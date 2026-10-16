/**
 * Deterministic structural analysis for request-facing regular expressions.
 *
 * The parser derives exact widths and finite branch words without executing
 * attacker-sized probes. Repeated finite languages are checked with a prefix
 * trie, so literal alternatives are linear in their total source length.
 * Unsupported intersections fail closed behind explicit node, word, symbol,
 * comparison, and nesting budgets.
 */
type RegexNode =
  | { kind: "atom"; symbol: RegexSymbol | null; fixedWidth: boolean }
  | { kind: "assertion"; child: RegexNode; negativeLookahead?: boolean }
  | { kind: "sequence"; children: RegexNode[] }
  | { kind: "alternation"; branches: RegexNode[] }
  | { kind: "repeat"; child: RegexNode; min: number; max: number };

// Symbol keys are namespaced by kind so a literal `\.` and the wildcard `.`
// never share a prefix-trie edge and skip the overlap check.
type RegexSymbol =
  | { kind: "literal"; key: string; value: string }
  | {
      kind: "class";
      key: string;
      values: ReadonlySet<string>;
      nonAscii: NonAsciiDomain;
    }
  | { kind: "opaque"; key: string; pattern: string; ignoreCase: boolean };

type NonAsciiDomain = "none" | "whitespace" | "non-whitespace" | "all";

export type RegexSafetyIssue =
  | "nested repetition"
  | "ambiguous alternatives under repetition"
  | "ambiguous sequence expansion"
  | "overlapping sequential repetition"
  | "exponentially ambiguous repetition"
  | "analysis budget exceeded";

const MAX_NODES = 16_384;
const MAX_NESTING_DEPTH = 256;
const MAX_PATTERN_LENGTH = 65_536;
const MAX_WORDS = 4_096;
const MAX_WORD_SYMBOLS = 32_768;
const MAX_OPAQUE_COMPARISONS = 4_096;
const MAX_SEQUENCE_EXPANSIONS = 256;
const MAX_SAFE_OVERLAPPING_VARIABLE_BOUNDARIES = 1;
// Above Next.js's 4096-character source limit, plus room for unrolled repeats.
const MAX_POSITIONS = 16_384;
// When unrolling every repeat exceeds a budget, repeats past this many
// positions are read as unbounded instead.
const MAX_UNROLLED_REPEAT = 1_024;
const MAX_AUTOMATON_EDGES = 262_144;
// Map entries read while building the automaton: unrolling a long repeat
// whose copies may be skipped, such as `a{0,16384}`, copies ever larger
// first and last sets.
const MAX_AUTOMATON_WORK = 4_000_000;
const MAX_PRODUCT_EDGES = 500_000;
// Follow lists longer than this are indexed by character for the product.
const MAX_UNINDEXED_FOLLOW = 16;

export function canonicalizeIgnoreCase(character: string): string {
  const upper = character.toUpperCase();
  // ECMAScript's non-Unicode Canonicalize operation keeps the original UTF-16
  // code unit when uppercasing expands it or maps a non-ASCII character to
  // ASCII. Middleware regexes are compiled with `i`, but not `u`.
  if (upper.length !== 1) return character;
  if (character.charCodeAt(0) >= 0x80 && upper.charCodeAt(0) < 0x80) return character;
  return upper;
}

function literalSymbol(character: string, ignoreCase: boolean): RegexSymbol {
  const key = ignoreCase ? canonicalizeIgnoreCase(character) : character;
  return { kind: "literal", key, value: character };
}

function createClassSymbol(values: ReadonlySet<string>, nonAscii: NonAsciiDomain): RegexSymbol {
  const key = [...values].sort().join("");
  return { kind: "class", key: `class:${nonAscii}:${key}`, values, nonAscii };
}

function shorthandClassSymbol(shorthand: string, ignoreCase: boolean): RegexSymbol | null {
  if (!"dDwWsS".includes(shorthand)) return null;
  const regexp = new RegExp(`\\${shorthand}`);
  const values = new Set<string>();
  for (let code = 0; code <= 0x7f; code++) {
    const character = String.fromCharCode(code);
    if (regexp.test(character)) {
      values.add(ignoreCase ? canonicalizeIgnoreCase(character) : character);
    }
  }
  const nonAscii: NonAsciiDomain =
    shorthand === "d" || shorthand === "w"
      ? "none"
      : shorthand === "s"
        ? "whitespace"
        : shorthand === "S"
          ? "non-whitespace"
          : "all";
  return createClassSymbol(values, nonAscii);
}

function unionNonAscii(left: NonAsciiDomain, right: NonAsciiDomain): NonAsciiDomain {
  if (left === "none") return right;
  if (right === "none" || left === right) return left;
  return "all";
}

function simpleClassSymbol(raw: string, ignoreCase: boolean): RegexSymbol | null {
  const end = raw.length - 1;
  if (raw[0] !== "[" || raw[end] !== "]" || raw[1] === "^") return null;
  const values = new Set<string>();
  let nonAscii: NonAsciiDomain = "none";

  const add = (character: string): boolean => {
    if (character.charCodeAt(0) > 0x7f) return false;
    values.add(ignoreCase ? canonicalizeIgnoreCase(character) : character);
    return true;
  };

  const addClass = (symbol: RegexSymbol): boolean => {
    if (symbol.kind !== "class") return false;
    for (const value of symbol.values) values.add(value);
    nonAscii = unionNonAscii(nonAscii, symbol.nonAscii);
    return true;
  };

  for (let index = 1; index < end; index++) {
    const start = raw[index];
    if (start === "\\") {
      const escaped = raw[++index];
      if (escaped === undefined) return null;
      const shorthand = shorthandClassSymbol(escaped, ignoreCase);
      if (shorthand) {
        if (!addClass(shorthand)) return null;
      } else if ("\\-]".includes(escaped)) {
        if (!add(escaped)) return null;
      } else {
        return null;
      }
      continue;
    }
    if (index + 2 < end && raw[index + 1] === "-") {
      const rangeEnd = raw[index + 2];
      if (rangeEnd === "\\") return null;
      const startCode = start.charCodeAt(0);
      const endCode = rangeEnd.charCodeAt(0);
      if (startCode > endCode || endCode > 0x7f) return null;
      for (let code = startCode; code <= endCode; code++) {
        if (!add(String.fromCharCode(code))) return null;
      }
      index += 2;
    } else if (!add(start)) {
      return null;
    }
  }

  if (values.size === 0 && nonAscii === "none") return null;
  return createClassSymbol(values, nonAscii);
}

/**
 * Whether a `(?i:...)` group turns on case folding for part of `pattern`.
 * Symbols are compared by key, and a folded `a` keys as `A`, so a pattern
 * that mixes both is read case-insensitively throughout; that only lets
 * more characters overlap, except in negative lookaheads, which the parser
 * drops when they hold a case-sensitive symbol.
 */
function hasScopedIgnoreCase(pattern: string): boolean {
  const scoped = /\?[ims]*i[ims]*(?:-[ims]+)?:/y;
  let inClass = false;
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index];
    if (character === "\\") index++;
    else if (character === "[") inClass = true;
    else if (character === "]") inClass = false;
    else if (!inClass && character === "(") {
      scoped.lastIndex = index + 1;
      if (scoped.test(pattern)) return true;
    }
  }
  return false;
}

/**
 * Where a pattern sits in the RegExp it is compiled into: after `before`
 * capturing groups, with `total` in the whole RegExp. Numbered
 * backreferences count them all.
 */
export type CaptureContext = { before: number; total: number };

/** Capturing groups in `pattern`, named or not, outside classes and escapes. */
export function countCapturingGroups(pattern: string): number {
  let count = 0;
  let inClass = false;
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index];
    if (character === "\\") index++;
    else if (character === "[") inClass = true;
    else if (character === "]") inClass = false;
    else if (!inClass && character === "(") {
      if (pattern[index + 1] !== "?") count++;
      else if (pattern[index + 2] === "<" && !"=!".includes(pattern[index + 3] ?? "")) count++;
    }
  }
  return count;
}

class RegexParser {
  index = 0;
  nodes = 0;
  depth = 0;
  exceededBudget = false;
  private readonly ignoreCase: boolean;
  // Whether the current `(?i:...)`/`(?-i:...)` scope folds case, and whether a
  // symbol it reads case-sensitively has been folded anyway: a folded `A`
  // also matches `a`, so `(?!A)` would exclude more than the RegExp does.
  private scopeIgnoreCase: boolean;
  private foldedCaseSensitive = false;
  // Whether `.` matches line terminators, which `(?s:...)` sets for its body.
  private dotAll = false;
  // Annex B reads `\N` as a backreference only up to the capture count.
  private readonly captures: number;
  // Each closed capturing group's body, by number and by name, so a
  // backreference to it can be read as the text it captures.
  private captureIndex = 0;
  private skippedGroup = false;
  private readonly groups: RegexNode[] = [];
  /** Groups that may not have taken part by the time a later term runs. */
  private readonly optionalGroups = new Set<number>();
  /** Each group name's capture, or undefined when several groups share it. */
  private readonly groupNames = new Map<string, number | undefined>();

