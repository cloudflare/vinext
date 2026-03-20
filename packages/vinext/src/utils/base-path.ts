/**
 * Shared basePath helpers.
 *
 * Next.js only treats a pathname as being under basePath when it is an exact
 * match ("/app") or starts with the basePath followed by a path separator
 * ("/app/..."). Prefix-only matches like "/application" must be left intact.
 */

/**
 * Check whether a pathname is inside the configured basePath.
 */
export function hasBasePath(pathname: string, basePath: string): boolean {
  if (!basePath) return false;
  return pathname === basePath || pathname.startsWith(basePath + "/");
}

/**
 * Strip the basePath prefix from a pathname when it matches on a segment
 * boundary. Returns the original pathname when it is outside the basePath.
 */
export function stripBasePath(pathname: string, basePath: string): string {
  if (!hasBasePath(pathname, basePath)) return pathname;
  return pathname.slice(basePath.length) || "/";
}
