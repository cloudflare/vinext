/**
 * next/router shim
 *
 * Provides useRouter() hook and Router singleton for Pages Router.
 * Backed by the browser History API. Supports client-side navigation
 * by fetching new page data and re-rendering the React root.
 */
import {
  useState,
  useEffect,
  useMemo,
  useContext,
  createElement,
  type ReactElement,
  type ReactNode,
  type ComponentType,
} from "react";
import { RouterContext } from "./internal/router-context.js";
import {
  applyVinextLocaleGlobals,
  extractVinextNextDataJson,
  parseVinextNextDataJson,
  type VinextNextData,
} from "../client/vinext-next-data.js";
import { isValidModulePath } from "../client/validate-module-path.js";
import { installWindowNext, type PagesRouterPublicInstance } from "../client/window-next.js";
import {
  isAbsoluteOrProtocolRelativeUrl,
  isHashOnlyBrowserUrlChange,
  normalizePathTrailingSlash,
  toBrowserNavigationHref,
  toSameOriginAppPath,
} from "./url-utils.js";
import { stripBasePath } from "../utils/base-path.js";
import {
  addLocalePrefix,
  getDomainLocaleUrl,
  getLocalePathPrefix,
  type DomainLocale,
} from "../utils/domain-locale.js";
import {
  addQueryParam,
  appendSearchParamsToUrl,
  type UrlQuery,
  urlQueryToSearchParams,
} from "../utils/query.js";
import { matchRoutePattern, routePatternParts } from "../routing/route-pattern.js";
import { scrollToHashTarget } from "./hash-scroll.js";
import { setPagesRouterPopStateHandler } from "./pages-router-runtime.js";
import { assertSafeNavigationUrl } from "./url-safety.js";

/** basePath from next.config.js, injected by the plugin at build time */
const __basePath: string = process.env.__NEXT_ROUTER_BASEPATH ?? "";
/** trailingSlash from next.config.js, injected by the plugin at build time */
const __trailingSlash: boolean = process.env.__VINEXT_TRAILING_SLASH === "true";

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
  locale?: string | false;
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

function resolveTransitionLocale(locale: TransitionOptions["locale"]): string | undefined {
  if (typeof window === "undefined") return undefined;
  if (locale === false) return window.__VINEXT_DEFAULT_LOCALE__;
  return locale ?? window.__VINEXT_LOCALE__;
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
  if (isAbsoluteOrProtocolRelativeUrl(url)) {
    return url;
  }
  if (getLocalePathPrefix(url, window.__VINEXT_LOCALES__)) {
    return url;
  }

  const domainLocalePath = getDomainLocalePath(url, locale);
  if (domainLocalePath) return domainLocalePath;

  return addLocalePrefix(url, locale, window.__VINEXT_DEFAULT_LOCALE__ ?? "");
}

function isDefaultLocaleRootNavigation(url: string, locale: string | undefined): boolean {
  if (typeof window === "undefined") return false;
  if (!locale || locale !== window.__VINEXT_DEFAULT_LOCALE__) return false;

  let parsed: URL;
  try {
    parsed = new URL(url, window.location.href);
  } catch {
    return false;
  }

  return stripBasePath(parsed.pathname, __basePath) === "/";
}

function getPagesHtmlFetchUrl(browserUrl: string, locale: string | undefined): string {
  if (!isDefaultLocaleRootNavigation(browserUrl, locale)) return browserUrl;

  // Browser URL stays unprefixed for the default locale, but the internal
  // HTML fetch must bypass root Accept-Language detection.
  const parsed = new URL(browserUrl, window.location.href);
  const localeRoot = normalizePathTrailingSlash(`/${locale}`, __trailingSlash);
  // Base path joining can change slash shape, then the final URL must still
  // conform to the app's trailingSlash setting.
  return normalizePathTrailingSlash(
    toBrowserNavigationHref(
      `${localeRoot}${parsed.search}${parsed.hash}`,
      window.location.href,
      __basePath,
    ),
    __trailingSlash,
  );
}

