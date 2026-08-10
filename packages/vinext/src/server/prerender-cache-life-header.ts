import { resolveClientStaleTimeSeconds } from "../utils/cache-control-metadata.js";
import { NEXT_CACHE_TAGS_HEADER, VINEXT_PRERENDER_CACHE_LIFE_HEADER } from "./headers.js";

type PrerenderCacheLife = {
  expire?: number;
  revalidate?: number;
  /** Client-router dimension — see `resolveClientStaleTimeSeconds`. */
  stale?: number;
};

export function applyPrerenderCacheLifeHeader(
  headers: Headers,
  requestCacheLife: PrerenderCacheLife | null | undefined,
): void {
  if (!requestCacheLife) return;
  // Build-internal channel: build/prerender.ts turns this into ISR seed
  // metadata; these responses never reach a browser.
  const payload: PrerenderCacheLife = {};
  if (
    typeof requestCacheLife.revalidate === "number" &&
    Number.isFinite(requestCacheLife.revalidate)
  ) {
    payload.revalidate = requestCacheLife.revalidate;
  }
  if (typeof requestCacheLife.expire === "number" && Number.isFinite(requestCacheLife.expire)) {
    payload.expire = requestCacheLife.expire;
  }
  const stale = resolveClientStaleTimeSeconds(requestCacheLife);
  if (stale !== undefined) {
    payload.stale = stale;
  }
  if (
    payload.revalidate === undefined &&
    payload.expire === undefined &&
    payload.stale === undefined
  ) {
    return;
  }
  headers.set(VINEXT_PRERENDER_CACHE_LIFE_HEADER, JSON.stringify(payload));
}

export function applyPrerenderCacheTagsHeader(
  headers: Headers,
  cacheTags: readonly string[],
): void {
  if (cacheTags.length > 0) {
    headers.set(NEXT_CACHE_TAGS_HEADER, cacheTags.join(","));
  }
}
