"use client";

/**
 * next/link shim
 *
 * Renders an <a> tag with client-side navigation support.
 * On click, prevents full page reload and triggers client-side
 * page swap via the router's navigation system.
 */
import React, {
  forwardRef,
  useCallback,
  useContext,
  createContext,
  useEffect,
  useRef,
  useState,
  type AnchorHTMLAttributes,
  type MouseEvent,
  type TouchEvent,
} from "react";
import type { UrlObject } from "node:url";
import {
  getNavigationRuntime,
  hasAppNavigationRuntime,
  registerNavigationRuntimeFunctions,
} from "../client/navigation-runtime.js";
import { isDangerousScheme, reportBlockedDangerousNavigation } from "./url-safety.js";
import {
  canLinkIntentPrefetch,
  canLinkPrefetch,
  getLinkPrefetchHref,
  type LinkPrefetchRouterMode,
} from "./link-prefetch.js";
import {
  isAbsoluteOrProtocolRelativeUrl,
  normalizePathTrailingSlash,
  toBrowserNavigationHref,
  toSameOriginAppPath,
  withBasePath,
} from "./url-utils.js";
import { appendSearchParamsToUrl, type UrlQuery, urlQueryToSearchParams } from "../utils/query.js";
import { addLocalePrefix, getDomainLocaleUrl, type DomainLocale } from "../utils/domain-locale.js";
import { getI18nContext } from "./i18n-context.js";
import type { VinextLinkPrefetchRoute, VinextNextData } from "../client/vinext-next-data.js";
import {
  navigatePagesRouterLinkWithFallback,
  resolvePagesRouterQueryOnlyHref,
} from "../client/pages-router-link-navigation.js";
import { createRouteTrieCache, matchRouteWithTrie } from "../routing/route-matching.js";
import { stripBasePath } from "../utils/base-path.js";
import { isBotUserAgent } from "../utils/html-limited-bots.js";
import {
  getPagesMiddlewareDataHref,
  prefetchPagesData,
  resolvePagesDataNavigationTarget,
} from "./internal/pages-data-target.js";
import { interpolateDynamicRouteHref, resolveDynamicRouteHref } from "./internal/interpolate-as.js";
import { markAppRouteDetectedOnPrefetch } from "./internal/app-route-detection.js";
import { RouterContext } from "./internal/router-context.js";
import { getCurrentBrowserLocale } from "./client-locale.js";
import {
  clearLinkForCurrentNavigation,
  notifyLinkNavigationStart,
  setLinkForCurrentNavigation,
  type PendingLinkSetter,
} from "./internal/link-status-registry.js";
import { getCurrentRoutePathnameForWarning } from "./internal/route-pattern-for-warning.js";
import { scheduleAppPrefetchFetch } from "./internal/app-prefetch-fetch-queue.js";

type NavigateEvent = {
  url: URL;
  /** Call to prevent the Link's default navigation (e.g. for View Transitions). */
  preventDefault(): void;
  /** Whether preventDefault() has been called. */
  defaultPrevented: boolean;
};

const HAS_PAGES_ROUTER = process.env.__VINEXT_HAS_PAGES_ROUTER !== "false";
const HAS_CLIENT_REWRITES = process.env.__VINEXT_HAS_CLIENT_REWRITES !== "false";

export type LinkProps<_RouteInferType = unknown> = {
  href: string | UrlObject;
  /** URL displayed in the browser (when href is a route pattern like /user/[id]) */
  as?: string | UrlObject;
  /** Replace the current history entry instead of pushing */
  replace?: boolean;
  /** Prefetch the page in the background (App Router default: auto, Pages Router default: true) */
  prefetch?: boolean | "auto" | null;
  /**
   * Unstable App Router option matching Next.js canary: an automatic prefetch
   * is upgraded to a full prefetch when the user shows navigation intent.
   */
  unstable_dynamicOnHover?: boolean;
  /** Whether to pass the href to the child element */
  passHref?: boolean;
  /**
   * Pre-Next.js-13 link behaviour. When true, <Link> expects its child to be
   * an `<a>` (or a component that renders one) and forwards `href`, click,
   * and prefetch handlers to the child via `React.cloneElement` instead of
   * rendering its own wrapping `<a>`. Required when the user wants to
   * style/instrument the anchor themselves.
   */
  legacyBehavior?: boolean;
  /** Scroll to top on navigation (default: true) */
  scroll?: boolean;
  /**
   * Pages Router: update the URL without re-running data fetching methods
   * (getServerSideProps / getStaticProps / getInitialProps). The shallow change
   * still triggers the route change events and updates `router.query`. Only
   * applies to navigations within the same page. No-op on the App Router.
   */
  shallow?: boolean;
  /** Locale for i18n (used for locale-prefixed URLs) */
  locale?: string | false;
  /** Called before navigation happens (Next.js 16). Return value is ignored. */
  onNavigate?: (event: { preventDefault(): void }) => void;
  transitionTypes?: string[];
  children?: React.ReactNode;
} & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href">;

type LinkPrefetchMode = "disabled" | "auto" | "full" | "full-after-shell";

declare global {
  // Window is an ambient interface from lib.dom; interface merging is required
  // for this global browser hook.
  // oxlint-disable-next-line typescript-eslint/consistent-type-definitions
  interface Window {
    __VINEXT_LINK_PREFETCH_ROUTES__?: VinextLinkPrefetchRoute[];
  }
}

// ---------------------------------------------------------------------------
// useLinkStatus — reports the pending state of a parent <Link> navigation
// ---------------------------------------------------------------------------

type LinkStatusContextValue = {
  pending: boolean;
};

const LinkStatusContext = createContext<LinkStatusContextValue>({ pending: false });

/**
 * useLinkStatus returns the pending state of the enclosing <Link>.
 * In Next.js, this is used to show loading indicators while a
 * prefetch-triggered navigation is in progress.
 */
export function useLinkStatus(): LinkStatusContextValue {
  return useContext(LinkStatusContext);
}

let linkPrefetchNavigationEpoch = 0;

function notifyLinkNavigationStartAndCancelPrefetchSetup(): void {
  linkPrefetchNavigationEpoch += 1;
  notifyLinkNavigationStart();
}

// Register the link-status reset hook on the navigation runtime as soon as this
// module evaluates on the client. `navigateClientSide` calls it at the start of
// every App Router navigation (including router.push and shallow routing), so a
// stale link's pending state is cleared even when no <Link> initiated the
// navigation. The registry itself lives in internal/link-status-registry.ts so
// it can be unit-tested without rendering a <Link>.
if (typeof window !== "undefined") {
  registerNavigationRuntimeFunctions({
    notifyLinkNavigationStart: notifyLinkNavigationStartAndCancelPrefetchSetup,
  });
}

/** basePath from next.config.js, injected by the plugin at build time */
const __basePath: string = process.env.__NEXT_ROUTER_BASEPATH ?? "";
/** trailingSlash from next.config.js, injected by the plugin at build time */
const __trailingSlash: boolean = process.env.__VINEXT_TRAILING_SLASH === "true";
const __prefetchInlining: boolean = process.env.__VINEXT_PREFETCH_INLINING === "true";
const linkPrefetchRouteTrieCache = createRouteTrieCache<VinextLinkPrefetchRoute>();

function resolveHref(href: LinkProps["href"]): string {
  if (typeof href === "string") return href;
  // When `pathname` is omitted, leave the base empty so the result is a
  // query-only href (e.g. `?params=foo`) rather than `/?params=foo`. Mirrors
  // Next.js's `formatUrl()` (`pathname = urlObj.pathname || ''`) so that a
  // `<Link href={{ query: {...} }} />` resolves against the *current* path at
  // navigation time instead of collapsing onto the site root. Defaulting to
  // "/" here recorded the wrong history entry for shallow links, breaking
  // back/forward traversal (issue #1540).
  let url = href.pathname ?? "";
  if (href.query) {
    const params = urlQueryToSearchParams(href.query as UrlQuery);
    url = appendSearchParamsToUrl(url, params);
  }
  if (href.hash) {
    url += href.hash.startsWith("#") ? href.hash : `#${href.hash}`;
  }
  return url;
}

function resolvePagesQueryOnlyHref(href: string): string {
  if (!HAS_PAGES_ROUTER) return href;
  if ((!href.startsWith("?") && !href.startsWith("#")) || typeof window === "undefined") {
    return href;
  }

  const pagesRouter = window.next?.appDir === true ? undefined : window.next?.router;
  const visibleHref =
    pagesRouter &&
    "reload" in pagesRouter &&
    "asPath" in pagesRouter &&
    typeof pagesRouter.asPath === "string"
      ? pagesRouter.asPath
      : undefined;
  return resolvePagesRouterQueryOnlyHref(href, {
    asPath: visibleHref,
    basePath: __basePath,
    fallbackHref: window.location.href,
    locales: window.__VINEXT_LOCALES__,
  });
}