/** Check if a URL is external (any URL scheme per RFC 3986, or protocol-relative) */
export function isExternalUrl(url: string): boolean {
  return isAbsoluteOrProtocolRelativeUrl(url);
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
  return isHashOnlyBrowserUrlChange(href, window.location.href, __basePath);
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

type PagesNavigationContextShape = {
  pathname: string;
  searchParams: URLSearchParams;
  params: Record<string, string | string[]>;
};

// Client-only cache for snapshot stability. useSyncExternalStore compares
// snapshots with Object.is, so returning a fresh object on every render would
// trigger re-render loops. We use a module-level cache keyed by URL inputs;
// this is safe in the browser because there is exactly one request at a time
// but it must NOT be used on the server (concurrent ALS-scoped requests).
let _cachedClientPagesNavCtx: PagesNavigationContextShape | null = null;
let _cachedClientPagesNavCtxKey: string | null = null;

function _buildClientPagesNavigationContext(
  routePattern: string,
  resolvedPath: string,
  searchString: string,
): PagesNavigationContextShape {
  const cacheKey = `${routePattern}|${resolvedPath}|${searchString}`;
  if (_cachedClientPagesNavCtxKey === cacheKey && _cachedClientPagesNavCtx) {
    return _cachedClientPagesNavCtx;
  }
  const searchParams = new URLSearchParams(searchString);
  const params = routePattern ? (extractRouteParamsFromPath(routePattern, resolvedPath) ?? {}) : {};
  const ctx: PagesNavigationContextShape = { pathname: resolvedPath, searchParams, params };
  _cachedClientPagesNavCtx = ctx;
  _cachedClientPagesNavCtxKey = cacheKey;
  return ctx;
}

/**
 * Cross-router compat shim source for `next/navigation` hooks.
 *
 * Returns the current Pages Router state shaped as a navigation context so
 * the App Router hooks (useParams/useSearchParams/usePathname) can act as
 * compat shims when invoked inside a Pages Router render. Mirrors Next.js's
 * `adaptForPathParams` and `adaptForSearchParams` in
 * .nextjs-ref/packages/next/src/shared/lib/router/adapters.tsx, which Next.js
 * uses to populate SearchParamsContext / PathParamsContext for the Pages
 * Router (see packages/next/src/server/render.tsx and
 * packages/next/src/client/index.tsx).
 *
 * Returns `null` when there is no Pages Router state available — e.g. App
 * Router pages, RSC-only renders, or pre-router renders. Callers should
 * treat null as "App Router context, use normal app-router state".
 */
export function getPagesNavigationContext(): PagesNavigationContextShape | null {
  if (typeof window === "undefined") {
    const ssrCtx = _getSSRContext();
    if (!ssrCtx) return null;
    // ssrCtx.pathname is the route pattern (e.g. "/blog/[slug]").
    // ssrCtx.asPath is the resolved URL with query string. For useSearchParams
    // we want only the URL search string; for useParams we want only the
    // dynamic route params. Build a fresh object each call — server scope is
    // request-isolated via ALS but module state must not be cached across
    // concurrent requests.
    let searchParams: URLSearchParams;
    let resolvedPath: string;
    try {
      const url = new URL(ssrCtx.asPath, "http://_");
      searchParams = url.searchParams;
      resolvedPath = url.pathname;
    } catch {
      searchParams = new URLSearchParams();
      resolvedPath = ssrCtx.pathname;
    }
    const params = extractRouteParamsFromPath(ssrCtx.pathname, resolvedPath) ?? {};
    return { pathname: resolvedPath, searchParams, params };
  }

  // Client: derive from window.location + __NEXT_DATA__. __NEXT_DATA__.page
  // is the route pattern that was matched; navigateClient() keeps it in sync
  // with the visible URL on every client-side navigation. Cached so
  // useSyncExternalStore sees a stable snapshot between renders.
  const resolvedPath = stripBasePath(window.location.pathname, __basePath);
  const pattern = window.__NEXT_DATA__?.page ?? "";
  return _buildClientPagesNavigationContext(pattern, resolvedPath, window.location.search);
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

type RouteQueryNextData = {
  page?: string;
  query?: Record<string, string | string[] | undefined>;
};

function splitPathSegments(pathname: string): string[] {
  return pathname.split("/").filter(Boolean);
}

function extractRouteParamsFromPath(
  pattern: string,
  pathname: string,
): Record<string, string | string[]> | null {
  return matchRoutePattern(splitPathSegments(pathname), routePatternParts(pattern));
}

function getRouteQueryFromNextData(
  nextData: RouteQueryNextData | undefined,
  resolvedPath: string,
): Record<string, string | string[]> {
  const routeQuery: Record<string, string | string[]> = {};
  if (!nextData?.query || !nextData.page) return routeQuery;

  const routeParamNames = extractRouteParamNames(nextData.page);
  if (routeParamNames.length === 0) return routeQuery;

  const currentRouteParams = extractRouteParamsFromPath(nextData.page, resolvedPath);
  if (currentRouteParams) return currentRouteParams;

  for (const key of routeParamNames) {
    const value = nextData.query[key];
    if (typeof value === "string") {
      routeQuery[key] = value;
    } else if (Array.isArray(value)) {
      routeQuery[key] = [...value];
    }
  }
  return routeQuery;
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
  const nextData = window.__NEXT_DATA__;
  const routeQuery = getRouteQueryFromNextData(nextData, resolvedPath);
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
async function navigateClient(url: string, fetchUrl = url): Promise<void> {
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
      res = await fetch(fetchUrl, {
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
    const nextDataJson = extractVinextNextDataJson(html);
    if (!nextDataJson) {
      scheduleHardNavigationAndThrow(url, "Navigation failed: missing __NEXT_DATA__ in response");
    }

    const nextData = parseVinextNextDataJson(nextDataJson);
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

    // Wrap with RouterContext.Provider so next/router and next/compat/router work.
    element = wrapWithRouterContext(element);

    // Commit __NEXT_DATA__ only after all assertStillCurrent() checks have passed,
    // so a stale navigation can never pollute the global.
    // INVARIANT: Everything after the final assertStillCurrent() above (the
    // checkpoint immediately after the optional _app import) through
    // root.render() is synchronous. If any step here ever becomes async, add
    // another assertStillCurrent() before writing __NEXT_DATA__.
    window.__NEXT_DATA__ = nextData;
    applyVinextLocaleGlobals(window, nextData);
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
  fetchUrl = fullUrl,
): Promise<"completed" | "cancelled" | "failed"> {
  try {
    await navigateClient(fullUrl, fetchUrl);
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
 * and a set of navigation methods. Shared by the Pages Router context provider
 * and tests so the public router shape stays in sync.
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

/** Extract the hash fragment from a URL, including the leading `#`. */
function extractHash(url: string): string {
  const i = url.indexOf("#");
  return i === -1 ? "" : url.slice(i);
}

/** Notify in-page listeners (e.g. useRouter hooks) that navigation occurred. */
function dispatchNavigateEvent(): void {
  window.dispatchEvent(new CustomEvent("vinext:navigate"));
}

/**
 * Update history with the new URL and refresh the hash-only-detection tracker.
 * Centralises the `pushState`/`replaceState` branch so callers don't repeat it.
 */
function updateHistory(mode: "push" | "replace", url: string): void {
  if (mode === "push") window.history.pushState({}, "", url);
  else window.history.replaceState({}, "", url);
  _lastPathnameAndSearch = window.location.pathname + window.location.search;
}

/**
 * Throw the canonical "no router instance" error used when a Pages Router
 * navigation method (push/replace/back/reload/prefetch/beforePopState) is
 * invoked during SSR or prerendering.
 *
 * Mirrors Next.js's `ServerRouter.push`/`replace`/etc. which all call
 * `noRouter()` in `packages/next/src/server/render.tsx`. The error message
 * matches Next.js verbatim so userland error handling and docs links work
 * unchanged.
 *
 * Ported from Next.js: packages/next/src/server/render.tsx
 * https://github.com/vercel/next.js/blob/canary/packages/next/src/server/render.tsx
 */
function throwNoRouterInstance(): never {
  throw new Error(
    'No router instance found. you should only use "next/router" inside the client side of your app. https://nextjs.org/docs/messages/no-router-instance',
  );
}

/**
 * Shared client-side navigation flow used by both `useRouter()` and the
 * `Router` singleton. The only differences between push/replace are the
 * history method (`pushState` vs `replaceState`), the external-URL fallback
 * (`assign` vs `replace`), and the fact that push saves scroll position for
 * back/forward restoration while replace does not.
 *
 * `onStateUpdate` lets the hook trigger a `setState` re-render at the same
 * point that hashChangeComplete/routeChangeComplete fires; the singleton
 * passes no callback.
 */
async function performNavigation(
  url: string | UrlObject,
  as: string | undefined,
  options: TransitionOptions | undefined,
  mode: "push" | "replace",
  onStateUpdate?: () => void,
): Promise<boolean> {
  // SSR / prerender guard. Calling Router.push or Router.replace from a
  // Pages Router component during server rendering would otherwise crash
  // with `ReferenceError: window is not defined` (window.location is
  // accessed unconditionally below). Match Next.js's `ServerRouter.push`
  // behaviour and throw the documented "no router instance" error so the
  // failure surfaces as a normal render error instead of a ReferenceError
  // that takes down the request pipeline.
  if (typeof window === "undefined") {
    throwNoRouterInstance();
  }

  // Block dangerous URI schemes (javascript:, data:, vbscript:) before any
  // navigation work happens. Mirrors Next.js's Pages Router guard at
  // packages/next/src/shared/lib/router/router.ts:1020-1028,1052-1060, which
  // throws and (via React's event-handler runtime) surfaces a console.error
  // that the `test/e2e/app-dir/javascript-urls/javascript-urls.test.ts` suite
  // asserts on. `assertSafeNavigationUrl` emits the matching console.error
  // before throwing so the same observable behaviour holds when the throw is
  // swallowed by an async event handler (e.g. Link's click delegation).
  assertSafeNavigationUrl(resolveUrl(url));
  if (as !== undefined) {
    assertSafeNavigationUrl(String(as));
  }

  const navigationLocale = resolveTransitionLocale(options?.locale);
  let resolved = resolveNavigationTarget(url, as, navigationLocale);

  // External URLs — delegate to browser (unless same-origin)
  if (isExternalUrl(resolved)) {
    const localPath = toSameOriginAppPath(resolved, __basePath);
    if (localPath == null) {
      if (mode === "push") window.location.assign(resolved);
      else window.location.replace(resolved);
      return true;
    }
    resolved = localPath;
  }

  resolved = normalizePathTrailingSlash(resolved, __trailingSlash);
  const full = normalizePathTrailingSlash(
    toBrowserNavigationHref(resolved, window.location.href, __basePath),
    __trailingSlash,
  );
  const htmlFetchUrl = getPagesHtmlFetchUrl(full, navigationLocale);
  const shallow = options?.shallow ?? false;
  const doScroll = options?.scroll !== false;

  // Hash-only change — no page fetch needed
  if (isHashOnlyChange(full)) {
    const eventUrl = resolveHashUrl(full);
    routerEvents.emit("hashChangeStart", eventUrl, { shallow });
    updateHistory(mode, resolved.startsWith("#") ? resolved : full);
    if (doScroll) scrollToHashTarget(extractHash(resolved));
    onStateUpdate?.();
    routerEvents.emit("hashChangeComplete", eventUrl, { shallow });
    dispatchNavigateEvent();
    return true;
  }

  if (mode === "push") saveScrollPosition();
  routerEvents.emit("routeChangeStart", resolved, { shallow });
  routerEvents.emit("beforeHistoryChange", resolved, { shallow });
  updateHistory(mode, full);
  if (!shallow) {
    const result = await runNavigateClient(full, resolved, htmlFetchUrl);
    if (result === "cancelled") return true;
    if (result === "failed") return false;
  }
  onStateUpdate?.();
  routerEvents.emit("routeChangeComplete", resolved, { shallow });

  const hash = extractHash(resolved);
  if (doScroll) {
    if (hash) scrollToHashTarget(hash);
    else window.scrollTo(0, 0);
  }
  dispatchNavigateEvent();
  return true;
}

/** Inject a `<link rel="prefetch">` for the target page. */
async function prefetchUrl(url: string): Promise<void> {
  if (typeof document !== "undefined") {
    const link = document.createElement("link");
    link.rel = "prefetch";
    link.href = url;
    link.as = "document";
    document.head.appendChild(link);
  }
}

/**
 * useRouter hook - Pages Router compatible.
 *
 * Ported from Next.js: packages/next/src/client/router.ts
 * https://github.com/vercel/next.js/blob/canary/packages/next/src/client/router.ts
 */
export function useRouter(): NextRouter {
  const router = useContext(RouterContext);
  if (!router) {
    throw new Error(
      "NextRouter was not mounted. https://nextjs.org/docs/messages/next-router-not-mounted",
    );
  }

  return router;
}

function PagesRouterProvider({ children }: { children: ReactNode }): ReactElement {
  const [{ pathname, query, asPath }, setState] = useState(getPathnameAndQuery);

  // Popstate is handled by the Pages Router client entry via
  // installPagesRouterRuntime() so beforePopState() is consistently enforced
  // regardless of hook consumers. Keep URL snapshot subscriptions at the
  // provider boundary so many useRouter() calls share one router state and one
  // vinext:navigate listener.
  useEffect(() => {
    const onNavigate = ((_e: CustomEvent) => {
      setState(getPathnameAndQuery());
    }) as EventListener;
    window.addEventListener("vinext:navigate", onNavigate);
    return () => window.removeEventListener("vinext:navigate", onNavigate);
  }, []);

  const router = useMemo(
    (): NextRouter =>
      buildRouterValue(pathname, query, asPath, {
        push: Router.push,
        replace: Router.replace,
        back: Router.back,
        reload: Router.reload,
        prefetch: Router.prefetch,
        beforePopState: Router.beforePopState,
      }),
    [pathname, query, asPath],
  );

  return createElement(RouterContext.Provider, { value: router }, children);
}

// beforePopState callback: called before handling browser back/forward.
// If it returns false, the navigation is cancelled.
let _beforePopStateCb: BeforePopStateCallback | undefined;

// Track pathname+search for detecting hash-only back/forward in the popstate
// handler. Updated after every pushState/replaceState so that popstate can
// compare the previous value with the (already-changed) window.location.
let _lastPathnameAndSearch =
  typeof window !== "undefined" ? window.location.pathname + window.location.search : "";

function handlePagesRouterPopState(e: PopStateEvent): void {
  const browserUrl = window.location.pathname + window.location.search;
  const appUrl = stripBasePath(window.location.pathname, __basePath) + window.location.search;

  // Detect hash-only back/forward: pathname+search unchanged, only hash differs.
  const isHashOnly = browserUrl === _lastPathnameAndSearch;

  // Check beforePopState callback
  if (_beforePopStateCb !== undefined) {
    const shouldContinue = _beforePopStateCb({
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
    scrollToHashTarget(window.location.hash);
    routerEvents.emit("hashChangeComplete", hashUrl, { shallow: false });
    dispatchNavigateEvent();
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
    const result = await runNavigateClient(
      browserUrl,
      fullAppUrl,
      getPagesHtmlFetchUrl(browserUrl, window.__VINEXT_LOCALE__),
    );
    if (result === "completed") {
      routerEvents.emit("routeChangeComplete", fullAppUrl, { shallow: false });
      restoreScrollPosition(e.state);
      dispatchNavigateEvent();
    }
    // "cancelled": superseded by a newer navigation, so this popstate no longer wins.
    // "failed": runNavigateClient already scheduled the hard-navigation fallback.
  })();
}

setPagesRouterPopStateHandler(handlePagesRouterPopState);

/**
 * Wrap a React element in a RouterContext.Provider so that
 * next/compat/router's useRouter() returns the real Pages Router value.
 *
 * The provider owns the reactive Pages Router snapshot so next/router and
 * next/compat/router consumers share one context value instead of each hook
 * installing its own global URL-change listener.
 */
export function wrapWithRouterContext(element: ReactElement): ReactElement {
  return createElement(PagesRouterProvider, null, element);
}

/**
 * Props injected by `withRouter` into the wrapped component.
 *
 * Ported from Next.js: packages/next/src/client/with-router.tsx
 * https://github.com/vercel/next.js/blob/canary/packages/next/src/client/with-router.tsx
 */
export type WithRouterProps = {
  router: NextRouter;
};

/**
 * Pick<P, Exclude<keyof P, keyof WithRouterProps>> — the props of the
 * composed component minus the `router` prop that `withRouter` injects.
 *
 * Ported from Next.js: packages/next/src/client/with-router.tsx
 */
export type ExcludeRouterProps<P> = Pick<P, Exclude<keyof P, keyof WithRouterProps>>;

/**
 * Higher-order component that injects the Pages Router `router` instance as
 * a `router` prop into a wrapped component. Primarily used by class
 * components (which cannot call hooks) to access the router. The wrapped
 * component receives the same props as the original, minus `router`, which
 * is filled in by the HOC.
 *
 * Ported from Next.js: packages/next/src/client/with-router.tsx
 * https://github.com/vercel/next.js/blob/canary/packages/next/src/client/with-router.tsx
 *
 * Differences from Next.js:
 * - We type the composed component as `ComponentType<P>` instead of
 *   `NextComponentType<C, any, P>` because vinext does not expose
 *   `NextComponentType` from this shim. The runtime shape (and the props
 *   the wrapper forwards) is identical.
 * - We forward `getInitialProps` and `origGetInitialProps` from the
 *   composed component so `_app` parity holds for class components that
 *   define `getInitialProps`.
 */
export function withRouter<P extends WithRouterProps>(
  ComposedComponent: ComponentType<P>,
): ComponentType<ExcludeRouterProps<P>> {
  function WithRouterWrapper(props: ExcludeRouterProps<P>): ReactElement {
    const router = useRouter();
    // Match Next.js spread order:
    // `<ComposedComponent router={useRouter()} {...props} />`
    // The injected `router` is placed first, and `{...props}` is spread
    // after, so a user-passed `router` prop overrides the HOC-injected
    // one (last-spread wins). Mirrors
    // packages/next/src/client/with-router.tsx. At the type level
    // `props: ExcludeRouterProps<P>` has no `router` key, but TS still
    // sees `P` as `WithRouterProps`-extending when checking the literal,
    // so we widen to a `Record` for the final prop bag.
    const merged: Record<string, unknown> = { router, ...(props as Record<string, unknown>) };
    return createElement(ComposedComponent, merged as unknown as P);
  }

  // Forward getInitialProps so class-component pages that define it keep
  // working when wrapped. Mirrors Next.js's with-router.tsx.
  const composed = ComposedComponent as ComponentType<P> & {
    getInitialProps?: unknown;
    origGetInitialProps?: unknown;
  };
  (WithRouterWrapper as unknown as { getInitialProps?: unknown }).getInitialProps =
    composed.getInitialProps;
  (WithRouterWrapper as unknown as { origGetInitialProps?: unknown }).origGetInitialProps =
    composed.origGetInitialProps;

  if (process.env.NODE_ENV !== "production") {
    const name = composed.displayName || composed.name || "Unknown";
    WithRouterWrapper.displayName = `withRouter(${name})`;
  }

  return WithRouterWrapper;
}

// Note: `withRouter` is exposed only as a named export from `next/router`.
// The default export of that module is the Router singleton declared below.

// Also export a default Router singleton for `import Router from 'next/router'`.
//
// State fields (`pathname`, `route`, `query`, `asPath`, etc.) are exposed as
// live getters so `window.next.router.pathname` reflects the current URL
// without callers needing to know about React render cycles. Mirrors
// Next.js's `singletonRouter` shape from
// .nextjs-ref/packages/next/src/client/router.ts (lines 32–47), which uses
// `Object.defineProperty` to forward `urlPropertyFields` to the active
// router instance. The Next.js deploy test suite drives navigations through
// `browser.eval('next.router.push(...)')` and then reads
// `browser.eval('next.router.pathname')` to assert success, so the fields
// must be readable, not just the methods.
//
// Every navigation method is also guarded against SSR/prerender execution.
// Matches Next.js's `ServerRouter` (packages/next/src/server/render.tsx) which
// throws `noRouter()` from push/replace/back/reload/prefetch/beforePopState so
// that invoking them during server rendering surfaces as a documented render
// error rather than a `ReferenceError: window is not defined`. The throws are
// synchronous (not via the returned Promise) so render-time callers see the
// error inline — matching Next.js behaviour and avoiding unhandled rejections.
const RouterMethods = {
  push: (url: string | UrlObject, as?: string, options?: TransitionOptions) => {
    if (typeof window === "undefined") throwNoRouterInstance();
    return performNavigation(url, as, options, "push");
  },
  replace: (url: string | UrlObject, as?: string, options?: TransitionOptions) => {
    if (typeof window === "undefined") throwNoRouterInstance();
    return performNavigation(url, as, options, "replace");
  },
  back: () => {
    if (typeof window === "undefined") throwNoRouterInstance();
    window.history.back();
  },
  reload: () => {
    if (typeof window === "undefined") throwNoRouterInstance();
    window.location.reload();
  },
  prefetch: (url: string) => {
    if (typeof window === "undefined") throwNoRouterInstance();
    return prefetchUrl(url);
  },
  beforePopState: (cb: BeforePopStateCallback) => {
    if (typeof window === "undefined") throwNoRouterInstance();
    _beforePopStateCb = cb;
  },
  events: routerEvents,
};

const Router: typeof RouterMethods & Omit<NextRouter, keyof typeof RouterMethods> =
  Object.defineProperties(RouterMethods, {
    pathname: {
      enumerable: true,
      get(): string {
        return getPathnameAndQuery().pathname;
      },
    },
    route: {
      enumerable: true,
      get(): string {
        const { pathname } = getPathnameAndQuery();
        if (typeof window === "undefined") return pathname;
        const nextData = window.__NEXT_DATA__ as VinextNextData | undefined;
        return nextData?.page ?? pathname;
      },
    },
    query: {
      enumerable: true,
      get(): Record<string, string | string[]> {
        return getPathnameAndQuery().query;
      },
    },
    asPath: {
      enumerable: true,
      get(): string {
        return getPathnameAndQuery().asPath;
      },
    },
    basePath: { enumerable: true, value: __basePath, writable: false },
    locale: {
      enumerable: true,
      get(): string | undefined {
        if (typeof window === "undefined") return _getSSRContext()?.locale;
        return window.__VINEXT_LOCALE__;
      },
    },
    locales: {
      enumerable: true,
      get(): string[] | undefined {
        if (typeof window === "undefined") return _getSSRContext()?.locales;
        return window.__VINEXT_LOCALES__;
      },
    },
    defaultLocale: {
      enumerable: true,
      get(): string | undefined {
        if (typeof window === "undefined") return _getSSRContext()?.defaultLocale;
        return window.__VINEXT_DEFAULT_LOCALE__;
      },
    },
    domainLocales: {
      enumerable: true,
      get(): VinextNextData["domainLocales"] | undefined {
        if (typeof window === "undefined") return _getSSRContext()?.domainLocales;
        return (window.__NEXT_DATA__ as VinextNextData | undefined)?.domainLocales;
      },
    },
    isReady: { enumerable: true, value: true, writable: false },
    isPreview: { enumerable: true, value: false, writable: false },
    isFallback: {
      enumerable: true,
      get(): boolean {
        if (typeof window === "undefined") return false;
        return (window.__NEXT_DATA__ as VinextNextData | undefined)?.isFallback === true;
      },
    },
  }) as typeof RouterMethods & Omit<NextRouter, keyof typeof RouterMethods>;

// Expose `window.next.router` for Next.js parity. Pages Router test suites,
// userland scripts, and third-party libraries reach for this global directly
// (e.g. `window.next.router.push(...)`, `window.next.router.events.on(...)`,
// `window.next.router.pathname`).
// Without this assignment, those callers crash with
// `TypeError: Cannot read properties of undefined (reading 'router')`.
//
// Ported from Next.js: `packages/next/src/client/next.ts` (line 13). We do
// NOT use a live-binding getter like Next.js does because vinext's Router
// singleton is constructed synchronously here, so by the time this module
// finishes loading the value is final.
if (typeof window !== "undefined") {
  // Cast: `NextRouter.push`/`replace` are typed with narrow parameters
  // (UrlObject | string) while `PagesRouterPublicInstance` accepts unknown
  // args. The two are structurally compatible at runtime; TypeScript flags
  // the narrowing of contravariant function params, which is benign here
  // because callers reading off `window.next.router` are tests/userland
  // and treat the surface as opaque.
  installWindowNext({ router: Router as unknown as PagesRouterPublicInstance });
}

// Register the Pages Router compat shim source for `next/navigation` hooks
// (useParams / useSearchParams / usePathname). The accessor is exposed
// through a well-known Symbol.for so navigation.ts can read it without
// importing this module — that avoids triggering navigation.ts's
// `window.history.pushState` patch in tests that only need next/router.
//
// Mirrors Next.js's behavior where the pages-router server (render.tsx) and
// client (client/index.tsx) wrap pages with SearchParamsContext /
// PathParamsContext / PathnameContext providers populated from the router.
const _PAGES_NAVIGATION_ACCESSOR_KEY = Symbol.for(
  "vinext.navigation.pagesNavigationContextAccessor",
);
(globalThis as Record<PropertyKey, unknown>)[_PAGES_NAVIGATION_ACCESSOR_KEY] =
  getPagesNavigationContext;

export default Router;
