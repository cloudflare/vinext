/**
 * Destination param substitution for next.config.js redirects and rewrites.
 *
 * Kept free of server-only imports so the Pages Router client can apply simple
 * beforeFiles rewrites with exactly the same substitution as the server.
 */

/**
 * Cache for destination substitution regexes in substituteDestinationParams.
 *
 * The regex depends only on the set of param keys captured from the matched
 * source pattern. Caching by sorted key list avoids recompiling a new RegExp
 * for repeated redirect/rewrite calls that use the same param shape.
 */
const _compiledDestinationParamCache = new Map<string, RegExp>();

/**
 * Substitute all matched route params into a redirect/rewrite destination.
 *
 * Handles repeated params (e.g. `/api/:id/:id`) and catch-all suffix forms
 * (`:path*`, `:path+`) in a single pass. Unknown params are left intact.
 *
 * Params substituted into the query are escaped so an `&` or `=` in a param
 * stays inside one query value instead of introducing extra query params.
 * The escaping follows how Next.js consumes each destination kind:
 *
 * - A rewrite's query is parsed into an object before substitution, so the
 *   target sees each param verbatim as one value. vinext encodes the whole
 *   value so it round-trips back to that verbatim string.
 * - A redirect's query is emitted as Location text with params inserted
 *   verbatim, so an already percent-encoded capture is decoded once by the
 *   client. vinext keeps that text and only escapes characters that would end
 *   the value or are not valid in a URL query. Next.js inserts a literal `&`
 *   verbatim here; escaping it is deliberate hardening.
 *
 * https://github.com/vercel/next.js/blob/canary/packages/next/src/shared/lib/router/utils/prepare-destination.ts
 * https://github.com/vercel/next.js/blob/canary/packages/next/src/server/server-route-utils.ts
 */
export function substituteDestinationParams(
  destination: string,
  params: Record<string, string>,
  kind: "redirect" | "rewrite",
): string {
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

  const replaceParams = (value: string, encodeParam: (value: string) => string): string =>
    value.replace(paramRe, (_token, key: string) => encodeParam(params[key]));

  const hashIndex = destination.indexOf("#");
  const beforeHash = hashIndex === -1 ? destination : destination.slice(0, hashIndex);
  const hash = hashIndex === -1 ? "" : destination.slice(hashIndex);
  const queryIndex = beforeHash.indexOf("?");

  if (queryIndex !== -1) {
    const beforeQuery = beforeHash.slice(0, queryIndex);
    const query = beforeHash.slice(queryIndex + 1);
    return `${replaceParams(beforeQuery, (value) => value)}?${replaceParams(
      query,
      kind === "rewrite" ? encodeRewriteQueryParamValue : encodeRedirectQueryParamValue,
    )}${replaceParams(hash, (value) => value)}`;
  }

  return replaceParams(destination, (value) => value);
}

function encodeRewriteQueryParamValue(value: string): string {
  const params = new URLSearchParams();
  params.set("", value);
  return params.toString().slice(1);
}

// Matches anything that is not an RFC 3986 query character, the `&`, `=` and
// `#` value delimiters, and any `%` that does not start a percent-encoded triplet.
const REDIRECT_QUERY_VALUE_UNSAFE_REGEX = /%(?![0-9A-Fa-f]{2})|[^A-Za-z0-9\-._~!$'()*+,;:@/?%]/gu;

function encodeRedirectQueryParamValue(value: string): string {
  return value.replace(REDIRECT_QUERY_VALUE_UNSAFE_REGEX, (char) => encodeURIComponent(char));
}
