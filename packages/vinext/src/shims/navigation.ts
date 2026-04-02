/**
 * next/navigation shim
 *
 * App Router navigation hooks. These work on both server (RSC) and client.
 * Server-side: reads from a request context set by the RSC handler.
 * Client-side: reads from browser Location API and provides navigation.
 */

// Use namespace import for RSC safety: the react-server condition doesn't export
// createContext/useContext/useSyncExternalStore as named exports, and strict ESM
// would throw at link time for missing bindings. With `import * as React`, the
// bindings are just `undefined` on the namespace object and we can guard at runtime.
import * as React from "react";
import { notifyAppRouterTransitionStart } from "../client/instrumentation-client-state.js";
import { createAppPayloadCacheKey } from "../server/app-elements.js";
import { toBrowserNavigationHref, toSameOriginAppPath } from "./url-utils.js";
import { stripBasePath } from "../utils/base-path.js";
import { ReadonlyURLSearchParams } from "./readonly-url-search-params.js";

// ─── Layout segment context ───────────────────────────────────────────────────
// Stores the child segments below the current layout. Each layout wraps its
// children with a provider whose value is the remaining route tree segments
// (including route groups, with dynamic params resolved to actual values).
// Created lazily because `React.createContext` is NOT available in the
// react-server condition of React. In the RSC environment, this remains null.
// The shared context lives behind a global singleton so provider/hook pairs
// still line up if Vite loads this shim through multiple resolved module IDs.
const _LAYOUT_SEGMENT_CTX_KEY = Symbol.for("vinext.layoutSegmentContext");
const _SERVER_INSERTED_HTML_CTX_KEY = Symbol.for("vinext.serverInsertedHTMLContext");

/**
 * Map of parallel route key → child segments below the current layout.
 * The "children" key is always present (the default parallel route).
 * Named parallel routes add their own keys (e.g., "team", "analytics").
 *
 * Arrays are mutable (`string[]`) to match Next.js's public API return type
 * without requiring `as` casts. The map itself is Readonly — no key addition.
 */
export type SegmentMap = Readonly<Record<string, string[]>> & { readonly children: string[] };

type _LayoutSegmentGlobal = typeof globalThis & {
  [_LAYOUT_SEGMENT_CTX_KEY]?: React.Context<SegmentMap> | null;
  [_SERVER_INSERTED_HTML_CTX_KEY]?: React.Context<
    ((callback: () => unknown) => void) | null
  > | null;
};

// ─── ServerInsertedHTML context ────────────────────────────────────────────────
// Used by CSS-in-JS libraries (Apollo Client, styled-components, emotion) to
// register HTML injection callbacks during SSR via useContext().
// The SSR entry wraps the rendered tree with a Provider whose value is a
// callback registration function (useServerInsertedHTML).
//
// In Next.js, ServerInsertedHTMLContext holds a function:
//   (callback: () => React.ReactNode) => void
// Libraries call useContext(ServerInsertedHTMLContext) to get this function,
// then call it to register callbacks that inject HTML during SSR.
//
// Created eagerly at module load time. In the RSC environment (react-server
// condition), createContext isn't available so this will be null.

function getServerInsertedHTMLContext(): React.Context<
  ((callback: () => unknown) => void) | null
> | null {
  if (typeof React.createContext !== "function") return null;

  const globalState = globalThis as _LayoutSegmentGlobal;
  if (!globalState[_SERVER_INSERTED_HTML_CTX_KEY]) {
    globalState[_SERVER_INSERTED_HTML_CTX_KEY] = React.createContext<
      ((callback: () => unknown) => void) | null
    >(null);
  }

  return globalState[_SERVER_INSERTED_HTML_CTX_KEY] ?? null;
}

export const ServerInsertedHTMLContext: React.Context<
  ((callback: () => unknown) => void) | null
> | null = getServerInsertedHTMLContext();

/**
 * Get or create the layout segment context.
 * Returns null in the RSC environment (createContext unavailable).
 */
export function getLayoutSegmentContext(): React.Context<SegmentMap> | null {
  if (typeof React.createContext !== "function") return null;

  const globalState = globalThis as _LayoutSegmentGlobal;
  if (!globalState[_LAYOUT_SEGMENT_CTX_KEY]) {
    globalState[_LAYOUT_SEGMENT_CTX_KEY] = React.createContext<SegmentMap>({ children: [] });
  }

  return globalState[_LAYOUT_SEGMENT_CTX_KEY] ?? null;
}

/**
 * Read the child segments for a parallel route below the current layout.
 * Returns [] if no context is available (RSC environment, outside React tree)
 * or if the requested key is not present in the segment map.
 */
/* oxlint-disable eslint-plugin-react-hooks/rules-of-hooks */
function useChildSegments(parallelRoutesKey: string = "children"): string[] {
  const ctx = getLayoutSegmentContext();
  if (!ctx) return [];
  // useContext is safe here because if createContext exists, useContext does too.
  // This branch is only taken in SSR/Browser, never in RSC.
  // Try/catch for unit tests that call this hook outside a React render tree.
  try {
    const segmentMap = React.useContext(ctx);
    return segmentMap[parallelRoutesKey] ?? [];
  } catch {
    return [];
  }
}
/* oxlint-enable eslint-plugin-react-hooks/rules-of-hooks */

// ---------------------------------------------------------------------------
// Server-side request context (set by the RSC entry before rendering)
// ---------------------------------------------------------------------------

export type NavigationContext = {
  pathname: string;
  searchParams: URLSearchParams;
  params: Record<string, string | string[]>;
};

const _READONLY_SEARCH_PARAMS = Symbol("vinext.navigation.readonlySearchParams");
const _READONLY_SEARCH_PARAMS_SOURCE = Symbol("vinext.navigation.readonlySearchParamsSource");

type NavigationContextWithReadonlyCache = NavigationContext & {
  [_READONLY_SEARCH_PARAMS]?: ReadonlyURLSearchParams;
  [_READONLY_SEARCH_PARAMS_SOURCE]?: URLSearchParams;
};

// ---------------------------------------------------------------------------
// Server-side navigation state lives in a separate server-only module
// (navigation-state.ts) that uses AsyncLocalStorage for request isolation.
// This module is bundled for the browser, so it can't import node:async_hooks.
//
// On the server: state functions are set by navigation-state.ts at import time.
// On the client: _serverContext falls back to null (hooks use window instead).
//
// Global accessor pattern (issue #688):
// Vite's multi-environment dev mode can create separate module instances of
// this file for the SSR entry vs "use client" components. When that happens,
// _registerStateAccessors only updates the SSR entry's instance, leaving the
// "use client" instance with the default (null) fallbacks.
//
// To fix this, navigation-state.ts also stores the accessors on globalThis
// via Symbol.for, and the defaults here check for that global before falling
// back to module-level state. This ensures all module instances can reach the
// ALS-backed state regardless of which instance was registered.
// ---------------------------------------------------------------------------

