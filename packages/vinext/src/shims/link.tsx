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
  useLayoutEffect,
  useRef,
  useState,
  type AnchorHTMLAttributes,
  type MouseEvent,
  type TouchEvent,
} from "react";
import type { UrlObject } from "node:url";
import {
  getNavigationRuntime,
  isNavigationRuntimeFunctions,
  loadNavigationRuntimeRouteManifest,
  NAVIGATION_RUNTIME_KEY,
  registerNavigationRuntimeFunctions,
  type NavigationRuntime,
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
  toCanonicalBrowserNavigationHref,
  toSameOriginAppPath,
  withBasePath,
} from "./url-utils.js";
import { addLocalePrefix, getDomainLocaleUrl, type DomainLocale } from "../utils/domain-locale.js";
import { getI18nContext } from "./i18n-context.js";
import type { VinextLinkPrefetchRoute, VinextNextData } from "../client/vinext-next-data.js";
import {
  navigatePagesRouterLinkWithFallback,
  resolvePagesRouterQueryOnlyHref,
} from "../client/pages-router-link-navigation.js";
import { isBotUserAgent } from "../utils/html-limited-bots.js";
import {
  getPagesMiddlewareDataHref,
  prefetchPagesData,
  resolvePagesDataNavigationTarget,
} from "./internal/pages-data-target.js";
import { interpolateDynamicRouteHref, resolveDynamicRouteHref } from "./internal/interpolate-as.js";
import { markAppRouteDetectedOnPrefetch } from "./internal/app-route-detection.js";
import {
  canAutoPrefetchFullAppRoute,
  resolveAutoAppRoutePrefetch,
  resolveFullAppRoutePrefetch,
} from "./internal/app-route-prefetch-policy.js";
import { RouterContext } from "./internal/router-context.js";
import { getCurrentBrowserLocale } from "./client-locale.js";
import {
  clearLinkForCurrentNavigation,
  notifyLinkNavigationStart,
  setLinkForCurrentNavigation,
  type PendingLinkSetter,
} from "./internal/link-status-registry.js";
import { getCurrentRoutePathnameForWarning } from "./internal/route-pattern-for-warning.js";
import { normalizeRouterHref, resolvePagesRouterHref } from "./internal/normalize-router-href.js";
import { formatUrlObject, formatUrlObjectWithValidation } from "./internal/format-url-object.js";
import {
  cancelQueuedAppPrefetchFetch,
  getAppPrefetchFetchClaimSequence,
  isAppPrefetchFetchClaimed,
  scheduleAppPrefetchFetch,
} from "./internal/app-prefetch-fetch-queue.js";

type NavigateEvent = {
  url: URL;
  /** Call to prevent the Link's default navigation (e.g. for View Transitions). */
  preventDefault(): void;
  /** Whether preventDefault() has been called. */
  defaultPrevented: boolean;
};

const HAS_PAGES_ROUTER = process.env.__VINEXT_HAS_PAGES_ROUTER !== "false";
const isServer = typeof window === "undefined";
const HAS_CLIENT_REWRITES = process.env.__VINEXT_HAS_CLIENT_REWRITES !== "false";

type NavigationModule = typeof import("./navigation.js");
type HybridClientRouteOwnerModule = typeof import("./internal/hybrid-client-route-owner.js");

let loadedNavigationModule: NavigationModule | null = null;
let navigationModulePromise: Promise<NavigationModule> | null = null;
let loadedHybridClientRouteOwnerModule: HybridClientRouteOwnerModule | null = null;
let hybridClientRouteOwnerModulePromise: Promise<HybridClientRouteOwnerModule> | null = null;

function loadNavigationModule(): Promise<NavigationModule> {
  return (navigationModulePromise ??= import("./navigation.js").then((module) => {
    loadedNavigationModule = module;
    return module;
  }));
}

function loadHybridClientRouteOwnerModule(): Promise<HybridClientRouteOwnerModule> {
  return (hybridClientRouteOwnerModulePromise ??=
    import("./internal/hybrid-client-route-owner.js").then((module) => {
      loadedHybridClientRouteOwnerModule = module;
      return module;
    }));
}

type AppRscCacheBustingModule = typeof import("../server/app-rsc-cache-busting.js");
type AppPrefetchModules = [
  typeof import("../server/app-elements.js"),
  AppRscCacheBustingModule,
  typeof import("./internal/app-prefetch-rsc-request.js"),
  typeof import("../server/app-rsc-render-mode.js"),
  typeof import("../server/headers.js"),
];

let appRscCacheBustingModulePromise: Promise<AppRscCacheBustingModule> | null = null;
let appPrefetchModulesPromise: Promise<AppPrefetchModules> | null = null;

// Production builds wrap each dynamic import() in Vite's preload helper, which
// queries the document for a CSP nonce on every call. Cache the promises so
// each Link prefetch reuses them instead of paying that DOM scan again.
function loadAppRscCacheBustingModule(): Promise<AppRscCacheBustingModule> {
  return (appRscCacheBustingModulePromise ??= import("../server/app-rsc-cache-busting.js"));
}

