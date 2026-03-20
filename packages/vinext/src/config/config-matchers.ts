/**
 * Config pattern matching and rule application utilities.
 *
 * Shared between the dev server (index.ts) and the production server
 * (prod-server.ts) so both apply next.config.js rules identically.
 */

import type { NextRedirect, NextRewrite, NextHeader, HasCondition } from "./next-config.js";
import { buildRequestHeadersFromMiddlewareResponse } from "../server/middleware-request-headers.js";

/**
 * Cache for compiled regex patterns in matchConfigPattern.
 *
 * Redirect/rewrite patterns are static — they come from next.config.js and
 * never change at runtime. Without caching, every request that hits the regex
 * branch re-runs the full tokeniser walk + isSafeRegex + new RegExp() for
 * every rule in the array. On apps with many locale-prefixed rules (which all
 * contain `(` and therefore enter the regex branch) this dominated profiling
 * at ~2.4 seconds of CPU self-time.
 *
 * Value is `null` when safeRegExp rejected the pattern (ReDoS risk), so we
 * skip it on subsequent requests too without re-running the scanner.
 */
const _compiledPatternCache = new Map<string, { re: RegExp; paramNames: string[] } | null>();

/**
 * Cache for compiled header source regexes in matchHeaders.
 *
 * Each NextHeader rule has a `source` that is run through escapeHeaderSource()
 * then safeRegExp() to produce a RegExp. Both are pure functions of the source
 * string and the result never changes. Without caching, every request
 * re-runs the full escapeHeaderSource tokeniser + isSafeRegex scan + new RegExp()
 * for every header rule.
 *
 * Value is `null` when safeRegExp rejected the pattern (ReDoS risk).
 */
const _compiledHeaderSourceCache = new Map<string, RegExp | null>();

/**
 * Cache for compiled has/missing condition value regexes in checkSingleCondition.
 *
 * Each has/missing condition may carry a `value` string that is passed directly
 * to safeRegExp() for matching against header/cookie/query/host values. The
 * condition objects are static (from next.config.js) so the compiled RegExp
 * never changes. Without caching, safeRegExp() is called on every request for
 * every condition on every rule.
 *
 * Value is `null` when safeRegExp rejected the pattern, or `false` when the
 * value string was undefined (no regex needed — use exact string comparison).
 */
const _compiledConditionCache = new Map<string, RegExp | null>();

/**
 * Cache for destination substitution regexes in substituteDestinationParams.
 *
 * The regex depends only on the set of param keys captured from the matched
 * source pattern. Caching by sorted key list avoids recompiling a new RegExp
 * for repeated redirect/rewrite calls that use the same param shape.
 */
const _compiledDestinationParamCache = new Map<string, RegExp>();

/**
 * Redirect index for O(1) locale-static rule lookup.
 *
 * Many Next.js apps generate 50-100 redirect rules of the form:
 *   /:locale(en|es|fr|...)?/some-static-path  →  /some-destination
 *
 * The compiled regex for each is like:
 *   ^/(en|es|fr|...)?/some-static-path$
 *
 * When no redirect matches (the common case for ordinary page loads),
 * matchRedirect previously ran exec() on every one of those regexes —
 * ~2ms per call, ~2992ms total self-time in profiles.
 *
 * The index splits rules into two buckets:
 *
 *   localeStatic — rules whose source is exactly /:paramName(alt1|alt2|...)?/suffix
 *     where `suffix` is a static path with no further params or regex groups.
 *     These are indexed in a Map<suffix, entry[]> for O(1) lookup after a
 *     single fast strip of the optional locale prefix.
 *
 *   linear — all other rules. Matched with the original O(n) loop.
 *
 * The index is stored in a WeakMap keyed by the redirects array so it is
 * computed once per config load and GC'd when the array is no longer live.
 *
 * ## Ordering invariant
 *
 * Redirect rules must be evaluated in their original order (first match wins).
 * Each locale-static entry stores its `originalIndex` so that, when a
 * locale-static fast-path match is found, any linear rules that appear earlier
 * in the array are still checked first.
 */

