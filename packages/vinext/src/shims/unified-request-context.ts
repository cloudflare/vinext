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
export interface UnifiedRequestContext {
  // ── headers.ts (VinextHeadersShimState) ────────────────────────────
  /** The request's headers/cookies context, or null before setup. */
  headersContext: unknown;
  /** Set to true when a component calls connection/cookies/headers/noStore. */
  dynamicUsageDetected: boolean;
  /** Accumulated Set-Cookie header strings from cookies().set()/delete(). */
  pendingSetCookies: string[];
  /** Set-Cookie header from draftMode().enable()/disable(). */
  draftModeCookieHeader: string | null;
  /** Current request phase — determines cookie mutability. */
  phase: "render" | "action" | "route-handler";

  // ── navigation-state.ts (NavigationState) ──────────────────────────
  /** Server-side navigation context (pathname, searchParams, params). */
  serverContext: unknown;
  /** useServerInsertedHTML callbacks for CSS-in-JS etc. */
  serverInsertedHTMLCallbacks: Array<() => unknown>;

  // ── cache.ts (CacheState) ──────────────────────────────────────────
  /** Request-scoped cacheLife config from page-level "use cache". */
  requestScopedCacheLife: unknown;

  // ── cache-runtime.ts (PrivateCacheState) — lazy ────────────────────
  /** Per-request cache for "use cache: private". Null until first access. */
  _privateCache: Map<string, unknown> | null;

  // ── fetch-cache.ts (FetchCacheState) ───────────────────────────────
  /** Tags collected from fetch() calls during this render pass. */
  currentRequestTags: string[];

  // ── request-context.ts ─────────────────────────────────────────────
  /** Cloudflare Workers ExecutionContext, or null on Node.js dev. */
  executionContext: unknown;

  // ── router-state.ts / head-state.ts (Pages Router) ────────────────
  /** Pages Router SSR context used by next/router during SSR. */
  ssrContext: unknown;
  /** Collected SSR <Head> HTML for the Pages Router. */
  ssrHeadElements: string[];
}

// ---------------------------------------------------------------------------
// ALS setup — stored on globalThis via Symbol.for so all Vite environments
// (RSC/SSR/client) share the same instance.
// ---------------------------------------------------------------------------

const _ALS_KEY = Symbol.for("vinext.unifiedRequestContext.als");
const _FALLBACK_KEY = Symbol.for("vinext.unifiedRequestContext.fallback");
const _REQUEST_CONTEXT_ALS_KEY = Symbol.for("vinext.requestContext.als");
const _g = globalThis as unknown as Record<PropertyKey, unknown>;
const _als = (_g[_ALS_KEY] ??=
  new AsyncLocalStorage<UnifiedRequestContext>()) as AsyncLocalStorage<UnifiedRequestContext>;

function _getInheritedExecutionContext(): unknown {
  const unifiedStore = _als.getStore();
  if (unifiedStore) return unifiedStore.executionContext;

  const executionContextAls = _g[_REQUEST_CONTEXT_ALS_KEY] as
    | AsyncLocalStorage<unknown | null>
    | undefined;
  return executionContextAls?.getStore() ?? null;
}

function _isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as Promise<T>).then === "function"
  );
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

/** Module-level fallback for environments without ALS wrapping (dev, tests). */
const _fallbackState = (_g[_FALLBACK_KEY] ??= createRequestContext()) as UnifiedRequestContext;

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
 * Apply a temporary mutation to the current unified store, then restore it
 * after `fn` completes. Used by legacy runWith* wrappers to preserve their
 * nested-scope semantics without creating another ALS layer.
 *
 * @internal
 */
export function runWithUnifiedStateMutation<T>(
  mutate: (ctx: UnifiedRequestContext) => () => void,
  fn: () => T | Promise<T>,
): T | Promise<T> {
  const ctx = _als.getStore();
  if (!ctx) return fn();

  const restore = mutate(ctx);
  try {
    const result = fn();
    if (_isPromiseLike(result)) {
      return Promise.resolve(result).finally(restore) as Promise<T>;
    }
    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
}

/**
 * Get the current unified request context.
 * Returns the ALS store when inside a `runWithRequestContext()` scope,
 * or the module-level fallback otherwise.
 */
export function getRequestContext(): UnifiedRequestContext {
  return _als.getStore() ?? _fallbackState;
}

/**
 * Check whether the current execution is inside a `runWithRequestContext()` scope.
 * Shim modules use this to decide whether to read from the unified store
 * or fall back to their own standalone ALS.
 */
export function isInsideUnifiedScope(): boolean {
  return _als.getStore() != null;
}
