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