/** Matches `/:param(alternation)?/static/suffix` — the locale-static pattern. */
const _LOCALE_STATIC_RE = /^\/:[\w-]+\(([^)]+)\)\?\/([a-zA-Z0-9_~.%@!$&'*+,;=:/-]+)$/;

type LocaleStaticEntry = {
  /** The param name extracted from the source (e.g. "locale"). */
  paramName: string;
  /** The compiled regex matching just the alternation, used at match time. */
  altRe: RegExp;
  /** The original redirect rule. */
  redirect: NextRedirect;
  /** Position of this rule in the original redirects array. */
  originalIndex: number;
};

type RedirectIndex = {
  /** Fast-path map: strippedPath (e.g. "/security") → matching entries. */
  localeStatic: Map<string, LocaleStaticEntry[]>;
  /**
   * Linear fallback for rules that couldn't be indexed.
   * Each entry is [originalIndex, redirect].
   */
  linear: Array<[number, NextRedirect]>;
};

const _redirectIndexCache = new WeakMap<NextRedirect[], RedirectIndex>();

/**
 * Build (or retrieve from cache) the redirect index for a given redirects array.
 *
 * Called once per config load from matchRedirect. The WeakMap ensures the index
 * is recomputed if the config is reloaded (new array reference) and GC'd when
 * the array is collected.
 */
function _getRedirectIndex(redirects: NextRedirect[]): RedirectIndex {
  let index = _redirectIndexCache.get(redirects);
  if (index !== undefined) return index;

  const localeStatic = new Map<string, LocaleStaticEntry[]>();
  const linear: Array<[number, NextRedirect]> = [];

  for (let i = 0; i < redirects.length; i++) {
    const redirect = redirects[i];
    const m = _LOCALE_STATIC_RE.exec(redirect.source);
    if (m) {
      const paramName = redirect.source.slice(2, redirect.source.indexOf("("));
      const alternation = m[1];
      const suffix = "/" + m[2]; // e.g. "/security"
      // Build a small regex to validate the captured locale value against the
      // alternation. Using anchored match to avoid partial matches.
      // The alternation comes from user config; run it through safeRegExp to
      // guard against ReDoS in pathological configs.
      const altRe = safeRegExp("^(?:" + alternation + ")$");
      if (!altRe) {
        // Unsafe alternation — fall back to linear scan for this rule.
        linear.push([i, redirect]);
        continue;
      }
      const entry: LocaleStaticEntry = { paramName, altRe, redirect, originalIndex: i };
      const bucket = localeStatic.get(suffix);
      if (bucket) {
        bucket.push(entry);
      } else {
        localeStatic.set(suffix, [entry]);
      }
    } else {
      linear.push([i, redirect]);
    }
  }

  index = { localeStatic, linear };
  _redirectIndexCache.set(redirects, index);
  return index;
}

/** Hop-by-hop headers that should not be forwarded through a proxy. */
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
]);

/**
 * Request hop-by-hop headers to strip before proxying with fetch().
 * Intentionally narrower than HOP_BY_HOP_HEADERS: external rewrite proxying
 * still forwards proxy auth credentials, while response sanitization strips
 * them before returning data to the client.
 */
const REQUEST_HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
]);

