import { matchesRewriteSource, rewriteSourceForDestination } from "../config/config-matchers.js";
import type { ResolvedNextConfig } from "../config/next-config.js";
import type { AppRoute } from "../routing/app-router.js";

type RewriteSourceConfig = Pick<ResolvedNextConfig, "basePath" | "i18n" | "rewrites">;
type RouteOwner = Pick<AppRoute, "pattern" | "isDynamic">;

/**
 * Public pathnames that a next.config rewrite can resolve to the page at
 * `pagePathname`. The prerender asks the request handler about each of them.
 *
 * This list is a set of candidates, not a routing decision. Only the request
 * handler knows how a URL resolves. It renders a candidate only when a rewrite
 * resolves it to the page, and refuses it before any other owner of the URL
 * runs (see `readRewriteSourceProbe`). A wrong candidate costs one refused
 * request. The rules below leave out the candidates that the config shows the
 * handler would refuse or would never read at runtime:
 *
 * - A rule with `has` / `missing` is not inverted, and an earlier rule whose
 *   source matches the pathname can take the request, with or without
 *   conditions. The rule must be the first rule that matches.
 * - An `afterFiles` rule cannot take a pathname that a route without params
 *   owns. It runs before dynamic routes, so those do not matter.
 * - A `fallback` rule runs after dynamic routes. This module cannot tell which
 *   pathnames they match, so `fallback` rules give no pathnames.
 * - With `i18n`, a pathname has locale forms that this module does not model.
 */
export function collectRewriteSourcePathnames(
  pagePathname: string,
  config: RewriteSourceConfig,
  routes: readonly RouteOwner[],
): string[] {
  if (config.i18n) return [];

  const { beforeFiles, afterFiles } = config.rewrites;
  const rules = [...beforeFiles, ...afterFiles];
  // The build requests every URL below basePath.
  const basePathState = { basePath: config.basePath, hadBasePath: true };
  const ownedByNonDynamicRoute = (pathname: string) =>
    routes.some((route) => !route.isDynamic && route.pattern === pathname);

  const sourcePathnames: string[] = [];
  for (const rule of rules) {
    const sourcePathname = rewriteSourceForDestination(rule, pagePathname);
    if (sourcePathname === null) continue;
    if (
      rules.find((other) => matchesRewriteSource(sourcePathname, other, basePathState)) !== rule
    ) {
      continue;
    }
    if (afterFiles.includes(rule) && ownedByNonDynamicRoute(sourcePathname)) continue;
    sourcePathnames.push(sourcePathname);
  }
  return sourcePathnames;
}

/**
 * The rewrite source URLs to render for a list of prerendered pages.
 *
 * The source pathname names the artifact files. On a file system that ignores
 * letter case, two source pathnames that differ only by case share one file,
 * so only the first of them is rendered.
 */
export function collectRewriteSources<Page extends { urlPath: string }>(
  pages: readonly Page[],
  config: RewriteSourceConfig,
  routes: readonly RouteOwner[],
): Array<{ page: Page; sourcePathname: string }> {
  const sources: Array<{ page: Page; sourcePathname: string }> = [];
  const foldedPathnames = new Set<string>();
  for (const page of pages) {
    for (const sourcePathname of collectRewriteSourcePathnames(page.urlPath, config, routes)) {
      const foldedPathname = sourcePathname.toLowerCase();
      if (foldedPathnames.has(foldedPathname)) continue;
      foldedPathnames.add(foldedPathname);
      sources.push({ page, sourcePathname });
    }
  }
  return sources;
}
