import { appRouter, type AppRoute } from "../routing/app-router.js";
import { apiRouter, pagesRouter, type Route } from "../routing/pages-router.js";
import { buildReportRows, type RouteRow } from "./report.js";

// Mirrors Nitro's NitroRouteConfig — hand-rolled because nitropack is not a direct dependency.
export type NitroRouteRuleConfig = Record<string, unknown> & {
  swr?: boolean | number;
  cache?: unknown;
  static?: boolean;
  isr?: boolean | number;
  prerender?: boolean;
};

export type NitroRouteRules = Record<string, { swr: number }>;

/**
 * Scans the filesystem for route files and generates Nitro `routeRules` for ISR routes.
 *
 * Note: this duplicates the filesystem scanning that `printBuildReport` also performs.
 * The `nitro.setup` hook runs during Nitro initialization (before the build), while
 * `printBuildReport` runs after the build, so sharing results is non-trivial. This is
 * a future optimization target.
 *
 * Unlike `printBuildReport`, this path does not receive `prerenderResult`, so routes
 * classified as `unknown` by static analysis (which `printBuildReport` might upgrade
 * to `static` via speculative prerender) are skipped here.
 */
export async function collectNitroRouteRules(options: {
  appDir?: string | null;
  pagesDir?: string | null;
  pageExtensions: string[];
}): Promise<NitroRouteRules> {
  const { appDir, pageExtensions, pagesDir } = options;

  let appRoutes: AppRoute[] = [];
  let pageRoutes: Route[] = [];
  let apiRoutes: Route[] = [];

  if (appDir) {
    appRoutes = await appRouter(appDir, pageExtensions);
  }

  if (pagesDir) {
    const [pages, apis] = await Promise.all([
      pagesRouter(pagesDir, pageExtensions),
      apiRouter(pagesDir, pageExtensions),
    ]);
    pageRoutes = pages;
    apiRoutes = apis;
  }

  return generateNitroRouteRules(buildReportRows({ appRoutes, pageRoutes, apiRoutes }));
}

export function generateNitroRouteRules(rows: RouteRow[]): NitroRouteRules {
  const rules: NitroRouteRules = {};

  for (const row of rows) {
    if (
      row.type === "isr" &&
      typeof row.revalidate === "number" &&
      Number.isFinite(row.revalidate) &&
      row.revalidate > 0
    ) {
      rules[convertToNitroPattern(row.pattern)] = { swr: row.revalidate };
    }
  }

  return rules;
}

/**
 * Converts vinext's internal `:param` route syntax to Nitro's `/**` glob
 * pattern format. Nitro's `routeRules` use radix3's `toRouteMatcher` which
 * documents exact paths and `/**` globs, not `:param` segments.
 *
 *   /blog/:slug   -> /blog/**
 *   /docs/:slug+  -> /docs/**
 *   /docs/:slug*  -> /docs/**
 *   /about        -> /about  (unchanged)
 */
export function convertToNitroPattern(pattern: string): string {
  return pattern.replace(/\/:([a-zA-Z_][a-zA-Z0-9_-]*)([+*]?)(\/|$)/g, "/**$3");
}

export function mergeNitroRouteRules(
  existingRouteRules: Record<string, NitroRouteRuleConfig> | undefined,
  generatedRouteRules: NitroRouteRules,
): {
  routeRules: Record<string, NitroRouteRuleConfig>;
  skippedRoutes: string[];
} {
  const routeRules = { ...existingRouteRules };
  const skippedRoutes: string[] = [];

  for (const [route, generatedRule] of Object.entries(generatedRouteRules)) {
    const existingRule = routeRules[route];

    if (existingRule && hasUserDefinedCacheRule(existingRule)) {
      skippedRoutes.push(route);
      continue;
    }

    routeRules[route] = {
      ...existingRule,
      ...generatedRule,
    };
  }

  return { routeRules, skippedRoutes };
}

function hasUserDefinedCacheRule(rule: NitroRouteRuleConfig): boolean {
  return (
    rule.swr !== undefined ||
    rule.cache !== undefined ||
    rule.static !== undefined ||
    rule.isr !== undefined ||
    rule.prerender !== undefined
  );
}
