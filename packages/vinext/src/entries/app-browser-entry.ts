import { resolveClientRuntimeModule, resolveRuntimeEntryModule } from "./runtime-entry-module.js";
import type {
  VinextLinkPrefetchRoute,
  VinextPagesLinkPrefetchRoute,
} from "../client/vinext-next-data.js";
import type { AppRoute } from "../routing/app-router.js";
import type { RouteManifest } from "../routing/app-route-graph.js";
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
  const prefetchRoutes: VinextLinkPrefetchRoute[] = routes.map((route) =>
    isLinkPrefetchRoute(route) ? toLinkPrefetchRoute(route) : toDocumentOnlyAppRoute(route),
  );

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
export function isLinkPrefetchRoute(route: AppRoute): boolean {
  if (route.pagePath !== null) return true;
  return route.routePath === null && route.layouts.length > 0;
}

export function toDocumentOnlyAppRoute(route: AppRoute): VinextLinkPrefetchRoute {
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

/** Project an `AppRoute` down to the public `VinextLinkPrefetchRoute` shape. */
export function toLinkPrefetchRoute(route: AppRoute): VinextLinkPrefetchRoute {
  return {
    canPrefetchLoadingShell: route.loadingPath !== null,
    patternParts: [...route.patternParts],
    isDynamic: route.isDynamic,
    ...(requiresDynamicNavigationRequest(route) ? { requiresDynamicNavigationRequest: true } : {}),
  };
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
