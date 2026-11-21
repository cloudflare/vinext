/**
 * next/navigation shim
 *
 * App Router navigation hooks. These work on both server (RSC) and client.
 * Server-side: reads from a request context set by the RSC handler.
 * Client-side: reads the shared client navigation state, or the Pages Router
 * state when a Pages page uses these hooks.
 *
 * Like Next.js' `client/components/navigation.ts`, this module holds no App
 * Router navigation machinery. The runtime that fetches, prefetches, writes
 * history and scrolls lives in `app-router-navigation.ts`, which only the App
 * Router browser entry and the shims that navigate import, so Pages Router
 * pages that use these hooks don't load it.
 */

// Use namespace import for RSC safety: the react-server condition doesn't export
// createContext/useContext/useSyncExternalStore as named exports, and strict ESM
// would throw at link time for missing bindings. With `import * as React`, the
// bindings are just `undefined` on the namespace object and we can guard at runtime.
import * as React from "react";
import type { Params } from "@vinext/types/next/upstream/dist/server/request/params";
import { INITIAL_BFCACHE_ID, PUBLIC_INITIAL_BFCACHE_ID } from "../server/app-bfcache-id.js";
import { stripBasePath } from "../utils/base-path.js";
import { ReadonlyURLSearchParams } from "./readonly-url-search-params.js";
import {
  getPprFallbackShellState,
  markPprFallbackShellDynamicBoundary,
} from "./ppr-fallback-shell.js";
import { BailoutToCSRError as NavigationBailoutToCSRError } from "./navigation-errors.js";
import { AppRouterContext } from "./internal/app-router-context.js";
import { getPagesNavigationContext as _getPagesNavigationContext } from "./internal/pages-router-accessor.js";
import {
  clearClientHydrationContext,
  getBfcacheIdMapContext,
  getBfcacheSegmentIdContext,
  getLayoutSegmentContext,
  getNavigationContext,
  registerServerInsertedHTMLCallback,
  type NavigationContext,
} from "./navigation-context-state.js";

export {
  type NavigationContext,
  type NavigationStateAccessors,
  type SegmentMap,
  GLOBAL_ACCESSORS_KEY,
  ServerInsertedHTMLContext,
  _registerStateAccessors,
  clearServerInsertedHTML,
  flushServerInsertedHTML,
  getBfcacheIdMapContext,
  getBfcacheSegmentIdContext,
  getLayoutSegmentContext,
  getNavigationContext,
  renderServerInsertedHTML,
  setNavigationContext,
} from "./navigation-context-state.js";

export {
  BailoutToCSRError,
  DynamicServerError,
  HTTP_ERROR_FALLBACK_ERROR_CODE,
  RedirectType,
  decodeRedirectError,
  forbidden,
  getAccessFallbackHTTPStatus,
  isBailoutToCSRError,
  isDynamicServerError,
  isHTTPAccessFallbackError,
  isNextRouterError,
  isRedirectError,
  notFound,
  permanentRedirect,
  redirect,
  unauthorized,
  unstable_rethrow,
} from "./navigation-errors.js";

// ─── Layout segment context ───────────────────────────────────────────────────
// Stores the child segments below the current layout. Each layout wraps its
// children with a provider whose value is the remaining route tree segments
// (including route groups, with dynamic params resolved to actual values).
// Created lazily because `React.createContext` is NOT available in the
// react-server condition of React. In the RSC environment, this remains null.
// The contexts and request-state bridge live in navigation-context-state.ts so
// the browser and server facades share one lightweight implementation.

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
    return (segmentMap[parallelRoutesKey] ?? []).filter(
      (segment) => !segment.startsWith("__PAGE__"),
    );
  } catch {
    return [];
  }
}
/* oxlint-enable eslint-plugin-react-hooks/rules-of-hooks */

// ---------------------------------------------------------------------------
// Server-side request context (set by the RSC entry before rendering)
// ---------------------------------------------------------------------------

