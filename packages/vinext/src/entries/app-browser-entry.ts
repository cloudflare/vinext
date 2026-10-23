import { resolveClientRuntimeModule, resolveRuntimeEntryModule } from "./runtime-entry-module.js";
import type {
  VinextLinkPrefetchIntercept,
  VinextLinkPrefetchRoute,
  VinextPagesLinkPrefetchRoute,
} from "../client/vinext-next-data.js";
import { toClientRewrites } from "../client/client-rewrites.js";
import type { AppRoute } from "../routing/app-router.js";
import { patternsStructurallyEquivalent, type RouteManifest } from "../routing/app-route-graph.js";
import { toBrowserRouteManifestWire } from "../routing/browser-route-manifest.js";
import { hashRoutePatternParts } from "../routing/hashed-route-patterns.js";
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
  pagesPrefetchRoutes: readonly VinextPagesLinkPrefetchRoute[] = [],
  rewrites: { afterFiles: NextRewrite[]; beforeFiles: NextRewrite[]; fallback: NextRewrite[] } = {
    afterFiles: [],
    beforeFiles: [],
    fallback: [],
  },
  locales: readonly string[] = [],
  classifier?: AppRouteDynamicRenderClassifier,
): string {
  const entryPath = resolveRuntimeEntryModule("app-browser-entry");
  const reactInstanceBootstrapPath = resolveClientRuntimeModule("react-instance-bootstrap");
  const prefetchRoutes = toLinkPrefetchRoutes(routes, classifier);
  // Route handlers only feed hybrid App/Pages ownership. An App-only client
  // learns a handler URL from its non-Flight response (a prefetch miss, then a
  // document navigation), like Next.js, so it gets none (issue #3624).
  const routeHandlers = pagesPrefetchRoutes.length > 0 ? toHashedRouteHandlerRoutes(routes) : [];
  const clientRewrites = toClientRewrites(rewrites);

  return `import ${JSON.stringify(reactInstanceBootstrapPath)};

window.__VINEXT_LINK_PREFETCH_ROUTES__ = ${JSON.stringify(prefetchRoutes)};
window.__VINEXT_APP_ROUTE_HANDLERS__ = ${JSON.stringify(routeHandlers)};
// Pages route manifest for hybrid ownership decisions. In a hybrid
// app+pages build the user can land on an App page, so the App browser
// entry must also expose the Pages manifest (the Pages client entry does
// the same — whichever entry runs first emits both globals).
window.__VINEXT_PAGES_LINK_PREFETCH_ROUTES__ = ${JSON.stringify(pagesPrefetchRoutes)};
window.__VINEXT_CLIENT_REWRITES__ = ${JSON.stringify(clientRewrites)};
window.__VINEXT_LOCALES__ = ${JSON.stringify(locales)};
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

/**
 * App route handlers for hybrid App/Pages ownership, with their static
 * segments hashed so the client never receives their paths in plain text.
 */
export function toHashedRouteHandlerRoutes(routes: readonly AppRoute[]): VinextLinkPrefetchRoute[] {
  return routes.flatMap((route) =>
    isLinkPrefetchRoute(route)
      ? []
      : [
          {
            canPrefetchLoadingShell: false,
            documentOnly: true,
            isDynamic: route.isDynamic,
            patternParts: hashRoutePatternParts(route.patternParts),
          },
        ],
  );
}

function requiresDynamicNavigationRequest(route: AppRoute): boolean {
  return route.isDynamic && route.parallelSlots.length > 0;
}

function splitPatternParts(pattern: string): string[] {
  return pattern.split("/").filter(Boolean);
}

type AppRouteIntercept = AppRoute["siblingIntercepts"][number];

/** Reads, at build time, which App pages Next.js renders on every request. */
export type AppRouteDynamicRenderClassifier = {
  route(route: AppRoute): boolean;
  /**
   * `layoutPaths` holds the layouts above the intercepting page outside its
   * own branch: the source route's, and the slot's.
   */
  intercept(intercept: AppRouteIntercept, layoutPaths: readonly string[]): boolean;
};

function interceptTargetsRoute(interceptTargetPattern: string, route: AppRoute): boolean {
  return patternsStructurallyEquivalent(
    splitPatternParts(interceptTargetPattern),
    route.patternParts,
  );
}

function hasLoadingBoundary(route: AppRoute, hasSiblingInterceptLoading: boolean): boolean {
  return (
    route.loadingPath !== null ||
    (route.loadingPaths?.some((_, index) => (route.loadingTreePositions?.[index] ?? 0) > 0) ??
      false) ||
    // Position 0 is already shared only for the main route tree. For a parallel
    // slot or intercepted subtree it is that subtree's local root and must
    // still be advertised as a loading shell.
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
  rendersDynamically = false,
): VinextLinkPrefetchRoute {
  return {
    canPrefetchLoadingShell: hasLoadingBoundary(route, hasSiblingInterceptLoading),
    patternParts: [...route.patternParts],
    isDynamic: route.isDynamic,
    ...(rendersDynamically ? { rendersDynamically: true } : {}),
    ...(requiresDynamicNavigationRequest(route) ? { requiresDynamicNavigationRequest: true } : {}),
    ...((route.rootParamNames?.length ?? 0) > 0 ? { hasRootParams: true } : {}),
  };
}

/**
 * Project App routes together so sibling-intercept loading is applied to its
 * target route. `classifier` reads each route's segment config, and each
 * intercepting page's, which applies to its target route.
 */
export function toLinkPrefetchRoutes(
  routes: readonly AppRoute[],
  classifier?: AppRouteDynamicRenderClassifier,
): VinextLinkPrefetchRoute[] {
  const siblingInterceptLoadingTargets: string[][] = [];
  for (const route of routes) {
    for (const intercept of route.siblingIntercepts) {
      if ((intercept.loadingPaths?.length ?? 0) > 0) {
        siblingInterceptLoadingTargets.push(splitPatternParts(intercept.targetPattern));
      }
    }
  }
  const intercepts = classifier ? collectClassifiedIntercepts(routes, classifier) : [];

  return routes.filter(isLinkPrefetchRoute).map((route) => {
    const prefetchRoute = toLinkPrefetchRoute(
      route,
      siblingInterceptLoadingTargets.some((targetParts) =>
        patternsStructurallyEquivalent(targetParts, route.patternParts),
      ),
      classifier?.route(route) ?? false,
    );
    const routeIntercepts = intercepts
      .filter(({ targetParts }) => patternsStructurallyEquivalent(targetParts, route.patternParts))
      .map(({ intercept }) => intercept);
    return routeIntercepts.length > 0
      ? { ...prefetchRoute, intercepts: routeIntercepts }
      : prefetchRoute;
  });
}

/**
 * Every intercepting page once, with its classification. A slot's intercepts
 * are listed on each route that shares the slot.
 */
function collectClassifiedIntercepts(
  routes: readonly AppRoute[],
  classifier: AppRouteDynamicRenderClassifier,
): { intercept: VinextLinkPrefetchIntercept; targetParts: string[] }[] {
  const seen = new Set<string>();
  const results: { intercept: VinextLinkPrefetchIntercept; targetParts: string[] }[] = [];
  const add = (intercept: AppRouteIntercept, layoutPaths: readonly string[]) => {
    const key = `${intercept.sourceMatchPattern}\0${intercept.pagePath}`;
    if (seen.has(key)) return;
    seen.add(key);
    const rendersDynamically = classifier.intercept(intercept, [
      ...layoutPaths,
      ...intercept.layoutPaths,
    ]);
    results.push({
      intercept: {
        sourcePatternParts: splitPatternParts(intercept.sourceMatchPattern),
        ...(rendersDynamically ? { rendersDynamically: true } : {}),
      },
      targetParts: splitPatternParts(intercept.targetPattern),
    });
  };
  for (const route of routes) {
    for (const slot of route.parallelSlots) {
      const slotLayoutPaths = slot.layoutPath ? [...route.layouts, slot.layoutPath] : route.layouts;
      for (const intercept of slot.interceptingRoutes) add(intercept, slotLayoutPaths);
    }
    for (const intercept of route.siblingIntercepts) add(intercept, route.layouts);
  }
  return results;
}

/**
 * Generate the virtual module that holds the browser RouteManifest.
 *
 * The App browser runtime imports it dynamically when hydration starts, so the
 * manifest, which grows with every route, stays out of the entry chunk. The
 * JSON string keeps the parse on V8's fast JSON path.
 */
export function generateBrowserRouteManifestModule(routeManifest: RouteManifest | null): string {
  if (routeManifest === null) return "export default null;";
  return `export default JSON.parse(${JSON.stringify(
    JSON.stringify(toBrowserRouteManifestWire(routeManifest)),
  )});`;
}
