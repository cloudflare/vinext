import {
  PREFETCH_CACHE_TTL,
  resolveCachedRscResponseExpiresAt,
  type CachedRscResponse,
} from "vinext/shims/navigation";
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

function isVisitedResponseCacheEntryCompatibleForFullPrefetch(
  entry: VisitedResponseCacheEntry,
  mountedSlotsHeader: string | null,
): boolean {
  // A decoded committed tree can be merged against the current mounted slots.
  // A snapshot-only entry is safe only in the request context that produced it.
  return entry.elements !== undefined || entry.mountedSlotsHeader === mountedSlotsHeader;
}

/**
 * Promotes a recently visited response into the explicit-full-prefetch stale
 * window. Next.js does the same when a Full Segment Cache prefetch can be
 * fulfilled from BFCache instead of issuing another request. Returns the
 * absolute Full-prefetch expiry so programmatic prefetch invalidation can use
 * the same deadline, or null when no response is claimable.
 */
export function claimVisitedResponseCacheEntryForFullPrefetch(
  cache: Map<string, VisitedResponseCacheEntry>,
  rscUrl: string,
  interceptionContext: string | null,
  mountedSlotsHeader: string | null,
  options: { now?: number; staleTimeMs?: number } = {},
): number | null {
  const now = options.now ?? Date.now();
  const staleTimeMs = options.staleTimeMs ?? PREFETCH_CACHE_TTL;
  const exactCacheKey = AppElementsWire.encodeCacheKey(rscUrl, interceptionContext);
  const normalizedTarget = normalizeVisitedResponseCacheLookupUrl(rscUrl);
  let match: { cacheKey: string; entry: VisitedResponseCacheEntry } | null = null;

  // Multiple requests for the same route can be stored under different RSC
  // cache-busting digests. Inspect every canonical alias: an older alias may
  // already be outside the Full-prefetch window while a newer navigation is
  // still reusable.
  for (const [cacheKey, entry] of cache) {
    if (cacheKey !== exactCacheKey) {
      const source = parseVisitedResponseCacheKey(cacheKey);
      if (source.interceptionContext !== interceptionContext) continue;
      if (normalizedTarget === null) continue;
      if (normalizeVisitedResponseCacheLookupUrl(source.rscUrl) !== normalizedTarget) continue;
    }
    if (!isVisitedResponseCacheEntryCompatibleForFullPrefetch(entry, mountedSlotsHeader)) {
      continue;
    }
    if (now >= entry.createdAt + staleTimeMs) continue;
    if (match !== null && match.entry.createdAt >= entry.createdAt) continue;
    match = { cacheKey, entry };
  }

  if (!match) return null;

  // A Full prefetch uses the static stale time measured from the navigation
  // that produced the BFCache entry. Its regular-navigation dynamic deadline
  // is independent and may be longer, so promoting the entry must not shorten
  // that existing BFCache lifetime.
  const expiresAt = match.entry.createdAt + staleTimeMs;
  match.entry.expiresAt = Math.max(match.entry.expiresAt, expiresAt);
  cache.delete(match.cacheKey);
  cache.set(match.cacheKey, match.entry);
  return expiresAt;
}