// Global symbols, so every instance of this module reuses one wrapper per
// context and the browser adopts that same object after hydration.
const _READONLY_SEARCH_PARAMS = Symbol.for("vinext.navigation.readonlySearchParams");
const _READONLY_SEARCH_PARAMS_SOURCE = Symbol.for("vinext.navigation.readonlySearchParamsSource");
const _READONLY_SEARCH_PARAMS_SOURCE_KEY = Symbol.for(
  "vinext.navigation.readonlySearchParamsSourceKey",
);

type NavigationContextWithReadonlyCache = NavigationContext & {
  [_READONLY_SEARCH_PARAMS]?: ReadonlyURLSearchParams;
  [_READONLY_SEARCH_PARAMS_SOURCE]?: URLSearchParams;
  [_READONLY_SEARCH_PARAMS_SOURCE_KEY]?: string;
};

// ---------------------------------------------------------------------------
// Pages Router compat source.
//
// `next/navigation` is the App Router API surface, but Next.js exposes the
// same hook names to Pages Router pages as a compat shim. In Next.js this is
// done by wrapping pages with SearchParamsContext / PathParamsContext /
// PathnameContext providers populated from the Pages Router's state — see:
// .nextjs-ref/packages/next/src/server/render.tsx
// .nextjs-ref/packages/next/src/client/index.tsx
// .nextjs-ref/packages/next/src/shared/lib/router/adapters.tsx
//
// vinext drives these hooks from a module-level navigation context instead of
// React Context, so we fall back to a Pages Router accessor when no App
// Router context is set. The accessor is published by next/router via a
// global Symbol.for handle (see packages/vinext/src/shims/router.ts); we do
// NOT import router.ts here because doing so would load the Pages Router with
// every page that uses these hooks.
// ---------------------------------------------------------------------------

const PAGES_NAVIGATION_NOTIFY_KEY = Symbol.for("vinext.navigation.pagesNavigationNotify");
type _GlobalWithPagesNotify = typeof globalThis & {
  [PAGES_NAVIGATION_NOTIFY_KEY]?: () => void;
};

// ---------------------------------------------------------------------------
// Client-side state
// ---------------------------------------------------------------------------

const isServer = typeof window === "undefined";

/** basePath from next.config.js, injected by the plugin at build time */
export const __basePath: string = process.env.__NEXT_ROUTER_BASEPATH ?? "";

type NavigationListener = () => void;
const _CLIENT_NAV_STATE_KEY = Symbol.for("vinext.clientNavigationState");

/** @internal Shared with the App Router navigation runtime. */
export type ClientNavigationState = {
  listeners: Set<NavigationListener>;
  cachedSearch: string;
  cachedReadonlySearchParams: ReadonlyURLSearchParams;
  cachedPathname: string;
  clientParams: Record<string, string | string[]>;
  clientParamsJson: string;
  pendingClientParams: Record<string, string | string[]> | null;
  pendingClientParamsJson: string | null;
  pendingPathname: string | null;
  pendingPathnameNavId: number | null;
  originalPushState: typeof window.history.pushState;
  originalReplaceState: typeof window.history.replaceState;
  patchInstalled: boolean;
  routerHistoryWriteDepth: number;
  routerHistoryWrite: RouterHistoryWrite | null;
  hasPendingNavigationUpdate: boolean;
  suppressUrlNotifyCount: number;
  navigationSnapshotActiveCount: number;
};

/** @internal */
export type RouterHistoryWrite = {
  method: "pushState" | "replaceState";
  data: unknown;
  url: string | URL;
  // The destination `url` resolves to when the write starts.
  href: string;
  land: RouterHistoryWriteLanding | undefined;
  // An attempt threw; a wrapper may retry with a copy.
  threw: boolean;
  // The write has landed; a wrapper's further retries of it are dropped.
  landed: boolean;
};

/**
 * Runs as a router history write lands, after any writes a history wrapper
 * installed after boot made before forwarding it. Returns the data to write
 * (re-stamped when those writes moved the traversal indices) and a commit to
 * run once the write succeeds, before any write the wrapper makes after it. A
 * wrapper installed before boot is the original method called after `land`, so
 * writes it makes through the live methods are not accounted for.
 */