  constructor(
    private readonly pattern: string,
    ignoreCase: boolean,
    private readonly namedGroups: boolean,
    private readonly context: CaptureContext = { before: 0, total: countCapturingGroups(pattern) },
  ) {
    this.ignoreCase = ignoreCase || hasScopedIgnoreCase(pattern);
    this.scopeIgnoreCase = ignoreCase;
    this.captures = context.total;
  }

  parse(): RegexNode {
    return this.parseAlternation();
  }

  private fold(): boolean {
    if (this.ignoreCase && !this.scopeIgnoreCase) this.foldedCaseSensitive = true;
    return this.ignoreCase;
  }

  private node<T extends RegexNode>(node: T): T {
    this.nodes++;
    if (this.nodes > MAX_NODES) this.exceededBudget = true;
    return node;
  }

  /** Marks the groups opened since group `after` as possibly not taking part. */
  private markGroupsOptional(after: number): void {
    for (let group = after + 1; group <= this.captureIndex; group++) this.optionalGroups.add(group);
  }

  private parseAlternation(): RegexNode {
    const before = this.captureIndex;
    const branches = [this.parseSequence()];
    while (this.pattern[this.index] === "|") {
      this.index++;
      // A later branch runs only when the earlier ones did not match.
      this.markGroupsOptional(before);
      branches.push(this.parseSequence());
    }
    if (branches.length > 1) this.markGroupsOptional(before);
    return branches.length === 1 ? branches[0] : this.node({ kind: "alternation", branches });
  }

  private parseSequence(): RegexNode {
    const children: RegexNode[] = [];
    while (this.index < this.pattern.length) {
      const character = this.pattern[this.index];
      if (character === "|" || character === ")") break;
      const term = this.parseTerm();
      // Parentheses around a sequence do not change which terms can consume
      // adjacent input. Flatten those transparent wrappers so empty groups
      // cannot hide overlapping repetitions from sequence analysis.
      if (term.kind === "sequence") children.push(...term.children);
      else children.push(term);
    }
    return children.length === 1 ? children[0] : this.node({ kind: "sequence", children });
  }

  private parseTerm(): RegexNode {
    const before = this.captureIndex;
    const atom = this.parseAtom();
    const quantifier = this.parseQuantifier();
    if (!quantifier) return atom;
    if (quantifier.min === 0) this.markGroupsOptional(before);
    if (this.pattern[this.index] === "?") this.index++;
    // An exact-one quantifier does not change the language or consumption of
    // its child. Remove it so it cannot hide a variable repetition from the
    // surrounding sequence analysis.
    if (quantifier.min === 1 && quantifier.max === 1) return atom;
    return this.node({ kind: "repeat", child: atom, ...quantifier });
  }

  private parseAtom(): RegexNode {
    const character = this.pattern[this.index++];
    if (character === "(") return this.parseGroup();
    if (character === "[") return this.parseClass();
    if (character === "\\") return this.parseEscape();
    if (character === "^" || character === "$") {
      return this.node({ kind: "assertion", child: this.node({ kind: "sequence", children: [] }) });
    }
    if (character === ".") {
      const pattern = this.dotAll ? "[\\s\\S]" : ".";
      return this.node({
        kind: "atom",
        symbol: { kind: "opaque", key: `opaque:${pattern}`, pattern, ignoreCase: this.ignoreCase },
        fixedWidth: true,
      });
    }
    return this.node({
      kind: "atom",
      symbol: literalSymbol(character, this.fold()),
      fixedWidth: true,
    });
  }

  /**
   * A backreference matches the text its group captured, or nothing when the
   * group did not take part. A group that reads a few fixed words captured
   * one of them, each read one way. Otherwise the text is a run of the
   * characters the group reads, as long as the group reads, which one repeat
   * of their class reads one way per length, as the engine compares the text
   * one way. Each occurrence is read on its own, so `(a|aa)\1+` still looks
   * ambiguous. Lookarounds in the group only constrained the capture, so they
   * are not replayed. An open or unknown group may have captured any text.
   */
  private backreference(group: number | undefined): RegexNode {
    const body = group === undefined || this.skippedGroup ? undefined : this.groups[group];
    const characters = body && capturedCharacters(body);
    if (!body || characters === null) {
      return this.node({ kind: "atom", symbol: null, fixedWidth: false });
    }
    const optional = this.optionalGroups.has(group!);
    const words = fixedWords(body, { words: 0, symbols: 0, exceeded: false });
    if (words) {
      const distinct = new Map<string, RegexSymbol[]>();
      for (const word of words) distinct.set(word.map((symbol) => symbol.key).join("\0"), word);
      const branches = [...distinct.values()].map((word) =>
        this.node({
          kind: "sequence",
          children: word.map((symbol) => this.node({ kind: "atom", symbol, fixedWidth: true })),
        }),
      );
      const text =
        branches.length === 1 ? branches[0]! : this.node({ kind: "alternation", branches });
      return optional ? this.node({ kind: "repeat", child: text, min: 0, max: 1 }) : text;
    }
    const [min, max] = widthRange(body, new WeakMap());
    if (characters === undefined || max === 0) {
      return this.node({ kind: "sequence", children: [] });
    }
    const child = this.node({ kind: "atom", symbol: characters, fixedWidth: true });
    return this.node({ kind: "repeat", child, min: optional ? 0 : min, max });
  }

  private parseGroup(): RegexNode {
    this.depth++;
    if (this.depth > MAX_NESTING_DEPTH) {
      this.exceededBudget = true;
      this.skipGroup();
      this.depth--;
      return this.node({ kind: "atom", symbol: null, fixedWidth: false });
    }
    let assertion = false;
    let negativeLookahead = false;
    let negativeAssertion = false;
    let capture = false;
    const outerDotAll = this.dotAll;
    const outerIgnoreCase = this.scopeIgnoreCase;
    const outerFolded = this.foldedCaseSensitive;
    const modifiers = /^\?([ims]*)(?:-([ims]+))?:/.exec(this.pattern.slice(this.index));
    if (modifiers && (modifiers[1] !== "" || modifiers[2] !== undefined)) {
      this.index += modifiers[0].length;
      if (modifiers[1]!.includes("s")) this.dotAll = true;
      if (modifiers[2]?.includes("s")) this.dotAll = false;
      if (modifiers[1]!.includes("i")) this.scopeIgnoreCase = true;
      if (modifiers[2]?.includes("i")) this.scopeIgnoreCase = false;
    } else if (this.pattern[this.index] !== "?") {
      capture = true;
    } else {
      const marker = this.pattern[this.index + 1];
      if (marker === ":") {
        this.index += 2;
      } else if (marker === "=" || marker === "!") {
        assertion = true;
        negativeLookahead = marker === "!";
        negativeAssertion = negativeLookahead;
        this.index += 2;
      } else if (
        marker === "<" &&
        (this.pattern[this.index + 2] === "=" || this.pattern[this.index + 2] === "!")
      ) {
        assertion = true;
        negativeAssertion = this.pattern[this.index + 2] === "!";
        this.index += 3;
      } else if (marker === "<") {
        const nameEnd = this.pattern.indexOf(">", this.index + 2);
        if (nameEnd !== -1) {
          const name = this.pattern.slice(this.index + 2, nameEnd);
          // Groups in different alternatives may share a name, and a
          // backreference reads whichever one took part.
          this.groupNames.set(name, this.groupNames.has(name) ? undefined : this.captureIndex + 1);
        }
        this.index = nameEnd === -1 ? this.pattern.length : nameEnd + 1;
        capture = true;
      } else {
        // Unsupported group prefixes will be rejected by RegExp compilation.
        // Keep analysis conservative if this parser is asked to inspect one.
        this.skipGroup();
        this.depth--;
        return this.node({ kind: "atom", symbol: null, fixedWidth: false });
      }
    }

    this.foldedCaseSensitive = false;
    const before = this.captureIndex;
    const captureNumber = capture ? ++this.captureIndex : 0;
    const child = this.parseAlternation();
    // Groups in a negative assertion never keep a capture.
    if (negativeAssertion) this.markGroupsOptional(before);
    if (this.pattern[this.index] === ")") this.index++;
    if (capture) this.groups[captureNumber] = child;
    const folded = this.foldedCaseSensitive;
    this.foldedCaseSensitive = outerFolded || folded;
    this.dotAll = outerDotAll;
    this.scopeIgnoreCase = outerIgnoreCase;
    this.depth--;
    if (!assertion) return child;
    // A negative lookahead over a folded case-sensitive symbol would exclude
    // too much, so read it as matching nothing; that only adds paths.
    if (negativeLookahead && folded) {
      return this.node({ kind: "assertion", child: this.node({ kind: "sequence", children: [] }) });
    }
    return this.node({ kind: "assertion", child, negativeLookahead });
  }

