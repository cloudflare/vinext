/**
 * Unified per-request context backed by a single AsyncLocalStorage.
 *
 * Consolidates the 5–6 nested ALS scopes that previously wrapped every
 * App Router request (headers, navigation, cache-state, cache-invocations,
 * fetch-cache, execution-context) into one flat store.
 *
 * Each shim module checks `isInsideUnifiedScope()` and reads its sub-fields
 * from the unified store, falling back to its own standalone ALS when
 * outside (SSR environment, Pages Router, tests).
 */

import type { AsyncLocalStorage } from "node:async_hooks";
import { getOrCreateAls } from "./internal/als-registry.js";
import type {
  CacheInvocationState,
  CacheState,
  ExecutionContextLike,
  FetchCacheState,
  HeadState,
  I18nState,
  NavigationState,
  RouterState,
  RootParamsState,
  VinextHeadersShimState,
} from "./request-state-types.js";

// ---------------------------------------------------------------------------
// Unified context shape
// ---------------------------------------------------------------------------

/**
 * Flat union of all per-request state previously spread across
 * VinextHeadersShimState, NavigationState, CacheState, CacheInvocationState,
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
  CacheInvocationState &
  FetchCacheState &
  RouterState &
  HeadState &
  RootParamsState;

export type AfterRequestContext = {
  callbacks: Array<() => unknown>;
  responseClosed: boolean;
  pendingCallbacks: number;
  pendingPromises: number;
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
    pendingCacheInvocations: null,
    completedCacheInvocations: null,
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
      pendingPromises: 0,
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

/** Track promise-form after() work that can register a callback before settling. */
export function trackAfterPromise<T>(ctx: UnifiedRequestContext, promise: Promise<T>): Promise<T> {
  ctx.afterContext.pendingPromises += 1;
  return promise.finally(() => {
    ctx.afterContext.pendingPromises -= 1;
  });
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

/**
 * Whether this request has function-form `after()` work that still needs to
 * observe the response body closing.
 *
 * Promise-form `after(promise)` is included because its continuation can
 * register a function-form `after()` before the promise settles. Function-form
 * work needs the body's close observed because its contract is "run once the
 * response has been sent". `resolveCompletion` stays non-null for as long as
 * any callback is queued or in flight, so checking it alongside the explicit
 * counters keeps this correct on re-entry after callbacks have started.
 */
export function requiresResponseCloseTracking(ctx: UnifiedRequestContext): boolean {
  const state = ctx.afterContext;
  return (
    state.callbacks.length > 0 ||
    state.pendingCallbacks > 0 ||
    state.pendingPromises > 0 ||
    state.resolveCompletion !== null
  );
}

type ResponseWithFullyBufferedBodyMetadata = Response & {
  __vinextFullyBufferedBody?: boolean;
};

/**
 * Mark a response whose body vinext constructed from a fully in-memory string
 * or byte array, as opposed to a body handed back by user code, which could
 * still be producing. With no producer left, no `after()` call can originate
 * from this body — the one signal that makes it safe for
 * `closeAfterResponseWithBody()` to skip close tracking.
 *
 * Not set for a metadata route's `result instanceof Response` passthrough (a
 * user `icon.tsx`/`opengraph-image.tsx` can return a streaming
 * `ImageResponse`) or any handler-returned `new Response(stream)` — those
 * bodies can still be producing and must keep close tracking.
 */
export function markFullyBufferedBody(response: Response): Response {
  (response as ResponseWithFullyBufferedBodyMetadata).__vinextFullyBufferedBody = true;
  return response;
}

function isFullyBufferedBody(response: Response): boolean {
  return (response as ResponseWithFullyBufferedBodyMetadata).__vinextFullyBufferedBody === true;
}

/** Preserve the internal buffered-body signal when response metadata is rebuilt. */
export function preserveFullyBufferedBodyMetadata(source: Response, target: Response): Response {
  return isFullyBufferedBody(source) ? markFullyBufferedBody(target) : target;
}

/**
 * Wrap a response so deferred `after()` callbacks start on stream completion
 * or cancellation. Skipped only when the body is marked fully buffered (see
 * `markFullyBufferedBody`) and nothing is currently registered — that lets
 * the runtime send it with an accurate `Content-Length` instead of chunked
 * transfer encoding.
 */
export function closeAfterResponseWithBody(
  response: Response,
  ctx: UnifiedRequestContext,
): Response {
  if (!response.body) {
    // Resolve the after-lifecycle now (a no-op if nothing is queued) so a
    // callback registered after this call returns doesn't wait forever on a
    // responseClosed flag nothing else will set.
    queueMicrotask(() => void closeAfterResponse(ctx));
    return response;
  }

  if (isFullyBufferedBody(response) && !requiresResponseCloseTracking(ctx)) {
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
  (wrapped as { __vinextStreamedApiResponse?: boolean }).__vinextStreamedApiResponse = (
    response as { __vinextStreamedApiResponse?: boolean }
  ).__vinextStreamedApiResponse;
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
  // Map fields (unstableCacheObservations, pendingCacheInvocations,
  // completedCacheInvocations),
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
