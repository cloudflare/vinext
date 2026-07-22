import { resolveClientRuntimeModule, resolveRuntimeEntryModule } from "./runtime-entry-module.js";
import type {
  VinextLinkPrefetchRoute,
  VinextPagesLinkPrefetchRoute,
} from "../client/vinext-next-data.js";
import type { AppRoute } from "../routing/app-router.js";
import { patternsStructurallyEquivalent, type RouteManifest } from "../routing/app-route-graph.js";
import type { NextRewrite } from "../config/next-config.js";

/**
 * Generate the virtual browser entry module.
 *
 * This runs in the client (browser). It hydrates the page from the
 * embedded RSC payload and handles client-side navigation by re-fetching
 * RSC streams.
 */
export function generateBrowserEntry(
  routes: readonly AppRoute[] = [],
  routeManifest: RouteManifest | null = null,
  pagesPrefetchRoutes: readonly VinextPagesLinkPrefetchRoute[] = [],
  rewrites: { afterFiles: NextRewrite[]; beforeFiles: NextRewrite[]; fallback: NextRewrite[] } = {
    afterFiles: [],
    beforeFiles: [],
    fallback: [],
  },
): string {
  const entryPath = resolveRuntimeEntryModule("app-browser-entry");
  const navigationRuntimePath = resolveClientRuntimeModule("navigation-runtime");
  const prefetchRoutes = toLinkPrefetchRoutes(routes);

  return `import { registerNavigationRuntimeBootstrap } from ${JSON.stringify(navigationRuntimePath)};

window.__VINEXT_LINK_PREFETCH_ROUTES__ = ${JSON.stringify(prefetchRoutes)};
// Pages route manifest for hybrid ownership decisions. In a hybrid
// app+pages build the user can land on an App page, so the App browser
// entry must also expose the Pages manifest (the Pages client entry does
// the same — whichever entry runs first emits both globals).
window.__VINEXT_PAGES_LINK_PREFETCH_ROUTES__ = ${JSON.stringify(pagesPrefetchRoutes)};
window.__VINEXT_CLIENT_REWRITES__ = ${JSON.stringify(rewrites)};
registerNavigationRuntimeBootstrap({
    routeManifest: ${buildRouteManifestExpression(routeManifest)}
});
import ${JSON.stringify(entryPath)};`;
}

/**
 * Filter for routes that should appear in the `__VINEXT_LINK_PREFETCH_ROUTES__`
 * manifest. Exported so the Pages Router client entry can reuse it when
 * emitting the same manifest for hybrid builds — see issue #1526 and
 * `pages-client-entry.ts`.
 */
function isLinkPrefetchRoute(route: AppRoute): boolean {
  if (route.pagePath !== null) return true;
  return route.routePath === null && route.layouts.length > 0;
}

function toDocumentOnlyAppRoute(route: AppRoute): VinextLinkPrefetchRoute {
  return {
    canPrefetchLoadingShell: false,
    documentOnly: true,
    patternParts: [...route.patternParts],
    isDynamic: route.isDynamic,
  };
}

function requiresDynamicNavigationRequest(route: AppRoute): boolean {
  return route.isDynamic && route.parallelSlots.length > 0;
}

function splitPatternParts(pattern: string): string[] {
  return pattern.split("/").filter(Boolean);
}

function interceptTargetsRoute(interceptTargetPattern: string, route: AppRoute): boolean {
  return patternsStructurallyEquivalent(
    splitPatternParts(interceptTargetPattern),
    route.patternParts,
  );
}

function hasLoadingBoundary(route: AppRoute, hasSiblingInterceptLoading: boolean): boolean {
  return (
    route.loadingPath !== null ||
    (route.loadingPaths?.length ?? 0) > 0 ||
    route.parallelSlots.some(
      (slot) =>
        slot.loadingPath !== null ||
        (slot.loadingPaths?.length ?? 0) > 0 ||
        slot.interceptingRoutes.some(
          (intercept) =>
            interceptTargetsRoute(intercept.targetPattern, route) &&
            (intercept.loadingPaths?.length ?? 0) > 0,
        ),
    ) ||
    hasSiblingInterceptLoading
  );
}

/** Project an `AppRoute` down to the public `VinextLinkPrefetchRoute` shape. */
export function toLinkPrefetchRoute(
  route: AppRoute,
  hasSiblingInterceptLoading = route.siblingIntercepts.some(
    (intercept) =>
      interceptTargetsRoute(intercept.targetPattern, route) &&
      (intercept.loadingPaths?.length ?? 0) > 0,
  ),
): VinextLinkPrefetchRoute {
  return {
    canPrefetchLoadingShell: hasLoadingBoundary(route, hasSiblingInterceptLoading),
    patternParts: [...route.patternParts],
    isDynamic: route.isDynamic,
    ...(requiresDynamicNavigationRequest(route) ? { requiresDynamicNavigationRequest: true } : {}),
  };
}

/** Project App routes together so sibling-intercept loading is applied to its target route. */
export function toLinkPrefetchRoutes(routes: readonly AppRoute[]): VinextLinkPrefetchRoute[] {
  const siblingInterceptLoadingTargets: string[][] = [];
  for (const route of routes) {
    for (const intercept of route.siblingIntercepts) {
      if ((intercept.loadingPaths?.length ?? 0) > 0) {
        siblingInterceptLoadingTargets.push(splitPatternParts(intercept.targetPattern));
      }
    }
  }

  return routes.map((route) =>
    isLinkPrefetchRoute(route)
      ? toLinkPrefetchRoute(
          route,
          siblingInterceptLoadingTargets.some((targetParts) =>
            patternsStructurallyEquivalent(targetParts, route.patternParts),
          ),
        )
      : toDocumentOnlyAppRoute(route),
  );
}

function buildRouteManifestExpression(routeManifest: RouteManifest | null): string {
  if (routeManifest === null) return "null";

  const graph = routeManifest.segmentGraph;
  return `{
  graphVersion: ${JSON.stringify(routeManifest.graphVersion)},
  segmentGraph: {
    routes: ${buildMapExpression(graph.routes)},
    pages: ${buildMapExpression(graph.pages)},
    routeHandlers: ${buildMapExpression(graph.routeHandlers)},
    layouts: ${buildMapExpression(graph.layouts)},
    templates: ${buildMapExpression(graph.templates)},
    slots: ${buildMapExpression(graph.slots)},
    defaults: ${buildMapExpression(graph.defaults)},
    slotBindings: ${buildMapExpression(graph.slotBindings)},
    interceptions: ${buildMapExpression(graph.interceptions)},
    interceptionsBySlotId: ${buildMapExpression(graph.interceptionsBySlotId)},
    boundaries: ${buildMapExpression(graph.boundaries)},
    rootBoundaries: ${buildMapExpression(graph.rootBoundaries)}
  }
}`;
}

function buildMapExpression<Key extends string, Value>(map: ReadonlyMap<Key, Value>): string {
  return `new Map(${JSON.stringify(Array.from(map.entries()))})`;
}