  private skipGroup(): void {
    // Groups inside are not numbered, so later backreferences are unknown.
    this.skippedGroup = true;
    let depth = 1;
    let inClass = false;
    while (this.index < this.pattern.length && depth > 0) {
      const character = this.pattern[this.index++];
      if (character === "\\") {
        this.index++;
        continue;
      }
      if (character === "[") inClass = true;
      else if (character === "]") inClass = false;
      else if (!inClass && character === "(") depth++;
      else if (!inClass && character === ")") depth--;
    }
  }

  private parseClass(): RegexNode {
    const start = this.index - 1;
    while (this.index < this.pattern.length) {
      const character = this.pattern[this.index++];
      if (character === "\\") this.index++;
      else if (character === "]") break;
    }
    const raw = this.pattern.slice(start, this.index);
    const ignoreCase = this.fold();
    return this.node({
      kind: "atom",
      symbol:
        simpleClassSymbol(raw, ignoreCase) ??
        ({
          kind: "opaque",
          key: `opaque:${raw}`,
          pattern: raw,
          ignoreCase,
        } as const),
      fixedWidth: true,
    });
  }

  private parseEscape(): RegexNode {
    const escaped = this.pattern[this.index++];
    if (escaped === undefined) {
      return this.node({ kind: "atom", symbol: null, fixedWidth: false });
    }
    if (escaped === "b" || escaped === "B") {
      return this.node({ kind: "assertion", child: this.node({ kind: "sequence", children: [] }) });
    }
    const shorthand = shorthandClassSymbol(escaped, this.fold());
    if (shorthand) {
      return this.node({ kind: "atom", symbol: shorthand, fixedWidth: true });
    }
    // Numeric and named backreferences match whatever their group captured, so
    // their language cannot be modelled from the pattern text. Without named
    // groups, Annex B reads `\k` as a literal `k`.
    if (escaped === "k" && this.namedGroups && this.pattern[this.index] === "<") {
      const nameEnd = this.pattern.indexOf(">", this.index);
      const name = nameEnd === -1 ? "" : this.pattern.slice(this.index + 1, nameEnd);
      this.index = nameEnd === -1 ? this.pattern.length : nameEnd + 1;
      return this.backreference(this.groupNames.get(name));
    }
    let literal: string | null = null;
    if (/\d/.test(escaped)) {
      const digits = /^\d*/.exec(this.pattern.slice(this.index))![0];
      if (escaped !== "0" && Number(escaped + digits) <= this.captures) {
        this.index += digits.length;
        // A group outside `pattern` is unknown here.
        return this.backreference(Number(escaped + digits) - this.context.before);
      }
      // Annex B: otherwise `\8` and `\9` are literal digits and `\0`-`\7`
      // start a legacy octal escape of up to three digits, at most `\377`.
      if (escaped === "8" || escaped === "9") {
        literal = escaped;
      } else {
        const octal = /^[0-7]{0,2}/.exec(this.pattern.slice(this.index))![0];
        const length = escaped <= "3" ? octal.length : Math.min(octal.length, 1);
        literal = String.fromCharCode(Number.parseInt(escaped + octal.slice(0, length), 8));
        this.index += length;
      }
    } else if (
      escaped === "x" &&
      /^[\da-fA-F]{2}/.test(this.pattern.slice(this.index, this.index + 2))
    ) {
      literal = String.fromCharCode(
        Number.parseInt(this.pattern.slice(this.index, this.index + 2), 16),
      );
      this.index += 2;
    } else if (
      escaped === "u" &&
      /^[\da-fA-F]{4}/.test(this.pattern.slice(this.index, this.index + 4))
    ) {
      literal = String.fromCharCode(
        Number.parseInt(this.pattern.slice(this.index, this.index + 4), 16),
      );
      this.index += 4;
    } else if (escaped === "c") {
      // Annex B: `\c` plus an ASCII letter is one control character. Without
      // a letter, the backslash is literal and `c` starts the next atom.
      const letter = this.pattern[this.index];
      if (letter !== undefined && /[A-Za-z]/.test(letter)) {
        literal = String.fromCharCode(letter.charCodeAt(0) % 32);
        this.index++;
      } else {
        literal = "\\";
        this.index--;
      }
    } else if ("nrtvf".includes(escaped)) {
      literal = ({ n: "\n", r: "\r", t: "\t", v: "\v", f: "\f" } as const)[
        escaped as "n" | "r" | "t" | "v" | "f"
      ];
    } else if (!/[A-Za-z]/.test(escaped)) {
      literal = escaped;
    }

    if (literal !== null) {
      return this.node({
        kind: "atom",
        symbol: literalSymbol(literal, this.fold()),
        fixedWidth: true,
      });
    }
    const raw = `\\${escaped}`;
    return this.node({
      kind: "atom",
      symbol: { kind: "opaque", key: `opaque:${raw}`, pattern: raw, ignoreCase: this.fold() },
      fixedWidth: true,
    });
  }

  private parseQuantifier(): { min: number; max: number } | null {
    const character = this.pattern[this.index];
    if (character === "*") {
      this.index++;
      return { min: 0, max: Infinity };
    }
    if (character === "+") {
      this.index++;
      return { min: 1, max: Infinity };
    }
    if (character === "?") {
      this.index++;
      return { min: 0, max: 1 };
    }
    if (character !== "{") return null;

    const start = this.index;
    let cursor = start + 1;
    while (/\d/.test(this.pattern[cursor] ?? "")) cursor++;
    if (cursor === start + 1) return null;
    const min = Number(this.pattern.slice(start + 1, cursor));
    if (this.pattern[cursor] === "}") {
      this.index = cursor + 1;
      return { min, max: min };
    }
    if (this.pattern[cursor] !== ",") return null;
    cursor++;
    const maxStart = cursor;
    while (/\d/.test(this.pattern[cursor] ?? "")) cursor++;
    if (this.pattern[cursor] !== "}") return null;
    const max = cursor === maxStart ? Infinity : Number(this.pattern.slice(maxStart, cursor));
    this.index = cursor + 1;
    return { min, max };
  }
}

/**
 * The characters a lookahead body reads, as with `a`, `[ab]` or `a|[bc]`, or
 * null when it reads more or other characters.
 */
function lookaheadCharacters(node: RegexNode): RegexSymbol[] | null {
  const branches = node.kind === "alternation" ? node.branches : [node];
  const characters: RegexSymbol[] = [];
  for (const branch of branches) {
    if (branch.kind !== "atom") return null;
    const symbol = branch.symbol;
    if (symbol?.kind !== "literal" && symbol?.kind !== "class") return null;
    characters.push(symbol);
  }
  return characters;
}

/**
 * One symbol for every character `node` reads outside lookarounds, undefined
 * when it reads none, or null when it may read text of unknown shape.
 */
function capturedCharacters(node: RegexNode): RegexSymbol | null | undefined {
  const literals = new Map<string, Extract<RegexSymbol, { kind: "literal" }>>();
  const values = new Set<string>();
  let nonAscii: NonAsciiDomain = "none";
  let any = false;
  const visit = (current: RegexNode): boolean => {
    switch (current.kind) {
      case "atom": {
        const symbol = current.symbol;
        if (symbol === null || !current.fixedWidth) return false;
        if (symbol.kind === "literal") literals.set(symbol.key, symbol);
        else if (symbol.kind === "class") {
          for (const value of symbol.values) values.add(value);
          nonAscii = unionNonAscii(nonAscii, symbol.nonAscii);
        } else any = true;
        return true;
      }
      case "assertion":
        return true;
      case "sequence":
        return current.children.every(visit);
      case "alternation":
        return current.branches.every(visit);
      case "repeat":
        return visit(current.child);
    }
  };
  if (!visit(node)) return null;
  if (any) {
    return { kind: "opaque", key: "opaque:[\\s\\S]", pattern: "[\\s\\S]", ignoreCase: false };
  }
  if (literals.size === 1 && values.size === 0 && nonAscii === "none") {
    return literals.values().next().value!;
  }
  for (const literal of literals.values()) {
    if (literal.key.charCodeAt(0) <= 0x7f) values.add(literal.key);
    else
      nonAscii = unionNonAscii(
        nonAscii,
        /\s/.test(literal.value) ? "whitespace" : "non-whitespace",
      );
  }
  if (values.size === 0 && nonAscii === "none") return undefined;
  return createClassSymbol(values, nonAscii);
}