type _StateAccessors = {
  getServerContext: () => NavigationContext | null;
  setServerContext: (ctx: NavigationContext | null) => void;
  getInsertedHTMLCallbacks: () => Array<() => unknown>;
  clearInsertedHTMLCallbacks: () => void;
};

export const GLOBAL_ACCESSORS_KEY = Symbol.for("vinext.navigation.globalAccessors");
const _GLOBAL_ACCESSORS_KEY = GLOBAL_ACCESSORS_KEY;
type _GlobalWithAccessors = typeof globalThis & { [_GLOBAL_ACCESSORS_KEY]?: _StateAccessors };

function _getGlobalAccessors(): _StateAccessors | undefined {
  return (globalThis as _GlobalWithAccessors)[_GLOBAL_ACCESSORS_KEY];
}

let _serverContext: NavigationContext | null = null;
let _serverInsertedHTMLCallbacks: Array<() => unknown> = [];

// These are overridden by navigation-state.ts on the server to use ALS.
// The defaults check globalThis for cross-module-instance access (issue #688).
let _getServerContext = (): NavigationContext | null => {
  const g = _getGlobalAccessors();
  return g ? g.getServerContext() : _serverContext;
};
let _setServerContext = (ctx: NavigationContext | null): void => {
  const g = _getGlobalAccessors();
  if (g) {
    g.setServerContext(ctx);
  } else {
    _serverContext = ctx;
  }
};
let _getInsertedHTMLCallbacks = (): Array<() => unknown> => {
  const g = _getGlobalAccessors();
  return g ? g.getInsertedHTMLCallbacks() : _serverInsertedHTMLCallbacks;
};
let _clearInsertedHTMLCallbacks = (): void => {
  const g = _getGlobalAccessors();
  if (g) {
    g.clearInsertedHTMLCallbacks();
  } else {
    _serverInsertedHTMLCallbacks = [];
  }
};

/**
 * Register ALS-backed state accessors. Called by navigation-state.ts on import.
 * @internal
 */
export function _registerStateAccessors(accessors: _StateAccessors): void {
  _getServerContext = accessors.getServerContext;
  _setServerContext = accessors.setServerContext;
  _getInsertedHTMLCallbacks = accessors.getInsertedHTMLCallbacks;
  _clearInsertedHTMLCallbacks = accessors.clearInsertedHTMLCallbacks;
}

/**
 * Get the navigation context for the current SSR/RSC render.
 * Reads from AsyncLocalStorage when available (concurrent-safe),
 * otherwise falls back to module-level state.
 */
export function getNavigationContext(): NavigationContext | null {
  return _getServerContext();
}

/**
 * Set the navigation context for the current SSR/RSC render.
 * Called by the framework entry before rendering each request.
 */
export function setNavigationContext(ctx: NavigationContext | null): void {
  _setServerContext(ctx);
}

// ---------------------------------------------------------------------------
// Client-side state
// ---------------------------------------------------------------------------

const isServer = typeof window === "undefined";

/** basePath from next.config.js, injected by the plugin at build time */
export const __basePath: string = process.env.__NEXT_ROUTER_BASEPATH ?? "";

// ---------------------------------------------------------------------------
// RSC prefetch cache utilities (shared between link.tsx and browser entry)
// ---------------------------------------------------------------------------

/** Maximum number of entries in the RSC prefetch cache. */
export const MAX_PREFETCH_CACHE_SIZE = 50;

/** TTL for prefetch cache entries in ms (matches Next.js static prefetch TTL). */
export const PREFETCH_CACHE_TTL = 30_000;

export const VINEXT_INTERCEPTION_CONTEXT_HISTORY_STATE_KEY = "__vinext_interceptionContext";

/** A buffered RSC response stored as an ArrayBuffer for replay. */
export type CachedRscResponse = {
  buffer: ArrayBuffer;
  contentType: string;
  mountedSlotsHeader?: string | null;
  paramsHeader: string | null;
  url: string;
};

export type PrefetchCacheEntry = {
  snapshot?: CachedRscResponse;
  pending?: Promise<void>;
  timestamp: number;
};

/**
 * Convert a pathname (with optional query/hash) to its .rsc URL.
 * Strips trailing slashes before appending `.rsc` so that cache keys
 * are consistent regardless of the `trailingSlash` config setting.
 */
export function toRscUrl(href: string): string {
  const [beforeHash] = href.split("#");
  const qIdx = beforeHash.indexOf("?");
  const pathname = qIdx === -1 ? beforeHash : beforeHash.slice(0, qIdx);
  const query = qIdx === -1 ? "" : beforeHash.slice(qIdx);
  // Strip trailing slash (but preserve "/" root) for consistent cache keys
  const normalizedPath =
    pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  return normalizedPath + ".rsc" + query;
}

export function readHistoryStateInterceptionContext(state: unknown): string | null {
  if (!state || typeof state !== "object") {
    return null;
  }

  const value = Reflect.get(state, VINEXT_INTERCEPTION_CONTEXT_HISTORY_STATE_KEY);
  return typeof value === "string" ? value : null;
}

export function getCurrentInterceptionContext(): string | null {
  if (isServer) {
    return null;
  }

  return (
    readHistoryStateInterceptionContext(window.history.state) ??
    stripBasePath(window.location.pathname, __basePath)
  );
}

/** Get or create the shared in-memory RSC prefetch cache on window. */
export function getPrefetchCache(): Map<string, PrefetchCacheEntry> {
  if (isServer) return new Map();
  if (!window.__VINEXT_RSC_PREFETCH_CACHE__) {
    window.__VINEXT_RSC_PREFETCH_CACHE__ = new Map<string, PrefetchCacheEntry>();
  }
  return window.__VINEXT_RSC_PREFETCH_CACHE__;
}

/**
 * Get or create the shared set of already-prefetched RSC URLs on window.
 * Keyed by interception-aware cache key so distinct source routes do not alias.
 */
export function getPrefetchedUrls(): Set<string> {
  if (isServer) return new Set();
  if (!window.__VINEXT_RSC_PREFETCHED_URLS__) {
    window.__VINEXT_RSC_PREFETCHED_URLS__ = new Set<string>();
  }
  return window.__VINEXT_RSC_PREFETCHED_URLS__;
}

/**
 * Evict prefetch cache entries if at capacity.
 * First sweeps expired entries, then falls back to FIFO eviction.
 */
