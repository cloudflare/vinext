/**
 * next/navigation shim
 *
 * App Router navigation hooks. These work on both server (RSC) and client.
 * Server-side: reads from a request context set by the RSC handler.
 * Client-side: reads from browser Location API and provides navigation.
 */

import { useSyncExternalStore } from "react";

// ---------------------------------------------------------------------------
// Server-side request context (set by the RSC entry before rendering)
// ---------------------------------------------------------------------------

interface NavigationContext {
  pathname: string;
  searchParams: URLSearchParams;
  params: Record<string, string | string[]>;
}

let _serverContext: NavigationContext | null = null;

/**
 * Set the navigation context for the current SSR/RSC render.
 * Called by the framework entry before rendering each request.
 */
export function setNavigationContext(ctx: NavigationContext | null): void {
  _serverContext = ctx;
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

// Client navigation listeners
type NavigationListener = () => void;
const _listeners: Set<NavigationListener> = new Set();

function notifyListeners(): void {
  for (const fn of _listeners) fn();
}

// Cached URLSearchParams for referential stability (useSyncExternalStore
// compares snapshots with Object.is — new URLSearchParams instances are
// never equal, which would cause infinite re-renders).
let _cachedSearch = !isServer ? window.location.search : "";
let _cachedSearchParams: URLSearchParams = new URLSearchParams(_cachedSearch);

function getSearchParamsSnapshot(): URLSearchParams {
  const current = window.location.search;
  if (current !== _cachedSearch) {
    _cachedSearch = current;
    _cachedSearchParams = new URLSearchParams(current);
  }
  return _cachedSearchParams;
}

// Same for pathname — cache the string for referential stability
let _cachedPathname = !isServer ? stripBasePath(window.location.pathname) : "/";

function getPathnameSnapshot(): string {
  const current = stripBasePath(window.location.pathname);
  if (current !== _cachedPathname) {
    _cachedPathname = current;
  }
  return _cachedPathname;
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
    // During SSR of "use client" components, _serverContext may not be set.
    // Return a safe fallback — the client will hydrate with the real value.
    return _serverContext?.pathname ?? "/";
  }
  // Client-side: use the hook system for reactivity
  return useSyncExternalStore(
    (cb: () => void) => { _listeners.add(cb); return () => { _listeners.delete(cb); }; },
    getPathnameSnapshot,
    () => _serverContext?.pathname ?? "/",
  );
}

/**
 * Returns the current search params as a read-only URLSearchParams.
 */
export function useSearchParams(): URLSearchParams {
  if (isServer) {
    // During SSR of "use client" components, _serverContext may not be set.
    // Return a safe fallback — the client will hydrate with the real value.
    return _serverContext?.searchParams ?? new URLSearchParams();
  }
  return useSyncExternalStore(
    (cb: () => void) => { _listeners.add(cb); return () => { _listeners.delete(cb); }; },
    getSearchParamsSnapshot,
    () => _serverContext?.searchParams ?? new URLSearchParams(),
  );
}

/**
 * Returns the dynamic params for the current route.
 */
export function useParams<
  T extends Record<string, string | string[]> = Record<string, string | string[]>,
>(): T {
  if (isServer) {
    // During SSR of "use client" components, _serverContext may not be set.
    return (_serverContext?.params ?? {}) as T;
  }
  return _clientParams as T;
}

/**
 * Check if a href is an external URL.
 */
function isExternalUrl(href: string): boolean {
  return href.startsWith("http://") || href.startsWith("https://") || href.startsWith("//");
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
 */
function restoreScrollPosition(state: unknown): void {
  if (state && typeof state === "object" && "__vinext_scrollY" in state) {
    const { __vinext_scrollX: x, __vinext_scrollY: y } = state as {
      __vinext_scrollX: number;
      __vinext_scrollY: number;
    };
    // Use requestAnimationFrame to ensure DOM has updated before scrolling
    requestAnimationFrame(() => {
      window.scrollTo(x, y);
    });
  }
}

/**
 * Navigate to a URL, handling external URLs, hash-only changes, and RSC navigation.
 */
function navigateImpl(
  href: string,
  mode: "push" | "replace",
  scroll: boolean,
): void {
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

  // Trigger RSC re-fetch if available
  if (typeof (window as any).__VINEXT_RSC_NAVIGATE__ === "function") {
    (window as any).__VINEXT_RSC_NAVIGATE__(fullHref);
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
      navigateImpl(href, "push", options?.scroll !== false);
    },
    replace(href: string, options?: { scroll?: boolean }): void {
      if (isServer) return;
      navigateImpl(href, "replace", options?.scroll !== false);
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
      // Prefetch the RSC payload for the target route
      const fullHref = withBasePath(href);
      const beforeHash = fullHref.split("#")[0];
      const qIdx = beforeHash.indexOf("?");
      const rscUrl = qIdx === -1 ? beforeHash + ".rsc" : beforeHash.slice(0, qIdx) + ".rsc" + beforeHash.slice(qIdx);
      fetch(rscUrl, {
        priority: "low" as RequestInit["priority"],
      }).catch(() => {
        // Silently ignore prefetch failures
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
 * layout down to the leaf page. In our implementation, we derive this
 * from the pathname.
 *
 * @param parallelRoutesKey - Which parallel route to read (default: "children")
 */
export function useSelectedLayoutSegments(
  _parallelRoutesKey?: string,
): string[] {
  const pathname = usePathname();
  // Split pathname into segments, filtering empty strings
  const segments = pathname.split("/").filter(Boolean);
  return segments;
}

/**
 * ReadonlyURLSearchParams — type alias matching Next.js.
 * In Next.js this prevents mutation, but since URLSearchParams is the underlying
 * type in our implementation, we export it as-is for type compatibility.
 */
export type ReadonlyURLSearchParams = URLSearchParams;

/**
 * useServerInsertedHTML — for injecting HTML from server components.
 * Used by styling libraries (styled-components, emotion) for SSR.
 * In our implementation, this is a no-op since we don't have the same
 * streaming injection mechanism.
 */
export function useServerInsertedHTML(_callback: () => unknown): void {
  // No-op — styles should be handled via Vite's CSS pipeline
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
 * Throw a redirect. Caught by the framework to send a redirect response.
 */
export function redirect(url: string, type?: "replace" | "push"): never {
  const error = new Error(`NEXT_REDIRECT:${url}`);
  (error as any).digest = `NEXT_REDIRECT;${type ?? "replace"};${url}`;
  throw error;
}

/**
 * Trigger a permanent redirect (308).
 */
export function permanentRedirect(url: string): never {
  const error = new Error(`NEXT_REDIRECT:${url}`);
  (error as any).digest = `NEXT_REDIRECT;replace;${url};308`;
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
