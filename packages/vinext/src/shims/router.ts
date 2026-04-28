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
  useCallback,
  useMemo,
  useContext,
  createElement,
  type ComponentType,
  type ReactElement,
} from "react";
import { RouterContext } from "./internal/router-context.js";
import type { VinextNextData } from "../client/vinext-next-data.js";
import { isValidModulePath } from "../client/validate-module-path.js";
import {
  normalizeLocalTrailingSlashHref,
  toBrowserNavigationHref,
  toSameOriginAppPath,
} from "./url-utils.js";
import { hasBasePath, stripBasePath } from "../utils/base-path.js";
import { addLocalePrefix, getDomainLocaleUrl, type DomainLocale } from "../utils/domain-locale.js";
import {
  addQueryParam,
  appendSearchParamsToUrl,
  type UrlQuery,
  urlQueryToSearchParams,
} from "../utils/query.js";

/** basePath from next.config.js, injected by the plugin at build time */
const __basePath: string = process.env.__NEXT_ROUTER_BASEPATH ?? "";
const __trailingSlash = process.env.__NEXT_ROUTER_TRAILING_SLASH === "true";
const __scrollRestoration = process.env.__NEXT_SCROLL_RESTORATION === "true";

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
  /** Static data cache used by Next's legacy Pages Router internals. */
  sdc: Record<string, unknown>;
  /** Listen for route changes */
  events: RouterEvents;
};

type LegacyRouterEvent =
  | "routeChangeStart"
  | "routeChangeComplete"
  | "routeChangeError"
  | "beforeHistoryChange"
  | "hashChangeStart"
  | "hashChangeComplete";

type LegacyRouterEventHandler = (...args: unknown[]) => void;

type LegacyRouterEventProperty =
  | "onRouteChangeStart"
  | "onRouteChangeComplete"
  | "onRouteChangeError"
  | "onBeforeHistoryChange"
  | "onHashChangeStart"
  | "onHashChangeComplete";

export type NextRouterSingleton = NextRouter &
  Partial<Record<LegacyRouterEventProperty, LegacyRouterEventHandler | null>>;

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

const LEGACY_ROUTER_EVENT_PROPS: Record<LegacyRouterEvent, LegacyRouterEventProperty> = {
  routeChangeStart: "onRouteChangeStart",
  routeChangeComplete: "onRouteChangeComplete",
  routeChangeError: "onRouteChangeError",
  beforeHistoryChange: "onBeforeHistoryChange",
  hashChangeStart: "onHashChangeStart",
  hashChangeComplete: "onHashChangeComplete",
};

let singletonRouter: NextRouterSingleton | null = null;

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
      const legacyProp = LEGACY_ROUTER_EVENT_PROPS[event as LegacyRouterEvent];
      const legacyHandler = legacyProp ? singletonRouter?.[legacyProp] : null;
      if (typeof legacyHandler === "function") legacyHandler(...args);
    },
  };
}

// Singleton events instance
const routerEvents = createRouterEvents();

function dispatchVinextNavigate(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent("vinext:navigate"));
  setTimeout(() => {
    if (typeof window === "undefined") return;
    window.dispatchEvent(new CustomEvent("vinext:navigate"));
  }, 0);
}

function resolveUrl(url: string | UrlObject): string {
  if (typeof url === "string") return url;
  let result = url.pathname ?? "/";
  if (url.query) {
    const params = urlQueryToSearchParams(url.query);
    result = appendSearchParamsToUrl(result, params);
  }
  return result;
}

function getDynamicParamNames(pattern: string): string[] {
  const names: string[] = [];
  const dynamicParamRe = /\[(?:\.\.\.)?([^\]]+)\]/g;
  let match: RegExpExecArray | null;
  while ((match = dynamicParamRe.exec(pattern)) !== null) {
    names.push(match[1]);
  }
  return names;
}

function interpolateVisibleDynamicPath(
  routePattern: string,
  visiblePathname: string,
  query: URLSearchParams,
): string | null {
  const patternParts = routePattern.split("/").filter(Boolean);
  const pathParts = visiblePathname.split("/").filter(Boolean);
  const nextParts: string[] = [];

  for (let i = 0; i < patternParts.length; i++) {
    const patternPart = patternParts[i];
    const catchAll = patternPart.match(/^\[\.\.\.([^\]]+)\]$/);
    if (catchAll) {
      const values = query.getAll(catchAll[1]);
      if (values.length === 0) return null;
      nextParts.push(...values.map((value) => encodeURIComponent(value)));
      query.delete(catchAll[1]);
      return `/${nextParts.join("/")}`;
    }

    const dynamic = patternPart.match(/^\[([^\]]+)\]$/);
    if (dynamic) {
      if (pathParts[i] === undefined) return null;
      const value = query.get(dynamic[1]);
      nextParts.push(encodeURIComponent(value ?? decodeURIComponent(pathParts[i])));
      if (value !== null) query.delete(dynamic[1]);
      continue;
    }

    if (patternPart !== pathParts[i]) return null;
    nextParts.push(pathParts[i]);
  }

  if (patternParts.length !== pathParts.length) return null;
  return `/${nextParts.join("/")}`;
}

function resolveCurrentVisibleQueryNavigation(queryString: string): string {
  if (typeof window === "undefined") return queryString;

  const currentPathname = stripBasePath(window.location.pathname, __basePath);
  const origin = window.location.origin ?? new URL(window.location.href).origin;
  const parsed = new URL(`${currentPathname}${queryString}`, origin);
  const nextDataPage = window.__NEXT_DATA__?.page;
  let searchParams = new URLSearchParams(parsed.search);

  let pathname = currentPathname;
  if (nextDataPage && getDynamicParamNames(nextDataPage).some((name) => searchParams.has(name))) {
    const interpolatedSearchParams = new URLSearchParams(searchParams);
    const interpolatedPathname = interpolateVisibleDynamicPath(
      nextDataPage,
      currentPathname,
      interpolatedSearchParams,
    );
    if (interpolatedPathname) {
      pathname = interpolatedPathname;
      searchParams = interpolatedSearchParams;
    }
  }

  const search = searchParams.toString();
  return `${pathname}${search ? `?${search}` : ""}${parsed.hash}`;
}

function resolvePagesRelativeNavigationUrl(url: string | UrlObject): string {
  if (typeof url === "string") {
    return url.startsWith("?") ? resolveCurrentVisibleQueryNavigation(url) : url;
  }

  if (url.pathname !== undefined) return resolveUrl(url);

  const params = url.query ? urlQueryToSearchParams(url.query) : new URLSearchParams();
  const query = params.toString();
  return resolveCurrentVisibleQueryNavigation(query ? `?${query}` : "");
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
  return normalizeLocalTrailingSlashHref(
    applyNavigationLocale(as ?? resolvePagesRelativeNavigationUrl(url), locale),
    __trailingSlash,
  );
}

function resolveNavigationRouteTarget(url: string | UrlObject, locale: string | undefined): string {
  return normalizeLocalTrailingSlashHref(
    applyNavigationLocale(resolvePagesRelativeNavigationUrl(url), locale),
    __trailingSlash,
  );
}