function stripHopByHopRequestHeaders(headers: Headers): void {
  const connectionTokens = (headers.get("connection") || "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);

  for (const header of REQUEST_HOP_BY_HOP_HEADERS) {
    headers.delete(header);
  }

  for (const token of connectionTokens) {
    headers.delete(token);
  }
}

/**
 * Detect regex patterns vulnerable to catastrophic backtracking (ReDoS).
 *
 * Uses a lightweight heuristic: scans the pattern string for nested quantifiers
 * (a quantifier applied to a group that itself contains a quantifier). This
 * catches the most common pathological patterns like `(a+)+`, `(.*)*`,
 * `([^/]+)+`, `(a|a+)+` without needing a full regex parser.
 *
 * Returns true if the pattern appears safe, false if it's potentially dangerous.
 */
export function isSafeRegex(pattern: string): boolean {
  // Track parenthesis nesting depth and whether we've seen a quantifier
  // at each depth level.
  const quantifierAtDepth: boolean[] = [];
  let depth = 0;
  let i = 0;

  while (i < pattern.length) {
    const ch = pattern[i];

    // Skip escaped characters
    if (ch === "\\") {
      i += 2;
      continue;
    }

    // Skip character classes [...] — quantifiers inside them are literal
    if (ch === "[") {
      i++;
      while (i < pattern.length && pattern[i] !== "]") {
        if (pattern[i] === "\\") i++; // skip escaped char in class
        i++;
      }
      i++; // skip closing ]
      continue;
    }

    if (ch === "(") {
      depth++;
      // Initialize: no quantifier seen yet at this new depth
      if (quantifierAtDepth.length <= depth) {
        quantifierAtDepth.push(false);
      } else {
        quantifierAtDepth[depth] = false;
      }
      i++;
      continue;
    }

    if (ch === ")") {
      const hadQuantifier = depth > 0 && quantifierAtDepth[depth];
      if (depth > 0) depth--;

      // Look ahead for a quantifier on this group: +, *, {n,m}
      // Note: '?' after ')' means "zero or one" which does NOT cause catastrophic
      // backtracking — it only allows 2 paths (match/skip), not exponential.
      // Only unbounded repetition (+, *, {n,}) on a group with inner quantifiers is dangerous.
      const next = pattern[i + 1];
      if (next === "+" || next === "*" || next === "{") {
        if (hadQuantifier) {
          // Nested quantifier detected: quantifier on a group that contains a quantifier
          return false;
        }
        // Mark the enclosing depth as having a quantifier
        if (depth >= 0 && depth < quantifierAtDepth.length) {
          quantifierAtDepth[depth] = true;
        }
      }
      i++;
      continue;
    }

    // Detect quantifiers: +, *, ?, {n,m}
    // '?' is a quantifier (optional) unless it follows another quantifier (+, *, ?, })
    // in which case it's a non-greedy modifier.
    if (ch === "+" || ch === "*") {
      if (depth > 0) {
        quantifierAtDepth[depth] = true;
      }
      i++;
      continue;
    }

    if (ch === "?") {
      // '?' after +, *, ?, or } is a non-greedy modifier, not a quantifier
      const prev = i > 0 ? pattern[i - 1] : "";
      if (prev !== "+" && prev !== "*" && prev !== "?" && prev !== "}") {
        if (depth > 0) {
          quantifierAtDepth[depth] = true;
        }
      }
      i++;
      continue;
    }

    if (ch === "{") {
      // Check if this is a quantifier {n}, {n,}, {n,m}
      let j = i + 1;
      while (j < pattern.length && /[\d,]/.test(pattern[j])) j++;
      if (j < pattern.length && pattern[j] === "}" && j > i + 1) {
        if (depth > 0) {
          quantifierAtDepth[depth] = true;
        }
        i = j + 1;
        continue;
      }
    }

    i++;
  }

  return true;
}

/**
 * Compile a regex pattern safely. Returns the compiled RegExp or null if the
 * pattern is invalid or vulnerable to ReDoS.
 *
 * Logs a warning when a pattern is rejected so developers can fix their config.
 */
export function safeRegExp(pattern: string, flags?: string): RegExp | null {
  if (!isSafeRegex(pattern)) {
    console.warn(
      `[vinext] Ignoring potentially unsafe regex pattern (ReDoS risk): ${pattern}\n` +
        `  Patterns with nested quantifiers (e.g. (a+)+) can cause catastrophic backtracking.\n` +
        `  Simplify the pattern to avoid nested repetition.`,
    );
    return null;
  }
  try {
    return new RegExp(pattern, flags);
  } catch {
    return null;
  }
}

/**
 * Convert a Next.js header/rewrite/redirect source pattern into a regex string.
 *
 * Regex groups in the source (e.g. `(\d+)`) are extracted first, the remaining
 * text is escaped/converted in a **single pass** (avoiding chained `.replace()`
 * which CodeQL flags as incomplete sanitization), then groups are restored.
 */
export function escapeHeaderSource(source: string): string {
  // Sentinel character for group placeholders. Uses a Unicode private-use-area
  // codepoint that will never appear in real source patterns.
  const S = "\uE000";

  // Step 1: extract regex groups and replace with numbered placeholders.
  const groups: string[] = [];
  const withPlaceholders = source.replace(/\(([^)]+)\)/g, (_m, inner) => {
    groups.push(inner);
    return `${S}G${groups.length - 1}${S}`;
  });

  // Step 2: single-pass conversion of the placeholder-bearing string.
  // Match named params (:[\w-]+), sentinel group placeholders, metacharacters, and literal text.
  // The regex uses non-overlapping alternatives to avoid backtracking:
  //   :[\w-]+  — named parameter (constraint sentinel is checked procedurally;
  //              param names may contain hyphens, e.g. :auth-method)
  //   sentinel group — standalone regex group placeholder
  //   [.+?*] — single metachar to escape/convert
  //   [^.+?*:\uE000]+ — literal text (excludes all chars that start other alternatives)
  let result = "";
  const re = new RegExp(
    `${S}G(\\d+)${S}|:[\\w-]+|[.+?*]|[^.+?*:\\uE000]+`, // lgtm[js/redos] — alternatives are non-overlapping
    "g",
  );
  let m: RegExpExecArray | null;
  while ((m = re.exec(withPlaceholders)) !== null) {
    if (m[1] !== undefined) {
      // Standalone regex group — restore as-is
      result += `(${groups[Number(m[1])]})`;
    } else if (m[0].startsWith(":")) {
      // Named parameter — check if followed by a constraint group placeholder
      const afterParam = withPlaceholders.slice(re.lastIndex);
      const constraintMatch = afterParam.match(new RegExp(`^${S}G(\\d+)${S}`));
      if (constraintMatch) {
        // :param(constraint) — use the constraint as the capture group
        re.lastIndex += constraintMatch[0].length;
        result += `(${groups[Number(constraintMatch[1])]})`;
      } else {
        // Plain named parameter → match one segment
        result += "[^/]+";
      }
    } else {
      switch (m[0]) {
        case ".":
          result += "\\.";
          break;
        case "+":
          result += "\\+";
          break;
        case "?":
          result += "\\?";
          break;
        case "*":
          result += ".*";
          break;
        default:
          result += m[0];
          break;
      }
    }
  }

  return result;
}

/**
 * Request context needed for evaluating has/missing conditions.
 * Callers extract the relevant parts from the incoming Request.
 */
export interface RequestContext {
  headers: Headers;
  cookies: Record<string, string>;
  query: URLSearchParams;
  host: string;
}

/**
 * Parse a Cookie header string into a key-value record.
 */
export function parseCookies(cookieHeader: string | null): Record<string, string> {
  if (!cookieHeader) return {};
  const cookies: Record<string, string> = {};
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key) cookies[key] = value;
  }
  return cookies;
}

/**
 * Build a RequestContext from a Web Request object.
 */
