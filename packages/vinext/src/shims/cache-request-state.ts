import { getCdnCacheAdapter } from "./cdn-cache.js";
import { getHeadersAccessPhase } from "./internal/headers-state.js";
import { getOrCreateAls } from "./internal/als-registry.js";
import {
  getRequestContext,
  isInsideUnifiedScope,
  runWithUnifiedStateMutation,
} from "./unified-request-context.js";

export type CacheLifeConfig = {
  stale?: number;
  revalidate?: number;
  expire?: number;
};

export const cacheLifeProfiles: Record<string, CacheLifeConfig> = {
  default: { revalidate: 900, expire: 4294967294 },
  seconds: { stale: 30, revalidate: 1, expire: 60 },
  minutes: { stale: 300, revalidate: 60, expire: 3600 },
  hours: { stale: 300, revalidate: 3600, expire: 86400 },
  days: { stale: 300, revalidate: 86400, expire: 604800 },
  weeks: { stale: 300, revalidate: 604800, expire: 2592000 },
  max: { stale: 300, revalidate: 2592000, expire: 31536000 },
};

export {
  _recordUseCacheRootParamRead,
  _registerCacheContextAccessor,
  getRegisteredCacheContext,
} from "./internal/cache-context-accessor.js";

export type UnstableCacheRevalidationMode = "foreground" | "background";
export type ActionRevalidationKind = 0 | 1 | 2;
export type UnstableCacheObservation = Readonly<{
  kind: "unstable_cache";
  keyHash: string;
  revalidate: number | false | null;
  tagCount: number;
  tagHash: string | null;
}>;

/**
 * Collects the cacheLife claims made anywhere below the scope that installed
 * it, including nested scopes that reset `requestScopedCacheLife`. Shallow
 * scope clones share it by reference.
 */
export type CacheLifeSink = { cacheLife: CacheLifeConfig | null };

type TagInvalidationDurations = { expire?: number } | undefined;

/** A CDN purge waiting for the request boundary, after its data-cache invalidation. */
export type PendingCdnTagInvalidation = Readonly<{
  tag: string;
  durations: TagInvalidationDurations;
  dataInvalidation: Promise<void>;
}>;

export type CacheState = {
  actionRevalidationKind: ActionRevalidationKind;
  cacheLifeSink: CacheLifeSink | null;
  pendingCdnTagInvalidations: PendingCdnTagInvalidation[];
  pendingRevalidatedTags: Set<string>;
  pendingRevalidations: Set<Promise<void>>;
  requestScopedCacheLife: CacheLifeConfig | null;
  unstableCacheObservations: Map<string, UnstableCacheObservation>;
  unstableCacheRevalidation: UnstableCacheRevalidationMode;
};

const FALLBACK_KEY = Symbol.for("vinext.cache.fallback");
const globalState = globalThis as unknown as Record<PropertyKey, unknown>;
const cacheAls = getOrCreateAls<CacheState>("vinext.cache.als");

const ACTION_DID_NOT_REVALIDATE = 0 satisfies ActionRevalidationKind;
export const ACTION_DID_REVALIDATE_STATIC_AND_DYNAMIC = 1 satisfies ActionRevalidationKind;
export const ACTION_DID_REVALIDATE_DYNAMIC_ONLY = 2 satisfies ActionRevalidationKind;

const fallbackState = (globalState[FALLBACK_KEY] ??= {
  actionRevalidationKind: ACTION_DID_NOT_REVALIDATE,
  cacheLifeSink: null,
  pendingCdnTagInvalidations: [],
  pendingRevalidatedTags: new Set<string>(),
  pendingRevalidations: new Set<Promise<void>>(),
  requestScopedCacheLife: null,
  unstableCacheObservations: new Map<string, UnstableCacheObservation>(),
  unstableCacheRevalidation: "foreground",
} satisfies CacheState) as CacheState;

function getCacheState(): CacheState {
  if (isInsideUnifiedScope()) {
    return getRequestContext();
  }
  return cacheAls.getStore() ?? fallbackState;
}

export function _runWithCacheState<T>(fn: () => Promise<T>): Promise<T>;
export function _runWithCacheState<T>(fn: () => T | Promise<T>): T | Promise<T>;
export function _runWithCacheState<T>(fn: () => T | Promise<T>): T | Promise<T> {
  if (isInsideUnifiedScope()) {
    return runWithUnifiedStateMutation((context) => {
      context.actionRevalidationKind = ACTION_DID_NOT_REVALIDATE;
      context.cacheLifeSink = null;
      context.requestScopedCacheLife = null;
      context.unstableCacheObservations = new Map<string, UnstableCacheObservation>();
      context.unstableCacheRevalidation = "foreground";
    }, fn);
  }
  const state: CacheState = {
    actionRevalidationKind: ACTION_DID_NOT_REVALIDATE,
    cacheLifeSink: null,
    pendingCdnTagInvalidations: [],
    pendingRevalidatedTags: new Set<string>(),
    pendingRevalidations: new Set<Promise<void>>(),
    requestScopedCacheLife: null,
    unstableCacheObservations: new Map<string, UnstableCacheObservation>(),
    unstableCacheRevalidation: "foreground",
  };
  return cacheAls.run(state, fn);
}

