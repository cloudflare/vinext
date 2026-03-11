/**
 * Unified per-request context backed by a single AsyncLocalStorage.
 *
 * Consolidates the 5–6 nested ALS scopes that previously wrapped every
 * App Router request (headers, navigation, cache-state, private-cache,
 * fetch-cache, execution-context) into one flat store.
 *
 * Each shim module checks `isInsideUnifiedScope()` and reads its sub-fields
 * from the unified store, falling back to its own standalone ALS when
 * outside (SSR environment, Pages Router, tests).
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type {
  CacheState,
  ExecutionContextLike,
  FetchCacheState,
  HeadState,
  NavigationState,
  PrivateCacheState,
  RouterState,
  VinextHeadersShimState,
} from "./request-state-types.js";

// ---------------------------------------------------------------------------
// Unified context shape
// ---------------------------------------------------------------------------

/**
 * Flat union of all per-request state previously spread across
 * VinextHeadersShimState, NavigationState, CacheState, PrivateCacheState,
 * FetchCacheState, and ExecutionContextLike.
 *
 * Each field group is documented with its source shim module.
 */
export interface UnifiedRequestContext
  extends
    VinextHeadersShimState,
    NavigationState,
    CacheState,
    PrivateCacheState,
    FetchCacheState,
    RouterState,
    HeadState {
  // ── request-context.ts ─────────────────────────────────────────────
  /** Cloudflare Workers ExecutionContext, or null on Node.js dev. */
  executionContext: ExecutionContextLike | null;
}

// ---------------------------------------------------------------------------
// ALS setup — stored on globalThis via Symbol.for so all Vite environments
// (RSC/SSR/client) share the same instance.
// ---------------------------------------------------------------------------

const _ALS_KEY = Symbol.for("vinext.unifiedRequestContext.als");
const _REQUEST_CONTEXT_ALS_KEY = Symbol.for("vinext.requestContext.als");
const _g = globalThis as unknown as Record<PropertyKey, unknown>;
const _als = (_g[_ALS_KEY] ??=
  new AsyncLocalStorage<UnifiedRequestContext>()) as AsyncLocalStorage<UnifiedRequestContext>;

function _getInheritedExecutionContext(): ExecutionContextLike | null {
  const unifiedStore = _als.getStore();
  if (unifiedStore) return unifiedStore.executionContext;

  const executionContextAls = _g[_REQUEST_CONTEXT_ALS_KEY] as
    | AsyncLocalStorage<ExecutionContextLike | null>
    | undefined;
  return executionContextAls?.getStore() ?? null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a fresh `UnifiedRequestContext` with defaults for all fields.
 * Pass partial overrides for the fields you need to pre-populate.
 */
export function createRequestContext(opts?: Partial<UnifiedRequestContext>): UnifiedRequestContext {
  return {
    headersContext: null,
    dynamicUsageDetected: false,
    pendingSetCookies: [],
    draftModeCookieHeader: null,
    phase: "render",
    serverContext: null,
    serverInsertedHTMLCallbacks: [],
    requestScopedCacheLife: null,
    _privateCache: null,
    currentRequestTags: [],
    executionContext: _getInheritedExecutionContext(),
    ssrContext: null,
    ssrHeadElements: [],
    ...opts,
  };
}

/**
 * Run `fn` within a unified request context scope.
 * All shim modules will read/write their state from `ctx` for the
 * duration of the call, including async continuations.
 */
export function runWithRequestContext<T>(
  ctx: UnifiedRequestContext,
  fn: () => T | Promise<T>,
): T | Promise<T> {
  return _als.run(ctx, fn);
}

/**
 * Run `fn` in a nested unified scope derived from the current request context.
 * Used by legacy runWith* wrappers to reset or override one sub-state while
 * preserving proper async isolation for continuations created inside `fn`.
 * The child scope is a shallow clone of the parent store, so untouched fields
 * keep sharing their existing references while overridden slices can be reset.
 *
 * @internal
 */
export function runWithUnifiedStateMutation<T>(
  mutate: (ctx: UnifiedRequestContext) => void,
  fn: () => T | Promise<T>,
): T | Promise<T> {
  const parentCtx = _als.getStore();
  if (!parentCtx) return fn();

  const childCtx = { ...parentCtx };
  mutate(childCtx);
  return _als.run(childCtx, fn);
}

/**
 * Get the current unified request context.
 * Returns the ALS store when inside a `runWithRequestContext()` scope,
 * or a fresh detached context otherwise. Mutations to the detached value do
 * not persist across calls.
 */
export function getRequestContext(): UnifiedRequestContext {
  return _als.getStore() ?? createRequestContext();
}

/**
 * Check whether the current execution is inside a `runWithRequestContext()` scope.
 * Shim modules use this to decide whether to read from the unified store
 * or fall back to their own standalone ALS.
 */
export function isInsideUnifiedScope(): boolean {
  return _als.getStore() != null;
}