export function requestContextFromRequest(request: Request): RequestContext {
  const url = new URL(request.url);
  return {
    headers: request.headers,
    cookies: parseCookies(request.headers.get("cookie")),
    query: url.searchParams,
    host: normalizeHost(request.headers.get("host"), url.hostname),
  };
}

export function normalizeHost(hostHeader: string | null, fallbackHostname: string): string {
  const host = hostHeader ?? fallbackHostname;
  return host.split(":", 1)[0].toLowerCase();
}

/**
 * Unpack `x-middleware-request-*` headers from the collected middleware
 * response headers into the actual request, and strip all `x-middleware-*`
 * internal signals so they never reach clients.
 *
 * `middlewareHeaders` is mutated in-place (matching keys are deleted).
 * Returns a (possibly cloned) `Request` with the unpacked headers applied,
 * and a fresh `RequestContext` built from it — ready for post-middleware
 * config rule matching (beforeFiles, afterFiles, fallback).
 *
 * Works for both Node.js requests (mutable headers) and Workers requests
 * (immutable — cloned only when there are headers to apply).
 *
 * `x-middleware-request-*` values are always plain strings (they carry
 * individual header values), so the wider `string | string[]` type of
 * `middlewareHeaders` is safe to cast here.
 */
export function applyMiddlewareRequestHeaders(
  middlewareHeaders: Record<string, string | string[]>,
  request: Request,
): { request: Request; postMwReqCtx: RequestContext } {
  const nextHeaders = buildRequestHeadersFromMiddlewareResponse(request.headers, middlewareHeaders);

  for (const key of Object.keys(middlewareHeaders)) {
    if (key.startsWith("x-middleware-")) {
      delete middlewareHeaders[key];
    }
  }

  if (nextHeaders) {
    // Headers may be immutable (Workers), so always clone via new Headers().
    request = new Request(request.url, {
      method: request.method,
      headers: nextHeaders,
      body: request.body,
      // @ts-expect-error — duplex needed for streaming request bodies
      duplex: request.body ? "half" : undefined,
    });
  }

  return { request, postMwReqCtx: requestContextFromRequest(request) };
}

function _emptyParams(): Record<string, string> {
  return Object.create(null) as Record<string, string>;
}

function _matchConditionValue(
  actualValue: string,
  expectedValue: string | undefined,
): Record<string, string> | null {
  if (expectedValue === undefined) return _emptyParams();

  const re = _cachedConditionRegex(expectedValue);
  if (re) {
    const match = re.exec(actualValue);
    if (!match) return null;

    const params = _emptyParams();
    if (match.groups) {
      for (const [key, value] of Object.entries(match.groups)) {
        if (value !== undefined) params[key] = value;
      }
    }
    return params;
  }

  return actualValue === expectedValue ? _emptyParams() : null;
}

/**
 * Check a single has/missing condition against request context.
 * Returns captured params when the condition is satisfied, or null otherwise.
 */
function matchSingleCondition(
  condition: HasCondition,
  ctx: RequestContext,
): Record<string, string> | null {
  switch (condition.type) {
    case "header": {
      const headerValue = ctx.headers.get(condition.key);
      if (headerValue === null) return null;
      return _matchConditionValue(headerValue, condition.value);
    }
    case "cookie": {
      const cookieValue = ctx.cookies[condition.key];
      if (cookieValue === undefined) return null;
      return _matchConditionValue(cookieValue, condition.value);
    }
    case "query": {
      const queryValue = ctx.query.get(condition.key);
      if (queryValue === null) return null;
      return _matchConditionValue(queryValue, condition.value);
    }
    case "host": {
      if (condition.value !== undefined) return _matchConditionValue(ctx.host, condition.value);
      return ctx.host === condition.key ? _emptyParams() : null;
    }
    default:
      return null;
  }
}

/**
 * Return a cached RegExp for a has/missing condition value string, compiling
 * on first use. Returns null if safeRegExp rejected the pattern or if the
 * value is not a valid regex (fall back to exact string comparison).
 */
function _cachedConditionRegex(value: string): RegExp | null {
  let re = _compiledConditionCache.get(value);
  if (re === undefined) {
    re = safeRegExp(value);
    _compiledConditionCache.set(value, re);
  }
  return re;
}

/**
 * Check all has/missing conditions for a config rule.
 * Returns true if the rule should be applied (all has conditions pass, all missing conditions pass).
 *
 * - has: every condition must match (the request must have it)
 * - missing: every condition must NOT match (the request must not have it)
 */
function collectConditionParams(
  has: HasCondition[] | undefined,
  missing: HasCondition[] | undefined,
  ctx: RequestContext,
): Record<string, string> | null {
  const params = _emptyParams();

  if (has) {
    for (const condition of has) {
      const conditionParams = matchSingleCondition(condition, ctx);
      if (!conditionParams) return null;
      Object.assign(params, conditionParams);
    }
  }

  if (missing) {
    for (const condition of missing) {
      if (matchSingleCondition(condition, ctx)) return null;
    }
  }

  return params;
}

export function checkHasConditions(
  has: HasCondition[] | undefined,
  missing: HasCondition[] | undefined,
  ctx: RequestContext,
): boolean {
  return collectConditionParams(has, missing, ctx) !== null;
}

