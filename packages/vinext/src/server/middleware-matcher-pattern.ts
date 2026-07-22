import type { HasCondition } from "../config/next-config.js";
import { analyzeRegexSafety, regexAtomsMayOverlap } from "../utils/regex-safety.js";
import {
  middlewarePathTokensToRegExp,
  normalizeMiddlewarePathTokens,
  parseMiddlewarePath,
  type MiddlewarePathKey,
  type MiddlewarePathToken,
} from "./middleware-path-to-regexp.js";

export type CompiledMiddlewareMatcherPattern =
  | { regexp: RegExp; error?: never }
  | { regexp?: never; error: string; kind: "invalid" | "unsafe" };

export type MiddlewareMatcherObject = {
  source: string;
  locale?: false;
  has?: HasCondition[];
  missing?: HasCondition[];
};

const MATCHER_OBJECT_KEYS = new Set(["source", "locale", "has", "missing"]);
const CONDITION_TYPES_WITH_KEY = new Set(["header", "query", "cookie"]);

function invalidConditionReason(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "has and missing entries must be objects";
  }

  const condition = value as Record<string, unknown>;
  const type = condition.type;
  if (typeof type === "string" && CONDITION_TYPES_WITH_KEY.has(type)) {
    for (const key of Object.keys(condition)) {
      if (key !== "type" && key !== "key" && key !== "value") {
        return `condition contains unsupported field "${key}"`;
      }
    }
    if (typeof condition.key !== "string") {
      return `condition type "${type}" requires a string key`;
    }
    if (condition.value !== undefined && typeof condition.value !== "string") {
      return `condition type "${type}" requires value to be a string`;
    }
    return null;
  }

  if (type === "host") {
    for (const key of Object.keys(condition)) {
      if (key !== "type" && key !== "value") {
        return `host condition contains unsupported field "${key}"`;
      }
    }
    return typeof condition.value === "string" ? null : "host condition requires a string value";
  }

  return "condition type must be header, query, cookie, or host";
}

function invalidConditionsReason(value: unknown, field: "has" | "missing"): string | null {
  if (value === undefined) return null;
  if (!Array.isArray(value)) return `${field} must be an array`;
  for (const condition of value) {
    const reason = invalidConditionReason(condition);
    if (reason) return `${field} ${reason}`;
  }
  return null;
}

function matcherObjectSource(value: unknown): { source?: string; error?: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { error: "matcher entries must be strings or objects" };
  }

  const matcher = value as Record<string, unknown>;
  for (const key of Object.keys(matcher)) {
    if (!MATCHER_OBJECT_KEYS.has(key)) {
      return { error: `matcher object contains unsupported field "${key}"` };
    }
  }
  if (typeof matcher.source !== "string") {
    return { error: "matcher object requires a string source" };
  }
  if (matcher.locale !== undefined && matcher.locale !== false) {
    return { error: "matcher object locale must be false when provided" };
  }
  const invalidHas = invalidConditionsReason(matcher.has, "has");
  if (invalidHas) return { error: invalidHas };
  const invalidMissing = invalidConditionsReason(matcher.missing, "missing");
  if (invalidMissing) return { error: invalidMissing };
  return { source: matcher.source };
}

export function isValidMiddlewareMatcherObjectConfig(
  value: unknown,
): value is MiddlewareMatcherObject {
  return matcherObjectSource(value).error === undefined;
}

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

function unsafeTokenReason(token: MiddlewarePathKey): string | null {
  const regexSafetyIssue = analyzeRegexSafety(token.pattern, { ignoreCase: true });
  if (regexSafetyIssue) {
    if (regexSafetyIssue === "analysis budget exceeded") {
      return `parameter "${token.name}" exceeds the regex analysis budget`;
    }
    return `parameter "${token.name}" contains ${regexSafetyIssue}`;
  }
  if (hasOverlappingSequentialRepetition(token.pattern)) {
    return `parameter "${token.name}" contains overlapping sequential repetition`;
  }

  if (token.modifier !== "*" && token.modifier !== "+") return null;

  // Repeating parameters are joined by the token prefix/suffix. If their own
  // constraint can also consume a slash (or the empty string), the same input
  // has many equivalent partitions. Patterns such as `/:path(.*)*/end` then
  // backtrack exponentially on a near miss. Ordinary repeats use a constraint
  // that cannot cross the path delimiter, so each segment has one owner.
  if (patternMatches(token.pattern, "") || patternMatches(token.pattern, "/")) {
    return `repeated parameter "${token.name}" may match an empty value or path delimiter`;
  }

  return null;
}

function validateTokens(tokens: MiddlewarePathToken[]): string | null {
  for (const token of tokens) {
    if (typeof token === "string") continue;
    const reason = unsafeTokenReason(token);
    if (reason) return reason;
  }
  return null;
}

export function compileMiddlewareMatcherPattern(source: string): CompiledMiddlewareMatcherPattern {
  if (!source.startsWith("/")) {
    return { kind: "invalid", error: "source must start with /" };
  }
  if (source.length > 4096) {
    return { kind: "invalid", error: "source exceeds max built length of 4096" };
  }

  let tokens: MiddlewarePathToken[];
  try {
    tokens = parseMiddlewarePath(source);
  } catch (error) {
    return {
      kind: "invalid",
      error: error instanceof Error ? error.message : "matcher could not be parsed",
    };
  }

  const unsafeReason = validateTokens(tokens);
  if (unsafeReason) return { kind: "unsafe", error: unsafeReason };

  try {
    return { regexp: middlewarePathTokensToRegExp(tokens) };
  } catch {
    // Match Next.js 16.2.7's path-to-regexp 6.3 normalization: repeating
    // tokens without a prefix/suffix receive a slash prefix and are retried.
    const normalizedTokens = normalizeMiddlewarePathTokens(tokens);
    const normalizedUnsafeReason = validateTokens(normalizedTokens);
    if (normalizedUnsafeReason) return { kind: "unsafe", error: normalizedUnsafeReason };
    try {
      return { regexp: middlewarePathTokensToRegExp(normalizedTokens) };
    } catch (error) {
      return {
        kind: "invalid",
        error: error instanceof Error ? error.message : "matcher could not be compiled",
      };
    }
  }
}

export function validateMiddlewareMatcherPatterns(value: unknown): void {
  const sources: string[] = [];
  if (typeof value === "string") {
    sources.push(value);
  } else if (Array.isArray(value)) {
    for (const matcher of value) {
      if (typeof matcher === "string") sources.push(matcher);
      else {
        const result = matcherObjectSource(matcher);
        if (result.error) throw new Error(`Invalid middleware matcher config: ${result.error}.`);
        sources.push(result.source!);
      }
    }
  } else {
    throw new Error(
      "Invalid middleware matcher config: matcher must be a string or an array of strings or objects.",
    );
  }

  for (const source of sources) {
    const result = compileMiddlewareMatcherPattern(source);
    if (result.regexp) continue;
    throw new Error(`Invalid middleware matcher "${source}": ${result.error}.`);
  }
}
