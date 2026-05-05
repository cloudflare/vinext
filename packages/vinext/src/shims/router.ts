/**
 * next/router shim
 *
 * Provides useRouter() hook and Router singleton for Pages Router.
 * Backed by the browser History API. Supports client-side navigation
 * by fetching new page data and re-rendering the React root.
 */
import { useState, useEffect, useCallback, useMemo, createElement, type ReactElement } from "react";
import { RouterContext } from "./internal/router-context.js";
import type { VinextNextData } from "../client/vinext-next-data.js";
import { isValidModulePath } from "../client/validate-module-path.js";
import { toBrowserNavigationHref, toSameOriginAppPath } from "./url-utils.js";
import { stripBasePath } from "../utils/base-path.js";
import { addLocalePrefix, getDomainLocaleUrl, type DomainLocale } from "../utils/domain-locale.js";
import {
  addQueryParam,
  appendSearchParamsToUrl,
  type UrlQuery,
  urlQueryToSearchParams,
} from "../utils/query.js";

/** basePath from next.config.js, injected by the plugin at build time */
const __basePath: string = process.env.__NEXT_ROUTER_BASEPATH ?? "";

type BeforePopStateCallback = (state: {
  url: string;
  as: string;
  options: { shallow: boolean };
}) => boolean;

export type NextRouter = {
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
  /** Configured domain locales */
  domainLocales?: VinextNextData["domainLocales"];
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
};

type UrlObject = {
  pathname?: string;
  query?: UrlQuery;
};

type TransitionOptions = {
  shallow?: boolean;
  scroll?: boolean;
  locale?: string;
};

type RouterEvents = {
  on(event: string, handler: (...args: unknown[]) => void): void;
  off(event: string, handler: (...args: unknown[]) => void): void;
  emit(event: string, ...args: unknown[]): void;
};

function createRouterEvents(): RouterEvents {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  return {
    on(event: string, handler: (...args: unknown[]) => void) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      (listeners.get(event) as Set<(...args: unknown[]) => void>).add(handler);
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
    const params = urlQueryToSearchParams(url.query);
    result = appendSearchParamsToUrl(result, params);
  }
  return result;
}

/**
 * When `as` is provided, use it as the navigation target. This is a
 * simplification: Next.js keeps `url` and `as` as separate values (url for
 * data fetching, as for the browser URL). We collapse them because vinext's
 * navigateClient() fetches HTML from the target URL, so `as` must be a
 * server-resolvable path. Purely decorative `as` values are not supported.
 */
function resolveNavigationTarget(
  url: string | UrlObject,
  as: string | undefined,
  locale: string | undefined,
): string {
  return applyNavigationLocale(as ?? resolveUrl(url), locale);
}

function getDomainLocales(): readonly DomainLocale[] | undefined {
  return (window.__NEXT_DATA__ as VinextNextData | undefined)?.domainLocales;
}

function getCurrentHostname(): string | undefined {
  return window.location?.hostname;
}

function getDomainLocalePath(url: string, locale: string): string | undefined {
  return getDomainLocaleUrl(url, locale, {
    basePath: __basePath,
    currentHostname: getCurrentHostname(),
    domainItems: getDomainLocales(),
  });
}

/**
 * Apply locale prefix to a URL for client-side navigation.
 * Same logic as Link's applyLocaleToHref but reads from window globals.
 */
export function applyNavigationLocale(url: string, locale?: string): string {
  if (!locale || typeof window === "undefined") return url;
  // Absolute and protocol-relative URLs must not be prefixed — locale
  // only applies to local paths.
  if (url.startsWith("http://") || url.startsWith("https://") || url.startsWith("//")) {
    return url;
  }

  const domainLocalePath = getDomainLocalePath(url, locale);
  if (domainLocalePath) return domainLocalePath;

  return addLocalePrefix(url, locale, window.__VINEXT_DEFAULT_LOCALE__ ?? "");
}

