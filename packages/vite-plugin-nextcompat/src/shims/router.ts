/**
 * next/router shim
 *
 * Provides useRouter() hook and Router singleton for Pages Router.
 * Backed by the browser History API. Supports client-side navigation
 * by fetching new page data and re-rendering the React root.
 */
import { useState, useEffect, useCallback, useMemo } from "react";

/** basePath from next.config.js, injected by the plugin at build time */
const __basePath: string = process.env.__NEXT_ROUTER_BASEPATH ?? "";

/** Prepend basePath to a path for browser URLs / fetches */
function withBasePath(p: string): string {
  if (!__basePath) return p;
  return __basePath + p;
}

/** Strip basePath prefix from a browser pathname */
function stripBasePath(p: string): string {
  if (!__basePath) return p;
  if (p.startsWith(__basePath)) return p.slice(__basePath.length) || "/";
  return p;
}

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

// Route event handler types (used by consumers via router.events)
type _RouteChangeHandler = (url: string) => void;
type _RouteErrorHandler = (err: Error, url: string) => void;

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
 */
interface SSRContext {
  pathname: string;
  query: Record<string, string | string[]>;
  asPath: string;
  locale?: string;
  locales?: string[];
  defaultLocale?: string;
}

let ssrContext: SSRContext | null = null;

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
      const query: Record<string, string> = {};
      for (const [key, value] of Object.entries(ssrContext.query)) {
        query[key] = Array.isArray(value) ? value.join(",") : value;
      }
      return { pathname: ssrContext.pathname, query, asPath: ssrContext.asPath };
    }
    return { pathname: "/", query: {}, asPath: "/" };
  }
  const pathname = stripBasePath(window.location.pathname);
  const query: Record<string, string> = {};
  const params = new URLSearchParams(window.location.search);
  for (const [key, value] of params) {
    query[key] = value;
  }
  const asPath = pathname + window.location.search;
  return { pathname, query, asPath };
}

/**
 * Perform client-side navigation: fetch the target page's HTML,
 * extract __NEXT_DATA__, and re-render the React root.
 */
let _navInProgress = false;
async function navigateClient(url: string): Promise<void> {
  if (typeof window === "undefined") return;

  const win = window as any;
  const root = win.__NEXTCOMPAT_ROOT__;
  if (!root) {
    // No React root yet — fall back to hard navigation
    window.location.href = url;
    return;
  }

  // Prevent re-entrant navigation (e.g., double popstate events)
  if (_navInProgress) return;
  _navInProgress = true;

  try {
    // Fetch the target page's SSR HTML
    const res = await fetch(url, { headers: { Accept: "text/html" } });
    if (!res.ok) {
      window.location.href = url;
      return;
    }

    const html = await res.text();

    // Extract __NEXT_DATA__ from the HTML
    const match = html.match(/<script>window\.__NEXT_DATA__\s*=\s*(.*?)<\/script>/);
    if (!match) {
      window.location.href = url;
      return;
    }

    const nextData = JSON.parse(match[1]);
    const { pageProps } = nextData.props;
    win.__NEXT_DATA__ = nextData;

    // Get the page module URL from __NEXT_DATA__.__nextcompat (preferred),
    // or fall back to parsing the hydration script
    let pageModuleUrl: string | undefined =
      nextData.__nextcompat?.pageModuleUrl;

    if (!pageModuleUrl) {
      // Legacy fallback: try to find the module URL in the inline script
      const moduleMatch = html.match(/import\("([^"]+)"\);\s*\n\s*const PageComponent/);
      const altMatch = html.match(/await import\("([^"]+pages\/[^"]+)"\)/);
      pageModuleUrl = moduleMatch?.[1] ?? altMatch?.[1] ?? undefined;
    }

    if (!pageModuleUrl) {
      window.location.href = url;
      return;
    }

    // Dynamically import the new page module
    const pageModule = await import(/* @vite-ignore */ pageModuleUrl);
    const PageComponent = pageModule.default;

    if (!PageComponent) {
      window.location.href = url;
      return;
    }

    // Import React for createElement
    const React = (await import("react")).default;

    // Re-render with the new page, loading _app if needed
    let AppComponent = win.__NEXTCOMPAT_APP__;
    const appModuleUrl: string | undefined =
      nextData.__nextcompat?.appModuleUrl;

    if (!AppComponent && appModuleUrl) {
      try {
        const appModule = await import(/* @vite-ignore */ appModuleUrl);
        AppComponent = appModule.default;
        win.__NEXTCOMPAT_APP__ = AppComponent;
      } catch {
        // _app not available — continue without it
      }
    }

    let element;
    if (AppComponent) {
      element = React.createElement(AppComponent, {
        Component: PageComponent,
        pageProps,
      });
    } else {
      element = React.createElement(PageComponent, pageProps);
    }

    root.render(element);
  } catch (err) {
    console.error("[nextcompat] Client navigation failed:", err);
    window.location.href = url;
  } finally {
    _navInProgress = false;
  }
}