function resolvePagesLinkNavigationHref(href: string, locale: string | false | undefined): string {
  return normalizePathTrailingSlash(
    applyLocaleToHref(resolvePagesQueryOnlyHref(href), locale),
    __trailingSlash,
  );
}

function applyPagesNavigationFallback(href: string, replace: boolean): void {
  if (replace) {
    window.history.replaceState({}, "", href);
  } else {
    window.history.pushState({}, "", href);
  }
  window.dispatchEvent(new PopStateEvent("popstate"));
}

/**
 * Collapse repeated forward-slashes (and convert backslashes to forward-slashes)
 * in the path portion of a URL, preserving any query string.
 *
 * Ported from Next.js: packages/next/src/shared/lib/utils/normalize-repeated-slashes.ts
 * https://github.com/vercel/next.js/blob/canary/packages/next/src/shared/lib/utils/normalize-repeated-slashes.ts
 */
function normalizeRepeatedSlashes(url: string): string {
  const urlParts = url.split("?");
  const urlNoQueryString = urlParts.shift() ?? "";
  const queryString = urlParts.join("?");
  return (
    urlNoQueryString.replace(/\\/g, "/").replace(/\/\/+/g, "/") +
    (queryString ? `?${queryString}` : "")
  );
}

/**
 * Emit Next.js's "Invalid href" `console.error` when `href` contains repeated
 * forward slashes or backslashes in its path portion, and return the
 * normalized URL (with `\\` converted to `/` and runs of `/` collapsed). If
 * the href is already well-formed, the original string is returned unchanged.
 *
 * Ported from Next.js: packages/next/src/client/resolve-href.ts
 * https://github.com/vercel/next.js/blob/canary/packages/next/src/client/resolve-href.ts
 *
 * Matches the message asserted by:
 * test/e2e/repeated-forward-slashes-error/repeated-forward-slashes-error.test.ts
 *
 * Note: Next.js fires this warning unconditionally on every call to
 * `resolveHref`. We mirror that behaviour (no dedup) for exact parity.
 *
 * Note: Next.js uses `router.pathname` (the route pattern, e.g.
 * `/posts/[id]`) for the "in page" segment of the message. The Next.js
 * compat test asserts this exact text (`in page: '/my/path/[name]'`), so we
 * source it from the current render's route pattern via
 * `getCurrentRoutePathnameForWarning()`: the Pages Router SSR context's route
 * pattern on the server, `window.location.pathname` on the client, falling
 * back to `"/"`.
 */
