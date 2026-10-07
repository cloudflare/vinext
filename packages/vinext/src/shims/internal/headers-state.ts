/**
 * Request state behind next/headers' dynamic-usage tracking.
 *
 * Kept apart from the headers()/cookies() implementation in ../headers.ts so
 * the SSR environment, which only marks and observes dynamic usage, does not
 * load it. The state lives on globalThis (see the note below), so every copy of
 * this module shares it.
 */

import type { RenderRequestApiKind } from "../../server/cache-proof.js";
import type { HeadersContext } from "../headers.js";
import { getOrCreateAls } from "./als-registry.js";
import {
  ensureRenderDynamicLatch,
  getRequestContext,
  isInsideUnifiedScope,
} from "../unified-request-context.js";

export type HeadersAccessPhase = "render" | "action" | "route-handler";

/**
 * Whether the current render has used a dynamic API. Unlike
 * `dynamicUsageDetected`, nothing clears it, and one object is shared by every
 * child scope of the request, so usage inside isolated scopes (such as the
 * layout probe) stays visible to later readers.
 */
export type RenderDynamicLatch = {
  dynamic: boolean;
  listeners: Set<() => void>;
};

export function createRenderDynamicLatch(): RenderDynamicLatch {
  return { dynamic: false, listeners: new Set() };
}

export type VinextHeadersShimState = {
  headersContext: HeadersContext | null;
  dynamicUsageDetected: boolean;
  renderDynamicLatch: RenderDynamicLatch;
  renderRequestApiUsage: Set<RenderRequestApiKind>;
  connectionProbe: ConnectionProbeState | null;
  /** Error recorded by throwIfInsideCacheScope for dev diagnostics, persists even if caught by user code. */
  invalidDynamicUsageError: unknown;
  pendingSetCookies: string[];
  draftModeCookieHeader: string | null;
  phase: HeadersAccessPhase;
};

export type ConnectionProbeState = {
  active: boolean;
  dynamicUsageTarget: VinextHeadersShimState;
  interrupted: boolean;
  interrupt: () => void;
  pending: Promise<never>;
};

export type ConnectionProbeResult<T> =
  | {
      completed: true;
      result: T;
    }
  | {
      completed: false;
    };

// NOTE:
// - This shim can be loaded under multiple module specifiers in Vite's
//   multi-environment setup (RSC/SSR). Store the AsyncLocalStorage on
//   globalThis so `connection()` (next/server) and `consumeDynamicUsage()`
//   (next/headers) always share it.
// - We use AsyncLocalStorage so concurrent requests don't stomp each other's
//   headers/cookies/dynamic-usage state.
const _FALLBACK_KEY = Symbol.for("vinext.nextHeadersShim.fallback");
const _g = globalThis as unknown as Record<PropertyKey, unknown>;
export const headersShimAls = getOrCreateAls<VinextHeadersShimState>("vinext.nextHeadersShim.als");

const _fallbackState = (_g[_FALLBACK_KEY] ??= {
  headersContext: null,
  dynamicUsageDetected: false,
  renderDynamicLatch: createRenderDynamicLatch(),
  renderRequestApiUsage: new Set<RenderRequestApiKind>(),
  connectionProbe: null,
  invalidDynamicUsageError: null,
  pendingSetCookies: [],
  draftModeCookieHeader: null,
  phase: "render",
} satisfies VinextHeadersShimState) as VinextHeadersShimState;

export function getHeadersShimState(): VinextHeadersShimState {
  if (isInsideUnifiedScope()) {
    return getRequestContext();
  }
  return headersShimAls.getStore() ?? _fallbackState;
}

/**
 * Dynamic usage flag — set when a component calls connection(), cookies(),
 * headers(), or noStore() during rendering. When true, ISR caching is
 * bypassed and the response gets Cache-Control: no-store.
 */
// (stored on _state)

/**
 * Mark the current render as requiring dynamic (uncached) rendering.
 * Called by connection(), cookies(), headers(), and noStore().
 */
export function markDynamicUsage(): void {
  const state = getHeadersShimState();
  if (state.headersContext?.forceStatic) {
    return;
  }
  state.dynamicUsageDetected = true;
  // A probe scope cloned before an HMR update may not share its parent's
  // latch, so latch each propagation target too. Set every flag before any
  // listener runs.
  const latches = [ensureRenderDynamicLatch(state)];
  forEachConnectionProbeTarget(state, (target) => {
    target.dynamicUsageDetected = true;
    latches.push(ensureRenderDynamicLatch(target));
  });
  for (const latch of latches) {
    latchRenderDynamic(latch);
  }
}

function latchRenderDynamic(latch: RenderDynamicLatch): void {
  if (latch.dynamic) return;
  latch.dynamic = true;
  const listeners = [...latch.listeners];
  latch.listeners.clear();
  for (const listener of listeners) {
    try {
      listener();
    } catch (error) {
      // Listeners are never notified again, so one failing must not skip the
      // rest, and its error isn't the dynamic API caller's to handle.
      console.error(error);
    }
  }
}

/** Whether the current render has used a dynamic API at any point so far. */
export function isRenderDynamicLatched(): boolean {
  return ensureRenderDynamicLatch(getHeadersShimState()).dynamic;
}

/**
 * Call `listener` once when the current render first uses a dynamic API.
 * Returns an unsubscribe function. The listener never runs if the render is
 * already latched; check `isRenderDynamicLatched()` first.
 */