/** The fewest and most characters `node` reads, the most possibly Infinity. */
function widthRange(
  node: RegexNode,
  cache: WeakMap<RegexNode, [number, number]>,
): [number, number] {
  const cached = cache.get(node);
  if (cached) return cached;
  let range: [number, number];
  switch (node.kind) {
    case "atom":
      range = node.fixedWidth ? [1, 1] : [0, Infinity];
      break;
    case "assertion":
      range = [0, 0];
      break;
    case "sequence":
      range = [0, 0];
      for (const child of node.children) {
        const [min, max] = widthRange(child, cache);
        range = [range[0] + min, range[1] + max];
      }
      break;
    case "alternation":
      range = [Infinity, 0];
      for (const branch of node.branches) {
        const [min, max] = widthRange(branch, cache);
        range = [Math.min(range[0], min), Math.max(range[1], max)];
      }
      if (node.branches.length === 0) range = [0, 0];
      break;
    case "repeat": {
      const [min, max] = widthRange(node.child, cache);
      range = [node.min * min, max === 0 ? 0 : node.max * max];
      break;
    }
  }
  cache.set(node, range);
  return range;
}

function exactWidth(node: RegexNode): number | null {
  switch (node.kind) {
    case "atom":
      return node.fixedWidth ? 1 : null;
    case "assertion":
      return 0;
    case "sequence": {
      let width = 0;
      for (const child of node.children) {
        const childWidth = exactWidth(child);
        if (childWidth === null) return null;
        width += childWidth;
      }
      return width;
    }
    case "alternation": {
      let width: number | null | undefined;
      for (const branch of node.branches) {
        const branchWidth = exactWidth(branch);
        if (branchWidth === null) return null;
        if (width === undefined) width = branchWidth;
        else if (width !== branchWidth) return null;
      }
      return width ?? 0;
    }
    case "repeat": {
      if (node.min !== node.max || !Number.isFinite(node.max)) return null;
      const childWidth = exactWidth(node.child);
      return childWidth === null ? null : childWidth * node.min;
    }
  }
}

function containsConsumingRepetition(node: RegexNode): boolean {
  switch (node.kind) {
    case "atom":
      return false;
    case "assertion":
      return false;
    case "sequence":
      return node.children.some(containsConsumingRepetition);
    case "alternation":
      return node.branches.some(containsConsumingRepetition);
    case "repeat":
      return node.min !== 1 || node.max !== 1 || containsConsumingRepetition(node.child);
  }
}

function containsConsumingAlternation(node: RegexNode): boolean {
  switch (node.kind) {
    case "atom":
      return false;
    case "assertion":
      return false;
    case "sequence":
      return node.children.some(containsConsumingAlternation);
    case "alternation":
      return true;
    case "repeat":
      return containsConsumingAlternation(node.child);
  }
}

type WordBudget = { words: number; symbols: number; exceeded: boolean };

function fixedWords(node: RegexNode, budget: WordBudget): RegexSymbol[][] | null {
  if (budget.exceeded) return null;
  switch (node.kind) {
    case "atom":
      return node.symbol ? [[node.symbol]] : null;
    case "assertion":
      return [[]];
    case "sequence": {
      let words: RegexSymbol[][] = [[]];
      for (const child of node.children) {
        const childWords = fixedWords(child, budget);
        if (!childWords) return null;
        const next: RegexSymbol[][] = [];
        for (const prefix of words) {
          for (const suffix of childWords) {
            if (++budget.words > MAX_WORDS) {
              budget.exceeded = true;
              return null;
            }
            const word = [...prefix, ...suffix];
            budget.symbols += word.length;
            if (budget.symbols > MAX_WORD_SYMBOLS) {
              budget.exceeded = true;
              return null;
            }
            next.push(word);
          }
        }
        words = next;
      }
      return words;
    }
    case "alternation": {
      const words: RegexSymbol[][] = [];
      for (const branch of node.branches) {
        const branchWords = fixedWords(branch, budget);
        if (!branchWords) return null;
        words.push(...branchWords);
        if ((budget.words += branchWords.length) > MAX_WORDS) {
          budget.exceeded = true;
          return null;
        }
      }
      return words;
    }
    case "repeat": {
      // A bounded repeat such as `woff2?` or `x{1,3}` still has a finite
      // language: the child's words repeated min..max times. Every word is a
      // separate match path, so `(?:a|aa?)` counts as three ambiguous paths.
      // Out-of-order ranges such as `{2,1}` are invalid and fail closed.
      if (!Number.isFinite(node.max) || node.min > node.max) return null;
      let words: RegexSymbol[][] = [[]];
      const childWords = fixedWords(node.child, budget);
      if (!childWords) return null;
      const repeated: RegexSymbol[][] = node.min === 0 ? [[]] : [];
      for (let count = 1; count <= node.max; count++) {
        const next: RegexSymbol[][] = [];
        for (const prefix of words) {
          for (const suffix of childWords) {
            if (++budget.words > MAX_WORDS) {
              budget.exceeded = true;
              return null;
            }
            const word = [...prefix, ...suffix];
            budget.symbols += word.length;
            if (budget.symbols > MAX_WORD_SYMBOLS) {
              budget.exceeded = true;
              return null;
            }
            next.push(word);
          }
        }
        words = next;
        if (count >= node.min) repeated.push(...words);
      }
      return repeated;
    }
  }
}

type TrieEdge = { symbol: RegexSymbol; node: TrieNode };
type TrieNode = {
  terminal: boolean;
  edges: Map<string, TrieEdge>;
  complexEdges: TrieEdge[];
};

function createTrieNode(): TrieNode {
  return { terminal: false, edges: new Map(), complexEdges: [] };
}

function opaqueMatchesLiteral(opaque: RegexSymbol, literal: RegexSymbol): boolean {
  if (opaque.kind !== "opaque" || literal.kind !== "literal") return false;
  try {
    return new RegExp(`^(?:${opaque.pattern})$`, opaque.ignoreCase ? "i" : "").test(literal.value);
  } catch {
    return true;
  }
}

function classMatchesLiteral(characterClass: RegexSymbol, literal: RegexSymbol): boolean {
  if (characterClass.kind !== "class" || literal.kind !== "literal") return false;
  if (literal.value.charCodeAt(0) <= 0x7f) return characterClass.values.has(literal.key);
  if (characterClass.nonAscii === "all") return true;
  const whitespace = /\s/.test(literal.value);
  return whitespace
    ? characterClass.nonAscii === "whitespace"
    : characterClass.nonAscii === "non-whitespace";
}

function nonAsciiDomainsOverlap(left: NonAsciiDomain, right: NonAsciiDomain): boolean {
  if (left === "none" || right === "none") return false;
  if (left === "all" || right === "all") return true;
  return left === right;
}

function symbolsMayOverlap(left: RegexSymbol, right: RegexSymbol): boolean {
  if (left.kind === "literal" && right.kind === "literal") return left.key === right.key;
  if (left.kind === "class" && right.kind === "literal") return classMatchesLiteral(left, right);
  if (left.kind === "literal" && right.kind === "class") return classMatchesLiteral(right, left);
  if (left.kind === "class" && right.kind === "class") {
    const [smaller, larger] =
      left.values.size <= right.values.size
        ? [left.values, right.values]
        : [right.values, left.values];
    for (const value of smaller) {
      if (larger.has(value)) return true;
    }
    return nonAsciiDomainsOverlap(left.nonAscii, right.nonAscii);
  }
  if (left.kind === "opaque" && right.kind === "literal") {
    return opaqueMatchesLiteral(left, right);
  }
  if (left.kind === "literal" && right.kind === "opaque") {
    return opaqueMatchesLiteral(right, left);
  }
  return true;
}

// Whether `word` from `index` on can match a prefix of an existing word, or
// an existing word can match a prefix of it. Exact-key edges are followed
// directly. Other edges whose symbols may overlap are explored too, so `\.x`
// and `.y` stay disjoint through their second symbol. Every step off the
// exact path counts against the comparison budget.
function wordMayCollide(
  node: TrieNode,
  word: RegexSymbol[],
  index: number,
  comparisons: { count: number },
  branched: boolean,
): boolean {
  if (node.terminal) return true;
  if (index === word.length) return node.edges.size > 0;
  if (branched && ++comparisons.count > MAX_OPAQUE_COMPARISONS) return true;
  const symbol = word[index];
  const exact = node.edges.get(symbol.key);
  if (exact && wordMayCollide(exact.node, word, index + 1, comparisons, branched)) return true;
  const candidates = symbol.kind === "literal" ? node.complexEdges : node.edges.values();
  for (const candidate of candidates) {
    if (candidate === exact) continue;
    if (++comparisons.count > MAX_OPAQUE_COMPARISONS) return true;
    if (
      symbolsMayOverlap(candidate.symbol, symbol) &&
      wordMayCollide(candidate.node, word, index + 1, comparisons, true)
    ) {
      return true;
    }
  }
  return false;
}

