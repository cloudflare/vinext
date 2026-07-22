/**
 * App Router file-system routing.
 *
 * Scans the app/ directory following Next.js App Router conventions:
 * - app/page.tsx -> /
 * - app/about/page.tsx -> /about
 * - app/blog/[slug]/page.tsx -> /blog/:slug
 * - app/[...catchAll]/page.tsx -> /:catchAll+
 * - app/route.ts -> / (API route)
 * - app/(group)/page.tsx -> / (route groups are transparent)
 * - Layouts: app/layout.tsx wraps all children
 * - Loading: app/loading.tsx -> Suspense fallback
 * - Error: app/error.tsx -> ErrorBoundary
 * - Not Found: app/not-found.tsx
 */
import { createValidFileMatcher, type ValidFileMatcher } from "./file-matcher.js";
import { createRouteTrieCache, matchRouteWithTrie } from "./route-matching.js";
import {
  buildAppRouteGraph,
  type AppRoute,
  type AppRouteGraphRoute,
  type RouteManifest,
} from "./app-route-graph.js";
export type { AppRoute } from "./app-route-graph.js";
export {
  computeAppRouteStaticSiblings,
  computeRootParamNames,
  convertSegmentsToRouteParts,
} from "./app-route-graph.js";

type AppRouteGraph = {
  routes: AppRouteGraphRoute[];
  routeManifest: RouteManifest;
};

// Cache for app routes
let cachedGraph: AppRouteGraph | null = null;
let cachedAppDir: string | null = null;
let cachedPageExtensionsKey: string | null = null;
let cacheGeneration = 0;

export function invalidateAppRouteCache(): void {
  cacheGeneration++;
  cachedGraph = null;
  cachedAppDir = null;
  cachedPageExtensionsKey = null;
}

/**
 * Scan the app/ directory and return the route graph.
 * TODO(#726): Layer 4 should consume this read model directly once the
 * navigation planner owns route graph facts.
 *
 * @internal
 */
export async function appRouteGraph(
  appDir: string,
  pageExtensions?: readonly string[],
  matcher?: ValidFileMatcher,
): Promise<AppRouteGraph> {
  matcher ??= createValidFileMatcher(pageExtensions);
  const pageExtensionsKey = JSON.stringify(matcher.extensions);
  while (true) {
    if (cachedGraph && cachedAppDir === appDir && cachedPageExtensionsKey === pageExtensionsKey) {
      return cachedGraph;
    }

    const scanGeneration = cacheGeneration;
    const graph = await buildAppRouteGraph(appDir, matcher);
    // A watcher may invalidate while the async filesystem scan is still in
    // flight. Retry instead of returning or caching that obsolete snapshot.
    // Watcher invalidations arrive in finite bursts, so intentionally wait for
    // a quiescent scan rather than bounding retries and publishing stale routes.
    if (scanGeneration !== cacheGeneration) continue;

    cachedGraph = graph;
    cachedAppDir = appDir;
    cachedPageExtensionsKey = pageExtensionsKey;
    return graph;
  }
}

/**
 * Scan the app/ directory and return a list of routes.
 */
export async function appRouter(
  appDir: string,
  pageExtensions?: readonly string[],
  matcher?: ValidFileMatcher,
): Promise<AppRouteGraphRoute[]> {
  const graph = await appRouteGraph(appDir, pageExtensions, matcher);
  return graph.routes;
}

// Trie cache — keyed by route array identity (same array = same trie)
const appTrieCache = createRouteTrieCache<AppRoute>();

/**
 * Match a URL against App Router routes.
 */
export function matchAppRoute(
  url: string,
  routes: AppRoute[],
): { route: AppRoute; params: Record<string, string | string[]> } | null {
  return matchRouteWithTrie(url, routes, appTrieCache);
}
