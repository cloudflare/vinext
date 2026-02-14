/**
 * next/navigation shim
 *
 * App Router navigation hooks. These work on both server (RSC) and client.
 * Server-side: reads from a request context set by the RSC handler.
 * Client-side: reads from browser Location API and provides navigation.
 */

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

// Track client-side params (set during RSC hydration/navigation)
let _clientParams: Record<string, string | string[]> = {};

export function setClientParams(params: Record<string, string | string[]>): void {
  _clientParams = params;
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
    if (!_serverContext) {
      throw new Error(
        "usePathname() called outside of a request context. " +
          "This usually means it was called in a Server Component that wasn't rendered by the framework.",
      );
    }
    return _serverContext.pathname;
  }
  // Client-side: use the hook system for reactivity
  const { useState: useStateR, useEffect: useEffectR, useSyncExternalStore } = requireReact();
  if (useSyncExternalStore) {
    return useSyncExternalStore(
      (cb: () => void) => { _listeners.add(cb); return () => { _listeners.delete(cb); }; },
      () => stripBasePath(window.location.pathname),
      () => _serverContext?.pathname ?? "/",
    );
  }
  // Fallback for older React
  const [pathname, setPathname] = useStateR(stripBasePath(window.location.pathname));
  useEffectR(() => {
    const handler = () => setPathname(stripBasePath(window.location.pathname));
    _listeners.add(handler);
    return () => { _listeners.delete(handler); };
  }, []);
  return pathname;
}

/**
 * Returns the current search params as a read-only URLSearchParams.
 */
export function useSearchParams(): URLSearchParams {
  if (isServer) {
    if (!_serverContext) {
      throw new Error("useSearchParams() called outside of a request context.");
    }
    return _serverContext.searchParams;
  }
  const { useSyncExternalStore, useState: useStateR, useEffect: useEffectR } = requireReact();
  if (useSyncExternalStore) {
    return useSyncExternalStore(
      (cb: () => void) => { _listeners.add(cb); return () => { _listeners.delete(cb); }; },
      () => new URLSearchParams(window.location.search),
      () => _serverContext?.searchParams ?? new URLSearchParams(),
    );
  }
  const [sp, setSp] = useStateR(new URLSearchParams(window.location.search));
  useEffectR(() => {
    const handler = () => setSp(new URLSearchParams(window.location.search));
    _listeners.add(handler);
    return () => { _listeners.delete(handler); };
  }, []);
  return sp;
}

/**
 * Returns the dynamic params for the current route.
 */
export function useParams<
  T extends Record<string, string | string[]> = Record<string, string | string[]>,
>(): T {
  if (isServer) {
    if (!_serverContext) {
      throw new Error("useParams() called outside of a request context.");
    }
    return _serverContext.params as T;
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
 * Save the current scroll position into the current history state.
 * Called before every navigation to enable scroll restoration on back/forward.
 */
function saveScrollPosition(): void {
  const state = window.history.state ?? {};
  window.history.replaceState(
    { ...state, __nextcompat_scrollX: window.scrollX, __nextcompat_scrollY: window.scrollY },
    "",
  );
}

/**
 * Restore scroll position from a history state object (used on popstate).
 */
function restoreScrollPosition(state: unknown): void {
  if (state && typeof state === "object" && "__nextcompat_scrollY" in state) {
    const { __nextcompat_scrollX: x, __nextcompat_scrollY: y } = state as {
      __nextcompat_scrollX: number;
      __nextcompat_scrollY: number;
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
  if (typeof (window as any).__NEXTCOMPAT_RSC_NAVIGATE__ === "function") {
    (window as any).__NEXTCOMPAT_RSC_NAVIGATE__(fullHref);
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
      if (typeof (window as any).__NEXTCOMPAT_RSC_NAVIGATE__ === "function") {
        (window as any).__NEXTCOMPAT_RSC_NAVIGATE__(window.location.href);
      }
    },
    prefetch(_href: string): void {
      // No-op for now — could implement RSC prefetching later
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

// ---------------------------------------------------------------------------
// Non-hook utilities (can be called from Server Components)
// ---------------------------------------------------------------------------

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
 * Trigger a not-found response. Caught by the framework.
 */
export function notFound(): never {
  const error = new Error("NEXT_NOT_FOUND");
  (error as any).digest = "NEXT_NOT_FOUND";
  throw error;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requireReact() {
  // Dynamic require to avoid issues in RSC environment
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require("react");
  return {
    useState: React.useState,
    useEffect: React.useEffect,
    useSyncExternalStore: React.useSyncExternalStore,
  };
}

// Listen for popstate on the client
if (!isServer) {
  window.addEventListener("popstate", (event) => {
    notifyListeners();
    // Restore scroll position for back/forward navigation
    restoreScrollPosition(event.state);
  });
}
