import { getHeadersAccessPhase } from "./headers.js";
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

type CacheContextLike = {
  tags: string[];
  lifeConfigs: CacheLifeConfig[];
  variant: string;
  hasExplicitRevalidate: boolean;
  hasExplicitExpire: boolean;
  dynamicNestedCacheError: Error | undefined;
};

let getCacheContext: (() => CacheContextLike | null) | null = null;

export function _registerCacheContextAccessor(fn: () => CacheContextLike | null): void {
  getCacheContext = fn;
}

export function getRegisteredCacheContext(): CacheContextLike | null {
  return getCacheContext?.() ?? null;
}

export type UnstableCacheRevalidationMode = "foreground" | "background";
export type ActionRevalidationKind = 0 | 1 | 2;
export type UnstableCacheObservation = Readonly<{
  kind: "unstable_cache";
  keyHash: string;
  revalidate: number | false | null;
  tagCount: number;
  tagHash: string | null;
}>;

export type CacheState = {
  actionRevalidationKind: ActionRevalidationKind;
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
      context.requestScopedCacheLife = null;
      context.unstableCacheObservations = new Map<string, UnstableCacheObservation>();
      context.unstableCacheRevalidation = "foreground";
    }, fn);
  }
  const state: CacheState = {
    actionRevalidationKind: ACTION_DID_NOT_REVALIDATE,
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
 * Await and clear every cache invalidation queued in the current request.
 * Clearing before awaiting also lets a later drain observe work enqueued by
 * an async continuation while this batch is settling.
 *
 * @internal
 */
export async function _drainPendingRevalidations(): Promise<void> {
  const state = getCacheState();
  let didReject = false;
  let firstRejection: unknown;
  while (state.pendingRevalidations.size > 0) {
    const pending = [...state.pendingRevalidations];
    state.pendingRevalidations.clear();
    const results = await Promise.allSettled(pending);
    for (const result of results) {
      if (result.status === "rejected" && !didReject) {
        didReject = true;
        firstRejection = result.reason;
      }
    }
  }
  if (didReject) throw firstRejection;
}

export function _setRequestScopedCacheLife(config: CacheLifeConfig): void {
  const state = getCacheState();
  if (state.requestScopedCacheLife === null) {
    state.requestScopedCacheLife = { ...config };
    return;
  }

  if (config.stale !== undefined) {
    state.requestScopedCacheLife.stale =
      state.requestScopedCacheLife.stale !== undefined
        ? Math.min(state.requestScopedCacheLife.stale, config.stale)
        : config.stale;
  }
  if (config.revalidate !== undefined) {
    state.requestScopedCacheLife.revalidate =
      state.requestScopedCacheLife.revalidate !== undefined
        ? Math.min(state.requestScopedCacheLife.revalidate, config.revalidate)
        : config.revalidate;
  }
  if (config.expire !== undefined) {
    state.requestScopedCacheLife.expire =
      state.requestScopedCacheLife.expire !== undefined
        ? Math.min(state.requestScopedCacheLife.expire, config.expire)
        : config.expire;
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

export function recordUnstableCacheObservation(observation: UnstableCacheObservation): void {
  getCacheState().unstableCacheObservations.set(observation.keyHash, observation);
}

export function _peekUnstableCacheObservations(): UnstableCacheObservation[] {
  return [...getCacheState().unstableCacheObservations.values()].sort((a, b) =>
    a.keyHash.localeCompare(b.keyHash),
  );
}

export function shouldServeStaleUnstableCacheEntry(): boolean {
  return getCacheState().unstableCacheRevalidation === "background";
}
