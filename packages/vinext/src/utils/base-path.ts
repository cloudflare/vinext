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

/**
 * Remove trailing slashes from a pathname while preserving the root "/".
 * Collapses any number of trailing slashes ("/a//" → "/a"). Used by the
 * trailing-slash redirect path and route pattern normalization.
 */
export function removeTrailingSlash(pathname: string): string {
  if (pathname === "/") return "/";
  let end = pathname.length;
  while (end > 0 && pathname.charCodeAt(end - 1) === 47 /* "/" */) end--;
  return end === 0 ? "/" : pathname.slice(0, end);
}