function insertPrefixFreeWord(
  root: TrieNode,
  word: RegexSymbol[],
  comparisons: { count: number },
): boolean {
  if (wordMayCollide(root, word, 0, comparisons, false)) return false;
  let node = root;
  for (const symbol of word) {
    let edge = node.edges.get(symbol.key);
    if (!edge) {
      edge = { symbol, node: createTrieNode() };
      node.edges.set(symbol.key, edge);
      if (symbol.kind !== "literal") node.complexEdges.push(edge);
    }
    node = edge.node;
  }
  node.terminal = true;
  return true;
}

function hasPrefixFreeFiniteLanguage(node: RegexNode): {
  safe: boolean;
  budgetExceeded: boolean;
  wordCount: number;
} {
  const budget: WordBudget = { words: 0, symbols: 0, exceeded: false };
  const words = fixedWords(node, budget);
  if (!words) return { safe: false, budgetExceeded: budget.exceeded, wordCount: 0 };
  const root = createTrieNode();
  const comparisons = { count: 0 };
  for (const word of words) {
    if (!insertPrefixFreeWord(root, word, comparisons)) {
      return {
        safe: false,
        budgetExceeded: comparisons.count > MAX_OPAQUE_COMPARISONS,
        wordCount: words.length,
      };
    }
  }
  return { safe: true, budgetExceeded: false, wordCount: words.length };
}

function ambiguousExpansionFactor(node: RegexNode): number {
  switch (node.kind) {
    case "atom":
    case "assertion":
      return 1;
    case "alternation": {
      const result = hasPrefixFreeFiniteLanguage(node);
      if (result.safe) return 1;
      if (result.budgetExceeded || result.wordCount === 0) return MAX_SEQUENCE_EXPANSIONS + 1;
      return result.wordCount;
    }
    case "sequence": {
      let factor = 1;
      for (const child of node.children) {
        factor *= ambiguousExpansionFactor(child);
        if (factor > MAX_SEQUENCE_EXPANSIONS) return factor;
      }
      return factor;
    }
    case "repeat": {
      if (node.min !== node.max || !Number.isFinite(node.max)) return 1;
      const childFactor = ambiguousExpansionFactor(node.child);
      if (childFactor === 1) return 1;
      let factor = 1;
      for (let count = 0; count < node.max; count++) {
        factor *= childFactor;
        if (factor > MAX_SEQUENCE_EXPANSIONS) return factor;
      }
      return factor;
    }
  }
}

function isNullable(node: RegexNode): boolean {
  switch (node.kind) {
    case "atom":
      return !node.fixedWidth;
    case "assertion":
      return true;
    case "sequence":
      return node.children.every(isNullable);
    case "alternation":
      return node.branches.some(isNullable);
    case "repeat":
      return node.min === 0 || isNullable(node.child);
  }
}

function firstSymbols(node: RegexNode): RegexSymbol[] | null {
  switch (node.kind) {
    case "atom":
      return node.symbol ? [node.symbol] : null;
    case "assertion":
      return [];
    case "repeat":
      return firstSymbols(node.child);
    case "alternation": {
      const symbols: RegexSymbol[] = [];
      for (const branch of node.branches) {
        const branchSymbols = firstSymbols(branch);
        if (!branchSymbols) return null;
        symbols.push(...branchSymbols);
      }
      return symbols;
    }
    case "sequence": {
      const symbols: RegexSymbol[] = [];
      for (const child of node.children) {
        const childSymbols = firstSymbols(child);
        if (!childSymbols) return null;
        symbols.push(...childSymbols);
        if (!isNullable(child)) break;
      }
      return symbols;
    }
  }
}

function lastSymbols(node: RegexNode): RegexSymbol[] | null {
  switch (node.kind) {
    case "atom":
      return node.symbol ? [node.symbol] : null;
    case "assertion":
      return [];
    case "repeat":
      return lastSymbols(node.child);
    case "alternation": {
      const symbols: RegexSymbol[] = [];
      for (const branch of node.branches) {
        const branchSymbols = lastSymbols(branch);
        if (!branchSymbols) return null;
        symbols.push(...branchSymbols);
      }
      return symbols;
    }
    case "sequence": {
      const symbols: RegexSymbol[] = [];
      for (let index = node.children.length - 1; index >= 0; index--) {
        const child = node.children[index];
        const childSymbols = lastSymbols(child);
        if (!childSymbols) return null;
        symbols.push(...childSymbols);
        if (!isNullable(child)) break;
      }
      return symbols;
    }
  }
}

function boundariesMayOverlap(
  left: RegexSymbol[] | null,
  right: RegexSymbol[] | null,
  comparisons: { count: number },
): boolean {
  if (!left || !right) return true;
  for (const leftSymbol of left) {
    for (const rightSymbol of right) {
      if (++comparisons.count > MAX_OPAQUE_COMPARISONS) return true;
      if (symbolsMayOverlap(leftSymbol, rightSymbol)) return true;
    }
  }
  return false;
}

function findSequenceIssue(
  node: Extract<RegexNode, { kind: "sequence" }>,
): RegexSafetyIssue | null {
  if (ambiguousExpansionFactor(node) > MAX_SEQUENCE_EXPANSIONS) {
    return "ambiguous sequence expansion";
  }
  return findOverlappingRepetitionChain(node);
}

function findOverlappingRepetitionChain(
  node: Extract<RegexNode, { kind: "sequence" }>,
): RegexSafetyIssue | null {
  let pendingRepetitionEnds: Array<RegexSymbol[] | null> = [];
  const comparisons = { count: 0 };
  let overlappingBoundaryCount = 0;
  for (const child of node.children) {
    const variableRepetition =
      child.kind === "repeat" && (child.min !== child.max || !Number.isFinite(child.max));
    if (variableRepetition) {
      const starts = firstSymbols(child);
      const overlappingBoundaries = pendingRepetitionEnds.filter((ends) =>
        boundariesMayOverlap(ends, starts, comparisons),
      ).length;
      if (overlappingBoundaries > 0) {
        overlappingBoundaryCount++;
      } else if (!isNullable(child)) {
        overlappingBoundaryCount = 0;
      }
      // One overlapping boundary has linearly many partitions over the input
      // length. A second makes that search quadratic, and every additional
      // boundary raises the degree again. Preserve common two-repeat patterns,
      // but reject longer overlapping chains before compiling them.
      if (overlappingBoundaryCount > MAX_SAFE_OVERLAPPING_VARIABLE_BOUNDARIES) {
        return "overlapping sequential repetition";
      }
      const ends = lastSymbols(child);
      pendingRepetitionEnds = isNullable(child) ? [...pendingRepetitionEnds, ends] : [ends];
    } else if (!isNullable(child)) {
      pendingRepetitionEnds = [];
      overlappingBoundaryCount = 0;
    }
  }
  return null;
}

function findSafetyIssue(node: RegexNode): RegexSafetyIssue | null {
  switch (node.kind) {
    case "atom":
      return null;
    case "assertion":
      return findSafetyIssue(node.child);
    case "sequence": {
      const sequenceIssue = findSequenceIssue(node);
      if (sequenceIssue) return sequenceIssue;
      for (const child of node.children) {
        const issue = findSafetyIssue(child);
        if (issue) return issue;
      }
      return null;
    }
    case "alternation":
      for (const branch of node.branches) {
        const issue = findSafetyIssue(branch);
        if (issue) return issue;
      }
      return null;
    case "repeat": {
      const nestedRepetition = containsConsumingRepetition(node.child);
      if (node.max > 1 && nestedRepetition && exactWidth(node.child) === null) {
        return "nested repetition";
      }
      if (node.max > 1 && containsConsumingAlternation(node.child)) {
        const prefixFree = hasPrefixFreeFiniteLanguage(node.child);
        if (!prefixFree.safe) {
          return prefixFree.budgetExceeded
            ? "analysis budget exceeded"
            : "ambiguous alternatives under repetition";
        }
      }
      return findSafetyIssue(node.child);
    }
  }
}