function warnAndNormalizeRepeatedSlashesInHref(urlAsString: string): string {
  // Protocol-relative URLs (e.g. "//example.com/path") are treated by vinext
  // as external — see `isAbsoluteOrProtocolRelativeUrl` in url-utils. We
  // intentionally skip the repeated-slash warning and normalization for them
  // so that locale prefixing and same-origin detection elsewhere in this
  // shim continue to receive the original href. (Next.js itself does flag
  // these, but our external-URL handling supersedes that behaviour.)
  if (urlAsString.startsWith("//")) return urlAsString;

  // Strip any protocol prefix (e.g. "https://") so we do not flag the
  // legitimate `//` that separates the scheme from the authority.
  const urlProtoMatch = urlAsString.match(/^[a-z][a-z0-9+.-]*:\/\//i);
  const urlAsStringNoProto = urlProtoMatch
    ? urlAsString.slice(urlProtoMatch[0].length)
    : urlAsString;
  const urlParts = urlAsStringNoProto.split("?", 1);
  if (!(urlParts[0] || "").match(/(\/\/|\\)/)) return urlAsString;

  const pathname = getCurrentRoutePathnameForWarning();
  console.error(
    `Invalid href '${urlAsString}' passed to next/router in page: '${pathname}'. Repeated forward-slashes (//) or backslashes \\ are not valid in the href.`,
  );

  const normalizedNoProto = normalizeRepeatedSlashes(urlAsStringNoProto);
  return (urlProtoMatch ? urlProtoMatch[0] : "") + normalizedNoProto;
}

export function resolveLinkPrefetchMode(
  prefetchProp: LinkProps["prefetch"],
  isDangerous: boolean,
): LinkPrefetchMode {
  if (isDangerous || prefetchProp === false) return "disabled";
  if (prefetchProp === true) return "full";
  return "auto";
}

function toSameOriginRouteHref(href: string): string | null {
  if (typeof window === "undefined") return null;

  let url: URL;
  try {
    url = new URL(href, window.location.href);
  } catch {
    return null;
  }

  if (url.origin !== window.location.origin) return null;

  return `${stripBasePath(url.pathname, __basePath)}${url.search}`;
}

function getLinkPrefetchRouterMode(): LinkPrefetchRouterMode {
  return hasAppNavigationRuntime() ? "app" : "pages";
}

function resolveMatchedAutoAppRoutePrefetch(route: VinextLinkPrefetchRoute): {
  cacheForNavigation: boolean;
  prefetchShellFirst: boolean;
  shouldPrefetch: boolean;
} {
  const hasLoadingShell = route.canPrefetchLoadingShell;
  return {
    // Automatic prefetches are only unsafe as authoritative navigation
    // payloads for dynamic routes whose active parallel branches must be
    // derived from the click-time target tree. Other concrete dynamic URLs can
    // match Next.js's full-prefetch behavior, including client-param routes.
    cacheForNavigation: !hasLoadingShell && route.requiresDynamicNavigationRequest !== true,
    prefetchShellFirst: !route.isDynamic,
    shouldPrefetch: true,
  };
}

export function canAutoPrefetchFullAppRoute(href: string): boolean {
  if (typeof window === "undefined") return false;

  const routes = window.__VINEXT_LINK_PREFETCH_ROUTES__;
  if (!routes) return false;

  const routeHref = toSameOriginRouteHref(href);
  if (routeHref === null) return false;

  const match = matchRouteWithTrie(routeHref, routes, linkPrefetchRouteTrieCache);
  if (!match) return false;

  return resolveAutoAppRoutePrefetch(href).cacheForNavigation;
}

export function resolveAutoAppRoutePrefetch(href: string): {
  cacheForNavigation: boolean;
  prefetchShellFirst: boolean;
  shouldPrefetch: boolean;
} {
  if (typeof window === "undefined") {
    return { cacheForNavigation: false, prefetchShellFirst: false, shouldPrefetch: false };
  }

  const routes = window.__VINEXT_LINK_PREFETCH_ROUTES__;
  if (!routes) {
    return { cacheForNavigation: false, prefetchShellFirst: false, shouldPrefetch: false };
  }

  const routeHref = toSameOriginRouteHref(href);
  if (routeHref === null) {
    return { cacheForNavigation: false, prefetchShellFirst: false, shouldPrefetch: false };
  }

  const match = matchRouteWithTrie(routeHref, routes, linkPrefetchRouteTrieCache);
  if (!match) {
    return { cacheForNavigation: false, prefetchShellFirst: false, shouldPrefetch: false };
  }

  const prefetch = resolveMatchedAutoAppRoutePrefetch(match.route);
  const url = new URL(routeHref, "http://vinext.local");
  if (url.search !== "") {
    return {
      ...prefetch,
      cacheForNavigation: false,
      prefetchShellFirst: true,
    };
  }

  return prefetch;
}

function resolveFullAppRoutePrefetch(): {
  cacheForNavigation: true;
  prefetchShellFirst: boolean;
  shouldPrefetch: true;
} {
  return {
    cacheForNavigation: true,
    prefetchShellFirst: true,
    shouldPrefetch: true,
  };
}

// ---------------------------------------------------------------------------
// Prefetching infrastructure
// ---------------------------------------------------------------------------

/**
 * Prefetch a URL for faster navigation.
 *
 * For App Router (RSC): fetches the .rsc payload in the background and
 * stores it in an in-memory cache for instant use during navigation.
 * For Pages Router: warms the page chunk, prefetches data only for SSG pages,
 * and falls back to a document prefetch hint when no page loader matches.
 *
 * App Router and high-priority prefetches start immediately. Low-priority
 * Pages Router fallback prefetches use `requestIdleCallback` (or `setTimeout`
 * fallback) to avoid blocking the main thread during initial page load.
 */
function prefetchUrl(
  href: string,
  mode: LinkPrefetchMode,
  priority: "low" | "high" = "low",
  pagesRouteHref?: string,
  locale?: string | false,
): void {
  if (typeof window === "undefined") return;
  const navigationEpoch = linkPrefetchNavigationEpoch;

  const prefetchHref = getLinkPrefetchHref({
    href,
    basePath: __basePath,
    currentOrigin: window.location.origin,
  });
  if (prefetchHref == null) return;

  const fullHref = toBrowserNavigationHref(prefetchHref, window.location.href, __basePath);
  const routePrefetchHref =
    pagesRouteHref === undefined
      ? prefetchHref
      : (getLinkPrefetchHref({
          href: pagesRouteHref,
          basePath: __basePath,
          currentOrigin: window.location.origin,
        }) ?? prefetchHref);
  const fullRouteHref = toBrowserNavigationHref(
    routePrefetchHref,
    window.location.href,
    __basePath,
  );
  const target = new URL(fullHref, window.location.href);
  if (
    target.origin === window.location.origin &&
    target.pathname === window.location.pathname &&
    target.search === window.location.search
  ) {
    return;
  }

  const runPrefetch = () => {
    void (async () => {
      if (hasAppNavigationRuntime()) {
        if (isBotUserAgent(window.navigator?.userAgent ?? "")) return;

        const [
          navigation,
          { AppElementsWire },
          rscCacheBusting,
          {
            APP_RSC_RENDER_MODE_PREFETCH_DYNAMIC_SHELL,
            APP_RSC_RENDER_MODE_PREFETCH_LOADING_SHELL,
          },
          headersModule,
          hybridRouteOwner,
        ] = await Promise.all([
          import("./navigation.js"),
          import("../server/app-elements.js"),
          import("../server/app-rsc-cache-busting.js"),
          import("../server/app-rsc-render-mode.js"),
          import("../server/headers.js"),
          HAS_PAGES_ROUTER || HAS_CLIENT_REWRITES
            ? import("./internal/hybrid-client-route-owner.js")
            : null,
        ]);
        // A pointer-intent prefetch and its click navigation can start in the
        // same event turn. If navigation won the module-loading race, do not
        // begin a second request after it consumes an equivalent cached route.
        if (navigationEpoch !== linkPrefetchNavigationEpoch) return;
        const {
          getPrefetchInterceptionContext,
          getPrefetchCache,
          getPrefetchedUrls,
          getMountedSlotsHeader,
          hasSearchAgnosticPrefetchShellForRoute,
          hasPrefetchCacheEntryForNavigation,
          peekPrefetchResponseForNavigation,
          prefetchRscResponse,
          restoreRscResponse,
          PREFETCH_CACHE_TTL,
        } = navigation;
        const { createRscRequestHeaders, createRscRequestUrl } = rscCacheBusting;
        const {
          NEXT_ROUTER_PREFETCH_HEADER,
          NEXT_ROUTER_SEGMENT_PREFETCH_HEADER,
          VINEXT_MOUNTED_SLOTS_HEADER,
        } = headersModule;
        // Hybrid ownership: skip the App RSC prefetch when Pages owns the
        // URL. The App's `__VINEXT_LINK_PREFETCH_ROUTES__` may include an
        // App catch-all that also matches the same path, so a naive
        // prefetch would fetch an RSC stream for a Pages route — that
        // stream is never consumed (the click path now hard-navigates to
        // Pages) and would also race the request the browser will issue on
        // the actual navigation.
        const hybridOwner = HAS_PAGES_ROUTER
          ? hybridRouteOwner!.resolveHybridClientRouteOwner(prefetchHref, __basePath)
          : null;
        if (hybridOwner === "pages" || hybridOwner === "document") {
          return;
        }
        const rewrittenPrefetchHref = HAS_CLIENT_REWRITES
          ? hybridRouteOwner!.resolveHybridClientRewriteHref(fullHref, __basePath)
          : null;
        const prefetchPolicyHref = rewrittenPrefetchHref ?? prefetchHref;
        const autoPrefetch =
          mode === "auto"
            ? resolveAutoAppRoutePrefetch(prefetchPolicyHref)
            : mode === "full-after-shell"
              ? { cacheForNavigation: true, prefetchShellFirst: true, shouldPrefetch: true }
              : resolveFullAppRoutePrefetch();
        if (!autoPrefetch.shouldPrefetch) return;

        const interceptionContext = getPrefetchInterceptionContext(fullHref);
        const mountedSlotsHeader = getMountedSlotsHeader();
        const isOptimisticRouteShellPrefetch = !autoPrefetch.cacheForNavigation;
        const hasSearchParams = new URL(fullHref, window.location.href).search !== "";
        const isAutomaticSearchParamShell =
          mode === "auto" && isOptimisticRouteShellPrefetch && hasSearchParams;
        const hasSearchAgnosticShell =
          isAutomaticSearchParamShell &&
          hasSearchAgnosticPrefetchShellForRoute(
            await createRscRequestUrl(fullHref, new Headers()),
            interceptionContext,
            mountedSlotsHeader,
          );
        const headers = createRscRequestHeaders({
          interceptionContext,
          renderMode: isOptimisticRouteShellPrefetch
            ? hasSearchAgnosticShell
              ? APP_RSC_RENDER_MODE_PREFETCH_LOADING_SHELL
              : isAutomaticSearchParamShell
                ? APP_RSC_RENDER_MODE_PREFETCH_DYNAMIC_SHELL
                : APP_RSC_RENDER_MODE_PREFETCH_LOADING_SHELL
            : undefined,
        });
        if (mountedSlotsHeader) {
          headers.set(VINEXT_MOUNTED_SLOTS_HEADER, mountedSlotsHeader);
        }
        const shouldSendSegmentPrefetchHeaders = isOptimisticRouteShellPrefetch || mode === "auto";
        if (__prefetchInlining && autoPrefetch.cacheForNavigation) {
          headers.set(NEXT_ROUTER_PREFETCH_HEADER, "1");
          headers.set(NEXT_ROUTER_SEGMENT_PREFETCH_HEADER, "/__PAGE__");
        } else if (shouldSendSegmentPrefetchHeaders) {
          headers.set(NEXT_ROUTER_PREFETCH_HEADER, "1");
          headers.set(NEXT_ROUTER_SEGMENT_PREFETCH_HEADER, "1");
        }
        // Distinguish the same visible URL when it is prefetched from different
        // request contexts such as /feed vs /gallery or different mounted slots.
        const rscUrl = await createRscRequestUrl(fullHref, headers);
        const additionalRscUrls =
          rewrittenPrefetchHref && rewrittenPrefetchHref !== fullHref
            ? [await createRscRequestUrl(rewrittenPrefetchHref, headers)]
            : [];
        const cacheKey = AppElementsWire.encodeCacheKey(rscUrl, interceptionContext);
        const prefetched = getPrefetchedUrls();
        if (prefetched.has(cacheKey)) {
          if (!autoPrefetch.cacheForNavigation) {
            return;
          }

          const existing = getPrefetchCache().get(cacheKey);
          if (existing?.cacheForNavigation === false) {
            existing.cacheForNavigation = true;
          }
        }
        const fetchFullRscPayload = () =>
          scheduleAppPrefetchFetch(
            () =>
              fetch(rscUrl, {
                headers,
                credentials: "include",
                priority,
                // @ts-expect-error — purpose is a valid fetch option in some browsers
                purpose: "prefetch",
              }),
            priority,
          );
        const fetchLoadingShellForReuse = async (): Promise<void> => {
          const shellHeaders = createRscRequestHeaders({
            interceptionContext,
            renderMode: APP_RSC_RENDER_MODE_PREFETCH_LOADING_SHELL,
          });
          shellHeaders.set(NEXT_ROUTER_PREFETCH_HEADER, "1");
          shellHeaders.set(NEXT_ROUTER_SEGMENT_PREFETCH_HEADER, "1");
          if (mountedSlotsHeader) {
            shellHeaders.set(VINEXT_MOUNTED_SLOTS_HEADER, mountedSlotsHeader);
          }
          const shellRscUrl = await createRscRequestUrl(fullHref, shellHeaders);
          const shellCacheKey = AppElementsWire.encodeCacheKey(shellRscUrl, interceptionContext);
          const shellCache = getPrefetchCache();
          let shellEntry = shellCache.get(shellCacheKey);
          if (shellEntry === undefined) {
            getPrefetchedUrls().add(shellCacheKey);
            prefetchRscResponse(
              shellRscUrl,
              scheduleAppPrefetchFetch(
                () =>
                  fetch(shellRscUrl, {
                    headers: shellHeaders,
                    credentials: "include",
                    priority,
                    // @ts-expect-error — purpose is a valid fetch option in some browsers
                    purpose: "prefetch",
                  }),
                priority,
              ),
              interceptionContext,
              mountedSlotsHeader,
              undefined,
              {
                cacheForNavigation: false,
                optimisticRouteShell: true,
                prefetchKind: "loading-shell",
              },
            );
            shellEntry = shellCache.get(shellCacheKey);
          }
          await shellEntry?.pending?.catch(() => {});
        };
        const fetchAliasCacheHitProbe = async (): Promise<Response> => {
          const probeHeaders = createRscRequestHeaders({
            interceptionContext,
            renderMode: APP_RSC_RENDER_MODE_PREFETCH_LOADING_SHELL,
          });
          probeHeaders.set(NEXT_ROUTER_PREFETCH_HEADER, "1");
          probeHeaders.set(NEXT_ROUTER_SEGMENT_PREFETCH_HEADER, "1");
          if (mountedSlotsHeader) {
            probeHeaders.set(VINEXT_MOUNTED_SLOTS_HEADER, mountedSlotsHeader);
          }
          const probeRscUrl = await createRscRequestUrl(fullHref, probeHeaders);
          return fetch(probeRscUrl, {
            method: "HEAD",
            headers: probeHeaders,
            credentials: "include",
            priority,
            // @ts-expect-error — purpose is a valid fetch option in some browsers
            purpose: "prefetch",
          });
        };
        const hasExactNavigationCacheEntry =
          autoPrefetch.cacheForNavigation &&
          hasPrefetchCacheEntryForNavigation(rscUrl, interceptionContext, mountedSlotsHeader);
        const hasNavigationCacheEntry =
          hasExactNavigationCacheEntry ||
          (autoPrefetch.cacheForNavigation &&
            hasPrefetchCacheEntryForNavigation(rscUrl, interceptionContext, mountedSlotsHeader, {
              additionalRscUrls,
            }));
        // A single freshness-aware gate covers both an exact prior prefetch and
        // an equivalent `_rsc` variant; the helper also deletes any stale exact
        // entry, so a stale `prefetched` member is harmlessly re-added below.
        if (hasNavigationCacheEntry) {
          if (
            !hasExactNavigationCacheEntry &&
            !prefetched.has(cacheKey) &&
            additionalRscUrls.length > 0 &&
            autoPrefetch.prefetchShellFirst &&
            mountedSlotsHeader === null
          ) {
            prefetched.add(cacheKey);
            void fetchAliasCacheHitProbe()
              .then((response) => response.arrayBuffer())
              .catch(() => {});
          }
          return;
        }
        prefetched.add(cacheKey);
        // Next's `prefetchInlining` Segment Cache path fetches a route tree
        // and then one inlined segment payload. Vinext still caches the unified
        // route payload for navigation, but keeps the same two-stage request
        // timing so duplicate visible links see the full payload as already
        // pending while tests/userland can still observe the later data fetch.
        const gateViaRouteTree =
          __prefetchInlining && mode === "auto" && autoPrefetch.prefetchShellFirst;
        const gateViaExplicitSearchShell =
          mode === "full" &&
          hasSearchParams &&
          autoPrefetch.prefetchShellFirst &&
          mountedSlotsHeader === null;
        const gateViaLoadingShell =
          (mode === "full-after-shell" || gateViaExplicitSearchShell) &&
          autoPrefetch.prefetchShellFirst;
        const fetchPromise =
          autoPrefetch.cacheForNavigation && (gateViaRouteTree || gateViaLoadingShell)
            ? (async () => {
                if (gateViaLoadingShell) {
                  await fetchLoadingShellForReuse();
                  return fetchFullRscPayload();
                }
                const shellHeaders = createRscRequestHeaders({
                  interceptionContext,
                  renderMode: undefined,
                });
                shellHeaders.set(NEXT_ROUTER_PREFETCH_HEADER, "1");
                shellHeaders.set(NEXT_ROUTER_SEGMENT_PREFETCH_HEADER, "/_tree");
                if (mountedSlotsHeader) {
                  shellHeaders.set(VINEXT_MOUNTED_SLOTS_HEADER, mountedSlotsHeader);
                }
                const shellRscUrl = await createRscRequestUrl(fullHref, shellHeaders);
                const shellCacheKey = AppElementsWire.encodeCacheKey(
                  shellRscUrl,
                  interceptionContext,
                );
                const shellCache = getPrefetchCache();
                let shellEntry = shellCache.get(shellCacheKey);
                if (shellEntry === undefined) {
                  getPrefetchedUrls().add(shellCacheKey);
                  prefetchRscResponse(
                    shellRscUrl,
                    scheduleAppPrefetchFetch(
                      () =>
                        fetch(shellRscUrl, {
                          headers: shellHeaders,
                          credentials: "include",
                          priority,
                          // @ts-expect-error — purpose is a valid fetch option in some browsers
                          purpose: "prefetch",
                        }),
                      priority,
                    ),
                    interceptionContext,
                    mountedSlotsHeader,
                    undefined,
                    {
                      cacheForNavigation: false,
                      optimisticRouteShell: false,
                      prefetchKind: "route-tree",
                    },
                  );
                  shellEntry = shellCache.get(shellCacheKey);
                }
                await shellEntry?.pending?.catch(() => {});
                const renderedPathAndSearch = shellEntry?.snapshot?.renderedPathAndSearch;
                if (renderedPathAndSearch) {
                  const renderedRscUrl = await createRscRequestUrl(renderedPathAndSearch, headers);
                  const cachedRenderedResponse = peekPrefetchResponseForNavigation(
                    renderedRscUrl,
                    interceptionContext,
                    mountedSlotsHeader,
                  );
                  if (cachedRenderedResponse) {
                    return restoreRscResponse(cachedRenderedResponse);
                  }
                }
                return scheduleAppPrefetchFetch(
                  () =>
                    fetch(rscUrl, {
                      headers,
                      credentials: "include",
                      priority,
                      // @ts-expect-error — purpose is a valid fetch option in some browsers
                      purpose: "prefetch",
                    }),
                  priority,
                );
              })()
            : fetchFullRscPayload();
        if (
          mode === "full" &&
          autoPrefetch.cacheForNavigation &&
          autoPrefetch.prefetchShellFirst &&
          mountedSlotsHeader === null &&
          !gateViaExplicitSearchShell
        ) {
          void fetchLoadingShellForReuse();
        }
        prefetchRscResponse(
          rscUrl,
          fetchPromise,
          interceptionContext,
          mountedSlotsHeader,
          undefined,
          {
            cacheForNavigation: autoPrefetch.cacheForNavigation,
            fallbackTtlMs: PREFETCH_CACHE_TTL,
            optimisticRouteShell: isOptimisticRouteShellPrefetch,
            prefetchKind: isOptimisticRouteShellPrefetch ? "loading-shell" : "navigation",
            searchAgnosticShell: isAutomaticSearchParamShell && !hasSearchAgnosticShell,
          },
        );
      } else if (HAS_PAGES_ROUTER && window.__NEXT_DATA__) {
        // Pages Router prefetch. When a code-split loader is registered for
        // the target route (prod builds expose them on window via the
        // generated client entry), warm the page chunk and prefetch data JSON
        // only for SSG routes. Otherwise (dev, or unmapped route) fall back
        // to the legacy `<link rel="prefetch" as="document">` so the browser
        // still preloads the HTML.
        //
        // The decision helper + prefetch action live in shims/internal/ so
        // this file does not pull in the router shim at module init time,
        // which would create a circular import and grow the SSR module graph.
        const dataTarget = resolvePagesDataNavigationTarget(fullRouteHref, __basePath, { locale });
        if (dataTarget) {
          const middlewareDataHref =
            fullRouteHref === fullHref
              ? dataTarget.middlewareDataHref
              : (getPagesMiddlewareDataHref(fullHref, __basePath) ?? undefined);
          prefetchPagesData({ ...dataTarget, middlewareDataHref });
        } else {
          // The target is not a Pages Router route — mark it on the Pages
          // Router `components` map if it matches an App Router route in the
          // shared prefetch manifest. Mirrors Next.js's `_bfl` marker write at
          // `packages/next/src/shared/lib/router/router.ts:2525`; the Next.js
          // deploy test reads `window.next.router.components[<path>]` to
          // assert prefetch detection. See issue #1526.
          await markAppRouteDetectedOnPrefetch(fullHref, __basePath);

          // Legacy fallback: hint the browser to preload the HTML document.
          // Used in dev (no loader map populated) and for routes not in the
          // client loader map.
          const link = document.createElement("link");
          link.rel = "prefetch";
          link.href = fullHref;
          link.as = "document";
          document.head.appendChild(link);
        }
      }
    })().catch((error) => {
      console.error("[vinext] RSC prefetch setup error:", error);
    });
  };

  if (priority === "high" || hasAppNavigationRuntime()) {
    runPrefetch();
    return;
  }

  const schedule = window.requestIdleCallback ?? ((fn: () => void) => setTimeout(fn, 100));
  schedule(runPrefetch);
}

async function promotePrefetchEntriesForNavigation(href: string): Promise<void> {
  if (typeof window === "undefined") return;
  if (!hasAppNavigationRuntime()) return;
  const [{ getPrefetchCache }, { stripRscCacheBustingSearchParam, stripRscSuffix }] =
    await Promise.all([import("./navigation.js"), import("../server/app-rsc-cache-busting.js")]);

  let target: URL;
  try {
    target = new URL(
      toBrowserNavigationHref(href, window.location.href, __basePath),
      window.location.href,
    );
  } catch {
    return;
  }

  for (const [cacheKey, entry] of getPrefetchCache()) {
    if (entry.optimisticRouteShell === true) continue;
    if (entry.prefetchKind === "route-tree") continue;

    const [rscUrl] = cacheKey.split("\0", 1);
    let cached: URL;
    try {
      cached = new URL(rscUrl, window.location.href);
    } catch {
      continue;
    }
    stripRscCacheBustingSearchParam(cached);
    if (stripRscSuffix(cached.pathname) === target.pathname && cached.search === target.search) {
      entry.cacheForNavigation = true;
    }
  }
}

/**
 * Shared IntersectionObserver for viewport-based prefetching.
 * All Link elements use the same observer to minimize resource usage.
 */
let sharedObserver: IntersectionObserver | null = null;
type LinkPrefetchInstance = {
  href: string;
  isVisible: boolean;
  locale?: string | false;
  mode: LinkPrefetchMode;
  pagesRouteHref?: string;
  queuedViewportPrefetch: boolean;
  routerMode: LinkPrefetchRouterMode;
  viewportPrefetched: boolean;
};

const observedLinkPrefetches = new WeakMap<Element, LinkPrefetchInstance>();
const visibleLinkPrefetches = new Set<LinkPrefetchInstance>();
const visibleAppPrefetchQueue: LinkPrefetchInstance[] = [];
let visibleAppPrefetchDrainScheduled = false;

function drainVisibleAppPrefetchQueue(): void {
  visibleAppPrefetchDrainScheduled = false;
  while (true) {
    const instance = visibleAppPrefetchQueue.pop();
    if (!instance) return;
    instance.queuedViewportPrefetch = false;
    if (!instance.isVisible || instance.routerMode !== "app") continue;
    prefetchUrl(instance.href, instance.mode, "low", instance.pagesRouteHref);
  }
}

function scheduleVisibleAppPrefetch(instance: LinkPrefetchInstance): void {
  if (instance.queuedViewportPrefetch) return;
  instance.queuedViewportPrefetch = true;
  visibleAppPrefetchQueue.push(instance);
  if (visibleAppPrefetchDrainScheduled) return;
  visibleAppPrefetchDrainScheduled = true;
  queueMicrotask(drainVisibleAppPrefetchQueue);
}

function setVisibleLinkPrefetch(instance: LinkPrefetchInstance, isVisible: boolean): void {
  instance.isVisible = isVisible;
  if (isVisible) {
    visibleLinkPrefetches.add(instance);
    if (instance.routerMode === "pages" && instance.viewportPrefetched) return;
    if (instance.routerMode === "app") {
      scheduleVisibleAppPrefetch(instance);
    } else {
      prefetchUrl(instance.href, instance.mode, "low", instance.pagesRouteHref, instance.locale);
    }
    instance.viewportPrefetched = true;
  } else {
    visibleLinkPrefetches.delete(instance);
  }
}

function registerVisibleLinkPing(): void {
  if (typeof window === "undefined") return;
  registerNavigationRuntimeFunctions({ pingVisibleLinks: pingVisibleLinkPrefetches });
}

function pingVisibleLinkPrefetches(): void {
  for (const instance of visibleLinkPrefetches) {
    if (instance.isVisible && instance.routerMode === "app") {
      scheduleVisibleAppPrefetch(instance);
    }
  }
}

function getSharedObserver(): IntersectionObserver | null {
  if (typeof window === "undefined" || typeof IntersectionObserver === "undefined") return null;
  if (sharedObserver) return sharedObserver;

  sharedObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const instance = observedLinkPrefetches.get(entry.target);
        if (!instance) continue;
        setVisibleLinkPrefetch(instance, entry.isIntersecting || entry.intersectionRatio > 0);
      }
    },
    {
      // Start prefetching when the link is within 250px of the viewport.
      // This gives the browser a head start before the user scrolls to it.
      rootMargin: "250px",
    },
  );

  return sharedObserver;
}

