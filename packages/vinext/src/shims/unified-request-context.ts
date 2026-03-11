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
}

// ---------------------------------------------------------------------------
// ALS setup — stored on globalThis via Symbol.for so all Vite environments
// (RSC/SSR/client) share the same instance.
// ---------------------------------------------------------------------------

const _ALS_KEY = Symbol.for("vinext.unifiedRequestContext.als");
const _FALLBACK_KEY = Symbol.for("vinext.unifiedRequestContext.fallback");
const _g = globalThis as unknown as Record<PropertyKey, unknown>;
const _als = (_g[_ALS_KEY] ??=
  new AsyncLocalStorage<UnifiedRequestContext>()) as AsyncLocalStorage<UnifiedRequestContext>;

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
    executionContext: null,
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
