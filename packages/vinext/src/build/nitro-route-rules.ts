import { appRouter, type AppRoute } from "../routing/app-router.js";
import { apiRouter, pagesRouter, type Route } from "../routing/pages-router.js";
import { buildReportRows, type RouteRow } from "./report.js";

export type NitroRouteRuleConfig = Record<string, unknown> & {
  swr?: boolean | number;
  cache?: unknown;
  static?: boolean;
  isr?: boolean | number;
  prerender?: boolean;
};

export type NitroRouteRules = Record<string, { swr: number }>;

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
      rules[row.pattern] = { swr: row.revalidate };
    }
  }

  return rules;
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