function getDefaultLocale(): string | undefined {
  if (typeof window !== "undefined") {
    return window.__VINEXT_DEFAULT_LOCALE__;
  }
  return getI18nContext()?.defaultLocale;
}

function getCurrentLocale(): string | undefined {
  if (typeof window !== "undefined") {
    return getCurrentBrowserLocale({
      basePath: __basePath,
      domainLocales: getDomainLocales(),
      hostname: getCurrentHostname(),
    });
  }
  return getI18nContext()?.locale;
}

function getDomainLocales(): readonly DomainLocale[] | undefined {
  if (typeof window !== "undefined") {
    return (window.__NEXT_DATA__ as VinextNextData | undefined)?.domainLocales;
  }
  return getI18nContext()?.domainLocales;
}

function getCurrentHostname(): string | undefined {
  if (typeof window !== "undefined") return window.location.hostname;
  return getI18nContext()?.hostname;
}

function getDomainLocaleHref(href: string, locale: string): string | undefined {
  // Only cross-domain locale switches need a special absolute URL here.
  // Same-domain cases fall back to the standard locale-prefix logic below.
  return getDomainLocaleUrl(href, locale, {
    basePath: __basePath,
    currentHostname: getCurrentHostname(),
    domainItems: getDomainLocales(),
  });
}