function evictPrefetchCacheIfNeeded(): void {
  const cache = getPrefetchCache();
  if (cache.size < MAX_PREFETCH_CACHE_SIZE) return;

  const now = Date.now();
  const prefetched = getPrefetchedUrls();

  for (const [key, entry] of cache) {
    if (now - entry.timestamp >= PREFETCH_CACHE_TTL) {
      cache.delete(key);
      prefetched.delete(key);
    }
  }

  while (cache.size >= MAX_PREFETCH_CACHE_SIZE) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) {
      cache.delete(oldest);
      prefetched.delete(oldest);
    } else {
      break;
    }
  }
}

/**
 * Store a prefetched RSC response in the cache by snapshotting it to an
 * ArrayBuffer.  The snapshot completes asynchronously; during that window
 * the entry is marked `pending` so consumePrefetchResponse() will skip it
 * (the caller falls back to a fresh fetch, which is acceptable).
 *
 * Prefer prefetchRscResponse() for new call-sites — it handles the full
 * prefetch lifecycle including dedup and explicit slot context.
 * storePrefetchResponse() is kept for backward compatibility and test
 * helpers. It is slot-unaware: the snapshot's mountedSlotsHeader comes
 * from the response headers, not the caller, so consumePrefetchResponse
 * may reject the entry if the caller's slot context differs.
 *
 * NB: Caller is responsible for managing getPrefetchedUrls() — this
 * function only stores the response in the prefetch cache.
 */
export function storePrefetchResponse(
  rscUrl: string,
  response: Response,
  interceptionContext: string | null = null,
): void {
  const cacheKey = createAppPayloadCacheKey(rscUrl, interceptionContext);
  evictPrefetchCacheIfNeeded();
  const entry: PrefetchCacheEntry = { timestamp: Date.now() };
  entry.pending = snapshotRscResponse(response)
    .then((snapshot) => {
      entry.snapshot = snapshot;
    })
    .catch(() => {
      getPrefetchCache().delete(cacheKey);
    })
    .finally(() => {
      entry.pending = undefined;
    });
  getPrefetchCache().set(cacheKey, entry);
}

/**
 * Snapshot an RSC response to an ArrayBuffer for caching and replay.
 * Consumes the response body and stores it with content-type and URL metadata.
 */
export async function snapshotRscResponse(response: Response): Promise<CachedRscResponse> {
  const buffer = await response.arrayBuffer();
  return {
    buffer,
    contentType: response.headers.get("content-type") ?? "text/x-component",
    mountedSlotsHeader: response.headers.get("X-Vinext-Mounted-Slots"),
    paramsHeader: response.headers.get("X-Vinext-Params"),
    url: response.url,
  };
}

/**
 * Reconstruct a Response from a cached RSC snapshot.
 * Creates a new Response with the original ArrayBuffer so createFromFetch
 * can consume the stream from scratch.
 *
 * NOTE: The reconstructed Response always has `url === ""` — the Response
 * constructor does not accept a `url` option, and `response.url` is read-only
 * set by the fetch infrastructure. Callers that need the original URL should
 * read it from `cached.url` directly rather than from the restored Response.
 *
 * @param copy - When true (default), copies the ArrayBuffer so the cached
 *   snapshot remains replayable (needed for the visited-response cache).
 *   Pass false for single-consumption paths (e.g. prefetch cache entries
 *   that are deleted after consumption) to avoid the extra allocation.
 */
export function restoreRscResponse(cached: CachedRscResponse, copy = true): Response {
  const headers = new Headers({ "content-type": cached.contentType });
  if (cached.mountedSlotsHeader != null) {
    headers.set("X-Vinext-Mounted-Slots", cached.mountedSlotsHeader);
  }
  if (cached.paramsHeader != null) {
    headers.set("X-Vinext-Params", cached.paramsHeader);
  }

  return new Response(copy ? cached.buffer.slice(0) : cached.buffer, {
    status: 200,
    headers,
  });
}

/**
 * Prefetch an RSC response and snapshot it for later consumption.
 * Stores the in-flight promise so immediate clicks can await it instead
 * of firing a duplicate fetch.
 * Enforces a maximum cache size to prevent unbounded memory growth on
 * link-heavy pages.
 */
export function prefetchRscResponse(
  rscUrl: string,
  fetchPromise: Promise<Response>,
  interceptionContext: string | null = null,
  mountedSlotsHeader: string | null = null,
): void {
  const cacheKey = createAppPayloadCacheKey(rscUrl, interceptionContext);
  const cache = getPrefetchCache();
  const prefetched = getPrefetchedUrls();
  const now = Date.now();

  const entry: PrefetchCacheEntry = { timestamp: now };

  entry.pending = fetchPromise
    .then(async (response) => {
      if (response.ok) {
        entry.snapshot = {
          ...(await snapshotRscResponse(response)),
          // Prefetch compatibility is defined by the slot context at fetch
          // time, not by whatever header a reused response happens to carry.
          mountedSlotsHeader,
        };
      } else {
        prefetched.delete(cacheKey);
        cache.delete(cacheKey);
      }
    })
    .catch(() => {
      prefetched.delete(cacheKey);
      cache.delete(cacheKey);
    })
    .finally(() => {
      entry.pending = undefined;
    });

  // Insert the new entry before evicting. FIFO evicts from the front of the
  // Map (oldest insertion order), so the just-appended entry is safe — only
  // entries inserted before it are candidates for removal.
  cache.set(cacheKey, entry);
  evictPrefetchCacheIfNeeded();
}

/**
 * Consume a prefetched response for a given rscUrl.
 * Only returns settled (non-pending) snapshots synchronously.
 * Returns null if the entry is still in flight or doesn't exist.
 */