function findRepetitionChainDeep(node: RegexNode): RegexSafetyIssue | null {
  switch (node.kind) {
    case "atom":
      return null;
    case "assertion":
    case "repeat":
      return findRepetitionChainDeep(node.child);
    case "sequence": {
      const chainIssue = findOverlappingRepetitionChain(node);
      if (chainIssue) return chainIssue;
      for (const child of node.children) {
        const issue = findRepetitionChainDeep(child);
        if (issue) return issue;
      }
      return null;
    }
    case "alternation":
      for (const branch of node.branches) {
        const issue = findRepetitionChainDeep(branch);
        if (issue) return issue;
      }
      return null;
  }
}

/**
 * Only analyzeRegexSafety's check for chains of overlapping variable repeats
 * in a sequence. For a RegExp compiled from separately checked parts, where
 * each part is known to be safe but a chain across parts is not.
 */
export function analyzeRegexRepetitionChains(
  pattern: string,
  options: { ignoreCase?: boolean; namedGroups?: boolean } = {},
): RegexSafetyIssue | null {
  if (pattern.length > MAX_PATTERN_LENGTH) return "analysis budget exceeded";
  const parser = new RegexParser(
    pattern,
    options.ignoreCase === true,
    options.namedGroups ?? mayHaveNamedGroups(pattern),
  );
  const node = parser.parse();
  if (parser.exceededBudget) return "analysis budget exceeded";
  return findRepetitionChainDeep(node);
}

/**
 * Whether a RegExp source declares a named group, which turns `\k<name>` into
 * a backreference. Escaped characters and character classes cannot open one.
 */
export function mayHaveNamedGroups(pattern: string): boolean {
  let inClass = false;
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index];
    if (character === "\\") {
      index++;
    } else if (inClass) {
      if (character === "]") inClass = false;
    } else if (character === "[") {
      inClass = true;
    } else if (
      character === "(" &&
      pattern.startsWith("?<", index + 1) &&
      pattern[index + 3] !== "=" &&
      pattern[index + 3] !== "!"
    ) {
      return true;
    }
  }
  return false;
}

/**
 * `namedGroups` must describe the whole compiled RegExp when `pattern` is only
 * a fragment of it. It defaults to scanning `pattern` itself.
 */
export function analyzeRegexSafety(
  pattern: string,
  options: { ignoreCase?: boolean; namedGroups?: boolean; captures?: CaptureContext } = {},
): RegexSafetyIssue | null {
  if (pattern.length > MAX_PATTERN_LENGTH) return "analysis budget exceeded";
  const parser = new RegexParser(
    pattern,
    options.ignoreCase === true,
    options.namedGroups ?? mayHaveNamedGroups(pattern),
    options.captures,
  );
  const node = parser.parse();
  if (parser.exceededBudget) return "analysis budget exceeded";
  return findSafetyIssue(node);
}

export function regexAtomsMayOverlap(left: string, right: string, ignoreCase = false): boolean {
  // Both sides must key symbols the same way to compare them.
  ignoreCase ||= hasScopedIgnoreCase(left) || hasScopedIgnoreCase(right);
  const leftParser = new RegexParser(left, ignoreCase, true);
  const rightParser = new RegexParser(right, ignoreCase, true);
  const leftNode = leftParser.parse();
  const rightNode = rightParser.parse();
  const leftWords = fixedWords(leftNode, { words: 0, symbols: 0, exceeded: false });
  const rightWords = fixedWords(rightNode, { words: 0, symbols: 0, exceeded: false });
  if (!leftWords || !rightWords || leftWords.length !== 1 || rightWords.length !== 1) return true;
  const leftSymbol = leftWords[0][0];
  const rightSymbol = rightWords[0][0];
  if (!leftSymbol || !rightSymbol) return true;
  return symbolsMayOverlap(leftSymbol, rightSymbol);
}

// Path counts saturate at two: two distinct paths are enough for ambiguity.
type PathCounts = Map<number, number>;
type PositionFragment = { first: PathCounts; last: PathCounts; empty: number };

function saturate(count: number): number {
  return Math.min(count, 2);
}

function addPaths(target: PathCounts, source: PathCounts, factor = 1): PathCounts {
  if (factor === 0) return target;
  for (const [position, count] of source) {
    target.set(position, saturate((target.get(position) ?? 0) + count * factor));
  }
  return target;
}

/**
 * The position (Glushkov) automaton of a parsed RegExp: one state per
 * consuming atom, entered by reading that atom's symbol, plus start state 0.
 * Repeats are unrolled, `x{1,3}` as `x(?:x(?:x)?)?`, so each state is one
 * place the backtracking engine can be. A repeat that would unroll past
 * `maxUnrolledRepeat` positions is read as `x+` (or `x*`) instead: each of
 * its paths is still a distinct path there, so that only adds ambiguity.
 * Fragments count their paths, and edges keep that count: `(a*)*` builds
 * `a -> a` twice and `\/(?:|)` ends at "/" two ways, and each is two ways for the engine to move. Like the
 * engine, a repeat past its minimum never takes an empty iteration.
 * Assertions are read as empty, which only adds paths, except a negative
 * lookahead right before a single-character atom, which path-to-regexp emits
 * to keep a param out of the text after it: `(?!-)` or `(?![ab])` removes
 * those characters from what the atom reads, and a literal word such as
 * `(?!ab)` is kept as a guard for applyLookaheadGuards.
 */
class PositionAutomaton {
  readonly symbols: Array<RegexSymbol | null> = [null];
  readonly excluded: RegexSymbol[][] = [[]];
  readonly guards: Array<RegexSymbol[] | null> = [null];
  /** Each edge's target, listed once per path that builds it. */
  readonly follow: number[][] = [];
  exceeded = false;
  /** Whether a repeat past MAX_UNROLLED_REPEAT positions was unrolled. */
  unrolledLongRepeat = false;
  private readonly edges: PathCounts[] = [new Map()];
  private edgeCount = 0;
  private work = 0;
  private readonly sizes = new WeakMap<RegexNode, number>();

  constructor(private readonly maxUnrolledRepeat: number) {}

  build(node: RegexNode): void {
    const fragment = this.fragment(node);
    this.connect(new Map([[0, 1]]), fragment.first);
    for (const targets of this.edges) {
      const follow: number[] = [];
      for (const [target, count] of targets) {
        for (let copy = 0; copy < count; copy++) follow.push(target);
      }
      this.follow.push(follow);
    }
  }

  private position(
    symbol: RegexSymbol | null,
    excluded: RegexSymbol[] = [],
    guard: RegexSymbol[] | null = null,
  ): number {
    // The start state is not counted.
    if (this.symbols.length > MAX_POSITIONS) this.exceeded = true;
    this.symbols.push(symbol);
    this.excluded.push(excluded);
    this.guards.push(guard);
    this.edges.push(new Map());
    return this.symbols.length - 1;
  }

  private single(position: number): PositionFragment {
    return { first: new Map([[position, 1]]), last: new Map([[position, 1]]), empty: 0 };
  }

  private spend(work: number): void {
    this.work += work;
    if (this.work > MAX_AUTOMATON_WORK) this.exceeded = true;
  }

  private connect(from: PathCounts, to: PathCounts): void {
    this.spend(from.size * to.size);
    if (this.exceeded) return;
    for (const [source, sourceCount] of from) {
      const targets = this.edges[source]!;
      for (const [target, targetCount] of to) {
        const existing = targets.get(target);
        if (existing === undefined && ++this.edgeCount > MAX_AUTOMATON_EDGES) {
          this.exceeded = true;
          return;
        }
        targets.set(target, saturate((existing ?? 0) + sourceCount * targetCount));
      }
    }
  }

  private concat(left: PositionFragment, right: PositionFragment): PositionFragment {
    this.connect(left.last, right.first);
    this.spend(left.first.size + right.first.size + left.last.size + right.last.size);
    return {
      first: addPaths(new Map(left.first), right.first, left.empty),
      last: addPaths(new Map(right.last), left.last, right.empty),
      empty: saturate(left.empty * right.empty),
    };
  }

  /** The positions `node` unrolls to. */
  private size(node: RegexNode): number {
    let size = this.sizes.get(node);
    if (size !== undefined) return size;
    switch (node.kind) {
      case "atom":
        size = 1;
        break;
      case "assertion":
        size = 0;
        break;
      case "sequence":
        size = node.children.reduce((total, child) => total + this.size(child), 0);
        break;
      case "alternation":
        size = node.branches.reduce((total, branch) => total + this.size(branch), 0);
        break;
      case "repeat": {
        const child = this.size(node.child);
        size = this.unrollsTooFar(node) ? child : child * this.copies(node);
        break;
      }
    }
    this.sizes.set(node, size);
    return size;
  }

  /** How many copies of its child `node` unrolls to. */
  private copies(node: Extract<RegexNode, { kind: "repeat" }>): number {
    return Number.isFinite(node.max) ? node.max : Math.max(node.min, 1);
  }

