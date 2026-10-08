import { notFoundResponse } from "./http-error-responses.js";

/**
 * Returns true if a request pathname looks like a protocol-relative open
 * redirect, in either literal or percent-encoded form.
 *
 * A pathname is considered "open redirect shaped" when its first segment,
 * after decoding backslashes and encoded delimiters, would cause a browser
 * to resolve a `Location` containing the pathname as protocol-relative.
 */
export function isOpenRedirectShaped(rawPathname: string): boolean {
  if (!rawPathname.startsWith("/")) return false;

  // Browsers treat backslashes as forward slashes in URL paths.
  const afterSlash = rawPathname.slice(1);
  if (afterSlash.startsWith("/") || afterSlash.startsWith("\\")) return true;

  // Percent escapes are case-insensitive per RFC 3986 section 2.1.
  if (afterSlash.length >= 3 && afterSlash[0] === "%") {
    const encoded = afterSlash.slice(0, 3).toLowerCase();
    if (encoded === "%5c" || encoded === "%2f") return true;
  }

  return false;
}

const REPEATED_SLASH_OR_BACKSLASH_RE = /\\|\/\//;
const REDIRECT_LOCATION_BASE = "http://vinext.invalid";

/**
 * What a request entry answers for a raw path containing a backslash or a
 * repeated slash: Next.js's 308, or a 404 when the collapsed path would still
 * be open-redirect shaped.
 */
export type RepeatedSlashRedirect = { status: 308; location: string } | { status: 404 };

/**
 * Returns Next.js's redirect for a raw request path containing a backslash or
 * a repeated slash, or `null` when the path needs no change.
 *
 * Ported from Next.js's request entry (`base-server.ts` / `resolve-routes.ts`,
 * via `normalizeRepeatedSlashes` in `shared/lib/utils.ts`): backslashes in the
 * path become `/`, runs of slashes collapse to one and the query is kept.
 * `next start` then builds the Location with `url.format(parseUrl(...))` in
 * `router-server.ts`, so the result is serialized through a WHATWG URL here
 * too (`/a/%2e%2e//b` → `/b`, `?q="x"` → `?q=%22x%22`, as observed). It runs
 * before basePath handling, so `//` → `/`, `/docs//` → `/docs/` and
 * `//evil.com` → `/evil.com`. Percent-encoded `%2F`/`%5C` are not touched and
 * keep falling through to `isOpenRedirectShaped` (404), as in Next.js.
 *
 * The Location is always same-origin. Absolute-form request targets
 * (`GET http://host//x`) are left alone. A collapsed path that still starts
 * with an encoded slash or backslash (`//%2Fevil.com`, `/.//%2Fevil.com`) is
 * never echoed into a Location or routed: it gets a 404 instead.
 *
 * @param rawUrl - The raw request target: pathname plus optional `?query`
 */
export function getRepeatedSlashRedirect(rawUrl: string): RepeatedSlashRedirect | null {
  if (!rawUrl.startsWith("/")) return null;
  const urlParts = rawUrl.split("?");
  const pathname = urlParts[0];
  if (!REPEATED_SLASH_OR_BACKSLASH_RE.test(pathname)) return null;

  // Same as Next.js: the query is kept only when its first `?`-separated part
  // is non-empty, so `//??next=1` redirects to `/`.
  const cleanUrl =
    pathname.replaceAll("\\", "/").replace(/\/\/+/g, "/") +
    (urlParts[1] ? `?${urlParts.slice(1).join("?")}` : "");
  const parsed = new URL(REDIRECT_LOCATION_BASE + cleanUrl);
  const location = parsed.pathname + parsed.search + parsed.hash;
  return isOpenRedirectShaped(location) ? { status: 404 } : { status: 308, location };
}

function repeatedSlashRedirectHeaders(location: string): Record<string, string> {
  return { Location: location, Refresh: `0;url=${location}` };
}

/**
 * Build the Response for a raw request path containing a backslash or a
 * repeated slash. See `getRepeatedSlashRedirect`.
 */
export function repeatedSlashRedirectResponse(rawUrl: string): Response | null {
  const redirect = getRepeatedSlashRedirect(rawUrl);
  if (!redirect) return null;
  if (redirect.status === 404) return notFoundResponse();
  return new Response(redirect.location, {
    status: 308,
    headers: repeatedSlashRedirectHeaders(redirect.location),
  });
}

/**
 * Node `ServerResponse` counterpart of `repeatedSlashRedirectResponse`, for
 * entries that see the raw request target (dev and `vinext start`). Returns
 * true when a response was sent.
 */
export function sendRepeatedSlashRedirect(
  rawUrl: string,
  res: {
    writeHead(status: number, headers?: Record<string, string>): unknown;
    end(body: string): unknown;
  },
): boolean {
  const redirect = getRepeatedSlashRedirect(rawUrl);
  if (!redirect) return false;
  if (redirect.status === 404) {
    res.writeHead(404);
    res.end("This page could not be found");
    return true;
  }
  res.writeHead(308, repeatedSlashRedirectHeaders(redirect.location));
  res.end(redirect.location);
  return true;
}
