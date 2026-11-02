/**
 * Compiles and matches next.config.js redirect, rewrite and header sources.
 *
 * Kept apart from config-matchers so the Pages router can match sources
 * synchronously with the same code as the server, without bundling the rest
 * of config-matchers.
 */

import {
  normalizePathTokens,
  parsePathPattern,
  pathTokensToRegExpSource,
  type PathKey,
  type PathToken,
} from "../utils/path-to-regexp.js";

/**
 * Cache for compiled redirect/rewrite/header sources.
 *
 * Sources come from next.config.js and never change at runtime. Without
 * caching, every request re-parses and recompiles every rule. On apps with
 * many locale-prefixed rules this dominated profiling at ~2.4 seconds of CPU
 * self-time.
 *
 * Value is `null` when the source is invalid, so we skip it on subsequent
 * requests too without re-parsing it.
 */
const _compiledSourceCache = new Map<string, CompiledConfigSource | null>();

export type CompiledConfigSource = {
  re: RegExp;
  /** Keys in capture-group order; unnamed groups have numeric names. */
  keys: PathKey[];
};

/**
 * Compile a redirect/rewrite/header source the way Next.js does at runtime:
 * path-to-regexp 6 with `strict: true`, `delimiter: "/"` and case-insensitive
 * matching, then `modifyRouteRegex` appends an optional trailing slash.
 *
 * Returns an error for sources path-to-regexp rejects. Like Next.js, custom
 * param patterns are not checked for catastrophic backtracking.
 *
 * https://github.com/vercel/next.js/blob/v16.2.7/packages/next/src/server/lib/router-utils/filesystem.ts
 * https://github.com/vercel/next.js/blob/v16.2.7/packages/next/src/shared/lib/router/utils/path-match.ts
 */
function compileConfigSourceUncached(
  source: string,
): CompiledConfigSource | { kind: "invalid"; error: string } {
  const parsed = parseConfigSource(source);
  if ("kind" in parsed) return parsed;
  const { tokens, re } = parsed;
  // tokensToRegexp only captures tokens with a pattern.
  const keys = tokens.filter(
    (token): token is PathKey => typeof token !== "string" && !!token.pattern,
  );
  return { re, keys };
}

function parseConfigSource(
  source: string,
): { tokens: PathToken[]; re: RegExp } | { kind: "invalid"; error: string } {
  try {
    const tokens = parsePathPattern(source, { delimiter: "/" });
    return { tokens, re: new RegExp(`${pathTokensToRegExpSource(tokens)}(?:\\/)?$`, "i") };
  } catch (error) {
    return { kind: "invalid", error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Length of the RegExp Next.js builds when validating a source
 * (tryToParsePath: path-to-regexp defaults, retried with normalized repeat
 * tokens), or null when it cannot be built.
 */
function validationRegExpLength(source: string): number | null {
  try {
    const tokens = parsePathPattern(source);
    const build = (value: PathToken[]) =>
      new RegExp(`${pathTokensToRegExpSource(value)}[\\/#\\?]?$`).source.length;
    try {
      return build(tokens);
    } catch {
      return build(normalizePathTokens(tokens));
    }
  } catch {
    return null;
  }
}

/**
 * Why `source` is not a valid redirects/rewrites/headers source, or null.
 * Mirrors the source checks in Next.js's checkCustomRoutes, which fail the
 * build; config loading calls this to do the same.
 *
 * https://github.com/vercel/next.js/blob/v16.2.7/packages/next/src/lib/load-custom-routes.ts
 */
export function configSourceError(source: unknown): string | null {
  if (!source) return "`source` is missing";
  if (typeof source !== "string") return "`source` is not a string";
  if (!source.startsWith("/")) return "`source` does not start with /";
  const parsed = parseConfigSource(source);
  if ("kind" in parsed) return parsed.error;
  const length = validationRegExpLength(source);
  if (length !== null && length > 4096) return "`source` exceeds max built length of 4096";
  return null;
}

export function compileConfigSource(source: string): CompiledConfigSource | null {
  let compiled = _compiledSourceCache.get(source);
  if (compiled !== undefined) return compiled;
  const result = compileConfigSourceUncached(source);
  if ("kind" in result) {
    console.warn(`[vinext] Ignoring invalid next.config.js source "${source}": ${result.error}`);
    compiled = null;
  } else {
    compiled = result;
  }
  _compiledSourceCache.set(source, compiled);
  return compiled;
}

/**
 * Match a Next.js config source (from redirects/rewrites/headers) against a
 * pathname. Returns the named params or null.
 *
 * Unnamed groups are dropped, as Next.js does with `removeUnnamedParams`.
 * Repeated params (`:path*`, `:path+`) keep the captured string (`a/b`), and
 * an optional param that did not match is `""`.
 */
export function matchConfigPattern(
  pathname: string,
  pattern: string,
): Record<string, string> | null {
  return execConfigSource(pathname, pattern)?.params ?? null;
}

/**
 * matchConfigPattern, also reporting the optional params that did not match.
 * Next.js leaves those out of its params entirely.
 */
export function execConfigSource(
  pathname: string,
  source: string,
): { params: Record<string, string>; unmatched: string[] } | null {
  const compiled = compileConfigSource(source);
  if (!compiled) return null;
  const match = compiled.re.exec(pathname);
  if (!match) return null;
  const params: Record<string, string> = Object.create(null);
  const matched = new Set<string>();
  for (let i = 0; i < compiled.keys.length; i++) {
    const key = compiled.keys[i].name;
    if (typeof key !== "string") continue;
    const value = match[i + 1];
    // Like Next.js, an unmatched capture never overwrites a duplicate name
    // that did match (`/:id?/:id?` on `/x` gives `{ id: "x" }`).
    if (value === undefined) {
      if (!matched.has(key)) params[key] = "";
      continue;
    }
    matched.add(key);
    // NOTE: Do NOT decodeURIComponent here. The pathname is already decoded at
    // the request entry point. Decoding again would produce incorrect param values.
    params[key] = value;
  }
  const unmatched = Object.keys(params).filter((key) => !matched.has(key));
  return { params, unmatched };
}
