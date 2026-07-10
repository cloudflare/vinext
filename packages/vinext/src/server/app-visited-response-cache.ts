import {
  PREFETCH_CACHE_TTL,
  resolveCachedRscResponseExpiresAt,
  type CachedRscResponse,
} from "vinext/shims/navigation";
import { AppElementsWire, type AppElements } from "./app-elements.js";
import { stripRscCacheBustingSearchParam } from "./app-rsc-cache-busting.js";

type VisitedResponseCacheNavigationKind = "navigate" | "prefetch" | "refresh" | "traverse";

export type VisitedResponseCacheEntry = {
  createdAt: number;
  elements?: AppElements;
  expiresAt: number;
  mountedSlotsHeader: string | null;
  params: Record<string, string | string[]>;
  response: CachedRscResponse;
};

export const VISITED_RESPONSE_CACHE_TTL = 5 * 60_000;
export const MAX_TRAVERSAL_CACHE_TTL = 30 * 60_000;
export const visitedResponseCache = new Map<string, VisitedResponseCacheEntry>();

type VisitedResponseCacheLookupOptions = {
  mountedSlotsHeader?: string | null;
  isEntryCompatible?: (
    entry: VisitedResponseCacheEntry,
    mountedSlotsHeader: string | null,
  ) => boolean;
};

export function createVisitedResponseCacheEntry(options: {
  elements?: AppElements;
  fallbackTtlMs?: number;
  now: number;
  mountedSlotsHeader?: string | null;
  params: Record<string, string | string[]>;
  response: CachedRscResponse;
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

  if (options.navigationKind === "prefetch") {
    return options.now <= entry.createdAt + PREFETCH_CACHE_TTL;
  }

  return entry.expiresAt > options.now;
}

export function clearVisitedResponseCache(): void {
  visitedResponseCache.clear();
}

function normalizeVisitedResponseCacheLookupUrl(rscUrl: string): string | null {
  try {
    const url = new URL(rscUrl, "http://vinext.local");
    stripRscCacheBustingSearchParam(url);
    return `${url.pathname}${url.search}`;
  } catch {
    return null;
  }
}

export function findVisitedResponseCacheEntry(
  cache: Map<string, VisitedResponseCacheEntry>,
  rscUrl: string,
  interceptionContext: string | null,
  options: VisitedResponseCacheLookupOptions = {},
): { cacheKey: string; entry: VisitedResponseCacheEntry } | null {
  const exactCacheKey = AppElementsWire.encodeCacheKey(rscUrl, interceptionContext);
  const exactEntry = cache.get(exactCacheKey);
  if (exactEntry) {
    return { cacheKey: exactCacheKey, entry: exactEntry };
  }

  const normalizedTarget = normalizeVisitedResponseCacheLookupUrl(rscUrl);
  if (normalizedTarget === null) return null;

  for (const [cacheKey, entry] of cache) {
    const source = AppElementsWire.decodeCacheKey(cacheKey);
    if (source === null) continue;
    if (source.interceptionContext !== interceptionContext) continue;
    if (normalizeVisitedResponseCacheLookupUrl(source.rscUrl) !== normalizedTarget) continue;
    if (
      options.mountedSlotsHeader !== undefined &&
      options.isEntryCompatible !== undefined &&
      !options.isEntryCompatible(entry, options.mountedSlotsHeader)
    ) {
      continue;
    }
    return { cacheKey, entry };
  }

  return null;
}

export function deleteVisitedResponseCacheEntry(
  cache: Map<string, VisitedResponseCacheEntry>,
  rscUrl: string,
  interceptionContext: string | null,
  options: VisitedResponseCacheLookupOptions = {},
): boolean {
  const match = findVisitedResponseCacheEntry(cache, rscUrl, interceptionContext, options);
  if (!match) return false;
  return cache.delete(match.cacheKey);
}

export function isVisitedResponseCacheEntryCompatibleForNavigation(
  entry: VisitedResponseCacheEntry,
  mountedSlotsHeader: string | null,
): boolean {
  return entry.mountedSlotsHeader === mountedSlotsHeader;
}

export function isVisitedResponseCacheEntryCompatibleForPrefetch(
  entry: VisitedResponseCacheEntry,
  mountedSlotsHeader: string | null,
): boolean {
  return entry.elements !== undefined || entry.mountedSlotsHeader === mountedSlotsHeader;
}

export function claimVisitedResponseCacheEntryForPrefetch(
  rscUrl: string,
  interceptionContext: string | null,
  mountedSlotsHeader: string | null,
): boolean {
  const match = findVisitedResponseCacheEntry(visitedResponseCache, rscUrl, interceptionContext, {
    mountedSlotsHeader,
    isEntryCompatible: isVisitedResponseCacheEntryCompatibleForPrefetch,
  });
  if (!match) return false;

  if (
    !isVisitedResponseCacheEntryFresh(match.entry, {
      navigationKind: "prefetch",
      now: Date.now(),
    })
  ) {
    visitedResponseCache.delete(match.cacheKey);
    return false;
  }

  if (!isVisitedResponseCacheEntryCompatibleForPrefetch(match.entry, mountedSlotsHeader)) {
    return false;
  }

  visitedResponseCache.delete(match.cacheKey);
  visitedResponseCache.set(match.cacheKey, match.entry);
  return true;
}