/** Check if a URL is external (any URL scheme per RFC 3986, or protocol-relative) */
export function isExternalUrl(url: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith("//");
}

/** Resolve a hash URL to a basePath-stripped app URL for event payloads */
function resolveHashUrl(url: string): string {
  if (typeof window === "undefined") return url;
  if (url.startsWith("#"))
    return stripBasePath(window.location.pathname, __basePath) + window.location.search + url;
  // Full-path hash URL — strip basePath for consistency with other events
  try {
    const parsed = new URL(url, window.location.href);
    return stripBasePath(parsed.pathname, __basePath) + parsed.search + parsed.hash;
  } catch {
    return url;
  }
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
type SSRContext = {
  pathname: string;
  query: Record<string, string | string[]>;
  asPath: string;
  locale?: string;
  locales?: string[];
  defaultLocale?: string;
  domainLocales?: VinextNextData["domainLocales"];
};

// ---------------------------------------------------------------------------
// Server-side SSR state uses a registration pattern so this module can be
// bundled for the browser. The ALS-backed implementation lives in
// router-state.ts (server-only) and registers itself on import.
// ---------------------------------------------------------------------------

let _ssrContext: SSRContext | null = null;

let _getSSRContext = (): SSRContext | null => _ssrContext;
let _setSSRContextImpl = (ctx: SSRContext | null): void => {
  _ssrContext = ctx;
};

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
  // Accepts any non-] characters inside brackets (Next.js PARAMETER_PATTERN parity).
  const bracketMatches = pattern.matchAll(/\[{1,2}(?:\.\.\.)?([^\]]+)\]{1,2}/g);
  for (const m of bracketMatches) {
    names.push(m[1]);
  }
  if (names.length > 0) return names;
  // Fallback: match internal :param format (any chars except /, +, *)
  const colonMatches = pattern.matchAll(/:([^/+*]+)[+*]?/g);
  for (const m of colonMatches) {
    names.push(m[1]);
  }
  return names;
}

function getPathnameAndQuery(): {
  pathname: string;
  query: Record<string, string | string[]>;
  asPath: string;
} {
  if (typeof window === "undefined") {
    const _ssrCtx = _getSSRContext();
    if (_ssrCtx) {
      const query: Record<string, string | string[]> = {};
      for (const [key, value] of Object.entries(_ssrCtx.query)) {
        query[key] = Array.isArray(value) ? [...value] : value;
      }
      return { pathname: _ssrCtx.pathname, query, asPath: _ssrCtx.asPath };
    }
    return { pathname: "/", query: {}, asPath: "/" };
  }
  const resolvedPath = stripBasePath(window.location.pathname, __basePath);
  // In Next.js, router.pathname is the route pattern (e.g., "/posts/[id]"),
  // not the resolved path ("/posts/42"). __NEXT_DATA__.page holds the route
  // pattern and is updated by navigateClient() on every client-side navigation.
  const pathname = window.__NEXT_DATA__?.page ?? resolvedPath;
  const routeQuery: Record<string, string | string[]> = {};
  // Include dynamic route params from __NEXT_DATA__ (e.g., { id: "42" } from /posts/[id]).
  // Only include keys that are part of the route pattern (not stale query params).
  const nextData = window.__NEXT_DATA__;
  if (nextData && nextData.query && nextData.page) {
    const routeParamNames = extractRouteParamNames(nextData.page);
    for (const key of routeParamNames) {
      const value = nextData.query[key];
      if (typeof value === "string") {
        routeQuery[key] = value;
      } else if (Array.isArray(value)) {
        routeQuery[key] = [...value];
      }
    }
  }
  // URL search params always reflect the current URL
  const searchQuery: Record<string, string | string[]> = {};
  const params = new URLSearchParams(window.location.search);
  for (const [key, value] of params) {
    addQueryParam(searchQuery, key, value);
  }
  const query = { ...searchQuery, ...routeQuery };
  // asPath uses the resolved browser path, not the route pattern
  const asPath = resolvedPath + window.location.search + window.location.hash;
  return { pathname, query, asPath };
}