/**
 * If the current position in `str` starts with a parenthesized group, consume
 * it and advance `re.lastIndex` past the closing `)`. Returns the group
 * contents or null if no group is present.
 */
function extractConstraint(str: string, re: RegExp): string | null {
  if (str[re.lastIndex] !== "(") return null;
  const start = re.lastIndex + 1;
  let depth = 1;
  let i = start;
  while (i < str.length && depth > 0) {
    if (str[i] === "(") depth++;
    else if (str[i] === ")") depth--;
    i++;
  }
  if (depth !== 0) return null;
  re.lastIndex = i;
  return str.slice(start, i - 1);
}

/**
 * Match a Next.js config pattern (from redirects/rewrites sources) against a pathname.
 * Returns matched params or null.
 *
 * Supports:
 *   :param     - matches a single path segment
 *   :param*    - matches zero or more segments (catch-all)
 *   :param+    - matches one or more segments
 *   (regex)    - inline regex patterns in the source
 *   :param(constraint) - named param with inline regex constraint
 */
export function matchConfigPattern(
  pathname: string,
  pattern: string,
): Record<string, string> | null {
  // If the pattern contains regex groups like (\d+) or (.*), use regex matching.
  // Also enter this branch when a catch-all parameter (:param* or :param+) is
  // followed by a literal suffix (e.g. "/:path*.md"). Without this, the suffix
  // pattern falls through to the simple segment matcher which incorrectly treats
  // the whole segment (":path*.md") as a named parameter and matches everything.
  // The last condition catches simple params with literal suffixes (e.g. "/:slug.md")
  // where the param name is followed by a dot — the simple matcher would treat
  // "slug.md" as the param name and match any single segment regardless of suffix.
  if (
    pattern.includes("(") ||
    pattern.includes("\\") ||
    /:[\w-]+[*+][^/]/.test(pattern) ||
    /:[\w-]+\./.test(pattern)
  ) {
    try {
      // Look up the compiled regex in the module-level cache. Patterns come
      // from next.config.js and are static, so we only need to compile each
      // one once across the lifetime of the worker/server process.
      let compiled = _compiledPatternCache.get(pattern);
      if (compiled === undefined) {
        // Cache miss — compile the pattern now and store the result.
        // Param names may contain hyphens (e.g. :auth-method, :sign-in).
        const paramNames: string[] = [];
        // Single-pass conversion with procedural suffix handling. The tokenizer
        // matches only simple, non-overlapping tokens; quantifier/constraint
        // suffixes after :param are consumed procedurally to avoid polynomial
        // backtracking in the regex engine.
        let regexStr = "";
        const tokenRe = /:([\w-]+)|[.]|[^:.]+/g; // lgtm[js/redos] — alternatives are non-overlapping (`:` and `.` excluded from `[^:.]+`)
        let tok: RegExpExecArray | null;
        while ((tok = tokenRe.exec(pattern)) !== null) {
          if (tok[1] !== undefined) {
            const name = tok[1];
            const rest = pattern.slice(tokenRe.lastIndex);
            // Check for quantifier (* or +) with optional constraint
            if (rest.startsWith("*") || rest.startsWith("+")) {
              const quantifier = rest[0];
              tokenRe.lastIndex += 1;
              const constraint = extractConstraint(pattern, tokenRe);
              paramNames.push(name);
              if (constraint !== null) {
                regexStr += `(${constraint})`;
              } else {
                regexStr += quantifier === "*" ? "(.*)" : "(.+)";
              }
            } else {
              // Check for inline constraint without quantifier
              const constraint = extractConstraint(pattern, tokenRe);
              paramNames.push(name);
              regexStr += constraint !== null ? `(${constraint})` : "([^/]+)";
            }
          } else if (tok[0] === ".") {
            regexStr += "\\.";
          } else {
            regexStr += tok[0];
          }
        }
        const re = safeRegExp("^" + regexStr + "$");
        // Store null for rejected patterns so we don't re-run isSafeRegex.
        compiled = re ? { re, paramNames } : null;
        _compiledPatternCache.set(pattern, compiled);
      }
      if (!compiled) return null;
      const match = compiled.re.exec(pathname);
      if (!match) return null;
      const params: Record<string, string> = Object.create(null);
      for (let i = 0; i < compiled.paramNames.length; i++) {
        params[compiled.paramNames[i]] = match[i + 1] ?? "";
      }
      return params;
    } catch {
      // Fall through to segment-based matching
    }
  }

  // Check for catch-all patterns (:param* or :param+) without regex groups
  // Param names may contain hyphens (e.g. :sign-in*, :sign-up+).
  const catchAllMatch = pattern.match(/:([\w-]+)(\*|\+)$/);
  if (catchAllMatch) {
    const prefix = pattern.slice(0, pattern.lastIndexOf(":"));
    const paramName = catchAllMatch[1];
    const isPlus = catchAllMatch[2] === "+";

    const prefixNoSlash = prefix.replace(/\/$/, "");
    if (!pathname.startsWith(prefixNoSlash)) return null;
    const charAfter = pathname[prefixNoSlash.length];
    if (charAfter !== undefined && charAfter !== "/") return null;

    const rest = pathname.slice(prefixNoSlash.length);
    if (isPlus && (!rest || rest === "/")) return null;
    let restValue = rest.startsWith("/") ? rest.slice(1) : rest;
    // NOTE: Do NOT decodeURIComponent here. The pathname is already decoded at
    // the request entry point. Decoding again would produce incorrect param values.
    return { [paramName]: restValue };
  }

  // Simple segment-based matching for exact patterns and :param
  const parts = pattern.split("/");
  const pathParts = pathname.split("/");

  if (parts.length !== pathParts.length) return null;

  const params: Record<string, string> = Object.create(null);
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].startsWith(":")) {
      params[parts[i].slice(1)] = pathParts[i];
    } else if (parts[i] !== pathParts[i]) {
      return null;
    }
  }
  return params;
}