export function consumePrefetchResponse(
  rscUrl: string,
  interceptionContext: string | null = null,
  mountedSlotsHeader: string | null = null,
): CachedRscResponse | null {
  const cacheKey = createAppPayloadCacheKey(rscUrl, interceptionContext);
  const cache = getPrefetchCache();
  const entry = cache.get(cacheKey);
  if (!entry) return null;

  // Don't consume pending entries — let the navigation fetch independently.
  if (entry.pending) return null;

  cache.delete(cacheKey);
  getPrefetchedUrls().delete(cacheKey);

  if (entry.snapshot) {
    if ((entry.snapshot.mountedSlotsHeader ?? null) !== mountedSlotsHeader) {
      // Entry was already removed above. Slot mismatch means the prefetch
      // used stale slot context and cannot be safely reused.
      return null;
    }
    if (Date.now() - entry.timestamp >= PREFETCH_CACHE_TTL) {
      return null;
    }
    return entry.snapshot;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Client navigation state — stored on a Symbol.for global to survive
// multiple Vite module instances loading this file through different IDs.
// ---------------------------------------------------------------------------

type NavigationListener = () => void;
const _CLIENT_NAV_STATE_KEY = Symbol.for("vinext.clientNavigationState");
const _MOUNTED_SLOTS_HEADER_KEY = Symbol.for("vinext.mountedSlotsHeader");

type ClientNavigationState = {
  listeners: Set<NavigationListener>;
  cachedSearch: string;
  cachedReadonlySearchParams: ReadonlyURLSearchParams;
  cachedPathname: string;
  clientParams: Record<string, string | string[]>;
  clientParamsJson: string;
  pendingClientParams: Record<string, string | string[]> | null;
  pendingClientParamsJson: string | null;
  originalPushState: typeof window.history.pushState;
  originalReplaceState: typeof window.history.replaceState;
  patchInstalled: boolean;
  hasPendingNavigationUpdate: boolean;
  suppressUrlNotifyCount: number;
  navigationSnapshotActiveCount: number;
};

type ClientNavigationGlobal = typeof globalThis & {
  [_CLIENT_NAV_STATE_KEY]?: ClientNavigationState;
  [_MOUNTED_SLOTS_HEADER_KEY]?: string | null;
};

export function setMountedSlotsHeader(header: string | null): void {
  if (isServer) return;
  const globalState = window as ClientNavigationGlobal;
  globalState[_MOUNTED_SLOTS_HEADER_KEY] = header;
}

export function getMountedSlotsHeader(): string | null {
  if (isServer) return null;
  const globalState = window as ClientNavigationGlobal;
  return globalState[_MOUNTED_SLOTS_HEADER_KEY] ?? null;
}

function getClientNavigationState(): ClientNavigationState | null {
  if (isServer) return null;

  const globalState = window as ClientNavigationGlobal;
  globalState[_CLIENT_NAV_STATE_KEY] ??= {
    listeners: new Set<NavigationListener>(),
    cachedSearch: window.location.search,
    cachedReadonlySearchParams: new ReadonlyURLSearchParams(window.location.search),
    cachedPathname: stripBasePath(window.location.pathname, __basePath),
    clientParams: {},
    clientParamsJson: "{}",
    pendingClientParams: null,
    pendingClientParamsJson: null,
    // NB: These capture the currently installed history methods, not guaranteed
    // native ones. If a third-party library (analytics, router) has already patched
    // history methods before this module loads, we intentionally preserve that
    // wrapper. With Symbol.for global state, the first module instance to load wins.
    originalPushState: window.history.pushState.bind(window.history),
    originalReplaceState: window.history.replaceState.bind(window.history),
    patchInstalled: false,
    hasPendingNavigationUpdate: false,
    suppressUrlNotifyCount: 0,
    navigationSnapshotActiveCount: 0,
  };

  return globalState[_CLIENT_NAV_STATE_KEY]!;
}

function notifyNavigationListeners(): void {
  const state = getClientNavigationState();
  if (!state) return;
  for (const fn of state.listeners) fn();
}

// Cached URLSearchParams, pathname, etc. for referential stability
// useSyncExternalStore compares snapshots with Object.is — avoid creating
// new instances on every render (infinite re-renders).
let _cachedEmptyServerSearchParams: ReadonlyURLSearchParams | null = null;

/**
 * Get cached pathname snapshot for useSyncExternalStore.
 * Note: Returns cached value from ClientNavigationState, not live window.location.
 * The cache is updated by syncCommittedUrlStateFromLocation() after navigation commits.
 * This ensures referential stability and prevents infinite re-renders.
 * External pushState/replaceState while URL notifications are suppressed won't
 * be visible until the next commit.
 */
function getPathnameSnapshot(): string {
  return getClientNavigationState()?.cachedPathname ?? "/";
}

let _cachedEmptyClientSearchParams: ReadonlyURLSearchParams | null = null;

/**
 * Get cached search params snapshot for useSyncExternalStore.
 * Note: Returns cached value from ClientNavigationState, not live window.location.search.
 * The cache is updated by syncCommittedUrlStateFromLocation() after navigation commits.
 * This ensures referential stability and prevents infinite re-renders.
 * External pushState/replaceState while URL notifications are suppressed won't
 * be visible until the next commit.
 */
function getSearchParamsSnapshot(): ReadonlyURLSearchParams {
  const cached = getClientNavigationState()?.cachedReadonlySearchParams;
  if (cached) return cached;
  if (_cachedEmptyClientSearchParams === null) {
    _cachedEmptyClientSearchParams = new ReadonlyURLSearchParams();
  }
  return _cachedEmptyClientSearchParams;
}

function syncCommittedUrlStateFromLocation(): boolean {
  const state = getClientNavigationState();
  if (!state) return false;

  let changed = false;

  const pathname = stripBasePath(window.location.pathname, __basePath);
  if (pathname !== state.cachedPathname) {
    state.cachedPathname = pathname;
    changed = true;
  }

  const search = window.location.search;
  if (search !== state.cachedSearch) {
    state.cachedSearch = search;
    state.cachedReadonlySearchParams = new ReadonlyURLSearchParams(search);
    changed = true;
  }

  return changed;
}

function getServerSearchParamsSnapshot(): ReadonlyURLSearchParams {
  const ctx = _getServerContext() as NavigationContextWithReadonlyCache | null;

  if (!ctx) {
    // No server context available - return cached empty instance
    if (_cachedEmptyServerSearchParams === null) {
      _cachedEmptyServerSearchParams = new ReadonlyURLSearchParams();
    }
    return _cachedEmptyServerSearchParams;
  }

  const source = ctx.searchParams;
  const cached = ctx[_READONLY_SEARCH_PARAMS];
  const cachedSource = ctx[_READONLY_SEARCH_PARAMS_SOURCE];

  // Return cached wrapper if source hasn't changed
  if (cached && cachedSource === source) {
    return cached;
  }

  // Create and cache new wrapper
  const readonly = new ReadonlyURLSearchParams(source);
  ctx[_READONLY_SEARCH_PARAMS] = readonly;
  ctx[_READONLY_SEARCH_PARAMS_SOURCE] = source;

  return readonly;
}

// ---------------------------------------------------------------------------
// Navigation snapshot activation flag
//
// The render snapshot context provides pending URL values during transitions.
// After the transition commits, the snapshot becomes stale and must NOT shadow
// subsequent external URL changes (user pushState/replaceState). This flag
// tracks whether a navigation transition is in progress — hooks only prefer
// the snapshot while it's active.
// ---------------------------------------------------------------------------

/**
 * Mark a navigation snapshot as active. Called before startTransition
 * in renderNavigationPayload. While active, hooks prefer the snapshot
 * context value over useSyncExternalStore. Uses a counter (not boolean)
 * to handle overlapping navigations — rapid clicks can interleave
 * activate/deactivate if multiple transitions are in flight.
 */
export function activateNavigationSnapshot(): void {
  const state = getClientNavigationState();
  if (state) state.navigationSnapshotActiveCount++;
}

// Track client-side params (set during RSC hydration/navigation)
// We cache the params object for referential stability — only create a new
// object when the params actually change (shallow key/value comparison).
const _EMPTY_PARAMS: Record<string, string | string[]> = {};

// ---------------------------------------------------------------------------
// Client navigation render snapshot — provides pending URL values to hooks
// during a startTransition so they see the destination, not the stale URL.
// ---------------------------------------------------------------------------

export type ClientNavigationRenderSnapshot = {
  pathname: string;
  searchParams: ReadonlyURLSearchParams;
  params: Record<string, string | string[]>;
};

const _CLIENT_NAV_RENDER_CTX_KEY = Symbol.for("vinext.clientNavigationRenderContext");
type _ClientNavRenderGlobal = typeof globalThis & {
  [_CLIENT_NAV_RENDER_CTX_KEY]?: React.Context<ClientNavigationRenderSnapshot | null> | null;
};

export function getClientNavigationRenderContext(): React.Context<ClientNavigationRenderSnapshot | null> | null {
  if (typeof React.createContext !== "function") return null;

  const globalState = globalThis as _ClientNavRenderGlobal;
  if (!globalState[_CLIENT_NAV_RENDER_CTX_KEY]) {
    globalState[_CLIENT_NAV_RENDER_CTX_KEY] =
      React.createContext<ClientNavigationRenderSnapshot | null>(null);
  }

  return globalState[_CLIENT_NAV_RENDER_CTX_KEY] ?? null;
}

/* oxlint-disable eslint-plugin-react-hooks/rules-of-hooks */
function useClientNavigationRenderSnapshot(): ClientNavigationRenderSnapshot | null {
  const ctx = getClientNavigationRenderContext();
  if (!ctx || typeof React.useContext !== "function") return null;
  try {
    return React.useContext(ctx);
  } catch {
    return null;
  }
}
/* oxlint-enable eslint-plugin-react-hooks/rules-of-hooks */

export function createClientNavigationRenderSnapshot(
  href: string,
  params: Record<string, string | string[]>,
): ClientNavigationRenderSnapshot {
  const origin = typeof window !== "undefined" ? window.location.origin : "http://localhost";
  const url = new URL(href, origin);

  return {
    pathname: stripBasePath(url.pathname, __basePath),
    searchParams: new ReadonlyURLSearchParams(url.search),
    params,
  };
}

// Module-level fallback for environments without window (tests, SSR).
let _fallbackClientParams: Record<string, string | string[]> = _EMPTY_PARAMS;
let _fallbackClientParamsJson = "{}";

export function setClientParams(params: Record<string, string | string[]>): void {
  const state = getClientNavigationState();
  if (!state) {
    const json = JSON.stringify(params);
    if (json !== _fallbackClientParamsJson) {
      _fallbackClientParams = params;
      _fallbackClientParamsJson = json;
    }
    return;
  }

  const json = JSON.stringify(params);
  if (json !== state.clientParamsJson) {
    state.clientParams = params;
    state.clientParamsJson = json;
    state.pendingClientParams = null;
    state.pendingClientParamsJson = null;
    notifyNavigationListeners();
  }
}

export function replaceClientParamsWithoutNotify(params: Record<string, string | string[]>): void {
  const state = getClientNavigationState();
  if (!state) return;

  const json = JSON.stringify(params);
  if (json !== state.clientParamsJson && json !== state.pendingClientParamsJson) {
    state.pendingClientParams = params;
    state.pendingClientParamsJson = json;
    state.hasPendingNavigationUpdate = true;
  }
}

/** Get the current client params (for testing referential stability). */
export function getClientParams(): Record<string, string | string[]> {
  return getClientNavigationState()?.clientParams ?? _fallbackClientParams;
}

function getClientParamsSnapshot(): Record<string, string | string[]> {
  return getClientNavigationState()?.clientParams ?? _EMPTY_PARAMS;
}

function getServerParamsSnapshot(): Record<string, string | string[]> {
  return _getServerContext()?.params ?? _EMPTY_PARAMS;
}

function subscribeToNavigation(cb: () => void): () => void {
  const state = getClientNavigationState();
  if (!state) return () => {};

  state.listeners.add(cb);
  return () => {
    state.listeners.delete(cb);
  };
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

/* oxlint-disable eslint-plugin-react-hooks/rules-of-hooks */
/**
 * Returns the current pathname.
 * Server: from request context. Client: from window.location.
 */
export function usePathname(): string {
  if (isServer) {
    // During SSR of "use client" components, the navigation context may not be set.
    // Return a safe fallback — the client will hydrate with the real value.
    return _getServerContext()?.pathname ?? "/";
  }
  const renderSnapshot = useClientNavigationRenderSnapshot();
  // Client-side: use the hook system for reactivity
  const pathname = React.useSyncExternalStore(
    subscribeToNavigation,
    getPathnameSnapshot,
    () => _getServerContext()?.pathname ?? "/",
  );
  // Prefer the render snapshot during an active navigation transition so
  // hooks return the pending URL, not the stale committed one. After commit,
  // fall through to useSyncExternalStore so user pushState/replaceState
  // calls are immediately reflected.
  if (renderSnapshot && (getClientNavigationState()?.navigationSnapshotActiveCount ?? 0) > 0) {
    return renderSnapshot.pathname;
  }
  return pathname;
}
/* oxlint-enable eslint-plugin-react-hooks/rules-of-hooks */

/* oxlint-disable eslint-plugin-react-hooks/rules-of-hooks */
/**
 * Returns the current search params as a read-only URLSearchParams.
 */
export function useSearchParams(): ReadonlyURLSearchParams {
  if (isServer) {
    // During SSR for "use client" components, the navigation context may not be set.
    // Return a safe fallback — the client will hydrate with the real value.
    return getServerSearchParamsSnapshot();
  }
  const renderSnapshot = useClientNavigationRenderSnapshot();
  const searchParams = React.useSyncExternalStore(
    subscribeToNavigation,
    getSearchParamsSnapshot,
    getServerSearchParamsSnapshot,
  );
  if (renderSnapshot && (getClientNavigationState()?.navigationSnapshotActiveCount ?? 0) > 0) {
    return renderSnapshot.searchParams;
  }
  return searchParams;
}
/* oxlint-enable eslint-plugin-react-hooks/rules-of-hooks */

/* oxlint-disable eslint-plugin-react-hooks/rules-of-hooks */
/**
 * Returns the dynamic params for the current route.
 */
export function useParams<
  T extends Record<string, string | string[]> = Record<string, string | string[]>,
>(): T {
  if (isServer) {
    // During SSR for "use client" components, the navigation context may not be set.
    return (_getServerContext()?.params ?? _EMPTY_PARAMS) as T;
  }
  const renderSnapshot = useClientNavigationRenderSnapshot();
  const params = React.useSyncExternalStore(
    subscribeToNavigation,
    getClientParamsSnapshot as () => T,
    getServerParamsSnapshot as () => T,
  );
  if (renderSnapshot && (getClientNavigationState()?.navigationSnapshotActiveCount ?? 0) > 0) {
    return renderSnapshot.params as T;
  }
  return params;
}
/* oxlint-enable eslint-plugin-react-hooks/rules-of-hooks */

/**
 * Check if a href is an external URL (any URL scheme per RFC 3986, or protocol-relative).
 */
function isExternalUrl(href: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//");
}

/**
 * Check if a href is only a hash change relative to the current URL.
 */
function isHashOnlyChange(href: string): boolean {
  if (typeof window === "undefined") return false;
  if (href.startsWith("#")) return true;
  try {
    const current = new URL(window.location.href);
    const next = new URL(href, window.location.href);
    // Strip basePath from both pathnames for consistent comparison
    // (matches how isSameRoute handles basePath in app-browser-entry.ts)
    const strippedCurrentPath = stripBasePath(current.pathname, __basePath);
    const strippedNextPath = stripBasePath(next.pathname, __basePath);
    return (
      strippedCurrentPath === strippedNextPath && current.search === next.search && next.hash !== ""
    );
  } catch {
    return false;
  }
}

/**
 * Scroll to a hash target element, or to the top if no hash.
 */
function scrollToHash(hash: string): void {
  if (!hash || hash === "#") {
    window.scrollTo(0, 0);
    return;
  }
  const id = hash.slice(1);
  const element = document.getElementById(id);
  if (element) {
    element.scrollIntoView({ behavior: "auto" });
  }
}

// ---------------------------------------------------------------------------
// History method wrappers — suppress notifications for internal updates
// ---------------------------------------------------------------------------

function withSuppressedUrlNotifications<T>(fn: () => T): T {
  const state = getClientNavigationState();
  if (!state) {
    return fn();
  }

  state.suppressUrlNotifyCount += 1;
  try {
    return fn();
  } finally {
    state.suppressUrlNotifyCount -= 1;
  }
}

export function commitClientNavigationState(): void {
  if (isServer) return;
  const state = getClientNavigationState();
  if (!state) return;

  // Only decrement the snapshot counter if a snapshot was previously activated.
  // Several code paths call commit without a prior activateNavigationSnapshot()
  // — hash-only changes (navigateClientSide), Pages Router popstate, and
  // patched history.pushState/replaceState — which legitimately have count == 0.
  if (state.navigationSnapshotActiveCount > 0) {
    state.navigationSnapshotActiveCount -= 1;
  }

  const urlChanged = syncCommittedUrlStateFromLocation();
  if (state.pendingClientParams !== null && state.pendingClientParamsJson !== null) {
    state.clientParams = state.pendingClientParams;
    state.clientParamsJson = state.pendingClientParamsJson;
    state.pendingClientParams = null;
    state.pendingClientParamsJson = null;
  }
  const shouldNotify = urlChanged || state.hasPendingNavigationUpdate;
  state.hasPendingNavigationUpdate = false;

  if (shouldNotify) {
    notifyNavigationListeners();
  }
}

export function pushHistoryStateWithoutNotify(
  data: unknown,
  unused: string,
  url?: string | URL | null,
): void {
  withSuppressedUrlNotifications(() => {
    const state = getClientNavigationState();
    state?.originalPushState.call(window.history, data, unused, url);
  });
}

export function replaceHistoryStateWithoutNotify(
  data: unknown,
  unused: string,
  url?: string | URL | null,
): void {
  withSuppressedUrlNotifications(() => {
    const state = getClientNavigationState();
    state?.originalReplaceState.call(window.history, data, unused, url);
  });
}

/**
 * Save the current scroll position into the current history state.
 * Called before every navigation to enable scroll restoration on back/forward.
 *
 * Uses replaceHistoryStateWithoutNotify to avoid triggering the patched
 * history.replaceState interception (which would cause spurious re-renders).
 */
function saveScrollPosition(): void {
  const state = window.history.state ?? {};
  replaceHistoryStateWithoutNotify(
    { ...state, __vinext_scrollX: window.scrollX, __vinext_scrollY: window.scrollY },
    "",
  );
}

/**
 * Restore scroll position from a history state object (used on popstate).
 *
 * When an RSC navigation is in flight (back/forward triggers both this
 * handler and the browser entry's popstate handler which calls
 * __VINEXT_RSC_NAVIGATE__), we must wait for the new content to render
 * before scrolling. Otherwise the user sees old content flash at the
 * restored scroll position.
 *
 * This handler fires before the browser entry's popstate handler (because
 * navigation.ts is loaded before hydration completes), so we defer via a
 * microtask to give the browser entry handler a chance to set
 * __VINEXT_RSC_PENDING__. Promise.resolve() schedules a microtask
 * that runs after all synchronous event listeners have completed.
 */
function restoreScrollPosition(state: unknown): void {
  if (state && typeof state === "object" && "__vinext_scrollY" in state) {
    const { __vinext_scrollX: x, __vinext_scrollY: y } = state as {
      __vinext_scrollX: number;
      __vinext_scrollY: number;
    };

    // Defer to allow other popstate listeners (browser entry) to run first
    // and set __VINEXT_RSC_PENDING__. Promise.resolve() schedules a microtask
    // that runs after all synchronous event listeners have completed.
    void Promise.resolve().then(() => {
      const pending: Promise<void> | null = window.__VINEXT_RSC_PENDING__ ?? null;

      if (pending) {
        // Wait for the RSC navigation to finish rendering, then scroll.
        void pending.then(() => {
          requestAnimationFrame(() => {
            window.scrollTo(x, y);
          });
        });
      } else {
        // No RSC navigation in flight (Pages Router or already settled).
        requestAnimationFrame(() => {
          window.scrollTo(x, y);
        });
      }
    });
  }
}

/**
 * Navigate to a URL, handling external URLs, hash-only changes, and RSC navigation.
 */
export async function navigateClientSide(
  href: string,
  mode: "push" | "replace",
  scroll: boolean,
): Promise<void> {
  // Normalize same-origin absolute URLs to local paths for SPA navigation
  let normalizedHref = href;
  if (isExternalUrl(href)) {
    const localPath = toSameOriginAppPath(href, __basePath);
    if (localPath == null) {
      // Truly external: use full page navigation
      if (mode === "replace") {
        window.location.replace(href);
      } else {
        window.location.assign(href);
      }
      return;
    }
    normalizedHref = localPath;
  }

  const fullHref = toBrowserNavigationHref(normalizedHref, window.location.href, __basePath);
  // Match Next.js: App Router reports navigation start before dispatching,
  // including hash-only navigations that short-circuit after URL update.
  notifyAppRouterTransitionStart(fullHref, mode);

  // Save scroll position before navigating (for back/forward restoration)
  if (mode === "push") {
    saveScrollPosition();
  }

  // Hash-only change: update URL and scroll to target, skip RSC fetch
  if (isHashOnlyChange(fullHref)) {
    const hash = fullHref.includes("#") ? fullHref.slice(fullHref.indexOf("#")) : "";
    if (mode === "replace") {
      replaceHistoryStateWithoutNotify(null, "", fullHref);
    } else {
      pushHistoryStateWithoutNotify(null, "", fullHref);
    }
    commitClientNavigationState();
    if (scroll) {
      scrollToHash(hash);
    }
    return;
  }

  // Extract hash for post-navigation scrolling
  const hashIdx = fullHref.indexOf("#");
  const hash = hashIdx !== -1 ? fullHref.slice(hashIdx) : "";

  // Trigger RSC re-fetch if available, and wait for the new content to render
  // before scrolling. This prevents the old page from visibly jumping to the
  // top before the new content paints.
  //
  // History is NOT pushed here for RSC navigations — the commit effect inside
  // navigateRsc owns the push/replace exclusively. This avoids a fragile
  // double-push and ensures window.location still reflects the *current* URL
  // when navigateRsc computes isSameRoute (cross-route vs same-route).
  if (typeof window.__VINEXT_RSC_NAVIGATE__ === "function") {
    await window.__VINEXT_RSC_NAVIGATE__(fullHref, 0, "navigate", mode);
  } else {
    if (mode === "replace") {
      replaceHistoryStateWithoutNotify(null, "", fullHref);
    } else {
      pushHistoryStateWithoutNotify(null, "", fullHref);
    }
    commitClientNavigationState();
  }

  if (scroll) {
    if (hash) {
      scrollToHash(hash);
    } else {
      window.scrollTo(0, 0);
    }
  }
}

// ---------------------------------------------------------------------------
// App Router router singleton
//
// All methods close over module-level state (navigateClientSide, withBasePath, etc.)
// and carry no per-render data, so the object can be created once and reused.
// Next.js returns the same router reference on every call to useRouter(), which
// matters for components that rely on referential equality (e.g. useMemo /
// useEffect dependency arrays, React.memo bailouts).
// ---------------------------------------------------------------------------

const _appRouter = {
  push(href: string, options?: { scroll?: boolean }): void {
    if (isServer) return;
    void navigateClientSide(href, "push", options?.scroll !== false);
  },
  replace(href: string, options?: { scroll?: boolean }): void {
    if (isServer) return;
    void navigateClientSide(href, "replace", options?.scroll !== false);
  },
  back(): void {
    if (isServer) return;
    window.history.back();
  },
  forward(): void {
    if (isServer) return;
    window.history.forward();
  },
  refresh(): void {
    if (isServer) return;
    // Re-fetch the current page's RSC stream
    if (typeof window.__VINEXT_RSC_NAVIGATE__ === "function") {
      void window.__VINEXT_RSC_NAVIGATE__(window.location.href, 0, "refresh");
    }
  },
  prefetch(href: string): void {
    if (isServer) return;
    // Prefetch the RSC payload for the target route and store in cache.
    // We must add to prefetchedUrls manually for deduplication.
    // prefetchRscResponse only manages the cache Map, not the URL set.
    const fullHref = toBrowserNavigationHref(href, window.location.href, __basePath);
    const rscUrl = toRscUrl(fullHref);
    const interceptionContext = getCurrentInterceptionContext();
    const cacheKey = createAppPayloadCacheKey(rscUrl, interceptionContext);
    const prefetched = getPrefetchedUrls();
    if (prefetched.has(cacheKey)) return;
    prefetched.add(cacheKey);
    const mountedSlotsHeader = getMountedSlotsHeader();
    const headers = new Headers({ Accept: "text/x-component" });
    if (mountedSlotsHeader) {
      headers.set("X-Vinext-Mounted-Slots", mountedSlotsHeader);
    }
    if (interceptionContext !== null) {
      headers.set("X-Vinext-Interception-Context", interceptionContext);
    }
    prefetchRscResponse(
      rscUrl,
      fetch(rscUrl, {
        headers,
        credentials: "include",
        priority: "low" as RequestInit["priority"],
      }),
      interceptionContext,
      mountedSlotsHeader,
    );
  },
};

/**
 * App Router's useRouter — returns push/replace/back/forward/refresh.
 * Different from Pages Router's useRouter (next/router).
 *
 * Returns a stable singleton: the same object reference on every call,
 * matching Next.js behavior so components using referential equality
 * (e.g. useMemo / useEffect deps, React.memo) don't re-render unnecessarily.
 */
export function useRouter() {
  return _appRouter;
}

/**
 * Returns the active child segment one level below the layout where it's called.
 *
 * Returns the first segment from the route tree below this layout, including
 * route groups (e.g., "(marketing)") and resolved dynamic params. Returns null
 * if at the leaf (no child segments).
 *
 * @param parallelRoutesKey - Which parallel route to read (default: "children")
 */
export function useSelectedLayoutSegment(parallelRoutesKey?: string): string | null {
  const segments = useSelectedLayoutSegments(parallelRoutesKey);
  return segments.length > 0 ? segments[0] : null;
}

/**
 * Returns all active segments below the layout where it's called.
 *
 * Each layout in the App Router tree wraps its children with a
 * LayoutSegmentProvider whose value is a map of parallel route key to
 * segment arrays. The "children" key is the default parallel route.
 *
 * @param parallelRoutesKey - Which parallel route to read (default: "children")
 */
export function useSelectedLayoutSegments(parallelRoutesKey?: string): string[] {
  return useChildSegments(parallelRoutesKey);
}

export { ReadonlyURLSearchParams };

/**
 * useServerInsertedHTML — inject HTML during SSR from client components.
 *
 * Used by CSS-in-JS libraries (styled-components, emotion, StyleX) to inject
 * <style> tags during SSR so styles appear in the initial HTML (no FOUC).
 *
 * The callback is called once after each SSR render pass. The returned JSX/HTML
 * is serialized and injected into the HTML stream.
 *
 * Usage (in a "use client" component wrapping children):
 *   useServerInsertedHTML(() => {
 *     const styles = sheet.getStyleElement();
 *     sheet.instance.clearTag();
 *     return <>{styles}</>;
 *   });
 */

export function useServerInsertedHTML(callback: () => unknown): void {
  if (typeof document !== "undefined") {
    // Client-side: no-op (styles are already in the DOM)
    return;
  }
  _getInsertedHTMLCallbacks().push(callback);
}

/**
 * Flush all collected useServerInsertedHTML callbacks.
 * Returns an array of results (React elements or strings).
 * Clears the callback list so the next render starts fresh.
 *
 * Called by the SSR entry after renderToReadableStream completes.
 */
export function flushServerInsertedHTML(): unknown[] {
  const callbacks = _getInsertedHTMLCallbacks();
  const results: unknown[] = [];
  for (const cb of callbacks) {
    try {
      const result = cb();
      if (result != null) results.push(result);
    } catch {
      // Ignore errors from individual callbacks
    }
  }
  callbacks.length = 0;
  return results;
}

/**
 * Clear all collected useServerInsertedHTML callbacks without flushing.
 * Used for cleanup between requests.
 */
export function clearServerInsertedHTML(): void {
  _clearInsertedHTMLCallbacks();
}

// ---------------------------------------------------------------------------
// Non-hook utilities (can be called from Server Components)
// ---------------------------------------------------------------------------

/**
 * HTTP Access Fallback error code — shared prefix for notFound/forbidden/unauthorized.
 * Matches Next.js 16's unified error handling approach.
 */
export const HTTP_ERROR_FALLBACK_ERROR_CODE = "NEXT_HTTP_ERROR_FALLBACK";

/**
 * Check if an error is an HTTP Access Fallback error (notFound, forbidden, unauthorized).
 */
export function isHTTPAccessFallbackError(error: unknown): boolean {
  if (error && typeof error === "object" && "digest" in error) {
    const digest = String((error as { digest: unknown }).digest);
    return (
      digest === "NEXT_NOT_FOUND" || // legacy compat
      digest.startsWith(`${HTTP_ERROR_FALLBACK_ERROR_CODE};`)
    );
  }
  return false;
}

/**
 * Extract the HTTP status code from an HTTP Access Fallback error.
 * Returns 404 for legacy NEXT_NOT_FOUND errors.
 */
export function getAccessFallbackHTTPStatus(error: unknown): number {
  if (error && typeof error === "object" && "digest" in error) {
    const digest = String((error as { digest: unknown }).digest);
    if (digest === "NEXT_NOT_FOUND") return 404;
    if (digest.startsWith(`${HTTP_ERROR_FALLBACK_ERROR_CODE};`)) {
      return parseInt(digest.split(";")[1], 10);
    }
  }
  return 404;
}

/**
 * Enum matching Next.js RedirectType for type-safe redirect calls.
 */
export enum RedirectType {
  push = "push",
  replace = "replace",
}

/**
 * Internal error class used by redirect/notFound/forbidden/unauthorized.
 * The `digest` field is the serialised control-flow signal read by the
 * framework's error boundary and server-side request handlers.
 */
class VinextNavigationError extends Error {
  readonly digest: string;
  constructor(message: string, digest: string) {
    super(message);
    this.digest = digest;
  }
}

/**
 * Throw a redirect. Caught by the framework to send a redirect response.
 *
 * When `type` is omitted, the digest carries an empty sentinel so the
 * catch site can resolve the default based on context:
 * - Server Action context → "push"  (Back button works after form submission)
 * - SSR render context    → "replace"
 *
 * This matches Next.js behavior where `redirect()` checks
 * `actionAsyncStorage.getStore()?.isAction` at call time.
 *
 * @see https://github.com/vercel/next.js/blob/canary/packages/next/src/client/components/redirect.ts
 */
export function redirect(url: string, type?: "replace" | "push" | RedirectType): never {
  throw new VinextNavigationError(
    `NEXT_REDIRECT:${url}`,
    `NEXT_REDIRECT;${type ?? ""};${encodeURIComponent(url)}`,
  );
}

/**
 * Trigger a permanent redirect (308).
 *
 * Accepts an optional `type` parameter matching Next.js's signature.
 * Defaults to "replace" (not context-dependent like `redirect()`).
 *
 * @see https://github.com/vercel/next.js/blob/canary/packages/next/src/client/components/redirect.ts
 */
export function permanentRedirect(
  url: string,
  type: "replace" | "push" | RedirectType = "replace",
): never {
  throw new VinextNavigationError(
    `NEXT_REDIRECT:${url}`,
    `NEXT_REDIRECT;${type};${encodeURIComponent(url)};308`,
  );
}

/**
 * Trigger a not-found response (404). Caught by the framework.
 */
export function notFound(): never {
  throw new VinextNavigationError("NEXT_NOT_FOUND", `${HTTP_ERROR_FALLBACK_ERROR_CODE};404`);
}

/**
 * Trigger a forbidden response (403). Caught by the framework.
 * In Next.js, this is gated behind experimental.authInterrupts — we
 * support it unconditionally for maximum compatibility.
 */
export function forbidden(): never {
  throw new VinextNavigationError("NEXT_FORBIDDEN", `${HTTP_ERROR_FALLBACK_ERROR_CODE};403`);
}

/**
 * Trigger an unauthorized response (401). Caught by the framework.
 * In Next.js, this is gated behind experimental.authInterrupts — we
 * support it unconditionally for maximum compatibility.
 */
export function unauthorized(): never {
  throw new VinextNavigationError("NEXT_UNAUTHORIZED", `${HTTP_ERROR_FALLBACK_ERROR_CODE};401`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Listen for popstate on the client
if (!isServer) {
  const state = getClientNavigationState();
  if (state && !state.patchInstalled) {
    state.patchInstalled = true;

    // Listen for popstate on the client.
    // Note: This handler runs for Pages Router only (when __VINEXT_RSC_NAVIGATE__
    // is not available). It restores scroll position with microtask-based deferral.
    // App Router scroll restoration is handled in server/app-browser-entry.ts:697
    // with RSC navigation coordination (waits for pending navigation to settle).
    window.addEventListener("popstate", (event) => {
      if (typeof window.__VINEXT_RSC_NAVIGATE__ !== "function") {
        commitClientNavigationState();
        restoreScrollPosition(event.state);
      }
    });

    window.history.pushState = function patchedPushState(
      data: unknown,
      unused: string,
      url?: string | URL | null,
    ): void {
      state.originalPushState.call(window.history, data, unused, url);
      if (state.suppressUrlNotifyCount === 0) {
        commitClientNavigationState();
      }
    };

    window.history.replaceState = function patchedReplaceState(
      data: unknown,
      unused: string,
      url?: string | URL | null,
    ): void {
      state.originalReplaceState.call(window.history, data, unused, url);
      if (state.suppressUrlNotifyCount === 0) {
        commitClientNavigationState();
      }
    };
  }
}