export function onRenderDynamicLatched(listener: () => void): () => void {
  const latch = ensureRenderDynamicLatch(getHeadersShimState());
  if (latch.dynamic) return () => {};
  latch.listeners.add(listener);
  return () => {
    latch.listeners.delete(listener);
  };
}

function forEachConnectionProbeTarget(
  state: VinextHeadersShimState,
  visit: (target: VinextHeadersShimState) => void,
): void {
  let target = state.connectionProbe?.dynamicUsageTarget ?? null;
  const seen = new Set<VinextHeadersShimState>([state]);
  while (target && !seen.has(target)) {
    seen.add(target);
    visit(target);
    target = target.connectionProbe?.dynamicUsageTarget ?? null;
  }
}

function propagateInvalidDynamicUsageError(state: VinextHeadersShimState, error: unknown): void {
  forEachConnectionProbeTarget(state, (target) => {
    if (target.invalidDynamicUsageError == null) {
      target.invalidDynamicUsageError = error;
    }
  });
}

export function markRenderRequestApiUsage(kind: RenderRequestApiKind): void {
  getHeadersShimState().renderRequestApiUsage.add(kind);
}

export function throwIfStaticGenerationAccessError(): void {
  const accessError = getHeadersShimState().headersContext?.accessError;
  if (accessError) {
    throw accessError;
  }
}

// ---------------------------------------------------------------------------
// Cache scope detection — checks whether we're inside "use cache" or
// unstable_cache() by reading ALS instances stored on globalThis via Symbols.
// This avoids circular imports between headers.ts, cache.ts, and cache-runtime.ts.
// The ALS instances are registered by cache-runtime.ts and cache.ts respectively.
// ---------------------------------------------------------------------------

/** Symbol used by cache-runtime.ts to store the "use cache" ALS on globalThis */
const _USE_CACHE_ALS_KEY = Symbol.for("vinext.cacheRuntime.contextAls");
/** Symbol used by cache.ts to store the unstable_cache ALS on globalThis */
const _UNSTABLE_CACHE_ALS_KEY = Symbol.for("vinext.unstableCache.als");

type UseCacheGuardContext = {
  variant?: unknown;
  invalidDynamicUsageError?: unknown;
};

function _getGlobalCacheScopeStore(key: symbol): unknown {
  const value = Reflect.get(globalThis, key);
  if (!value || typeof value !== "object") return null;

  const getStore = Reflect.get(value, "getStore");
  if (typeof getStore !== "function") return null;

  return getStore.call(value);
}

function _getUseCacheGuardContext(): UseCacheGuardContext | null {
  const store = _getGlobalCacheScopeStore(_USE_CACHE_ALS_KEY);
  if (!store || typeof store !== "object") return null;
  return store;
}

function _isInsidePublicUseCache(): boolean {
  const ctx = _getUseCacheGuardContext();
  // Next.js models "use cache: private" as a private-cache work unit that
  // carries request headers and cookies. Only public "use cache" scopes freeze
  // request APIs into persisted cache entries and must reject these reads.
  // https://github.com/vercel/next.js/blob/canary/packages/next/src/server/app-render/work-unit-async-storage.external.ts
  return ctx !== null && ctx.variant !== "private";
}

function _isInsideUnstableCache(): boolean {
  return _getGlobalCacheScopeStore(_UNSTABLE_CACHE_ALS_KEY) === true;
}

/** Whether work is executing inside a cache boundary that owns its reuse. */
export function isInsideAnyCacheScope(): boolean {
  return _getUseCacheGuardContext() !== null || _isInsideUnstableCache();
}

/**
 * Throw if the current execution is inside a "use cache" or unstable_cache()
 * scope. Called by dynamic request APIs (headers, cookies, connection) to
 * prevent request-specific data from being frozen into cached results.
 *
 * @param apiName - The name of the API being called (e.g. "connection()")
 */
export function throwIfInsideCacheScope(apiName: string): void {
  if (_isInsidePublicUseCache()) {
    const error = new Error(
      `\`${apiName}\` cannot be called inside "use cache". ` +
        `If you need this data inside a cached function, call \`${apiName}\` ` +
        "outside and pass the required data as an argument.",
    );
    // Record the error on the request context so it survives user try/catch
    // and can be forwarded to the dev overlay on client-side navigations.
    // Ported from Next.js: workStore.invalidDynamicUsageError assignment in
    // packages/next/src/server/app-render/app-render.tsx
    // https://github.com/vercel/next.js/commit/f5e54c06726b571a042fce67417e40a29f6b8689
    try {
      const cacheCtx = _getUseCacheGuardContext();
      if (cacheCtx) cacheCtx.invalidDynamicUsageError = error;
      const ctx = getRequestContext();
      if (ctx) ctx.invalidDynamicUsageError = error;
      propagateInvalidDynamicUsageError(getHeadersShimState(), error);
    } catch {
      // Ignore — best-effort recording for dev diagnostics
    }
    throw error;
  }
  if (_isInsideUnstableCache()) {
    const error = new Error(
      `\`${apiName}\` cannot be called inside a function cached with \`unstable_cache()\`. ` +
        `If you need this data inside a cached function, call \`${apiName}\` ` +
        "outside and pass the required data as an argument.",
    );
    try {
      const ctx = getRequestContext();
      if (ctx) ctx.invalidDynamicUsageError = error;
      propagateInvalidDynamicUsageError(getHeadersShimState(), error);
    } catch {
      // Ignore
    }
    throw error;
  }
}

export function getHeadersAccessPhase(): HeadersAccessPhase {
  return getHeadersShimState().phase;
}