export function _initRequestScopedCacheState(): void {
  const state = getCacheState();
  state.actionRevalidationKind = ACTION_DID_NOT_REVALIDATE;
  state.requestScopedCacheLife = null;
  state.unstableCacheObservations = new Map<string, UnstableCacheObservation>();
}

export function markActionRevalidation(kind: ActionRevalidationKind): void {
  if (getHeadersAccessPhase() !== "action") return;

  const state = getCacheState();
  state.actionRevalidationKind =
    state.actionRevalidationKind === ACTION_DID_REVALIDATE_STATIC_AND_DYNAMIC
      ? ACTION_DID_REVALIDATE_STATIC_AND_DYNAMIC
      : kind;
}

export function getAndClearActionRevalidationKind(): ActionRevalidationKind {
  const state = getCacheState();
  const kind = state.actionRevalidationKind;
  state.actionRevalidationKind = ACTION_DID_NOT_REVALIDATE;
  return kind;
}

function hasRequestScopedCacheState(): boolean {
  if (isInsideUnifiedScope() || cacheAls.getStore() !== undefined) return true;
  const phase = getHeadersAccessPhase();
  return phase === "action" || phase === "route-handler";
}

/** @internal */
export function _markPendingRevalidatedTag(tag: string): void {
  if (!hasRequestScopedCacheState()) return;
  getCacheState().pendingRevalidatedTags.add(tag);
}

/** @internal */
export function _hasPendingRevalidatedTag(tags: readonly string[]): boolean {
  if (!hasRequestScopedCacheState()) return false;
  const pendingTags = getCacheState().pendingRevalidatedTags;
  return tags.some((tag) => pendingTags.has(tag));
}

/**
 * Record a cache invalidation that must finish before the current action or
 * route-handler request is finalized. The public revalidation APIs remain
 * synchronous, matching Next.js, while the request boundary owns the await.
 *
 * Returns false outside a request-like phase so standalone calls can retain
 * their historical background-work behavior without accumulating promises in
 * the process-global fallback state.
 *
 * @internal
 */
export function _queuePendingRevalidation(promise: Promise<void>): boolean {
  if (!hasRequestScopedCacheState()) return false;

  getCacheState().pendingRevalidations.add(promise);
  // Draining rethrows failures at the request boundary. This observer only
  // prevents runtimes from reporting a transient unhandled rejection before
  // that boundary gets a chance to await the original promise.
  void promise.catch(() => {});
  return true;
}

/**
 * Defer the CDN purge for `tag` to the current Server Action or Route Handler
 * boundary, so the request sends one adapter call per cacheLife profile like
 * Next.js' `executeRevalidates`. Edge purges are rate limited (Workers Cache
 * allows 5 requests a minute per account), so per-call purges run out fast.
 *
 * Only those two phases defer: their executors always drain before the
 * request finishes. Once the response has closed, `after()` callbacks run
 * past the last drain, so they purge immediately too. Everywhere else returns
 * false and the caller purges immediately.
 *
 * @internal
 */
export function _queuePendingCdnTagInvalidation(
  tag: string,
  durations: TagInvalidationDurations,
  dataInvalidation: Promise<void>,
): boolean {
  const phase = getHeadersAccessPhase();
  if (phase !== "action" && phase !== "route-handler") return false;
  if (isInsideUnifiedScope() && getRequestContext().afterContext.responseClosed) return false;

  getCacheState().pendingCdnTagInvalidations.push({ tag, durations, dataInvalidation });
  return true;
}

/**
 * Ask the CDN adapter to invalidate `tags`, logging rather than rethrowing a
 * failure. The data cache is already invalidated by then, so a failed edge
 * purge leaves edge-cached responses stale until they expire, and failing the
 * request would not change that. It would only report a committed Server
 * Action write as a failure.
 *
 * @internal
 */
export async function _revalidateCdnTags(
  tags: string | string[],
  durations?: { expire?: number },
): Promise<void> {
  try {
    await getCdnCacheAdapter().revalidateTag(tags, durations);
  } catch (error) {
    console.error(
      "[vinext] CDN cache invalidation failed; edge-cached responses may stay stale until they expire:",
      error,
    );
  }
}

async function flushCdnTagInvalidations(
  invalidations: readonly PendingCdnTagInvalidation[],
): Promise<void> {
  if (invalidations.length === 0) return;

  const settled = await Promise.allSettled(
    invalidations.map(({ dataInvalidation }) => dataInvalidation),
  );
  const batches = new Map<string, { durations: TagInvalidationDurations; tags: Set<string> }>();
  invalidations.forEach(({ tag, durations }, index) => {
    // Purging the edge for a tag whose data-cache invalidation failed would
    // let the edge refetch and re-cache stale data.
    if (settled[index].status === "rejected") return;
    const key = durations === undefined ? "" : JSON.stringify(durations);
    let batch = batches.get(key);
    if (!batch) {
      batch = { durations, tags: new Set() };
      batches.set(key, batch);
    }
    batch.tags.add(tag);
  });
  await Promise.all(
    [...batches.values()].map(({ durations, tags }) => _revalidateCdnTags([...tags], durations)),
  );
}

