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

import type { AsyncLocalStorage } from "node:async_hooks";
import { getOrCreateAls } from "./internal/als-registry.js";
import type {
  CacheState,
  ExecutionContextLike,
  FetchCacheState,
  HeadState,
  I18nState,
  NavigationState,
  PrivateCacheState,
  RouterState,
  RootParamsState,
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
export type UnifiedRequestContext = {
  // ── request-context.ts ─────────────────────────────────────────────
  /** Cloudflare Workers ExecutionContext, or null on Node.js dev. */
  executionContext: ExecutionContextLike | null;

  // ── cache-for-request.ts ──────────────────────────────────────────
  /** Per-request cache for cacheForRequest(). Keyed by factory function reference. */
  // oxlint-disable-next-line @typescript-eslint/no-explicit-any
  requestCache: WeakMap<(...args: any[]) => any, unknown>;

  // ── next/server after() ───────────────────────────────────────────
  /** Shared lifecycle state for work deferred until the response closes. */
  afterContext: AfterRequestContext;
} & VinextHeadersShimState &
  I18nState &
  NavigationState &
  CacheState &
  PrivateCacheState &
  FetchCacheState &
  RouterState &
  HeadState &
  RootParamsState;

export type AfterRequestContext = {
  callbacks: Array<() => unknown>;
  responseClosed: boolean;
  pendingCallbacks: number;
  completion: Promise<void> | null;
  resolveCompletion: (() => void) | null;
};

// ---------------------------------------------------------------------------
// ALS setup — stored on globalThis via Symbol.for so all Vite environments
// (RSC/SSR/client) share the same instance.
// ---------------------------------------------------------------------------

const _REQUEST_CONTEXT_ALS_KEY = Symbol.for("vinext.requestContext.als");
const _g = globalThis as unknown as Record<PropertyKey, unknown>;
const _als = getOrCreateAls<UnifiedRequestContext>("vinext.unifiedRequestContext.als");

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
    actionRevalidationKind: 0,
    pendingRevalidatedTags: new Set<string>(),
    pendingRevalidations: new Set<Promise<void>>(),
    dynamicUsageDetected: false,
    renderRequestApiUsage: new Set(),
    connectionProbe: null,
    invalidDynamicUsageError: null,
    pendingSetCookies: [],
    draftModeCookieHeader: null,
    phase: "render",
    i18nContext: null,
    serverContext: null,
    serverInsertedHTMLCallbacks: [],
    requestScopedCacheLife: null,
    unstableCacheObservations: new Map(),
    unstableCacheRevalidation: "foreground",
    _privateCache: null,
    cacheableFetchUrls: new Set<string>(),
    currentRequestTags: [],
    currentFetchSoftTags: [],
    currentFetchCacheMode: null,
    currentForceDynamicFetchDefault: false,
    dynamicFetchUrls: new Set<string>(),
    refreshStaleFetchesInForeground: false,
    isFetchDedupeActive: false,
    currentFetchDedupeEntries: new Map(),
    executionContext: _getInheritedExecutionContext(), // inherits from standalone ALS if present
    requestCache: new WeakMap(),
    afterContext: {
      callbacks: [],
      responseClosed: false,
      pendingCallbacks: 0,
      completion: null,
      resolveCompletion: null,
    },
    ssrContext: null,
    ssrHeadChildren: [],
    documentInitialHead: [],
    rootParams: null,
    ...opts,
  };
}

function ensureAfterCompletion(ctx: UnifiedRequestContext): void {
  const state = ctx.afterContext;
  if (state.resolveCompletion && state.completion) return;

  let resolveCompletion!: () => void;
  const completion = new Promise<void>((resolve) => {
    resolveCompletion = resolve;
  });
  state.completion = completion;
  state.resolveCompletion = resolveCompletion;
  ctx.executionContext?.waitUntil(completion);
}

function finishAfterCallbacksIfIdle(ctx: UnifiedRequestContext): void {
  const state = ctx.afterContext;
  if (
    !state.responseClosed ||
    state.pendingCallbacks !== 0 ||
    state.callbacks.length !== 0 ||
    !state.resolveCompletion
  ) {
    return;
  }

  const resolveCompletion = state.resolveCompletion;
  state.resolveCompletion = null;
  resolveCompletion();
}

function startAfterCallback(ctx: UnifiedRequestContext, callback: () => unknown): void {
  const state = ctx.afterContext;
  ensureAfterCompletion(ctx);
  state.pendingCallbacks += 1;
  void Promise.resolve()
    .then(callback)
    .catch((error) => {
      console.error("[vinext] after() task failed:", error);
    })
    .finally(() => {
      state.pendingCallbacks -= 1;
      finishAfterCallbacksIfIdle(ctx);
    });
}

/** Queue a callback until response close, or start it immediately once closed. */
export function queueAfterCallback(ctx: UnifiedRequestContext, callback: () => unknown): void {
  ensureAfterCompletion(ctx);
  if (ctx.afterContext.responseClosed) {
    startAfterCallback(ctx, callback);
  } else {
    ctx.afterContext.callbacks.push(callback);
  }
}