/**
 * Error thrown when a navigation is superseded by a newer one.
 * Matches Next.js's convention of an Error with `.cancelled = true`.
 */
class NavigationCancelledError extends Error {
  cancelled = true;
  constructor(route: string) {
    super(`Abort fetching component for route: "${route}"`);
    this.name = "NavigationCancelledError";
  }
}

/**
 * Error thrown after queueing a hard navigation fallback for a known failure
 * mode. Callers can use this to avoid scheduling the same hard navigation twice.
 */
class HardNavigationScheduledError extends Error {
  hardNavigationScheduled = true;
  constructor(message: string) {
    super(message);
    this.name = "HardNavigationScheduledError";
  }
}

/**
 * Monotonically increasing ID for tracking the current navigation.
 * Each call to navigateClient() increments this and captures the value.
 * After each async boundary, the navigation checks whether it is still
 * the active one. If a newer navigation has started, the stale one
 * throws NavigationCancelledError so the caller can emit routeChangeError
 * and skip routeChangeComplete.
 *
 * Replaces the old boolean `_navInProgress` guard which silently dropped
 * the second navigation, causing URL/content mismatch.
 */
let _navigationId = 0;

/** AbortController for the in-flight fetch, so superseded navigations abort network I/O. */
let _activeAbortController: AbortController | null = null;

function scheduleHardNavigationAndThrow(url: string, message: string): never {
  if (typeof window === "undefined") {
    throw new HardNavigationScheduledError(message);
  }
  window.location.href = url;
  throw new HardNavigationScheduledError(message);
}

/**
 * Perform client-side navigation: fetch the target page's HTML,
 * extract __NEXT_DATA__, and re-render the React root.
 *
 * Throws NavigationCancelledError if a newer navigation supersedes this one.
 * Throws on hard-navigation failures (non-OK response, missing data) so the
 * caller can distinguish success from failure for event emission.
 */
