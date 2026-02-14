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
 * App Router's useRouter — returns push/replace/back/forward/refresh.
 * Different from Pages Router's useRouter (next/router).
 */
export function useRouter() {
  const router = {
    push(href: string, options?: { scroll?: boolean }): void {
      if (isServer) return;
      const fullHref = withBasePath(href);
      window.history.pushState(null, "", fullHref);
      notifyListeners();
      if (options?.scroll !== false) {
        window.scrollTo(0, 0);
      }
      // Trigger RSC re-fetch if available
      if (typeof (window as any).__NEXTCOMPAT_RSC_NAVIGATE__ === "function") {
        (window as any).__NEXTCOMPAT_RSC_NAVIGATE__(fullHref);
      }
    },
    replace(href: string, options?: { scroll?: boolean }): void {
      if (isServer) return;
      const fullHref = withBasePath(href);
      window.history.replaceState(null, "", fullHref);
      notifyListeners();
      if (options?.scroll !== false) {
        window.scrollTo(0, 0);
      }
      if (typeof (window as any).__NEXTCOMPAT_RSC_NAVIGATE__ === "function") {
        (window as any).__NEXTCOMPAT_RSC_NAVIGATE__(fullHref);
      }
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
  window.addEventListener("popstate", () => {
    notifyListeners();
  });
}