/** Bind a callback to every AsyncLocalStorage context active at registration. */
export function bindRequestContextSnapshot<T>(
  ctx: UnifiedRequestContext,
  callback: () => T,
): () => T {
  const constructor = _als.constructor as {
    snapshot?: () => <TResult>(callback: () => TResult) => TResult;
  };
  try {
    const runInSnapshot = constructor.snapshot?.();
    if (runInSnapshot) return () => runInSnapshot(callback);
  } catch {
    // Runtimes with partial AsyncLocalStorage implementations may not support snapshots.
  }
  return () => _als.run(ctx, callback);
}

/**
 * Release function-form `after()` work once the response body has closed.
 * All queued callbacks start together, matching Next.js' unbounded PromiseQueue.
 */
export async function closeAfterResponse(ctx: UnifiedRequestContext): Promise<void> {
  const state = ctx.afterContext;
  if (!state.responseClosed) {
    state.responseClosed = true;
    const callbacks = state.callbacks.splice(0);
    for (const callback of callbacks) startAfterCallback(ctx, callback);
    finishAfterCallbacksIfIdle(ctx);
  }
  return state.completion ?? Promise.resolve();
}

/** Wrap a response so deferred callbacks start on stream completion or cancellation. */
export function closeAfterResponseWithBody(
  response: Response,
  ctx: UnifiedRequestContext,
): Response {
  if (!response.body) {
    queueMicrotask(() => void closeAfterResponse(ctx));
    return response;
  }

  const passthrough = new TransformStream<Uint8Array, Uint8Array>();
  void response.body.pipeTo(passthrough.writable).then(
    () => void closeAfterResponse(ctx),
    () => void closeAfterResponse(ctx),
  );

  const wrapped = new Response(passthrough.readable, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
  (wrapped as { __vinextStreamedHtmlResponse?: boolean }).__vinextStreamedHtmlResponse = (
    response as { __vinextStreamedHtmlResponse?: boolean }
  ).__vinextStreamedHtmlResponse;
  return wrapped;
}

/**
 * Run `fn` within a unified request context scope.
 * All shim modules will read/write their state from `ctx` for the
 * duration of the call, including async continuations.
 */
export function runWithRequestContext<T>(
  ctx: UnifiedRequestContext,
  fn: () => Promise<T>,
): Promise<T>;
export function runWithRequestContext<T>(
  ctx: UnifiedRequestContext,
  fn: () => T | Promise<T>,
): T | Promise<T>;
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
  fn: () => Promise<T>,
): Promise<T>;
export function runWithUnifiedStateMutation<T>(
  mutate: (ctx: UnifiedRequestContext) => void,
  fn: () => T | Promise<T>,
): T | Promise<T>;
export function runWithUnifiedStateMutation<T>(
  mutate: (ctx: UnifiedRequestContext) => void,
  fn: () => T | Promise<T>,
): T | Promise<T> {
  const parentCtx = _als.getStore();
  if (!parentCtx) return fn();

  const childCtx = { ...parentCtx };
  // NOTE: This is a shallow clone. Object/array fields (afterContext, pendingSetCookies,
  // serverInsertedHTMLCallbacks, currentRequestTags, ssrHeadChildren), Set
  // fields (renderRequestApiUsage, pendingRevalidatedTags, pendingRevalidations,
  // cacheableFetchUrls, dynamicFetchUrls),
  // Map fields (unstableCacheObservations, _privateCache),
  // requestCache WeakMap, and object fields (headersContext,
  // i18nContext, serverContext, ssrContext, executionContext,
  // requestScopedCacheLife) still share references with the parent until
  // replaced. requestCache is intentionally shared — nested scopes within
  // the same request should see the same cached values. The mutate
  // callback must replace those reference-typed slices (for example
  // `ctx.currentRequestTags = []` or `ctx.renderRequestApiUsage = new Set()`)
  // rather than mutating them in-place (for
  // example `ctx.currentRequestTags.push(...)`) or the parent scope will
  // observe those changes too. Keep this enumeration in sync with
  // UnifiedRequestContext: when adding a new reference-typed field, add it
  // here too and verify callers still follow the replace-not-mutate rule.
  mutate(childCtx);
  return _als.run(childCtx, fn);
}

/**
 * Get the current unified request context.
 * Returns the ALS store when inside a `runWithRequestContext()` scope,
 * or a fresh detached context otherwise. Unlike the legacy per-shim fallback
 * singletons, this detached value is ephemeral — mutations do not persist
 * across calls. This is intentional to prevent state leakage outside request
 * scopes.
 *
 * Only direct callers observe this detached fallback. Shim `_getState()`
 * helpers should continue to gate on `isInsideUnifiedScope()` and fall back
 * to their standalone ALS/fallback singletons outside the unified scope.
 * If called inside a standalone `runWithExecutionContext()` scope, the
 * detached context still reflects that inherited `executionContext`.
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
