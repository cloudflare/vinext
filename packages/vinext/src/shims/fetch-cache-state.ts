/**
 * Request-scoped fetch cache state, kept apart from the fetch patching in
 * fetch-cache.ts so modules that only read or update it, like next/cache,
 * don't pull the patched fetch and its Node.js builtins into client graphs
 * that import them.
 */

import { getOrCreateAls } from "./internal/als-registry.js";
import {
  isInsideUnifiedScope,
  getRequestContext,
  runWithUnifiedStateMutation,
} from "./unified-request-context.js";

export type FetchDedupeEntry = {
  key: string;
  promise: Promise<Response>;
  response: Response | null;
};

// ---------------------------------------------------------------------------
// AsyncLocalStorage for request-scoped fetch cache state.
// Uses Symbol.for() on globalThis so the storage is shared across Vite's
// multi-environment module instances.
// ---------------------------------------------------------------------------
export type FetchCacheState = {
  cacheableFetchUrls: Set<string>;
  currentRequestTags: string[];
  currentFetchSoftTags: string[];
  currentFetchCacheMode: FetchCacheMode | null;
  currentFetchRevalidate: number | null;
  currentForceDynamicFetchDefault: boolean;
  dynamicFetchUrls: Set<string>;
  refreshStaleFetchesInForeground: boolean;
  isFetchDedupeActive: boolean;
  currentFetchDedupeEntries: Map<string, FetchDedupeEntry[]>;
  nextFetchId: number;
};

export type FetchCacheMode =
  | "auto"
  | "default-cache"
  | "default-no-store"
  | "force-cache"
  | "force-no-store"
  | "only-cache"
  | "only-no-store";

const _FALLBACK_KEY = Symbol.for("vinext.fetchCache.fallback");
export const fetchCacheAls = getOrCreateAls<FetchCacheState>("vinext.fetchCache.als");

function createFetchCacheState(): FetchCacheState {
  return {
    cacheableFetchUrls: new Set<string>(),
    currentRequestTags: [],
    currentFetchSoftTags: [],
    currentFetchCacheMode: null,
    currentFetchRevalidate: null,
    currentForceDynamicFetchDefault: false,
    dynamicFetchUrls: new Set<string>(),
    refreshStaleFetchesInForeground: false,
    isFetchDedupeActive: false,
    currentFetchDedupeEntries: new Map(),
    nextFetchId: 1,
  };
}

/**
 * Process-wide state used only while the deprecated `withFetchCache()` is
 * active, which marks it with `isFetchDedupeActive`.
 */
export const fallbackFetchCacheState = ((globalThis as unknown as Record<PropertyKey, unknown>)[
  _FALLBACK_KEY
] ??= createFetchCacheState()) as FetchCacheState;

export function getFetchCacheState(): FetchCacheState {
  if (isInsideUnifiedScope()) {
    return getRequestContext();
  }
  const store = fetchCacheAls.getStore();
  if (store) return store;
  if (fallbackFetchCacheState.isFetchDedupeActive) return fallbackFetchCacheState;
  // No request store (a Pages API route, middleware, or work outside any
  // request): hand out a throwaway state so fetch URLs, tags and revalidate
  // made here never accumulate in, or govern, the whole process.
  return createFetchCacheState();
}

/**
 * Reset the fallback state for a new request.  Used by `withFetchCache()`
 * in single-threaded contexts where ALS.run() isn't used.
 */
export function resetFallbackFetchCacheState(isFetchDedupeActive: boolean): void {
  Object.assign(fallbackFetchCacheState, createFetchCacheState(), { isFetchDedupeActive });
}

/**
 * Append cache tags to the current request's collected tags.
 *
 * Mirrors Next.js's `propagateCacheLifeAndTagsToRevalidateStore`: tags declared
 * inside a `"use cache"` function (via `cacheTag()`, persisted on the data cache
 * entry) must also bubble up to the surrounding page / route-handler ISR entry
 * so `revalidateTag()` / `revalidatePath()` can evict the rendered output, not
 * just the inner data cache entry. Without this, a cached `"use cache"` result
 * keeps being served from a stale page/route entry after its tag is revalidated
 * (issue #1453). Tags are already encoded by the caller; deduped to match the
 * tagged-fetch path. A no-op for empty input.
 */
export function addCollectedRequestTags(tags: readonly string[]): void {
  if (tags.length === 0) return;
  const reqTags = getFetchCacheState().currentRequestTags;
  for (const tag of tags) {
    if (!reqTags.includes(tag)) {
      reqTags.push(tag);
    }
  }
}

/**
 * Read the path-derived soft tags for the current render.
 *
 * Used by the "use cache" runtime to pass soft tags to the cache handler
 * so that `revalidatePath()` invalidates "use cache" entries during the
 * affected route's next request, even when the entry carries no hard tags.
 */
export function getCurrentFetchSoftTags(): string[] {
  return getFetchCacheState().currentFetchSoftTags;
}

/**
 * Run `fn` with the request's fetch settings but its own record of the tags and
 * URLs its fetches touch, so work done on the request's behalf after the fact
 * (a background regeneration) leaves the request's response untouched.
 */
export function runWithDetachedFetchObservations<T>(fn: () => Promise<T>): Promise<T> {
  if (isInsideUnifiedScope()) {
    return runWithUnifiedStateMutation((uCtx) => {
      uCtx.cacheableFetchUrls = new Set<string>();
      uCtx.currentRequestTags = [];
      uCtx.dynamicFetchUrls = new Set<string>();
    }, fn);
  }
  return fetchCacheAls.run(
    {
      ...getFetchCacheState(),
      cacheableFetchUrls: new Set<string>(),
      currentRequestTags: [],
      dynamicFetchUrls: new Set<string>(),
    },
    fn,
  );
}
