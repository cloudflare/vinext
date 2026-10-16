import {
  analyzeRegexAmbiguity,
  analyzeRegexSafety,
  analyzeRegexRepetitionChains,
  countCapturingGroups,
  mayHaveNamedGroups,
  type CaptureContext,
  regexAtomsMayOverlap,
} from "./regex-safety.js";
import { pathTokensToRegExpSource, type PathKey, type PathToken } from "./path-to-regexp.js";

function patternMatches(pattern: string, value: string): boolean {
  try {
    return new RegExp(`^(?:${pattern})$`).test(value);
  } catch {
    return false;
  }
}

function atomsOverlap(left: string, right: string): boolean {
  return regexAtomsMayOverlap(left, right, true);
}

function groupCanMatchEmpty(group: string): boolean {
  if (/^\?(?:[=!]|<[=!])/.test(group)) return true;
  const body = group.startsWith("?:") ? group.slice(2) : group;
  return patternMatches(body, "");
}

function hasOverlappingSequentialRepetition(pattern: string): boolean {
  const repeatedAtDepth: string[][] = [[]];
  const groupStarts: number[] = [];
  let depth = 0;

  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index];
    if (character === "(") {
      groupStarts.push(index);
      depth++;
      repeatedAtDepth[depth] = [];
      if (pattern[index + 1] === "?") {
        // Skip the non-capturing/lookaround marker. Its punctuation is not a
        // consuming atom, and the existing validator handles quantified
        // lookaround groups conservatively.
        index++;
        if (pattern[index + 1] === "<" && /[=!]/.test(pattern[index + 2] ?? "")) index += 2;
        else if (/[=:!]/.test(pattern[index + 1] ?? "")) index++;
      }
      continue;
    }
    if (character === ")") {
      const groupStart = groupStarts.pop();
      repeatedAtDepth[depth] = [];
      depth = Math.max(0, depth - 1);
      if (groupStart !== undefined) {
        const modifier = pattern[index + 1];
        const optionalModifier =
          modifier === "*" ||
          modifier === "?" ||
          (modifier === "{" && /^\{0(?:,\d*)?\}/.test(pattern.slice(index + 1)));
        if (!optionalModifier && !groupCanMatchEmpty(pattern.slice(groupStart + 1, index))) {
          repeatedAtDepth[depth] = [];
        }
      }
      continue;
    }
    if (character === "|") {
      repeatedAtDepth[depth] = [];
      continue;
    }
    if (character === "^" || character === "$") continue;
    if (character === "*" || character === "+" || character === "?" || character === "{") {
      continue;
    }

    let atom = character;
    if (character === "\\") {
      if (index + 1 >= pattern.length) return true;
      atom += pattern[++index];
    } else if (character === "[") {
      let classEnd = index + 1;
      if (pattern[classEnd] === "^") classEnd++;
      while (classEnd < pattern.length && pattern[classEnd] !== "]") {
        if (pattern[classEnd] === "\\") classEnd++;
        classEnd++;
      }
      if (classEnd >= pattern.length) return true;
      atom = pattern.slice(index, classEnd + 1);
      index = classEnd;
    } else if (character === ".") {
      atom = ".";
    }

    const quantifierStart = index + 1;
    const quantifier = pattern[quantifierStart];
    let unbounded = quantifier === "*" || quantifier === "+";
    let canBeEmpty = quantifier === "*";
    let quantifierEnd = quantifierStart;
    if (quantifier === "{") {
      const match = /^\{(\d+),\}/.exec(pattern.slice(quantifierStart));
      if (match) {
        unbounded = true;
        canBeEmpty = Number(match[1]) === 0;
        quantifierEnd += match[0].length - 1;
      }
    }

    if (!unbounded) {
      // An optional atom does not separate the repetitions on either side;
      // every other non-repeated atom is a mandatory separator.
      if (quantifier !== "?") repeatedAtDepth[depth] = [];
      if (quantifier === "?") index = quantifierStart;
      continue;
    }

    if (repeatedAtDepth[depth].some((previous) => atomsOverlap(previous, atom))) {
      return true;
    }
    repeatedAtDepth[depth] = canBeEmpty ? [...repeatedAtDepth[depth], atom] : [atom];
    index = quantifierEnd;
  }

  return false;
}

export type PathTokenSafetyOptions = {
  /**
   * Whether the compiled RegExp uses the `i` flag. The per-pattern checks
   * stay case-insensitive, which only makes them more conservative.
   */
  ignoreCase: boolean;
};

function unsafeTokenReason(
  token: PathKey,
  namedGroups: boolean,
  captures: CaptureContext,
): string | null {
  const regexSafetyIssue = analyzeRegexSafety(token.pattern, {
    ignoreCase: true,
    namedGroups,
    captures,
  });
  if (regexSafetyIssue) {
    if (regexSafetyIssue === "analysis budget exceeded") {
      return `parameter "${token.name}" exceeds the regex analysis budget`;
    }
    return `parameter "${token.name}" contains ${regexSafetyIssue}`;
  }
  if (hasOverlappingSequentialRepetition(token.pattern)) {
    return `parameter "${token.name}" contains overlapping sequential repetition`;
  }
  return null;
}

/**
 * Reject path-to-regexp tokens whose custom patterns can backtrack
 * catastrophically once compiled. Each param's pattern is checked, then the
 * compiled RegExp as a whole: a `+`/`*` param repeats its pattern joined by
 * its prefix and suffix, which can be ambiguous, as in `/:id(a|aa?)+`, and
 * adjacent params such as `/:a(a+):b(a+):c(a+)` can form an overlapping chain.
 */
export function unsafePathTokensReason(
  tokens: PathToken[],
  options: PathTokenSafetyOptions,
): string | null {
  // Every token pattern is compiled into one RegExp, so a named group in any
  // of them turns `\k<name>` in another into a backreference.
  const namedGroups = tokens.some(
    (token) => typeof token !== "string" && mayHaveNamedGroups(token.pattern),
  );
  // pathTokensToRegExpSource wraps each param's pattern in a capture, after
  // the captures of the params before it, and writes a repeated param's
  // pattern twice.
  const captureCounts = tokens.map((token) => {
    if (typeof token === "string" || !token.pattern) return 0;
    const repeated = token.modifier === "+" || token.modifier === "*";
    return 1 + countCapturingGroups(token.pattern) * (repeated ? 2 : 1);
  });
  const total = captureCounts.reduce((sum, count) => sum + count, 0);
  let before = 0;
  for (const [index, token] of tokens.entries()) {
    if (typeof token !== "string") {
      const reason = unsafeTokenReason(token, namedGroups, { before: before + 1, total });
      if (reason) return reason;
    }
    before += captureCounts[index]!;
  }
  // Tokens that do not compile yet are checked again by the caller once
  // normalized, or rejected as invalid.
  let source: string;
  try {
    source = pathTokensToRegExpSource(tokens);
  } catch {
    return null;
  }
  const sequenceIssue =
    analyzeRegexAmbiguity(source, { ignoreCase: options.ignoreCase, namedGroups }) ??
    analyzeRegexRepetitionChains(source, { ignoreCase: options.ignoreCase, namedGroups });
  if (sequenceIssue === "analysis budget exceeded")
    return "source exceeds the regex analysis budget";
  if (sequenceIssue) return `source contains ${sequenceIssue}`;
  return null;
}