async function navigateClient(url: string): Promise<void> {
  if (typeof window === "undefined") return;

  const root = window.__VINEXT_ROOT__;
  if (!root) {
    // No React root yet — fall back to hard navigation
    window.location.href = url;
    return;
  }

  // Cancel any in-flight navigation (abort its fetch, mark it stale)
  _activeAbortController?.abort();
  const controller = new AbortController();
  _activeAbortController = controller;

  const navId = ++_navigationId;

  /** Check if this navigation is still the active one. If not, throw. */
  function assertStillCurrent(): void {
    if (navId !== _navigationId) {
      throw new NavigationCancelledError(url);
    }
  }

  try {
    // Fetch the target page's SSR HTML
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { Accept: "text/html" },
        signal: controller.signal,
      });
    } catch (err: unknown) {
      // AbortError means a newer navigation cancelled this fetch
      if (err instanceof DOMException && err.name === "AbortError") {
        throw new NavigationCancelledError(url);
      }
      throw err;
    }
    assertStillCurrent();

    if (!res.ok) {
      // Set window.location.href first so the browser navigates to the correct
      // page even if the caller suppresses the error.  The assignment schedules
      // the navigation asynchronously (as a task), so synchronous routeChangeError
      // listeners still run — and observe the error — before the page unloads.
      // Contract: routeChangeError listeners MUST be synchronous; async listeners
      // will not fire before the navigation completes.  Callers (runNavigateClient)
      // must NOT schedule a second hard navigation — this assignment already queues
      // the browser fallback, and the helper-level HardNavigationScheduledError
      // makes that contract explicit to callers.
      scheduleHardNavigationAndThrow(url, `Navigation failed: ${res.status} ${res.statusText}`);
    }

    const html = await res.text();
    assertStillCurrent();

    // Extract __NEXT_DATA__ from the HTML
    const match = html.match(/<script>window\.__NEXT_DATA__\s*=\s*(.*?)<\/script>/);
    if (!match) {
      scheduleHardNavigationAndThrow(url, "Navigation failed: missing __NEXT_DATA__ in response");
    }

    const nextData = JSON.parse(match[1]);
    const { pageProps } = nextData.props;
    // Defer writing window.__NEXT_DATA__ until just before root.render() —
    // writing it here would let a stale navigation briefly pollute the global
    // between this assertStillCurrent() and the next one after await import().

    // Get the page module URL from __NEXT_DATA__.__vinext (preferred),
    // or fall back to parsing the hydration script
    let pageModuleUrl: string | undefined = nextData.__vinext?.pageModuleUrl;

    if (!pageModuleUrl) {
      // Legacy fallback: try to find the module URL in the inline script
      const moduleMatch = html.match(/import\("([^"]+)"\);\s*\n\s*const PageComponent/);
      const altMatch = html.match(/await import\("([^"]+pages\/[^"]+)"\)/);
      pageModuleUrl = moduleMatch?.[1] ?? altMatch?.[1] ?? undefined;
    }

    if (!pageModuleUrl) {
      scheduleHardNavigationAndThrow(url, "Navigation failed: no page module URL found");
    }

    // Validate the module URL before importing — defense-in-depth against
    // unexpected __NEXT_DATA__ or malformed HTML responses
    if (!isValidModulePath(pageModuleUrl)) {
      console.error("[vinext] Blocked import of invalid page module path:", pageModuleUrl);
      scheduleHardNavigationAndThrow(url, "Navigation failed: invalid page module path");
    }

    // Dynamically import the new page module
    const pageModule = await import(/* @vite-ignore */ pageModuleUrl);
    assertStillCurrent();

    const PageComponent = pageModule.default;

    if (!PageComponent) {
      scheduleHardNavigationAndThrow(url, "Navigation failed: page module has no default export");
    }

    // Import React for createElement
    const React = (await import("react")).default;
    assertStillCurrent();

    // Re-render with the new page, loading _app if needed
    let AppComponent = window.__VINEXT_APP__;
    const appModuleUrl: string | undefined = nextData.__vinext?.appModuleUrl;

    if (!AppComponent && appModuleUrl) {
      if (!isValidModulePath(appModuleUrl)) {
        console.error("[vinext] Blocked import of invalid app module path:", appModuleUrl);
      } else {
        try {
          const appModule = await import(/* @vite-ignore */ appModuleUrl);
          AppComponent = appModule.default;
          window.__VINEXT_APP__ = AppComponent;
        } catch {
          // _app not available — continue without it
        }
      }
    }
    assertStillCurrent();

    let element;
    if (AppComponent) {
      element = React.createElement(AppComponent, {
        Component: PageComponent,
        pageProps,
      });
    } else {
      element = React.createElement(PageComponent, pageProps);
    }

    // Wrap with RouterContext.Provider so next/compat/router works
    element = wrapWithRouterContext(element);

    // Commit __NEXT_DATA__ only after all assertStillCurrent() checks have passed,
    // so a stale navigation can never pollute the global.
    // INVARIANT: Everything after the final assertStillCurrent() above (the
    // checkpoint immediately after the optional _app import) through
    // root.render() is synchronous. If any step here ever becomes async, add
    // another assertStillCurrent() before writing __NEXT_DATA__.
    window.__NEXT_DATA__ = nextData;
    root.render(element);
  } finally {
    // Clean up the abort controller if this navigation is still the active one
    if (navId === _navigationId) {
      _activeAbortController = null;
    }
  }
}

/**
 * Run navigateClient and handle errors: emit routeChangeError on failure,
 * and fall back to a hard navigation for non-cancel errors so the browser
 * recovers to a consistent state.
 *
 * Returns:
 * - "completed" — navigation finished, caller should emit routeChangeComplete
 * - "cancelled" — superseded by a newer navigation, caller should return true
 *   without emitting routeChangeComplete (matches Next.js behaviour)
 * - "failed" — genuine error, caller should return false (hard nav is already
 *   scheduled as recovery)
 */
