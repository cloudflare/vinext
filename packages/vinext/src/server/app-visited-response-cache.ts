import { resolveCachedRscResponseExpiresAt, type CachedRscResponse } from "vinext/shims/navigation";
import { AppElementsWire, type AppElements } from "./app-elements.js";
import { normalizeMountedSlotsHeader } from "./app-mounted-slots-header.js";
import { stripRscCacheBustingSearchParam } from "./app-rsc-cache-busting.js";
import type { BfcacheIdMap } from "./app-history-state.js";

type VisitedResponseCacheNavigationKind = "navigate" | "refresh" | "traverse";

export type VisitedResponseCacheEntry = {
  bfcacheIds?: BfcacheIdMap;
  createdAt: number;
  elements?: AppElements;
  expiresAt: number;
  mountedSlotsHeader: string | null;
  partial?: boolean;
  params: Record<string, string | string[]>;
  response: CachedRscResponse;
  stage?: "runtime" | "static";
  stageGeneration?: number;
};

export const VISITED_RESPONSE_CACHE_TTL = 5 * 60_000;
export const MAX_TRAVERSAL_CACHE_TTL = 30 * 60_000;

export function startAuthoritativeCachedNavigationResponse<T>(
  startResponse: () => Promise<T>,
  runtimeFill: Promise<void> | null | undefined,
  detachedShellCommit?: Promise<unknown> | null,
): Promise<T> {
  void runtimeFill?.catch(() => {});
  void detachedShellCommit?.catch(() => {});
  return startResponse();
}

export function createVisitedResponseCacheEntry(options: {
  elements?: AppElements;
  fallbackTtlMs?: number;
  now: number;
  mountedSlotsHeader?: string | null;
  partial?: boolean;
  bfcacheIds?: BfcacheIdMap;
  params: Record<string, string | string[]>;
  response: CachedRscResponse;
  stage?: "runtime" | "static";
  stageGeneration?: number;
}): VisitedResponseCacheEntry {
  const expiryResponse =
    options.stage !== undefined
      ? { expiresAt: options.response.expiresAt, serverStaleTime: options.response.serverStaleTime }
      : options.response;
  return {
    createdAt: options.now,
    ...(options.bfcacheIds ? { bfcacheIds: options.bfcacheIds } : {}),
    ...(options.elements ? { elements: options.elements } : {}),
    expiresAt: resolveCachedRscResponseExpiresAt(
      options.now,
      expiryResponse,
      options.fallbackTtlMs ?? VISITED_RESPONSE_CACHE_TTL,
    ),
    mountedSlotsHeader: options.mountedSlotsHeader ?? null,
    ...(options.partial === undefined ? {} : { partial: options.partial }),
    params: options.params,
    response: options.response,
    ...(options.stage === undefined ? {} : { stage: options.stage }),
    ...(options.stageGeneration === undefined ? {} : { stageGeneration: options.stageGeneration }),
  };
}

export function createCachedNavigationStageCacheKey(
  pathAndSearch: string,
  interceptionContext: string | null,
  mountedSlotsHeader: string | null,
): string {
  return JSON.stringify([
    AppElementsWire.encodeCacheKey(pathAndSearch, interceptionContext),
    normalizeMountedSlotsHeader(mountedSlotsHeader),
  ]);
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

/**
 * A completed runtime stage replaces the static stage in Next's segment cache.
 * Keep the static shell independently reusable while that refinement is absent
 * (including while its fill is pending), but expire the published pair once
 * either completed stage becomes stale.
 */
export function isCachedNavigationStagePairFresh(
  staticStage: VisitedResponseCacheEntry,
  runtimeStage: VisitedResponseCacheEntry | undefined,
  options: {
    navigationKind: VisitedResponseCacheNavigationKind;
    now: number;
  },
): boolean {
  if (!isVisitedResponseCacheEntryFresh(staticStage, options)) return false;
  if (
    runtimeStage === undefined ||
    staticStage.stageGeneration === undefined ||
    runtimeStage.stageGeneration !== staticStage.stageGeneration
  ) {
    return true;
  }
  return isVisitedResponseCacheEntryFresh(runtimeStage, options);
}

export function canPublishCachedNavigationRuntimeStage(
  staticStage: VisitedResponseCacheEntry | undefined,
  stageGeneration: number,
): boolean {
  return staticStage?.stageGeneration === stageGeneration;
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