function loadAppPrefetchModules(): Promise<AppPrefetchModules> {
  return (appPrefetchModulesPromise ??= Promise.all([
    import("../server/app-elements.js"),
    loadAppRscCacheBustingModule(),
    import("./internal/app-prefetch-rsc-request.js"),
    import("../server/app-rsc-render-mode.js"),
    import("../server/headers.js"),
  ]));
}

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

function resolveHref(href: LinkProps["href"], validate = false): string {
  if (typeof href === "string") return href;
  return validate ? formatUrlObjectWithValidation(href) : formatUrlObject(href);
}

function resolvePagesLinkValue(
  value: LinkProps["href"],
  pagesRouter: React.ContextType<typeof RouterContext>,
): string {
  const formatted = resolveHref(value, pagesRouter !== null);
  if (pagesRouter === null) return formatted;
  if (
    typeof pagesRouter.pathname === "string" &&
    typeof pagesRouter.asPath === "string" &&
    !formatted.startsWith("?") &&
    !formatted.startsWith("#")
  ) {
    return resolvePagesRouterHref(formatted, pagesRouter, __basePath);
  }
  return normalizeRouterHref(formatted, getCurrentRoutePathnameForWarning());
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

export function resolveLinkPrefetchMode(
  prefetchProp: LinkProps["prefetch"],
  isDangerous: boolean,
): LinkPrefetchMode {
  if (isDangerous || prefetchProp === false) return "disabled";
  if (prefetchProp === true) return "full";
  return "auto";
}

// Re-exported so the public test surface of this shim is unchanged after the
// policy helpers moved to internal/app-route-prefetch-policy.ts.
export { canAutoPrefetchFullAppRoute, resolveAutoAppRoutePrefetch };

let validatedNavigationRuntime: NavigationRuntime | null = null;
let validatedNavigationRuntimeBootstrap: unknown = null;
let validatedNavigationRuntimeFunctions: unknown = null;

/**
 * `hasAppNavigationRuntime()` for Link, which asks on every render and every
 * prefetch. Full validation walks the whole navigation runtime, including every
 * inline RSC chunk still held by the bootstrap, so skip it while window still
 * holds the runtime that last passed it with the same bootstrap and function
 * table objects. Registering either replaces that object, and a replaced
 * runtime, bootstrap or table falls through to full validation. A table edited
 * in place keeps its identity, so the function table is still checked on every
 * call (it is cheap); chunks streamed into the held bootstrap are not
 * revalidated.
 */
function hasLinkAppNavigationRuntime(): boolean {
  if (typeof window === "undefined") return false;
  const runtime = validatedNavigationRuntime;
  if (
    runtime !== null &&
    Reflect.get(window, NAVIGATION_RUNTIME_KEY) === runtime &&
    runtime.bootstrap === validatedNavigationRuntimeBootstrap &&
    runtime.functions === validatedNavigationRuntimeFunctions
  ) {
    const functions: unknown = runtime.functions;
    return isNavigationRuntimeFunctions(functions) && typeof functions.navigate === "function";
  }
  const validated = getNavigationRuntime();
  validatedNavigationRuntime = validated;
  validatedNavigationRuntimeBootstrap = validated?.bootstrap ?? null;
  validatedNavigationRuntimeFunctions = validated?.functions ?? null;
  return typeof validated?.functions.navigate === "function";
}

function getLinkPrefetchRouterMode(): LinkPrefetchRouterMode {
  return hasLinkAppNavigationRuntime() ? "app" : "pages";
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
 *
 * `owner` is the visible Link behind a viewport prefetch; see
 * `OwnedLinkPrefetch`.
 */
function prefetchUrl(
  href: string,
  mode: LinkPrefetchMode,
  priority: "low" | "high" = "low",
  pagesRouteHref?: string,
  locale?: string | false,
  owner?: LinkPrefetchInstance,
): void {
  if (typeof window === "undefined") return;
  const navigationEpoch = linkPrefetchNavigationEpoch;

  const prefetchHref = getLinkPrefetchHref({
    href,
    basePath: __basePath,
    currentOrigin: window.location.origin,
  });
  if (prefetchHref == null) return;

  const fullHref = toCanonicalBrowserNavigationHref(
    prefetchHref,
    window.location.href,
    __basePath,
    __trailingSlash,
  );
  const routePrefetchHref =
    pagesRouteHref === undefined
      ? prefetchHref
      : (getLinkPrefetchHref({
          href: pagesRouteHref,
          basePath: __basePath,
          currentOrigin: window.location.origin,
        }) ?? prefetchHref);
  const fullRouteHref = toCanonicalBrowserNavigationHref(
    routePrefetchHref,
    window.location.href,
    __basePath,
    __trailingSlash,
  );
  const target = new URL(fullHref, window.location.href);
  if (
    target.origin === window.location.origin &&
    target.pathname === window.location.pathname &&
    target.search === window.location.search
  ) {
    return;
  }
  if (
    mode === "auto" &&
    priority === "low" &&
    target.origin === window.location.origin &&
    target.pathname === window.location.pathname &&
    target.search !== window.location.search &&
    target.hash !== ""
  ) {
    // Match Next.js's same-page query+hash behavior: the visible Link does not
    // issue its query RSC request during viewport prefetch. The click remains
    // authoritative and fetches the changed search state before scrolling.
    return;
  }

  const runPrefetch = () => {
    void (async () => {
      if (hasLinkAppNavigationRuntime()) {
        if (isBotUserAgent(window.navigator?.userAgent ?? "")) return;

        const [
          navigation,
          [
            { AppElementsWire },
            rscCacheBusting,
            { resolveAppPrefetchRscRequest },
            {
              APP_RSC_RENDER_MODE_PREFETCH_DYNAMIC_SHELL,
              APP_RSC_RENDER_MODE_PREFETCH_LOADING_SHELL,
            },
            headersModule,
          ],
          hybridRouteOwner,
          routeManifestLoaded,
        ] = await Promise.all([
          loadNavigationModule(),
          loadAppPrefetchModules(),
          HAS_PAGES_ROUTER || HAS_CLIENT_REWRITES ? loadHybridClientRouteOwnerModule() : null,
          // getPrefetchInterceptionContext below reads the RouteManifest.
          // Without it the prefetch would miss its interception context.
          loadNavigationRuntimeRouteManifest(),
        ]);
        if (routeManifestLoaded === false) return;
        // A pointer-intent prefetch and its click navigation can start in the
        // same event turn. If navigation won the module-loading race, do not
        // begin a second request after it consumes an equivalent cached route.
        if (navigationEpoch !== linkPrefetchNavigationEpoch) return;
        const {
          getPrefetchInterceptionContext,
          getPrefetchCache,
          getPrefetchedUrls,
          getMountedSlotsHeader,
          createAppPrefetchRequestHeaders,
          discardLearningOnlyPrefetchCacheEntry,
          fetchRouteTreeGatedPrefetch,
          hasFreshLearningOnlyPrefetchCacheEntry,
          hasSearchAgnosticPrefetchShellForRoute,
          hasPrefetchCacheEntryForNavigation,
          prefetchRscResponse,
          prepareNavigationPrefetchSnapshot,
          DYNAMIC_NAVIGATION_CACHE_TTL,
          PREFETCH_CACHE_TTL,
        } = navigation;
        const { createRscRequestUrl } = rscCacheBusting;
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
        const interceptionContext = getPrefetchInterceptionContext(fullHref);
        const mountedSlotsHeader = getMountedSlotsHeader();
        const autoPrefetch =
          mode === "auto"
            ? resolveAutoAppRoutePrefetch(prefetchPolicyHref)
            : resolveFullAppRoutePrefetch();
        if (!autoPrefetch.shouldPrefetch) return;

        const isOptimisticRouteShellPrefetch = !autoPrefetch.cacheForNavigation;
        const hasSearchParams = new URL(fullHref, window.location.href).search !== "";
        const isAutomaticSearchParamShell =
          mode === "auto" && isOptimisticRouteShellPrefetch && hasSearchParams;
        // A prefetch never renders the page of a route that renders
        // dynamically, so its search-param href fetches the loading shell.
        const hasSearchAgnosticShell =
          isAutomaticSearchParamShell &&
          (autoPrefetch.rendersDynamically === true ||
            hasSearchAgnosticPrefetchShellForRoute(
              await createRscRequestUrl(fullHref, new Headers()),
              interceptionContext,
              mountedSlotsHeader,
            ));
        const headers = createAppPrefetchRequestHeaders({
          interceptionContext,
          fetchPriority: priority,
          prefetchKind: mode === "full" ? "full" : "auto",
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
        const requiresRouteTreePrefetch = autoPrefetch.requiresRouteTreePrefetch === true;
        if (
          (__prefetchInlining || requiresRouteTreePrefetch) &&
          mode === "auto" &&
          autoPrefetch.cacheForNavigation
        ) {
          headers.set(NEXT_ROUTER_PREFETCH_HEADER, "1");
          headers.set(NEXT_ROUTER_SEGMENT_PREFETCH_HEADER, "/__PAGE__");
        } else if (shouldSendSegmentPrefetchHeaders) {
          headers.set(NEXT_ROUTER_PREFETCH_HEADER, "1");
          headers.set(NEXT_ROUTER_SEGMENT_PREFETCH_HEADER, "1");
        }
        const { additionalRscUrls, rscUrl } = await resolveAppPrefetchRscRequest({
          fullHref,
          headers,
          rewrittenPrefetchHref,
        });
        if (navigationEpoch !== linkPrefetchNavigationEpoch) return;
        const cacheKey = AppElementsWire.encodeCacheKey(rscUrl, interceptionContext);
        const prefetched = getPrefetchedUrls();
        // The exact request is still fresh as a learning-only prefetch,
        // including a full prefetch kept that way because its page rendered
        // dynamically.
        if (hasFreshLearningOnlyPrefetchCacheEntry(rscUrl, interceptionContext)) {
          joinOwnedLinkPrefetch(getPrefetchCache().get(cacheKey)?.fetchPromise, owner);
          return;
        }
        if (autoPrefetch.cacheForNavigation) {
          discardLearningOnlyPrefetchCacheEntry(rscUrl, interceptionContext);
        }
        const owned = createOwnedLinkPrefetch(owner);
        const fetchFullRscPayload = () =>
          scheduleOwnedLinkPrefetch(
            owned,
            (signal) =>
              fetch(rscUrl, {
                headers,
                credentials: "include",
                priority,
                signal,
                // @ts-expect-error — purpose is a valid fetch option in some browsers
                purpose: "prefetch",
              }),
            priority,
          );
        const fetchLoadingShellForReuse = async (): Promise<void> => {
          const shellHeaders = createAppPrefetchRequestHeaders({
            interceptionContext,
            fetchPriority: priority,
            renderMode: APP_RSC_RENDER_MODE_PREFETCH_LOADING_SHELL,
          });
          shellHeaders.set(NEXT_ROUTER_PREFETCH_HEADER, "1");
          shellHeaders.set(NEXT_ROUTER_SEGMENT_PREFETCH_HEADER, "1");
          if (mountedSlotsHeader) {
            shellHeaders.set(VINEXT_MOUNTED_SLOTS_HEADER, mountedSlotsHeader);
          }
          const ownerLeaveCount = owner?.leaveCount;
          const shellRscUrl = await createRscRequestUrl(fullHref, shellHeaders);
          // The Link left meanwhile, so this prefetch was dropped.
          if (owner && owner.leaveCount !== ownerLeaveCount) return;
          const shellCacheKey = AppElementsWire.encodeCacheKey(shellRscUrl, interceptionContext);
          const shellCache = getPrefetchCache();
          let shellEntry = shellCache.get(shellCacheKey);
          if (shellEntry === undefined) {
            getPrefetchedUrls().add(shellCacheKey);
            const shellOwned = createOwnedLinkPrefetch(owner);
            const shellFetchPromise = scheduleOwnedLinkPrefetch(
              shellOwned,
              (signal) =>
                fetch(shellRscUrl, {
                  headers: shellHeaders,
                  credentials: "include",
                  priority,
                  signal,
                  // @ts-expect-error — purpose is a valid fetch option in some browsers
                  purpose: "prefetch",
                }),
              priority,
            );
            trackOwnedLinkPrefetch(shellOwned, shellFetchPromise);
            prefetchRscResponse(
              shellRscUrl,
              shellFetchPromise,
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
          } else {
            joinOwnedLinkPrefetch(shellEntry.fetchPromise, owner);
          }
          await shellEntry?.pending?.catch(() => {});
        };
        const fetchAliasCacheHitProbe = async (): Promise<Response> => {
          const probeHeaders = createAppPrefetchRequestHeaders({
            interceptionContext,
            fetchPriority: priority,
            renderMode: APP_RSC_RENDER_MODE_PREFETCH_LOADING_SHELL,
          });
          probeHeaders.set(NEXT_ROUTER_PREFETCH_HEADER, "1");
          probeHeaders.set(NEXT_ROUTER_SEGMENT_PREFETCH_HEADER, "1");
          if (mountedSlotsHeader) {
            probeHeaders.set(VINEXT_MOUNTED_SLOTS_HEADER, mountedSlotsHeader);
          }
          const ownerLeaveCount = owner?.leaveCount;
          const probeRscUrl = await createRscRequestUrl(fullHref, probeHeaders);
          // The Link left meanwhile. The probe is best effort, so drop it.
          if (owner && owner.leaveCount !== ownerLeaveCount) {
            throw new DOMException("Prefetch is no longer wanted", "AbortError");
          }
          return fetch(probeRscUrl, {
            method: "HEAD",
            headers: probeHeaders,
            credentials: "include",
            priority,
            // @ts-expect-error — purpose is a valid fetch option in some browsers
            purpose: "prefetch",
          });
        };
        // A visible Link that reuses a pending request becomes one of its owners.
        const onReuse = (entry: { fetchPromise?: Promise<Response> }) =>
          joinOwnedLinkPrefetch(entry.fetchPromise, owner);
        const hasExactNavigationCacheEntry =
          autoPrefetch.cacheForNavigation &&
          hasPrefetchCacheEntryForNavigation(rscUrl, interceptionContext, mountedSlotsHeader, {
            onReuse,
          });
        const hasNavigationCacheEntry =
          hasExactNavigationCacheEntry ||
          (autoPrefetch.cacheForNavigation &&
            hasPrefetchCacheEntryForNavigation(rscUrl, interceptionContext, mountedSlotsHeader, {
              additionalRscUrls,
              onReuse,
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
          (__prefetchInlining || requiresRouteTreePrefetch) &&
          mode === "auto" &&
          autoPrefetch.prefetchShellFirst;
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
                return fetchRouteTreeGatedPrefetch({
                  fetchFullRscPayload,
                  fetchRouteTree: (routeTreeRscUrl, routeTreeHeaders) =>
                    scheduleOwnedLinkPrefetch(
                      owned,
                      (signal) =>
                        fetch(routeTreeRscUrl, {
                          headers: routeTreeHeaders,
                          credentials: "include",
                          priority,
                          signal,
                          // @ts-expect-error — purpose is a valid fetch option in some browsers
                          purpose: "prefetch",
                        }),
                      priority,
                    ),
                  fullHref,
                  headers,
                  interceptionContext,
                  mountedSlotsHeader,
                });
              })()
            : fetchFullRscPayload();
        trackOwnedLinkPrefetch(owned, fetchPromise);
        if (
          !__prefetchInlining &&
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
            fallbackTtlMs:
              autoPrefetch.fallbackTtl === "dynamic"
                ? DYNAMIC_NAVIGATION_CACHE_TTL
                : PREFETCH_CACHE_TTL,
            dynamicStaleTime: autoPrefetch.dynamicStaleTime,
            optimisticRouteShell: isOptimisticRouteShellPrefetch,
            prefetchKind: isOptimisticRouteShellPrefetch ? "loading-shell" : "navigation",
            prepareSnapshot: autoPrefetch.cacheForNavigation
              ? prepareNavigationPrefetchSnapshot
              : undefined,
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
              : (getPagesMiddlewareDataHref(fullHref, __basePath, { locale }, fullRouteHref) ??
                undefined);
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

  if (priority === "high" || hasLinkAppNavigationRuntime()) {
    runPrefetch();
    return;
  }

  const schedule = window.requestIdleCallback ?? ((fn: () => void) => setTimeout(fn, 100));
  schedule(runPrefetch);
}

async function promotePrefetchEntriesForNavigation(href: string): Promise<void> {
  if (typeof window === "undefined") return;
  if (!hasLinkAppNavigationRuntime()) return;
  const [
    { getPrefetchCache, promotePrefetchCacheEntryForNavigation },
    { parseRscRequestPath, stripRscCacheBustingSearchParam, stripRscSuffix },
  ] = await Promise.all([loadNavigationModule(), loadAppRscCacheBustingModule()]);

  let target: URL;
  try {
    target = new URL(
      toCanonicalBrowserNavigationHref(href, window.location.href, __basePath, __trailingSlash),
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
      cached = parseRscRequestPath(rscUrl);
    } catch {
      continue;
    }
    stripRscCacheBustingSearchParam(cached);
    if (stripRscSuffix(cached.pathname) === target.pathname && cached.search === target.search) {
      promotePrefetchCacheEntryForNavigation(cacheKey, entry);
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
  /** Prefetches this Link created or reused while visible. */
  ownedPrefetches: Set<OwnedLinkPrefetch>;
  /** How many times this Link has left the viewport or unmounted. */
  leaveCount: number;
  pagesRouteHref?: string;
  queuedViewportPrefetch: boolean;
  routerMode: LinkPrefetchRouterMode;
  viewportPrefetched: boolean;
};

const observedLinkPrefetches = new WeakMap<Element, LinkPrefetchInstance>();
const visibleLinkPrefetches = new Set<LinkPrefetchInstance>();
const visibleAppPrefetchQueue: LinkPrefetchInstance[] = [];
let visibleAppPrefetchDrainScheduled = false;

/**
 * Next.js cancels a Link's prefetch task when the Link leaves the viewport or
 * unmounts (`cancelPrefetchTask` in `client/components/links.ts`): requests it
 * has not started are never sent, while requests already in flight finish.
 * Otherwise a prefetch queued by the previous page could still reach
 * middleware after the user navigated away (for example resetting a locale
 * cookie the destination page just set).
 *
 * Vinext queues requests rather than tasks, and Links whose hrefs resolve to
 * the same request share it. So each viewport prefetch records the visible
 * Links that created or reused it. When the last of them leaves, the prefetch
 * is dropped: its queued requests are cancelled and its later stages are never
 * sent, unless a navigation that claimed it before then is still current. A
 * Link that comes back prefetches again with the current page's inputs.
 */
type OwnedLinkPrefetch = {
  owners: Set<LinkPrefetchInstance>;
  /** Every queued request made for this prefetch, one per stage. */
  requests: Array<Promise<Response>>;
  /** The cached promise a navigation claims. */
  claimable?: Promise<Response>;
  /** The claim sequence when the last owner left; later claims are ignored. */
  droppedAt?: number;
};

const ownedLinkPrefetches = new WeakMap<Promise<Response>, OwnedLinkPrefetch>();

function createOwnedLinkPrefetch(
  owner: LinkPrefetchInstance | undefined,
): OwnedLinkPrefetch | undefined {
  if (owner === undefined) return undefined;
  return { owners: new Set([owner]), requests: [] };
}

function hasVisibleOwner(owned: OwnedLinkPrefetch): boolean {
  for (const owner of owned.owners) {
    if (owner.isVisible) return true;
  }
  return false;
}

function isOwnedLinkPrefetchWanted(owned: OwnedLinkPrefetch): boolean {
  if (owned.droppedAt !== undefined) {
    return isAppPrefetchFetchClaimed(owned.claimable, owned.droppedAt);
  }
  return isAppPrefetchFetchClaimed(owned.claimable) || hasVisibleOwner(owned);
}

function scheduleOwnedLinkPrefetch(
  owned: OwnedLinkPrefetch | undefined,
  fetcher: (signal: AbortSignal) => Promise<Response>,
  priority: "low" | "high",
): Promise<Response> {
  // A later stage of a dropped prefetch fails right away, which also removes
  // its cache entry.
  if (owned && !isOwnedLinkPrefetchWanted(owned)) {
    return Promise.reject(new DOMException("Prefetch is no longer wanted", "AbortError"));
  }
  const request = scheduleAppPrefetchFetch(
    fetcher,
    priority,
    owned && (() => isOwnedLinkPrefetchWanted(owned)),
  );
  owned?.requests.push(request);
  return request;
}

/**
 * Registers the promise cached for `owned`, which reusing Links join. Owners
 * are registered here, not in `createOwnedLinkPrefetch`, since a cache hit
 * returns before sending anything.
 */
function trackOwnedLinkPrefetch(
  owned: OwnedLinkPrefetch | undefined,
  fetchPromise: Promise<Response>,
): void {
  if (owned === undefined) return;
  for (const owner of owned.owners) owner.ownedPrefetches.add(owned);
  owned.claimable = fetchPromise;
  ownedLinkPrefetches.set(fetchPromise, owned);
  const settle = (failed: boolean) => {
    // Only work that can still be cancelled is joined.
    ownedLinkPrefetches.delete(fetchPromise);
    for (const owner of owned.owners) {
      owner.ownedPrefetches.delete(owned);
      // A Link that came back while the dropped prefetch was still settling
      // joined it instead of starting a fresh one.
      if (failed && owned.droppedAt !== undefined && owner.isVisible) {
        scheduleVisibleAppPrefetch(owner);
      }
    }
    owned.owners.clear();
  };
  fetchPromise.then(
    () => settle(false),
    () => settle(true),
  );
}

function joinOwnedLinkPrefetch(
  fetchPromise: Promise<Response> | undefined,
  owner: LinkPrefetchInstance | undefined,
): void {
  const owned = fetchPromise && ownedLinkPrefetches.get(fetchPromise);
  if (!owned || owner === undefined) return;
  owned.owners.add(owner);
  owner.ownedPrefetches.add(owned);
}

/** Called when a Link leaves the viewport or unmounts. */
function releaseOwnedLinkPrefetches(instance: LinkPrefetchInstance): void {
  instance.leaveCount += 1;
  for (const owned of instance.ownedPrefetches) {
    owned.owners.delete(instance);
    if (owned.droppedAt !== undefined || hasVisibleOwner(owned)) continue;
    // Dropped even while claimed, so only claims made before now keep it alive.
    owned.droppedAt = getAppPrefetchFetchClaimSequence();
    if (isAppPrefetchFetchClaimed(owned.claimable)) continue;
    for (const request of owned.requests) cancelQueuedAppPrefetchFetch(request);
  }
  instance.ownedPrefetches.clear();
}

function drainVisibleAppPrefetchQueue(): void {
  visibleAppPrefetchDrainScheduled = false;
  while (true) {
    const instance = visibleAppPrefetchQueue.pop();
    if (!instance) return;
    instance.queuedViewportPrefetch = false;
    if (!instance.isVisible || instance.routerMode !== "app") continue;
    prefetchUrl(instance.href, instance.mode, "low", instance.pagesRouteHref, undefined, instance);
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
    releaseOwnedLinkPrefetches(instance);
  }
}

let visibleLinkPingRuntime: NavigationRuntime | null = null;

function registerVisibleLinkPing(): void {
  if (typeof window === "undefined") return;
  // Registering validates the whole navigation runtime and copies its function
  // table, so skip it while the runtime that already holds this ping is still
  // the one installed on window, instead of repeating it for every Link mount.
  // A malformed table still goes through registration, which replaces the
  // runtime with a valid one.
  const functions: unknown = visibleLinkPingRuntime?.functions;
  if (
    visibleLinkPingRuntime !== null &&
    Reflect.get(window, NAVIGATION_RUNTIME_KEY) === visibleLinkPingRuntime &&
    typeof functions === "object" &&
    functions !== null &&
    Reflect.get(functions, "pingVisibleLinks") === pingVisibleLinkPrefetches
  ) {
    return;
  }
  visibleLinkPingRuntime = registerNavigationRuntimeFunctions({
    pingVisibleLinks: pingVisibleLinkPrefetches,
  });
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
    const domainLocales = getDomainLocales();
    return getCurrentBrowserLocale({
      basePath: __basePath,
      domainLocales,
      // Only matched against configured domain locales; skip the location read
      // when there are none.
      hostname: domainLocales?.length ? getCurrentHostname() : undefined,
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

/** Resolve a dynamic route pattern to the concrete URL used for prefetching. */
function resolveConcreteRouteHref(href: string, as: string | undefined): string | null {
  if (typeof as !== "string") return null;
  const projection = interpolateDynamicRouteHref(href, as);
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
    locale,
    ...anchorProps
  },
  forwardedRef,
) {
  const pagesRouter = useContext(RouterContext);
  const hrefStr = resolvePagesLinkValue(href, pagesRouter);
  const asHref = as === undefined ? undefined : resolvePagesLinkValue(as, pagesRouter);

  // Next.js parity: in legacyBehavior, a string or number child is wrapped in
  // a plain <a> so the cloneElement path below has an element to clone. The
  // wrapper anchor receives the forwarded href + handlers from Link.
  // Ported from Next.js: packages/next/src/client/link.tsx (around line 334)
  // https://github.com/vercel/next.js/blob/canary/packages/next/src/client/link.tsx
  let children: React.ReactNode = childrenProp;
  if (legacyBehavior && (typeof childrenProp === "string" || typeof childrenProp === "number")) {
    children = React.createElement("a", null, childrenProp);
  }

  // Keep Next.js's route/display split: Router receives the normalized route
  // pattern plus `as`, while prefetching uses an interpolated concrete URL.
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
  const pagesAsHref = asHref ?? implicitDynamicRouteHref?.as;
  const unresolvedHref = pagesAsHref ?? hrefStr;
  const resolvedHref =
    unresolvedHref.startsWith("#") && !hasLinkAppNavigationRuntime()
      ? resolvePagesQueryOnlyHref(unresolvedHref)
      : unresolvedHref;
  const concreteRouteHref = HAS_PAGES_ROUTER
    ? resolveConcreteRouteHref(hrefForImplicitInterpolation ?? hrefStr, pagesAsHref)
    : null;
  const routeHrefRaw = hrefStr;
  const prefetchRouteHrefRaw = concreteRouteHref ?? routeHrefRaw;
  const hasPagesHrefAsPair =
    HAS_PAGES_ROUTER && pagesAsHref !== undefined && pagesAsHref !== routeHrefRaw;
  const isDangerous = isDangerousScheme(resolvedHref);
  const isRouteDangerous = isDangerousScheme(prefetchRouteHrefRaw);
  const isPrefetchDangerous = isDangerous || (pagesRouter !== null && isRouteDangerous);

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
        applyLocaleToHref(isRouteDangerous ? "/" : prefetchRouteHrefRaw, locale),
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

  // On the server, everything below only allocates: effects never run, event
  // handlers and refs are not rendered, and no navigation can be pending. Pages
  // render many links, so skip straight to the markup. The client never takes
  // this branch, so its renders always call every hook, and a server render
  // never renders the same Link again with different props. legacyBehavior
  // passes the handlers to the child, which a custom child component can
  // observe, and a dangerous href warns in development, so both keep the full
  // path.
  /* oxlint-disable eslint-plugin-react-hooks/rules-of-hooks -- the early return below never happens on the client. */
  if (isServer && !legacyBehavior && !isDangerous) {
    return (
      // Like the client's per-link value: never pending, and its own object.
      <LinkStatusContext.Provider value={{ pending: false }}>
        <a href={fullHref} {...anchorProps}>
          {children}
        </a>
      </LinkStatusContext.Provider>
    );
  }

  // Track pending state for useLinkStatus()
  const [pending, setPending] = useState(false);
  const mountedRef = useRef(true);
  const pendingPagesIntentPrefetchRef = useRef<(() => void) | null>(null);
  // Stable setter so the global navigation registry can reset this link's
  // pending state from another navigation without depending on render identity.
  const setPendingRef = useRef<PendingLinkSetter>((next: boolean) => {
    if (mountedRef.current) setPending(next);
  });
  useEffect(() => {
    mountedRef.current = true;
    const setter = setPendingRef.current;
    return () => {
      mountedRef.current = false;
      pendingPagesIntentPrefetchRef.current?.();
      pendingPagesIntentPrefetchRef.current = null;
      // Drop our setter from the global registry on unmount so a later
      // navigation never calls into an unmounted component.
      if (setter) clearLinkForCurrentNavigation(setter);
    };
  }, []);

  // Prefetching: observe the element when it enters the viewport.
  // In App Router, null/undefined/"auto" is automatic prefetch and true opts
  // into a full RSC prefetch, matching Next.js's public prefetch contract.
  const internalRef = useRef<HTMLAnchorElement | null>(null);
  // A shallow Pages navigation only mutates the current route's visible URL;
  // it must not issue a data prefetch for that URL. Besides wasting a request,
  // such a prefetch would run middleware/getServerSideProps even though the
  // shallow transition itself deliberately skips them.
  const prefetchRouterMode = getLinkPrefetchRouterMode();
  const isShallowPagesLink = prefetchRouterMode === "pages" && shallow;
  const effectivePrefetchProp = isShallowPagesLink ? false : prefetchProp;
  const prefetchMode = resolveLinkPrefetchMode(effectivePrefetchProp, isPrefetchDangerous);
  const shouldViewportPrefetch = canLinkPrefetch({
    nodeEnv: process.env.NODE_ENV,
    prefetch: effectivePrefetchProp,
    isDangerous: isPrefetchDangerous,
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

  // A layout effect, so unmounting releases the Link's queued prefetches in the
  // commit that detaches it (Next.js unmounts from its ref callback), not in a
  // later passive effect that a free prefetch slot could beat.
  useLayoutEffect(() => {
    if (!shouldViewportPrefetch || typeof window === "undefined") return;
    const node = internalRef.current;
    if (!node) return;

    // getLinkPrefetchHref() returns relative hrefs unchanged, so only read the
    // window origin for absolute ones.
    const hrefToPrefetch = isAbsoluteOrProtocolRelativeUrl(normalizedHref)
      ? getLinkPrefetchHref({
          href: normalizedHref,
          basePath: __basePath,
          currentOrigin: window.location.origin,
        })
      : normalizedHref;
    if (hrefToPrefetch == null) return;

    const observer = getSharedObserver();
    if (!observer) return;

    registerVisibleLinkPing();
    const instance: LinkPrefetchInstance = {
      href: hrefToPrefetch,
      isVisible: false,
      locale,
      mode: prefetchMode,
      ownedPrefetches: new Set(),
      leaveCount: 0,
      pagesRouteHref:
        normalizedRouteHref === normalizedHref
          ? undefined
          : (getLinkPrefetchHref({
              href: normalizedRouteHref,
              basePath: __basePath,
              currentOrigin: window.location.origin,
            }) ?? undefined),
      queuedViewportPrefetch: false,
      routerMode: prefetchRouterMode,
      viewportPrefetched: false,
    };
    observedLinkPrefetches.set(node, instance);
    observer.observe(node);

    return () => {
      observer.unobserve(node);
      observedLinkPrefetches.delete(node);
      visibleLinkPrefetches.delete(instance);
      instance.isVisible = false;
      releaseOwnedLinkPrefetches(instance);
    };
  }, [
    shouldViewportPrefetch,
    prefetchMode,
    prefetchRouterMode,
    normalizedHref,
    normalizedRouteHref,
    locale,
  ]);

  const prefetchOnIntent = useCallback(() => {
    if (
      isShallowPagesLink ||
      !canLinkIntentPrefetch({
        nodeEnv: process.env.NODE_ENV,
        prefetch: effectivePrefetchProp,
        isDangerous: isPrefetchDangerous,
        routerMode: prefetchRouterMode,
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
    effectivePrefetchProp,
    isPrefetchDangerous,
    isShallowPagesLink,
    prefetchMode,
    prefetchRouterMode,
    normalizedHref,
    normalizedRouteHref,
    locale,
    unstable_dynamicOnHover,
  ]);

  const schedulePrefetchOnIntent = useCallback(() => {
    if (prefetchRouterMode !== "pages" || typeof window.requestAnimationFrame !== "function") {
      prefetchOnIntent();
      return;
    }

    pendingPagesIntentPrefetchRef.current?.();
    const frame = window.requestAnimationFrame(() => {
      pendingPagesIntentPrefetchRef.current = null;
      prefetchOnIntent();
    });
    pendingPagesIntentPrefetchRef.current = () => window.cancelAnimationFrame(frame);
  }, [prefetchOnIntent, prefetchRouterMode]);

  const handleMouseEnter = useCallback(
    (e: MouseEvent<HTMLAnchorElement>) => {
      onMouseEnter?.(e);
      schedulePrefetchOnIntent();
    },
    [onMouseEnter, schedulePrefetchOnIntent],
  );

  const handleTouchStart = useCallback(
    (e: TouchEvent<HTMLAnchorElement>) => {
      onTouchStart?.(e);
      schedulePrefetchOnIntent();
    },
    [onTouchStart, schedulePrefetchOnIntent],
  );

  const handleClick = async (
    e: MouseEvent<HTMLAnchorElement>,
    options: { skipLinkOnClick?: boolean } = {},
  ) => {
    pendingPagesIntentPrefetchRef.current?.();
    pendingPagesIntentPrefetchRef.current = null;
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

    const hasAppNavigationRuntime = hasLinkAppNavigationRuntime();
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
    const absoluteFullHref = toCanonicalBrowserNavigationHref(
      hasAppNavigationRuntime ? navigateHref : pagesNavigateHref,
      window.location.href,
      __basePath,
      __trailingSlash,
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
    const hybridOwnerModule =
      HAS_PAGES_ROUTER && hasAppNavigationRuntime
        ? (loadedHybridClientRouteOwnerModule ?? (await loadHybridClientRouteOwnerModule()))
        : null;
    const hybridOwner = hybridOwnerModule?.resolveHybridClientRouteOwner(navigateHref, __basePath);
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
      const { navigateClientSide } = loadedNavigationModule ?? (await loadNavigationModule());
      const setter = setPendingRef.current;
      // Register this link as the one driving the current navigation. This
      // resets any previously-pending link (e.g. a different link clicked
      // moments earlier) so only the last-clicked link shows a pending state.
      if (setter) setLinkForCurrentNavigation(setter);
      setPending(true);
      React.startTransition(() => {
        void navigateClientSide(navigateHref, replace ? "replace" : "push", scroll, false).finally(
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
      // Next.js also clones the legacy child and merges its ref during render.
      // oxlint-disable-next-line react/refs -- preserve the Next.js legacy Link contract
      const dangerousChild = React.cloneElement(child, {
        ref: setDangerousRefs,
        onClick: (event: MouseEvent<HTMLAnchorElement>) => {
          if (childOnClick) childOnClick(event);
          reportBlockedDangerousNavigation();
        },
      });
      return (
        <LinkStatusContext.Provider value={linkStatusValue}>
          {dangerousChild}
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
    // Next.js also clones the legacy child and merges its ref during render.
    // oxlint-disable-next-line react/refs -- preserve the Next.js legacy Link contract
    const clonedChild = React.cloneElement(child, clonedProps);
    return (
      <LinkStatusContext.Provider value={linkStatusValue}>{clonedChild}</LinkStatusContext.Provider>
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
  /* oxlint-enable eslint-plugin-react-hooks/rules-of-hooks */
});

export default Link;