async function runNavigateClient(
  fullUrl: string,
  resolvedUrl: string,
): Promise<"completed" | "cancelled" | "failed"> {
  try {
    await navigateClient(fullUrl);
    return "completed";
  } catch (err: unknown) {
    routerEvents.emit("routeChangeError", err, resolvedUrl, { shallow: false });
    if (err instanceof NavigationCancelledError) {
      return "cancelled";
    }
    // Genuine error (network, parse, import failure): fall back to a hard
    // navigation so the browser lands on the correct page. Known failure modes
    // throw HardNavigationScheduledError, and this guard skips those; only
    // unexpected failures (parse, import, render) need recovery here.
    if (typeof window !== "undefined" && !(err instanceof HardNavigationScheduledError)) {
      window.location.href = fullUrl;
    }
    return "failed";
  }
}

/**
 * Build the full router value object from the current pathname, query, asPath,
 * and a set of navigation methods.  Shared by useRouter() (which passes
 * hook-derived callbacks) and wrapWithRouterContext() (which passes the Router
 * singleton methods) so the shape stays in sync.
 */
function buildRouterValue(
  pathname: string,
  query: Record<string, string | string[]>,
  asPath: string,
  methods: {
    push: NextRouter["push"];
    replace: NextRouter["replace"];
    back: NextRouter["back"];
    reload: NextRouter["reload"];
    prefetch: NextRouter["prefetch"];
    beforePopState: NextRouter["beforePopState"];
  },
): NextRouter {
  const _ssrState = _getSSRContext();
  const nextData =
    typeof window !== "undefined"
      ? (window.__NEXT_DATA__ as VinextNextData | undefined)
      : undefined;
  const locale = typeof window === "undefined" ? _ssrState?.locale : window.__VINEXT_LOCALE__;
  const locales = typeof window === "undefined" ? _ssrState?.locales : window.__VINEXT_LOCALES__;
  const defaultLocale =
    typeof window === "undefined" ? _ssrState?.defaultLocale : window.__VINEXT_DEFAULT_LOCALE__;
  const domainLocales =
    typeof window === "undefined" ? _ssrState?.domainLocales : nextData?.domainLocales;

  const route = typeof window !== "undefined" ? (nextData?.page ?? pathname) : pathname;

  return {
    pathname,
    route,
    query,
    asPath,
    basePath: __basePath,
    locale,
    locales,
    defaultLocale,
    domainLocales,
    isReady: true,
    isPreview: false,
    isFallback: typeof window !== "undefined" && nextData?.isFallback === true,
    ...methods,
    events: routerEvents,
  };
}

/**
 * useRouter hook - Pages Router compatible.
 */
