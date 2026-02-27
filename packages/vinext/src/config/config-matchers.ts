/**
 * Config pattern matching and rule application utilities.
 *
 * Shared between the dev server (index.ts) and the production server
 * (prod-server.ts) so both apply next.config.js rules identically.
 */

import type { NextRedirect, NextRewrite, NextHeader, HasCondition } from "./next-config.js";

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
  // Match named params (:\w+), sentinel group placeholders, metacharacters, and literal text.
  // The regex uses non-overlapping alternatives to avoid backtracking:
  //   :\w+  — named parameter (constraint sentinel is checked procedurally)
  //   sentinel group — standalone regex group placeholder
  //   [.+?*] — single metachar to escape/convert
  //   [^.+?*:\uE000]+ — literal text (excludes all chars that start other alternatives)
  let result = "";
  const re = new RegExp(
    `${S}G(\\d+)${S}|:\\w+|[.+?*]|[^.+?*:\\uE000]+`, // lgtm[js/redos] — alternatives are non-overlapping
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
        case ".": result += "\\."; break;
        case "+": result += "\\+"; break;
        case "?": result += "\\?"; break;
        case "*": result += ".*"; break;
        default: result += m[0]; break;
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
    host: request.headers.get("host") ?? url.host,
  };
}

/**
 * Check a single has/missing condition against request context.
 * Returns true if the condition is satisfied.
 */
function checkSingleCondition(condition: HasCondition, ctx: RequestContext): boolean {
  switch (condition.type) {
    case "header": {
      const headerValue = ctx.headers.get(condition.key);
      if (headerValue === null) return false;
      if (condition.value !== undefined) {
        const re = safeRegExp(condition.value);
        if (re) return re.test(headerValue);
        return headerValue === condition.value;
      }
      return true; // Key exists, no value constraint
    }
    case "cookie": {
      const cookieValue = ctx.cookies[condition.key];
      if (cookieValue === undefined) return false;
      if (condition.value !== undefined) {
        const re = safeRegExp(condition.value);
        if (re) return re.test(cookieValue);
        return cookieValue === condition.value;
      }
      return true;
    }
    case "query": {
      const queryValue = ctx.query.get(condition.key);
      if (queryValue === null) return false;
      if (condition.value !== undefined) {
        const re = safeRegExp(condition.value);
        if (re) return re.test(queryValue);
        return queryValue === condition.value;
      }
      return true;
    }
    case "host": {
      if (condition.value !== undefined) {
        const re = safeRegExp(condition.value);
        if (re) return re.test(ctx.host);
        return ctx.host === condition.value;
      }
      return ctx.host === condition.key;
    }
    default:
      return false;
  }
}

/**
 * Check all has/missing conditions for a config rule.
 * Returns true if the rule should be applied (all has conditions pass, all missing conditions pass).
 *
 * - has: every condition must match (the request must have it)
 * - missing: every condition must NOT match (the request must not have it)
 */
