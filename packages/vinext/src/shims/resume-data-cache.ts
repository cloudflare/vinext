/**
 * Resume data cache (RDC).
 *
 * The `"use cache"` and fetch cache entries a fallback shell render read or
 * wrote, stored with the shell so the request that resumes it renders the
 * shell's cached parts from the same values the shell was built from.
 *
 * Like Next.js, an RDC entry is used whatever its age; only a tag the current
 * request revalidated bypasses it. The collector records entries on cache hits
 * and fresh writes alike, so a shell that hit a warm entry still carries it.
 *
 * Ported from Next.js: packages/next/src/server/resume-data-cache/
 * https://github.com/vercel/next.js/tree/canary/packages/next/src/server/resume-data-cache
 */
import type { CacheControlMetadata, CachedFetchValue } from "./cache-handler.js";
import { _getResumeDataCacheCollector, _getResumeDataCacheSeed } from "./cache-request-state.js";

export type UseCacheResumeDataCacheEntry = {
  /** The base64 Flight payload of the cached result. */
  body: string;
  cacheControl: CacheControlMetadata | undefined;
  tags: string[];
  /**
   * The root params the cached function read, so a resumed hit still keys an
   * enclosing cache by them on a runtime that has not run the function yet.
   */
  readRootParamNames?: string[];
};

export type FetchResumeDataCacheEntry = CachedFetchValue["data"];

export type ResumeDataCache = {
  cache: Map<string, UseCacheResumeDataCacheEntry>;
  fetch: Map<string, FetchResumeDataCacheEntry>;
};

type SerializedResumeDataCache = {
  cache: Record<string, UseCacheResumeDataCacheEntry>;
  fetch: Record<string, FetchResumeDataCacheEntry>;
};

export function createResumeDataCache(): ResumeDataCache {
  return { cache: new Map(), fetch: new Map() };
}

export function isResumeDataCacheEmpty(cache: ResumeDataCache): boolean {
  return cache.cache.size === 0 && cache.fetch.size === 0;
}

export function stringifyResumeDataCache(cache: ResumeDataCache): string {
  const serialized: SerializedResumeDataCache = {
    cache: Object.fromEntries(cache.cache),
    fetch: Object.fromEntries(cache.fetch),
  };
  return JSON.stringify(serialized);
}

/** Returns null for a value this build did not write, so the shell renders without one. */
export function parseResumeDataCache(value: string | undefined): ResumeDataCache | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<SerializedResumeDataCache> | null;
    if (!parsed || typeof parsed !== "object") return null;
    return {
      cache: new Map(Object.entries(parsed.cache ?? {})),
      fetch: new Map(Object.entries(parsed.fetch ?? {})),
    };
  } catch {
    return null;
  }
}

export function readUseCacheResumeDataCacheEntry(
  key: string,
): UseCacheResumeDataCacheEntry | undefined {
  return _getResumeDataCacheSeed()?.cache.get(key);
}

// Like Next.js's DYNAMIC_EXPIRE (server/use-cache/constants.ts), in seconds.
const DYNAMIC_EXPIRE = 300;

export function collectUseCacheResumeDataCacheEntry(
  key: string,
  entry: UseCacheResumeDataCacheEntry,
): void {
  // Like Next.js, short-lived entries stay out of a shell's resume data
  // cache: a resumed request runs them again instead of replaying build-time
  // values.
  const cacheControl = entry.cacheControl;
  if (
    cacheControl &&
    (cacheControl.revalidate === 0 ||
      (cacheControl.expire !== undefined && cacheControl.expire < DYNAMIC_EXPIRE))
  ) {
    return;
  }
  _getResumeDataCacheCollector()?.cache.set(key, entry);
}

export function readFetchResumeDataCacheEntry(key: string): FetchResumeDataCacheEntry | undefined {
  return _getResumeDataCacheSeed()?.fetch.get(key);
}

export function collectFetchResumeDataCacheEntry(
  key: string,
  entry: FetchResumeDataCacheEntry,
): void {
  _getResumeDataCacheCollector()?.fetch.set(key, entry);
}
