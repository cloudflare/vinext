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
  | { kind: "assertion"; child: RegexNode }
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
    if (this.pattern[this.index] === "?") {
      const marker = this.pattern[this.index + 1];
      if (marker === ":") {
        this.index += 2;
      } else if (marker === "=" || marker === "!") {
        assertion = true;
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
        // Unsupported group prefixes will be rejected by RegExp compilation.
        // Keep analysis conservative if this parser is asked to inspect one.
        while (this.index < this.pattern.length && this.pattern[this.index] !== ")") this.index++;
        if (this.pattern[this.index] === ")") this.index++;
        this.depth--;
        return this.node({ kind: "atom", symbol: null, fixedWidth: false });
      }
    }

    const child = this.parseAlternation();
    if (this.pattern[this.index] === ")") this.index++;
    this.depth--;
    return assertion ? this.node({ kind: "assertion", child }) : child;
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