export type RouterHistoryWriteLanding = (data: unknown) => {
  data: unknown;
  commit: () => void;
};

type CommitClientNavigationStateOptions = {
  releaseSnapshot?: boolean;
};

type ClientNavigationGlobal = typeof globalThis & {
  [_CLIENT_NAV_STATE_KEY]?: ClientNavigationState;
};

export function getClientNavigationState(): ClientNavigationState | null {
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
    pendingPathname: null,
    pendingPathnameNavId: null,
    // NB: These capture the currently installed history methods, not guaranteed
    // native ones. If a third-party library (analytics, router) has already patched
    // history methods, we intentionally preserve that wrapper. The App Router
    // runtime takes them again when it installs its history patch, and with
    // Symbol.for global state, the first runtime instance to load wins. Router
    // writes with a URL still go through the live window.history methods (see
    // writeRouterHistoryState in app-router-navigation.ts) so wrappers installed
    // after boot see them too.
    originalPushState: window.history.pushState.bind(window.history),
    originalReplaceState: window.history.replaceState.bind(window.history),
    patchInstalled: false,
    routerHistoryWriteDepth: 0,
    routerHistoryWrite: null,
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

if (!isServer) {
  (globalThis as _GlobalWithPagesNotify)[PAGES_NAVIGATION_NOTIFY_KEY] = notifyNavigationListeners;
}

// Cached URLSearchParams, pathname, etc. for referential stability
// useSyncExternalStore compares snapshots with Object.is — avoid creating
// new instances on every render (infinite re-renders).
let _cachedEmptyServerSearchParams: ReadonlyURLSearchParams | null = null;
const _readonlyPagesSearchParamsCache = new WeakMap<URLSearchParams, ReadonlyURLSearchParams>();
let _cachedReadonlyPagesSearchParamsKey: string | null = null;
let _cachedReadonlyPagesSearchParams: ReadonlyURLSearchParams | null = null;

function getReadonlyPagesSearchParams(searchParams: URLSearchParams): ReadonlyURLSearchParams {
  // Two-level cache. The per-object WeakMap gives referential stability for a
  // single URLSearchParams instance across renders. The string-keyed slot is
  // also load-bearing: across the Pages Router pre-ready → ready transition the
  // context swaps in a NEW URLSearchParams object even when the query string is
  // unchanged, and returning the same wrapper for an equal string keeps
  // `useSearchParams()` Object.is-stable so a `[searchParams]` effect does not
  // re-fire spuriously. Under concurrent SSR one request can read another
  // request's string-keyed wrapper, but that is harmless: ReadonlyURLSearchParams
  // is immutable and equal-string wrappers are interchangeable.
  const cached = _readonlyPagesSearchParamsCache.get(searchParams);
  if (cached) return cached;

  const key = searchParams.toString();
  if (_cachedReadonlyPagesSearchParamsKey === key && _cachedReadonlyPagesSearchParams) {
    _readonlyPagesSearchParamsCache.set(searchParams, _cachedReadonlyPagesSearchParams);
    return _cachedReadonlyPagesSearchParams;
  }

  const readonly = new ReadonlyURLSearchParams(searchParams);
  _readonlyPagesSearchParamsCache.set(searchParams, readonly);
  _cachedReadonlyPagesSearchParamsKey = key;
  _cachedReadonlyPagesSearchParams = readonly;
  return readonly;
}

/**
 * Get cached pathname snapshot for useSyncExternalStore.
 * Note: Returns cached value from ClientNavigationState, not live window.location.
 * The cache is updated by syncCommittedUrlStateFromLocation() after navigation commits.
 * This ensures referential stability and prevents infinite re-renders.
 * External pushState/replaceState while URL notifications are suppressed won't
 * be visible until the next commit.
 */
function getPathnameSnapshot(): string | null {
  const pagesCtx = _getPagesNavigationContext();
  if (pagesCtx) return pagesCtx.pathname;
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
  // The App Router context only seeds hydration, through getServerSnapshot.
  // Once hydrated, the browser URL wins, as in Next.js: a force-static page
  // renders an empty query on the server but reads the real one in the browser.
  const hasAppContext = getNavigationContext() !== null;
  const pagesCtx = _getPagesNavigationContext();
  if (!hasAppContext && pagesCtx) {
    return getReadonlyPagesSearchParams(pagesCtx.searchParams);
  }

  const state = getClientNavigationState();
  if (state) {
    if (hasAppContext) adoptHydrationSearchParams(state);
    return state.cachedReadonlySearchParams;
  }
  if (_cachedEmptyClientSearchParams === null) {
    _cachedEmptyClientSearchParams = new ReadonlyURLSearchParams();
  }
  return _cachedEmptyClientSearchParams;
}

let _comparedHydrationSearchParams: ReadonlyURLSearchParams | null = null;

/**
 * Keep the hydrated search params object when the browser URL has the same
 * query. React compares the two snapshots by identity once hydrated, so a new
 * object would re-render every useSearchParams() caller and re-run effects
 * keyed on it, where Next.js keeps one object from the first render.
 */
function adoptHydrationSearchParams(state: ClientNavigationState): void {
  const hydrated = getServerSearchParamsSnapshot();
  if (hydrated === state.cachedReadonlySearchParams) return;
  if (hydrated === _comparedHydrationSearchParams) return;
  _comparedHydrationSearchParams = hydrated;
  if (hydrated.toString() === state.cachedReadonlySearchParams.toString()) {
    state.cachedReadonlySearchParams = hydrated;
  }
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
  const ctx = getNavigationContext() as NavigationContextWithReadonlyCache | null;

  if (!ctx) {
    // No App Router server context - try Pages Router compat shim.
    // See `adaptForSearchParams` in Next.js's adapters:
    // .nextjs-ref/packages/next/src/shared/lib/router/adapters.tsx
    const pagesCtx = _getPagesNavigationContext();
    if (pagesCtx) {
      return getReadonlyPagesSearchParams(pagesCtx.searchParams);
    }
    if (_cachedEmptyServerSearchParams === null) {
      _cachedEmptyServerSearchParams = new ReadonlyURLSearchParams();
    }
    return _cachedEmptyServerSearchParams;
  }

  const source = ctx.searchParams;
  const cached = ctx[_READONLY_SEARCH_PARAMS];
  const cachedSource = ctx[_READONLY_SEARCH_PARAMS_SOURCE];

  // Fast path: identical source object — reuse the wrapper without serializing.
  if (cached && cachedSource === source) {
    return cached;
  }

  // The source object can change identity while keeping the same value (e.g. a
  // hydration-cloned URLSearchParams). Serialize only when the identity check
  // misses, then compare against the cached value key before rebuilding.
  const sourceKey = source.toString();
  if (cached && ctx[_READONLY_SEARCH_PARAMS_SOURCE_KEY] === sourceKey) {
    ctx[_READONLY_SEARCH_PARAMS_SOURCE] = source;
    return cached;
  }

  // Create and cache new wrapper
  const readonly = new ReadonlyURLSearchParams(source);
  ctx[_READONLY_SEARCH_PARAMS] = readonly;
  ctx[_READONLY_SEARCH_PARAMS_SOURCE] = source;
  ctx[_READONLY_SEARCH_PARAMS_SOURCE_KEY] = sourceKey;

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
  // Preserve the browser URL's raw query spelling for exact navigation
  // identity. ReadonlyURLSearchParams intentionally canonicalizes `%20` to `+`
  // when serialized, so it cannot reconstruct the href used for a commit.
  search: string;
  searchParams: ReadonlyURLSearchParams;
  params: Record<string, string | string[]>;
  /**
   * The query the server rendered this tree with, when it is known. A rewrite
   * can change it (`/search/:q` -> `/search?q=:q`), so it can differ from
   * `search`. Client page `searchParams` read it (see `client-page-root.tsx`).
   */
  renderedSearch?: string;
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
/** @internal */
export function useClientNavigationRenderSnapshot(): ClientNavigationRenderSnapshot | null {
  const ctx = getClientNavigationRenderContext();
  if (!ctx || typeof React.useContext !== "function") return null;
  try {
    return React.useContext(ctx);
  } catch {
    return null;
  }
}
/* oxlint-enable eslint-plugin-react-hooks/rules-of-hooks */

/**
 * @param renderedPathAndSearch The path and query the server rendered for this
 * navigation (`X-Vinext-Rendered-Path-And-Search`), when known.
 */
export function createClientNavigationRenderSnapshot(
  href: string,
  params: Record<string, string | string[]>,
  renderedPathAndSearch?: string | null,
): ClientNavigationRenderSnapshot {
  const origin = typeof window !== "undefined" ? window.location.origin : "http://localhost";
  const url = new URL(href, origin);

  return {
    pathname: stripBasePath(url.pathname, __basePath),
    search: url.search,
    searchParams: new ReadonlyURLSearchParams(url.search),
    params,
    ...(renderedPathAndSearch != null
      ? { renderedSearch: new URL(renderedPathAndSearch, origin).search }
      : {}),
  };
}

export function createSnapshotPathAndSearch(snapshot: ClientNavigationRenderSnapshot): string {
  return snapshot.pathname + snapshot.search;
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

/**
 * Set the pending pathname for client-side navigation.
 * Strips the base path before storing. Associates the pathname with the given navId
 * so only that navigation (or a newer one) can clear it.
 */
export function setPendingPathname(pathname: string, navId: number): void {
  const state = getClientNavigationState();
  if (!state) return;
  state.pendingPathname = stripBasePath(pathname, __basePath);
  state.pendingPathnameNavId = navId;
}

/**
 * Clear the pending pathname, but only if the given navId matches the one
 * that set it, or if pendingPathnameNavId is null (no active owner).
 * This prevents superseded navigations from clearing state belonging to newer navigations.
 */
export function clearPendingPathname(navId: number): void {
  const state = getClientNavigationState();
  if (!state) return;
  // Only clear if this navId is the one that set the pendingPathname,
  // or if pendingPathnameNavId is null (no owner)
  if (state.pendingPathnameNavId === null || state.pendingPathnameNavId === navId) {
    state.pendingPathname = null;
    state.pendingPathnameNavId = null;
  }
}

function getClientParamsSnapshot(): Record<string, string | string[]> | null {
  const state = getClientNavigationState();
  const ctx = getNavigationContext();
  if (ctx) return ctx.params;

  const pagesCtx = _getPagesNavigationContext();
  if (pagesCtx) {
    return pagesCtx.params;
  }
  return state?.clientParams ?? _EMPTY_PARAMS;
}

function getServerParamsSnapshot(): Record<string, string | string[]> | null {
  const ctx = getNavigationContext();
  if (ctx) return ctx.params;
  // No App Router navigation context — fall back to Pages Router state.
  // See `adaptForPathParams` in Next.js's pages-router adapter:
  // .nextjs-ref/packages/next/src/shared/lib/router/adapters.tsx
  const pagesCtx = _getPagesNavigationContext();
  if (pagesCtx) return pagesCtx.params;
  return _EMPTY_PARAMS;
}

function subscribeToNavigation(cb: () => void): () => void {
  const state = getClientNavigationState();
  if (!state) return () => {};

  state.listeners.add(cb);
  return () => {
    state.listeners.delete(cb);
  };
}

/* oxlint-disable eslint-plugin-react-hooks/rules-of-hooks */
/**
 * Returns the current pathname.
 * Server: from request context. Client: from window.location.
 */
export function usePathname(): string {
  if (isServer) {
    markPprFallbackShellDynamicBoundary();
    // During SSR of "use client" components, the navigation context may not be set.
    // Return a safe fallback — the client will hydrate with the real value.
    const ctx = getNavigationContext();
    if (ctx) return ctx.pathname;
    // Pages Router compat shim: derive pathname from the Pages Router state.
    const pagesCtx = _getPagesNavigationContext();
    // The standalone next/navigation declaration returns string, while the
    // Pages Router compatibility runtime intentionally yields null before
    // router readiness (matching Next.js' Pages Router adapter behavior).
    return pagesCtx ? (pagesCtx.pathname as string) : "/";
  }
  const renderSnapshot = useClientNavigationRenderSnapshot();
  // Client-side: use the hook system for reactivity
  const pathname = React.useSyncExternalStore(subscribeToNavigation, getPathnameSnapshot, () => {
    const ctx = getNavigationContext();
    if (ctx) return ctx.pathname;
    const pagesCtx = _getPagesNavigationContext();
    return pagesCtx ? pagesCtx.pathname : "/";
  });
  // Prefer the render snapshot during an active navigation transition so
  // hooks return the pending URL, not the stale committed one. After commit,
  // fall through to useSyncExternalStore so user pushState/replaceState
  // calls are immediately reflected.
  if (renderSnapshot && (getClientNavigationState()?.navigationSnapshotActiveCount ?? 0) > 0) {
    return renderSnapshot.pathname as string;
  }
  return pathname as string;
}
/* oxlint-enable eslint-plugin-react-hooks/rules-of-hooks */

/* oxlint-disable eslint-plugin-react-hooks/rules-of-hooks */
/**
 * Returns the current search params as a read-only URLSearchParams.
 */
export function useSearchParams(): ReadonlyURLSearchParams {
  if (isServer) {
    const ctx = getNavigationContext();
    if (
      ctx?.isStaticGeneration === true &&
      ctx.isForceStatic !== true &&
      getPprFallbackShellState() === null
    ) {
      // Next.js treats a client component reading useSearchParams during a
      // static render as a client-render boundary. Throwing its canonical
      // control-flow error lets React render the nearest Suspense fallback
      // into the static HTML while the browser fills in the real URL values.
      throw new NavigationBailoutToCSRError("useSearchParams()");
    }
    const gate = ctx?.searchParamsGate;
    if (gate) {
      // A cache-candidate render waits until it is known whether the render
      // will be stored: real values once it is dynamic, otherwise the same
      // client-render boundary as a static render.
      React.use(gate.decided);
      if (gate.decision === "bailout") {
        throw new NavigationBailoutToCSRError("useSearchParams()");
      }
    }
    markPprFallbackShellDynamicBoundary();
    // During SSR for "use client" components, the navigation context may not be set.
    // getServerSearchParamsSnapshot also covers the Pages Router compat shim.
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
export function useParams<T extends Params = Params>(): T | null {
  if (isServer) {
    markPprFallbackShellDynamicBoundary();
    // During SSR for "use client" components, the navigation context may not be set.
    // getServerParamsSnapshot covers both App Router and Pages Router compat.
    return getServerParamsSnapshot() as T | null;
  }
  const renderSnapshot = useClientNavigationRenderSnapshot();
  const params = React.useSyncExternalStore(
    subscribeToNavigation,
    getClientParamsSnapshot as () => T | null,
    getServerParamsSnapshot as () => T | null,
  );
  if (renderSnapshot && (getClientNavigationState()?.navigationSnapshotActiveCount ?? 0) > 0) {
    return renderSnapshot.params as T;
  }
  return params;
}
/* oxlint-enable eslint-plugin-react-hooks/rules-of-hooks */

/**
 * Commit pending client navigation state to committed snapshots.
 *
 * navId is optional: callers that don't own pendingPathname (for example,
 * superseded pre-paint cleanup) may pass undefined to flush URL/params state
 * without clearing pendingPathname owned by the active navigation. Such callers
 * must opt in explicitly if they also own an activated render snapshot.
 */
export function commitClientNavigationState(
  navId?: number,
  options?: CommitClientNavigationStateOptions,
): void {
  if (isServer) return;
  const state = getClientNavigationState();
  if (!state) return;

  // Only navigation-owned commits may release a render snapshot. Ownerless URL
  // syncs still update committed pathname/search state, but must not consume
  // the active snapshot for an in-flight App Router transition.
  const shouldReleaseSnapshot = options?.releaseSnapshot ?? navId !== undefined;
  if (shouldReleaseSnapshot && state.navigationSnapshotActiveCount > 0) {
    state.navigationSnapshotActiveCount -= 1;
  }

  const urlChanged = syncCommittedUrlStateFromLocation();
  let paramsChanged = false;
  if (state.pendingClientParams !== null && state.pendingClientParamsJson !== null) {
    state.clientParams = state.pendingClientParams;
    state.clientParamsJson = state.pendingClientParamsJson;
    state.pendingClientParams = null;
    state.pendingClientParamsJson = null;
    paramsChanged = true;
  }
  // Clear pending pathname when navigation commits, but only if:
  // - The navId matches the one that set pendingPathname
  // - No newer navigation has overwritten pendingPathname (pendingPathnameNavId === null or matches)
  // - navId is undefined only for non-owning callers, which must not clear
  //   pendingPathname for an active navigation.
  const canClearPendingPathname =
    state.pendingPathnameNavId === null ||
    (navId !== undefined && state.pendingPathnameNavId === navId);
  if (canClearPendingPathname) {
    state.pendingPathname = null;
    state.pendingPathnameNavId = null;
  }
  const shouldNotify = urlChanged || state.hasPendingNavigationUpdate;
  state.hasPendingNavigationUpdate = false;

  if (urlChanged || paramsChanged) {
    clearClientHydrationContext();
  }

  if (shouldNotify) {
    notifyNavigationListeners();
  }
}

function formatPublicBfcacheId(value: string | null | undefined): string {
  if (!value || value === INITIAL_BFCACHE_ID) return PUBLIC_INITIAL_BFCACHE_ID;
  return value;
}

/* oxlint-disable eslint-plugin-react-hooks/rules-of-hooks */
function readBfcacheIdFromContext(): string {
  const segmentContext = getBfcacheSegmentIdContext();
  const idMapContext = getBfcacheIdMapContext();
  if (!segmentContext || !idMapContext || typeof React.useContext !== "function") {
    return formatPublicBfcacheId(null);
  }

  try {
    const segmentId = React.useContext(segmentContext);
    const idMap = React.useContext(idMapContext);
    return formatPublicBfcacheId(segmentId !== null ? idMap?.[segmentId] : null);
  } catch (error) {
    // Low-level tests and direct module calls can hit this outside render.
    if (process.env.NODE_ENV !== "production") {
      console.warn("[vinext] readBfcacheIdFromContext failed:", error);
    }
    return formatPublicBfcacheId(null);
  }
}
/* oxlint-enable eslint-plugin-react-hooks/rules-of-hooks */

/**
 * App Router's useRouter — returns push/replace/back/forward/refresh.
 * Different from Pages Router's useRouter (next/router).
 *
 * Preserves the mounted AppRouterContext router as the authority for methods
 * and layers the nearest segment's contextual `bfcacheId` on top.
 */
export function useRouter() {
  if (
    !AppRouterContext ||
    typeof React.useContext !== "function" ||
    typeof React.useMemo !== "function"
  ) {
    throw new Error("invariant expected app router to be mounted");
  }
  const router = React.useContext(AppRouterContext);
  if (router === null) {
    throw new Error("invariant expected app router to be mounted");
  }
  const bfcacheId = readBfcacheIdFromContext();
  return React.useMemo(
    () => ({
      ...router,
      bfcacheId,
    }),
    [router, bfcacheId],
  );
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
  if (segments.length === 0) return null;

  return parallelRoutesKey === undefined || parallelRoutesKey === "children"
    ? segments[0]
    : segments[segments.length - 1];
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
  if (isServer) {
    markPprFallbackShellDynamicBoundary();
  }
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
  registerServerInsertedHTMLCallback(callback);
}

// ---------------------------------------------------------------------------
// Unrecognized server-action errors
//
// `UnrecognizedActionError` / `unstable_isUnrecognizedActionError` live in a
// dedicated zero-dependency module so this `next/navigation` shim and vinext's
// client server-action dispatcher (`server/server-action-not-found.ts`) share
// one class. `instanceof` is identity-based per module instance, so the
// dispatcher and user code must resolve the same class for the predicate to
// work. Re-exported here to keep the public `next/navigation` surface intact.
// ---------------------------------------------------------------------------

export {
  UnrecognizedActionError,
  unstable_isUnrecognizedActionError,
} from "./unrecognized-action-error.js";
