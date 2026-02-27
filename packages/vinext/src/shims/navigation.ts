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

// ─── Layout segment depth context ─────────────────────────────────────────────
// Used by useSelectedLayoutSegments() to know which layout it's inside.
// The context is created lazily because `React.createContext` is NOT available in
// the react-server condition of React. In the RSC environment, this remains
// null and the hooks fall back to returning all segments (depth 0).
// In SSR and browser environments, the context is created and used normally.

let _LayoutSegmentCtx: React.Context<number> | null = null;

/**
 * Get or create the layout segment context.
 * Returns null in the RSC environment (createContext unavailable).
 */
export function getLayoutSegmentContext(): React.Context<number> | null {
  if (_LayoutSegmentCtx === null && typeof React.createContext === "function") {
    _LayoutSegmentCtx = React.createContext<number>(0);
  }
  return _LayoutSegmentCtx;
}

/**
 * Read the layout segment depth from context. Returns 0 if no context
 * is available (RSC environment, outside React tree, or root level).
 */
function useLayoutSegmentDepth(): number {
  const ctx = getLayoutSegmentContext();
  if (!ctx) return 0;
  // useContext is safe here because if createContext exists, useContext does too.
  // This branch is only taken in SSR/Browser, never in RSC.
  // Try/catch for unit tests that call this hook outside a React render tree.
  try {
    return React.useContext(ctx);
  } catch {
    return 0;
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

// ---------------------------------------------------------------------------
// Server-side navigation state lives in a separate server-only module
// (navigation-state.ts) that uses AsyncLocalStorage for request isolation.
// This module is bundled for the browser, so it can't import node:async_hooks.
//
// On the server: state functions are set by navigation-state.ts at import time.
// On the client: _serverContext falls back to null (hooks use window instead).
// ---------------------------------------------------------------------------

let _serverContext: NavigationContext | null = null;
let _serverInsertedHTMLCallbacks: Array<() => unknown> = [];

// These are overridden by navigation-state.ts on the server to use ALS.
let _getServerContext = (): NavigationContext | null => _serverContext;
let _setServerContext = (ctx: NavigationContext | null): void => { _serverContext = ctx; };
let _getInsertedHTMLCallbacks = (): Array<() => unknown> => _serverInsertedHTMLCallbacks;
let _clearInsertedHTMLCallbacks = (): void => { _serverInsertedHTMLCallbacks = []; };

/**
 * Register ALS-backed state accessors. Called by navigation-state.ts on import.
 * @internal
 */
export function _registerStateAccessors(accessors: {
  getServerContext: () => NavigationContext | null;
  setServerContext: (ctx: NavigationContext | null) => void;
  getInsertedHTMLCallbacks: () => Array<() => unknown>;
  clearInsertedHTMLCallbacks: () => void;
}): void {
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

/** Strip basePath prefix from a browser pathname */
function stripBasePath(p: string): string {
  if (!__basePath) return p;
  if (p.startsWith(__basePath)) return p.slice(__basePath.length) || "/";
  return p;
}

/** Prepend basePath to a path for browser URLs / fetches */
function withBasePath(p: string): string {
  if (!__basePath) return p;
  return __basePath + p;
}

// ---------------------------------------------------------------------------
// RSC prefetch cache utilities (shared between link.tsx and browser entry)
// ---------------------------------------------------------------------------

/** Maximum number of entries in the RSC prefetch cache. */
const MAX_PREFETCH_CACHE_SIZE = 50;

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
  const normalizedPath = pathname.length > 1 && pathname.endsWith("/")
    ? pathname.slice(0, -1)
    : pathname;
  return normalizedPath + ".rsc" + query;
}

/** Get or create the shared in-memory RSC prefetch cache on window. */
export function getPrefetchCache(): Map<string, PrefetchCacheEntry> {
  if (isServer) return new Map();
  const win = window as any;
  if (!win.__VINEXT_RSC_PREFETCH_CACHE__) {
    win.__VINEXT_RSC_PREFETCH_CACHE__ = new Map<string, PrefetchCacheEntry>();
  }
  return win.__VINEXT_RSC_PREFETCH_CACHE__;
}

/**
 * Get or create the shared set of already-prefetched RSC URLs on window.
 * Keyed by rscUrl so that the browser entry can clear entries when consumed.
 */
export function getPrefetchedUrls(): Set<string> {
  if (isServer) return new Set();
  const win = window as any;
  if (!win.__VINEXT_RSC_PREFETCHED_URLS__) {
    win.__VINEXT_RSC_PREFETCHED_URLS__ = new Set<string>();
  }
  return win.__VINEXT_RSC_PREFETCHED_URLS__;
}

/**
 * Store a prefetched RSC response in the cache.
 * Enforces a maximum cache size to prevent unbounded memory growth on
 * link-heavy pages.
 */
export function storePrefetchResponse(rscUrl: string, response: Response): void {
  const cache = getPrefetchCache();
  // Evict oldest entry if at capacity (Map iterates in insertion order)
  if (cache.size >= MAX_PREFETCH_CACHE_SIZE) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(rscUrl, { response, timestamp: Date.now() });
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
let _cachedSearchParams: URLSearchParams = new URLSearchParams(_cachedSearch);
let _cachedServerSearchParams: URLSearchParams | null = null;
let _cachedPathname = !isServer ? stripBasePath(window.location.pathname) : "/";

function getPathnameSnapshot(): string {
  const current = stripBasePath(window.location.pathname);
  if (current !== _cachedPathname) {
    _cachedPathname = current;
  }
  return _cachedPathname;
}

function getSearchParamsSnapshot(): URLSearchParams {
  const current = window.location.search;
  if (current !== _cachedSearch) {
    _cachedSearch = current;
    _cachedSearchParams = new URLSearchParams(current);
  }
  return _cachedSearchParams;
}

function getServerSearchParamsSnapshot(): URLSearchParams {
  const ctx = _getServerContext();
  if (ctx?.searchParams != null) return ctx.searchParams;
  if (_cachedServerSearchParams === null) {
    _cachedServerSearchParams = new URLSearchParams();
  }
  return _cachedServerSearchParams;
}

// Track client-side params (set during RSC hydration/navigation)
// We cache the params object for referential stability — only create a new
// object when the params actually change (shallow key/value comparison).
let _clientParams: Record<string, string | string[]> = {};
let _clientParamsJson = "{}";

export function setClientParams(params: Record<string, string | string[]>): void {
  const json = JSON.stringify(params);
  if (json !== _clientParamsJson) {
    _clientParams = params;
    _clientParamsJson = json;
  }
}

/** Get the current client params (for testing referential stability). */
export function getClientParams(): Record<string, string | string[]> {
  return _clientParams;
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
    (cb: () => void) => { _listeners.add(cb); return () => { _listeners.delete(cb); }; },
    getPathnameSnapshot,
    () => _getServerContext()?.pathname ?? "/",
  );
}

/**
 * Returns the current search params as a read-only URLSearchParams.
 */
export function useSearchParams(): URLSearchParams {
  if (isServer) {
    // During SSR of "use client" components, the navigation context may not be set.
    // Return a safe fallback — the client will hydrate with the real value.
    return _getServerContext()?.searchParams ?? new URLSearchParams();
  }
   return React.useSyncExternalStore(
    (cb: () => void) => { _listeners.add(cb); return () => { _listeners.delete(cb); }; },
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
    return (_getServerContext()?.params ?? {}) as T;
  }
  return _clientParams as T;
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
const _nativeReplaceState = !isServer
  ? window.history.replaceState.bind(window.history)
  : (null as unknown as typeof window.history.replaceState);

/**
 * Save the current scroll position into the current history state.
 * Called before every navigation to enable scroll restoration on back/forward.
 *
 * Uses _nativeReplaceState to avoid triggering the history.replaceState
 * interception (which would cause spurious re-renders from notifyListeners).
 */
function saveScrollPosition(): void {
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
      const pending: Promise<void> | null = (window as any).__VINEXT_RSC_PENDING__ ?? null;

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
  // External URLs: use full page navigation
  if (isExternalUrl(href)) {
    if (mode === "replace") {
      window.location.replace(href);
    } else {
      window.location.assign(href);
    }
    return;
  }

  const fullHref = withBasePath(href);

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
  if (typeof (window as any).__VINEXT_RSC_NAVIGATE__ === "function") {
    await (window as any).__VINEXT_RSC_NAVIGATE__(fullHref);
  }

  if (scroll) {
    if (hash) {
      scrollToHash(hash);
    } else {
      window.scrollTo(0, 0);
    }
  }
}

/**
 * App Router's useRouter — returns push/replace/back/forward/refresh.
 * Different from Pages Router's useRouter (next/router).
 */
export function useRouter() {
  const router = {
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
      if (typeof (window as any).__VINEXT_RSC_NAVIGATE__ === "function") {
        (window as any).__VINEXT_RSC_NAVIGATE__(window.location.href);
      }
    },
    prefetch(href: string): void {
      if (isServer) return;
      // Prefetch the RSC payload for the target route and store in cache
      const fullHref = withBasePath(href);
      const rscUrl = toRscUrl(fullHref);
      const prefetched = getPrefetchedUrls();
      if (prefetched.has(rscUrl)) return;
      prefetched.add(rscUrl);
      fetch(rscUrl, {
        headers: { Accept: "text/x-component" },
        credentials: "include",
        priority: "low" as RequestInit["priority"],
      }).then((response) => {
        if (response.ok) {
          storePrefetchResponse(rscUrl, response);
        } else {
          // Non-ok response: allow retry on next prefetch() call
          prefetched.delete(rscUrl);
        }
      }).catch(() => {
        // Network error: allow retry on next prefetch() call
        prefetched.delete(rscUrl);
      });
    },
  };
  return router;
}

/**
 * Returns the active child segment one level below the layout where it's called.
 *
 * In Next.js, this is layout-aware: it returns the segment relative to the
 * nearest parent layout. In our implementation, we approximate by returning
 * the first segment after a specified parallel route key, or the first segment
 * of the pathname. Returns null if at the leaf (no child segments).
 *
 * @param parallelRoutesKey - Which parallel route to read (default: "children")
 */
export function useSelectedLayoutSegment(
  parallelRoutesKey?: string,
): string | null {
  const segments = useSelectedLayoutSegments(parallelRoutesKey);
  return segments.length > 0 ? segments[0] : null;
}

/**
 * Returns all active segments below the layout where it's called.
 *
 * In Next.js, this returns the full array of segments from the current
 * layout down to the leaf page. Each layout in the tree wraps its children
 * with a LayoutSegmentProvider that records the URL segment depth at that
 * level. This hook reads that depth from context and slices the pathname
 * segments accordingly.
 *
 * @param parallelRoutesKey - Which parallel route to read (default: "children")
 */
export function useSelectedLayoutSegments(
  _parallelRoutesKey?: string,
): string[] {
  const pathname = usePathname();
  const depth = useLayoutSegmentDepth();
  const segments = pathname.split("/").filter(Boolean);
  return segments.slice(depth);
}

/**
 * ReadonlyURLSearchParams — type alias matching Next.js.
 * In Next.js this prevents mutation, but since URLSearchParams is the underlying
 * type in our implementation, we export it as-is for type compatibility.
 */
export type ReadonlyURLSearchParams = URLSearchParams;

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
    const digest = String((error as any).digest);
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
    const digest = String((error as any).digest);
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
 * Throw a redirect. Caught by the framework to send a redirect response.
 */
export function redirect(url: string, type?: "replace" | "push" | RedirectType): never {
  const error = new Error(`NEXT_REDIRECT:${url}`);
  (error as any).digest = `NEXT_REDIRECT;${type ?? "replace"};${encodeURIComponent(url)}`;
  throw error;
}

/**
 * Trigger a permanent redirect (308).
 */
export function permanentRedirect(url: string): never {
  const error = new Error(`NEXT_REDIRECT:${url}`);
  (error as any).digest = `NEXT_REDIRECT;replace;${encodeURIComponent(url)};308`;
  throw error;
}

/**
 * Trigger a not-found response (404). Caught by the framework.
 */
export function notFound(): never {
  const error = new Error("NEXT_NOT_FOUND");
  (error as any).digest = `${HTTP_ERROR_FALLBACK_ERROR_CODE};404`;
  throw error;
}

/**
 * Trigger a forbidden response (403). Caught by the framework.
 * In Next.js, this is gated behind experimental.authInterrupts — we
 * support it unconditionally for maximum compatibility.
 */
export function forbidden(): never {
  const error = new Error("NEXT_FORBIDDEN");
  (error as any).digest = `${HTTP_ERROR_FALLBACK_ERROR_CODE};403`;
  throw error;
}

/**
 * Trigger an unauthorized response (401). Caught by the framework.
 * In Next.js, this is gated behind experimental.authInterrupts — we
 * support it unconditionally for maximum compatibility.
 */
export function unauthorized(): never {
  const error = new Error("NEXT_UNAUTHORIZED");
  (error as any).digest = `${HTTP_ERROR_FALLBACK_ERROR_CODE};401`;
  throw error;
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
