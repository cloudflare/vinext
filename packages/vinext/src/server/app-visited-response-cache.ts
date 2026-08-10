import { resolveCachedRscResponseExpiresAt, type CachedRscResponse } from "vinext/shims/navigation";
import { AppElementsWire, type AppElements } from "./app-elements.js";
import { stripRscCacheBustingSearchParam } from "./app-rsc-cache-busting.js";

type VisitedResponseCacheNavigationKind = "navigate" | "refresh" | "traverse";

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

  return entry.expiresAt > options.now;
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