  private unrollsTooFar(node: Extract<RegexNode, { kind: "repeat" }>): boolean {
    return this.size(node.child) * this.copies(node) > this.maxUnrolledRepeat;
  }

  /**
   * `fragment` repeated without bound, at least once when `required`. A
   * required first iteration may match empty and be followed by one that
   * does not, so it can also start where the second iteration starts.
   */
  private loop(fragment: PositionFragment, required: boolean): PositionFragment {
    this.connect(fragment.last, fragment.first);
    this.spend(fragment.first.size);
    if (!required) return { ...fragment, empty: 1 };
    return {
      first: addPaths(new Map(fragment.first), fragment.first, fragment.empty),
      last: fragment.last,
      empty: fragment.empty,
    };
  }

  private fragment(node: RegexNode): PositionFragment {
    if (this.exceeded) return { first: new Map(), last: new Map(), empty: 1 };
    switch (node.kind) {
      case "atom": {
        const fragment = this.single(this.position(node.symbol));
        // An unmodelled atom, such as a backreference, may match any text.
        return node.symbol === null ? this.loop(fragment, false) : fragment;
      }
      case "assertion":
        return { first: new Map(), last: new Map(), empty: 1 };
      case "sequence": {
        let fragment: PositionFragment = { first: new Map(), last: new Map(), empty: 1 };
        for (let index = 0; index < node.children.length; index++) {
          const child = node.children[index]!;
          const next = node.children[index + 1];
          const lookahead =
            child.kind === "assertion" && child.negativeLookahead ? child.child : null;
          // The lookahead constrains the next character: that of the next
          // atom, or of the first required copy of a repeated atom.
          const guarded =
            next?.kind === "repeat" && next.min > 0 && next.child.kind === "atom"
              ? next.child
              : next;
          if (
            lookahead &&
            guarded?.kind === "atom" &&
            guarded.symbol !== null &&
            guarded.fixedWidth
          ) {
            let position: number | null = null;
            const characters = lookaheadCharacters(lookahead);
            if (characters) {
              position = this.position(guarded.symbol, characters);
            } else if (
              lookahead.kind === "sequence" &&
              lookahead.children.length > 1 &&
              lookahead.children.every(
                (part) => part.kind === "atom" && part.symbol?.kind === "literal",
              )
            ) {
              const word = lookahead.children.map(
                (part) => (part as Extract<RegexNode, { kind: "atom" }>).symbol!,
              );
              position = this.position(guarded.symbol, [], word);
            }
            if (position !== null) {
              fragment = this.concat(fragment, this.single(position));
              if (next!.kind === "repeat") {
                const rest = { ...next!, min: next!.min - 1, max: next!.max - 1 };
                fragment = this.concat(fragment, this.fragment(rest));
              }
              index++;
              continue;
            }
          }
          fragment = this.concat(fragment, this.fragment(child));
        }
        return fragment;
      }
      case "alternation": {
        const fragment: PositionFragment = { first: new Map(), last: new Map(), empty: 0 };
        for (const branch of node.branches) {
          const child = this.fragment(branch);
          addPaths(fragment.first, child.first);
          addPaths(fragment.last, child.last);
          fragment.empty = saturate(fragment.empty + child.empty);
        }
        return fragment;
      }
      case "repeat": {
        if (this.unrollsTooFar(node)) return this.loop(this.fragment(node.child), node.min > 0);
        // A zero-width child can only match empty, which no iteration past
        // the minimum may do. More required copies only multiply its path
        // count, which one copy has already saturated or kept at 0 or 1.
        if (this.size(node.child) === 0) {
          return node.min === 0
            ? { first: new Map(), last: new Map(), empty: 1 }
            : this.fragment(node.child);
        }
        if (this.size(node) > MAX_UNROLLED_REPEAT) this.unrolledLongRepeat = true;
        // Iterations up to the minimum may match empty; later ones may not.
        let fragment: PositionFragment = { first: new Map(), last: new Map(), empty: 1 };
        const required = Number.isFinite(node.max) ? node.min : Math.max(node.min - 1, 0);
        for (let count = 0; count < required && !this.exceeded; count++) {
          fragment = this.concat(fragment, this.fragment(node.child));
        }
        if (!Number.isFinite(node.max)) {
          return this.concat(fragment, this.loop(this.fragment(node.child), node.min > 0));
        }
        // Nest the optional copies so a shorter run has a single parse.
        let optional: PositionFragment = { first: new Map(), last: new Map(), empty: 1 };
        for (let count = node.min; count < node.max && !this.exceeded; count++) {
          optional = this.concat({ ...this.fragment(node.child), empty: 0 }, optional);
          optional.empty = 1;
        }
        return this.concat(fragment, optional);
      }
    }
  }
}

type AmbiguityGraph = {
  symbols: Array<RegexSymbol | null>;
  /** Characters each state's symbol does not read. */
  excluded: RegexSymbol[][];
  /** Each edge's target, listed once per path that takes it. */
  follow: number[][];
};

/**
 * The automaton with each literal `(?!word)` guard enforced. A state also
 * records how far each pending guard word has matched, and a step that would
 * complete one is dropped, as the engine's lookahead fails there. A symbol is
 * split only at the characters a guard checks next, so every input still
 * takes as many paths as it does in the engine.
 */
function applyLookaheadGuards(automaton: PositionAutomaton): AmbiguityGraph | null {
  const { excluded, follow, guards, symbols } = automaton;
  if (!guards.some((guard) => guard !== null)) {
    return { symbols, excluded, follow };
  }

  const graph: AmbiguityGraph = { symbols: [null], excluded: [[]], follow: [[]] };
  // Pending guards as [guarded position, characters matched so far].
  const states: Array<{ position: number; pending: Array<[number, number]> }> = [
    { position: 0, pending: [] },
  ];
  const ids = new Map<string, number>();
  const queue = [0];
  const stateFor = (
    position: number,
    symbol: RegexSymbol | null,
    without: RegexSymbol[],
    pending: Array<[number, number]>,
  ): number | null => {
    const key = [
      position,
      symbol?.key ?? "",
      without.map((character) => character.key).join("\0"),
      pending.map(([guard, matched]) => `${guard}:${matched}`).join(","),
    ].join("\u0001");
    let id = ids.get(key);
    if (id === undefined) {
      if (graph.symbols.length > MAX_POSITIONS) return null;
      id = graph.symbols.length;
      ids.set(key, id);
      graph.symbols.push(symbol);
      graph.excluded.push(without);
      graph.follow.push([]);
      states.push({ position, pending });
      queue.push(id);
    }
    return id;
  };

  while (queue.length > 0) {
    const id = queue.pop()!;
    const { position, pending } = states[id]!;
    for (const target of follow[position]!) {
      const symbol = symbols[target]!;
      const guard = guards[target]!;
      const checked = new Map<string, RegexSymbol>();
      for (const [guarded, matched] of pending) {
        const character = guards[guarded]![matched]!;
        checked.set(character.key, character);
      }
      if (guard) checked.set(guard[0]!.key, guard[0]!);

      // Each checked character the symbol may read, then everything else.
      const parts: Array<{
        symbol: RegexSymbol | null;
        character: string | null;
        without: RegexSymbol[];
      }> = [];
      const exclusions = excluded[target]!;
      for (const character of checked.values()) {
        if (symbol !== null && !symbolsMayOverlap(symbol, character)) continue;
        if (exclusions.some((exclusion) => symbolsMayOverlap(exclusion, character))) continue;
        parts.push({ symbol: character, character: character.key, without: [] });
      }
      if (symbol?.kind !== "literal" || !checked.has(symbol.key)) {
        parts.push({ symbol, character: null, without: [...exclusions, ...checked.values()] });
      }

      for (const part of parts) {
        const next: Array<[number, number]> = [];
        let blocked = false;
        const advance = (guarded: number, matched: number) => {
          if (part.character !== guards[guarded]![matched]!.key) return;
          if (matched + 1 === guards[guarded]!.length) blocked = true;
          else next.push([guarded, matched + 1]);
        };
        for (const [guarded, matched] of pending) advance(guarded, matched);
        if (guard) advance(target, 0);
        if (blocked) continue;
        next.sort((left, right) => left[0] - right[0] || left[1] - right[1]);
        const nextId = stateFor(target, part.symbol, part.without, next);
        if (nextId === null) return null;
        graph.follow[id]!.push(nextId);
      }
    }
  }
  return graph;
}

/**
 * Whether two paths through the automaton can leave the same state and meet
 * again in it after reading the same text, by different states or by
 * parallel edges. Such a loop doubles the paths a backtracking engine tries
 * on each pass, so a near miss takes exponential time. This is the
 * exponential-ambiguity test of Allauzen, Mohri and Rastogi (2008): a
 * strongly connected component of the automaton's self-product holding both
 * a pair `(p, p)` and either a pair `(q, r)` with q != r or an edge from a
 * parallel pair. States unreachable from the start are never explored, and
 * dead ends are kept, since the engine explores those paths too.
 */