/**
 * Await and clear every cache invalidation queued in the current request,
 * then send the deferred CDN purges in batches. Clearing before awaiting also
 * lets a later drain observe work enqueued by an async continuation while
 * this batch is settling.
 *
 * @internal
 */
export async function _drainPendingRevalidations(): Promise<void> {
  const state = getCacheState();
  let didReject = false;
  let firstRejection: unknown;
  while (state.pendingRevalidations.size > 0 || state.pendingCdnTagInvalidations.length > 0) {
    const pending = [...state.pendingRevalidations];
    state.pendingRevalidations.clear();
    // Mutate in place: shallow-cloned child scopes share this array.
    const cdnInvalidations = state.pendingCdnTagInvalidations.splice(0);
    const results = await Promise.allSettled(pending);
    for (const result of results) {
      if (result.status === "rejected" && !didReject) {
        didReject = true;
        firstRejection = result.reason;
      }
    }
    await flushCdnTagInvalidations(cdnInvalidations);
  }
  if (didReject) throw firstRejection;
}

function mergeCacheLife(current: CacheLifeConfig | null, config: CacheLifeConfig): CacheLifeConfig {
  if (current === null) return { ...config };

  if (config.stale !== undefined) {
    current.stale =
      current.stale !== undefined ? Math.min(current.stale, config.stale) : config.stale;
  }
  if (config.revalidate !== undefined) {
    current.revalidate =
      current.revalidate !== undefined
        ? Math.min(current.revalidate, config.revalidate)
        : config.revalidate;
  }
  if (config.expire !== undefined) {
    current.expire =
      current.expire !== undefined ? Math.min(current.expire, config.expire) : config.expire;
  }
  return current;
}

export function _setRequestScopedCacheLife(config: CacheLifeConfig): void {
  const state = getCacheState();
  state.requestScopedCacheLife = mergeCacheLife(state.requestScopedCacheLife, config);
  if (state.cacheLifeSink) {
    state.cacheLifeSink.cacheLife = mergeCacheLife(state.cacheLifeSink.cacheLife, config);
  }
}

export function _peekRequestScopedCacheLife(): CacheLifeConfig | null {
  const config = getCacheState().requestScopedCacheLife;
  return config === null ? null : { ...config };
}

export function _consumeRequestScopedCacheLife(): CacheLifeConfig | null {
  const state = getCacheState();
  const config = state.requestScopedCacheLife;
  state.requestScopedCacheLife = null;
  return config;
}

/**
 * Capture access to the current request's cache-life slot for work that may
 * finish after the AsyncLocalStorage request scope has returned. RSC response
 * bodies are consumed by the server runtime later, so resolving the active
 * store from a stream-finalization callback can otherwise read a detached
 * context and lose cacheLife claims made while rendering the body.
 */
export function _captureRequestScopedCacheLifeAccessors(): {
  consume: () => CacheLifeConfig | null;
  peek: () => CacheLifeConfig | null;
} {
  const state = getCacheState();
  return {
    consume() {
      const config = state.requestScopedCacheLife;
      state.requestScopedCacheLife = null;
      return config;
    },
    peek() {
      const config = state.requestScopedCacheLife;
      return config === null ? null : { ...config };
    },
  };
}

export function recordUnstableCacheObservation(observation: UnstableCacheObservation): void {
  getCacheState().unstableCacheObservations.set(observation.keyHash, observation);
}

export function _peekUnstableCacheObservations(): UnstableCacheObservation[] {
  return [...getCacheState().unstableCacheObservations.values()].sort((a, b) =>
    a.keyHash.localeCompare(b.keyHash),
  );
}

/**
 * Run `fn` with the request's cache settings, including its revalidation mode,
 * but its own record of cache lives and unstable_cache observations, so work
 * done on the request's behalf after the fact leaves the request untouched.
 */
export function runWithDetachedCacheObservations<T>(fn: () => Promise<T>): Promise<T> {
  if (isInsideUnifiedScope()) {
    return runWithUnifiedStateMutation((context) => {
      context.cacheLifeSink = null;
      context.requestScopedCacheLife = null;
      context.unstableCacheObservations = new Map<string, UnstableCacheObservation>();
    }, fn);
  }
  return cacheAls.run(
    {
      ...getCacheState(),
      cacheLifeSink: null,
      requestScopedCacheLife: null,
      unstableCacheObservations: new Map<string, UnstableCacheObservation>(),
    },
    fn,
  );
}

export function shouldServeStaleUnstableCacheEntry(): boolean {
  return getCacheState().unstableCacheRevalidation === "background";
}