export function useRouter(): NextRouter {
  const [{ pathname, query, asPath }, setState] = useState(getPathnameAndQuery);

  // Popstate is handled by the module-level listener below so beforePopState()
  // is consistently enforced even when multiple components mount useRouter().
  useEffect(() => {
    const onNavigate = ((_e: CustomEvent) => {
      setState(getPathnameAndQuery());
    }) as EventListener;
    window.addEventListener("vinext:navigate", onNavigate);
    return () => window.removeEventListener("vinext:navigate", onNavigate);
  }, []);

  const push = useCallback(
    async (url: string | UrlObject, as?: string, options?: TransitionOptions): Promise<boolean> => {
      let resolved = resolveNavigationTarget(url, as, options?.locale);

      // External URLs — delegate to browser (unless same-origin)
      if (isExternalUrl(resolved)) {
        const localPath = toSameOriginAppPath(resolved, __basePath);
        if (localPath == null) {
          window.location.assign(resolved);
          return true;
        }
        resolved = localPath;
      }

      const full = toBrowserNavigationHref(resolved, window.location.href, __basePath);

      // Hash-only change — no page fetch needed
      if (isHashOnlyChange(resolved)) {
        const eventUrl = resolveHashUrl(resolved);
        routerEvents.emit("hashChangeStart", eventUrl, {
          shallow: options?.shallow ?? false,
        });
        const hash = resolved.includes("#") ? resolved.slice(resolved.indexOf("#")) : "";
        window.history.pushState({}, "", resolved.startsWith("#") ? resolved : full);
        _lastPathnameAndSearch = window.location.pathname + window.location.search;
        scrollToHash(hash);
        setState(getPathnameAndQuery());
        routerEvents.emit("hashChangeComplete", eventUrl, {
          shallow: options?.shallow ?? false,
        });
        window.dispatchEvent(new CustomEvent("vinext:navigate"));
        return true;
      }

      saveScrollPosition();
      routerEvents.emit("routeChangeStart", resolved, { shallow: options?.shallow ?? false });
      routerEvents.emit("beforeHistoryChange", resolved, { shallow: options?.shallow ?? false });
      window.history.pushState({}, "", full);
      _lastPathnameAndSearch = window.location.pathname + window.location.search;
      if (!options?.shallow) {
        const result = await runNavigateClient(full, resolved);
        if (result === "cancelled") return true;
        if (result === "failed") return false;
      }
      setState(getPathnameAndQuery());
      routerEvents.emit("routeChangeComplete", resolved, { shallow: options?.shallow ?? false });

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
    async (url: string | UrlObject, as?: string, options?: TransitionOptions): Promise<boolean> => {
      let resolved = resolveNavigationTarget(url, as, options?.locale);

      // External URLs — delegate to browser (unless same-origin)
      if (isExternalUrl(resolved)) {
        const localPath = toSameOriginAppPath(resolved, __basePath);
        if (localPath == null) {
          window.location.replace(resolved);
          return true;
        }
        resolved = localPath;
      }

      const full = toBrowserNavigationHref(resolved, window.location.href, __basePath);

      // Hash-only change — no page fetch needed
      if (isHashOnlyChange(resolved)) {
        const eventUrl = resolveHashUrl(resolved);
        routerEvents.emit("hashChangeStart", eventUrl, {
          shallow: options?.shallow ?? false,
        });
        const hash = resolved.includes("#") ? resolved.slice(resolved.indexOf("#")) : "";
        window.history.replaceState({}, "", resolved.startsWith("#") ? resolved : full);
        _lastPathnameAndSearch = window.location.pathname + window.location.search;
        scrollToHash(hash);
        setState(getPathnameAndQuery());
        routerEvents.emit("hashChangeComplete", eventUrl, {
          shallow: options?.shallow ?? false,
        });
        window.dispatchEvent(new CustomEvent("vinext:navigate"));
        return true;
      }

      routerEvents.emit("routeChangeStart", resolved, { shallow: options?.shallow ?? false });
      routerEvents.emit("beforeHistoryChange", resolved, { shallow: options?.shallow ?? false });
      window.history.replaceState({}, "", full);
      _lastPathnameAndSearch = window.location.pathname + window.location.search;
      if (!options?.shallow) {
        const result = await runNavigateClient(full, resolved);
        if (result === "cancelled") return true;
        if (result === "failed") return false;
      }
      setState(getPathnameAndQuery());
      routerEvents.emit("routeChangeComplete", resolved, { shallow: options?.shallow ?? false });

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

  const router = useMemo(
    (): NextRouter =>
      buildRouterValue(pathname, query, asPath, {
        push,
        replace,
        back,
        reload,
        prefetch,
        beforePopState: (cb: BeforePopStateCallback) => {
          _beforePopStateCb = cb;
        },
      }),
    [pathname, query, asPath, push, replace, back, reload, prefetch],
  );

  return router;
}

// beforePopState callback: called before handling browser back/forward.
// If it returns false, the navigation is cancelled.
let _beforePopStateCb: BeforePopStateCallback | undefined;

// Track pathname+search for detecting hash-only back/forward in the popstate
// handler. Updated after every pushState/replaceState so that popstate can
// compare the previous value with the (already-changed) window.location.
let _lastPathnameAndSearch =
  typeof window !== "undefined" ? window.location.pathname + window.location.search : "";

// Module-level popstate listener: handles browser back/forward by re-rendering
// the React root with the page at the new URL. This runs regardless of whether
// any component calls useRouter().
if (typeof window !== "undefined") {
  window.addEventListener("popstate", (e: PopStateEvent) => {
    const browserUrl = window.location.pathname + window.location.search;
    const appUrl = stripBasePath(window.location.pathname, __basePath) + window.location.search;

    // Detect hash-only back/forward: pathname+search unchanged, only hash differs.
    const isHashOnly = browserUrl === _lastPathnameAndSearch;

    // Check beforePopState callback
    if (_beforePopStateCb !== undefined) {
      const shouldContinue = (_beforePopStateCb as BeforePopStateCallback)({
        url: appUrl,
        as: appUrl,
        options: { shallow: false },
      });
      if (!shouldContinue) return;
    }

    // Update tracker only after beforePopState confirms navigation proceeds.
    // If beforePopState cancels, the tracker must retain the previous value
    // so the next popstate compares against the correct baseline.
    _lastPathnameAndSearch = browserUrl;

    if (isHashOnly) {
      // Hash-only back/forward — no page fetch needed
      const hashUrl = appUrl + window.location.hash;
      routerEvents.emit("hashChangeStart", hashUrl, { shallow: false });
      scrollToHash(window.location.hash);
      routerEvents.emit("hashChangeComplete", hashUrl, { shallow: false });
      window.dispatchEvent(new CustomEvent("vinext:navigate"));
      return;
    }

    const fullAppUrl = appUrl + window.location.hash;
    routerEvents.emit("routeChangeStart", fullAppUrl, { shallow: false });
    // Note: The browser has already updated window.location by the time popstate
    // fires, so this is not truly "before" the URL change. In Next.js the popstate
    // handler calls replaceState to store history metadata — beforeHistoryChange
    // precedes that call, not the URL change itself. We emit it here for API
    // compatibility.
    routerEvents.emit("beforeHistoryChange", fullAppUrl, { shallow: false });
    void (async () => {
      const result = await runNavigateClient(browserUrl, fullAppUrl);
      if (result === "completed") {
        routerEvents.emit("routeChangeComplete", fullAppUrl, { shallow: false });
        restoreScrollPosition(e.state);
        window.dispatchEvent(new CustomEvent("vinext:navigate"));
      }
      // "cancelled": superseded by a newer navigation, so this popstate no longer wins.
      // "failed": runNavigateClient already scheduled the hard-navigation fallback.
    })();
  });
}

/**
 * Wrap a React element in a RouterContext.Provider so that
 * next/compat/router's useRouter() returns the real Pages Router value.
 *
 * This is a plain function, NOT a React component — it builds the router
 * value object directly from the current SSR context (server) or
 * window.location + Router singleton (client), avoiding duplicate state
 * that a hook-based component would create.
 */
export function wrapWithRouterContext(element: ReactElement): ReactElement {
  const { pathname, query, asPath } = getPathnameAndQuery();

  const routerValue = buildRouterValue(pathname, query, asPath, {
    push: Router.push,
    replace: Router.replace,
    back: Router.back,
    reload: Router.reload,
    prefetch: Router.prefetch,
    beforePopState: Router.beforePopState,
  });

  return createElement(RouterContext.Provider, { value: routerValue }, element) as ReactElement;
}

// Also export a default Router singleton for `import Router from 'next/router'`
const Router = {
  push: async (url: string | UrlObject, as?: string, options?: TransitionOptions) => {
    let resolved = resolveNavigationTarget(url, as, options?.locale);

    // External URLs (unless same-origin)
    if (isExternalUrl(resolved)) {
      const localPath = toSameOriginAppPath(resolved, __basePath);
      if (localPath == null) {
        window.location.assign(resolved);
        return true;
      }
      resolved = localPath;
    }

    const full = toBrowserNavigationHref(resolved, window.location.href, __basePath);

    // Hash-only change
    if (isHashOnlyChange(resolved)) {
      const eventUrl = resolveHashUrl(resolved);
      routerEvents.emit("hashChangeStart", eventUrl, {
        shallow: options?.shallow ?? false,
      });
      const hash = resolved.includes("#") ? resolved.slice(resolved.indexOf("#")) : "";
      window.history.pushState({}, "", resolved.startsWith("#") ? resolved : full);
      _lastPathnameAndSearch = window.location.pathname + window.location.search;
      scrollToHash(hash);
      routerEvents.emit("hashChangeComplete", eventUrl, {
        shallow: options?.shallow ?? false,
      });
      window.dispatchEvent(new CustomEvent("vinext:navigate"));
      return true;
    }

    saveScrollPosition();
    routerEvents.emit("routeChangeStart", resolved, { shallow: options?.shallow ?? false });
    routerEvents.emit("beforeHistoryChange", resolved, { shallow: options?.shallow ?? false });
    window.history.pushState({}, "", full);
    _lastPathnameAndSearch = window.location.pathname + window.location.search;
    if (!options?.shallow) {
      const result = await runNavigateClient(full, resolved);
      if (result === "cancelled") return true;
      if (result === "failed") return false;
    }
    routerEvents.emit("routeChangeComplete", resolved, { shallow: options?.shallow ?? false });

    const hash = resolved.includes("#") ? resolved.slice(resolved.indexOf("#")) : "";
    if (hash) {
      scrollToHash(hash);
    } else if (options?.scroll !== false) {
      window.scrollTo(0, 0);
    }
    window.dispatchEvent(new CustomEvent("vinext:navigate"));
    return true;
  },
  replace: async (url: string | UrlObject, as?: string, options?: TransitionOptions) => {
    let resolved = resolveNavigationTarget(url, as, options?.locale);

    // External URLs (unless same-origin)
    if (isExternalUrl(resolved)) {
      const localPath = toSameOriginAppPath(resolved, __basePath);
      if (localPath == null) {
        window.location.replace(resolved);
        return true;
      }
      resolved = localPath;
    }

    const full = toBrowserNavigationHref(resolved, window.location.href, __basePath);

    // Hash-only change
    if (isHashOnlyChange(resolved)) {
      const eventUrl = resolveHashUrl(resolved);
      routerEvents.emit("hashChangeStart", eventUrl, {
        shallow: options?.shallow ?? false,
      });
      const hash = resolved.includes("#") ? resolved.slice(resolved.indexOf("#")) : "";
      window.history.replaceState({}, "", resolved.startsWith("#") ? resolved : full);
      _lastPathnameAndSearch = window.location.pathname + window.location.search;
      scrollToHash(hash);
      routerEvents.emit("hashChangeComplete", eventUrl, {
        shallow: options?.shallow ?? false,
      });
      window.dispatchEvent(new CustomEvent("vinext:navigate"));
      return true;
    }

    routerEvents.emit("routeChangeStart", resolved, { shallow: options?.shallow ?? false });
    routerEvents.emit("beforeHistoryChange", resolved, { shallow: options?.shallow ?? false });
    window.history.replaceState({}, "", full);
    _lastPathnameAndSearch = window.location.pathname + window.location.search;
    if (!options?.shallow) {
      const result = await runNavigateClient(full, resolved);
      if (result === "cancelled") return true;
      if (result === "failed") return false;
    }
    routerEvents.emit("routeChangeComplete", resolved, { shallow: options?.shallow ?? false });

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