/**
 * Apply redirect rules from next.config.js.
 * Returns the redirect info if a redirect was matched, or null.
 *
 * `ctx` provides the request context (cookies, headers, query, host) used
 * to evaluate has/missing conditions. Next.js always has request context
 * when evaluating redirects, so this parameter is required.
 *
 * ## Performance
 *
 * Rules with a locale-capture-group prefix (the dominant pattern in large
 * Next.js apps — e.g. `/:locale(en|es|fr|...)?/some-path`) are handled via
 * a pre-built index. Instead of running exec() on each locale regex
 * individually, we:
 *
 *   1. Strip the optional locale prefix from the pathname with one cheap
 *      string-slice check (no regex exec on the hot path).
 *   2. Look up the stripped suffix in a Map<suffix, entry[]>.
 *   3. For each matching entry, validate the captured locale string against
 *      a small, anchored alternation regex.
 *
 * This reduces the per-request cost from O(n × regex) to O(1) map lookup +
 * O(matches × tiny-regex), eliminating the ~2992ms self-time reported in
 * profiles for apps with 63+ locale-prefixed rules.
 *
 * Rules that don't fit the locale-static pattern fall back to the original
 * linear matchConfigPattern scan.
 *
 * ## Ordering invariant
 *
 * First match wins, preserving the original redirect array order. When a
 * locale-static fast-path match is found at position N, all linear rules with
 * an original index < N are checked via matchConfigPattern first — they are
 * few in practice (typically zero) so this is not a hot-path concern.
 */
export function matchRedirect(
  pathname: string,
  redirects: NextRedirect[],
  ctx: RequestContext,
): { destination: string; permanent: boolean } | null {
  if (redirects.length === 0) return null;

  const index = _getRedirectIndex(redirects);

  // --- Locate the best locale-static candidate ---
  //
  // We look for the locale-static entry with the LOWEST originalIndex that
  // matches this pathname (and passes has/missing conditions).
  //
  // Strategy: try both the full pathname (locale omitted, e.g. "/security")
  // and the pathname with the first segment stripped (locale present, e.g.
  // "/en/security" → suffix "/security", locale "en").
  //
  // We do NOT use a regex here — just a single indexOf('/') to locate the
  // second slash, which is O(n) on the path length but far cheaper than
  // running 63 compiled regexes.

  let localeMatch: { destination: string; permanent: boolean } | null = null;
  let localeMatchIndex = Infinity;

  if (index.localeStatic.size > 0) {
    // Case 1: no locale prefix — pathname IS the suffix.
    const noLocaleBucket = index.localeStatic.get(pathname);
    if (noLocaleBucket) {
      for (const entry of noLocaleBucket) {
        if (entry.originalIndex >= localeMatchIndex) continue; // already have a better match
        const redirect = entry.redirect;
        const conditionParams =
          redirect.has || redirect.missing
            ? collectConditionParams(redirect.has, redirect.missing, ctx)
            : _emptyParams();
        if (!conditionParams) continue;
        // Locale was omitted (the `?` made it optional) — param value is "".
        let dest = substituteDestinationParams(redirect.destination, {
          [entry.paramName]: "",
          ...conditionParams,
        });
        dest = sanitizeDestination(dest);
        localeMatch = { destination: dest, permanent: redirect.permanent };
        localeMatchIndex = entry.originalIndex;
        break; // bucket entries are in insertion order = original order
      }
    }

    // Case 2: locale prefix present — first path segment is the locale.
    // Find the second slash: pathname = "/locale/rest/of/path"
    //                                         ^--- slashTwo
    const slashTwo = pathname.indexOf("/", 1);
    if (slashTwo !== -1) {
      const suffix = pathname.slice(slashTwo); // e.g. "/security"
      const localePart = pathname.slice(1, slashTwo); // e.g. "en"
      const localeBucket = index.localeStatic.get(suffix);
      if (localeBucket) {
        for (const entry of localeBucket) {
          if (entry.originalIndex >= localeMatchIndex) continue;
          // Validate that `localePart` is one of the allowed alternation values.
          if (!entry.altRe.test(localePart)) continue;
          const redirect = entry.redirect;
          const conditionParams =
            redirect.has || redirect.missing
              ? collectConditionParams(redirect.has, redirect.missing, ctx)
              : _emptyParams();
          if (!conditionParams) continue;
          let dest = substituteDestinationParams(redirect.destination, {
            [entry.paramName]: localePart,
            ...conditionParams,
          });
          dest = sanitizeDestination(dest);
          localeMatch = { destination: dest, permanent: redirect.permanent };
          localeMatchIndex = entry.originalIndex;
          break; // bucket entries are in insertion order = original order
        }
      }
    }
  }

  // --- Linear fallback: all non-locale-static rules ---
  //
  // We only need to check linear rules whose originalIndex < localeMatchIndex.
  // If localeMatchIndex is Infinity (no locale match), we check all of them.
  for (const [origIdx, redirect] of index.linear) {
    if (origIdx >= localeMatchIndex) {
      // This linear rule comes after the best locale-static match —
      // the locale-static match wins. Stop scanning.
      break;
    }
    const params = matchConfigPattern(pathname, redirect.source);
    if (params) {
      const conditionParams =
        redirect.has || redirect.missing
          ? collectConditionParams(redirect.has, redirect.missing, ctx)
          : _emptyParams();
      if (!conditionParams) continue;
      let dest = substituteDestinationParams(redirect.destination, {
        ...params,
        ...conditionParams,
      });
      // Collapse protocol-relative URLs (e.g. //evil.com from decoded %2F in catch-all params).
      dest = sanitizeDestination(dest);
      return { destination: dest, permanent: redirect.permanent };
    }
  }

  // Return the locale-static match if found (no earlier linear rule matched).
  return localeMatch;
}

