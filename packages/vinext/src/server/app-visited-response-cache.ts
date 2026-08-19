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
  requestVariantKey?: string | null;
  response: CachedRscResponse;
  /**
   * Framework proof that this is a complete committed tree. When the response
   * also does not vary on Next-Url, it can be re-keyed across source variants.
   */
  completePayload?: true;
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
  requestVariantKey?: string | null;
  response: CachedRscResponse;
  completePayload?: boolean;
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
    requestVariantKey: options.requestVariantKey,
    response: options.response,
    ...(options.completePayload === true ? { completePayload: true as const } : {}),
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
  requestVariantKey?: string | null,
): { cacheKey: string; entry: VisitedResponseCacheEntry } | null {
  const exactCacheKey = AppElementsWire.encodeCacheKey(rscUrl, interceptionContext);
  const exactEntry = cache.get(exactCacheKey);
  if (exactEntry) {
    return { cacheKey: exactCacheKey, entry: exactEntry };
  }

  const normalizedTarget = normalizeVisitedResponseCacheLookupUrl(rscUrl);
  if (normalizedTarget === null) return null;

  for (const [cacheKey, entry] of cache) {
    if (
      requestVariantKey !== undefined &&
      entry.requestVariantKey !== requestVariantKey &&
      entry.completePayload !== true
    ) {
      continue;
    }
    if (entry.response.variesOnNextUrl === true) continue;
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
  requestVariantKey?: string | null,
): boolean {
  const match = findVisitedResponseCacheEntry(
    cache,
    rscUrl,
    interceptionContext,
    requestVariantKey,
  );
  if (!match) return false;
  return cache.delete(match.cacheKey);
}

export function deleteAllVisitedResponseCacheEntries(
  cache: Map<string, VisitedResponseCacheEntry>,
  rscUrl: string,
  interceptionContext: string | null,
): number {
  let deleted = 0;
  const exactCacheKey = AppElementsWire.encodeCacheKey(rscUrl, interceptionContext);
  if (cache.delete(exactCacheKey)) deleted++;

  const normalizedTarget = normalizeVisitedResponseCacheLookupUrl(rscUrl);
  if (normalizedTarget === null) return deleted;

  // This is replacement invalidation, not a reuse lookup. Every older
  // fingerprint for the visible route is stale once a newer response commits,
  // including source-specific entries that intentionally vary on Next-Url and
  // therefore must not match `findVisitedResponseCacheEntry`.
  for (const cacheKey of cache.keys()) {
    const source = parseVisitedResponseCacheKey(cacheKey);
    if (source.interceptionContext !== interceptionContext) continue;
    if (normalizeVisitedResponseCacheLookupUrl(source.rscUrl) !== normalizedTarget) continue;
    cache.delete(cacheKey);
    deleted++;
  }
  return deleted;
}

export function deleteInvalidatedHistoryRestoreEntries(
  cache: Map<string, VisitedResponseCacheEntry>,
): void {
  for (const [cacheKey, entry] of cache) {
    if (entry.reuseAfterHistoryRestore) continue;
    cache.delete(cacheKey);
  }
}
