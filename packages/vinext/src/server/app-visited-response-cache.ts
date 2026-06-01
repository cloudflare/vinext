import { resolveCachedRscResponseExpiresAt, type CachedRscResponse } from "vinext/shims/navigation";

type VisitedResponseCacheNavigationKind = "navigate" | "refresh" | "traverse";

export type VisitedResponseCacheEntry = {
  createdAt: number;
  expiresAt: number;
  params: Record<string, string | string[]>;
  response: CachedRscResponse;
};

export const VISITED_RESPONSE_CACHE_TTL = 5 * 60_000;
export const MAX_TRAVERSAL_CACHE_TTL = 30 * 60_000;

export function createVisitedResponseCacheEntry(options: {
  now: number;
  params: Record<string, string | string[]>;
  response: CachedRscResponse;
}): VisitedResponseCacheEntry {
  return {
    createdAt: options.now,
    expiresAt: resolveCachedRscResponseExpiresAt(
      options.now,
      options.response,
      VISITED_RESPONSE_CACHE_TTL,
    ),
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
