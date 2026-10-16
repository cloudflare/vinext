import type { HasCondition } from "../config/next-config.js";
import {
  normalizePathTokens,
  parsePathPattern,
  pathTokensToRegExpSource,
  type PathToken,
} from "../utils/path-to-regexp.js";
import { unsafePathTokensReason } from "../utils/path-token-safety.js";

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

function middlewareRegExp(tokens: PathToken[]): RegExp {
  // path-to-regexp's non-strict ending for the `/#?` delimiter. Next.js keeps
  // only the `.source` and recompiles it without flags, so matchers are
  // case-sensitive. A case-insensitive negative lookahead would skip
  // middleware for case variants like `/API/x`.
  // https://github.com/vercel/next.js/blob/v16.2.7/packages/next/src/shared/lib/router/utils/middleware-route-matcher.ts
  return new RegExp(`${pathTokensToRegExpSource(tokens)}[\\/#\\?]?$`);
}

export function compileMiddlewareMatcherPattern(source: string): CompiledMiddlewareMatcherPattern {
  if (!source.startsWith("/")) {
    return { kind: "invalid", error: "source must start with /" };
  }
  if (source.length > 4096) {
    return { kind: "invalid", error: "source exceeds max built length of 4096" };
  }

  let tokens: PathToken[];
  try {
    tokens = parsePathPattern(source);
  } catch (error) {
    return {
      kind: "invalid",
      error: error instanceof Error ? error.message : "matcher could not be parsed",
    };
  }

  const unsafeReason = unsafePathTokensReason(tokens, { ignoreCase: false });
  if (unsafeReason) return { kind: "unsafe", error: unsafeReason };

  try {
    return { regexp: middlewareRegExp(tokens) };
  } catch {
    // Match Next.js 16.2.7's path-to-regexp 6.3 normalization: repeating
    // tokens without a prefix/suffix receive a slash prefix and are retried.
    const normalizedTokens = normalizePathTokens(tokens);
    const normalizedUnsafeReason = unsafePathTokensReason(normalizedTokens, { ignoreCase: false });
    if (normalizedUnsafeReason) return { kind: "unsafe", error: normalizedUnsafeReason };
    try {
      return { regexp: middlewareRegExp(normalizedTokens) };
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
