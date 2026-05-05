/**
 * Shared route-match preamble used by both Pages Router and App Router.
 *
 * Both routers normalize URLs and call `trieMatch` with nearly-identical
 * preamble: strip query, trailing-slash normalize, run
 * `normalizePathnameForRouteMatch`, split into url parts, then look up via a
 * per-routes-array trie cache. This module factors that out so each router
 * just calls `matchRouteWithTrie(url, routes)`.
 */
import { normalizePathnameForRouteMatch } from "./utils.js";
import { buildRouteTrie, trieMatch, type TrieNode } from "./route-trie.js";

// Trie cache — keyed by route array identity (same array = same trie).
// Each caller gets its own cache via `createRouteTrieCache()`, so different
// route shapes (Pages routes vs App routes) don't share a cache slot.
type RouteTrieCache<R extends { patternParts: string[] }> = WeakMap<R[], TrieNode<R>>;

export function createRouteTrieCache<R extends { patternParts: string[] }>(): RouteTrieCache<R> {
  return new WeakMap<R[], TrieNode<R>>();
}

function getOrBuildTrie<R extends { patternParts: string[] }>(
  cache: RouteTrieCache<R>,
  routes: R[],
): TrieNode<R> {
  let trie = cache.get(routes);
  if (!trie) {
    trie = buildRouteTrie(routes);
    cache.set(routes, trie);
  }
  return trie;
}

/**
 * Match a URL path against a list of routes via the shared preamble:
 *   1. strip query string
 *   2. trailing-slash normalize (preserving root "/")
 *   3. run `normalizePathnameForRouteMatch`
 *   4. split into url parts and look up via the (cached) trie
 *
 * Generic over the route shape; both Pages `Route` and App `AppRoute`
 * satisfy `{ patternParts: string[] }`.
 */
export function matchRouteWithTrie<R extends { patternParts: string[] }>(
  url: string,
  routes: R[],
  cache: RouteTrieCache<R>,
): { route: R; params: Record<string, string | string[]> } | null {
  // Normalize: strip query string and trailing slash
  const pathname = url.split("?")[0];
  let normalizedUrl = pathname === "/" ? "/" : pathname.replace(/\/$/, "");
  normalizedUrl = normalizePathnameForRouteMatch(normalizedUrl);

  // Split URL once, look up via trie
  const urlParts = normalizedUrl.split("/").filter(Boolean);
  const trie = getOrBuildTrie(cache, routes);
  return trieMatch(trie, urlParts);
}
