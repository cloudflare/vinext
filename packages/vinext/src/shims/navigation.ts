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
type _LayoutSegmentGlobal = typeof globalThis & {
  [_LAYOUT_SEGMENT_CTX_KEY]?: React.Context<string[]> | null;
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
export function getLayoutSegmentContext(): React.Context<string[]> | null {
  if (typeof React.createContext !== "function") return null;

  const globalState = globalThis as _LayoutSegmentGlobal;
  if (!globalState[_LAYOUT_SEGMENT_CTX_KEY]) {
    globalState[_LAYOUT_SEGMENT_CTX_KEY] = React.createContext<string[]>([]);
  }

  return globalState[_LAYOUT_SEGMENT_CTX_KEY] ?? null;
}

/**
 * Read the child segments below the current layout from context.
 * Returns [] if no context is available (RSC environment, outside React tree).
 */
function useChildSegments(): string[] {
  const ctx = getLayoutSegmentContext();
  if (!ctx) return [];
  // useContext is safe here because if createContext exists, useContext does too.
  // This branch is only taken in SSR/Browser, never in RSC.
  // Try/catch for unit tests that call this hook outside a React render tree.
  try {
    return React.useContext(ctx);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Server-side request context (set by the RSC entry before rendering)
// ---------------------------------------------------------------------------

export interface NavigationContext {
  pathname: string;
  searchParams: URLSearchParams;
  params: Record<string, string | string[]>;
}

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

interface _StateAccessors {
  getServerContext: () => NavigationContext | null;
  setServerContext: (ctx: NavigationContext | null) => void;
  getInsertedHTMLCallbacks: () => Array<() => unknown>;
  clearInsertedHTMLCallbacks: () => void;
}

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
const __basePath: string = process.env.__NEXT_ROUTER_BASEPATH ?? "";

// ---------------------------------------------------------------------------
// RSC prefetch cache utilities (shared between link.tsx and browser entry)
// ---------------------------------------------------------------------------

/** Maximum number of entries in the RSC prefetch cache. */
export const MAX_PREFETCH_CACHE_SIZE = 50;

/** TTL for prefetch cache entries in ms (matches Next.js static prefetch TTL). */
export const PREFETCH_CACHE_TTL = 30_000;

export interface PrefetchCacheEntry {
  response: Response;
  timestamp: number;
}

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
 * Keyed by rscUrl so that the browser entry can clear entries when consumed.
 */
export function getPrefetchedUrls(): Set<string> {
  if (isServer) return new Set();
  if (!window.__VINEXT_RSC_PREFETCHED_URLS__) {
    window.__VINEXT_RSC_PREFETCHED_URLS__ = new Set<string>();
  }
  return window.__VINEXT_RSC_PREFETCHED_URLS__;
}

/**
 * Store a prefetched RSC response in the cache.
 * Enforces a maximum cache size to prevent unbounded memory growth on
 * link-heavy pages.
 */
export function storePrefetchResponse(rscUrl: string, response: Response): void {
  const cache = getPrefetchCache();
  const now = Date.now();

  // Sweep expired entries before resorting to FIFO eviction
  if (cache.size >= MAX_PREFETCH_CACHE_SIZE) {
    const prefetched = getPrefetchedUrls();
    for (const [key, entry] of cache) {
      if (now - entry.timestamp >= PREFETCH_CACHE_TTL) {
        cache.delete(key);
        prefetched.delete(key);
      }
    }
  }

  // FIFO fallback if still at capacity after sweep
  if (cache.size >= MAX_PREFETCH_CACHE_SIZE) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) {
      cache.delete(oldest);
      getPrefetchedUrls().delete(oldest);
    }
  }

  cache.set(rscUrl, { response, timestamp: now });
}

// Client navigation listeners
type NavigationListener = () => void;
const _listeners: Set<NavigationListener> = new Set();

function notifyListeners(): void {
  for (const fn of _listeners) fn();
}

// Cached URLSearchParams, pathname, etc. for referential stability
// useSyncExternalStore compares snapshots with Object.is — avoid creating
// new instances on every render (infinite re-renders).
let _cachedSearch = !isServer ? window.location.search : "";
let _cachedReadonlySearchParams = new ReadonlyURLSearchParams(_cachedSearch);
let _cachedEmptyServerSearchParams: ReadonlyURLSearchParams | null = null;
let _cachedPathname = !isServer ? stripBasePath(window.location.pathname, __basePath) : "/";

function getPathnameSnapshot(): string {
  const current = stripBasePath(window.location.pathname, __basePath);
  if (current !== _cachedPathname) {
    _cachedPathname = current;
  }
  return _cachedPathname;
}

function getSearchParamsSnapshot(): ReadonlyURLSearchParams {
  const current = window.location.search;
  if (current !== _cachedSearch) {
    _cachedSearch = current;
    _cachedReadonlySearchParams = new ReadonlyURLSearchParams(current);
  }
  return _cachedReadonlySearchParams;
}

function getServerSearchParamsSnapshot(): ReadonlyURLSearchParams {
  const ctx = _getServerContext() as NavigationContextWithReadonlyCache | null;
  if (ctx != null) {
    const searchParams = ctx.searchParams;
    if (ctx[_READONLY_SEARCH_PARAMS_SOURCE] !== searchParams) {
      ctx[_READONLY_SEARCH_PARAMS_SOURCE] = searchParams;
      ctx[_READONLY_SEARCH_PARAMS] = new ReadonlyURLSearchParams(searchParams);
    }
    return ctx[_READONLY_SEARCH_PARAMS]!;
  }
  if (_cachedEmptyServerSearchParams === null) {
    _cachedEmptyServerSearchParams = new ReadonlyURLSearchParams();
  }
  return _cachedEmptyServerSearchParams;
}

// Track client-side params (set during RSC hydration/navigation)
// We cache the params object for referential stability — only create a new
// object when the params actually change (shallow key/value comparison).
const _EMPTY_PARAMS: Record<string, string | string[]> = {};
let _clientParams: Record<string, string | string[]> = _EMPTY_PARAMS;
let _clientParamsJson = "{}";

export function setClientParams(params: Record<string, string | string[]>): void {
  const json = JSON.stringify(params);
  if (json !== _clientParamsJson) {
    _clientParams = params;
    _clientParamsJson = json;
    // Notify useSyncExternalStore subscribers so useParams() re-renders.
    notifyListeners();
  }
}

/** Get the current client params (for testing referential stability). */
export function getClientParams(): Record<string, string | string[]> {
  return _clientParams;
}

function getClientParamsSnapshot(): Record<string, string | string[]> {
  return _clientParams;
}

function getServerParamsSnapshot(): Record<string, string | string[]> {
  return _getServerContext()?.params ?? _EMPTY_PARAMS;
}

function subscribeToNavigation(cb: () => void): () => void {
  _listeners.add(cb);
  return () => {
    _listeners.delete(cb);
  };
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

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
  // Client-side: use the hook system for reactivity
  return React.useSyncExternalStore(
    subscribeToNavigation,
    getPathnameSnapshot,
    () => _getServerContext()?.pathname ?? "/",
  );
}

/**
 * Returns the current search params as a read-only URLSearchParams.
 */
export function useSearchParams(): ReadonlyURLSearchParams {
  if (isServer) {
    // During SSR of "use client" components, the navigation context may not be set.
    // Return a safe fallback — the client will hydrate with the real value.
    return getServerSearchParamsSnapshot();
  }
  return React.useSyncExternalStore(
    subscribeToNavigation,
    getSearchParamsSnapshot,
    getServerSearchParamsSnapshot,
  );
}

/**
 * Returns the dynamic params for the current route.
 */
export function useParams<
  T extends Record<string, string | string[]> = Record<string, string | string[]>,
>(): T {
  if (isServer) {
    // During SSR of "use client" components, the navigation context may not be set.
    return (_getServerContext()?.params ?? _EMPTY_PARAMS) as T;
  }
  return React.useSyncExternalStore(
    subscribeToNavigation,
    getClientParamsSnapshot as () => T,
    getServerParamsSnapshot as () => T,
  );
}

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
    return current.pathname === next.pathname && current.search === next.search && next.hash !== "";
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

/**
 * Reference to the native history.replaceState before patching.
 * Used internally to avoid triggering the interception for internal operations
 * (e.g. saving scroll position shouldn't cause re-renders).
 * Captured before the history method patching at the bottom of this module.
 */
const _nativeReplaceState: typeof window.history.replaceState | null = !isServer
  ? window.history.replaceState.bind(window.history)
  : null;

/**
 * Save the current scroll position into the current history state.
 * Called before every navigation to enable scroll restoration on back/forward.
 *
 * Uses _nativeReplaceState to avoid triggering the history.replaceState
 * interception (which would cause spurious re-renders from notifyListeners).
 */
function saveScrollPosition(): void {
  if (!_nativeReplaceState) return;
  const state = window.history.state ?? {};
  _nativeReplaceState.call(
    window.history,
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
 * __VINEXT_RSC_PENDING__ first.
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
async function navigateImpl(
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

  // Save scroll position before navigating (for back/forward restoration)
  if (mode === "push") {
    saveScrollPosition();
  }

  // Hash-only change: update URL and scroll to target, skip RSC fetch
  if (isHashOnlyChange(fullHref)) {
    const hash = fullHref.includes("#") ? fullHref.slice(fullHref.indexOf("#")) : "";
    if (mode === "replace") {
      window.history.replaceState(null, "", fullHref);
    } else {
      window.history.pushState(null, "", fullHref);
    }
    notifyListeners();
    if (scroll) {
      scrollToHash(hash);
    }
    return;
  }

  // Extract hash for post-navigation scrolling
  const hashIdx = fullHref.indexOf("#");
  const hash = hashIdx !== -1 ? fullHref.slice(hashIdx) : "";

  if (mode === "replace") {
    window.history.replaceState(null, "", fullHref);
  } else {
    window.history.pushState(null, "", fullHref);
  }
  notifyListeners();

  // Trigger RSC re-fetch if available, and wait for the new content to render
  // before scrolling. This prevents the old page from visibly jumping to the
  // top before the new content paints.
  if (typeof window.__VINEXT_RSC_NAVIGATE__ === "function") {
    await window.__VINEXT_RSC_NAVIGATE__(fullHref);
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
// All methods close over module-level state (navigateImpl, withBasePath, etc.)
// and carry no per-render data, so the object can be created once and reused.
// Next.js returns the same router reference on every call to useRouter(), which
// matters for components that rely on referential equality (e.g. useMemo /
// useEffect dependency arrays, React.memo bailouts).
// ---------------------------------------------------------------------------

const _appRouter = {
  push(href: string, options?: { scroll?: boolean }): void {
    if (isServer) return;
    void navigateImpl(href, "push", options?.scroll !== false);
  },
  replace(href: string, options?: { scroll?: boolean }): void {
    if (isServer) return;
    void navigateImpl(href, "replace", options?.scroll !== false);
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
      void window.__VINEXT_RSC_NAVIGATE__(window.location.href);
    }
  },
  prefetch(href: string): void {
    if (isServer) return;
    // Prefetch the RSC payload for the target route and store in cache
    const fullHref = toBrowserNavigationHref(href, window.location.href, __basePath);
    const rscUrl = toRscUrl(fullHref);
    const prefetched = getPrefetchedUrls();
    if (prefetched.has(rscUrl)) return;
    prefetched.add(rscUrl);
    fetch(rscUrl, {
      headers: { Accept: "text/x-component" },
      credentials: "include",
      priority: "low" as RequestInit["priority"],
    })
      .then((response) => {
        if (response.ok) {
          storePrefetchResponse(rscUrl, response);
        } else {
          // Non-ok response: allow retry on next prefetch() call
          prefetched.delete(rscUrl);
        }
      })
      .catch(() => {
        // Network error: allow retry on next prefetch() call
        prefetched.delete(rscUrl);
      });
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
export function useSelectedLayoutSegment(
  // parallelRoutesKey is accepted for API compat but not yet supported —
  // vinext doesn't implement parallel routes with separate segment tracking.
  _parallelRoutesKey?: string,
): string | null {
  const segments = useSelectedLayoutSegments(_parallelRoutesKey);
  return segments.length > 0 ? segments[0] : null;
}

/**
 * Returns all active segments below the layout where it's called.
 *
 * Each layout in the App Router tree wraps its children with a
 * LayoutSegmentProvider whose value is the remaining route tree segments
 * (including route groups, with dynamic params resolved to actual values
 * and catch-all segments joined with "/"). This hook reads those segments
 * directly from context.
 *
 * @param parallelRoutesKey - Which parallel route to read (default: "children")
 */
export function useSelectedLayoutSegments(
  // parallelRoutesKey is accepted for API compat but not yet supported —
  // vinext doesn't implement parallel routes with separate segment tracking.
  _parallelRoutesKey?: string,
): string[] {
  return useChildSegments();
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
 */
export function redirect(url: string, type?: "replace" | "push" | RedirectType): never {
  throw new VinextNavigationError(
    `NEXT_REDIRECT:${url}`,
    `NEXT_REDIRECT;${type ?? "replace"};${encodeURIComponent(url)}`,
  );
}

/**
 * Trigger a permanent redirect (308).
 */
export function permanentRedirect(url: string): never {
  throw new VinextNavigationError(
    `NEXT_REDIRECT:${url}`,
    `NEXT_REDIRECT;replace;${encodeURIComponent(url)};308`,
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

// React hooks are imported at the top level via ESM.

// Listen for popstate on the client
if (!isServer) {
  window.addEventListener("popstate", (event) => {
    notifyListeners();
    // Restore scroll position for back/forward navigation
    restoreScrollPosition(event.state);
  });

  // ---------------------------------------------------------------------------
  // history.pushState / replaceState interception (shallow routing)
  //
  // Next.js intercepts these native methods so that when user code calls
  // `window.history.pushState(null, '', '/new-path?filter=abc')` directly,
  // React hooks like usePathname() and useSearchParams() re-render with
  // the new URL. This is the foundation for shallow routing patterns
  // (filter UIs, tabs, URL search param state, etc.).
  //
  // We wrap the original methods, call through to the native implementation,
  // then notify our listener system so useSyncExternalStore picks up the
  // URL change.
  // ---------------------------------------------------------------------------
  const originalPushState = window.history.pushState.bind(window.history);
  const originalReplaceState = window.history.replaceState.bind(window.history);

  window.history.pushState = function patchedPushState(
    data: unknown,
    unused: string,
    url?: string | URL | null,
  ): void {
    originalPushState(data, unused, url);
    notifyListeners();
  };

  window.history.replaceState = function patchedReplaceState(
    data: unknown,
    unused: string,
    url?: string | URL | null,
  ): void {
    originalReplaceState(data, unused, url);
    notifyListeners();
  };
}