function hasExponentialAmbiguity(graph: AmbiguityGraph): boolean | null {
  const { excluded, follow, symbols } = graph;
  const size = symbols.length;
  // Whether `symbol` minus `without` may share a character with `other`.
  // Exact when `other` is a single character; conservative otherwise.
  const remainderMayOverlap = (
    symbol: RegexSymbol | null,
    without: RegexSymbol[],
    other: RegexSymbol | null,
  ): boolean => {
    if (symbol == null || other == null) return true;
    if (!symbolsMayOverlap(symbol, other)) return false;
    return (
      other.kind !== "literal" || !without.some((character) => symbolsMayOverlap(character, other))
    );
  };
  const overlaps = new Map<number, boolean>();
  const symbolsOverlap = (left: number, right: number): boolean => {
    const key = left < right ? left * size + right : right * size + left;
    let overlap = overlaps.get(key);
    if (overlap === undefined) {
      overlap =
        remainderMayOverlap(symbols[left]!, excluded[left]!, symbols[right]!) &&
        remainderMayOverlap(symbols[right]!, excluded[right]!, symbols[left]!);
      overlaps.set(key, overlap);
    }
    return overlap;
  };

  // Iterative Tarjan over the product states reachable from (0, 0). States
  // are numbered in visiting order, so the per-state data are dense arrays.
  const index = new Map<number, number>();
  const lowLink: number[] = [];
  const component: number[] = [];
  const stack: number[] = [];
  const onStack: boolean[] = [];
  const parallelEdges: Array<[number, number]> = [];
  let components = 0;
  let edges = 0;

  // Each follow list's targets by the ASCII characters they may read, so a
  // pair of disjoint alternatives is never checked or charged. `wide` holds
  // the targets that may read other characters, which every target checks.
  type FollowIndex = { byCharacter: Map<string, number[]>; wide: number[] };
  const followIndexes = new Map<number, FollowIndex>();
  const followIndex = (position: number): FollowIndex => {
    let followed = followIndexes.get(position);
    if (followed) return followed;
    followed = { byCharacter: new Map(), wide: [] };
    const targets = follow[position]!;
    for (let j = 0; j < targets.length; j++) {
      const symbol = symbols[targets[j]!];
      let characters: Iterable<string> = [];
      if (symbol?.kind === "literal") characters = [symbol.key];
      else if (symbol?.kind === "class" && symbol.nonAscii === "none") characters = symbol.values;
      else followed.wide.push(j);
      for (const character of characters) {
        let indexes = followed.byCharacter.get(character);
        if (!indexes) followed.byCharacter.set(character, (indexes = []));
        indexes.push(j);
      }
    }
    followIndexes.set(position, followed);
    return followed;
  };
  // The targets of `followed` that `target` may share a character with, or
  // null for all of them.
  const candidates = (target: number, followed: FollowIndex): number[] | null => {
    const symbol = symbols[target];
    let characters: Iterable<string>;
    if (symbol?.kind === "literal") {
      const indexes = followed.byCharacter.get(symbol.key) ?? [];
      if (followed.wide.length === 0) return indexes;
      characters = [symbol.key];
    } else if (symbol?.kind === "class" && symbol.nonAscii === "none") {
      characters = symbol.values;
    } else {
      return null;
    }
    const result = new Set(followed.wide);
    for (const character of characters) {
      for (const j of followed.byCharacter.get(character) ?? []) result.add(j);
    }
    return [...result];
  };

  // The successors of every state on the DFS path, each frame's after its
  // parent's.
  const pending: number[] = [];
  const pushSuccessors = (state: number): void => {
    const left = Math.floor(state / size);
    const right = state % size;
    const leftFollow = follow[left]!;
    const rightFollow = follow[right]!;
    // Short lists are cheaper to check pair by pair.
    const rightIndex = rightFollow.length > MAX_UNINDEXED_FOLLOW ? followIndex(right) : null;
    for (let i = 0; i < leftFollow.length; i++) {
      const leftTarget = leftFollow[i]!;
      const indexes = rightIndex ? candidates(leftTarget, rightIndex) : null;
      const count = indexes ? indexes.length : rightFollow.length;
      for (let k = 0; k < count; k++) {
        const j = indexes ? indexes[k]! : k;
        if (++edges > MAX_PRODUCT_EDGES) return;
        const rightTarget = rightFollow[j]!;
        if (!symbolsOverlap(leftTarget, rightTarget)) continue;
        const target = leftTarget * size + rightTarget;
        if (left === right && leftTarget === rightTarget && i !== j) {
          parallelEdges.push([state, target]);
        }
        pending.push(target);
      }
    }
  };

  const states: number[] = [];
  // The DFS path as parallel arrays: each frame's state id, and where its
  // successors start and end in `pending`, and the next one to visit.
  const frameIds: number[] = [];
  const frameStart: number[] = [];
  const frameNext: number[] = [];
  const frameEnd: number[] = [];
  const visit = (state: number): void => {
    const id = states.length;
    index.set(state, id);
    states.push(state);
    lowLink.push(id);
    component.push(-1);
    onStack.push(true);
    stack.push(id);
    frameIds.push(id);
    frameStart.push(pending.length);
    frameNext.push(pending.length);
    pushSuccessors(state);
    frameEnd.push(pending.length);
  };

  visit(0);
  while (frameIds.length > 0) {
    if (edges > MAX_PRODUCT_EDGES) return null;
    const top = frameIds.length - 1;
    const id = frameIds[top]!;
    if (frameNext[top]! < frameEnd[top]!) {
      const target = pending[frameNext[top]!++]!;
      const targetId = index.get(target);
      if (targetId === undefined) {
        visit(target);
      } else if (onStack[targetId]) {
        lowLink[id] = Math.min(lowLink[id]!, targetId);
      }
      continue;
    }
    frameIds.pop();
    frameNext.pop();
    frameEnd.pop();
    pending.length = frameStart.pop()!;
    if (top > 0) {
      const parent = frameIds[top - 1]!;
      lowLink[parent] = Math.min(lowLink[parent]!, lowLink[id]!);
    }
    if (lowLink[id] !== id) continue;
    let hasDiagonal = false;
    let hasOffDiagonal = false;
    let member: number;
    do {
      member = stack.pop()!;
      onStack[member] = false;
      component[member] = components;
      const state = states[member]!;
      if (Math.floor(state / size) === state % size) hasDiagonal = true;
      else hasOffDiagonal = true;
    } while (member !== id);
    components++;
    if (hasDiagonal && hasOffDiagonal) return true;
  }

  return parallelEdges.some(
    ([from, to]) => component[index.get(from)!] === component[index.get(to)!],
  );
}

/**
 * Whether a backtracking engine can take exponentially many paths through
 * `pattern` on one input, as with `(a|aa?)+`, `(a?a?b)+` or `(.*\/)*x`.
 * Polynomial blowups, such as a chain of overlapping repeats, are left to
 * analyzeRegexSafety and analyzeRegexRepetitionChains.
 */
export function analyzeRegexAmbiguity(
  pattern: string,
  options: { ignoreCase?: boolean; namedGroups?: boolean } = {},
): RegexSafetyIssue | null {
  if (pattern.length > MAX_PATTERN_LENGTH) return "analysis budget exceeded";
  const parser = new RegexParser(
    pattern,
    options.ignoreCase === true,
    options.namedGroups ?? mayHaveNamedGroups(pattern),
  );
  const node = parser.parse();
  if (parser.exceededBudget || parser.index !== pattern.length) return "analysis budget exceeded";
  // Unroll repeats exactly while the automaton fits, and only read long
  // repeats as loops when it does not.
  const exact = new PositionAutomaton(MAX_POSITIONS);
  const issue = analyzePositionAutomaton(exact, node);
  if (issue !== "analysis budget exceeded" || !exact.unrolledLongRepeat) return issue;
  return analyzePositionAutomaton(new PositionAutomaton(MAX_UNROLLED_REPEAT), node);
}

function analyzePositionAutomaton(
  automaton: PositionAutomaton,
  node: RegexNode,
): RegexSafetyIssue | null {
  automaton.build(node);
  if (automaton.exceeded) return "analysis budget exceeded";
  const graph = applyLookaheadGuards(automaton);
  if (graph === null) return "analysis budget exceeded";
  const ambiguous = hasExponentialAmbiguity(graph);
  if (ambiguous === null) return "analysis budget exceeded";
  return ambiguous ? "exponentially ambiguous repetition" : null;
}
