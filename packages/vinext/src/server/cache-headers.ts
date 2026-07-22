import { NEXTJS_CACHE_HEADER, VINEXT_CACHE_HEADER } from "./headers.js";

type VinextCacheState = "HIT" | "MISS" | "STALE" | "STATIC";
type NextJsCacheState = "HIT" | "MISS" | "STALE";

function toNextJsCacheState(cacheState: VinextCacheState): NextJsCacheState {
  return cacheState === "STATIC" ? "HIT" : cacheState;
}

export function setCacheStateHeaders(headers: Headers, cacheState: VinextCacheState): void {
  headers.set(VINEXT_CACHE_HEADER, cacheState);
  headers.set(NEXTJS_CACHE_HEADER, toNextJsCacheState(cacheState));
}

export function buildCacheStateHeaders(cacheState: VinextCacheState): Record<string, string> {
  return {
    [VINEXT_CACHE_HEADER]: cacheState,
    [NEXTJS_CACHE_HEADER]: toNextJsCacheState(cacheState),
  };
}