/**
 * useRouter hook - Pages Router compatible.
 */
export function useRouter(): NextRouter {
  const [{ pathname, query, asPath }, setState] = useState(getPathnameAndQuery);

  useEffect(() => {
    const onPopState = () => {
      setState(getPathnameAndQuery());
      // Re-render with the new page on back/forward navigation
      navigateClient(window.location.pathname + window.location.search);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  // Listen for custom navigation events from Link component
  useEffect(() => {
    const onNavigate = ((_e: CustomEvent) => {
      setState(getPathnameAndQuery());
    }) as EventListener;
    window.addEventListener("nextcompat:navigate", onNavigate);
    return () => window.removeEventListener("nextcompat:navigate", onNavigate);
  }, []);

  const push = useCallback(
    async (url: string | UrlObject, _as?: string, options?: TransitionOptions): Promise<boolean> => {
      const resolved = resolveUrl(url);
      const full = withBasePath(resolved);
      routerEvents.emit("routeChangeStart", resolved);
      window.history.pushState({}, "", full);
      await navigateClient(full);
      setState(getPathnameAndQuery());
      routerEvents.emit("routeChangeComplete", resolved);
      if (options?.scroll !== false) {
        window.scrollTo(0, 0);
      }
      window.dispatchEvent(new CustomEvent("nextcompat:navigate"));
      return true;
    },
    [],
  );

  const replace = useCallback(
    async (url: string | UrlObject, _as?: string, options?: TransitionOptions): Promise<boolean> => {
      const resolved = resolveUrl(url);
      const full = withBasePath(resolved);
      routerEvents.emit("routeChangeStart", resolved);
      window.history.replaceState({}, "", full);
      await navigateClient(full);
      setState(getPathnameAndQuery());
      routerEvents.emit("routeChangeComplete", resolved);
      if (options?.scroll !== false) {
        window.scrollTo(0, 0);
      }
      window.dispatchEvent(new CustomEvent("nextcompat:navigate"));
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

  // Get i18n info from SSR context or window
  const locale = typeof window === "undefined"
    ? ssrContext?.locale
    : (window as any).__NEXTCOMPAT_LOCALE__;
  const locales = typeof window === "undefined"
    ? ssrContext?.locales
    : (window as any).__NEXTCOMPAT_LOCALES__;
  const defaultLocale = typeof window === "undefined"
    ? ssrContext?.defaultLocale
    : (window as any).__NEXTCOMPAT_DEFAULT_LOCALE__;

  const router = useMemo(
    (): NextRouter => ({
      pathname,
      route: pathname,
      query,
      asPath,
      basePath: __basePath,
      locale,
      locales,
      defaultLocale,
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
    [pathname, query, asPath, locale, locales, defaultLocale, push, replace, back, reload, prefetch],
  );

  return router;
}

// Module-level popstate listener: handles browser back/forward by re-rendering
// the React root with the page at the new URL. This runs regardless of whether
// any component calls useRouter().
if (typeof window !== "undefined") {
  window.addEventListener("popstate", () => {
    const browserUrl = window.location.pathname + window.location.search;
    const appUrl = stripBasePath(window.location.pathname) + window.location.search;
    routerEvents.emit("routeChangeStart", appUrl);
    navigateClient(browserUrl).then(() => {
      routerEvents.emit("routeChangeComplete", appUrl);
      window.dispatchEvent(new CustomEvent("nextcompat:navigate"));
    });
  });
}

// Also export a default Router singleton for `import Router from 'next/router'`
const Router = {
  push: async (url: string | UrlObject) => {
    const resolved = resolveUrl(url);
    const full = withBasePath(resolved);
    routerEvents.emit("routeChangeStart", resolved);
    window.history.pushState({}, "", full);
    await navigateClient(full);
    routerEvents.emit("routeChangeComplete", resolved);
    window.dispatchEvent(new CustomEvent("nextcompat:navigate"));
    return true;
  },
  replace: async (url: string | UrlObject) => {
    const resolved = resolveUrl(url);
    const full = withBasePath(resolved);
    routerEvents.emit("routeChangeStart", resolved);
    window.history.replaceState({}, "", full);
    await navigateClient(full);
    routerEvents.emit("routeChangeComplete", resolved);
    window.dispatchEvent(new CustomEvent("nextcompat:navigate"));
    return true;
  },
  back: () => window.history.back(),
  reload: () => window.location.reload(),
  prefetch: async () => {},
  events: routerEvents,
};

export default Router;
