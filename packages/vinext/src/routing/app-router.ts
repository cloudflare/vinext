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
import { normalizePathnameForRouteMatch } from "./utils.js";
import { createValidFileMatcher, type ValidFileMatcher } from "./file-matcher.js";
import { buildRouteTrie, trieMatch, type TrieNode } from "./route-trie.js";
import { buildAppRouteGraph, type AppRoute, type AppRouteGraphRoute } from "./app-route-graph.js";
export type { AppRoute } from "./app-route-graph.js";
export { computeRootParamNames } from "./app-route-graph.js";

// Cache for app routes
let cachedRoutes: AppRouteGraphRoute[] | null = null;
let cachedAppDir: string | null = null;
let cachedPageExtensionsKey: string | null = null;

export function invalidateAppRouteCache(): void {
  cachedRoutes = null;
  cachedAppDir = null;
  cachedPageExtensionsKey = null;
}

/**
 * Scan the app/ directory and return a list of routes.
 */
export async function appRouter(
  appDir: string,
  pageExtensions?: readonly string[],
  matcher?: ValidFileMatcher,
): Promise<AppRouteGraphRoute[]> {
  matcher ??= createValidFileMatcher(pageExtensions);
  const pageExtensionsKey = JSON.stringify(matcher.extensions);
  if (cachedRoutes && cachedAppDir === appDir && cachedPageExtensionsKey === pageExtensionsKey) {
    return cachedRoutes;
  }

  const graph = await buildAppRouteGraph(appDir, matcher);
  cachedRoutes = graph.routes;
  cachedAppDir = appDir;
  cachedPageExtensionsKey = pageExtensionsKey;
  return graph.routes;
}

// Trie cache — keyed by route array identity (same array = same trie)
const appTrieCache = new WeakMap<AppRoute[], TrieNode<AppRoute>>();

function getOrBuildAppTrie(routes: AppRoute[]): TrieNode<AppRoute> {
  let trie = appTrieCache.get(routes);
  if (!trie) {
    trie = buildRouteTrie(routes);
    appTrieCache.set(routes, trie);
  }
  return trie;
}

/**
 * Match a URL against App Router routes.
 */
export function matchAppRoute(
  url: string,
  routes: AppRoute[],
): { route: AppRoute; params: Record<string, string | string[]> } | null {
  const pathname = url.split("?")[0];
  let normalizedUrl = pathname === "/" ? "/" : pathname.replace(/\/$/, "");
  normalizedUrl = normalizePathnameForRouteMatch(normalizedUrl);

  // Split URL once, look up via trie
  const urlParts = normalizedUrl.split("/").filter(Boolean);
  const trie = getOrBuildAppTrie(routes);
  return trieMatch(trie, urlParts);
}
