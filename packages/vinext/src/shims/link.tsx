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
  useRef,
  useEffect,
  useCallback,
  useContext,
  createContext,
  useState,
  type AnchorHTMLAttributes,
  type MouseEvent,
  type TouchEvent,
} from "react";
import {
  getNavigationRuntime,
  hasAppNavigationRuntime,
  registerNavigationRuntimeFunctions,
} from "../client/navigation-runtime.js";
// Import shared RSC prefetch utilities from navigation shim (relative path
// so this resolves both via the Vite plugin and in direct vitest imports)
import {
  getPrefetchInterceptionContext,
  getPrefetchCache,
  getPrefetchedUrls,
  getMountedSlotsHeader,
  navigateClientSide,
  prefetchRscResponse,
} from "./navigation.js";
import { AppElementsWire } from "../server/app-elements.js";
import {
  createRscRequestHeaders,
  createRscRequestUrl,
  stripRscCacheBustingSearchParam,
  stripRscSuffix,
} from "../server/app-rsc-cache-busting.js";
import { APP_RSC_RENDER_MODE_PREFETCH_LOADING_SHELL } from "../server/app-rsc-render-mode.js";
import { VINEXT_MOUNTED_SLOTS_HEADER } from "../server/headers.js";
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
  resolveRelativeHref,
  toBrowserNavigationHref,
  toSameOriginAppPath,
  withBasePath,
} from "./url-utils.js";
import { appendSearchParamsToUrl, type UrlQuery, urlQueryToSearchParams } from "../utils/query.js";
import { addLocalePrefix, getDomainLocaleUrl, type DomainLocale } from "../utils/domain-locale.js";
import { getI18nContext } from "./i18n-context.js";
import type { VinextLinkPrefetchRoute, VinextNextData } from "../client/vinext-next-data.js";
import { navigatePagesRouterLink } from "../client/pages-router-link-navigation.js";
import { createRouteTrieCache, matchRouteWithTrie } from "../routing/route-matching.js";
import { stripBasePath } from "../utils/base-path.js";
import {
  prefetchPagesData,
  resolvePagesDataNavigationTarget,
} from "./internal/pages-data-target.js";
import { getCurrentBrowserLocale } from "./client-locale.js";

type NavigateEvent = {
  url: URL;
  /** Call to prevent the Link's default navigation (e.g. for View Transitions). */
  preventDefault(): void;
  /** Whether preventDefault() has been called. */
  defaultPrevented: boolean;
};

type LinkProps = {
  href: string | { pathname?: string; query?: UrlQuery };
  /** URL displayed in the browser (when href is a route pattern like /user/[id]) */
  as?: string;
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
  onNavigate?: (event: NavigateEvent) => void;
  children?: React.ReactNode;
} & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href">;

type LinkPrefetchMode = "disabled" | "auto" | "full";

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

/** basePath from next.config.js, injected by the plugin at build time */
const __basePath: string = process.env.__NEXT_ROUTER_BASEPATH ?? "";
/** trailingSlash from next.config.js, injected by the plugin at build time */
const __trailingSlash: boolean = process.env.__VINEXT_TRAILING_SLASH === "true";
const linkPrefetchRouteTrieCache = createRouteTrieCache<VinextLinkPrefetchRoute>();

function resolveHref(href: LinkProps["href"]): string {
  if (typeof href === "string") return href;
  let url = href.pathname ?? "/";
  if (href.query) {
    const params = urlQueryToSearchParams(href.query);
    url = appendSearchParamsToUrl(url, params);
  }
  return url;
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
 * `/posts/[id]`) for the "in page" segment of the message. We do not have
 * cheap access to the route pattern from inside the Link shim, so we
 * fall back to `window.location.pathname` (or `"/"` during SSR). The text
 * is cosmetic and is not asserted by the Next.js compat test.
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

  const pathname =
    typeof window !== "undefined" && window.location ? window.location.pathname : "/";
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

export function canAutoPrefetchFullAppRoute(href: string): boolean {
  if (typeof window === "undefined") return false;

  const routes = window.__VINEXT_LINK_PREFETCH_ROUTES__;
  if (!routes) return false;

  const routeHref = toSameOriginRouteHref(href);
  if (routeHref === null) return false;

  const match = matchRouteWithTrie(routeHref, routes, linkPrefetchRouteTrieCache);
  if (!match) return false;

  return !match.route.isDynamic;
}

