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
 * Query substitution follows how Next.js consumes each destination kind:
 *
 * - A rewrite's query is parsed into an object before substitution, so the
 *   target sees each param verbatim as one value. vinext encodes the whole
 *   value so it round-trips back to that verbatim string.
 * - A redirect's query is emitted as Location text with params inserted
 *   verbatim, so an already percent-encoded capture is decoded once by the
 *   client. vinext inserts redirect params verbatim too.
 *
 * A rewrite's absolute destination is proxied server-side, so params in its
 * authority (`https://:tenant.example.com/`) are percent-encoded, keeping the
 * `%XX` escapes a raw path capture already carries. A decoded `has` capture
 * carrying `#`, `/`, `?`, `@` or `:` then makes the host invalid instead of
 * moving the proxy to another host. Next.js substitutes the hostname verbatim
 * and can be retargeted this way; vinext is stricter.
 *
 * https://github.com/vercel/next.js/blob/canary/packages/next/src/shared/lib/router/utils/prepare-destination.ts
 * https://github.com/vercel/next.js/blob/canary/packages/next/src/server/server-route-utils.ts
 */
export function substituteDestinationParams(
  destination: string,
  params: Record<string, string>,
  kind: "redirect" | "rewrite",
): string {
  const paramRe = getDestinationParamRegex(params);
  if (!paramRe) return destination;

  const replaceParams = (value: string, encodeParam: (value: string) => string): string =>
    value.replace(paramRe, (_token, key: string) => encodeParam(params[key]));

  if (kind === "redirect") return replaceParams(destination, (value) => value);

  const hashIndex = destination.indexOf("#");
  const beforeHash = hashIndex === -1 ? destination : destination.slice(0, hashIndex);
  const hash = hashIndex === -1 ? "" : destination.slice(hashIndex);
  const queryIndex = beforeHash.indexOf("?");
  const beforeQuery = queryIndex === -1 ? beforeHash : beforeHash.slice(0, queryIndex);
  // A param may supply the scheme itself (`:proto://:tenant.example.com/`), so
  // find the authority with each param token standing in as same-length text.
  const authorityEnd = getAbsoluteUrlAuthorityEnd(
    beforeQuery.replace(paramRe, (token) => "x".repeat(token.length)),
  );
  const path = `${replaceParams(beforeQuery.slice(0, authorityEnd), encodeAuthorityParam)}${replaceParams(
    beforeQuery.slice(authorityEnd),
    (value) => value,
  )}`;
  const query =
    queryIndex === -1
      ? ""
      : `?${replaceParams(beforeHash.slice(queryIndex + 1), encodeRewriteQueryParamValue)}`;
  return `${path}${query}${replaceParams(hash, (value) => value)}`;
}

// End of the `scheme://authority` prefix of an absolute URL. Like the URL
// parser for special schemes, any run of `/` or `\` after the scheme belongs
// to the prefix, and the ASCII tab/newline characters it strips do not end it.
// A destination that is neither a path nor a literal absolute URL (Next.js
// rejects these) has its first segment treated the same way, so a param can
// never supply the `:` or slashes of a scheme.
function getAbsoluteUrlAuthorityEnd(value: string): number {
  const scheme = /^[a-z][a-z0-9+.-]*:[/\\\t\n\r]*/i.exec(value);
  if (!scheme && /^[/\\]/.test(value)) return 0;
  const start = scheme ? scheme[0].length : 0;
  const pathStart = value.slice(start).search(/[/\\]/);
  return pathStart === -1 ? value.length : start + pathStart;
}

/**
 * Split a redirect destination's query into parts before substituting params,
 * as Next.js's prepareDestination parses the template query first. Each part
 * is `[key, keyText, valueText]`: the texts are the part's template text with
 * params substituted verbatim (`valueText` is `null` without an `=`), and
 * `key` is the decoded key, used only to match request params. Keeping these
 * boundaries means a param containing `&` stays one value when the request
 * query is merged in.
 *
 * https://github.com/vercel/next.js/blob/canary/packages/next/src/shared/lib/router/utils/prepare-destination.ts
 */
export function substituteRedirectDestinationQuery(
  destination: string,
  params: Record<string, string>,
): RedirectDestinationQueryPart[] {
  const hashIndex = destination.indexOf("#");
  const beforeHash = hashIndex === -1 ? destination : destination.slice(0, hashIndex);
  const queryIndex = beforeHash.indexOf("?");
  if (queryIndex === -1) return [];

  const paramRe = getDestinationParamRegex(params);
  const substitute = (value: string) =>
    paramRe ? value.replace(paramRe, (_token, key: string) => params[key]) : value;

  return beforeHash
    .slice(queryIndex + 1)
    .split("&")
    .filter(Boolean)
    .map((part) => {
      const equalsIndex = part.indexOf("=");
      const keyText = substitute(equalsIndex === -1 ? part : part.slice(0, equalsIndex));
      const valueText = equalsIndex === -1 ? null : substitute(part.slice(equalsIndex + 1));
      return [decodeQueryKey(keyText), keyText, valueText];
    });
}

export type RedirectDestinationQueryPart = [key: string, keyText: string, valueText: string | null];

// Decode with URLSearchParams semantics (`+` as space, malformed escapes kept)
// so destination keys match request keys parsed the same way.
function decodeQueryKey(keyText: string): string {
  const [entry] = new URLSearchParams(keyText.replace(/[&=]/g, (char) => encodeURIComponent(char)));
  return entry?.[0] ?? "";
}

function getDestinationParamRegex(params: Record<string, string>): RegExp | null {
  const keys = Object.keys(params);
  if (keys.length === 0) return null;

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

  return paramRe;
}

// The host parser decodes `%XX` once and rejects forbidden code points, so a
// kept escape (`%23`) still makes the host invalid rather than ending it.
function encodeAuthorityParam(value: string): string {
  return value.replace(/%(?![0-9a-f]{2})|[^A-Za-z0-9._~%-]/giu, encodeURIComponent);
}

function encodeRewriteQueryParamValue(value: string): string {
  const params = new URLSearchParams();
  params.set("", value);
  return params.toString().slice(1);
}
