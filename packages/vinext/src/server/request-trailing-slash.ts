/**
 * The `trailingSlash` value to build a request's `NextURL` with.
 *
 * Next.js's getNextPathnameInfo takes the slash from the pathname itself and
 * only uses the config for root. vinext's NextURL applies the config as a
 * policy instead, which is equivalent while the trailing-slash redirect makes
 * every request canonical. `skipTrailingSlashRedirect` lets either form
 * through, so the request's own slash has to win.
 */
export function resolveRequestTrailingSlash(
  pathname: string,
  trailingSlash: boolean | undefined,
  skipTrailingSlashRedirect: boolean | undefined,
): boolean | undefined {
  return skipTrailingSlashRedirect && pathname !== "/" ? pathname.endsWith("/") : trailingSlash;
}
