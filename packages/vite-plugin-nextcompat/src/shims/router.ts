/**
 * next/router shim
 *
 * Provides useRouter() hook and Router singleton for Pages Router.
 * Backed by the browser History API.
 */
import { useState, useEffect, useCallback, useMemo } from "react";

interface NextRouter {
  /** Current pathname */
  pathname: string;
  /** Current route pattern (same as pathname for now) */
  route: string;
  /** Query parameters */
  query: Record<string, string | string[]>;
  /** Full URL including query string */
  asPath: string;
  /** Base path */
  basePath: string;
  /** Current locale */
  locale?: string;
  /** Available locales */
  locales?: string[];
  /** Default locale */
  defaultLocale?: string;
  /** Whether the router is ready */
  isReady: boolean;
  /** Whether this is a preview */
  isPreview: boolean;
  /** Whether this is a fallback page */
  isFallback: boolean;

  /** Navigate to a new URL */
  push(url: string | UrlObject, as?: string, options?: TransitionOptions): Promise<boolean>;
  /** Replace current URL */
  replace(url: string | UrlObject, as?: string, options?: TransitionOptions): Promise<boolean>;
  /** Go back */
  back(): void;
  /** Reload the page */
  reload(): void;
  /** Prefetch a page (no-op for now) */
  prefetch(url: string): Promise<void>;
  /** Listen for route changes */
  events: RouterEvents;
}

interface UrlObject {
  pathname?: string;
  query?: Record<string, string>;
}

interface TransitionOptions {
  shallow?: boolean;
  scroll?: boolean;
  locale?: string;
}

type RouteChangeHandler = (url: string) => void;
type RouteErrorHandler = (err: Error, url: string) => void;

interface RouterEvents {
  on(event: string, handler: (...args: unknown[]) => void): void;
  off(event: string, handler: (...args: unknown[]) => void): void;
  emit(event: string, ...args: unknown[]): void;
}

function createRouterEvents(): RouterEvents {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  return {
    on(event: string, handler: (...args: unknown[]) => void) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(handler);
    },
    off(event: string, handler: (...args: unknown[]) => void) {
      listeners.get(event)?.delete(handler);
    },
    emit(event: string, ...args: unknown[]) {
      listeners.get(event)?.forEach((handler) => handler(...args));
    },
  };
}

// Singleton events instance
const routerEvents = createRouterEvents();

function resolveUrl(url: string | UrlObject): string {
  if (typeof url === "string") return url;
  let result = url.pathname ?? "/";
  if (url.query) {
    const params = new URLSearchParams(url.query);
    result += `?${params.toString()}`;
  }
  return result;
}

/**
 * SSR context - set by the dev server before rendering each page.
 * Provides the actual URL, route pattern, and params during SSR.
 */
interface SSRContext {
  pathname: string;
  query: Record<string, string | string[]>;
  asPath: string;
}

let ssrContext: SSRContext | null = null;

/**
 * Set the router's SSR context. Called by the dev server before rendering.
 */
export function setSSRContext(ctx: SSRContext | null): void {
  ssrContext = ctx;
}

function getPathnameAndQuery(): {
  pathname: string;
  query: Record<string, string>;
  asPath: string;
} {
  if (typeof window === "undefined") {
    if (ssrContext) {
      // Flatten query values to strings for compatibility
      const query: Record<string, string> = {};
      for (const [key, value] of Object.entries(ssrContext.query)) {
        query[key] = Array.isArray(value) ? value.join(",") : value;
      }
      return {
        pathname: ssrContext.pathname,
        query,
        asPath: ssrContext.asPath,
      };
    }
    return { pathname: "/", query: {}, asPath: "/" };
  }
  const pathname = window.location.pathname;
  const query: Record<string, string> = {};
  const params = new URLSearchParams(window.location.search);
  for (const [key, value] of params) {
    query[key] = value;
  }
  const asPath = window.location.pathname + window.location.search;
  return { pathname, query, asPath };
}

/**
 * useRouter hook - Pages Router compatible.
 */
export function useRouter(): NextRouter {
  const [{ pathname, query, asPath }, setState] = useState(getPathnameAndQuery);

  useEffect(() => {
    const onPopState = () => {
      setState(getPathnameAndQuery());
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const push = useCallback(
    async (url: string | UrlObject, _as?: string, options?: TransitionOptions): Promise<boolean> => {
      const resolved = resolveUrl(url);
      routerEvents.emit("routeChangeStart", resolved);
      window.history.pushState({}, "", resolved);
      setState(getPathnameAndQuery());
      routerEvents.emit("routeChangeComplete", resolved);
      if (options?.scroll !== false) {
        window.scrollTo(0, 0);
      }
      return true;
    },
    [],
  );

  const replace = useCallback(
    async (url: string | UrlObject, _as?: string, options?: TransitionOptions): Promise<boolean> => {
      const resolved = resolveUrl(url);
      routerEvents.emit("routeChangeStart", resolved);
      window.history.replaceState({}, "", resolved);
      setState(getPathnameAndQuery());
      routerEvents.emit("routeChangeComplete", resolved);
      if (options?.scroll !== false) {
        window.scrollTo(0, 0);
      }
      return true;
    },
    [],
  );

  const back = useCallback(() => {
    window.history.back();
  }, []);

  const reload = useCallback(() => {
    window.location.reload();
  }, []);

  const prefetch = useCallback(async (_url: string): Promise<void> => {
    // No-op for now - can implement link prefetching later
  }, []);

  const router = useMemo(
    (): NextRouter => ({
      pathname,
      route: pathname,
      query,
      asPath,
      basePath: "",
      isReady: true,
      isPreview: false,
      isFallback: false,
      push,
      replace,
      back,
      reload,
      prefetch,
      events: routerEvents,
    }),
    [pathname, query, asPath, push, replace, back, reload, prefetch],
  );

  return router;
}

// Also export a default Router singleton for `import Router from 'next/router'`
const Router = {
  push: (url: string | UrlObject) =>
    Promise.resolve().then(() => {
      const resolved = resolveUrl(url);
      window.history.pushState({}, "", resolved);
      window.dispatchEvent(new PopStateEvent("popstate"));
      return true;
    }),
  replace: (url: string | UrlObject) =>
    Promise.resolve().then(() => {
      const resolved = resolveUrl(url);
      window.history.replaceState({}, "", resolved);
      window.dispatchEvent(new PopStateEvent("popstate"));
      return true;
    }),
  back: () => window.history.back(),
  reload: () => window.location.reload(),
  prefetch: async () => {},
  events: routerEvents,
};

export default Router;