/**
 * Apply rewrite rules from next.config.js.
 * Returns the rewritten URL or null if no rewrite matched.
 *
 * `ctx` provides the request context (cookies, headers, query, host) used
 * to evaluate has/missing conditions. Next.js always has request context
 * when evaluating rewrites, so this parameter is required.
 */
export function matchRewrite(
  pathname: string,
  rewrites: NextRewrite[],
  ctx: RequestContext,
): string | null {
  for (const rewrite of rewrites) {
    const params = matchConfigPattern(pathname, rewrite.source);
    if (params) {
      const conditionParams =
        rewrite.has || rewrite.missing
          ? collectConditionParams(rewrite.has, rewrite.missing, ctx)
          : _emptyParams();
      if (!conditionParams) continue;
      let dest = substituteDestinationParams(rewrite.destination, {
        ...params,
        ...conditionParams,
      });
      // Collapse protocol-relative URLs (e.g. //evil.com from decoded %2F in catch-all params).
      dest = sanitizeDestination(dest);
      return dest;
    }
  }
  return null;
}

/**
 * Substitute all matched route params into a redirect/rewrite destination.
 *
 * Handles repeated params (e.g. `/api/:id/:id`) and catch-all suffix forms
 * (`:path*`, `:path+`) in a single pass. Unknown params are left intact.
 */
