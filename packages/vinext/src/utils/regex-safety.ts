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
  | "analysis budget exceeded";

const MAX_NODES = 16_384;
const MAX_NESTING_DEPTH = 256;
const MAX_PATTERN_LENGTH = 65_536;
const MAX_WORDS = 4_096;
const MAX_WORD_SYMBOLS = 32_768;
const MAX_OPAQUE_COMPARISONS = 4_096;
const MAX_SEQUENCE_EXPANSIONS = 256;
const MAX_SAFE_OVERLAPPING_VARIABLE_BOUNDARIES = 1;

function canonicalizeIgnoreCase(character: string): string {
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

const NON_ASCII_COMPLEMENT: Record<NonAsciiDomain, NonAsciiDomain> = {
  none: "all",
  all: "none",
  whitespace: "non-whitespace",
  "non-whitespace": "whitespace",
};

function simpleClassSymbol(raw: string, ignoreCase: boolean): RegexSymbol | null {
  const end = raw.length - 1;
  if (raw[0] !== "[" || raw[end] !== "]") return null;
  // A negated class such as path-to-regexp's `[^\/]` matches every character
  // whose canonical form is outside the listed set.
  const negated = raw[1] === "^";
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

  for (let index = negated ? 2 : 1; index < end; index++) {
    const start = raw[index];
    if (start === "\\") {
      const escaped = raw[++index];
      if (escaped === undefined) return null;
      // An escaped range endpoint such as `[\.-z]` is not modeled.
      if (raw[index + 1] === "-" && index + 2 < end) return null;
      const shorthand = shorthandClassSymbol(escaped, ignoreCase);
      if (shorthand) {
        if (!addClass(shorthand)) return null;
      } else if (!/[\dA-Za-z]/.test(escaped)) {
        // Identity escapes such as `\/` or `\.` match the escaped character.
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

  if (negated) {
    const complement = new Set<string>();
    for (let code = 0; code <= 0x7f; code++) {
      const character = String.fromCharCode(code);
      const key = ignoreCase ? canonicalizeIgnoreCase(character) : character;
      if (!values.has(key)) complement.add(key);
    }
    const complementNonAscii = NON_ASCII_COMPLEMENT[nonAscii];
    if (complement.size === 0 && complementNonAscii === "none") return null;
    return createClassSymbol(complement, complementNonAscii);
  }
  if (values.size === 0 && nonAscii === "none") return null;
  return createClassSymbol(values, nonAscii);
}

class RegexParser {
  index = 0;
  nodes = 0;
  depth = 0;
  exceededBudget = false;

  constructor(
    private readonly pattern: string,
    private readonly ignoreCase: boolean,
  ) {}

  parse(): RegexNode {
    return this.parseAlternation();
  }

  private node<T extends RegexNode>(node: T): T {
    this.nodes++;
    if (this.nodes > MAX_NODES) this.exceededBudget = true;
    return node;
  }

  private parseAlternation(): RegexNode {
    const branches = [this.parseSequence()];
    while (this.pattern[this.index] === "|") {
      this.index++;
      branches.push(this.parseSequence());
    }
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
    const atom = this.parseAtom();
    const quantifier = this.parseQuantifier();
    if (!quantifier) return atom;
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
      return this.node({
        kind: "atom",
        symbol: { kind: "opaque", key: ".", pattern: ".", ignoreCase: this.ignoreCase },
        fixedWidth: true,
      });
    }
    return this.node({
      kind: "atom",
      symbol: literalSymbol(character, this.ignoreCase),
      fixedWidth: true,
    });
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
    if (this.pattern[this.index] === "?") {
      const marker = this.pattern[this.index + 1];
      if (marker === ":") {
        this.index += 2;
      } else if (marker === "=" || marker === "!") {
        assertion = true;
        negativeLookahead = marker === "!";
        this.index += 2;
      } else if (
        marker === "<" &&
        (this.pattern[this.index + 2] === "=" || this.pattern[this.index + 2] === "!")
      ) {
        assertion = true;
        this.index += 3;
      } else if (marker === "<") {
        const nameEnd = this.pattern.indexOf(">", this.index + 2);
        this.index = nameEnd === -1 ? this.pattern.length : nameEnd + 1;
      } else {
        // Inline modifier groups such as `(?i:...)` are not modeled: skipping
        // them would hide their contents (and anything after a nested `)`)
        // from the analysis, so fail closed.
        this.exceededBudget = true;
        this.skipGroup();
        this.depth--;
        return this.node({ kind: "atom", symbol: null, fixedWidth: false });
      }
    }

    const child = this.parseAlternation();
    if (this.pattern[this.index] === ")") this.index++;
    this.depth--;
    return assertion ? this.node({ kind: "assertion", child, negativeLookahead }) : child;
  }

  private skipGroup(): void {
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
    return this.node({
      kind: "atom",
      symbol:
        simpleClassSymbol(raw, this.ignoreCase) ??
        ({ kind: "opaque", key: raw, pattern: raw, ignoreCase: this.ignoreCase } as const),
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
    const shorthand = shorthandClassSymbol(escaped, this.ignoreCase);
    if (shorthand) {
      return this.node({ kind: "atom", symbol: shorthand, fixedWidth: true });
    }
    if (/\d/.test(escaped)) {
      return this.node({ kind: "atom", symbol: null, fixedWidth: false });
    }

    let literal: string | null = null;
    if (escaped === "x" && /^[\da-fA-F]{2}/.test(this.pattern.slice(this.index, this.index + 2))) {
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
    } else if ("nrtvf0".includes(escaped)) {
      literal = ({ n: "\n", r: "\r", t: "\t", v: "\v", f: "\f", 0: "\0" } as const)[
        escaped as "n" | "r" | "t" | "v" | "f" | "0"
      ];
    } else if (!/[A-Za-z]/.test(escaped)) {
      literal = escaped;
    }

    if (literal !== null) {
      return this.node({
        kind: "atom",
        symbol: literalSymbol(literal, this.ignoreCase),
        fixedWidth: true,
      });
    }
    const raw = `\\${escaped}`;
    return this.node({
      kind: "atom",
      symbol: { kind: "opaque", key: raw, pattern: raw, ignoreCase: this.ignoreCase },
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

function containsUnboundedRepetition(node: RegexNode): boolean {
  switch (node.kind) {
    case "atom":
      return false;
    case "assertion":
      return containsUnboundedRepetition(node.child);
    case "sequence":
      return node.children.some(containsUnboundedRepetition);
    case "alternation":
      return node.branches.some(containsUnboundedRepetition);
    case "repeat":
      return node.max === Infinity || containsUnboundedRepetition(node.child);
  }
}

/**
 * A lookaround consumes nothing, so width and repetition checks treat it as
 * free. It still scans the input each time it runs: one with an unbounded
 * repetition, such as `(?=a*b)`, does linear work per evaluation and turns a
 * surrounding repetition quadratic.
 *
 * With a `separator`, a lookaround that can never match the separator stops
 * scanning at the next occurrence of it, so it is not counted.
 */
function containsUnboundedLookaround(node: RegexNode, separator?: RegexSymbol): boolean {
  switch (node.kind) {
    case "atom":
      return false;
    case "assertion":
      return (
        containsUnboundedRepetition(node.child) &&
        !(separator && scanStopsAtSeparator(node.child, separator))
      );
    case "sequence":
      return node.children.some((child) => containsUnboundedLookaround(child, separator));
    case "alternation":
      return node.branches.some((branch) => containsUnboundedLookaround(branch, separator));
    case "repeat":
      return containsUnboundedLookaround(node.child, separator);
  }
}

/**
 * Whether every match of `node` avoids `separator`, including the text that
 * nested lookarounds with unbounded repetition scan: `(?=(?!.*Z)a)` consumes
 * no separator, but its inner lookahead still scans to the end of the input.
 */
function scanStopsAtSeparator(node: RegexNode, separator: RegexSymbol): boolean {
  return fixedSeparatorCount(node, separator) === 0 && nestedScansStopAtSeparator(node, separator);
}

function nestedScansStopAtSeparator(node: RegexNode, separator: RegexSymbol): boolean {
  switch (node.kind) {
    case "atom":
      return true;
    case "assertion":
      return (
        !containsUnboundedRepetition(node.child) || scanStopsAtSeparator(node.child, separator)
      );
    case "sequence":
      return node.children.every((child) => nestedScansStopAtSeparator(child, separator));
    case "alternation":
      return node.branches.every((branch) => nestedScansStopAtSeparator(branch, separator));
    case "repeat":
      return nestedScansStopAtSeparator(node.child, separator);
  }
}

/** Variable-width elements a match passes through in sequence, capped at 2. */
function variableWidthElements(node: RegexNode): number {
  switch (node.kind) {
    case "atom":
      return node.fixedWidth ? 0 : 1;
    case "assertion":
      return 0;
    case "sequence":
      return Math.min(
        2,
        node.children.reduce((count, child) => count + variableWidthElements(child), 0),
      );
    case "alternation":
      return Math.max(0, ...node.branches.map(variableWidthElements));
    case "repeat": {
      const inner = variableWidthElements(node.child);
      if (node.min === node.max && Number.isFinite(node.max)) {
        return Math.min(2, inner * node.min);
      }
      return Math.min(2, 1 + inner);
    }
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
      if (node.min !== node.max || !Number.isFinite(node.max)) return null;
      let words: RegexSymbol[][] = [[]];
      const childWords = fixedWords(node.child, budget);
      if (!childWords) return null;
      for (let count = 0; count < node.min; count++) {
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

function insertPrefixFreeWord(
  root: TrieNode,
  word: RegexSymbol[],
  comparisons: { count: number },
): boolean {
  let node = root;
  for (const symbol of word) {
    if (node.terminal) return false;
    let edge = node.edges.get(symbol.key);
    if (!edge) {
      const candidates = symbol.kind === "literal" ? node.complexEdges : node.edges.values();
      for (const candidate of candidates) {
        if (++comparisons.count > MAX_OPAQUE_COMPARISONS) return false;
        if (symbolsMayOverlap(candidate.symbol, symbol)) return false;
      }
      edge = { symbol, node: createTrieNode() };
      node.edges.set(symbol.key, edge);
      if (symbol.kind !== "literal") node.complexEdges.push(edge);
    }
    node = edge.node;
  }
  if (node.terminal || node.edges.size > 0) return false;
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

/**
 * An alternation such as `(\d+|new)`, where every branch without a finite
 * word set has an unbounded repetition and passes through only one
 * variable-width element. Sequence analysis treats it like a single variable
 * repetition with the alternation's first and last symbols; a branch such as
 * `a*a*` would hide a second overlapping boundary, so it still fails closed.
 */
function isUnboundedAlternation(node: RegexNode): boolean {
  if (node.kind !== "alternation") return false;
  let unbounded = false;
  for (const branch of node.branches) {
    if (fixedWords(branch, { words: 0, symbols: 0, exceeded: false })) continue;
    if (!containsUnboundedRepetition(branch) || variableWidthElements(branch) > 1) return false;
    unbounded = true;
  }
  return unbounded;
}

function ambiguousExpansionFactor(node: RegexNode): number {
  switch (node.kind) {
    case "atom":
    case "assertion":
      return 1;
    case "alternation": {
      const result = hasPrefixFreeFiniteLanguage(node);
      if (result.safe) return 1;
      if (result.budgetExceeded) return MAX_SEQUENCE_EXPANSIONS + 1;
      if (result.wordCount > 0) return result.wordCount;
      if (!isUnboundedAlternation(node)) return MAX_SEQUENCE_EXPANSIONS + 1;
      // Count each branch's own paths; findSequenceIssue() checks the
      // unbounded branch's variable width against its neighbours.
      let factor = 0;
      for (const branch of node.branches) {
        factor += ambiguousExpansionFactor(branch);
        if (factor > MAX_SEQUENCE_EXPANSIONS) return factor;
      }
      return factor;
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

type PendingBoundary = {
  ends: RegexSymbol[] | null;
  consumed: RegexSymbol[] | null;
  repeatable: RegexSymbol[] | null;
  alternation: boolean;
};

/** Symbols an unbounded repetition inside `node` can consume, or null if unknown. */
function repeatableSymbols(node: RegexNode): RegexSymbol[] | null {
  switch (node.kind) {
    case "atom":
    case "assertion":
      return [];
    case "repeat":
      return node.max === Infinity ? consumedSymbols(node.child) : repeatableSymbols(node.child);
    case "sequence":
    case "alternation": {
      const symbols: RegexSymbol[] = [];
      for (const child of node.kind === "sequence" ? node.children : node.branches) {
        const childSymbols = repeatableSymbols(child);
        if (!childSymbols) return null;
        symbols.push(...childSymbols);
      }
      return symbols;
    }
  }
}

function findSequenceIssue(
  node: Extract<RegexNode, { kind: "sequence" }>,
): RegexSafetyIssue | null {
  if (ambiguousExpansionFactor(node) > MAX_SEQUENCE_EXPANSIONS) {
    return "ambiguous sequence expansion";
  }

  let pending: PendingBoundary[] = [];
  // Earlier elements whose unbounded repetition may also have consumed the
  // fixed text since, so their variable boundary is still open. Between two
  // repetitions a fixed element keeps the established rule and resets them.
  let carried: PendingBoundary[] = [];
  const comparisons = { count: 0 };
  const carriedComparisons = { count: 0 };
  let overlappingBoundaryCount = 0;
  for (const child of node.children) {
    const alternation = child.kind !== "repeat";
    const variableRepetition =
      child.kind === "repeat"
        ? child.min !== child.max || !Number.isFinite(child.max)
        : isUnboundedAlternation(child);
    if (variableRepetition) {
      const starts = firstSymbols(child);
      // An unbounded alternation counts as a variable repetition at its
      // boundaries, including one across fixed text the other side can
      // consume (`(.*)/(\d+|new)`), so it shares the overlapping-boundary
      // budget below. Two of them may never overlap: `(?:a+|x)(?:a+|x)` and
      // `(?:a+|x)a(?:a+|x)` still fail closed.
      const carriedOverlaps = carried.filter(
        (boundary) =>
          (alternation || boundary.alternation) &&
          boundariesMayOverlap(boundary.consumed, starts, carriedComparisons),
      );
      const overlapping = pending.map((boundary) =>
        boundariesMayOverlap(boundary.ends, starts, comparisons),
      );
      if (
        alternation &&
        (carriedOverlaps.some((boundary) => boundary.alternation) ||
          overlapping.some((overlaps, index) => overlaps && pending[index].alternation))
      ) {
        return "overlapping sequential repetition";
      }
      const overlappingBoundaries =
        overlapping.filter(Boolean).length + (carriedOverlaps.length > 0 ? 1 : 0);
      if (overlappingBoundaries > 0) {
        overlappingBoundaryCount += overlapping.some(Boolean) && carriedOverlaps.length > 0 ? 2 : 1;
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
      const boundary = {
        ends: lastSymbols(child),
        consumed: consumedSymbols(child),
        repeatable: repeatableSymbols(child),
        alternation,
      };
      if (isNullable(child)) {
        pending = [...pending, boundary];
      } else {
        pending = [boundary];
        carried = [];
      }
    } else if (!isNullable(child)) {
      const symbols = consumedSymbols(child);
      carried = [...carried, ...pending].filter((boundary) =>
        boundariesMayOverlap(boundary.repeatable, symbols, carriedComparisons),
      );
      pending = [];
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
      if (node.max === Infinity && containsUnboundedLookaround(node.child)) {
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

export function analyzeRegexSafety(
  pattern: string,
  options: { ignoreCase?: boolean } = {},
): RegexSafetyIssue | null {
  if (pattern.length > MAX_PATTERN_LENGTH) return "analysis budget exceeded";
  const parser = new RegexParser(pattern, options.ignoreCase === true);
  const node = parser.parse();
  if (parser.exceededBudget) return "analysis budget exceeded";
  return findSafetyIssue(node);
}

export function regexAtomsMayOverlap(left: string, right: string, ignoreCase = false): boolean {
  const leftParser = new RegexParser(left, ignoreCase);
  const rightParser = new RegexParser(right, ignoreCase);
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

/**
 * How many times `separator` occurs in every match of `node`, or null when
 * that number can vary (or cannot be determined).
 */
function fixedSeparatorCount(node: RegexNode, separator: RegexSymbol): number | null {
  switch (node.kind) {
    case "atom": {
      if (!node.symbol) return null;
      if (!symbolsMayOverlap(node.symbol, separator)) return 0;
      const onlySeparator =
        node.symbol.kind === "literal" ||
        (node.symbol.kind === "class" &&
          node.symbol.values.size === 1 &&
          node.symbol.nonAscii === "none");
      return onlySeparator ? 1 : null;
    }
    case "assertion":
      return 0;
    case "sequence": {
      let count = 0;
      for (let index = 0; index < node.children.length; index++) {
        const child = node.children[index];
        const previous = node.children[index - 1];
        // `(?!\.)[^\/]`, path-to-regexp's default pattern after a `.` prefix,
        // excludes the separator from the atom it guards.
        if (
          child.kind === "atom" &&
          previous?.kind === "assertion" &&
          previous.negativeLookahead &&
          previous.child.kind === "atom" &&
          previous.child.symbol?.kind === "literal" &&
          previous.child.symbol.key === separator.key
        ) {
          continue;
        }
        const childCount = fixedSeparatorCount(child, separator);
        if (childCount === null) return null;
        count += childCount;
      }
      return count;
    }
    case "alternation": {
      let count: number | undefined;
      for (const branch of node.branches) {
        const branchCount = fixedSeparatorCount(branch, separator);
        if (branchCount === null || (count !== undefined && branchCount !== count)) return null;
        count = branchCount;
      }
      return count ?? 0;
    }
    case "repeat": {
      const childCount = fixedSeparatorCount(node.child, separator);
      if (childCount === null) return null;
      if (childCount === 0) return 0;
      return node.min === node.max && Number.isFinite(node.max) ? childCount * node.min : null;
    }
  }
}

export type SeparatedRepetitionIssue =
  | "unbounded lookaround"
  | "separator overlap"
  | "ambiguous pattern"
  | "analysis budget exceeded";

/** Every symbol `node` can consume, or null when one is unknown. */
function consumedSymbols(node: RegexNode): RegexSymbol[] | null {
  switch (node.kind) {
    case "atom":
      return node.symbol ? [node.symbol] : null;
    case "assertion":
      return [];
    case "repeat":
      return consumedSymbols(node.child);
    case "sequence":
    case "alternation": {
      const symbols: RegexSymbol[] = [];
      for (const child of node.kind === "sequence" ? node.children : node.branches) {
        const childSymbols = consumedSymbols(child);
        if (!childSymbols) return null;
        symbols.push(...childSymbols);
      }
      return symbols;
    }
  }
}

/** Whether two parsed elements are structurally identical. */
function sameNode(left: RegexNode, right: RegexNode): boolean {
  switch (left.kind) {
    case "atom":
      return (
        right.kind === "atom" &&
        left.fixedWidth === right.fixedWidth &&
        left.symbol !== null &&
        left.symbol.key === right.symbol?.key
      );
    case "assertion":
      // Lookaheads and lookbehinds share this node shape.
      return false;
    case "repeat":
      return (
        right.kind === "repeat" &&
        left.min === right.min &&
        left.max === right.max &&
        sameNode(left.child, right.child)
      );
    case "sequence":
      return (
        right.kind === "sequence" &&
        left.children.length === right.children.length &&
        left.children.every((child, index) => sameNode(child, right.children[index]))
      );
    case "alternation":
      return (
        right.kind === "alternation" &&
        left.branches.length === right.branches.length &&
        left.branches.every((branch, index) => sameNode(branch, right.branches[index]))
      );
  }
}

/** Whether two alternatives may both match some text. */
function branchesMayShareText(
  left: RegexNode,
  right: RegexNode,
  comparisons: { count: number },
): boolean {
  const leftWords = fixedWords(left, { words: 0, symbols: 0, exceeded: false });
  const rightWords = fixedWords(right, { words: 0, symbols: 0, exceeded: false });
  if (leftWords && rightWords) {
    for (const leftWord of leftWords) {
      for (const rightWord of rightWords) {
        if (leftWord.length !== rightWord.length) continue;
        let shared = true;
        for (let index = 0; index < leftWord.length && shared; index++) {
          if (++comparisons.count > MAX_OPAQUE_COMPARISONS) return true;
          shared = symbolsMayOverlap(leftWord[index], rightWord[index]);
        }
        if (shared) return true;
      }
    }
    return false;
  }
  // Shared text must agree symbol by symbol, so walk the prefix both
  // alternatives start with (`ab+` and `ac+` differ after `a`), then compare
  // the first symbols of what remains.
  const leftItems = left.kind === "sequence" ? left.children : [left];
  const rightItems = right.kind === "sequence" ? right.children : [right];
  let index = 0;
  for (; index < leftItems.length && index < rightItems.length; index++) {
    const leftItem = leftItems[index];
    const rightItem = rightItems[index];
    if (
      leftItem.kind === "atom" &&
      leftItem.symbol &&
      leftItem.fixedWidth &&
      rightItem.kind === "atom" &&
      rightItem.symbol &&
      rightItem.fixedWidth
    ) {
      if (++comparisons.count > MAX_OPAQUE_COMPARISONS) return true;
      if (!symbolsMayOverlap(leftItem.symbol, rightItem.symbol)) return false;
      continue;
    }
    // An identical element (`a+` in `a+b|a+c`) takes the same text in both
    // when neither remainder can start with a symbol it consumes: it must
    // stop where the remainder begins.
    if (!sameNode(leftItem, rightItem)) break;
    const leftAfter: RegexNode = { kind: "sequence", children: leftItems.slice(index + 1) };
    const rightAfter: RegexNode = { kind: "sequence", children: rightItems.slice(index + 1) };
    if (isNullable(leftAfter) || isNullable(rightAfter)) break;
    const consumed = consumedSymbols(leftItem);
    if (
      boundariesMayOverlap(consumed, firstSymbols(leftAfter), comparisons) ||
      boundariesMayOverlap(consumed, firstSymbols(rightAfter), comparisons)
    ) {
      break;
    }
  }
  const leftRest: RegexNode = { kind: "sequence", children: leftItems.slice(index) };
  const rightRest: RegexNode = { kind: "sequence", children: rightItems.slice(index) };
  if (isNullable(leftRest) && isNullable(rightRest)) return true;
  return boundariesMayOverlap(firstSymbols(leftRest), firstSymbols(rightRest), comparisons);
}

const MAX_OPTIONAL_SPLIT_ELEMENTS = 8;

/**
 * Whether a sequence may split some text between its elements in more than one
 * way. A variable-width element followed by others can only take text from
 * the next element if it can consume that element's first symbol, so a fixed
 * element it cannot start into (the `-` in `\w+-\w+`) fixes the split.
 */
function hasAmbiguousSplit(children: RegexNode[], comparisons: { count: number }): boolean {
  // Earlier variable-width elements the next one may directly follow: the
  // previous one, and those before it when only optional elements are
  // between. Each keeps the fixed elements since, to compute the split
  // frontier through them.
  let pending: Array<{ body: RegexSymbol[] | null; block: RegexNode[] }> = [];
  for (const child of children) {
    const width = exactWidth(child);
    if (width === 0) continue;
    if (width !== null) {
      for (const entry of pending) entry.block.push(child);
      continue;
    }
    const starts = firstSymbols(child);
    for (const earlier of pending) {
      const next =
        earlier.block.length === 0 ? earlier.body : splitFrontier(earlier.body, earlier.block);
      if (boundariesMayOverlap(next, starts, comparisons)) return true;
    }
    const entry: { body: RegexSymbol[] | null; block: RegexNode[] } = {
      body: consumedSymbols(child),
      block: [],
    };
    if (!isNullable(child)) {
      pending = [entry];
    } else if (pending.length < MAX_OPTIONAL_SPLIT_ELEMENTS) {
      pending = [...pending, entry];
    } else {
      return hasAmbiguousSplitWithOptionalElements(children, comparisons);
    }
  }
  return false;
}

/**
 * The symbols that can start the element after `block` when a variable-width
 * element with `body` before it takes a different amount of text. It either
 * swallows a whole block word (then the next element starts with a body or
 * block symbol), or takes part of one and the block shifts onto itself (then
 * the next element starts with the shifted word's remaining symbol).
 */
function splitFrontier(body: RegexSymbol[] | null, block: RegexNode[]): RegexSymbol[] | null {
  const words = fixedWords(
    { kind: "sequence", children: block },
    {
      words: 0,
      symbols: 0,
      exceeded: false,
    },
  );
  if (!body || !words) return null;
  let comparisons = 0;
  const overlaps = (left: RegexSymbol, right: RegexSymbol): boolean | null =>
    ++comparisons > MAX_OPAQUE_COMPARISONS ? null : symbolsMayOverlap(left, right);
  const frontier: RegexSymbol[] = [];
  for (const word of words) {
    let absorbed = 0;
    for (; absorbed < word.length; absorbed++) {
      let any = false;
      for (const symbol of body) {
        const result = overlaps(symbol, word[absorbed]);
        if (result === null) return null;
        if (result) {
          any = true;
          break;
        }
      }
      if (!any) break;
    }
    if (absorbed === word.length) {
      frontier.push(...body);
      for (const other of words) if (other[0]) frontier.push(other[0]);
    }
    for (let shift = 1; shift <= absorbed && shift < word.length; shift++) {
      for (const other of words) {
        if (other.length !== word.length) return null;
        let aligned = true;
        for (let offset = 0; shift + offset < word.length && aligned; offset++) {
          const result = overlaps(word[shift + offset], other[offset]);
          if (result === null) return null;
          aligned = result;
        }
        if (aligned) frontier.push(other[word.length - shift]);
      }
    }
  }
  return frontier;
}

/**
 * Conservative split check for sequences with an optional variable-width
 * element: a later element may start where an earlier one could have taken
 * text, so carry every symbol each earlier element may still consume.
 */
function hasAmbiguousSplitWithOptionalElements(
  children: RegexNode[],
  comparisons: { count: number },
): boolean {
  // Symbols each earlier variable-width element may still consume.
  let pending: Array<RegexSymbol[] | null> = [];
  for (const child of children) {
    const width = exactWidth(child);
    if (width === 0) continue;
    const starts = firstSymbols(child);
    if (width !== null) {
      const symbols = consumedSymbols(child);
      pending = pending
        .filter((body) => boundariesMayOverlap(body, starts, comparisons))
        .map((body) => (body && symbols ? [...body, ...symbols] : null));
      continue;
    }
    if (pending.some((body) => boundariesMayOverlap(body, starts, comparisons))) return true;
    const body = consumedSymbols(child);
    pending = isNullable(child) ? [...pending, body] : [body];
  }
  return false;
}

/**
 * Conservative check that every text `node` matches has one parse. A repeated
 * param multiplies any ambiguity in its pattern by every occurrence, so
 * `(a|a)` or `[^/]+b[^/]+` repeated backtracks exponentially. Repetitions are
 * already limited by analyzeRegexSafety() to fixed-width or prefix-free
 * children, which repeat unambiguously.
 */
function isUnambiguous(node: RegexNode, comparisons: { count: number }): boolean {
  switch (node.kind) {
    case "atom":
    case "assertion":
      return true;
    case "repeat":
      return isUnambiguous(node.child, comparisons);
    case "alternation": {
      if (!node.branches.every((branch) => isUnambiguous(branch, comparisons))) return false;
      for (let left = 0; left < node.branches.length; left++) {
        for (let right = left + 1; right < node.branches.length; right++) {
          if (branchesMayShareText(node.branches[left], node.branches[right], comparisons)) {
            return false;
          }
        }
      }
      return true;
    }
    case "sequence":
      return (
        node.children.every((child) => isUnambiguous(child, comparisons)) &&
        !hasAmbiguousSplit(node.children, comparisons)
      );
  }
}

const MAX_DECODING_COMPARISONS = 65_536;

/**
 * Sardinas–Patterson test: whether every concatenation of `codewords` has a
 * single factorization. Dangling suffixes are tracked as (codeword, offset)
 * positions, so the work is bounded by the total codeword length. Symbols are
 * compared with symbolsMayOverlap(), which only errs towards ambiguity.
 */
function isUniquelyDecodable(codewords: RegexSymbol[][]): boolean {
  const seen = new Set<string>();
  const queue: Array<[number, number]> = [];
  let comparisons = 0;

  // Compares the rest of codewords[word] from `offset` with `candidate`.
  // Returns false if both may match the same text (an empty dangling suffix)
  // or the budget runs out; otherwise queues any new dangling suffix.
  const compare = (word: number, offset: number, candidate: number): boolean => {
    const rest = codewords[word].length - offset;
    const other = codewords[candidate];
    const length = Math.min(rest, other.length);
    for (let index = 0; index < length; index++) {
      if (++comparisons > MAX_DECODING_COMPARISONS) return false;
      if (!symbolsMayOverlap(codewords[word][offset + index], other[index])) return true;
    }
    if (rest === other.length) return false;
    const next: [number, number] =
      rest > other.length ? [word, offset + other.length] : [candidate, rest];
    const key = `${next[0]}:${next[1]}`;
    if (!seen.has(key)) {
      seen.add(key);
      queue.push(next);
    }
    return true;
  };

  for (let word = 0; word < codewords.length; word++) {
    for (let candidate = word + 1; candidate < codewords.length; candidate++) {
      if (!compare(word, 0, candidate)) return false;
    }
  }
  for (let index = 0; index < queue.length; index++) {
    const [word, offset] = queue[index];
    for (let candidate = 0; candidate < codewords.length; candidate++) {
      if (!compare(word, offset, candidate)) return false;
    }
  }
  return true;
}

/**
 * Whether a finite pattern such as `foo/bar|baz`, repeated as
 * `P(?:separator P)*`, splits every input one way: the words with the
 * separator in front must form a uniquely decodable code.
 */
function hasUnambiguousSeparatedWords(
  node: RegexNode,
  separator: string,
  ignoreCase: boolean,
): boolean {
  if (hasPrefixFreeFiniteLanguage(node).safe) return true;
  const words = fixedWords(node, { words: 0, symbols: 0, exceeded: false });
  if (!words) return false;
  // Split by UTF-16 code unit, as RegexParser and non-`u` RegExps do.
  const prefix = separator.split("").map((character) => literalSymbol(character, ignoreCase));
  return isUniquelyDecodable(words.map((word) => [...prefix, ...word]));
}

/**
 * Check a pattern that is repeated with a literal separator between
 * occurrences, as path-to-regexp compiles `:name*` and `:name+`:
 * `P(?:separator P)*`. The pattern itself is checked by analyzeRegexSafety.
 *
 * Any ambiguity in the pattern is multiplied by every occurrence, so the
 * pattern must match each text one way.
 *
 * The repetition has a single partition of its input if every occurrence has
 * the same width, if every match of the pattern contains the separator's
 * first character the same number of times, or if the pattern is a finite set
 * of words such as `foo/bar|baz` that the separator splits one way. Otherwise
 * a pattern such as `a+` with separator `a`, or `a/a|a` with separator `/`,
 * splits the same text many ways and backtracks exponentially.
 */
export function analyzeSeparatedRepetitionSafety(
  pattern: string,
  separator: string,
  options: { ignoreCase?: boolean } = {},
): SeparatedRepetitionIssue | null {
  if (pattern.length > MAX_PATTERN_LENGTH) return "analysis budget exceeded";
  const ignoreCase = options.ignoreCase === true;
  const parser = new RegexParser(pattern, ignoreCase);
  const node = parser.parse();
  // Fail closed if the parser stopped early, e.g. at an unsupported group.
  if (parser.exceededBudget || parser.index < pattern.length) return "analysis budget exceeded";
  const separatorSymbol = separator ? literalSymbol(separator[0], ignoreCase) : undefined;
  if (containsUnboundedLookaround(node, separatorSymbol)) return "unbounded lookaround";
  if (!isUnambiguous(node, { count: 0 })) return "ambiguous pattern";
  if (
    separatorSymbol &&
    exactWidth(node) === null &&
    fixedSeparatorCount(node, separatorSymbol) === null &&
    !hasUnambiguousSeparatedWords(node, separator, ignoreCase)
  ) {
    return "separator overlap";
  }
  return null;
}