function resolveErrorRouteFetchTarget(
  url: string | UrlObject,
  as: string | undefined,
): string | null {
  if (as === undefined) return null;
  const routeTarget = resolvePagesRelativeNavigationUrl(url);
  const routePathname = routeTarget.split(/[?#]/, 1)[0];
  if (routePathname === "/404") return routeTarget;
  if (routePathname === "/_error") {
    return routeTarget.replace(/^\/_error(?=$|[?#])/, "/404");
  }
  return null;
}

function hasDynamicRouteSegment(pathname: string): boolean {
  return /\[[^\]]+\]/.test(pathname);
}

function appendSearchToPath(path: string, searchParams: URLSearchParams, hash: string): string {
  const search = searchParams.toString();
  return `${path}${search ? `?${search}` : ""}${hash}`;
}

function interpolateDynamicRouteTarget(routeTarget: string, asTarget: string): string {
  const routeUrl = new URL(routeTarget, "http://vinext.local");
  if (!hasDynamicRouteSegment(routeUrl.pathname)) return routeTarget;

  const routeSearchParams = new URLSearchParams(routeUrl.search);
  const dynamicParamNames = getDynamicParamNames(routeUrl.pathname);
  let missingParam = false;

  const interpolatedPathname = routeUrl.pathname
    .replace(/\[\[\.\.\.([^\]]+)\]\]/g, (_match, key: string) => {
      const values = routeSearchParams.getAll(key);
      routeSearchParams.delete(key);
      if (values.length === 0) {
        missingParam = true;
        return "";
      }
      return values.map((value) => encodeURIComponent(value)).join("/");
    })
    .replace(/\[\.\.\.([^\]]+)\]/g, (_match, key: string) => {
      const values = routeSearchParams.getAll(key);
      routeSearchParams.delete(key);
      if (values.length === 0) {
        missingParam = true;
        return "";
      }
      return values.map((value) => encodeURIComponent(value)).join("/");
    })
    .replace(/\[([^\]]+)\]/g, (_match, key: string) => {
      const value = routeSearchParams.get(key);
      routeSearchParams.delete(key);
      if (value == null) {
        missingParam = true;
        return "";
      }
      return encodeURIComponent(value);
    });

  if (!missingParam && !hasDynamicRouteSegment(interpolatedPathname)) {
    return appendSearchToPath(interpolatedPathname, routeSearchParams, routeUrl.hash);
  }

  const asUrl = new URL(asTarget, "http://vinext.local");
  for (const key of dynamicParamNames) {
    routeSearchParams.delete(key);
  }
  return appendSearchToPath(asUrl.pathname, routeSearchParams, asUrl.hash);
}

function shouldHardNavigateManualBasePathTarget(resolved: string): boolean {
  if (!__basePath || !resolved.startsWith("/") || resolved.startsWith("//")) return false;
  try {
    return hasBasePath(new URL(resolved, "http://vinext.local").pathname, __basePath);
  } catch {
    return false;
  }
}

function isCurrentBrowserUrl(url: string): boolean {
  try {
    const current = new URL(window.location.href);
    const target = new URL(url, window.location.href);
    return (
      current.pathname === target.pathname &&
      current.search === target.search &&
      current.hash === target.hash
    );
  } catch {
    return false;
  }
}

function shouldCommitQueryNavigationBeforeFetch(url: string): boolean {
  try {
    const target = new URL(url, window.location.href);
    return target.search !== "" && target.pathname === window.location.pathname;
  } catch {
    return false;
  }
}

function resolveNavigationRouteFetch(
  url: string | UrlObject,
  as: string | undefined,
  locale: string | undefined,
  browserFullUrl: string,
): { routeFull: string; allowErrorPageData: boolean } {
  const errorRouteFetchTarget = resolveErrorRouteFetchTarget(url, as);
  let routeTarget: string | null = errorRouteFetchTarget;
  if (!routeTarget && as !== undefined) {
    const routeHrefTarget = resolveNavigationRouteTarget(url, locale);
    const asTarget = resolveNavigationTarget(as, undefined, locale);
    routeTarget = interpolateDynamicRouteTarget(routeHrefTarget, asTarget);
  }
  if (!routeTarget) {
    return { routeFull: browserFullUrl, allowErrorPageData: false };
  }

  if (isExternalUrl(routeTarget)) {
    const localPath = toSameOriginAppPath(routeTarget, __basePath);
    if (localPath == null) {
      return { routeFull: browserFullUrl, allowErrorPageData: errorRouteFetchTarget !== null };
    }
    routeTarget = localPath;
  }

  return {
    routeFull: toBrowserNavigationHref(routeTarget, window.location.href, __basePath),
    allowErrorPageData: errorRouteFetchTarget !== null,
  };
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

/** Resolve a hash URL to the browser-visible URL for event payloads. */
function resolveHashUrl(url: string): string {
  if (typeof window === "undefined") return url;
  if (url.startsWith("#")) return window.location.pathname + window.location.search + url;
  try {
    const parsed = new URL(url, window.location.href);
    return parsed.pathname + parsed.search + parsed.hash;
  } catch {
    return url;
  }
}

function toRouterEventUrl(fullHref: string): string {
  try {
    const parsed = new URL(fullHref, window.location.href);
    return parsed.pathname + parsed.search + parsed.hash;
  } catch {
    return fullHref;
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

function createKey(): string {
  return Math.random().toString(36).slice(2, 10);
}

function canUseManualScrollRestoration(): boolean {
  if (!__scrollRestoration || typeof window === "undefined") return false;
  if (!window.history) return false;
  if (!("scrollRestoration" in window.history)) return false;
  try {
    const testKey = "__vinext_scroll_test";
    window.sessionStorage.setItem(testKey, testKey);
    window.sessionStorage.removeItem(testKey);
    return true;
  } catch {
    return false;
  }
}

const manualScrollRestoration = canUseManualScrollRestoration();
let _historyKey =
  typeof window !== "undefined" &&
  window.history?.state &&
  typeof window.history.state === "object" &&
  typeof (window.history.state as { key?: unknown }).key === "string"
    ? (window.history.state as { key: string }).key
    : createKey();

function saveScrollPositionToSession(key: string): void {
  if (!manualScrollRestoration) return;
  try {
    window.sessionStorage.setItem(
      `__next_scroll_${key}`,
      JSON.stringify({ x: window.scrollX, y: window.scrollY }),
    );
  } catch {
    // Fall back to browser behavior if sessionStorage is unavailable.
  }
}

function readScrollPositionFromSession(key: string): { x: number; y: number } | null {
  if (!manualScrollRestoration) return null;
  try {
    const value = window.sessionStorage.getItem(`__next_scroll_${key}`);
    if (!value) return null;
    const parsed = JSON.parse(value) as { x?: unknown; y?: unknown };
    if (typeof parsed.x !== "number" || typeof parsed.y !== "number") return null;
    return { x: parsed.x, y: parsed.y };
  } catch {
    return { x: 0, y: 0 };
  }
}

/** Save current scroll position into history state for back/forward restoration */
function saveScrollPosition(): void {
  saveScrollPositionToSession(_historyKey);
  const state = window.history.state ?? {};
  window.history.replaceState(
    {
      ...state,
      __vinext_scrollX: window.scrollX,
      __vinext_scrollY: window.scrollY,
      __vinext_restore_url:
        window.location.pathname + window.location.search + window.location.hash,
    },
    "",
  );
}

/** Restore scroll position from history state */
function restoreScrollPosition(
  state: unknown,
  forcedScroll?: { x: number; y: number } | null,
): void {
  if (forcedScroll) {
    requestAnimationFrame(() => window.scrollTo(forcedScroll.x, forcedScroll.y));
    return;
  }
  if (state && typeof state === "object" && "__vinext_scrollY" in state) {
    const { __vinext_scrollX: x, __vinext_scrollY: y } = state as {
      __vinext_scrollX: number;
      __vinext_scrollY: number;
    };
    requestAnimationFrame(() => window.scrollTo(x, y));
  }
}

function preserveTargetSearchIfRewriteDroppedIt(targetHref: string): void {
  const target = new URL(targetHref, window.location.href);
  if (target.search === "") return;
  if (window.location.pathname !== target.pathname || window.location.search !== "") return;

  window.history.replaceState(
    window.history.state ?? {},
    "",
    target.pathname + target.search + target.hash,
  );
  _lastPathnameAndSearch = window.location.pathname + window.location.search;
}

/**
 * SSR context - set by the dev server before rendering each page.
 */
type SSRContext = {
  pathname: string;
  query: Record<string, string | string[]>;
  asPath: string;
  isFallback?: boolean;
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

function extractDynamicParamsFromPath(
  pattern: string,
  pathname: string,
): Record<string, string | string[]> | null {
  const patternParts = pattern.split("/").filter(Boolean);
  const pathParts = pathname.split("/").filter(Boolean);
  const params: Record<string, string | string[]> = {};

  for (let i = 0; i < patternParts.length; i++) {
    const patternPart = patternParts[i];
    const catchAll = patternPart.match(/^\[\.\.\.([^\]]+)\]$/);
    if (catchAll) {
      params[catchAll[1]] = pathParts.slice(i).map((part) => decodeURIComponent(part));
      return params;
    }

    const dynamic = patternPart.match(/^\[([^\]]+)\]$/);
    if (dynamic) {
      const pathPart = pathParts[i];
      if (pathPart === undefined) return null;
      params[dynamic[1]] = decodeURIComponent(pathPart);
      continue;
    }

    if (patternPart !== pathParts[i]) return null;
  }

  return patternParts.length === pathParts.length ? params : null;
}

function getPathnameAndQuery(): {
  pathname: string;
  query: Record<string, string | string[]>;
  asPath: string;
} {
  return getPathnameAndQueryFromLocation({ includeSearchParams: true });
}

function getHydrationPathnameAndQuery(): {
  pathname: string;
  query: Record<string, string | string[]>;
  asPath: string;
} {
  return getPathnameAndQueryFromLocation({ includeSearchParams: false });
}

function getPathnameAndQueryFromLocation(options: { includeSearchParams: boolean }): {
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
  const browserUrl = new URL(
    _pendingNavigationBrowserUrl ?? window.location.href,
    window.location.href,
  );
  const resolvedPath = stripBasePath(browserUrl.pathname, __basePath);
  // In Next.js, router.pathname is the route pattern (e.g., "/posts/[id]"),
  // not the resolved path ("/posts/42"). __NEXT_DATA__.page holds the route
  // pattern and is updated by navigateClient() on every client-side navigation.
  const pathname = window.__NEXT_DATA__?.page ?? resolvedPath;
  const nextDataQuery: Record<string, string | string[]> = {};
  // Include serialized router query from __NEXT_DATA__ (e.g., dynamic params
  // plus query params introduced by middleware/config rewrites but not visible
  // in window.location.search).
  const nextData = window.__NEXT_DATA__;
  if (nextData && nextData.query && nextData.page) {
    for (const [key, value] of Object.entries(nextData.query)) {
      if (typeof value === "string") {
        nextDataQuery[key] = value;
      } else if (Array.isArray(value)) {
        nextDataQuery[key] = [...value];
      }
    }
  }
  // URL search params always reflect the current URL after hydration. During
  // the first client render, prefer serialized __NEXT_DATA__.query so static
  // Pages Router apps hydrate against the same query object the server used.
  const searchQuery: Record<string, string | string[]> = {};
  if (options.includeSearchParams) {
    const params = new URLSearchParams(browserUrl.search);
    for (const [key, value] of params) {
      addQueryParam(searchQuery, key, value);
    }
  }
  const query = { ...nextDataQuery, ...searchQuery };
  const dynamicPathParams = extractDynamicParamsFromPath(pathname, resolvedPath);
  for (const key of getDynamicParamNames(pathname)) {
    if (dynamicPathParams && key in dynamicPathParams) {
      query[key] = dynamicPathParams[key];
    } else if (key in nextDataQuery) {
      query[key] = nextDataQuery[key];
    }
  }
  // asPath uses the resolved browser path, not the route pattern
  const asPath = resolvedPath + browserUrl.search + browserUrl.hash;
  return { pathname, query, asPath };
}

/**
 * Error thrown when a navigation is superseded by a newer one.
 * Matches Next.js's convention of an Error with `.cancelled = true`.
 */
class NavigationCancelledError extends Error {
  cancelled = true;
  constructor(_route: string) {
    super("Route Cancelled");
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
let _activeNavigationUrl: string | null = null;
let _activeNavigationPromise: Promise<void> | null = null;
let _pendingNavigationBrowserUrl: string | null = null;
const _preEmittedCancelledUrls = new Set<string>();
const _inFlightPagesDataRequests = new Map<string, Promise<PagesNavigationDataResult>>();

function emitActiveNavigationCancelled(): void {
  if (!_activeAbortController || !_activeNavigationUrl) return;
  const cancelledUrl = _activeNavigationUrl;
  _preEmittedCancelledUrls.add(cancelledUrl);
  routerEvents.emit(
    "routeChangeError",
    new NavigationCancelledError(cancelledUrl),
    toRouterEventUrl(cancelledUrl),
    { shallow: false },
  );
}

function scheduleHardNavigationAndThrow(url: string, message: string, delayMs = 0): never {
  if (typeof window === "undefined") {
    throw new HardNavigationScheduledError(message);
  }
  if (delayMs > 0) {
    setTimeout(() => {
      window.location.href = url;
    }, delayMs);
  } else {
    window.location.href = url;
  }
  throw new HardNavigationScheduledError(message);
}

function getPagesDataPathParts(appPathname: string): {
  localePrefix: string;
  pagePathname: string;
} {
  const locales = window.__VINEXT_LOCALES__ ?? [];
  const defaultLocale = window.__VINEXT_DEFAULT_LOCALE__;
  const targetLocale = appPathname.split("/").filter(Boolean)[0];
  if (targetLocale && locales.includes(targetLocale)) {
    const pagePathname = appPathname.slice(targetLocale.length + 1) || "/";
    return { localePrefix: `/${targetLocale}`, pagePathname };
  }

  if (defaultLocale && locales.includes(defaultLocale)) {
    return { localePrefix: `/${defaultLocale}`, pagePathname: appPathname };
  }

  // Non-i18n data URLs do not carry a locale prefix.
  return { localePrefix: "", pagePathname: appPathname };
}

function buildPagesDataUrl(url: string): string | null {
  const buildId = window.__NEXT_DATA__?.buildId ?? process.env.__VINEXT_BUILD_ID;
  if (!buildId) return null;

  const parsed = new URL(url, window.location.href);
  const appPathname = stripBasePath(parsed.pathname, __basePath);
  const dataPathParts = getPagesDataPathParts(appPathname);
  const pagePathname =
    dataPathParts.pagePathname === "/"
      ? dataPathParts.localePrefix
        ? ""
        : "/index"
      : dataPathParts.pagePathname.replace(/\/$/, "");
  const basePathPrefix = __basePath || "";

  return `${parsed.origin}${basePathPrefix}/_next/data/${buildId}${dataPathParts.localePrefix}${pagePathname}.json${parsed.search}`;
}

type PagesNavigationData = Record<string, unknown> & {
  pageProps?: Record<string, unknown>;
  page?: string;
  query?: Record<string, string | string[]>;
  buildId?: string;
  gssp?: boolean;
  gsp?: boolean;
  isFallback?: boolean;
  locale?: string;
  locales?: string[];
  defaultLocale?: string;
  domainLocales?: VinextNextData["domainLocales"];
  __vinext?: VinextNextData["__vinext"];
};

type PagesNavigationDataResult =
  | { kind: "data"; data: PagesNavigationData }
  | {
      kind: "redirect";
      url: string;
      result: Exclude<PagesNavigationDataResult, { kind: "redirect" }>;
    }
  | { kind: "not-found" }
  | { kind: "fallback" };

async function renderPagesRoot(
  root: { render(element: ReactElement): void },
  element: ReactElement,
) {
  try {
    const { flushSync } = await import("react-dom");
    flushSync(() => root.render(element));
  } catch {
    root.render(element);
  }
}

async function fetchPagesNavigationData(
  url: string,
  signal: AbortSignal,
  options: { allowErrorPageData?: boolean } = {},
): Promise<PagesNavigationDataResult> {
  const dataUrl = buildPagesDataUrl(url);
  if (!dataUrl) return { kind: "fallback" };

  const cachedData = window.next?.router?.sdc?.[dataUrl];
  if (cachedData && typeof cachedData === "object") {
    return { kind: "data", data: cachedData as PagesNavigationData };
  }

  const inFlightRequest = _inFlightPagesDataRequests.get(dataUrl);
  if (inFlightRequest) {
    return await inFlightRequest;
  }

  const requestPromise = fetchUncachedPagesNavigationData(url, dataUrl, signal, options);
  _inFlightPagesDataRequests.set(dataUrl, requestPromise);
  try {
    return await requestPromise;
  } finally {
    if (_inFlightPagesDataRequests.get(dataUrl) === requestPromise) {
      _inFlightPagesDataRequests.delete(dataUrl);
    }
  }
}

async function fetchUncachedPagesNavigationData(
  url: string,
  dataUrl: string,
  signal: AbortSignal,
  options: { allowErrorPageData?: boolean },
): Promise<PagesNavigationDataResult> {
  let res: Response;
  try {
    res = await fetch(dataUrl, {
      headers: { "x-nextjs-data": "1" },
      credentials: "include",
      signal,
    });
  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new NavigationCancelledError(url);
    }
    throw err;
  }

  let redirectUrl: string | undefined;
  const redirectHeader = res.headers.get("x-nextjs-redirect");
  if (redirectHeader) {
    redirectUrl = redirectHeader;
  }
  if (res.redirected) {
    try {
      const finalUrl = new URL(res.url);
      if (finalUrl.origin === window.location.origin) {
        redirectUrl = finalUrl.pathname + finalUrl.search + finalUrl.hash;
      }
    } catch {
      // Ignore malformed redirect URLs and handle the response normally.
    }
  }

  const withRedirect = (
    result: Exclude<PagesNavigationDataResult, { kind: "redirect" }>,
  ): PagesNavigationDataResult =>
    redirectUrl ? { kind: "redirect", url: redirectUrl, result } : result;

  if (!res.ok) {
    if (redirectUrl) {
      return withRedirect({ kind: "fallback" });
    }
    if (res.status === 404) {
      const contentType = res.headers.get("Content-Type") ?? "";
      if (!redirectUrl && !contentType.toLowerCase().includes("application/json")) {
        return { kind: "fallback" };
      }
      if (!redirectUrl && contentType.toLowerCase().includes("application/json")) {
        try {
          const data = (await res.clone().json()) as { page?: unknown };
          if (data.page === "/404" && !options.allowErrorPageData) {
            scheduleHardNavigationAndThrow(url, "Navigation data request resolved to /404");
          }
        } catch (err: unknown) {
          if (err instanceof HardNavigationScheduledError) {
            throw err;
          }
          // Malformed 404 JSON falls back to the soft not-found render below.
        }
      }
      return withRedirect({ kind: "not-found" });
    }
    if (window.__VINEXT_SUPPRESS_DATA_NAVIGATION_FAILURE === true) {
      return withRedirect({ kind: "fallback" });
    }
    scheduleHardNavigationAndThrow(url, "Failed to load static props", 1500);
  }

  const contentType = res.headers.get("Content-Type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return withRedirect({ kind: "fallback" });
  }

  try {
    const data = (await res.json()) as PagesNavigationData;
    if (!redirectUrl && data.page === "/404" && !options.allowErrorPageData) {
      scheduleHardNavigationAndThrow(url, "Navigation data request resolved to /404");
    }
    return withRedirect({ kind: "data", data });
  } catch (err: unknown) {
    if (err instanceof HardNavigationScheduledError) {
      throw err;
    }
    return withRedirect({ kind: "fallback" });
  }
}

function renderPagesNotFound(root: { render(element: ReactElement): void }): void {
  const element = createElement(
    "div",
    null,
    createElement("h1", null, "404 - Page not found"),
    createElement("p", null, "This page could not be found."),
  );
  window.__NEXT_DATA__ = {
    ...window.__NEXT_DATA__,
    page: "/404",
    query: {},
    isFallback: false,
  } as VinextNextData;
  root.render(element);
}

function getCurrentBrowserPathSearchHash(): string {
  return window.location.pathname + window.location.search + window.location.hash;
}

function syncHistoryTrackingFromCurrent(): void {
  const state = window.history.state as NextHistoryState | null;
  if (state?.__N && typeof state.key === "string") {
    _historyKey = state.key;
  }
  _lastPathnameAndSearch = window.location.pathname + window.location.search;
}

function commitPushNavigationHistory(
  historyState: NextHistoryState,
  full: string,
  routeFull: string,
  hasAs: boolean,
): void {
  if (hasAs && routeFull !== full && isCurrentBrowserUrl(full)) {
    historyState.key = _historyKey;
    window.history.replaceState(historyState, "", full);
  } else {
    window.history.pushState(historyState, "", full);
    _historyKey = historyState.key ?? _historyKey;
  }
  _lastPathnameAndSearch = window.location.pathname + window.location.search;
}

function commitReplaceNavigationHistory(historyState: NextHistoryState, full: string): void {
  window.history.replaceState(historyState, "", full);
  _historyKey = historyState.key ?? _historyKey;
  _lastPathnameAndSearch = window.location.pathname + window.location.search;
}

function syncI18nGlobalsFromNextData(nextData: VinextNextData): void {
  if (!nextData.locales) return;
  window.__VINEXT_LOCALE__ = nextData.locale;
  window.__VINEXT_LOCALES__ = nextData.locales;
  window.__VINEXT_DEFAULT_LOCALE__ = nextData.defaultLocale;
}

/**
 * Perform client-side navigation: fetch the target page's HTML,
 * extract __NEXT_DATA__, and re-render the React root.
 *
 * Throws NavigationCancelledError if a newer navigation supersedes this one.
 * Throws on hard-navigation failures (non-OK response, missing data) so the
 * caller can distinguish success from failure for event emission.
 */
async function navigateClient(
  url: string,
  options: { allowErrorPageData?: boolean; beforeRender?: () => void } = {},
): Promise<void> {
  if (typeof window === "undefined") return;

  const root = window.__VINEXT_ROOT__;
  if (!root) {
    // No React root yet — fall back to hard navigation
    window.location.href = url;
    return;
  }

  if (_activeNavigationUrl === url) {
    await _activeNavigationPromise;
    return;
  }
  _activeNavigationUrl = url;

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

  const navigationPromise = (async () => {
    let dataResult = await fetchPagesNavigationData(url, controller.signal, options);
    assertStillCurrent();

    if (dataResult.kind === "redirect") {
      const targetUrl = new URL(url, window.location.href);
      const redirectUrl = new URL(dataResult.url, window.location.href);
      if (redirectUrl.origin !== window.location.origin) {
        scheduleHardNavigationAndThrow(
          redirectUrl.href,
          "Navigation data request redirected externally",
        );
      }
      const redirectOnlyDroppedQuery =
        targetUrl.pathname === redirectUrl.pathname &&
        targetUrl.search !== "" &&
        redirectUrl.search === "";
      if (!redirectOnlyDroppedQuery) {
        window.history.replaceState(
          {},
          "",
          redirectUrl.pathname + redirectUrl.search + redirectUrl.hash,
        );
        _lastPathnameAndSearch = window.location.pathname + window.location.search;
        url = redirectUrl.pathname + redirectUrl.search + redirectUrl.hash;
      }
      dataResult = dataResult.result;
    }

    if (dataResult.kind === "not-found") {
      options.beforeRender?.();
      renderPagesNotFound(root);
      return;
    }

    if (dataResult.kind === "data" && dataResult.data.__vinext?.pageModuleUrl) {
      const { pageProps = {}, ...appProps } = dataResult.data;
      const nextData = {
        ...window.__NEXT_DATA__,
        props: { ...appProps, pageProps },
        page:
          dataResult.data.page ??
          window.__NEXT_DATA__?.page ??
          stripBasePath(new URL(url, window.location.href).pathname, __basePath),
        query: dataResult.data.query ?? {},
        buildId: dataResult.data.buildId ?? window.__NEXT_DATA__?.buildId,
        isFallback: dataResult.data.isFallback ?? false,
        locale: dataResult.data.locale ?? window.__NEXT_DATA__?.locale,
        locales: dataResult.data.locales ?? window.__NEXT_DATA__?.locales,
        defaultLocale: dataResult.data.defaultLocale ?? window.__NEXT_DATA__?.defaultLocale,
        domainLocales: dataResult.data.domainLocales ?? window.__NEXT_DATA__?.domainLocales,
        ...(dataResult.data.gsp ? { gsp: true } : {}),
        ...(dataResult.data.gssp ? { gssp: true } : {}),
        __vinext: dataResult.data.__vinext,
      } as VinextNextData;

      const pageModuleUrl = dataResult.data.__vinext.pageModuleUrl;
      if (!isValidModulePath(pageModuleUrl)) {
        console.error("[vinext] Blocked import of invalid page module path:", pageModuleUrl);
        scheduleHardNavigationAndThrow(url, "Navigation failed: invalid page module path");
      }

      const pageModule = await import(/* @vite-ignore */ pageModuleUrl);
      assertStillCurrent();

      const PageComponent = pageModule.default;
      if (!PageComponent) {
        scheduleHardNavigationAndThrow(url, "Navigation failed: page module has no default export");
      }

      const React = (await import("react")).default;
      assertStillCurrent();

      let AppComponent = window.__VINEXT_APP__;
      const appModuleUrl = dataResult.data.__vinext.appModuleUrl;
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
          ...appProps,
        });
      } else {
        element = React.createElement(PageComponent, pageProps);
      }

      window.__NEXT_DATA__ = nextData;
      syncI18nGlobalsFromNextData(nextData);
      element = wrapWithRouterContext(element);
      options.beforeRender?.();
      await renderPagesRoot(root, element);
      return;
    }

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

    if (res.redirected) {
      try {
        const targetUrl = new URL(url, window.location.href);
        const finalUrl = new URL(res.url);
        if (finalUrl.origin === window.location.origin) {
          const redirectOnlyDroppedQuery =
            targetUrl.pathname === finalUrl.pathname &&
            targetUrl.search !== "" &&
            finalUrl.search === "";
          if (!redirectOnlyDroppedQuery) {
            window.history.replaceState(
              {},
              "",
              finalUrl.pathname + finalUrl.search + finalUrl.hash,
            );
            _lastPathnameAndSearch = window.location.pathname + window.location.search;
          }
        }
      } catch {
        // Ignore malformed redirect URLs and continue with the fetched response.
      }
    }

    if (!res.ok && res.status !== 404) {
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

    // Extract __NEXT_DATA__ from the HTML. i18n pages append vinext locale
    // globals in the same inline script after the JSON assignment.
    const match = html.match(
      /<script(?:\s[^>]*)?>window\.__NEXT_DATA__\s*=\s*([\s\S]*?)<\/script>/,
    );
    if (!match) {
      if (res.status === 404) {
        options.beforeRender?.();
        renderPagesNotFound(root);
        return;
      }
      scheduleHardNavigationAndThrow(url, "Navigation failed: missing __NEXT_DATA__ in response");
    }

    let nextDataJson = match[1].trim();
    const localeGlobalsIndex = nextDataJson.indexOf(";window.__VINEXT_");
    if (localeGlobalsIndex !== -1) {
      nextDataJson = nextDataJson.slice(0, localeGlobalsIndex);
    }
    const nextData = JSON.parse(nextDataJson);
    const { pageProps, ...appProps } = nextData.props;
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
        ...appProps,
      });
    } else {
      element = React.createElement(PageComponent, pageProps);
    }

    // Commit __NEXT_DATA__ only after all assertStillCurrent() checks have passed,
    // so a stale navigation can never pollute the global. Commit before
    // wrapWithRouterContext() so the new router value sees fresh route/query data.
    // INVARIANT: Everything after the final assertStillCurrent() above (the
    // checkpoint immediately after the optional _app import) through
    // root.render() is synchronous. If any step here ever becomes async, add
    // another assertStillCurrent() before writing __NEXT_DATA__.
    window.__NEXT_DATA__ = nextData;
    syncI18nGlobalsFromNextData(nextData);

    // Wrap with RouterContext.Provider so next/compat/router works
    element = wrapWithRouterContext(element);

    options.beforeRender?.();
    await renderPagesRoot(root, element);
  })();
  _activeNavigationPromise = navigationPromise;

  try {
    await navigationPromise;
  } finally {
    // Clean up the abort controller if this navigation is still the active one
    if (navId === _navigationId) {
      _activeAbortController = null;
      _activeNavigationUrl = null;
      _activeNavigationPromise = null;
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
  options: { allowErrorPageData?: boolean; beforeRender?: () => void } = {},
): Promise<"completed" | "cancelled" | "failed"> {
  try {
    await navigateClient(fullUrl, options);
    return "completed";
  } catch (err: unknown) {
    const alreadyEmittedCancellation =
      err instanceof NavigationCancelledError && _preEmittedCancelledUrls.delete(fullUrl);
    if (!alreadyEmittedCancellation) {
      routerEvents.emit("routeChangeError", err, toRouterEventUrl(resolvedUrl), { shallow: false });
    }
    if (err instanceof NavigationCancelledError) {
      return "cancelled";
    }
    // Genuine error (network, parse, import failure): fall back to a hard
    // navigation so the browser lands on the correct page. Known failure modes
    // throw HardNavigationScheduledError, and this guard skips those; only
    // unexpected failures (parse, import, render) need recovery here.
    if (
      typeof window !== "undefined" &&
      !(err instanceof HardNavigationScheduledError) &&
      !(err instanceof Error && err.message === "Failed to load static props")
    ) {
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
    isFallback:
      typeof window === "undefined"
        ? _ssrState?.isFallback === true
        : nextData?.isFallback === true,
    ...methods,
    sdc: {},
    events: routerEvents,
  };
}

/**
 * useRouter hook - Pages Router compatible.
 */
let _hasHydratedPagesRouter = false;

export function useRouter(): NextRouter {
  const contextRouter = useContext(RouterContext);
  const [{ pathname, query, asPath }, setState] = useState(() =>
    _hasHydratedPagesRouter ? getPathnameAndQuery() : getHydrationPathnameAndQuery(),
  );

  // Popstate is handled by the module-level listener below so beforePopState()
  // is consistently enforced even when multiple components mount useRouter().
  useEffect(() => {
    // Hydration should start from the SSR snapshot, but Pages Router query
    // values derived from window.location.search become authoritative once the
    // client router is mounted.
    _hasHydratedPagesRouter = true;
    setState(getPathnameAndQuery());
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
      if (shouldHardNavigateManualBasePathTarget(resolved)) {
        window.location.href = full;
        return true;
      }
      const { routeFull, allowErrorPageData } = resolveNavigationRouteFetch(
        url,
        as,
        options?.locale,
        full,
      );
      const eventUrl = toRouterEventUrl(full);
      const stateUrl =
        as !== undefined ? resolveNavigationRouteTarget(url, options?.locale) : resolved;
      const historyState = createPagesHistoryState(stateUrl, resolved, options);

      // Hash-only change — no page fetch needed
      if (isHashOnlyChange(full)) {
        const hashEventUrl = resolveHashUrl(full);
        routerEvents.emit("hashChangeStart", hashEventUrl, {
          shallow: options?.shallow ?? false,
        });
        const hash = resolved.includes("#") ? resolved.slice(resolved.indexOf("#")) : "";
        saveScrollPosition();
        window.history.pushState(historyState, "", resolved.startsWith("#") ? resolved : full);
        _historyKey = historyState.key ?? _historyKey;
        _lastPathnameAndSearch = window.location.pathname + window.location.search;
        scrollToHash(hash);
        setState(getPathnameAndQuery());
        routerEvents.emit("hashChangeComplete", hashEventUrl, {
          shallow: options?.shallow ?? false,
        });
        dispatchVinextNavigate();
        return true;
      }

      saveScrollPosition();
      emitActiveNavigationCancelled();
      routerEvents.emit("routeChangeStart", eventUrl, { shallow: options?.shallow ?? false });
      if (options?.shallow) {
        commitPushNavigationHistory(historyState, full, routeFull, as !== undefined);
        setState(getPathnameAndQuery());
        routerEvents.emit("beforeHistoryChange", eventUrl, { shallow: true });
        routerEvents.emit("routeChangeComplete", eventUrl, { shallow: true });
      } else {
        const committedBeforeFetch = shouldCommitQueryNavigationBeforeFetch(full);
        if (committedBeforeFetch) {
          commitPushNavigationHistory(historyState, full, routeFull, as !== undefined);
        }
        const previousBrowserUrl = getCurrentBrowserPathSearchHash();
        let completedBeforeRender = false;
        const completeBeforeRender = () => {
          if (completedBeforeRender) return;
          completedBeforeRender = true;
          if (!committedBeforeFetch && getCurrentBrowserPathSearchHash() === previousBrowserUrl) {
            commitPushNavigationHistory(historyState, full, routeFull, as !== undefined);
          } else {
            syncHistoryTrackingFromCurrent();
          }
          preserveTargetSearchIfRewriteDroppedIt(full);
          setState(getPathnameAndQuery());
          routerEvents.emit("beforeHistoryChange", eventUrl, {
            shallow: options?.shallow ?? false,
          });
          routerEvents.emit("routeChangeComplete", eventUrl, {
            shallow: options?.shallow ?? false,
          });
        };
        _pendingNavigationBrowserUrl = full;
        const result = await runNavigateClient(routeFull, eventUrl, {
          allowErrorPageData,
          beforeRender: completeBeforeRender,
        });
        if (_pendingNavigationBrowserUrl === full) {
          _pendingNavigationBrowserUrl = null;
        }
        if (result === "cancelled") return true;
        if (result === "failed") return false;
        if (!completedBeforeRender) {
          completeBeforeRender();
        }
      }

      // Scroll: handle hash target, else scroll to top unless scroll:false
      const hash = resolved.includes("#") ? resolved.slice(resolved.indexOf("#")) : "";
      if (hash) {
        scrollToHash(hash);
      } else if (options?.scroll !== false) {
        window.scrollTo(0, 0);
      }
      dispatchVinextNavigate();
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
      if (shouldHardNavigateManualBasePathTarget(resolved)) {
        window.location.replace(full);
        return true;
      }
      const { routeFull, allowErrorPageData } = resolveNavigationRouteFetch(
        url,
        as,
        options?.locale,
        full,
      );
      const eventUrl = toRouterEventUrl(full);
      const stateUrl =
        as !== undefined ? resolveNavigationRouteTarget(url, options?.locale) : resolved;
      const historyState = createPagesHistoryState(stateUrl, resolved, options, _historyKey);

      // Hash-only change — no page fetch needed
      if (isHashOnlyChange(full)) {
        const hashEventUrl = resolveHashUrl(full);
        routerEvents.emit("hashChangeStart", hashEventUrl, {
          shallow: options?.shallow ?? false,
        });
        const hash = resolved.includes("#") ? resolved.slice(resolved.indexOf("#")) : "";
        window.history.replaceState(historyState, "", resolved.startsWith("#") ? resolved : full);
        _historyKey = historyState.key ?? _historyKey;
        _lastPathnameAndSearch = window.location.pathname + window.location.search;
        scrollToHash(hash);
        setState(getPathnameAndQuery());
        routerEvents.emit("hashChangeComplete", hashEventUrl, {
          shallow: options?.shallow ?? false,
        });
        dispatchVinextNavigate();
        return true;
      }

      emitActiveNavigationCancelled();
      routerEvents.emit("routeChangeStart", eventUrl, { shallow: options?.shallow ?? false });
      if (options?.shallow) {
        commitReplaceNavigationHistory(historyState, full);
        setState(getPathnameAndQuery());
        routerEvents.emit("beforeHistoryChange", eventUrl, { shallow: true });
        routerEvents.emit("routeChangeComplete", eventUrl, { shallow: true });
      } else {
        const committedBeforeFetch = shouldCommitQueryNavigationBeforeFetch(full);
        if (committedBeforeFetch) {
          commitReplaceNavigationHistory(historyState, full);
        }
        const previousBrowserUrl = getCurrentBrowserPathSearchHash();
        let completedBeforeRender = false;
        const completeBeforeRender = () => {
          if (completedBeforeRender) return;
          completedBeforeRender = true;
          if (!committedBeforeFetch && getCurrentBrowserPathSearchHash() === previousBrowserUrl) {
            commitReplaceNavigationHistory(historyState, full);
          } else {
            syncHistoryTrackingFromCurrent();
          }
          preserveTargetSearchIfRewriteDroppedIt(full);
          setState(getPathnameAndQuery());
          routerEvents.emit("beforeHistoryChange", eventUrl, {
            shallow: options?.shallow ?? false,
          });
          routerEvents.emit("routeChangeComplete", eventUrl, {
            shallow: options?.shallow ?? false,
          });
        };
        _pendingNavigationBrowserUrl = full;
        const result = await runNavigateClient(routeFull, eventUrl, {
          allowErrorPageData,
          beforeRender: completeBeforeRender,
        });
        if (_pendingNavigationBrowserUrl === full) {
          _pendingNavigationBrowserUrl = null;
        }
        if (result === "cancelled") return true;
        if (result === "failed") return false;
        if (!completedBeforeRender) {
          completeBeforeRender();
        }
      }

      // Scroll: handle hash target, else scroll to top unless scroll:false
      const hash = resolved.includes("#") ? resolved.slice(resolved.indexOf("#")) : "";
      if (hash) {
        scrollToHash(hash);
      } else if (options?.scroll !== false) {
        window.scrollTo(0, 0);
      }
      dispatchVinextNavigate();
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
      link.href = new URL(url, window.location.href).href;
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

  return typeof window === "undefined" && contextRouter ? contextRouter : router;
}

type WithRouterComponent<P> = ComponentType<P> & {
  getInitialProps?: unknown;
  origGetInitialProps?: unknown;
};

export function withRouter<P extends { router: NextRouter }>(
  ComposedComponent: WithRouterComponent<P>,
): WithRouterComponent<Omit<P, "router">> {
  function WithRouterWrapper(props: Omit<P, "router">) {
    const router = useRouter();
    return createElement(ComposedComponent, { ...(props as P), router });
  }

  const displayName = ComposedComponent.displayName || ComposedComponent.name || "Component";
  WithRouterWrapper.displayName = `withRouter(${displayName})`;

  const WrappedComponent = WithRouterWrapper as WithRouterComponent<Omit<P, "router">>;
  if (ComposedComponent.getInitialProps) {
    WrappedComponent.getInitialProps = ComposedComponent.getInitialProps;
  }
  if (ComposedComponent.origGetInitialProps) {
    WrappedComponent.origGetInitialProps = ComposedComponent.origGetInitialProps;
  }

  return WrappedComponent;
}

// beforePopState callback: called before handling browser back/forward.
// If it returns false, the navigation is cancelled.
let _beforePopStateCb: BeforePopStateCallback | undefined;

// Track pathname+search for detecting hash-only back/forward in the popstate
// handler. Updated after every pushState/replaceState so that popstate can
// compare the previous value with the (already-changed) window.location.
let _lastPathnameAndSearch =
  typeof window !== "undefined" ? window.location.pathname + window.location.search : "";
let _lastIgnoredStalePopstate: string | null = null;
let _isFirstPagesPopStateEvent = true;

type NextHistoryState = {
  url?: string;
  as?: string;
  options?: { shallow?: boolean; locale?: string };
  key?: string;
  __N?: boolean;
  __NA?: boolean;
};

function createPagesHistoryState(
  url: string,
  as: string,
  options?: TransitionOptions,
  key = createKey(),
): NextHistoryState {
  return {
    url,
    as,
    options: {
      shallow: options?.shallow ?? false,
      locale: options?.locale,
    },
    key,
    __N: true,
  };
}

function getLocaleStrippedCurrentAsPath(): string {
  const appPathname = stripBasePath(window.location.pathname, __basePath);
  return (
    stripLocaleFromAppPathAndSearch(appPathname + window.location.search) + window.location.hash
  );
}

function stripLocaleFromAppPathAndSearch(pathAndSearch: string): string {
  const [pathnamePart, searchPart = ""] = pathAndSearch.split("?", 2);
  const locales = window.__VINEXT_LOCALES__ ?? [];
  const firstSegment = pathnamePart.split("/").filter(Boolean)[0];
  const pathname =
    firstSegment && locales.includes(firstSegment)
      ? pathnamePart.slice(firstSegment.length + 1) || "/"
      : pathnamePart;
  return `${pathname}${searchPart ? `?${searchPart}` : ""}`;
}

function getCurrentAppUrl(): string {
  return stripBasePath(window.location.pathname, __basePath) + window.location.search;
}

function getPathnameAndSearch(href: string): string {
  const url = new URL(href, window.location.href);
  return url.pathname + url.search;
}

function getAppPathnameAndSearch(href: string): string {
  const url = new URL(href, window.location.href);
  return stripBasePath(url.pathname, __basePath) + url.search;
}

function getCurrentLocaleStrippedPathAndSearch(): string {
  const asPath = getLocaleStrippedCurrentAsPath();
  const hashIndex = asPath.indexOf("#");
  return hashIndex === -1 ? asPath : asPath.slice(0, hashIndex);
}

function ensureInitialPagesHistoryState(): void {
  const state = window.history.state as NextHistoryState | null;
  if (state?.__N && typeof state.key === "string") {
    _historyKey = state.key;
    return;
  }

  const appUrl = getCurrentAppUrl();
  window.history.replaceState(
    {
      ...state,
      ...createPagesHistoryState(
        appUrl,
        getLocaleStrippedCurrentAsPath(),
        {
          locale: window.__VINEXT_LOCALE__,
        },
        _historyKey,
      ),
    },
    "",
  );
}

// Module-level popstate listener: handles browser back/forward by re-rendering
// the React root with the page at the new URL. This runs regardless of whether
// any component calls useRouter().
if (typeof window !== "undefined" && window.history) {
  ensureInitialPagesHistoryState();
  if (manualScrollRestoration) {
    window.history.scrollRestoration = "manual";
  }

  window.addEventListener("pageshow", (event: PageTransitionEvent) => {
    const pageShowState = window.history.state as NextHistoryState | null;
    if (pageShowState?.__N && typeof pageShowState.key === "string") {
      _historyKey = pageShowState.key;
    }

    const currentUrl = window.location.pathname + window.location.search + window.location.hash;
    const state = window.history.state as { __vinext_restore_url?: unknown } | null;
    if (!event.persisted && state?.__vinext_restore_url !== currentUrl) return;
    if (state && "__vinext_restore_url" in state) {
      const { __vinext_restore_url: _restoreUrl, ...nextState } = state;
      window.history.replaceState(nextState, "");
    }

    const browserUrl = window.location.pathname + window.location.search;
    const appUrl = stripBasePath(window.location.pathname, __basePath) + window.location.search;
    _lastPathnameAndSearch = browserUrl;

    const fullAppUrl = appUrl + window.location.hash;
    void (async () => {
      const result = await runNavigateClient(browserUrl, fullAppUrl);
      if (result === "completed") {
        dispatchVinextNavigate();
      }
    })();
  });

  window.addEventListener("popstate", (e: PopStateEvent) => {
    if (typeof window.__VINEXT_RSC_NAVIGATE__ === "function") {
      return;
    }

    const isFirstPopStateEvent = _isFirstPagesPopStateEvent;
    _isFirstPagesPopStateEvent = false;

    const state = e.state as NextHistoryState | null;

    if (state?.__NA) {
      window.location.reload();
      return;
    }

    if (state?.__N) {
      const stateUrl = state.url ?? window.location.pathname + window.location.search;
      const stateAs = state.as ?? stateUrl;
      const stateOptions = state.options ?? {};
      let forcedScroll: { x: number; y: number } | null = null;
      if (manualScrollRestoration && typeof state.key === "string" && _historyKey !== state.key) {
        saveScrollPositionToSession(_historyKey);
        forcedScroll = readScrollPositionFromSession(state.key) ?? { x: 0, y: 0 };
      }
      if (typeof state.key === "string") {
        _historyKey = state.key;
      }

      if (_beforePopStateCb !== undefined) {
        const shouldContinue = (_beforePopStateCb as BeforePopStateCallback)({
          url: stateUrl,
          as: stateAs,
          options: { shallow: stateOptions.shallow ?? false },
        });
        if (!shouldContinue) return;
      }

      const fullStateUrl = toBrowserNavigationHref(stateUrl, window.location.href, __basePath);
      const browserPathAndSearch = window.location.pathname + window.location.search;
      const stateBrowserPathAndSearch = getPathnameAndSearch(fullStateUrl);
      const stateAppPathAndSearch = getAppPathnameAndSearch(fullStateUrl);
      const stateAsPathAndSearch = getPathnameAndSearch(stateAs);
      const currentAsPathAndSearch = getCurrentLocaleStrippedPathAndSearch();
      const localeMatchesCurrent =
        stateOptions.locale === undefined || stateOptions.locale === window.__VINEXT_LOCALE__;
      const staleSameVisibleRoute =
        isFirstPopStateEvent &&
        localeMatchesCurrent &&
        stateAsPathAndSearch === currentAsPathAndSearch &&
        stateAppPathAndSearch !== currentAsPathAndSearch;

      if (staleSameVisibleRoute) {
        const staleKey = `${stateOptions.locale ?? ""}:${stateBrowserPathAndSearch}:${stateAsPathAndSearch}`;
        if (_lastIgnoredStalePopstate !== staleKey) {
          _lastIgnoredStalePopstate = staleKey;
          restoreScrollPosition(e.state, forcedScroll);
          return;
        }
      } else {
        _lastIgnoredStalePopstate = null;
      }

      if (
        browserPathAndSearch === _lastPathnameAndSearch &&
        stateBrowserPathAndSearch === browserPathAndSearch
      ) {
        const hashUrl = stripBasePath(browserPathAndSearch, __basePath) + window.location.hash;
        routerEvents.emit("hashChangeStart", hashUrl, { shallow: false });
        scrollToHash(window.location.hash);
        routerEvents.emit("hashChangeComplete", hashUrl, { shallow: false });
        restoreScrollPosition(e.state, forcedScroll);
        dispatchVinextNavigate();
        return;
      }
      _lastIgnoredStalePopstate = null;
      _lastPathnameAndSearch = browserPathAndSearch;
      routerEvents.emit("routeChangeStart", stateAs, { shallow: stateOptions.shallow ?? false });
      routerEvents.emit("beforeHistoryChange", stateAs, {
        shallow: stateOptions.shallow ?? false,
      });
      void (async () => {
        const result = await runNavigateClient(fullStateUrl, stateAs);
        if (result === "completed") {
          routerEvents.emit("routeChangeComplete", stateAs, {
            shallow: stateOptions.shallow ?? false,
          });
          restoreScrollPosition(e.state, forcedScroll);
          dispatchVinextNavigate();
        }
      })();
      return;
    }

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
      dispatchVinextNavigate();
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
        dispatchVinextNavigate();
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

function noRouter(): never {
  throw new Error(
    'No router instance found. you should only use "next/router" inside the client side of your app. https://nextjs.org/docs/messages/no-router-instance',
  );
}

function assertClientRouter(): void {
  if (typeof window === "undefined") noRouter();
}

// Also export a default Router singleton for `import Router from 'next/router'`
const Router: NextRouterSingleton = {
  get pathname() {
    return getPathnameAndQuery().pathname;
  },
  get route() {
    return typeof window !== "undefined"
      ? (window.__NEXT_DATA__?.page ?? this.pathname)
      : this.pathname;
  },
  get query() {
    return getPathnameAndQuery().query;
  },
  get asPath() {
    return getPathnameAndQuery().asPath;
  },
  get basePath() {
    return __basePath;
  },
  get locale() {
    return typeof window !== "undefined" ? window.__VINEXT_LOCALE__ : _getSSRContext()?.locale;
  },
  get locales() {
    return typeof window !== "undefined" ? window.__VINEXT_LOCALES__ : _getSSRContext()?.locales;
  },
  get defaultLocale() {
    return typeof window !== "undefined"
      ? window.__VINEXT_DEFAULT_LOCALE__
      : _getSSRContext()?.defaultLocale;
  },
  get domainLocales() {
    return typeof window !== "undefined"
      ? window.__NEXT_DATA__?.domainLocales
      : _getSSRContext()?.domainLocales;
  },
  isReady: true,
  isPreview: false,
  get isFallback() {
    return typeof window !== "undefined" && window.__NEXT_DATA__?.isFallback === true;
  },
  push: (url: string | UrlObject, as?: string, options?: TransitionOptions) => {
    assertClientRouter();
    return (async () => {
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
      if (shouldHardNavigateManualBasePathTarget(resolved)) {
        window.location.href = full;
        return true;
      }
      const { routeFull, allowErrorPageData } = resolveNavigationRouteFetch(
        url,
        as,
        options?.locale,
        full,
      );
      const eventUrl = toRouterEventUrl(full);
      const stateUrl =
        as !== undefined ? resolveNavigationRouteTarget(url, options?.locale) : resolved;
      const historyState = createPagesHistoryState(stateUrl, resolved, options);

      // Hash-only change
      if (isHashOnlyChange(full)) {
        const hashEventUrl = resolveHashUrl(full);
        routerEvents.emit("hashChangeStart", hashEventUrl, {
          shallow: options?.shallow ?? false,
        });
        const hash = resolved.includes("#") ? resolved.slice(resolved.indexOf("#")) : "";
        saveScrollPosition();
        window.history.pushState(historyState, "", resolved.startsWith("#") ? resolved : full);
        _historyKey = historyState.key ?? _historyKey;
        _lastPathnameAndSearch = window.location.pathname + window.location.search;
        scrollToHash(hash);
        routerEvents.emit("hashChangeComplete", hashEventUrl, {
          shallow: options?.shallow ?? false,
        });
        dispatchVinextNavigate();
        return true;
      }

      saveScrollPosition();
      emitActiveNavigationCancelled();
      routerEvents.emit("routeChangeStart", eventUrl, { shallow: options?.shallow ?? false });
      if (options?.shallow) {
        commitPushNavigationHistory(historyState, full, routeFull, as !== undefined);
        routerEvents.emit("beforeHistoryChange", eventUrl, { shallow: true });
        routerEvents.emit("routeChangeComplete", eventUrl, { shallow: true });
      } else {
        const committedBeforeFetch = shouldCommitQueryNavigationBeforeFetch(full);
        if (committedBeforeFetch) {
          commitPushNavigationHistory(historyState, full, routeFull, as !== undefined);
        }
        const previousBrowserUrl = getCurrentBrowserPathSearchHash();
        let completedBeforeRender = false;
        const completeBeforeRender = () => {
          if (completedBeforeRender) return;
          completedBeforeRender = true;
          if (!committedBeforeFetch && getCurrentBrowserPathSearchHash() === previousBrowserUrl) {
            commitPushNavigationHistory(historyState, full, routeFull, as !== undefined);
          } else {
            syncHistoryTrackingFromCurrent();
          }
          preserveTargetSearchIfRewriteDroppedIt(full);
          routerEvents.emit("beforeHistoryChange", eventUrl, {
            shallow: options?.shallow ?? false,
          });
          routerEvents.emit("routeChangeComplete", eventUrl, {
            shallow: options?.shallow ?? false,
          });
        };
        _pendingNavigationBrowserUrl = full;
        const result = await runNavigateClient(routeFull, eventUrl, {
          allowErrorPageData,
          beforeRender: completeBeforeRender,
        });
        if (_pendingNavigationBrowserUrl === full) {
          _pendingNavigationBrowserUrl = null;
        }
        if (result === "cancelled") return true;
        if (result === "failed") return false;
        if (!completedBeforeRender) {
          completeBeforeRender();
        }
      }

      const hash = resolved.includes("#") ? resolved.slice(resolved.indexOf("#")) : "";
      if (hash) {
        scrollToHash(hash);
      } else if (options?.scroll !== false) {
        window.scrollTo(0, 0);
      }
      dispatchVinextNavigate();
      return true;
    })();
  },
  replace: (url: string | UrlObject, as?: string, options?: TransitionOptions) => {
    assertClientRouter();
    return (async () => {
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
      if (shouldHardNavigateManualBasePathTarget(resolved)) {
        window.location.replace(full);
        return true;
      }
      const { routeFull, allowErrorPageData } = resolveNavigationRouteFetch(
        url,
        as,
        options?.locale,
        full,
      );
      const eventUrl = toRouterEventUrl(full);
      const stateUrl =
        as !== undefined ? resolveNavigationRouteTarget(url, options?.locale) : resolved;
      const historyState = createPagesHistoryState(stateUrl, resolved, options, _historyKey);

      // Hash-only change
      if (isHashOnlyChange(full)) {
        const hashEventUrl = resolveHashUrl(full);
        routerEvents.emit("hashChangeStart", hashEventUrl, {
          shallow: options?.shallow ?? false,
        });
        const hash = resolved.includes("#") ? resolved.slice(resolved.indexOf("#")) : "";
        window.history.replaceState(historyState, "", resolved.startsWith("#") ? resolved : full);
        _historyKey = historyState.key ?? _historyKey;
        _lastPathnameAndSearch = window.location.pathname + window.location.search;
        scrollToHash(hash);
        routerEvents.emit("hashChangeComplete", hashEventUrl, {
          shallow: options?.shallow ?? false,
        });
        dispatchVinextNavigate();
        return true;
      }

      emitActiveNavigationCancelled();
      routerEvents.emit("routeChangeStart", eventUrl, { shallow: options?.shallow ?? false });
      if (options?.shallow) {
        commitReplaceNavigationHistory(historyState, full);
        routerEvents.emit("beforeHistoryChange", eventUrl, { shallow: true });
        routerEvents.emit("routeChangeComplete", eventUrl, { shallow: true });
      } else {
        const committedBeforeFetch = shouldCommitQueryNavigationBeforeFetch(full);
        if (committedBeforeFetch) {
          commitReplaceNavigationHistory(historyState, full);
        }
        const previousBrowserUrl = getCurrentBrowserPathSearchHash();
        let completedBeforeRender = false;
        const completeBeforeRender = () => {
          if (completedBeforeRender) return;
          completedBeforeRender = true;
          if (!committedBeforeFetch && getCurrentBrowserPathSearchHash() === previousBrowserUrl) {
            commitReplaceNavigationHistory(historyState, full);
          } else {
            syncHistoryTrackingFromCurrent();
          }
          preserveTargetSearchIfRewriteDroppedIt(full);
          routerEvents.emit("beforeHistoryChange", eventUrl, {
            shallow: options?.shallow ?? false,
          });
          routerEvents.emit("routeChangeComplete", eventUrl, {
            shallow: options?.shallow ?? false,
          });
        };
        _pendingNavigationBrowserUrl = full;
        const result = await runNavigateClient(routeFull, eventUrl, {
          allowErrorPageData,
          beforeRender: completeBeforeRender,
        });
        if (_pendingNavigationBrowserUrl === full) {
          _pendingNavigationBrowserUrl = null;
        }
        if (result === "cancelled") return true;
        if (result === "failed") return false;
        if (!completedBeforeRender) {
          completeBeforeRender();
        }
      }

      const hash = resolved.includes("#") ? resolved.slice(resolved.indexOf("#")) : "";
      if (hash) {
        scrollToHash(hash);
      } else if (options?.scroll !== false) {
        window.scrollTo(0, 0);
      }
      dispatchVinextNavigate();
      return true;
    })();
  },
  back: () => {
    assertClientRouter();
    window.history.back();
  },
  reload: () => {
    assertClientRouter();
    window.location.reload();
  },
  prefetch: (url: string) => {
    assertClientRouter();
    return (async () => {
      if (typeof document !== "undefined") {
        const link = document.createElement("link");
        link.rel = "prefetch";
        link.href = new URL(url, window.location.href).href;
        link.as = "document";
        document.head.appendChild(link);
      }
    })();
  },
  beforePopState: (cb: BeforePopStateCallback) => {
    assertClientRouter();
    _beforePopStateCb = cb;
  },
  sdc: {},
  events: routerEvents,
};

singletonRouter = Router;

if (typeof window !== "undefined") {
  window.next ??= {};
  window.next.router = Router;
}

export default Router;
