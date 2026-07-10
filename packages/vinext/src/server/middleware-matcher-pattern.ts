import { isSafeRegex } from "../config/config-matchers.js";
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

function patternMatches(pattern: string, value: string): boolean {
  try {
    return new RegExp(`^(?:${pattern})$`).test(value);
  } catch {
    return false;
  }
}

function unsafeTokenReason(token: MiddlewarePathKey): string | null {
  if (!isSafeRegex(token.pattern)) {
    return `parameter "${token.name}" contains nested repetition`;
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
      else if (matcher && typeof matcher === "object" && "source" in matcher) {
        const source = Reflect.get(matcher, "source");
        if (typeof source === "string") sources.push(source);
      }
    }
  }

  for (const source of sources) {
    const result = compileMiddlewareMatcherPattern(source);
    if (result.regexp) continue;
    throw new Error(`Invalid middleware matcher "${source}": ${result.error}.`);
  }
}