export function resolveAutoAppRoutePrefetch(href: string): {
  cacheForNavigation: boolean;
  shouldPrefetch: boolean;
} {
  if (typeof window === "undefined") {
    return { cacheForNavigation: false, shouldPrefetch: false };
  }

  const routes = window.__VINEXT_LINK_PREFETCH_ROUTES__;
  if (!routes) {
    return { cacheForNavigation: false, shouldPrefetch: false };
  }

  const routeHref = toSameOriginRouteHref(href);
  if (routeHref === null) {
    return { cacheForNavigation: false, shouldPrefetch: false };
  }

  const match = matchRouteWithTrie(routeHref, routes, linkPrefetchRouteTrieCache);
  if (!match) {
    return { cacheForNavigation: false, shouldPrefetch: false };
  }

  return {
    cacheForNavigation: !match.route.isDynamic,
    shouldPrefetch: !match.route.isDynamic || match.route.canPrefetchLoadingShell,
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
 * For Pages Router: injects a <link rel="prefetch"> for the page module.
 *
 * Uses `requestIdleCallback` (or `setTimeout` fallback) to avoid blocking
 * the main thread during initial page load.
 */
function prefetchUrl(href: string, mode: LinkPrefetchMode, priority: "low" | "high" = "low"): void {
  if (typeof window === "undefined") return;

  const prefetchHref = getLinkPrefetchHref({
    href,
    basePath: __basePath,
    currentOrigin: window.location.origin,
  });
  if (prefetchHref == null) return;

  const fullHref = toBrowserNavigationHref(prefetchHref, window.location.href, __basePath);

  const schedule = window.requestIdleCallback ?? ((fn: () => void) => setTimeout(fn, 100));

  schedule(() => {
    void (async () => {
      if (hasAppNavigationRuntime()) {
        const autoPrefetch =
          mode === "auto"
            ? resolveAutoAppRoutePrefetch(prefetchHref)
            : { cacheForNavigation: true, shouldPrefetch: true };
        if (!autoPrefetch.shouldPrefetch) return;

        const interceptionContext = getPrefetchInterceptionContext(fullHref);
        const mountedSlotsHeader = getMountedSlotsHeader();
        const isOptimisticRouteShellPrefetch = !autoPrefetch.cacheForNavigation;
        if (isOptimisticRouteShellPrefetch && interceptionContext !== null) return;
        const headers = createRscRequestHeaders({
          interceptionContext,
          renderMode: isOptimisticRouteShellPrefetch
            ? APP_RSC_RENDER_MODE_PREFETCH_LOADING_SHELL
            : undefined,
        });
        if (mountedSlotsHeader) {
          headers.set(VINEXT_MOUNTED_SLOTS_HEADER, mountedSlotsHeader);
        }
        // Distinguish the same visible URL when it is prefetched from different
        // request contexts such as /feed vs /gallery or different mounted slots.
        const rscUrl = await createRscRequestUrl(fullHref, headers);
        const cacheKey = AppElementsWire.encodeCacheKey(rscUrl, interceptionContext);
        const prefetched = getPrefetchedUrls();
        if (prefetched.has(cacheKey)) {
          if (autoPrefetch.cacheForNavigation) {
            const existing = getPrefetchCache().get(cacheKey);
            if (existing?.cacheForNavigation === false) {
              existing.cacheForNavigation = true;
            }
          }
          return;
        }
        prefetched.add(cacheKey);
        prefetchRscResponse(
          rscUrl,
          fetch(rscUrl, {
            headers,
            credentials: "include",
            priority,
            // @ts-expect-error — purpose is a valid fetch option in some browsers
            purpose: "prefetch",
          }),
          interceptionContext,
          mountedSlotsHeader,
          undefined,
          {
            cacheForNavigation: autoPrefetch.cacheForNavigation,
            optimisticRouteShell: isOptimisticRouteShellPrefetch,
          },
        );
      } else if (window.__NEXT_DATA__) {
        // Pages Router prefetch. When a code-split loader is registered for
        // the target route (prod builds expose them on window via the
        // generated client entry), prefetch the data JSON + warm the page
        // chunk in parallel — matching the actual navigation, so the click
        // is a double cache hit. Otherwise (dev, or unmapped route) fall
        // back to the legacy `<link rel="prefetch" as="document">` so the
        // browser still preloads the HTML.
        //
        // The decision helper + prefetch action live in shims/internal/ so
        // this file does not pull in the router shim at module init time,
        // which would create a circular import and grow the SSR module graph.
        const dataTarget = resolvePagesDataNavigationTarget(fullHref, __basePath);
        if (dataTarget) {
          prefetchPagesData(dataTarget);
        } else {
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
  });
}

function promotePrefetchEntriesForNavigation(href: string): void {
  if (typeof window === "undefined") return;

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
  mode: LinkPrefetchMode;
  routerMode: LinkPrefetchRouterMode;
  viewportPrefetched: boolean;
};

const observedLinkPrefetches = new WeakMap<Element, LinkPrefetchInstance>();
const visibleLinkPrefetches = new Set<LinkPrefetchInstance>();

function setVisibleLinkPrefetch(instance: LinkPrefetchInstance, isVisible: boolean): void {
  instance.isVisible = isVisible;
  if (isVisible) {
    visibleLinkPrefetches.add(instance);
    if (instance.routerMode === "pages" && instance.viewportPrefetched) return;
    prefetchUrl(instance.href, instance.mode, "low");
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
      prefetchUrl(instance.href, instance.mode, "low");
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

const Link = forwardRef<HTMLAnchorElement, LinkProps>(function Link(
  {
    href,
    as,
    replace = false,
    prefetch: prefetchProp,
    scroll = true,
    shallow = false,
    children,
    onClick,
    onMouseEnter,
    onTouchStart,
    onNavigate,
    unstable_dynamicOnHover = false,
    ...rest
  },
  forwardedRef,
) {
  // Extract locale from rest props
  const { locale, ...restWithoutLocale } = rest;

  // If `as` is provided, use it as the actual URL (legacy Next.js pattern
  // where href is a route pattern like "/user/[id]" and as is "/user/1")
  const rawResolvedHref = as ?? resolveHref(href);

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
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
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
      mode: prefetchMode,
      routerMode: getLinkPrefetchRouterMode(),
      viewportPrefetched: false,
    };
    observedLinkPrefetches.set(node, instance);
    observer.observe(node);

    return () => {
      observer.unobserve(node);
      observedLinkPrefetches.delete(node);
      visibleLinkPrefetches.delete(instance);
    };
  }, [shouldViewportPrefetch, prefetchMode, normalizedHref]);

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
    const intentMode = unstable_dynamicOnHover ? "full" : prefetchMode;
    if (unstable_dynamicOnHover && internalRef.current) {
      const instance = observedLinkPrefetches.get(internalRef.current);
      if (instance) {
        instance.mode = "full";
      }
      promotePrefetchEntriesForNavigation(normalizedHref);
    }
    prefetchUrl(normalizedHref, intentMode, "high");
  }, [prefetchProp, isDangerous, prefetchMode, normalizedHref, unstable_dynamicOnHover]);

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

  const handleClick = async (e: MouseEvent<HTMLAnchorElement>) => {
    if (onClick) onClick(e);
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

    // Resolve relative hrefs (#hash, ?query) against the current URL once so
    // onNavigate and the actual navigation target stay in sync.
    const absoluteHref = resolveRelativeHref(navigateHref, window.location.href, __basePath);
    const absoluteFullHref = toBrowserNavigationHref(
      navigateHref,
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

    // App Router: delegate to navigateClientSide which handles scroll save,
    // hash-only changes, RSC fetch, and two-phase URL commit.
    if (getNavigationRuntime()?.functions.navigate) {
      setPending(true);
      React.startTransition(() => {
        void navigateClientSide(navigateHref, replace ? "replace" : "push", scroll, true).finally(
          () => {
            if (mountedRef.current) setPending(false);
          },
        );
      });
      return;
    } else {
      // Next.js only consumes onRouterTransitionStart in the App Router.
      // Pages Router still executes instrumentation-client side effects
      // during startup, but it does not invoke the named export on navigation.
      // Pages Router: use the Router singleton
      try {
        const routerModule = await import("next/router");
        const Router = routerModule.default;
        await navigatePagesRouterLink(Router, {
          href: absoluteHref,
          replace,
          scroll,
          shallow,
          locale,
        });
      } catch {
        // Fallback to hard navigation if router fails
        if (replace) {
          window.history.replaceState({}, "", absoluteFullHref);
        } else {
          window.history.pushState({}, "", absoluteFullHref);
        }
        window.dispatchEvent(new PopStateEvent("popstate"));
      }
    }
  };

  // Remove props that shouldn't be on <a>
  const { passHref: _p, ...anchorProps } = restWithoutLocale;

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
    const handleDangerousClick = (event: MouseEvent<HTMLAnchorElement>) => {
      if (onClick) onClick(event);
      reportBlockedDangerousNavigation();
    };
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

  return (
    <LinkStatusContext.Provider value={linkStatusValue}>
      <a
        ref={setRefs}
        href={fullHref}
        onClick={(event) => {
          void handleClick(event);
        }}
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