function substituteDestinationParams(destination: string, params: Record<string, string>): string {
  const keys = Object.keys(params);
  if (keys.length === 0) return destination;

  // Match only the concrete param keys captured from the source pattern.
  // Sorting longest-first ensures hyphenated names like `auth-method`
  // win over shorter prefixes like `auth`. The negative lookahead keeps
  // alphanumeric/underscore suffixes attached, while allowing `-` to act
  // as a literal delimiter in destinations like `:year-:month`.
  const sortedKeys = [...keys].sort((a, b) => b.length - a.length);
  const cacheKey = sortedKeys.join("\0");
  let paramRe = _compiledDestinationParamCache.get(cacheKey);
  if (!paramRe) {
    const paramAlternation = sortedKeys
      .map((key) => key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("|");
    paramRe = new RegExp(`:(${paramAlternation})([+*])?(?![A-Za-z0-9_])`, "g");
    _compiledDestinationParamCache.set(cacheKey, paramRe);
  }

  return destination.replace(paramRe, (_token, key: string) => params[key]);
}

/**
 * Sanitize a redirect/rewrite destination to collapse protocol-relative URLs.
 *
 * After parameter substitution, a destination like `/:path*` can become
 * `//evil.com` if the catch-all captured a decoded `%2F` (`/evil.com`).
 * Browsers interpret `//evil.com` as a protocol-relative URL, redirecting
 * users off-site.
 *
 * This function collapses any leading double (or more) slashes to a single
 * slash for non-external (relative) destinations.
 */
export function sanitizeDestination(dest: string): string {
  // External URLs (http://, https://) are intentional — don't touch them
  if (dest.startsWith("http://") || dest.startsWith("https://")) {
    return dest;
  }
  // Normalize leading backslashes to forward slashes. Browsers interpret
  // backslash as forward slash in URL contexts, so "\/evil.com" becomes
  // "//evil.com" (protocol-relative redirect). Replace any mix of leading
  // slashes and backslashes with a single forward slash.
  dest = dest.replace(/^[\\/]+/, "/");
  return dest;
}

/**
 * Check if a URL is external (absolute URL or protocol-relative).
 * Detects any URL scheme (http:, https:, data:, javascript:, blob:, etc.)
 * per RFC 3986, plus protocol-relative URLs (//).
 */
export function isExternalUrl(url: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith("//");
}

/**
 * Proxy an incoming request to an external URL and return the upstream response.
 *
 * Used for external rewrites (e.g. `/ph/:path*` → `https://us.i.posthog.com/:path*`).
 * Next.js handles these as server-side reverse proxies, forwarding the request
 * method, headers, and body to the external destination.
 *
 * Works in all runtimes (Node.js, Cloudflare Workers) via the standard fetch() API.
 */
export async function proxyExternalRequest(
  request: Request,
  externalUrl: string,
): Promise<Response> {
  // Build the full external URL, preserving query parameters from the original request
  const originalUrl = new URL(request.url);
  const targetUrl = new URL(externalUrl);
  const destinationKeys = new Set(targetUrl.searchParams.keys());

  // If the rewrite destination already has query params, merge them.
  // Destination params take precedence — original request params are only added
  // when the destination doesn't already specify that key.
  for (const [key, value] of originalUrl.searchParams) {
    if (!destinationKeys.has(key)) {
      targetUrl.searchParams.append(key, value);
    }
  }

  // Forward the request with appropriate headers
  const headers = new Headers(request.headers);
  // Set Host to the external target (required for correct routing)
  headers.set("host", targetUrl.host);
  // Remove headers that should not be forwarded to external services.
  // fetch() handles framing independently, so hop-by-hop transport headers
  // from the client must not be forwarded upstream. In particular,
  // transfer-encoding could cause request boundary disagreement between the
  // proxy and backend (defense-in-depth against request smuggling,
  // ref: CVE GHSA-ggv3-7p47-pfv8).
  stripHopByHopRequestHeaders(headers);
  const keysToDelete: string[] = [];
  for (const key of headers.keys()) {
    if (key.startsWith("x-middleware-")) {
      keysToDelete.push(key);
    }
  }
  for (const key of keysToDelete) {
    headers.delete(key);
  }

  const method = request.method;
  const hasBody = method !== "GET" && method !== "HEAD";

  const init: RequestInit & { duplex?: string } = {
    method,
    headers,
    redirect: "manual", // Don't follow redirects — pass them through to the client
  };

  if (hasBody && request.body) {
    init.body = request.body;
    init.duplex = "half";
  }

  // Enforce a timeout so slow/unresponsive upstreams don't hold connections
  // open indefinitely (DoS amplification risk on Node.js dev/prod servers).
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(targetUrl.href, { ...init, signal: controller.signal });
  } catch (e: any) {
    if (e?.name === "AbortError") {
      console.error("[vinext] External rewrite proxy timeout:", targetUrl.href);
      return new Response("Gateway Timeout", { status: 504 });
    }
    console.error("[vinext] External rewrite proxy error:", e);
    return new Response("Bad Gateway", { status: 502 });
  } finally {
    clearTimeout(timeout);
  }

  // Build the response to return to the client.
  // Copy all upstream headers except hop-by-hop headers.
  // Node.js fetch() auto-decompresses responses (gzip, br, etc.), so the body
  // we receive is already plain text. Forwarding the original content-encoding
  // and content-length headers causes the browser to attempt a second
  // decompression on the already-decoded body, resulting in
  // ERR_CONTENT_DECODING_FAILED. Strip both headers on Node.js only.
  // On Workers, fetch() preserves wire encoding, so the headers stay accurate.
  const isNodeRuntime = typeof process !== "undefined" && !!process.versions?.node;
  const responseHeaders = new Headers();
  upstreamResponse.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower)) return;
    if (isNodeRuntime && (lower === "content-encoding" || lower === "content-length")) return;
    responseHeaders.append(key, value);
  });

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers: responseHeaders,
  });
}

/**
 * Apply custom header rules from next.config.js.
 * Returns an array of { key, value } pairs to set on the response.
 *
 * `ctx` provides the request context (cookies, headers, query, host) used
 * to evaluate has/missing conditions. Next.js always has request context
 * when evaluating headers, so this parameter is required.
 */
export function matchHeaders(
  pathname: string,
  headers: NextHeader[],
  ctx: RequestContext,
): Array<{ key: string; value: string }> {
  const result: Array<{ key: string; value: string }> = [];
  for (const rule of headers) {
    // Cache the compiled source regex — escapeHeaderSource() + safeRegExp() are
    // pure functions of rule.source and the result never changes between requests.
    let sourceRegex = _compiledHeaderSourceCache.get(rule.source);
    if (sourceRegex === undefined) {
      const escaped = escapeHeaderSource(rule.source);
      sourceRegex = safeRegExp("^" + escaped + "$");
      _compiledHeaderSourceCache.set(rule.source, sourceRegex);
    }
    if (sourceRegex && sourceRegex.test(pathname)) {
      if (rule.has || rule.missing) {
        if (!checkHasConditions(rule.has, rule.missing, ctx)) {
          continue;
        }
      }
      result.push(...rule.headers);
    }
  }
  return result;
}
