/**
 * Client-side helpers for the Pages Router `/_next/data/<buildId>/<page>.json`
 * endpoint.
 *
 * Ported from Next.js:
 *   - `packages/next/src/client/page-loader.ts` (`getDataHref`)
 *   - `packages/next/src/shared/lib/router/utils/get-asset-path-from-route.ts`
 *
 * The server-side counterpart lives in `server/pages-data-route.ts` and parses
 * the URL shape this module generates. Keep the two in sync — they are the
 * wire-format contract between vinext's client navigation and its data
 * endpoint.
 */
import { matchRoutePattern, routePatternParts } from "../../routing/route-pattern.js";

/**
 * Append `.json` and the `/_next/data/<buildId>` prefix to a page pathname.
 *
 * Mirrors Next.js' `getAssetPathFromRoute` + `getDataHref` behaviour:
 *   `/`            → `/_next/data/<id>/index.json`
 *   `/about`       → `/_next/data/<id>/about.json`
 *   `/index`       → `/_next/data/<id>/index/index.json`  (explicit `/index` page)
 *   `/blog/foo`    → `/_next/data/<id>/blog/foo.json`
 *
 * `pagePath` is the resolved page pathname (already including any locale
 * prefix and dynamic-param substitution), with a leading slash and NO
 * trailing slash. The function does not URL-encode — the caller is expected
 * to have produced a server-routable path.
 */
export function buildPagesDataPath(buildId: string, pagePath: string): string {
  // Strip trailing slash except for the root path.
  let path = pagePath;
  if (path.length > 1 && path.endsWith("/")) {
    path = path.slice(0, -1);
  }

  // Next.js' `getAssetPathFromRoute` denormalisation:
  //   "/"            → "/index"
  //   "/index"       → "/index/index"
  //   "/index/foo"   → "/index/index/foo"
  // This mirrors `pages/index.tsx → /` and disambiguates an explicit
  // `pages/index.tsx` nested under a folder.
  let asset: string;
  if (path === "/") {
    asset = "/index";
  } else if (path === "/index" || path.startsWith("/index/")) {
    asset = "/index" + path;
  } else {
    asset = path;
  }

  return `/_next/data/${buildId}${asset}.json`;
}

/**
 * Build the full data URL including the basePath, the search string, and the
 * `/_next/data/<buildId>/<page>.json` segment.
 *
 * `pagePath` must already be the resolved pathname (param-substituted,
 * locale-prefixed where applicable). `search` includes the leading `?`.
 */
export function buildPagesDataHref(
  basePath: string,
  buildId: string,
  pagePath: string,
  search: string,
): string {
  const dataPath = buildPagesDataPath(buildId, pagePath);
  const prefix = basePath ? basePath : "";
  return `${prefix}${dataPath}${search}`;
}

/** Result of matching a URL pathname against the registered route patterns. */
type PagesPatternMatch = {
  /** The matched route pattern in Next.js bracket format (e.g. `/blog/[slug]`). */
  pattern: string;
  /** Dynamic route params extracted from the URL. */
  params: Record<string, string | string[]>;
};

/**
 * Find the route pattern (Next.js bracket format) that matches `pathname`.
 *
 * Patterns are tried in `patterns` order — callers should pre-sort so more
 * specific patterns come before catch-alls. Returns `null` when no pattern
 * matches, so the caller can fall back to a hard navigation (this is how
 * vinext handles routes that exist on the server but are not in the
 * client-side loader map, e.g. dev-only pages).
 */
export function matchPagesPattern(
  pathname: string,
  patterns: readonly string[],
): PagesPatternMatch | null {
  const urlParts = pathname.split("/").filter(Boolean);
  for (const pattern of patterns) {
    const patternParts = routePatternParts(pattern);
    const params = matchRoutePattern(urlParts, patternParts);
    if (params !== null) {
      return { pattern, params };
    }
  }
  return null;
}