function addLocalePrefixForRoot(href: string, locale: string): string | undefined {
  if (href !== "/" && !href.startsWith("/?") && !href.startsWith("/#")) {
    return undefined;
  }

  let parsed: URL;
  try {
    parsed = new URL(href, "http://vinext.local");
  } catch {
    return undefined;
  }

  if (parsed.origin !== "http://vinext.local" || parsed.pathname !== "/") {
    return undefined;
  }

  return `/${locale}${parsed.search}${parsed.hash}`;
}

/**
 * Apply locale prefix to a URL path based on the locale prop.
 * - locale="fr" → prepend /fr (unless it already has a locale prefix)
 * - locale={false} → use the href as-is (no locale prefix, link to default)
 * - locale=undefined → use current locale (href as-is in most cases)
 */
function applyLocaleToHref(href: string, locale: string | false | undefined): string {
  if (locale === false) {
    // Explicit false: no locale prefix
    return href;
  }

  const resolvedLocale = locale ?? getCurrentLocale();
  if (resolvedLocale === undefined) {
    return href;
  }

  // Absolute and protocol-relative URLs must not be prefixed — locale
  // only applies to local paths.
  if (isAbsoluteOrProtocolRelativeUrl(href)) {
    return href;
  }

  const domainLocaleHref = getDomainLocaleHref(href, resolvedLocale);
  if (domainLocaleHref) {
    return domainLocaleHref;
  }

  const defaultLocale = getDefaultLocale() ?? "";
  if (resolvedLocale.toLowerCase() === defaultLocale.toLowerCase()) {
    const localeRootHref = addLocalePrefixForRoot(href, resolvedLocale);
    if (localeRootHref) return localeRootHref;
  }

  return addLocalePrefix(href, resolvedLocale, defaultLocale);
}

/**
 * For the `<Link href="/blog/[slug]" as="/blog/test-post">` case, project the
 * bracket-pattern href + the resolved `as` back into a concrete route URL the
 * Pages Router can fetch (`/blog/test-post`). Returns null when:
 *   - `href` has no bracket params (already concrete; the existing forwarding
 *     path works as-is)
 *   - interpolation fails because a required param could not be resolved
 *     (caller falls back to `as`, matching pre-PR behavior)
 *
 * The query for interpolation is the href's own query — `as` is the matcher
 * input rather than the source of param values. For string hrefs the search
 * portion is parsed into the query record; for object hrefs we take
 * `href.query` directly.
 */
