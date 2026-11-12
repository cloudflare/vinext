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
import { getOrCreateAls } from "./internal/als-registry.js";
import { workUnitAsyncStorage } from "./internal/work-unit-async-storage.js";

// cache.ts owns this scope. Read it through the shared registry so the
// resume data cache does not pull in the full `next/cache` implementation.
const unstableCacheContextStorage = getOrCreateAls<boolean>("vinext.unstableCache.als");

/**
 * Like Next.js's getRenderResumeDataCache() and getPrerenderResumeDataCache(),
 * a cache scope sees no resume data cache. A nested cache is part of its
 * enclosing entry, so it is never replayed or collected on its own.
 */
function isInsideCacheScope(): boolean {
  const type = workUnitAsyncStorage.getStore()?.type;
  return (
    type === "cache" ||
    type === "private-cache" ||
    type === "unstable-cache" ||
    unstableCacheContextStorage.getStore() === true
  );
}

function getResumeDataCacheSeed(): ResumeDataCache | null {
  return isInsideCacheScope() ? null : _getResumeDataCacheSeed();
}

function getResumeDataCacheCollector(): ResumeDataCache | null {
  return isInsideCacheScope() ? null : _getResumeDataCacheCollector();
}

export type UseCacheResumeDataCacheEntry = {
  /** The base64 Flight payload of the cached result. */
  body: string;
  cacheControl: CacheControlMetadata | undefined;
  tags: string[];
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

// Like Next.js's MIN_PRERENDERABLE_EXPIRE and MIN_PREFETCHABLE_STALE
// (server/use-cache/constants.ts), in seconds. A shell leaves out a cache that
// expires sooner (short-lived) or goes stale sooner (not worth prefetching).
export const DYNAMIC_EXPIRE = 300;
export const MIN_PREFETCHABLE_STALE = 30;

/**
 * Like Next.js's serializeUseCacheCacheStore(), short-lived and soon-stale
 * entries stay out of a stored shell's resume data cache: a resumed request
 * runs them again instead of replaying build-time values. The prerender's own
 * renders still read them, so its final render doesn't run them again.
 */
function isOmittedFromStoredResumeDataCache(entry: UseCacheResumeDataCacheEntry): boolean {
  const cacheControl = entry.cacheControl;
  return (
    cacheControl !== undefined &&
    (cacheControl.revalidate === 0 ||
      (cacheControl.expire !== undefined && cacheControl.expire < DYNAMIC_EXPIRE) ||
      (cacheControl.stale !== undefined && cacheControl.stale < MIN_PREFETCHABLE_STALE))
  );
}

/** Returns null when the cache holds nothing a resumed request would read. */
export function stringifyResumeDataCache(cache: ResumeDataCache): string | null {
  const useCacheEntries = [...cache.cache].filter(
    ([, entry]) => !isOmittedFromStoredResumeDataCache(entry),
  );
  if (useCacheEntries.length === 0 && cache.fetch.size === 0) return null;
  const serialized: SerializedResumeDataCache = {
    cache: Object.fromEntries(useCacheEntries),
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
  return getResumeDataCacheSeed()?.cache.get(key);
}

export function collectUseCacheResumeDataCacheEntry(
  key: string,
  entry: UseCacheResumeDataCacheEntry,
): void {
  getResumeDataCacheCollector()?.cache.set(key, entry);
}

export function readFetchResumeDataCacheEntry(key: string): FetchResumeDataCacheEntry | undefined {
  return getResumeDataCacheSeed()?.fetch.get(key);
}

export function collectFetchResumeDataCacheEntry(
  key: string,
  entry: FetchResumeDataCacheEntry,
): void {
  getResumeDataCacheCollector()?.fetch.set(key, entry);
}
