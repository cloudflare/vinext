/**
 * Re-encode path delimiter characters that were decoded by decodeURIComponent.
 * After decoding a URL segment, characters like / # ? \ need to be re-encoded
 * so they don't change the path structure.
 *
 * Ported from Next.js: packages/next/src/shared/lib/router/utils/escape-path-delimiters.ts
 * https://github.com/vercel/next.js/blob/canary/packages/next/src/shared/lib/router/utils/escape-path-delimiters.ts
 */
export function escapePathDelimiters(segment: string, escapeEncoded?: boolean): string {
  return segment.replace(
    new RegExp(`([/#?]${escapeEncoded ? "|%(2f|23|3f|5c)" : ""})`, "gi"),
    (char: string) => encodeURIComponent(char),
  );
}

/**
 * Decode a URL pathname segment-by-segment, preserving encoded path delimiters.
 * Non-ASCII characters (e.g. %C3%A9 -> e) are decoded, but structural characters
 * like %2F (/) %23 (#) %3F (?) %5C (\) are re-encoded after decoding.
 *
 * This prevents encoded slashes from changing the path structure (e.g.
 * /admin%2Fpanel stays as a single segment, not /admin/panel).
 *
 * Ported from Next.js: packages/next/src/server/lib/router-utils/decode-path-params.ts
 * https://github.com/vercel/next.js/blob/canary/packages/next/src/server/lib/router-utils/decode-path-params.ts
 */
export function decodePathParams(pathname: string): string {
  return pathname
    .split("/")
    .map((seg) => {
      try {
        return escapePathDelimiters(decodeURIComponent(seg), true);
      } catch {
        return seg;
      }
    })
    .join("/");
}

/**
 * Path normalization utility for request handling.
 *
 * Normalizes URL pathnames to a canonical form BEFORE any matching occurs
 * (middleware, routing, redirects, rewrites). This ensures middleware and
 * the router always see the same path, preventing path-confusion issues like
 * double-slash mismatches.
 *
 * Normalization rules:
 *  1. Collapse consecutive slashes: //foo///bar → /foo/bar
 *  2. Resolve single-dot segments:  /foo/./bar  → /foo/bar
 *  3. Resolve double-dot segments:  /foo/../bar → /bar
 *  4. Ensure leading slash:         foo/bar     → /foo/bar
 *  5. Preserve root:                /           → /
 *
 * This function does NOT:
 *  - Strip or add trailing slashes (handled separately by trailingSlash config)
 *  - Decode percent-encoded characters (callers should decode before calling this)
 *  - Lowercase the path (route matching is case-sensitive)
 */
export function normalizePath(pathname: string): string {
  // Fast path: already canonical (single leading /, no //, no /./, no /../)
  if (
    pathname === "/" ||
    (pathname.length > 1 &&
      pathname[0] === "/" &&
      !pathname.includes("//") &&
      !pathname.includes("/./") &&
      !pathname.includes("/../") &&
      !pathname.endsWith("/.") &&
      !pathname.endsWith("/.."))
  ) {
    return pathname;
  }

  const segments = pathname.split("/");
  const resolved: string[] = [];

  for (const segment of segments) {
    if (segment === "" || segment === ".") {
      // Skip empty segments (from // or leading /) and single-dot segments
      continue;
    }
    if (segment === "..") {
      // Go up one level, but never above root
      resolved.pop();
    } else {
      resolved.push(segment);
    }
  }

  return "/" + resolved.join("/");
}
