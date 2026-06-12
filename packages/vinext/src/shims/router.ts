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
  useLayoutEffect,
  Fragment,
  Component,
  createElement,
  type ReactElement,
  type ReactNode,
  type ComponentType,
} from "react";
import { AppRouterContext, type AppRouterInstance } from "./internal/app-router-context.js";
import { RouterContext } from "./internal/router-context.js";
import {
  applyVinextLocaleGlobals,
  extractVinextNextDataJson,
  parseVinextNextDataJson,
  type VinextNextData,
} from "../client/vinext-next-data.js";
import { isValidModulePath } from "../client/validate-module-path.js";
import {
  prefetchPagesData,
  resolvePagesDataNavigationTarget,
  type PagesDataTarget,
} from "./internal/pages-data-target.js";
import { buildPagesDataHref } from "./internal/pages-data-url.js";
import {
  getPagesRouterComponentsMap,
  markAppRouteDetectedOnPrefetch,
} from "./internal/app-route-detection.js";
import { dedupedPagesDataFetch } from "./internal/pages-data-fetch-dedup.js";
import { installWindowNext, type PagesRouterPublicInstance } from "../client/window-next.js";
import { isUnknownRecord } from "../utils/record.js";
import { splitPathSegments } from "../routing/utils.js";
import {
  isAbsoluteOrProtocolRelativeUrl,
  isHashOnlyBrowserUrlChange,
  normalizePathTrailingSlash,
  toBrowserNavigationHref,
  toSameOriginAppPath,
  getWindowOrigin,
  withBasePath,
} from "./url-utils.js";
import { stripBasePath, removeTrailingSlash } from "../utils/base-path.js";
import {
  addLocalePrefix,
  getDomainLocaleUrl,
  getLocalePathPrefix,
  type DomainLocale,
} from "../utils/domain-locale.js";
import {
  addQueryParam,
  appendSearchParamsToUrl,
  mergeRouteParamsIntoQuery,
  parseQueryString,
  type UrlQuery,
  urlQueryToSearchParams,
} from "../utils/query.js";
import { matchRoutePattern, routePatternParts } from "../routing/route-pattern.js";
import { scrollToHashTarget } from "./hash-scroll.js";
import {
  installPagesRouterRuntime,
  setPagesRouterPopStateHandler,
  setStampInitialHistoryState,
} from "./pages-router-runtime.js";
import { assertSafeNavigationUrl } from "./url-safety.js";
import { getCurrentBrowserLocale } from "./client-locale.js";

/** basePath from next.config.js, injected by the plugin at build time */
const __basePath: string = process.env.__NEXT_ROUTER_BASEPATH ?? "";
/** trailingSlash from next.config.js, injected by the plugin at build time */
const __trailingSlash: boolean = process.env.__VINEXT_TRAILING_SLASH === "true";
/** experimental.scrollRestoration from next.config.js, injected by the plugin at build time */
const __scrollRestoration: boolean = process.env.__NEXT_SCROLL_RESTORATION === "true";

type ScrollPosition = { x: number; y: number };
const noopCommit = (): void => {};

/**
 * A version of useLayoutEffect that doesn't warn during SSR.
 * `wrapWithRouterContext` is shared with the server-side Pages Router render
 * path, where a raw useLayoutEffect would log React's "useLayoutEffect does
 * nothing on the server" warning on every render. Same pattern as
 * `shims/image.tsx`; Next.js only runs the commit callback on the client.
 */
const useNonWarningLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

class PagesRouterCommitBoundary extends Component<{
  children?: ReactNode;
  onCommit: () => void;
  onError: (error: Error) => void;
}> {
  componentDidCatch(error: Error) {
    this.props.onError(error);
  }

  render() {
    return createElement(
      PagesRouterCommitBoundaryHelper,
      { onCommit: this.props.onCommit },
      this.props.children,
    );
  }
}

function PagesRouterCommitBoundaryHelper({
  children,
  onCommit,
}: {
  children?: ReactNode;
  onCommit: () => void;
}): ReactElement {
  useNonWarningLayoutEffect(() => {
    onCommit();
  }, [onCommit]);

  return createElement(Fragment, null, children);
}

function renderPagesRouterElement(
  element: ReactElement,
  scroll?: ScrollPosition | null,
): Promise<void> {
  const root = window.__VINEXT_ROOT__;
  if (!root) {
    return Promise.resolve();
  }

  cancelPreviousRenderCommit();

  return new Promise<void>((resolve, reject) => {
    const cancel = () => {
      if (_cancelPendingRenderCommit === cancel) _cancelPendingRenderCommit = null;
      reject(new NavigationCancelledError("superseded"));
    };
    _cancelPendingRenderCommit = cancel;

    // Only clear the module-level canceller if it still belongs to this
    // render; a superseded tree can commit late and must not null out the
    // canceller installed by a newer navigation.
    const clearIfCurrent = () => {
      if (_cancelPendingRenderCommit === cancel) _cancelPendingRenderCommit = null;
    };

    const scrollHandler = () => {
      if (scroll) {
        window.scrollTo(scroll.x, scroll.y);
      }
    };

    root.render(
      wrapWithRouterContext(
        element,
        () => {
          clearIfCurrent();
          try {
            scrollHandler();
            resolve();
          } catch (err) {
            reject(err);
          }
        },
        (error) => {
          clearIfCurrent();
          reject(error);
        },
      ),
    );
    if (typeof document === "undefined") {
      clearIfCurrent();
      resolve();
    }
  });
}

