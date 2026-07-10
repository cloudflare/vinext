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
  | { kind: "opaque"; key: string; pattern: string; ignoreCase: boolean };

export type RegexSafetyIssue =
  | "nested repetition"
  | "ambiguous alternatives under repetition"
  | "analysis budget exceeded";

const MAX_NODES = 16_384;
const MAX_NESTING_DEPTH = 256;
const MAX_PATTERN_LENGTH = 65_536;
const MAX_WORDS = 4_096;
const MAX_WORD_SYMBOLS = 32_768;
const MAX_OPAQUE_COMPARISONS = 4_096;

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
      children.push(this.parseTerm());
    }
    return children.length === 1 ? children[0] : this.node({ kind: "sequence", children });
  }

  private parseTerm(): RegexNode {
    const atom = this.parseAtom();
    const quantifier = this.parseQuantifier();
    if (!quantifier) return atom;
    if (this.pattern[this.index] === "?") this.index++;
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
      symbol: { kind: "opaque", key: raw, pattern: raw, ignoreCase: this.ignoreCase },
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
  literals: Map<string, TrieEdge>;
  opaque: TrieEdge[];
};

function createTrieNode(): TrieNode {
  return { terminal: false, literals: new Map(), opaque: [] };
}

function opaqueMatchesLiteral(opaque: RegexSymbol, literal: RegexSymbol): boolean {
  if (opaque.kind !== "opaque" || literal.kind !== "literal") return false;
  try {
    return new RegExp(`^(?:${opaque.pattern})$`, opaque.ignoreCase ? "i" : "").test(literal.value);
  } catch {
    return true;
  }
}

function insertPrefixFreeWord(
  root: TrieNode,
  word: RegexSymbol[],
  comparisons: { count: number },
): boolean {
  let node = root;
  for (const symbol of word) {
    if (node.terminal) return false;
    let edge: TrieEdge | undefined;
    if (symbol.kind === "literal") {
      edge = node.literals.get(symbol.key);
      for (const opaque of node.opaque) {
        if (++comparisons.count > MAX_OPAQUE_COMPARISONS) return false;
        if (opaqueMatchesLiteral(opaque.symbol, symbol)) return false;
      }
      if (!edge) {
        edge = { symbol, node: createTrieNode() };
        node.literals.set(symbol.key, edge);
      }
    } else {
      for (const literal of node.literals.values()) {
        if (++comparisons.count > MAX_OPAQUE_COMPARISONS) return false;
        if (opaqueMatchesLiteral(symbol, literal.symbol)) return false;
      }
      edge = node.opaque.find((candidate) => candidate.symbol.key === symbol.key);
      if (!edge && node.opaque.length > 0) return false;
      if (!edge) {
        edge = { symbol, node: createTrieNode() };
        node.opaque.push(edge);
      }
    }
    node = edge.node;
  }
  if (node.terminal || node.literals.size > 0 || node.opaque.length > 0) return false;
  node.terminal = true;
  return true;
}

function hasPrefixFreeFiniteLanguage(node: RegexNode): { safe: boolean; budgetExceeded: boolean } {
  const budget: WordBudget = { words: 0, symbols: 0, exceeded: false };
  const words = fixedWords(node, budget);
  if (!words) return { safe: false, budgetExceeded: budget.exceeded };
  const root = createTrieNode();
  const comparisons = { count: 0 };
  for (const word of words) {
    if (!insertPrefixFreeWord(root, word, comparisons)) {
      return {
        safe: false,
        budgetExceeded: comparisons.count > MAX_OPAQUE_COMPARISONS,
      };
    }
  }
  return { safe: true, budgetExceeded: false };
}

function findSafetyIssue(node: RegexNode): RegexSafetyIssue | null {
  switch (node.kind) {
    case "atom":
      return null;
    case "assertion":
      return findSafetyIssue(node.child);
    case "sequence":
      for (const child of node.children) {
        const issue = findSafetyIssue(child);
        if (issue) return issue;
      }
      return null;
    case "alternation":
      for (const branch of node.branches) {
        const issue = findSafetyIssue(branch);
        if (issue) return issue;
      }
      return null;
    case "repeat": {
      const nestedRepetition = containsConsumingRepetition(node.child);
      if (node.max === Infinity && nestedRepetition) return "nested repetition";
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
  if (leftSymbol.kind === "literal" && rightSymbol.kind === "literal") {
    return leftSymbol.key === rightSymbol.key;
  }
  if (leftSymbol.kind === "opaque" && rightSymbol.kind === "literal") {
    return opaqueMatchesLiteral(leftSymbol, rightSymbol);
  }
  if (leftSymbol.kind === "literal" && rightSymbol.kind === "opaque") {
    return opaqueMatchesLiteral(rightSymbol, leftSymbol);
  }
  return true;
}
