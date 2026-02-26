/**
 * next/router shim
 *
 * Provides useRouter() hook and Router singleton for Pages Router.
 * Backed by the browser History API. Supports client-side navigation
 * by fetching new page data and re-rendering the React root.
 */
import { useState, useEffect, useCallback, useMemo } from "react";
import { isValidModulePath } from "../client/validate-module-path.js";

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

type BeforePopStateCallback = (state: { url: string; as: string; options: { shallow: boolean } }) => boolean;

interface NextRouter {
  /** Current pathname */
  pathname: string;
  /** Current route pattern (e.g., "/posts/[id]") */
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
  /** Prefetch a page (injects <link rel="prefetch">) */
  prefetch(url: string): Promise<void>;
  /** Register a callback to run before popstate navigation */
  beforePopState(cb: BeforePopStateCallback): void;
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
 * Apply locale prefix to a URL for client-side navigation.
 * Same logic as Link's applyLocaleToHref but reads from window globals.
 */
export function applyNavigationLocale(url: string, locale?: string): string {
  if (!locale || typeof window === "undefined") return url;
  const defaultLocale = (window as any).__VINEXT_DEFAULT_LOCALE__;
  // Default locale doesn't get a prefix
  if (locale === defaultLocale) return url;
  // Don't double-prefix
  if (url.startsWith(`/${locale}/`) || url === `/${locale}`) return url;
  return `/${locale}${url.startsWith("/") ? url : `/${url}`}`;
}

/** Check if a URL is external */
export function isExternalUrl(url: string): boolean {
  return url.startsWith("http://") || url.startsWith("https://") || url.startsWith("//");
}

/** Check if a href is only a hash change relative to the current URL */
export function isHashOnlyChange(href: string): boolean {
  if (href.startsWith("#")) return true;
  if (typeof window === "undefined") return false;
  try {
    const current = new URL(window.location.href);
    const next = new URL(href, window.location.href);
    return current.pathname === next.pathname && current.search === next.search && next.hash !== "";
  } catch {
    return false;
  }
}

/** Scroll to hash target element, or top if no hash */
function scrollToHash(hash: string): void {
  if (!hash || hash === "#") {
    window.scrollTo(0, 0);
    return;
  }
  const el = document.getElementById(hash.slice(1));
  if (el) el.scrollIntoView({ behavior: "auto" });
}

/** Save current scroll position into history state for back/forward restoration */
function saveScrollPosition(): void {
  const state = window.history.state ?? {};
  window.history.replaceState(
    { ...state, __vinext_scrollX: window.scrollX, __vinext_scrollY: window.scrollY },
    "",
  );
}

/** Restore scroll position from history state */
function restoreScrollPosition(state: unknown): void {
  if (state && typeof state === "object" && "__vinext_scrollY" in state) {
    const { __vinext_scrollX: x, __vinext_scrollY: y } = state as {
      __vinext_scrollX: number;
      __vinext_scrollY: number;
    };
    requestAnimationFrame(() => window.scrollTo(x, y));
  }
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

// ---------------------------------------------------------------------------
// Server-side SSR state uses a registration pattern so this module can be
// bundled for the browser. The ALS-backed implementation lives in
// router-state.ts (server-only) and registers itself on import.
// ---------------------------------------------------------------------------

let _ssrContext: SSRContext | null = null;

let _getSSRContext = (): SSRContext | null => _ssrContext;
let _setSSRContextImpl = (ctx: SSRContext | null): void => { _ssrContext = ctx; };

/**
 * Register ALS-backed state accessors. Called by router-state.ts on import.
 * @internal
 */
export function _registerRouterStateAccessors(accessors: {
  getSSRContext: () => SSRContext | null;
  setSSRContext: (ctx: SSRContext | null) => void;
}): void {
  _getSSRContext = accessors.getSSRContext;
  _setSSRContextImpl = accessors.setSSRContext;
}

export function setSSRContext(ctx: SSRContext | null): void {
  _setSSRContextImpl(ctx);
}

/**
 * Extract param names from a Next.js route pattern.
 * E.g., "/posts/[id]" → ["id"], "/docs/[...slug]" → ["slug"],
 * "/shop/[[...path]]" → ["path"], "/blog/[year]/[month]" → ["year", "month"]
 * Also handles internal format: "/posts/:id" → ["id"], "/docs/:slug+" → ["slug"]
 */
function extractRouteParamNames(pattern: string): string[] {
  const names: string[] = [];
  // Match Next.js bracket format: [id], [...slug], [[...slug]]
  const bracketMatches = pattern.matchAll(/\[{1,2}(?:\.\.\.)?([\w-]+)\]{1,2}/g);
  for (const m of bracketMatches) {
    names.push(m[1]);
  }
  if (names.length > 0) return names;
  // Fallback: match internal :param format
  const colonMatches = pattern.matchAll(/:([\w-]+)[+*]?/g);
  for (const m of colonMatches) {
    names.push(m[1]);
  }
  return names;
}

function getPathnameAndQuery(): {
  pathname: string;
  query: Record<string, string>;
  asPath: string;
} {
  if (typeof window === "undefined") {
    const _ssrCtx = _getSSRContext();
    if (_ssrCtx) {
      const query: Record<string, string> = {};
      for (const [key, value] of Object.entries(_ssrCtx.query)) {
        query[key] = Array.isArray(value) ? value.join(",") : value;
      }
      return { pathname: _ssrCtx.pathname, query, asPath: _ssrCtx.asPath };
    }
    return { pathname: "/", query: {}, asPath: "/" };
  }
  const pathname = stripBasePath(window.location.pathname);
  const query: Record<string, string> = {};
  // Include dynamic route params from __NEXT_DATA__ (e.g., { id: "42" } from /posts/[id]).
  // Only include keys that are part of the route pattern (not stale query params).
  const nextData = (window as any).__NEXT_DATA__;
  if (nextData && nextData.query && nextData.page) {
    const routeParamNames = extractRouteParamNames(nextData.page);
    for (const key of routeParamNames) {
      const value = nextData.query[key];
      if (typeof value === "string") {
        query[key] = value;
      } else if (Array.isArray(value)) {
        query[key] = value.join(",");
      }
    }
  }
  // URL search params always reflect the current URL
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
  const root = win.__VINEXT_ROOT__;
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

    // Get the page module URL from __NEXT_DATA__.__vinext (preferred),
    // or fall back to parsing the hydration script
    let pageModuleUrl: string | undefined =
      nextData.__vinext?.pageModuleUrl;

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

    // Validate the module URL before importing — defense-in-depth against
    // unexpected __NEXT_DATA__ or malformed HTML responses
    if (!isValidModulePath(pageModuleUrl)) {
      console.error("[vinext] Blocked import of invalid page module path:", pageModuleUrl);
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
    let AppComponent = win.__VINEXT_APP__;
    const appModuleUrl: string | undefined =
      nextData.__vinext?.appModuleUrl;

    if (!AppComponent && appModuleUrl) {
      if (!isValidModulePath(appModuleUrl)) {
        console.error("[vinext] Blocked import of invalid app module path:", appModuleUrl);
      } else {
        try {
          const appModule = await import(/* @vite-ignore */ appModuleUrl);
          AppComponent = appModule.default;
          win.__VINEXT_APP__ = AppComponent;
        } catch {
          // _app not available — continue without it
        }
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
    console.error("[vinext] Client navigation failed:", err);
    routerEvents.emit("routeChangeError", err, url);
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
    const onPopState = (e: PopStateEvent) => {
      setState(getPathnameAndQuery());
      // Re-render with the new page on back/forward navigation
      navigateClient(window.location.pathname + window.location.search).then(() => {
        restoreScrollPosition(e.state);
      });
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  // Listen for custom navigation events from Link component
  useEffect(() => {
    const onNavigate = ((_e: CustomEvent) => {
      setState(getPathnameAndQuery());
    }) as EventListener;
    window.addEventListener("vinext:navigate", onNavigate);
    return () => window.removeEventListener("vinext:navigate", onNavigate);
  }, []);

  const push = useCallback(
    async (url: string | UrlObject, _as?: string, options?: TransitionOptions): Promise<boolean> => {
      const resolved = applyNavigationLocale(resolveUrl(url), options?.locale);

      // External URLs — delegate to browser
      if (isExternalUrl(resolved)) {
        window.location.assign(resolved);
        return true;
      }

      // Hash-only change — no page fetch needed
      if (isHashOnlyChange(resolved)) {
        const hash = resolved.includes("#") ? resolved.slice(resolved.indexOf("#")) : "";
        window.history.pushState({}, "", resolved.startsWith("#") ? resolved : withBasePath(resolved));
        scrollToHash(hash);
        setState(getPathnameAndQuery());
        window.dispatchEvent(new CustomEvent("vinext:navigate"));
        return true;
      }

      saveScrollPosition();
      const full = withBasePath(resolved);
      routerEvents.emit("routeChangeStart", resolved);
      window.history.pushState({}, "", full);
      if (!options?.shallow) {
        await navigateClient(full);
      }
      setState(getPathnameAndQuery());
      routerEvents.emit("routeChangeComplete", resolved);

      // Scroll: handle hash target, else scroll to top unless scroll:false
      const hash = resolved.includes("#") ? resolved.slice(resolved.indexOf("#")) : "";
      if (hash) {
        scrollToHash(hash);
      } else if (options?.scroll !== false) {
        window.scrollTo(0, 0);
      }
      window.dispatchEvent(new CustomEvent("vinext:navigate"));
      return true;
    },
    [],
  );

  const replace = useCallback(
    async (url: string | UrlObject, _as?: string, options?: TransitionOptions): Promise<boolean> => {
      const resolved = applyNavigationLocale(resolveUrl(url), options?.locale);

      // External URLs — delegate to browser
      if (isExternalUrl(resolved)) {
        window.location.replace(resolved);
        return true;
      }

      // Hash-only change — no page fetch needed
      if (isHashOnlyChange(resolved)) {
        const hash = resolved.includes("#") ? resolved.slice(resolved.indexOf("#")) : "";
        window.history.replaceState({}, "", resolved.startsWith("#") ? resolved : withBasePath(resolved));
        scrollToHash(hash);
        setState(getPathnameAndQuery());
        window.dispatchEvent(new CustomEvent("vinext:navigate"));
        return true;
      }

      const full = withBasePath(resolved);
      routerEvents.emit("routeChangeStart", resolved);
      window.history.replaceState({}, "", full);
      if (!options?.shallow) {
        await navigateClient(full);
      }
      setState(getPathnameAndQuery());
      routerEvents.emit("routeChangeComplete", resolved);

      // Scroll: handle hash target, else scroll to top unless scroll:false
      const hash = resolved.includes("#") ? resolved.slice(resolved.indexOf("#")) : "";
      if (hash) {
        scrollToHash(hash);
      } else if (options?.scroll !== false) {
        window.scrollTo(0, 0);
      }
      window.dispatchEvent(new CustomEvent("vinext:navigate"));
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

  const prefetch = useCallback(async (url: string): Promise<void> => {
    // Inject a <link rel="prefetch"> for the target page
    if (typeof document !== "undefined") {
      const link = document.createElement("link");
      link.rel = "prefetch";
      link.href = url;
      link.as = "document";
      document.head.appendChild(link);
    }
  }, []);

  // Get i18n info from SSR context or window
  const _ssrState = _getSSRContext();
  const locale = typeof window === "undefined"
    ? _ssrState?.locale
    : (window as any).__VINEXT_LOCALE__;
  const locales = typeof window === "undefined"
    ? _ssrState?.locales
    : (window as any).__VINEXT_LOCALES__;
  const defaultLocale = typeof window === "undefined"
    ? _ssrState?.defaultLocale
    : (window as any).__VINEXT_DEFAULT_LOCALE__;

  // route is the route pattern (e.g., "/posts/[id]"), not the actual path
  const route = typeof window !== "undefined"
    ? ((window as any).__NEXT_DATA__?.page ?? pathname)
    : pathname;

  const router = useMemo(
    (): NextRouter => ({
      pathname,
      route,
      query,
      asPath,
      basePath: __basePath,
      locale,
      locales,
      defaultLocale,
      isReady: true,
      isPreview: false,
      isFallback: typeof window !== "undefined" && (window as any).__NEXT_DATA__?.isFallback === true,
      push,
      replace,
      back,
      reload,
      prefetch,
      beforePopState: (cb: BeforePopStateCallback) => { _beforePopStateCb = cb; },
      events: routerEvents,
    }),
    [pathname, query, asPath, locale, locales, defaultLocale, push, replace, back, reload, prefetch, route],
  );

  return router;
}

// beforePopState callback: called before handling browser back/forward.
// If it returns false, the navigation is cancelled.
let _beforePopStateCb: BeforePopStateCallback | undefined;

// Module-level popstate listener: handles browser back/forward by re-rendering
// the React root with the page at the new URL. This runs regardless of whether
// any component calls useRouter().
if (typeof window !== "undefined") {
  window.addEventListener("popstate", (e: PopStateEvent) => {
    const browserUrl = window.location.pathname + window.location.search;
    const appUrl = stripBasePath(window.location.pathname) + window.location.search;

    // Check beforePopState callback
    if (_beforePopStateCb !== undefined) {
      const shouldContinue = (_beforePopStateCb as BeforePopStateCallback)({ url: appUrl, as: appUrl, options: { shallow: false } });
      if (!shouldContinue) return;
    }

    routerEvents.emit("routeChangeStart", appUrl);
    navigateClient(browserUrl).then(() => {
      routerEvents.emit("routeChangeComplete", appUrl);
      restoreScrollPosition(e.state);
      window.dispatchEvent(new CustomEvent("vinext:navigate"));
    });
  });
}

// Also export a default Router singleton for `import Router from 'next/router'`
const Router = {
  push: async (url: string | UrlObject, _as?: string, options?: TransitionOptions) => {
    const resolved = applyNavigationLocale(resolveUrl(url), options?.locale);

    // External URLs
    if (isExternalUrl(resolved)) {
      window.location.assign(resolved);
      return true;
    }

    // Hash-only change
    if (isHashOnlyChange(resolved)) {
      const hash = resolved.includes("#") ? resolved.slice(resolved.indexOf("#")) : "";
      window.history.pushState({}, "", resolved.startsWith("#") ? resolved : withBasePath(resolved));
      scrollToHash(hash);
      window.dispatchEvent(new CustomEvent("vinext:navigate"));
      return true;
    }

    saveScrollPosition();
    const full = withBasePath(resolved);
    routerEvents.emit("routeChangeStart", resolved);
    window.history.pushState({}, "", full);
    if (!options?.shallow) {
      await navigateClient(full);
    }
    routerEvents.emit("routeChangeComplete", resolved);

    const hash = resolved.includes("#") ? resolved.slice(resolved.indexOf("#")) : "";
    if (hash) {
      scrollToHash(hash);
    } else if (options?.scroll !== false) {
      window.scrollTo(0, 0);
    }
    window.dispatchEvent(new CustomEvent("vinext:navigate"));
    return true;
  },
  replace: async (url: string | UrlObject, _as?: string, options?: TransitionOptions) => {
    const resolved = applyNavigationLocale(resolveUrl(url), options?.locale);

    // External URLs
    if (isExternalUrl(resolved)) {
      window.location.replace(resolved);
      return true;
    }

    // Hash-only change
    if (isHashOnlyChange(resolved)) {
      const hash = resolved.includes("#") ? resolved.slice(resolved.indexOf("#")) : "";
      window.history.replaceState({}, "", resolved.startsWith("#") ? resolved : withBasePath(resolved));
      scrollToHash(hash);
      window.dispatchEvent(new CustomEvent("vinext:navigate"));
      return true;
    }

    const full = withBasePath(resolved);
    routerEvents.emit("routeChangeStart", resolved);
    window.history.replaceState({}, "", full);
    if (!options?.shallow) {
      await navigateClient(full);
    }
    routerEvents.emit("routeChangeComplete", resolved);

    const hash = resolved.includes("#") ? resolved.slice(resolved.indexOf("#")) : "";
    if (hash) {
      scrollToHash(hash);
    } else if (options?.scroll !== false) {
      window.scrollTo(0, 0);
    }
    window.dispatchEvent(new CustomEvent("vinext:navigate"));
    return true;
  },
  back: () => window.history.back(),
  reload: () => window.location.reload(),
  prefetch: async (url: string) => {
    if (typeof document !== "undefined") {
      const link = document.createElement("link");
      link.rel = "prefetch";
      link.href = url;
      link.as = "document";
      document.head.appendChild(link);
    }
  },
  beforePopState: (cb: BeforePopStateCallback) => {
    _beforePopStateCb = cb;
  },
  events: routerEvents,
};

export default Router;
