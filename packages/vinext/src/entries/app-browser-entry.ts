import { resolveClientRuntimeModule, resolveRuntimeEntryModule } from "./runtime-entry-module.js";
import type { VinextLinkPrefetchRoute } from "../client/vinext-next-data.js";
import type { AppRoute } from "../routing/app-router.js";
import type { RouteManifest } from "../routing/app-route-graph.js";

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
): string {
  const entryPath = resolveRuntimeEntryModule("app-browser-entry");
  const navigationRuntimePath = resolveClientRuntimeModule("navigation-runtime");
  const prefetchRoutes: VinextLinkPrefetchRoute[] = routes
    .filter((route) => isLinkPrefetchRoute(route))
    .map((route) => ({
      canPrefetchLoadingShell: route.loadingPath !== null,
      patternParts: [...route.patternParts],
      isDynamic: route.isDynamic,
    }));

  return `import { registerNavigationRuntimeBootstrap } from ${JSON.stringify(navigationRuntimePath)};

window.__VINEXT_LINK_PREFETCH_ROUTES__ = ${JSON.stringify(prefetchRoutes)};
registerNavigationRuntimeBootstrap({
    routeManifest: ${buildRouteManifestExpression(routeManifest)}
});
import ${JSON.stringify(entryPath)};`;
}

function isLinkPrefetchRoute(route: AppRoute): boolean {
  if (route.pagePath !== null) return true;
  return route.routePath === null && route.layouts.length > 0;
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