function resolveConcreteRouteHref(href: LinkProps["href"], as: string | undefined): string | null {
  if (typeof as !== "string") return null;
  const hrefStr = typeof href === "string" ? href : resolveHref(href);
  const projection = interpolateDynamicRouteHref(
    hrefStr,
    as,
    typeof href === "string" || !href.query || typeof href.query === "string"
      ? undefined
      : (href.query as UrlQuery),
  );
  return projection?.href || null;
}

const Link = forwardRef<HTMLAnchorElement, LinkProps>(function Link(
  {
    href,
    as,
    replace = false,
    prefetch: prefetchProp,
    scroll = true,
    shallow = false,
    children: childrenProp,
    onClick,
    onMouseEnter,
    onTouchStart,
    onNavigate,
    unstable_dynamicOnHover = false,
    legacyBehavior = false,
    passHref = false,
    transitionTypes: _transitionTypes,
    ...rest
  },
  forwardedRef,
) {
  const pagesRouter = useContext(RouterContext);
  const asHref = as === undefined ? undefined : resolveHref(as);
  const hrefStr = resolveHref(href);
  // Extract locale from rest props
  const { locale, ...restWithoutLocale } = rest;

  // Next.js parity: in legacyBehavior, a string or number child is wrapped in
  // a plain <a> so the cloneElement path below has an element to clone. The
  // wrapper anchor receives the forwarded href + handlers from Link.
  // Ported from Next.js: packages/next/src/client/link.tsx (around line 334)
  // https://github.com/vercel/next.js/blob/canary/packages/next/src/client/link.tsx
  let children: React.ReactNode = childrenProp;
  if (legacyBehavior && (typeof childrenProp === "string" || typeof childrenProp === "number")) {
    children = React.createElement("a", null, childrenProp);
  }

  // If `as` is provided, use it as the actual URL (legacy Next.js pattern
  // where href is a route pattern like "/user/[id]" and as is "/user/1").
  // Pages Router object hrefs with dynamic segments implicitly derive the
  // same pair: the bracket-pattern href is retained for the router while the
  // interpolated URL is rendered and displayed. This is gated on the mounted
  // Pages Router context because App Router intentionally rejects dynamic
  // href patterns instead of interpolating them.
  // The rendered anchor / prefetch / locale / trailingSlash / basePath math
  // all run on the display value below; a concrete route-pattern href is
  // retained as `routeHrefRaw` so the Pages Router click branch can forward
  // the (href, as) pair to `router.push/replace` and preserve upstream
  // semantics (popstate fetches by href; same-asPath clicks coerce to
  // replaceState). When `as` is absent, routeHrefRaw === rawResolvedHref.
  //
  // Dynamic-route case: when `href` is a bracket pattern like "/blog/[slug]"
  // and `as` is the resolved display URL, the raw `href` itself is NOT
  // server-routable — the Pages Router data endpoint and HTML fetch would
  // both target `/_next/data/<id>/blog/[slug].json` and `/blog/[slug]`. Run
  // it through the Next.js `interpolateAs` helper (extracts params from `as`
  // when href and as differ, otherwise falls back to the href's own query)
  // to get a concrete URL the router can fetch. If interpolation fails (a
  // required param could not be resolved), fall back to `as` so behavior
  // matches the pre-PR documented use of `as` as the navigation target.
  // Mirrors Next.js' Router.change(): `getRouteRegex` + `interpolateAs`
  // computes `resolvedAs` for the dynamic-route branch (packages/next/src/
  // shared/lib/router/router.ts around L987).
  const hrefForImplicitInterpolation = isAbsoluteOrProtocolRelativeUrl(hrefStr)
    ? hrefStr.startsWith("//")
      ? null
      : toSameOriginAppPath(hrefStr, __basePath)
    : hrefStr;
  const implicitDynamicRouteHref =
    HAS_PAGES_ROUTER &&
    pagesRouter !== null &&
    asHref === undefined &&
    hrefForImplicitInterpolation !== null
      ? resolveDynamicRouteHref(hrefForImplicitInterpolation)
      : null;
  const dynamicRouteHref = implicitDynamicRouteHref
    ? { ...implicitDynamicRouteHref, href: hrefStr }
    : null;
  const pagesAsHref = asHref ?? dynamicRouteHref?.as;
  const unresolvedHref = pagesAsHref ?? hrefStr;
  const rawResolvedHref =
    typeof unresolvedHref === "string" && unresolvedHref.startsWith("#")
      ? resolvePagesQueryOnlyHref(unresolvedHref)
      : unresolvedHref;
  const concreteRouteHref = HAS_PAGES_ROUTER
    ? resolveConcreteRouteHref(
        dynamicRouteHref ? (hrefForImplicitInterpolation ?? href) : href,
        pagesAsHref,
      )
    : null;
  const routeHrefRaw = dynamicRouteHref?.href ?? concreteRouteHref ?? hrefStr;
  const prefetchRouteHrefRaw = concreteRouteHref ?? routeHrefRaw;
  const hasPagesHrefAsPair =
    HAS_PAGES_ROUTER &&
    typeof pagesAsHref === "string" &&
    typeof routeHrefRaw === "string" &&
    pagesAsHref !== routeHrefRaw;

  // Mirror Next.js: emit a console.error when the href contains repeated
  // forward-slashes (e.g. "/foo//bar") or backslashes, and then normalize the
  // href so navigation targets the collapsed path rather than the raw one.
  // See packages/next/src/client/resolve-href.ts.
  const resolvedHref =
    typeof rawResolvedHref === "string"
      ? warnAndNormalizeRepeatedSlashesInHref(rawResolvedHref)
      : rawResolvedHref;

  const isDangerous = typeof resolvedHref === "string" && isDangerousScheme(resolvedHref);

  // Apply locale prefix if specified (safe even for dangerous hrefs since we
  // won't use the result when isDangerous is true)
  const localizedHref = applyLocaleToHref(isDangerous ? "/" : resolvedHref, locale);
  // Normalise trailing slash to match `trailingSlash` config so that rendered
  // hrefs avoid the redirect bounce. Mirrors Next.js's `addLocale`/`addBasePath`,
  // both of which run `normalizePathTrailingSlash` after prefixing — we apply
  // it once after locale prefixing (for prefetch/navigation paths that bypass
  // basePath) and again after `withBasePath` for the rendered `href` attribute.
  const normalizedHref = normalizePathTrailingSlash(localizedHref, __trailingSlash);
  const normalizedRouteHref = hasPagesHrefAsPair
    ? normalizePathTrailingSlash(
        applyLocaleToHref(isDangerous ? "/" : prefetchRouteHrefRaw, locale),
        __trailingSlash,
      )
    : normalizedHref;
  // Full href with basePath for browser URLs and fetches, normalised again so
  // that combining a non-empty basePath with the bare root (`/`) still
  // produces a canonical href under `trailingSlash: false` (e.g. `/foo`
  // rather than `/foo/`).
  const fullHref = normalizePathTrailingSlash(
    withBasePath(normalizedHref, __basePath),
    __trailingSlash,
  );

  // Track pending state for useLinkStatus()
  const [pending, setPending] = useState(false);
  const mountedRef = useRef(true);
  // Stable setter so the global navigation registry can reset this link's
  // pending state from another navigation without depending on render identity.
  const setPendingRef = useRef<PendingLinkSetter | null>(null);
  if (setPendingRef.current === null) {
    setPendingRef.current = (next: boolean) => {
      if (mountedRef.current) setPending(next);
    };
  }
  useEffect(() => {
    mountedRef.current = true;
    const setter = setPendingRef.current;
    return () => {
      mountedRef.current = false;
      // Drop our setter from the global registry on unmount so a later
      // navigation never calls into an unmounted component.
      if (setter) clearLinkForCurrentNavigation(setter);
    };
  }, []);

  // Prefetching: observe the element when it enters the viewport.
  // In App Router, null/undefined/"auto" is automatic prefetch and true opts
  // into a full RSC prefetch, matching Next.js's public prefetch contract.
  const internalRef = useRef<HTMLAnchorElement | null>(null);
  const prefetchMode = resolveLinkPrefetchMode(prefetchProp, isDangerous);
  const shouldViewportPrefetch = canLinkPrefetch({
    nodeEnv: process.env.NODE_ENV,
    prefetch: prefetchProp,
    isDangerous,
  });

  const setRefs = useCallback(
    (node: HTMLAnchorElement | null) => {
      internalRef.current = node;
      if (typeof forwardedRef === "function") forwardedRef(node);
      else if (forwardedRef)
        (forwardedRef as React.MutableRefObject<HTMLAnchorElement | null>).current = node;
    },
    [forwardedRef],
  );

  useEffect(() => {
    if (!shouldViewportPrefetch || typeof window === "undefined") return;
    const node = internalRef.current;
    if (!node) return;

    const hrefToPrefetch = getLinkPrefetchHref({
      href: normalizedHref,
      basePath: __basePath,
      currentOrigin: window.location.origin,
    });
    if (hrefToPrefetch == null) return;

    const observer = getSharedObserver();
    if (!observer) return;

    registerVisibleLinkPing();
    const instance: LinkPrefetchInstance = {
      href: hrefToPrefetch,
      isVisible: false,
      locale,
      mode: prefetchMode,
      pagesRouteHref:
        normalizedRouteHref === normalizedHref
          ? undefined
          : (getLinkPrefetchHref({
              href: normalizedRouteHref,
              basePath: __basePath,
              currentOrigin: window.location.origin,
            }) ?? undefined),
      queuedViewportPrefetch: false,
      routerMode: getLinkPrefetchRouterMode(),
      viewportPrefetched: false,
    };
    observedLinkPrefetches.set(node, instance);
    observer.observe(node);

    return () => {
      observer.unobserve(node);
      observedLinkPrefetches.delete(node);
      visibleLinkPrefetches.delete(instance);
      instance.isVisible = false;
    };
  }, [shouldViewportPrefetch, prefetchMode, normalizedHref, normalizedRouteHref, locale]);

  const prefetchOnIntent = useCallback(() => {
    if (
      !canLinkIntentPrefetch({
        nodeEnv: process.env.NODE_ENV,
        prefetch: prefetchProp,
        isDangerous,
        routerMode: getLinkPrefetchRouterMode(),
      })
    ) {
      return;
    }
    const intentMode = unstable_dynamicOnHover ? "full-after-shell" : prefetchMode;
    if (unstable_dynamicOnHover && internalRef.current) {
      const instance = observedLinkPrefetches.get(internalRef.current);
      if (instance) {
        instance.mode = "full-after-shell";
      }
      void promotePrefetchEntriesForNavigation(normalizedHref);
    }
    prefetchUrl(
      normalizedHref,
      intentMode,
      "high",
      normalizedRouteHref === normalizedHref ? undefined : normalizedRouteHref,
      locale,
    );
  }, [
    prefetchProp,
    isDangerous,
    prefetchMode,
    normalizedHref,
    normalizedRouteHref,
    locale,
    unstable_dynamicOnHover,
  ]);

  const handleMouseEnter = useCallback(
    (e: MouseEvent<HTMLAnchorElement>) => {
      onMouseEnter?.(e);
      prefetchOnIntent();
    },
    [onMouseEnter, prefetchOnIntent],
  );

  const handleTouchStart = useCallback(
    (e: TouchEvent<HTMLAnchorElement>) => {
      onTouchStart?.(e);
      prefetchOnIntent();
    },
    [onTouchStart, prefetchOnIntent],
  );

  const handleClick = async (
    e: MouseEvent<HTMLAnchorElement>,
    options: { skipLinkOnClick?: boolean } = {},
  ) => {
    // In legacyBehavior, the onClick prop on <Link> itself is ignored — the
    // child's onClick is the one that runs (and Next.js even warns when
    // `onClick` is passed to <Link> alongside `legacyBehavior`). Skip the
    // preamble that calls Link's own onClick when invoked from that path.
    // See: .nextjs-ref/packages/next/src/client/link.tsx (legacyBehavior branch).
    if (!options.skipLinkOnClick && onClick) onClick(e);
    if (e.defaultPrevented) return;

    // Native download links must keep the browser's default behavior.
    if (e.currentTarget.hasAttribute("download")) {
      return;
    }

    // Only intercept left clicks without modifiers (standard link behavior)
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
      return;
    }

    // Don't intercept links with target (e.g. target="_blank")
    if (e.currentTarget.target && e.currentTarget.target !== "_self") {
      return;
    }

    // External links: let the browser handle it.
    // Same-origin absolute URLs (e.g. http://localhost:3000/about) are
    // normalized to local paths so they get client-side navigation.
    let navigateHref = normalizedHref;
    if (isAbsoluteOrProtocolRelativeUrl(resolvedHref)) {
      const localPath = toSameOriginAppPath(resolvedHref, __basePath);
      if (localPath == null) {
        // Truly external. Mirror Next.js `linkClicked`: when `replace` is set
        // we have to take over because the browser's default click navigation
        // pushes to history rather than replacing the current entry.
        // See `.nextjs-ref/packages/next/src/client/link.tsx` `linkClicked`.
        if (replace) {
          e.preventDefault();
          window.location.replace(resolvedHref);
        }
        return;
      }
      navigateHref = localPath;
    }

    e.preventDefault();

    const hasAppNavigationRuntime = Boolean(getNavigationRuntime()?.functions.navigate);
    const pagesNavigateHref =
      HAS_PAGES_ROUTER && resolvedHref.startsWith("?")
        ? resolvePagesLinkNavigationHref(resolvedHref, locale)
        : navigateHref;
    // When the Link author passed both `href` (route pattern) AND `as` (mask),
    // forward the original route-pattern href to Pages Router as the `url`
    // argument. The router uses `url` to fetch the page module / data, while
    // `as` drives the address bar — matching upstream Next.js Link → Router
    // semantics. When no mask is present, leave `pagesAsForLink` undefined so
    // existing single-arg navigation (the dominant code path) is unaffected.
    const pagesAsForLink = hasPagesHrefAsPair ? pagesNavigateHref : undefined;
    const pagesHrefForLink = pagesAsForLink === undefined ? pagesNavigateHref : routeHrefRaw;
    // Resolve relative hrefs (#hash, ?query) for onNavigate and the navigation fallback.
    // Pages query-only links must use the rewrite-aware target resolved above,
    // so callbacks and router-error fallback agree with the actual navigation.
    const absoluteFullHref = toBrowserNavigationHref(
      hasAppNavigationRuntime ? navigateHref : pagesNavigateHref,
      window.location.href,
      __basePath,
    );

    // Call onNavigate callback if provided (Next.js 16 View Transitions support)
    if (onNavigate) {
      try {
        const navUrl = new URL(absoluteFullHref, window.location.origin);
        let prevented = false;
        const navEvent: NavigateEvent = {
          url: navUrl,
          preventDefault() {
            prevented = true;
          },
          get defaultPrevented() {
            return prevented;
          },
        };
        onNavigate(navEvent);
        // If the callback called preventDefault(), skip Link's default navigation.
        // The callback is responsible for its own navigation (e.g. via View Transitions API).
        if (navEvent.defaultPrevented) {
          return;
        }
      } catch {
        // Ignore URL parsing errors for relative/hash hrefs
      }
    }

    // Hybrid ownership check: when the App Router runtime is installed and
    // the target URL is owned by the Pages Router, soft-navigating with RSC
    // would either (a) hit the App catch-all, or (b) bounce off
    // `renderPagesFallback` returning null for RSC requests. Either way the
    // user lands on the wrong route. Pages only renders HTML documents or
    // `_next/data` JSON, so the only correct path is a document navigation.
    //
    // We compare ownership here, not in `navigateClientSide`, because the
    // document navigation is committed synchronously by the browser — there
    // is no RSC stream to suspend on, so the soft-navigation bookkeeping
    // (`setPending`, `setLinkForCurrentNavigation`) would be a no-op at best
    // and a stale `useLinkStatus` indicator at worst.
    const hybridOwner =
      HAS_PAGES_ROUTER && hasAppNavigationRuntime
        ? (await import("./internal/hybrid-client-route-owner.js")).resolveHybridClientRouteOwner(
            navigateHref,
            __basePath,
          )
        : null;
    if (
      HAS_PAGES_ROUTER &&
      hasAppNavigationRuntime &&
      ["pages", "document"].includes(hybridOwner ?? "")
    ) {
      if (replace) {
        window.location.replace(absoluteFullHref);
      } else {
        window.location.assign(absoluteFullHref);
      }
      return;
    }

    // App Router: delegate to navigateClientSide which handles scroll save,
    // hash-only changes, RSC fetch, and two-phase URL commit.
    if (hasAppNavigationRuntime) {
      const { navigateClientSide } = await import("./navigation.js");
      const setter = setPendingRef.current;
      // Register this link as the one driving the current navigation. This
      // resets any previously-pending link (e.g. a different link clicked
      // moments earlier) so only the last-clicked link shows a pending state.
      if (setter) setLinkForCurrentNavigation(setter);
      setPending(true);
      React.startTransition(() => {
        void navigateClientSide(navigateHref, replace ? "replace" : "push", scroll, true).finally(
          () => {
            if (mountedRef.current) setPending(false);
            if (setter) clearLinkForCurrentNavigation(setter);
          },
        );
      });
      return;
    } else if (HAS_PAGES_ROUTER) {
      // Next.js only consumes onRouterTransitionStart in the App Router.
      // Pages Router still executes instrumentation-client side effects
      // during startup, but it does not invoke the named export on navigation.
      // Pages Router: use the Router singleton
      const Router = window.next?.appDir === true ? undefined : window.next?.router;
      const pagesRouter = Router && "reload" in Router ? Router : undefined;
      await navigatePagesRouterLinkWithFallback({
        router: pagesRouter,
        loadRouter: async () => (await import("next/router")).default,
        navigation: {
          href: pagesHrefForLink,
          as: pagesAsForLink,
          replace,
          scroll,
          shallow,
          locale,
          interpolateDynamicRoute: resolvedHref.startsWith("?"),
        },
        fallback: () => applyPagesNavigationFallback(absoluteFullHref, replace),
      });
    } else if (replace) {
      window.location.replace(absoluteFullHref);
    } else {
      window.location.assign(absoluteFullHref);
    }
  };

  const anchorProps = restWithoutLocale;

  const linkStatusValue = React.useMemo(() => ({ pending }), [pending]);

  // Block dangerous URI schemes (javascript:, data:, vbscript:).
  // Render an inert <a> without href to prevent XSS while preserving
  // styling, refs, and developer event handlers like onClick.
  // This check is placed after all hooks to satisfy the Rules of Hooks.
  if (isDangerous) {
    if (process.env.NODE_ENV !== "production") {
      console.warn(`<Link> blocked dangerous href: ${resolvedHref}`);
    }
    // Match Next.js parity: when a user clicks a Link whose href has a
    // dangerous scheme, emit the same `console.error` that Next.js surfaces
    // via React's event-handler runtime when `router.push` throws.
    // Ported from Next.js: test/e2e/app-dir/javascript-urls/javascript-urls.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/javascript-urls/javascript-urls.test.ts
    const handleDangerousClick = (event: MouseEvent<HTMLAnchorElement>): void => {
      if (onClick) onClick(event);
      reportBlockedDangerousNavigation();
    };
    // In legacyBehavior, clone the child instead of wrapping it in our own
    // <a>. Otherwise the dangerous-href branch would still produce nested
    // anchors. We do not forward the dangerous href to the child — Next.js's
    // safety guarantee is that the navigation never happens; the child can
    // keep its own (sanitized) href if it wants.
    if (legacyBehavior) {
      const child = React.Children.only(children) as React.ReactElement<{
        onClick?: (event: MouseEvent<HTMLAnchorElement>) => void;
        ref?: React.Ref<HTMLAnchorElement>;
      }>;
      const childOnClick = child.props.onClick;
      const childRef = child.props.ref;
      const setDangerousRefs = (node: HTMLAnchorElement | null): void => {
        internalRef.current = node;
        if (typeof childRef === "function") {
          childRef(node);
        } else if (childRef) {
          (childRef as React.MutableRefObject<HTMLAnchorElement | null>).current = node;
        }
      };
      return (
        <LinkStatusContext.Provider value={linkStatusValue}>
          {React.cloneElement(child, {
            ref: setDangerousRefs,
            onClick: (event: MouseEvent<HTMLAnchorElement>) => {
              if (childOnClick) childOnClick(event);
              reportBlockedDangerousNavigation();
            },
          })}
        </LinkStatusContext.Provider>
      );
    }
    return (
      <LinkStatusContext.Provider value={linkStatusValue}>
        <a
          ref={setRefs}
          onClick={handleDangerousClick}
          onMouseEnter={handleMouseEnter}
          onTouchStart={handleTouchStart}
          {...anchorProps}
        >
          {children}
        </a>
      </LinkStatusContext.Provider>
    );
  }

  // Next.js parity: in legacyBehavior, forward href/handlers to the single
  // child via React.cloneElement instead of wrapping in our own <a>. This
  // avoids the nested-anchor markup that broke onClick propagation and
  // produced duplicated/hidden child content (issue #1469).
  //
  // Ported from Next.js: packages/next/src/client/link.tsx (around line 499)
  // https://github.com/vercel/next.js/blob/canary/packages/next/src/client/link.tsx
  if (legacyBehavior) {
    const child = React.Children.only(children) as React.ReactElement<{
      href?: string;
      ref?: React.Ref<HTMLAnchorElement>;
      onClick?: (event: MouseEvent<HTMLAnchorElement>) => void;
      onMouseEnter?: (event: MouseEvent<HTMLAnchorElement>) => void;
      onTouchStart?: (event: TouchEvent<HTMLAnchorElement>) => void;
    }>;
    if (process.env.NODE_ENV !== "production") {
      if (onClick) {
        console.warn(
          `"onClick" was passed to <Link> with \`href\` of \`${resolveHref(href)}\` but "legacyBehavior" was set. The legacy behavior requires onClick be set on the child of next/link`,
        );
      }
      if (onMouseEnter) {
        console.warn(
          `"onMouseEnter" was passed to <Link> with \`href\` of \`${resolveHref(href)}\` but "legacyBehavior" was set. The legacy behavior requires onMouseEnter be set on the child of next/link`,
        );
      }
    }
    const childPropsExisting = child.props;
    // Use `'href' in props` (matches Next.js) so `href={undefined}` on the
    // child is treated as "the child owns its href" — we won't overwrite it.
    const childHasOwnHref = child.type === "a" ? "href" in childPropsExisting : false;
    // Match Next.js: forward href when `passHref` is set OR the child is a
    // plain <a> that does not already have an href. Otherwise, leave the
    // child's href alone.
    const shouldForwardHref = passHref || (child.type === "a" && !childHasOwnHref);
    const childOnClick = childPropsExisting.onClick;
    const childOnMouseEnter = childPropsExisting.onMouseEnter;
    const childOnTouchStart = childPropsExisting.onTouchStart;
    // Mirror Next.js: in legacy mode, the ref source is the child's own
    // ref (e.g. `<a ref={myRef}>`), not Link's `forwardedRef`. In React 19
    // `ref` is a regular prop on the element. Merge with our intersection
    // observer ref via `setRefs` so prefetching still works.
    const childRef = childPropsExisting.ref;
    const setLegacyRefs = (node: HTMLAnchorElement | null): void => {
      internalRef.current = node;
      if (typeof childRef === "function") {
        childRef(node);
      } else if (childRef) {
        (childRef as React.MutableRefObject<HTMLAnchorElement | null>).current = node;
      }
    };
    const clonedProps: Record<string, unknown> = {
      ref: setLegacyRefs,
      onClick: (event: MouseEvent<HTMLAnchorElement>) => {
        // Next.js parity: only the child's onClick runs in legacy mode. The
        // onClick prop on <Link> is intentionally ignored (and a dev warning
        // surfaces it above).
        if (childOnClick) childOnClick(event);
        if (event.defaultPrevented) return;
        return handleClick(event, { skipLinkOnClick: true });
      },
      onMouseEnter: (event: MouseEvent<HTMLAnchorElement>) => {
        if (childOnMouseEnter) childOnMouseEnter(event);
        prefetchOnIntent();
      },
      onTouchStart: (event: TouchEvent<HTMLAnchorElement>) => {
        if (childOnTouchStart) childOnTouchStart(event);
        prefetchOnIntent();
      },
    };
    if (shouldForwardHref) {
      clonedProps.href = fullHref;
    }
    return (
      <LinkStatusContext.Provider value={linkStatusValue}>
        {React.cloneElement(child, clonedProps)}
      </LinkStatusContext.Provider>
    );
  }

  return (
    <LinkStatusContext.Provider value={linkStatusValue}>
      <a
        ref={setRefs}
        href={fullHref}
        onClick={handleClick as React.MouseEventHandler<HTMLAnchorElement>}
        onMouseEnter={handleMouseEnter}
        onTouchStart={handleTouchStart}
        {...anchorProps}
      >
        {children}
      </a>
    </LinkStatusContext.Provider>
  );
});

export default Link;
