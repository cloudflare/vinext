import { resolveClientStaleTimeSeconds } from "../utils/cache-control-metadata.js";
import { NEXT_CACHE_TAGS_HEADER, VINEXT_PRERENDER_CACHE_LIFE_HEADER } from "./headers.js";

/** Cache life recovered from a prerendered response; `stale` seeds the ISR entry. */
export type PrerenderCacheLife = {
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

/**
 * The cache lifetime a prerender-mode render resolved, from its cache-life
 * side channel and Cache-Control header.
 */
export function resolveRenderedCacheControl(
  requestCacheLife: PrerenderCacheLife,
  cacheControl: string,
  fallbackExpireSeconds: number,
): { expire: number; revalidate?: number } {
  const sMaxage = parseCacheControlSeconds(cacheControl, "s-maxage");
  const staleWhileRevalidate = parseCacheControlSeconds(cacheControl, "stale-while-revalidate");
  const revalidate =
    requestCacheLife.revalidate ?? (staleWhileRevalidate === undefined ? undefined : sMaxage);
  return {
    expire:
      requestCacheLife.expire ??
      resolveRenderedExpireSeconds({
        fallbackExpireSeconds,
        sMaxage,
        staleWhileRevalidate,
      }),
    ...(revalidate === undefined ? {} : { revalidate }),
  };
}

export function readPrerenderCacheLifeHeader(headers: Headers): PrerenderCacheLife | null {
  const value = headers.get(VINEXT_PRERENDER_CACHE_LIFE_HEADER);
  if (!value) return null;

  try {
    const parsed = JSON.parse(value) as {
      expire?: unknown;
      revalidate?: unknown;
      stale?: unknown;
    };
    const cacheLife: PrerenderCacheLife = {};
    if (typeof parsed.revalidate === "number" && Number.isFinite(parsed.revalidate)) {
      cacheLife.revalidate = parsed.revalidate;
    }
    if (typeof parsed.expire === "number" && Number.isFinite(parsed.expire)) {
      cacheLife.expire = parsed.expire;
    }
    if (typeof parsed.stale === "number" && Number.isFinite(parsed.stale) && parsed.stale >= 0) {
      cacheLife.stale = parsed.stale;
    }
    return cacheLife.revalidate === undefined &&
      cacheLife.expire === undefined &&
      cacheLife.stale === undefined
      ? null
      : cacheLife;
  } catch {
    return null;
  }
}

export function readPrerenderCacheTagsHeader(headers: Headers): string[] {
  const value = headers.get(NEXT_CACHE_TAGS_HEADER);
  if (!value) return [];
  return [...new Set(value.split(",").filter(Boolean))];
}

function resolveRenderedExpireSeconds(options: {
  fallbackExpireSeconds: number;
  sMaxage?: number;
  staleWhileRevalidate?: number;
}): number {
  const { fallbackExpireSeconds, sMaxage, staleWhileRevalidate } = options;
  if (sMaxage === undefined || staleWhileRevalidate === undefined) {
    return fallbackExpireSeconds;
  }

  return sMaxage + staleWhileRevalidate;
}

function parseCacheControlSeconds(cacheControl: string, directive: string): number | undefined {
  for (const part of cacheControl.split(",")) {
    const [rawName, rawValue] = part.trim().split("=", 2);
    if (rawName.trim().toLowerCase() !== directive) continue;
    if (rawValue === undefined) return undefined;

    const value = Number(rawValue.trim());
    if (!Number.isFinite(value) || value < 0) return undefined;

    return value;
  }

  return undefined;
}