export function checkHasConditions(
  has: HasCondition[] | undefined,
  missing: HasCondition[] | undefined,
  ctx: RequestContext,
): boolean {
  if (has) {
    for (const condition of has) {
      if (!checkSingleCondition(condition, ctx)) return false;
    }
  }
  if (missing) {
    for (const condition of missing) {
      if (checkSingleCondition(condition, ctx)) return false;
    }
  }
  return true;
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
  if (
    pattern.includes("(") ||
    pattern.includes("\\") ||
    /:\w+[*+][^/]/.test(pattern)
  ) {
    try {
      const paramNames: string[] = [];
      // Single-pass conversion with procedural suffix handling. The tokenizer
      // matches only simple, non-overlapping tokens; quantifier/constraint
      // suffixes after :param are consumed procedurally to avoid polynomial
      // backtracking in the regex engine.
      let regexStr = "";
      const tokenRe = /:(\w+)|[.]|[^:.]+/g; // lgtm[js/redos] — alternatives are non-overlapping (`:` and `.` excluded from `[^:.]+`)
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
      if (!re) return null;
      const match = re.exec(pathname);
      if (!match) return null;
      const params: Record<string, string> = Object.create(null);
      for (let i = 0; i < paramNames.length; i++) {
        params[paramNames[i]] = match[i + 1] ?? "";
      }
      return params;
    } catch {
      // Fall through to segment-based matching
    }
  }

  // Check for catch-all patterns (:param* or :param+) without regex groups
  const catchAllMatch = pattern.match(/:(\w+)(\*|\+)$/);
  if (catchAllMatch) {
    const prefix = pattern.slice(0, pattern.lastIndexOf(":"));
    const paramName = catchAllMatch[1];
    const isPlus = catchAllMatch[2] === "+";

    if (!pathname.startsWith(prefix.replace(/\/$/, ""))) return null;

    const rest = pathname.slice(prefix.replace(/\/$/, "").length);
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
 * When `ctx` is provided, has/missing conditions on the redirect rules
 * are evaluated against the request context (cookies, headers, query, host).
 */
export function matchRedirect(
  pathname: string,
  redirects: NextRedirect[],
  ctx?: RequestContext,
): { destination: string; permanent: boolean } | null {
  for (const redirect of redirects) {
    const params = matchConfigPattern(pathname, redirect.source);
    if (params) {
      // Check has/missing conditions if present and context is available
      if (ctx && (redirect.has || redirect.missing)) {
        if (!checkHasConditions(redirect.has, redirect.missing, ctx)) {
          continue;
        }
      }
      let dest = redirect.destination;
      for (const [key, value] of Object.entries(params)) {
        // Replace :param*, :param+, and :param forms in the destination.
        // The catch-all suffixes (* and +) must be stripped along with the param name.
        dest = dest.replace(`:${key}*`, value);
        dest = dest.replace(`:${key}+`, value);
        dest = dest.replace(`:${key}`, value);
      }
      // Collapse protocol-relative URLs (e.g. //evil.com from decoded %2F in catch-all params).
      dest = sanitizeDestination(dest);
      return { destination: dest, permanent: redirect.permanent };
    }
  }
  return null;
}

/**
 * Apply rewrite rules from next.config.js.
 * Returns the rewritten URL or null if no rewrite matched.
 *
 * When `ctx` is provided, has/missing conditions on the rewrite rules
 * are evaluated against the request context (cookies, headers, query, host).
 */
export function matchRewrite(
  pathname: string,
  rewrites: NextRewrite[],
  ctx?: RequestContext,
): string | null {
  for (const rewrite of rewrites) {
    const params = matchConfigPattern(pathname, rewrite.source);
    if (params) {
      // Check has/missing conditions if present and context is available
      if (ctx && (rewrite.has || rewrite.missing)) {
        if (!checkHasConditions(rewrite.has, rewrite.missing, ctx)) {
          continue;
        }
      }
      let dest = rewrite.destination;
      for (const [key, value] of Object.entries(params)) {
        // Replace :param*, :param+, and :param forms in the destination.
        // The catch-all suffixes (* and +) must be stripped along with the param name.
        dest = dest.replace(`:${key}*`, value);
        dest = dest.replace(`:${key}+`, value);
        dest = dest.replace(`:${key}`, value);
      }
      // Collapse protocol-relative URLs (e.g. //evil.com from decoded %2F in catch-all params).
      dest = sanitizeDestination(dest);
      return dest;
    }
  }
  return null;
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

  // If the rewrite destination already has query params, merge them.
  // Destination params take precedence — original request params are only added
  // when the destination doesn't already specify that key.
  for (const [key, value] of originalUrl.searchParams) {
    if (!targetUrl.searchParams.has(key)) {
      targetUrl.searchParams.set(key, value);
    }
  }

  // Forward the request with appropriate headers
  const headers = new Headers(request.headers);
  // Set Host to the external target (required for correct routing)
  headers.set("host", targetUrl.host);
  // Remove headers that should not be forwarded to external services
  headers.delete("connection");
  // Strip credentials and internal headers to prevent leaking auth tokens,
  // session cookies, and middleware internals to third-party origins.
  headers.delete("cookie");
  headers.delete("authorization");
  headers.delete("x-api-key");
  headers.delete("proxy-authorization");
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
  const responseHeaders = new Headers();
  upstreamResponse.headers.forEach((value, key) => {
    if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
      responseHeaders.append(key, value);
    }
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
 */
export function matchHeaders(
  pathname: string,
  headers: NextHeader[],
): Array<{ key: string; value: string }> {
  const result: Array<{ key: string; value: string }> = [];
  for (const rule of headers) {
    const escaped = escapeHeaderSource(rule.source);
    const sourceRegex = safeRegExp("^" + escaped + "$");
    if (sourceRegex && sourceRegex.test(pathname)) {
      result.push(...rule.headers);
    }
  }
  return result;
}
