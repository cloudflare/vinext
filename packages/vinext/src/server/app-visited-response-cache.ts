import { resolveCachedRscResponseExpiresAt, type CachedRscResponse } from "vinext/shims/navigation";
import { AppElementsWire, type AppElements } from "./app-elements.js";
import { parseRscRequestPath, stripRscCacheBustingSearchParam } from "./app-rsc-cache-busting.js";

type VisitedResponseCacheNavigationKind = "navigate" | "refresh" | "traverse";

export type VisitedResponseCacheEntry = {
  createdAt: number;
  elements?: AppElements;
  expiresAt: number;
  mountedSlotsHeader: string | null;
  /**
   * A history restore revoked navigation reuse. The entry stays only as the
   * BFCache that a full prefetch reads (see `findVisitedResponseForFullPrefetch`).
   */
  navigationReuseRevoked?: true;
  params: Record<string, string | string[]>;
  response: CachedRscResponse;
  reuseAfterHistoryRestore: boolean;
};

export const VISITED_RESPONSE_CACHE_TTL = 5 * 60_000;
export const MAX_TRAVERSAL_CACHE_TTL = 30 * 60_000;

export function hasNavigationResponseHistoryLifetime(snapshot: CachedRscResponse): boolean {
  const dynamicStaleTime =
    snapshot.completedDynamicStaleTimeSeconds ?? snapshot.dynamicStaleTimeSeconds;
  return dynamicStaleTime !== undefined
    ? dynamicStaleTime > 0
    : snapshot.serverStaleTime !== undefined;
}

export function createVisitedResponseCacheEntry(options: {
  elements?: AppElements;
  fallbackTtlMs?: number;
  now: number;
  mountedSlotsHeader?: string | null;
  params: Record<string, string | string[]>;
  response: CachedRscResponse;
  reuseAfterHistoryRestore?: boolean;
}): VisitedResponseCacheEntry {
  return {
    createdAt: options.now,
    ...(options.elements ? { elements: options.elements } : {}),
    expiresAt: resolveCachedRscResponseExpiresAt(
      options.now,
      options.response,
      options.fallbackTtlMs ?? VISITED_RESPONSE_CACHE_TTL,
    ),
    mountedSlotsHeader: options.mountedSlotsHeader ?? null,
    params: options.params,
    response: options.response,
    reuseAfterHistoryRestore: options.reuseAfterHistoryRestore === true,
  };
}

export function isVisitedResponseCacheEntryFresh(
  entry: VisitedResponseCacheEntry,
  options: {
    navigationKind: VisitedResponseCacheNavigationKind;
    now: number;
  },
): boolean {
  if (options.navigationKind === "refresh") {
    return false;
  }

  if (options.navigationKind === "traverse") {
    return options.now - entry.createdAt < MAX_TRAVERSAL_CACHE_TTL;
  }

  return entry.expiresAt > options.now;
}

function normalizeVisitedResponseCacheLookupUrl(rscUrl: string): string | null {
  try {
    const url = parseRscRequestPath(rscUrl);
    stripRscCacheBustingSearchParam(url);
    return `${url.pathname}${url.search}`;
  } catch {
    return null;
  }
}

function parseVisitedResponseCacheKey(cacheKey: string): {
  interceptionContext: string | null;
  rscUrl: string;
} {
  const separatorIndex = cacheKey.indexOf("\0");
  if (separatorIndex === -1) {
    return { interceptionContext: null, rscUrl: cacheKey };
  }
  return {
    interceptionContext: cacheKey.slice(separatorIndex + 1),
    rscUrl: cacheKey.slice(0, separatorIndex),
  };
}

export function findVisitedResponseCacheEntry(
  cache: Map<string, VisitedResponseCacheEntry>,
  rscUrl: string,
  interceptionContext: string | null,
): { cacheKey: string; entry: VisitedResponseCacheEntry } | null {
  const exactCacheKey = AppElementsWire.encodeCacheKey(rscUrl, interceptionContext);
  const exactEntry = cache.get(exactCacheKey);
  if (exactEntry) {
    return { cacheKey: exactCacheKey, entry: exactEntry };
  }

  const normalizedTarget = normalizeVisitedResponseCacheLookupUrl(rscUrl);
  if (normalizedTarget === null) return null;

  for (const [cacheKey, entry] of cache) {
    const source = parseVisitedResponseCacheKey(cacheKey);
    if (source.interceptionContext !== interceptionContext) continue;
    if (normalizeVisitedResponseCacheLookupUrl(source.rscUrl) !== normalizedTarget) continue;
    return { cacheKey, entry };
  }

  return null;
}

export function deleteVisitedResponseCacheEntry(
  cache: Map<string, VisitedResponseCacheEntry>,
  rscUrl: string,
  interceptionContext: string | null,
): boolean {
  const match = findVisitedResponseCacheEntry(cache, rscUrl, interceptionContext);
  if (!match) return false;
  return cache.delete(match.cacheKey);
}

export function deleteAllVisitedResponseCacheEntries(
  cache: Map<string, VisitedResponseCacheEntry>,
  rscUrl: string,
  interceptionContext: string | null,
): number {
  let deleted = 0;
  while (deleteVisitedResponseCacheEntry(cache, rscUrl, interceptionContext)) {
    deleted++;
  }
  return deleted;
}

export function revokeHistoryRestoreNavigationReuse(
  cache: Map<string, VisitedResponseCacheEntry>,
): void {
  for (const entry of cache.values()) {
    if (entry.reuseAfterHistoryRestore) continue;
    entry.navigationReuseRevoked = true;
  }
}

/**
 * Next.js fulfills a full prefetch from the BFCache, which holds the data of
 * every navigation, while it is within the static stale time of that
 * navigation (`attemptToFulfillDynamicSegmentFromBFCache`). Navigation reuse
 * that a history restore revoked does not matter here. A navigation that
 * committed a prefetched payload dates from when that payload arrived.
 *
 * The match follows direct visited reuse: an entry with committed elements
 * replays them, because its raw response may be skip-pruned against the tree
 * it was requested from; otherwise the request-time or response-declared slot
 * context must match.
 */
export function findVisitedResponseForFullPrefetch(
  cache: Map<string, VisitedResponseCacheEntry>,
  rscUrls: readonly string[],
  interceptionContext: string | null,
  mountedSlotsHeader: string | null,
): { navigatedAt: number; response: CachedRscResponse } | null {
  for (const rscUrl of rscUrls) {
    const match = findVisitedResponseCacheEntry(cache, rscUrl, interceptionContext);
    if (match === null) continue;
    const { entry } = match;
    if (
      entry.elements === undefined &&
      entry.mountedSlotsHeader !== mountedSlotsHeader &&
      (entry.response.mountedSlotsHeader ?? null) !== mountedSlotsHeader
    ) {
      continue;
    }
    return {
      navigatedAt: entry.response.receivedAt ?? entry.createdAt,
      response:
        entry.elements === undefined
          ? entry.response
          : { ...entry.response, preparedElements: entry.elements },
    };
  }
  return null;
}