function canUseSessionStorageForScrollRestoration(): boolean {
  if (typeof window === "undefined") return false;

  try {
    const key = "__next";
    window.sessionStorage.setItem(key, key);
    window.sessionStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

// The `experimental.scrollRestoration` manual opt-in is Pages-Router-only.
// Next.js sets `history.scrollRestoration = "manual"` inside the Router
// class constructor (.nextjs-ref/packages/next/src/shared/lib/router/
// router.ts around L892), which only runs when client/index.tsx hydrates a
// Pages Router document — a bare value import of next/router never flips
// it, and App Router owns its own scroll behavior. The vinext shim installs
// at module eval instead, so an App Router app that value-imports
// next/router for compat would otherwise disable the browser's native
// restoration. The App Router bootstrap stamps `window.next.appDir = true`
// at entry eval, before any client-component module (and therefore this
// shim) can evaluate, so it is a reliable router-mode gate even though this
// constant is computed at module eval. Folding the check into the constant
// (rather than only into installManualScrollRestoration) keeps every
// consumer Pages-Router-only — including the popstate handler's
// sessionStorage save/read branches, which would otherwise rely solely on
// the `__N: true` state filter to stay inert on App Router documents.
const manualScrollRestoration =
  __scrollRestoration &&
  typeof window !== "undefined" &&
  window.next?.appDir !== true &&
  "scrollRestoration" in window.history &&
  canUseSessionStorageForScrollRestoration();

function installManualScrollRestoration(): void {
  if (manualScrollRestoration) {
    window.history.scrollRestoration = "manual";
  }
}

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
 * Pages error routes are handled as a narrow exception below because Next.js
 * treats their href as the component route while preserving `as` in history.
 */
function resolveNavigationTarget(
  url: string | UrlObject,
  as: string | undefined,
  locale: string | undefined,
): string {
  return applyNavigationLocale(as ?? resolveUrl(url), locale);
}

function getCurrentUrlLocale(): string | undefined {
  return getCurrentBrowserLocale({
    basePath: __basePath,
    domainLocales: getDomainLocales(),
    hostname: getCurrentHostname(),
  });
}

function getLocalPathname(url: string): string | null {
  if (typeof window === "undefined") return null;
  if (isAbsoluteOrProtocolRelativeUrl(url)) {
    const localPath = toSameOriginAppPath(url, __basePath);
    if (localPath == null) return null;
    return stripBasePath(new URL(localPath, window.location.href).pathname, __basePath);
  }
  try {
    return stripBasePath(new URL(url, window.location.href).pathname, __basePath);
  } catch {
    return null;
  }
}

function resolvePagesErrorHtmlFetchUrl(
  url: string | UrlObject,
  locale: string | undefined,
): string | null {
  const href = resolveUrl(url);
  const errorRoutePathname = getLocalPathname(href);
  if (errorRoutePathname !== "/404" && errorRoutePathname !== "/_error") return null;

  const fetchHref = errorRoutePathname === "/_error" ? replaceUrlPathname(href, "/404") : href;
  const resolvedUrl = applyNavigationLocale(fetchHref, locale);

  let parsed: URL;
  try {
    parsed = new URL(resolvedUrl, window.location.href);
  } catch {
    return null;
  }
  const appPathname = stripBasePath(parsed.pathname, __basePath);
  const fetchTarget = `${appPathname}${parsed.search}${parsed.hash}`;
  return normalizePathTrailingSlash(
    toBrowserNavigationHref(fetchTarget, window.location.href, __basePath),
    __trailingSlash,
  );
}

function replaceUrlPathname(url: string, pathname: string): string {
  try {
    const parsed = new URL(url, window.location.href);
    return `${pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return pathname;
  }
}

function resolveTransitionLocale(locale: TransitionOptions["locale"]): string | undefined {
  if (typeof window === "undefined") return undefined;
  if (locale === false) return window.__VINEXT_DEFAULT_LOCALE__;
  return locale ?? getCurrentUrlLocale();
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

let _currentHistoryKey: string | undefined;

/**
 * Build router-shaped state for the initial document entry. Captures the
 * active locale (from `window.__VINEXT_LOCALE__`) so a back-navigation
 * popstate to this entry can recover its locale instead of falling back to
 * the live window global — the locale may have changed by the time the user
 * navigates back.
 */
function buildInitialRouterState(): VinextHistoryState {
  const appPath = stripBasePath(window.location.pathname, __basePath) + window.location.search;
  const options: { locale?: string; shallow?: boolean } = {};
  if (window.__VINEXT_LOCALE__ !== undefined) options.locale = window.__VINEXT_LOCALE__;
  return {
    url: appPath,
    as: appPath,
    options,
    __N: true,
    key: createHistoryKey(),
  };
}

/**
 * Stamp the initial document entry with router-shaped state (only if no
 * state is present). Called once at runtime install so the entry has a
 * locale stamped before any push could overwrite the active locale global.
 */
function stampInitialHistoryState(): void {
  installManualScrollRestoration();

  if (!window.history) return;

  const existingState = window.history.state;
  if (existingState !== null && existingState !== undefined) {
    _currentHistoryKey = getRouterStateKey(existingState) ?? _currentHistoryKey;
    return;
  }

  const initialState = buildInitialRouterState();
  _currentHistoryKey = initialState.key;
  window.history.replaceState(initialState, "");
}

setStampInitialHistoryState(stampInitialHistoryState);

/** Save current scroll position into history state for back/forward restoration.
 *
 * Merging into the existing state preserves any router-owned fields (`__N`,
 * `url`, `as`, `options`, `key`). If the install-time stamp didn't run
 * (Router.push called before installPagesRouterRuntime), fall back to
 * minting the same shape here so the entry isn't treated as foreign.
 */
function saveScrollPosition(): void {
  const position = getWindowScrollPosition();
  const existing = isUnknownRecord(window.history.state) ? window.history.state : null;
  const scroll = {
    __vinext_scrollX: position.x,
    __vinext_scrollY: position.y,
  };
  const base: Record<string, unknown> = existing ?? buildInitialRouterState();
  const key = getRouterStateKey(base);
  if (key !== undefined) {
    _currentHistoryKey = key;
    saveScrollPositionToSessionStorage(key, position);
  }
  window.history.replaceState({ ...base, ...scroll }, "");
}

function getWindowScrollPosition(): ScrollPosition {
  return { x: window.scrollX, y: window.scrollY };
}

function getScrollStorageKey(historyKey: string): string {
  return `__next_scroll_${historyKey}`;
}

function readScrollPosition(value: unknown): ScrollPosition | null {
  if (!isUnknownRecord(value)) return null;

  const nextX = value.x;
  const nextY = value.y;
  if (typeof nextX === "number" && typeof nextY === "number") {
    return { x: nextX, y: nextY };
  }

  const vinextX = value.__vinext_scrollX;
  const vinextY = value.__vinext_scrollY;
  if (typeof vinextX === "number" && typeof vinextY === "number") {
    return { x: vinextX, y: vinextY };
  }

  return null;
}

function saveScrollPositionToSessionStorage(key: string, position: ScrollPosition): void {
  if (!manualScrollRestoration) return;

  try {
    window.sessionStorage.setItem(getScrollStorageKey(key), JSON.stringify(position));
  } catch {}
}

function readScrollPositionFromSessionStorage(key: string): ScrollPosition | null {
  if (!manualScrollRestoration) return null;

  try {
    const value = window.sessionStorage.getItem(getScrollStorageKey(key));
    if (value === null) return null;
    const parsed: unknown = JSON.parse(value);
    return readScrollPosition(parsed);
  } catch {
    return null;
  }
}

/**
 * SSR context - set by the dev server before rendering each page.
 */
type SSRContext = {
  pathname: string;
  query: Record<string, string | string[]>;
  asPath: string;
  navigationIsReady?: boolean;
  nextData?: VinextNextData;
  locale?: string;
  locales?: string[];
  defaultLocale?: string;
  domainLocales?: VinextNextData["domainLocales"];
  /**
   * True when rendering a `getStaticPaths` fallback shell for a path that
   * hasn't been pre-rendered yet (`fallback: true` + unlisted path). Mirrors
   * `renderContext.isFallback` in Next.js's `render.tsx`: `getStaticProps`
   * is skipped, the page renders with empty props, and `useRouter().isFallback`
   * returns `true` so user code can show a loading state.
   */
  isFallback?: boolean;
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
  pathname: string | null;
  searchParams: URLSearchParams;
  params: Record<string, string | string[]> | null;
};

const PAGES_NAVIGATION_NOTIFY_KEY = Symbol.for("vinext.navigation.pagesNavigationNotify");
type PagesNavigationNotifyGlobal = typeof globalThis & {
  [PAGES_NAVIGATION_NOTIFY_KEY]?: () => void;
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
  isReady: boolean,
  nextData: VinextNextData | undefined,
): PagesNavigationContextShape {
  const cacheKey = `${isReady ? "1" : "0"}|${routePattern}|${resolvedPath}|${searchString}`;
  if (_cachedClientPagesNavCtxKey === cacheKey && _cachedClientPagesNavCtx) {
    return _cachedClientPagesNavCtx;
  }
  const searchParams = isReady ? new URLSearchParams(searchString) : new URLSearchParams();
  // The browser URL is the authoritative source after a Pages client
  // navigation. `__NEXT_DATA__.query` is serialized for the rendered document
  // and can briefly lag behind the committed history URL while navigation
  // listeners publish snapshots, so using it first would leak stale params from
  // the page we just left.
  const params = isReady
    ? (extractRouteParamsFromPath(routePattern, resolvedPath) ??
      getRouteParamsFromQuery(routePattern, nextData?.query ?? {}) ??
      {})
    : null;
  const isAutoExportDynamic =
    nextData?.autoExport === true && extractRouteParamNames(routePattern).length > 0;
  const pathname = resolvePagesNavigationPathname(
    resolvedPath,
    nextData?.isFallback === true,
    isAutoExportDynamic,
    isReady,
  );
  const ctx: PagesNavigationContextShape = { pathname, searchParams, params };
  _cachedClientPagesNavCtx = ctx;
  _cachedClientPagesNavCtxKey = cacheKey;
  return ctx;
}

// Server-side cache for snapshot stability. React's `useSyncExternalStore`
// expects `getServerSnapshot` to return a stable reference within a single
// render so it can use Object.is to decide whether to bail out. The SSR ctx is
// per-request (ALS-isolated), so a WeakMap keyed on the ctx is concurrent-safe
// and lets us reuse the same shape across every hook call in a single render.
//
// Without this, React logs:
//   "The result of getServerSnapshot should be cached to avoid an infinite loop"
// and may re-render until the snapshots stabilize, which is wasteful at best
// and a hydration-mismatch hazard at worst.
const _ssrPagesNavCtxCache = new WeakMap<SSRContext, PagesNavigationContextShape>();

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
    // Reuse the cached shape for this request so React's useSyncExternalStore
    // sees Object.is-equal snapshots across hook calls in the same render.
    // The WeakMap is keyed on the request-scoped ALS ctx, so this remains
    // safe under concurrent SSR (each request has its own ctx).
    const cached = _ssrPagesNavCtxCache.get(ssrCtx);
    if (cached) return cached;
    // ssrCtx.pathname is the route pattern (e.g. "/blog/[slug]").
    // ssrCtx.asPath is the resolved URL with query string. Match the initial
    // Pages Router readiness phase so server HTML and the client hydration
    // snapshot agree before the queued ready notification publishes live values.
    let searchString = "";
    let resolvedPath: string;
    try {
      const url = new URL(ssrCtx.asPath, "http://_");
      searchString = url.search;
      resolvedPath = url.pathname;
    } catch {
      resolvedPath = ssrCtx.pathname;
    }
    const isReady = ssrCtx.navigationIsReady ?? true;
    const searchParams = isReady ? new URLSearchParams(searchString) : new URLSearchParams();
    const params = isReady
      ? (extractRouteParamsFromPath(ssrCtx.pathname, resolvedPath) ??
        getRouteParamsFromQuery(ssrCtx.pathname, ssrCtx.query) ??
        {})
      : null;
    const isAutoExportDynamic =
      ssrCtx.nextData?.autoExport === true && extractRouteParamNames(ssrCtx.pathname).length > 0;
    const pathname = resolvePagesNavigationPathname(
      resolvedPath,
      ssrCtx.isFallback === true,
      isAutoExportDynamic,
      isReady,
    );
    const ctx: PagesNavigationContextShape = { pathname, searchParams, params };
    _ssrPagesNavCtxCache.set(ssrCtx, ctx);
    return ctx;
  }

  // Client: derive from window.location + __NEXT_DATA__ only while the
  // active document is owned by the Pages Router. App Router documents also
  // carry __NEXT_DATA__, so treating that alone as a Pages signal would let
  // compat fallback state shadow App Router navigation snapshots.
  if (!isPagesRouterDocumentActive()) return null;
  const resolvedPath = stripBasePath(window.location.pathname, __basePath);
  const nextData = window.__NEXT_DATA__ as VinextNextData | undefined;
  const pattern = resolvePagesRoutePatternForPath(nextData?.page, resolvedPath);
  if (!pattern) return null;
  return _buildClientPagesNavigationContext(
    pattern,
    resolvedPath,
    window.location.search,
    isPagesRouterReady(),
    nextData,
  );
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

/**
 * Resolve the `pathname` snapshot for the Pages Router navigation context.
 * Shared by the client and SSR branches of `getPagesNavigationContext` so both
 * runtimes derive identical null-ness — diverging here would reintroduce a
 * hydration mismatch. Returns `null` for a `getStaticPaths` fallback shell or a
 * pre-ready auto-export dynamic route (the live path is published once the
 * client router becomes ready).
 */
function resolvePagesNavigationPathname(
  resolvedPath: string,
  isFallback: boolean,
  isAutoExportDynamic: boolean,
  isReady: boolean,
): string | null {
  return isFallback || (isAutoExportDynamic && !isReady) ? null : resolvedPath;
}

// Single-slot memo for the client pattern scan. `window.__VINEXT_PAGE_PATTERNS__`
// is static after load, so the resolved pattern is a pure function of
// (nextDataPage, resolvedPath). Caching avoids an O(routes) scan on every
// useSyncExternalStore snapshot read (getPathname/getSearchParams/getParams),
// which run repeatedly per render. Browser-only (one request at a time).
let _cachedPagesRoutePatternKey: string | null = null;
let _cachedPagesRoutePattern: string | undefined;

function resolvePagesRoutePatternForPath(
  nextDataPage: string | undefined,
  resolvedPath: string,
): string | undefined {
  if (nextDataPage && extractRouteParamNames(nextDataPage).length > 0) {
    return nextDataPage;
  }

  const cacheKey = `${nextDataPage ?? ""}|${resolvedPath}`;
  if (_cachedPagesRoutePatternKey === cacheKey) {
    return _cachedPagesRoutePattern;
  }

  let resolved: string | undefined = nextDataPage;
  for (const pattern of window.__VINEXT_PAGE_PATTERNS__ ?? []) {
    if (matchRoutePattern(splitPathSegments(resolvedPath), routePatternParts(pattern))) {
      resolved = pattern;
      break;
    }
  }

  _cachedPagesRoutePatternKey = cacheKey;
  _cachedPagesRoutePattern = resolved;
  return resolved;
}

type RouteQueryNextData = {
  page?: string;
  query?: Record<string, string | string[] | undefined>;
};

function extractRouteParamsFromPath(
  pattern: string,
  pathname: string,
): Record<string, string | string[]> | null {
  return matchRoutePattern(splitPathSegments(pathname), routePatternParts(pattern));
}

function getRouteParamsFromQuery(
  pattern: string,
  query: Record<string, string | string[]>,
): Record<string, string | string[]> | null {
  const names = extractRouteParamNames(pattern);
  if (names.length === 0) return null;

  const params: Record<string, string | string[]> = {};
  let hasParam = false;
  for (const name of names) {
    const value = query[name];
    if (typeof value === "string") {
      params[name] = value;
      hasParam = true;
    } else if (Array.isArray(value)) {
      params[name] = [...value];
      hasParam = true;
    }
  }
  return hasParam ? params : null;
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

export function getPagesNavigationIsReadyFromSerializedState(
  routePattern: string | undefined,
  searchString: string,
  nextData?: VinextNextData,
): boolean {
  if (!routePattern) return true;

  // Mirrors the Pages Router constructor's initial `isReady` predicate:
  // data-driven pages are ready immediately, while auto-exported dynamic
  // routes, query-string URLs, and rewrite-capable builds wait for the client
  // router to publish the live URL state. Dynamic route shape alone is not a
  // delayed case; Next gates that branch on `__NEXT_DATA__.autoExport`.
  if (
    nextData?.gssp === true ||
    nextData?.gip === true ||
    nextData?.isExperimentalCompile === true ||
    (nextData?.appGip === true && nextData.gsp !== true)
  ) {
    return true;
  }

  const autoExportDynamic =
    nextData?.autoExport === true && extractRouteParamNames(routePattern).length > 0;
  const hasSearch = searchString.length > 0;
  const hasRewrites = nextData?.__vinext?.hasRewrites === true;
  return !autoExportDynamic && !hasSearch && !hasRewrites;
}

function shouldDeferInitialPagesRouterReady(): boolean {
  if (typeof window === "undefined") return false;
  const nextData = window.__NEXT_DATA__ as VinextNextData | undefined;
  if (!nextData) return false;

  return !getPagesNavigationIsReadyFromSerializedState(
    nextData.page,
    window.location.search,
    nextData,
  );
}

let _pagesRouterReady =
  typeof window === "undefined" ? true : !shouldDeferInitialPagesRouterReady();

function isPagesRouterReady(): boolean {
  // `_pagesRouterReady` initializes to `true` on the server and is only ever
  // flipped on the client, so this reads correctly in both environments.
  return _pagesRouterReady;
}

function isPagesRouterDocumentActive(): boolean {
  if (typeof window === "undefined") return true;
  if (window.__VINEXT_PAGE_LOADERS__) return true;
  if (window.next?.appDir === true) return false;
  if (window.next?.router) return true;
  return Boolean(window.__VINEXT_APP__ || window.__VINEXT_APP_LOADER__);
}

function markPagesRouterReady(): boolean {
  if (typeof window === "undefined" || _pagesRouterReady) return false;
  _pagesRouterReady = true;
  return true;
}

function getRouterSnapshot(): ReturnType<typeof getPathnameAndQuery> & { isReady: boolean } {
  // On the server, derive `router.isReady` from the SSR navigation-readiness
  // context (auto-export dynamic / query-string / rewrite-capable routes are
  // not ready until the client router publishes the live URL). Mirrors Next.js
  // render.tsx, which serializes the same readiness into `__NEXT_DATA__` so the
  // client hydrates with the identical value. Returning `true` unconditionally
  // would render `isReady: true` on the server while the client hydrates with
  // `isReady: false`, a hydration mismatch for components reading it in JSX.
  const isReady =
    typeof window === "undefined"
      ? (_getSSRContext()?.navigationIsReady ?? true)
      : isPagesRouterReady();
  return { ...getPathnameAndQuery(), isReady };
}

function notifyNextNavigationPagesContext(): void {
  const notify = (globalThis as PagesNavigationNotifyGlobal)[PAGES_NAVIGATION_NOTIFY_KEY];
  notify?.();
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

/**
 * Pending render-commit rejection, so superseded navigations settle their
 * render-commit Promise instead of hanging when a newer root.render() call
 * starts before the previous tree commits.
 */
let _cancelPendingRenderCommit: (() => void) | null = null;

function cancelPreviousRenderCommit(): void {
  _cancelPendingRenderCommit?.();
  _cancelPendingRenderCommit = null;
}

function scheduleHardNavigationAndThrow(url: string, message: string): never {
  if (typeof window === "undefined") {
    throw new HardNavigationScheduledError(message);
  }
  window.location.href = url;
  throw new HardNavigationScheduledError(message);
}

type NavigateClientOptions = {
  allowNotFoundResponse?: boolean;
  /**
   * The history mode of the originating navigation. Used when a gSSP/gSP data
   * response carries a `__N_REDIRECT` marker so the re-entrant navigation to
   * the redirect destination preserves push-vs-replace semantics, matching
   * Next.js's `this.change(method, ...)` re-dispatch.
   */
  mode?: "push" | "replace";
  scroll?: ScrollPosition | null;
};

/** Wire format of `/_next/data/<id>/<page>.json` response bodies. */
type PagesDataResponse = {
  pageProps?: Record<string, unknown>;
  // Server may also emit `notFound`, `__N_SSP`, etc. — we only consume
  // `pageProps`; everything else triggers a hard reload per the
  // user-configured fallback policy.
  [key: string]: unknown;
};

function isPageComponent(value: unknown): value is ComponentType<Record<string, unknown>> {
  if (typeof value === "function") return true;
  if (!isUnknownRecord(value)) return false;
  return (
    value.$$typeof === Symbol.for("react.forward_ref") ||
    value.$$typeof === Symbol.for("react.memo")
  );
}

function isAppComponent(value: unknown): value is NonNullable<Window["__VINEXT_APP__"]> {
  return isPageComponent(value);
}

function resolveSameOriginRedirectedUrl(responseUrl: string): string | null {
  const appPath = toSameOriginAppPath(responseUrl, __basePath);
  if (appPath === null) return null;
  return normalizePathTrailingSlash(
    toBrowserNavigationHref(appPath, window.location.href, __basePath),
    __trailingSlash,
  );
}

function stripLocalePrefixForApiRedirect(appPath: string): string {
  const locales = window.__VINEXT_LOCALES__;
  if (!locales || locales.length === 0) return appPath;

  try {
    const parsed = new URL(appPath, "http://vinext.local");
    const pathname = stripBasePath(parsed.pathname, __basePath);
    const firstSegment = pathname.split("/")[1];
    if (!firstSegment || !locales.includes(firstSegment)) return appPath;

    const withoutLocale = pathname.slice(firstSegment.length + 1) || "/"; // +1 for leading `/`
    if (withoutLocale !== "/api" && !withoutLocale.startsWith("/api/")) {
      return appPath;
    }

    return `${withoutLocale}${parsed.search}${parsed.hash}`;
  } catch {
    return appPath;
  }
}

function resolveLocalRedirectUrl(location: string): string | null {
  let appPath: string | null;
  if (location.startsWith("/") && !location.startsWith("//")) {
    try {
      // Data redirect headers can already be browser paths with basePath.
      // Convert back to app paths before toBrowserNavigationHref re-applies it.
      const parsed = new URL(location, "http://vinext.local");
      appPath = stripBasePath(parsed.pathname, __basePath) + parsed.search + parsed.hash;
    } catch {
      appPath = location;
    }
  } else {
    appPath = toSameOriginAppPath(location, __basePath);
  }

  if (appPath === null) return null;
  return normalizePathTrailingSlash(
    toBrowserNavigationHref(
      stripLocalePrefixForApiRedirect(appPath),
      window.location.href,
      __basePath,
    ),
    __trailingSlash,
  );
}

function hasVinextMiddleware(nextData: unknown): boolean {
  if (!isUnknownRecord(nextData)) return false;
  const vinext = nextData.__vinext;
  return isUnknownRecord(vinext) && vinext.hasMiddleware === true;
}

function getMiddlewarePagesDataFetchUrl(browserUrl: string): string | null {
  const nextData = window.__NEXT_DATA__;
  if (!nextData || !hasVinextMiddleware(nextData)) return null;
  const buildId = nextData.buildId;
  if (typeof buildId !== "string" || buildId.length === 0) return null;

  let parsed: URL;
  try {
    parsed = new URL(browserUrl, window.location.href);
  } catch {
    return null;
  }
  if (parsed.origin !== getWindowOrigin()) return null;

  const appPathname = stripBasePath(parsed.pathname, __basePath);
  return buildPagesDataHref(__basePath, buildId, appPathname, parsed.search);
}

async function resolveMiddlewareDataRedirect(
  browserUrl: string,
  signal: AbortSignal,
): Promise<string | null> {
  const dataUrl = getMiddlewarePagesDataFetchUrl(browserUrl);
  if (!dataUrl) return null;

  // We deliberately do NOT thread `signal` into the shared fetch — see the
  // dedup helper for why. Stale callers bail out via `assertStillCurrent()`
  // after the await; we still surface a pre-await abort via this check so
  // callers see the documented AbortError on supersession.
  if (signal.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }

  try {
    const res = await dedupedPagesDataFetch(dataUrl, {
      headers: {
        Accept: "application/json",
        "x-nextjs-data": "1",
      },
    });
    return res.headers.get("x-nextjs-redirect");
  } catch {
    return null;
  }
}

/**
 * React to a gSSP/gSP `__N_REDIRECT` marker returned on a client data
 * navigation.
 *
 * Internal destinations (absolute paths, unless the redirect opted out of
 * basePath via `__N_REDIRECT_BASE_PATH === false`) are followed with a fresh
 * client-side navigation that preserves the originating push/replace mode. The
 * fresh navigation increments the navigation id, so the navigation that
 * produced this redirect is superseded and never commits the intermediate
 * page. External (or non-absolute) destinations fall back to a hard navigation.
 *
 * Ported from Next.js: packages/next/src/shared/lib/router/router.ts
 * (`pageProps.__N_REDIRECT` handling — internal `this.change` vs
 * `handleHardNavigation`).
 */
function handleDataRedirect(
  destination: string,
  redirectBasePath: unknown,
  mode: "push" | "replace" = "push",
): void {
  const isInternal = destination.startsWith("/") && redirectBasePath !== false;
  if (!isInternal) {
    // External or basePath-less redirect — hard navigate to the redirect
    // destination, mirroring Next.js's `handleHardNavigation({ url: destination })`.
    scheduleHardNavigationAndThrow(destination, "Navigation redirected externally");
  }

  // Re-dispatch as a fresh navigation. `locale: false` matches Next.js, which
  // does not re-apply the locale prefix to a redirect destination.
  void performNavigation(destination, undefined, { locale: false }, mode);
}

/**
 * Perform client-side navigation via the `/_next/data/<id>/<page>.json`
 * endpoint. Used when `__VINEXT_PAGE_LOADERS__` has a matching code-split
 * loader for the target pattern (the prod hot path). Falls back to the
 * HTML extraction path (`navigateClientHtml`) when this returns `null`.
 *
 * Failure modes (404, 5xx, network, parse, missing loader, soft redirect)
 * all queue a hard navigation and throw `HardNavigationScheduledError`,
 * mirroring the existing HTML-path failure protocol. The hard reload is
 * the deploy-skew safety net: when the server's buildId has rotated, the
 * data endpoint returns 404 and the client lands on the new build via a
 * full document load.
 */
async function navigateClientData(
  url: string,
  target: PagesDataTarget,
  controller: AbortController,
  navId: number,
  assertStillCurrent: () => void,
  options: NavigateClientOptions = {},
): Promise<void> {
  const root = window.__VINEXT_ROOT__;
  if (!root) {
    // No React root yet — fall back to hard navigation
    window.location.href = url;
    return;
  }

  // Fetch the page-data JSON.
  //
  // We dedupe by URL: concurrent `Router.push` calls (or back-to-back link
  // clicks) for the same destination share a single underlying request.
  // The shared fetch deliberately ignores `controller.signal` — each caller
  // still bails out of their navigation via `assertStillCurrent()` after the
  // await, but the shared network request itself runs to completion so other
  // racing callers still benefit. This matches Next.js's `inflightCache`
  // semantics in `fetchNextData()`.
  //
  // Pre-await abort still throws so callers see the documented cancellation
  // surface when supersession happened before the fetch was even attempted.
  if (controller.signal.aborted) {
    throw new NavigationCancelledError(url);
  }
  let res: Response;
  try {
    res = await dedupedPagesDataFetch(target.dataHref, {
      headers: { Accept: "application/json", "x-nextjs-data": "1" },
    });
  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new NavigationCancelledError(url);
    }
    throw err;
  }
  assertStillCurrent();

  // Soft-redirect protocol: the data endpoint emits 200 + x-nextjs-redirect
  // when middleware (or gSSP/gSP) chose a redirect for this URL.
  const softRedirect = res.headers.get("x-nextjs-redirect");
  if (softRedirect) {
    const redirectedUrl = resolveLocalRedirectUrl(softRedirect);
    if (!redirectedUrl) {
      scheduleHardNavigationAndThrow(softRedirect, "Navigation redirected externally");
    }

    window.history.replaceState(window.history.state ?? {}, "", redirectedUrl);
    _lastPathnameAndSearch = window.location.pathname + window.location.search;
    await navigateClientHtml(redirectedUrl, redirectedUrl, controller, navId, assertStillCurrent);
    return;
  }

  if (!res.ok) {
    // 404 here is the deploy-skew signal (server buildId rotated) — hard
    // reload to land on the new build's HTML. Any other non-OK status is
    // treated the same way per the user-configured "always hard reload"
    // fallback policy.
    scheduleHardNavigationAndThrow(url, `Data navigation failed: ${res.status} ${res.statusText}`);
  }

  let body: PagesDataResponse;
  try {
    body = (await res.json()) as PagesDataResponse;
  } catch {
    scheduleHardNavigationAndThrow(url, "Data navigation failed: invalid JSON response");
  }
  assertStillCurrent();

  const pageProps: Record<string, unknown> =
    body.pageProps && typeof body.pageProps === "object" ? body.pageProps : {};

  // gSSP/gSP redirect marker. When getServerSideProps/getStaticProps returns
  // `{ redirect }`, the data endpoint replies 200 with `__N_REDIRECT` /
  // `__N_REDIRECT_STATUS` inside pageProps (rather than an HTTP redirect, which
  // fetch would transparently follow to non-JSON HTML). Re-enter a fresh
  // navigation to the destination — this increments the navigation id, which
  // supersedes (cancels) the current navigation so the intermediate page is
  // never committed. Mirrors Next.js's `pageProps.__N_REDIRECT` handling in
  // packages/next/src/shared/lib/router/router.ts (`this.change(method, ...)`).
  const redirectDestination = pageProps.__N_REDIRECT;
  if (typeof redirectDestination === "string") {
    handleDataRedirect(redirectDestination, pageProps.__N_REDIRECT_BASE_PATH, options.mode);
    throw new NavigationCancelledError(url);
  }

  // Load the page module via the registered code-split loader. Vite has
  // already split each page into its own chunk; the loader is just the
  // `import()` thunk the build generated.
  let pageModule: { default?: unknown; [key: string]: unknown };
  try {
    pageModule = await target.loader();
  } catch (err) {
    console.error("[vinext] Page loader threw during navigation:", err);
    scheduleHardNavigationAndThrow(url, "Data navigation failed: page loader threw");
  }
  assertStillCurrent();

  const PageComponent = pageModule.default;
  if (!isPageComponent(PageComponent)) {
    scheduleHardNavigationAndThrow(
      url,
      "Data navigation failed: page module default export is not a component",
    );
  }

  // Lazy-load `_app` if we have an app loader and haven't cached it yet.
  let AppComponent = window.__VINEXT_APP__;
  if (!AppComponent && typeof window.__VINEXT_APP_LOADER__ === "function") {
    try {
      const appModule = await window.__VINEXT_APP_LOADER__();
      AppComponent = isAppComponent(appModule.default) ? appModule.default : undefined;
      if (AppComponent) window.__VINEXT_APP__ = AppComponent;
    } catch {
      // _app load failed — fall through and render without it. This matches
      // the HTML path which also tolerates a missing _app gracefully.
    }
  }
  assertStillCurrent();

  // Import React (already evaluated; this is a cached re-import).
  const React = (await import("react")).default;
  assertStillCurrent();

  let element: ReactElement;
  if (AppComponent) {
    element = React.createElement(AppComponent, {
      Component: PageComponent,
      pageProps,
    });
  } else {
    element = React.createElement(PageComponent, pageProps);
  }
  // Build the updated __NEXT_DATA__. The JSON envelope is intentionally
  // minimal (just `pageProps`), so we synthesise the surrounding fields
  // from the data we already have: the matched pattern, the params, and
  // the previous nextData's buildId/locale state. This keeps
  // `useRouter()`, `getPagesNavigationContext()`, and any code reading
  // `window.__NEXT_DATA__` in sync after a JSON navigation — mirroring
  // what the HTML path produces.
  //
  // The cast through `unknown` is unavoidable: the upstream `NEXT_DATA`
  // type defines `query` as `ParsedUrlQuery` which is structurally
  // identical to our `Record<string, string | string[]>` but nominally
  // disjoint, so TypeScript rejects the direct assignment. We spread the
  // previous nextData first to inherit locale/locales/defaultLocale/
  // domainLocales unchanged, then override the per-navigation fields.
  // Mirror Next.js' `__NEXT_DATA__.query`: search params + dynamic route params
  // merged in one object, with route params winning on key collision (so
  // `/posts/123?id=456` still exposes `id: "123"`). Without this, code reading
  // `window.__NEXT_DATA__.query` directly would see only the dynamic params.
  const mergedQuery = mergeRouteParamsIntoQuery(parseQueryString(target.search), target.params);

  const prev = window.__NEXT_DATA__ as NonNullable<Window["__NEXT_DATA__"]> | undefined;
  // Locale-prefixed URLs change the active locale; the JSON envelope itself
  // has no locale metadata, so derive it from the URL we navigated to.
  // `target.locale` is `undefined` when the URL is unprefixed — that means
  // either no i18n config (keep `prev.locale`) or the default locale
  // (override `prev.locale` so locale transitions back to default land
  // correctly). The locales list / defaultLocale / domainLocales are
  // build-time config and don't change between pages, so they spread through
  // from `prev` unchanged.
  const hasI18n = (window.__VINEXT_LOCALES__?.length ?? 0) > 0;
  const nextLocale = hasI18n
    ? (target.locale ?? window.__VINEXT_DEFAULT_LOCALE__)
    : (prev as VinextNextData | undefined)?.locale;
  const nextData = {
    ...prev,
    props: { pageProps },
    page: target.pattern,
    query: mergedQuery,
    buildId: target.buildId,
    isFallback: false,
    ...(nextLocale !== undefined ? { locale: nextLocale } : {}),
  } as unknown as NonNullable<Window["__NEXT_DATA__"]> & VinextNextData;

  // INVARIANT: __NEXT_DATA__ is mutated only after all pre-render async work
  // has passed assertStillCurrent(). The post-render await below waits for the
  // stable Pages Router commit boundary before routeChangeComplete, matching
  // Next.js's client Root callback without remounting the page tree.
  window.__NEXT_DATA__ = nextData;
  applyVinextLocaleGlobals(window, nextData);
  await renderPagesRouterElement(element, options.scroll);
  assertStillCurrent();
}

/**
 * Perform client-side navigation by fetching the page's full HTML and
 * extracting `__NEXT_DATA__` plus the page module URL. Used in dev (where
 * the per-page inline hydration script does not populate the loader map) and
 * as a generic fallback when the data path is not available.
 *
 * Throws NavigationCancelledError if a newer navigation supersedes this one.
 * Throws on hard-navigation failures (non-OK response, missing data) so the
 * caller can distinguish success from failure for event emission.
 */
async function navigateClientHtml(
  url: string,
  fetchUrl: string,
  controller: AbortController,
  navId: number,
  assertStillCurrent: () => void,
  options: NavigateClientOptions = {},
): Promise<void> {
  let browserUrl = url;
  let pendingRedirectHistoryUrl: string | null = fetchUrl === url ? null : url;
  const root = window.__VINEXT_ROOT__;
  if (!root) {
    // No React root yet — fall back to hard navigation
    window.location.href = browserUrl;
    return;
  }

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

  if (res.redirected && res.url) {
    const redirectedUrl = resolveSameOriginRedirectedUrl(res.url);
    if (redirectedUrl) {
      browserUrl = redirectedUrl;
      pendingRedirectHistoryUrl = redirectedUrl;
    }
  }

  if (!res.ok && !(options.allowNotFoundResponse === true && res.status === 404)) {
    // Set window.location.href first so the browser navigates to the correct
    // page even if the caller suppresses the error.  The assignment schedules
    // the navigation asynchronously (as a task), so synchronous routeChangeError
    // listeners still run — and observe the error — before the page unloads.
    // Contract: routeChangeError listeners MUST be synchronous; async listeners
    // will not fire before the navigation completes.  Callers (runNavigateClient)
    // must NOT schedule a second hard navigation — this assignment already queues
    // the browser fallback, and the helper-level HardNavigationScheduledError
    // makes that contract explicit to callers.
    scheduleHardNavigationAndThrow(
      browserUrl,
      `Navigation failed: ${res.status} ${res.statusText}`,
    );
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

  let pageModule: { default?: unknown; [key: string]: unknown };
  if (!pageModuleUrl) {
    const loader = window.__VINEXT_PAGE_LOADERS__?.[nextData.page];
    if (!loader) {
      scheduleHardNavigationAndThrow(browserUrl, "Navigation failed: no page module URL found");
    }
    pageModule = await loader();
  } else {
    // Validate the module URL before importing — defense-in-depth against
    // unexpected __NEXT_DATA__ or malformed HTML responses
    if (!isValidModulePath(pageModuleUrl)) {
      console.error("[vinext] Blocked import of invalid page module path:", pageModuleUrl);
      scheduleHardNavigationAndThrow(browserUrl, "Navigation failed: invalid page module path");
    }

    // Dynamically import the new page module
    pageModule = await import(/* @vite-ignore */ pageModuleUrl);
  }
  assertStillCurrent();

  const PageComponent = pageModule.default;
  if (!isPageComponent(PageComponent)) {
    scheduleHardNavigationAndThrow(
      browserUrl,
      "Navigation failed: page module default export is not a component",
    );
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
        AppComponent = isAppComponent(appModule.default) ? appModule.default : undefined;
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

  // Commit __NEXT_DATA__ only after all assertStillCurrent() checks have passed,
  // so a stale navigation can never pollute the global.
  // INVARIANT: __NEXT_DATA__ is mutated only after all pre-render async work
  // has passed assertStillCurrent(). The post-render await below waits for the
  // stable Pages Router commit boundary before routeChangeComplete, matching
  // Next.js's client Root callback without remounting the page tree.
  if (pendingRedirectHistoryUrl) {
    window.history.replaceState(window.history.state ?? {}, "", pendingRedirectHistoryUrl);
    _lastPathnameAndSearch = window.location.pathname + window.location.search;
  }
  window.__NEXT_DATA__ = nextData;
  applyVinextLocaleGlobals(window, nextData);
  await renderPagesRouterElement(element, options.scroll);
  assertStillCurrent();
}

/**
 * Perform client-side navigation. Prefers the JSON data endpoint when the
 * client has a registered code-split loader for the target route (the prod
 * hot path); otherwise falls back to fetching the page's full HTML (dev and
 * any unmapped route).
 *
 * Throws NavigationCancelledError if a newer navigation supersedes this one.
 * Throws on hard-navigation failures (non-OK response, missing data) so the
 * caller can distinguish success from failure for event emission.
 *
 * `fetchUrl` is the HTML-path fetch URL (already includes locale-root
 * fixups). The JSON path derives its own URL from the browser-facing `url`
 * because the data endpoint speaks the unprefixed path.
 */
async function navigateClient(
  url: string,
  fetchUrl = url,
  options: NavigateClientOptions = {},
): Promise<void> {
  if (typeof window === "undefined") return;

  // Cancel any in-flight navigation (abort its fetch, settle its render-commit wait)
  _activeAbortController?.abort();
  cancelPreviousRenderCommit();
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
    // Error-route navigation (`router.push('/404'|'/_error', as)`): the masked
    // browser URL and the component route differ, and the error page has no
    // data endpoint. Skip data navigation and middleware-redirect probing
    // (both would target the fictional masked URL) and fetch the resolved
    // error HTML directly, allowing a 404 response to hydrate.
    if (options.allowNotFoundResponse === true) {
      await navigateClientHtml(url, fetchUrl, controller, navId, assertStillCurrent, options);
    } else {
      let browserUrl = url;
      let htmlFetchUrl = fetchUrl;
      const dataTarget = resolvePagesDataNavigationTarget(browserUrl, __basePath);
      if (!dataTarget) {
        let redirectLocation: string | null;
        try {
          redirectLocation = await resolveMiddlewareDataRedirect(browserUrl, controller.signal);
        } catch (err: unknown) {
          if (err instanceof DOMException && err.name === "AbortError") {
            throw new NavigationCancelledError(browserUrl);
          }
          throw err;
        }
        assertStillCurrent();
        if (redirectLocation) {
          const redirectedUrl = resolveLocalRedirectUrl(redirectLocation);
          if (!redirectedUrl) {
            scheduleHardNavigationAndThrow(redirectLocation, "Navigation redirected externally");
          }
          window.history.replaceState(window.history.state ?? {}, "", redirectedUrl);
          _lastPathnameAndSearch = window.location.pathname + window.location.search;
          browserUrl = redirectedUrl;
          htmlFetchUrl = redirectedUrl;
        }
      }

      if (dataTarget) {
        await navigateClientData(
          browserUrl,
          dataTarget,
          controller,
          navId,
          assertStillCurrent,
          options,
        );
      } else {
        await navigateClientHtml(
          browserUrl,
          htmlFetchUrl,
          controller,
          navId,
          assertStillCurrent,
          options,
        );
      }
    }
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
  options: NavigateClientOptions = {},
): Promise<"completed" | "cancelled" | "failed"> {
  try {
    await navigateClient(fullUrl, fetchUrl, options);
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
  isReady: boolean,
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
    isReady,
    isPreview: false,
    isFallback:
      typeof window !== "undefined"
        ? nextData?.isFallback === true
        : _ssrState?.isFallback === true,
    ...methods,
    events: routerEvents,
  };
}

/** Extract the hash fragment from a URL, including the leading `#`. */
function extractHash(url: string): string {
  const i = url.indexOf("#");
  return i === -1 ? "" : url.slice(i);
}

/** Return the URL with any trailing `#fragment` removed. */
function stripHash(url: string): string {
  const i = url.indexOf("#");
  return i === -1 ? url : url.slice(0, i);
}

/** Notify in-page listeners (e.g. useRouter hooks) that navigation occurred. */
function dispatchNavigateEvent(): void {
  notifyNextNavigationPagesContext();
  window.dispatchEvent(new CustomEvent("vinext:navigate"));
}

/**
 * Update history with the new URL and refresh the hash-only-detection tracker.
 * Centralises the `pushState`/`replaceState` branch so callers don't repeat it.
 *
 * Writes a Next.js-compatible state shape so popstate can detect non-router
 * entries, ignore stale Safari-style replays, and recover the active locale
 * across browser back/forward. Mirrors `Router.changeState` in
 * .nextjs-ref/packages/next/src/shared/lib/router/router.ts (around L1916).
 *
 * @param mode push or replace
 * @param fullUrl absolute URL committed to the browser (with basePath)
 * @param navState router-level metadata (`url`, `as`, `options`) the popstate
 *        handler needs to honour stickiness — most importantly the active
 *        locale and the canonical app-relative `as` path.
 */
function updateHistory(
  mode: "push" | "replace",
  fullUrl: string,
  navState?: { url?: string; as?: string; options?: { locale?: string; shallow?: boolean } },
): void {
  const previousKey = getRouterStateKey(window.history.state);
  const key =
    mode === "push"
      ? createHistoryKey()
      : (previousKey ?? _currentHistoryKey ?? createHistoryKey());
  const stateUrl = navState?.url ?? fullUrl;
  const stateAs = navState?.as ?? fullUrl;
  const options = navState?.options ?? {};
  const state: VinextHistoryState = {
    url: stateUrl,
    as: stateAs,
    options,
    __N: true,
    key,
  };
  if (mode === "push") window.history.pushState(state, "", fullUrl);
  else window.history.replaceState(state, "", fullUrl);
  _currentHistoryKey = key;
  _lastPathnameAndSearch = window.location.pathname + window.location.search;
  _routerDidNavigate = true;
}

/**
 * Minimal Next.js-compatible history state shape. We deliberately keep this
 * narrow: only the fields popstate and the i18n stickiness machinery read.
 */
type VinextHistoryState = {
  url: string;
  as: string;
  options: { locale?: string; shallow?: boolean };
  __N: true;
  key: string;
};

let _historyKeyCounter = 0;
function createHistoryKey(): string {
  _historyKeyCounter += 1;
  // Same intent as Next.js's createKey() — opaque, monotonic-ish, fine for
  // identifying history entries client-side.
  return `vinext_${_historyKeyCounter.toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
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

  // Defence-in-depth dangerous-scheme guard. The synchronous guard inside
  // `Router.push` / `Router.replace` (see RouterMethods below) is the primary
  // line of defence and is what surfaces the matching console.error to React's
  // event-handler runtime. This inner guard catches any future call sites
  // that bypass the public Router methods and call `performNavigation`
  // directly. Mirrors Next.js's Pages Router check at
  // packages/next/src/shared/lib/router/router.ts:1025-1033,1057-1065.
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
  const errorRouteHtmlFetchUrl = resolvePagesErrorHtmlFetchUrl(url, navigationLocale);
  const htmlFetchUrl = errorRouteHtmlFetchUrl ?? getPagesHtmlFetchUrl(full, navigationLocale);
  const shallow = options?.shallow ?? false;
  const doScroll = options?.scroll !== false;
  const hash = extractHash(resolved);
  // Only pass {x, y} restoration through renderPagesRouterElement's commit
  // callback. Hash scrolling is deferred until after routeChangeComplete so
  // the event ordering matches Next.js: x/y reset before completion, hash
  // scroll after completion.
  const scrollTarget = doScroll ? { x: 0, y: 0 } : null;
  const navigateOptions: NavigateClientOptions = errorRouteHtmlFetchUrl
    ? { allowNotFoundResponse: true, mode, scroll: scrollTarget }
    : { mode, scroll: scrollTarget };

  // History state metadata — surfaces the active locale to popstate and the
  // Safari-replay filter. `as` is the canonical app-relative path (no
  // basePath, no hash) so it can be compared against `_lastPathnameAndSearch`
  // (which is `pathname + search` only) in the popstate handler.
  const navStateOptions: { locale?: string; shallow: boolean } = { shallow };
  if (navigationLocale !== undefined) navStateOptions.locale = navigationLocale;
  const resolvedNoHash = stripHash(resolved);
  const navState = { url: resolvedNoHash, as: resolvedNoHash, options: navStateOptions };

  // Hash-only change — no page fetch needed
  if (isHashOnlyChange(full)) {
    // Snapshot the outgoing entry's scroll before updateHistory mints a new
    // key, so a later back-popstate restores the position the user had
    // reached here rather than {x: 0, y: 0}. Upstream snapshots inside
    // Router.push() itself — before change()'s onlyAHashChange short-circuit
    // — so hash-only pushes still write `__next_scroll_<key>` for the
    // departed entry.
    // Mirrors Next.js: packages/next/src/shared/lib/router/router.ts:1034-1046.
    if (mode === "push") saveScrollPosition();
    const eventUrl = resolveHashUrl(full);
    routerEvents.emit("hashChangeStart", eventUrl, { shallow });
    updateHistory(mode, resolved.startsWith("#") ? resolved : full, navState);
    if (doScroll) scrollToHashTarget(extractHash(resolved));
    onStateUpdate?.();
    routerEvents.emit("hashChangeComplete", eventUrl, { shallow });
    dispatchNavigateEvent();
    return true;
  }

  // If this destination was detected as an App Router route during prefetch,
  // skip the Pages Router SPA fetch and do an immediate hard navigation.
  // The Pages Router client-side stack cannot render App Router pages; a hard
  // navigation lets the browser bootstrap the App Router runtime from scratch.
  //
  // Mirrors Next.js: packages/next/src/shared/lib/router/router.ts:1448-1453
  //   if ((this.components[pathname] as any)?.__appRouter) {
  //     handleHardNavigation({ url: as, router: this })
  //     return new Promise(() => {})
  //   }
  //
  // Key normalisation: strip trailing slash so the lookup always matches the
  // canonical key written by markAppRouteDetectedOnPrefetch, regardless of
  // whether trailingSlash:true added a slash to `resolved` above (line 1797).
  // Mirrors Next.js: removeTrailingSlash(removeBasePath(pathname)) at line 1442.
  const appPath = getLocalPathname(resolved);
  const appPathNorm = appPath !== null ? removeTrailingSlash(appPath) : null;
  const appPathEntry =
    appPathNorm !== null ? getPagesRouterComponentsMap()[appPathNorm] : undefined;
  if (appPathEntry !== undefined && "__appRouter" in appPathEntry && appPathEntry.__appRouter) {
    if (mode === "push") window.location.assign(full);
    else window.location.replace(full);
    return new Promise<boolean>(() => {});
  }

  if (mode === "push") saveScrollPosition();
  routerEvents.emit("routeChangeStart", resolved, { shallow });
  routerEvents.emit("beforeHistoryChange", resolved, { shallow });
  updateHistory(mode, full, navState);
  if (!shallow) {
    const result = await runNavigateClient(full, resolved, htmlFetchUrl, navigateOptions);
    if (result === "cancelled") return true;
    if (result === "failed") return false;
  } else {
    // Shallow navigations skip the render-commit path, so apply the scroll
    // reset synchronously here — before routeChangeComplete. This matches the
    // non-shallow path, where the x/y reset runs inside the render-commit
    // callback (also ahead of routeChangeComplete), mirroring Next.js's
    // ordering of scroll-during-commit, then completion event.
    if (doScroll) {
      if (hash) scrollToHashTarget(hash);
      else window.scrollTo(0, 0);
    }
  }
  onStateUpdate?.();
  routerEvents.emit("routeChangeComplete", resolved, { shallow });
  // Hash scrolling after routeChangeComplete, matching Next.js ordering:
  // x/y restoration happens during the render commit, then hash scrolling
  // happens after the completion event.
  if (doScroll && hash && !shallow) {
    scrollToHashTarget(hash);
  }
  dispatchNavigateEvent();
  return true;
}

/**
 * Prefetch the resources needed for a future Pages Router navigation.
 *
 * When the client has a registered code-split loader for the target route
 * (the prod hot path), we prefetch in parallel:
 *   1. The `/_next/data/<buildId>/<page>.json` payload — same URL the actual
 *      navigation will request, so a cache hit is automatic.
 *   2. The page's JS chunk — by invoking the loader thunk now. Vite's
 *      dynamic `import()` machinery is responsible for fetching + caching;
 *      the returned Promise is intentionally discarded.
 *
 * When no loader is registered (dev server, or an unmapped route), we fall
 * back to the legacy `<link rel="prefetch" as="document">` hint, which lets
 * the browser preload the HTML document. This matches the pre-`_next/data`
 * behaviour so dev doesn't regress.
 *
 * Ported from Next.js: `packages/next/src/client/page-loader.ts` `prefetch`
 * (the data + chunk parallel prefetch shape).
 */
async function prefetchUrl(url: string): Promise<void> {
  if (typeof document === "undefined") return;

  const dataTarget = resolvePagesDataNavigationTarget(url, __basePath);
  if (dataTarget) {
    prefetchPagesData(dataTarget);
    return;
  }

  // The target is not a Pages Router route — mark it on `components` if the
  // App Router prefetch manifest recognises it. Mirrors Next.js's `_bfl`
  // marker write at `packages/next/src/shared/lib/router/router.ts:2525`;
  // the Next.js deploy test reads `window.next.router.components[<path>]` to
  // assert prefetch detection. See issue #1526.
  markAppRouteDetectedOnPrefetch(url, __basePath);

  // Legacy fallback for routes without a registered loader (e.g. dev).
  // Hints the browser to preload the HTML document so the next click feels
  // faster, even though we can't resolve the chunk ahead of time.
  const link = document.createElement("link");
  link.rel = "prefetch";
  link.href = url;
  link.as = "document";
  document.head.appendChild(link);
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
  const [{ pathname, query, asPath, isReady }, setState] = useState(getRouterSnapshot);

  // Popstate is handled by the Pages Router client entry via
  // installPagesRouterRuntime() so beforePopState() is consistently enforced
  // regardless of hook consumers. Keep URL snapshot subscriptions at the
  // provider boundary so many useRouter() calls share one router state and one
  // vinext:navigate listener.
  useEffect(() => {
    const onNavigate = ((_e: CustomEvent) => {
      setState(getRouterSnapshot());
    }) as EventListener;
    window.addEventListener("vinext:navigate", onNavigate);
    let cancelled = false;
    const readyTimer = window.setTimeout(() => {
      if (cancelled || !markPagesRouterReady()) return;
      setState(getRouterSnapshot());
      notifyNextNavigationPagesContext();
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(readyTimer);
      window.removeEventListener("vinext:navigate", onNavigate);
    };
  }, []);

  const router = useMemo(
    (): NextRouter =>
      buildRouterValue(pathname, query, asPath, isReady, {
        push: Router.push,
        replace: Router.replace,
        back: Router.back,
        reload: Router.reload,
        prefetch: Router.prefetch,
        beforePopState: Router.beforePopState,
      }),
    [pathname, query, asPath, isReady],
  );

  const appRouter = useMemo(
    (): AppRouterInstance => ({
      bfcacheId: "0",
      back() {
        Router.back();
      },
      forward() {
        if (typeof window === "undefined") throwNoRouterInstance();
        window.history.forward();
      },
      refresh() {
        Router.reload();
      },
      push(href, options) {
        void Router.push(href, undefined, { scroll: options?.scroll });
      },
      replace(href, options) {
        void Router.replace(href, undefined, { scroll: options?.scroll });
      },
      prefetch(href) {
        void Router.prefetch(href);
      },
    }),
    [],
  );

  const content = createElement(RouterContext.Provider, { value: router }, children);
  return AppRouterContext
    ? createElement(AppRouterContext.Provider, { value: appRouter }, content)
    : content;
}

// beforePopState callback: called before handling browser back/forward.
// If it returns false, the navigation is cancelled.
let _beforePopStateCb: BeforePopStateCallback | undefined;

// Track pathname+search for detecting hash-only back/forward in the popstate
// handler. Updated after every pushState/replaceState so that popstate can
// compare the previous value with the (already-changed) window.location.
let _lastPathnameAndSearch =
  typeof window !== "undefined" ? window.location.pathname + window.location.search : "";

// Tracks whether we have observed at least one popstate event in this
// document. Safari fires a synthetic popstate on tab reopen / restore which
// must be ignored when the carried state matches the page we're already on.
//
// Ported from Next.js: packages/next/src/shared/lib/router/router.ts
// (the `isFirstPopStateEvent` flag around the `onPopState` handler, ~L935).
let _isFirstPopStateEvent = true;

// Tracks whether the router has performed any push/replace in this document.
// The Safari-replay filter (see below) only fires before any user-initiated
// navigation — once the user has navigated, a back/forward popstate is by
// definition a real one and must not be filtered out, even if the carried
// state happens to compare equal to the live URL on the relevant fields
// (e.g. a hash-only push followed by goBack carries state.as without a hash,
// matching `_lastPathnameAndSearch` which is also tracked without a hash).
let _routerDidNavigate = false;

function isNextRouterState(state: unknown): state is {
  url?: string;
  as?: string;
  options?: { locale?: string; shallow?: boolean };
  __N: true;
  key?: string;
} {
  return (
    typeof state === "object" &&
    state !== null &&
    "__N" in state &&
    (state as { __N?: unknown }).__N === true
  );
}

function getRouterStateKey(state: unknown): string | undefined {
  if (!isNextRouterState(state)) return undefined;
  return typeof state.key === "string" ? state.key : undefined;
}

function handlePagesRouterPopState(e: PopStateEvent): void {
  const browserUrl = window.location.pathname + window.location.search;
  const appUrl = stripBasePath(window.location.pathname, __basePath) + window.location.search;

  const state = e.state as unknown;
  const wasFirst = _isFirstPopStateEvent;
  _isFirstPopStateEvent = false;

  // History entries written by third-party code (state without `__N: true`)
  // are not owned by the router. Mirror Next.js's `if (!state.__N) return`
  // early-exit so a non-router pushState doesn't trigger a spurious page
  // fetch.
  //
  // The `null` state case (e.g. the initial document load, scroll-restoration
  // popstate, or tests that fire popstate without state) keeps the legacy
  // behaviour where we treat it as a back/forward navigation so existing
  // popstate tests stay green. Only an *object* state without `__N` is
  // treated as foreign.
  if (state !== null && state !== undefined && !isNextRouterState(state)) {
    return;
  }

  // Safari-replay filter: the browser sometimes fires a synthetic popstate
  // for the current entry on tab restore / BFCache. Ignore it when the
  // entry's locale matches the active locale AND the entry's `as` matches
  // the URL the router last actively navigated to. We compare against the
  // router-internal tracker (`_lastPathnameAndSearch`, browser-shaped, with
  // basePath) rather than the live `window.location` — after a real
  // back/forward the browser URL has already changed but the router tracker
  // still points at the entry we were on, so a genuine navigation is *not*
  // misidentified as a replay.
  //
  // `state.as` is the canonical app-relative path (no basePath); compose the
  // basePath back on for the comparison.
  //
  // Mirrors Next.js's:
  //   if (isFirstPopStateEvent && this.locale === state.options.locale
  //       && state.as === this.asPath) return
  // .nextjs-ref/packages/next/src/shared/lib/router/router.ts (around L935).
  // Only run the filter before any router-initiated push/replace. Once the
  // user has navigated, a popstate is by definition a real back/forward and
  // must not be silently dropped (e.g. a hash-only push then goBack carries
  // state.as without the hash, which would otherwise match
  // `_lastPathnameAndSearch` and be incorrectly filtered).
  if (wasFirst && !_routerDidNavigate && isNextRouterState(state)) {
    const currentLocale = window.__VINEXT_LOCALE__;
    if (
      state.options?.locale === currentLocale &&
      typeof state.as === "string" &&
      withBasePath(state.as, __basePath) === _lastPathnameAndSearch
    ) {
      return;
    }
  }

  // Detect hash-only back/forward: pathname+search unchanged, only hash differs.
  const isHashOnly = browserUrl === _lastPathnameAndSearch;
  const targetKey = getRouterStateKey(state);
  let forcedScroll: ScrollPosition | undefined;

  if (manualScrollRestoration) {
    const currentKey = _currentHistoryKey;
    if (currentKey !== undefined && currentKey !== targetKey) {
      // Reading window scroll here is only correct because manualScrollRestoration
      // implies history.scrollRestoration = "manual", so the browser hasn't yet
      // moved the viewport to the target entry's position when popstate fires.
      // Snapshotting eagerly (before the beforePopState gate below) is
      // intentional: if the traversal is cancelled the app stays on
      // `currentKey`, so the saved value is still that entry's live scroll.
      saveScrollPositionToSessionStorage(currentKey, getWindowScrollPosition());
    }

    if (targetKey !== undefined && currentKey !== targetKey) {
      // `?? {x: 0, y: 0}` is the missing-snapshot fallback, not just a type
      // guard: with no saved position for the target entry, top is the only
      // safe default under manual restoration.
      forcedScroll = readScrollPositionFromSessionStorage(targetKey) ?? { x: 0, y: 0 };
    }
  }

  // Check beforePopState callback
  if (_beforePopStateCb !== undefined) {
    const shouldContinue = _beforePopStateCb({
      url: appUrl,
      as: appUrl,
      options: { shallow: false },
    });
    if (!shouldContinue) return;
  }

  // Update trackers only after beforePopState confirms navigation proceeds.
  // If beforePopState cancels, the app stays on the previous history entry,
  // so both must retain their previous values: `_lastPathnameAndSearch` so
  // the next popstate compares against the correct baseline, and
  // `_currentHistoryKey` so subsequent scroll bookkeeping keys off the entry
  // the app is actually on.
  if (targetKey !== undefined) {
    _currentHistoryKey = targetKey;
  }
  _lastPathnameAndSearch = browserUrl;

  if (isHashOnly) {
    // Hash-only back/forward — no page fetch needed.
    //
    // `forcedScroll` is intentionally discarded here: only the hash anchor is
    // honoured, never the target entry's `__next_scroll_<key>` snapshot. This
    // matches Next.js, where `change()`'s onlyAHashChange branch calls
    // `this.set(nextState, this.components[nextState.route], null)` and only
    // `scrollToHash` runs — `forcedScroll` is consumed solely by the later
    // `upcomingScrollState = forcedScroll ?? resetScroll` full-navigation
    // path (.nextjs-ref/packages/next/src/shared/lib/router/router.ts around
    // L1381-1403 and L1780). The snapshot stays in sessionStorage, so a later
    // non-hash popstate to this entry still restores the saved position.
    const hashUrl = appUrl + window.location.hash;
    routerEvents.emit("hashChangeStart", hashUrl, { shallow: false });
    scrollToHashTarget(window.location.hash);
    routerEvents.emit("hashChangeComplete", hashUrl, { shallow: false });
    dispatchNavigateEvent();
    return;
  }

  // If the restored history entry carries an explicit locale, honour it
  // when computing the fetch URL so default-locale roots still go through
  // their locale-qualified HTML endpoint (parity with the push path).
  const stateLocale = isNextRouterState(state) ? state.options?.locale : undefined;
  const effectiveLocale = stateLocale ?? window.__VINEXT_LOCALE__;

  const fullAppUrl = appUrl + window.location.hash;
  routerEvents.emit("routeChangeStart", fullAppUrl, { shallow: false });
  // Note: The browser has already updated window.location by the time popstate
  // fires, so this is not truly "before" the URL change. In Next.js the popstate
  // handler calls replaceState to store history metadata — beforeHistoryChange
  // precedes that call, not the URL change itself. We emit it here for API
  // compatibility.
  routerEvents.emit("beforeHistoryChange", fullAppUrl, { shallow: false });
  void (async () => {
    // When manual scroll restoration is enabled we drive the position from the
    // sessionStorage snapshot keyed by history key. When it is disabled we
    // still restore the per-entry scroll saved in history state on push, since
    // a soft popstate re-renders content the browser's native restoration
    // can't position correctly. The fallbacks differ on purpose: with manual
    // restoration the browser is hands-off, so we default to { x: 0, y: 0 };
    // with it disabled, an entry we never stamped resolves to null (no scroll
    // from us) and native "auto" restoration — still enabled — handles it,
    // matching the old restoreScrollPosition no-op on main.
    // The manual chain is not three independent fallbacks: keyed entries always
    // resolve via forcedScroll (already `?? { x: 0, y: 0 }`), so the middle term
    // only handles entries without a router key, via the history-state shape.
    const scrollTarget = manualScrollRestoration
      ? (forcedScroll ?? readScrollPosition(state) ?? { x: 0, y: 0 })
      : readScrollPosition(state);
    const result = await runNavigateClient(
      browserUrl,
      fullAppUrl,
      getPagesHtmlFetchUrl(browserUrl, effectiveLocale),
      { scroll: scrollTarget },
    );
    if (result === "completed") {
      routerEvents.emit("routeChangeComplete", fullAppUrl, { shallow: false });
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
 *
 * The PagesRouterCommitBoundary exists for client navigations: its onCommit
 * callback resolves the render-commit promise (so scroll restoration runs at
 * commit time) and its onError rejection drives the hard-navigation fallback
 * in runNavigateClient. The same boundary intentionally also wraps SSR and
 * initial hydration, where both callbacks default to noopCommit: a
 * hydration-time render error is caught here (React still console.error's
 * it) instead of propagating, matching the navigation-path containment.
 */
export function wrapWithRouterContext(
  element: ReactElement,
  onCommit: () => void = noopCommit,
  onError: (error: Error) => void = noopCommit,
): ReactElement {
  return createElement(
    PagesRouterCommitBoundary,
    { onCommit, onError },
    createElement(PagesRouterProvider, null, element),
  );
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
/**
 * Pages Router `components` map exposed on the singleton.
 *
 * In Next.js, `Router.components` doubles as (a) the cached `PrivateRouteInfo`
 * keyed by route pattern after a real page render, and (b) a marker store
 * (`{ __appRouter: true }`) for App Router routes detected via prefetch (see
 * `packages/next/src/shared/lib/router/router.ts:2525`). The Next.js deploy
 * test suite asserts the latter through `window.next.router.components`.
 *
 * vinext only writes the marker variant — the cached-page-info side is handled
 * by Vite's module graph + our own loader manifest — but the property must be
 * present and mutable so the deploy assertion can find it. The map lives
 * behind a `Symbol.for` global so the Link shim's Pages-mode prefetch branch
 * writes to the same instance even when Vite resolves the router shim and
 * the link shim through different module IDs.
 *
 * Issue: https://github.com/cloudflare/vinext/issues/1526
 */
const _components = getPagesRouterComponentsMap();

const RouterMethods = {
  /** See `_components` comment above for the dual role this map plays. */
  components: _components,
  push: (url: string | UrlObject, as?: string, options?: TransitionOptions) => {
    if (typeof window === "undefined") throwNoRouterInstance();
    // Synchronously guard dangerous URI schemes (javascript:, data:, vbscript:)
    // before the async performNavigation kicks off. Mirrors Next.js's
    // Pages Router `push` at packages/next/src/shared/lib/router/router.ts:1025-1033,
    // where the check runs synchronously inside push() so the throw bubbles up
    // through React's event-handler error reporter (surfacing console.error).
    // Without this synchronous hoist, the throw inside `performNavigation`
    // (an async function) becomes a rejected Promise that React does not
    // observe from an event handler that does not await it (e.g.
    // `<button onClick={() => router.push(...)}>`).
    assertSafeNavigationUrl(resolveUrl(url));
    if (as !== undefined) {
      assertSafeNavigationUrl(String(as));
    }
    return performNavigation(url, as, options, "push");
  },
  replace: (url: string | UrlObject, as?: string, options?: TransitionOptions) => {
    if (typeof window === "undefined") throwNoRouterInstance();
    // See `push` above for the rationale on the synchronous guard.
    assertSafeNavigationUrl(resolveUrl(url));
    if (as !== undefined) {
      assertSafeNavigationUrl(String(as));
    }
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
    isReady: {
      enumerable: true,
      get(): boolean {
        return isPagesRouterReady();
      },
    },
    isPreview: { enumerable: true, value: false, writable: false },
    isFallback: {
      enumerable: true,
      get(): boolean {
        if (typeof window === "undefined") return _getSSRContext()?.isFallback === true;
        return (window.__NEXT_DATA__ as VinextNextData | undefined)?.isFallback === true;
      },
    },
  }) as typeof RouterMethods & Omit<NextRouter, keyof typeof RouterMethods>;

// Deprecated event property bridging: when userland code does
// `Router.onRouteChangeComplete = handler` (the legacy Next.js pattern),
// the handler must be called whenever the corresponding event fires.
//
// For each known router event, register a listener that reads the deprecated
// `on<EventName>` property off the singleton and calls it if present.
//
// Ported from Next.js: packages/next/src/client/router.ts (lines 105–124).
// The reference implementation wraps this in `singletonRouter.ready()` so it
// runs after the router instance is created; vinext's routerEvents is a module-
// level singleton that exists from the start, so we can register directly.
// Registering unconditionally at module load (without a client-only guard) is
// safe here because every routerEvents.emit() call is already gated behind
// typeof window checks, so these listeners never fire in SSR contexts.
const deprecatedRouterEvents = [
  "routeChangeStart",
  "beforeHistoryChange",
  "routeChangeComplete",
  "routeChangeError",
  "hashChangeStart",
  "hashChangeComplete",
] as const;

for (const event of deprecatedRouterEvents) {
  const eventField = `on${event.charAt(0).toUpperCase()}${event.substring(1)}`;
  routerEvents.on(event, (...args: unknown[]) => {
    const handler = (Router as Record<string, unknown>)[eventField];
    if (typeof handler === "function") {
      try {
        (handler as (...a: unknown[]) => void)(...args);
      } catch (err) {
        console.error(`Error when running the Router event: ${eventField}`);
        console.error(err instanceof Error ? `${err.message}\n${err.stack}` : String(err));
      }
    }
  });
}

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
  // Match Next.js's Router constructor: stamp the initial history entry and
  // attach the popstate listener while next/router itself is evaluating,
  // before window.next.router is exposed to userland. This install is
  // intentionally unconditional at module eval — any value import of
  // next/router (even from an App Router app) triggers it, mirroring
  // Next.js where the Router singleton's constructor runs at module eval.
  // The one Pages-Router-only side effect it carries — flipping
  // `history.scrollRestoration` to "manual" under
  // `experimental.scrollRestoration` — is gated on the document not being
  // an App Router one (see installManualScrollRestoration).
  installPagesRouterRuntime();
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
