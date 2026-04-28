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
} from "react";
// Import shared RSC prefetch utilities from navigation shim (relative path
// so this resolves both via the Vite plugin and in direct vitest imports)
import {
  getCurrentInterceptionContext,
  toRscUrl,
  getPrefetchedUrls,
  getMountedSlotsHeader,
  navigateClientSide,
  prefetchRscResponse,
} from "./navigation.js";
import { createAppPayloadCacheKey } from "../server/app-elements.js";
import { isDangerousScheme } from "./url-safety.js";
import Router from "./router.js";
import { RouterContext } from "./internal/router-context.js";
import {
  normalizeLocalTrailingSlashHref,
  toBrowserNavigationHref,
  toSameOriginAppPath,
  withBasePath,
} from "./url-utils.js";
import { stripBasePath } from "../utils/base-path.js";
import { appendSearchParamsToUrl, type UrlQuery, urlQueryToSearchParams } from "../utils/query.js";
import { addLocalePrefix, getDomainLocaleUrl, type DomainLocale } from "../utils/domain-locale.js";
import { getI18nContext } from "./i18n-context.js";
import type { VinextNextData } from "../client/vinext-next-data.js";

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
  /** Prefetch the page in the background (default: true, uses IntersectionObserver) */
  prefetch?: boolean;
  /** Whether to pass the href to the child element */
  passHref?: boolean;
  /** Preserve the pre-Next 13 behavior where Link clones/wraps its child. */
  legacyBehavior?: boolean;
  /** Scroll to top on navigation (default: true) */
  scroll?: boolean;
  /** Update URL/query without refetching Pages Router data */
  shallow?: boolean;
  /** Locale for i18n (used for locale-prefixed URLs) */
  locale?: string | false;
  /** Called before navigation happens (Next.js 16). Return value is ignored. */
  onNavigate?: (event: NavigateEvent) => void;
  children?: React.ReactNode;
} & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href">;

// ---------------------------------------------------------------------------
// useLinkStatus — reports the pending state of a parent <Link> navigation
// ---------------------------------------------------------------------------

type LinkStatusContextValue = {
  pending: boolean;
};

const LinkStatusContext = createContext<LinkStatusContextValue>({ pending: false });
const LINK_STATUS_NAVIGATION_EVENT = "vinext:link-status-navigation";
const _LINK_STATUS_STATE_KEY = Symbol.for("vinext.linkStatusState");

type LinkStatusListener = () => void;
type LinkStatusState = {
  activeLinkId: number | null;
  nextLinkId: number;
  listeners: Set<LinkStatusListener>;
  historyPatched: boolean;
  originalPushState: History["pushState"] | null;
  originalReplaceState: History["replaceState"] | null;
};

type LinkStatusGlobal = typeof globalThis & {
  [_LINK_STATUS_STATE_KEY]?: LinkStatusState;
};

function getLinkStatusState(): LinkStatusState {
  const globalState = globalThis as LinkStatusGlobal;
  globalState[_LINK_STATUS_STATE_KEY] ??= {
    activeLinkId: null,
    nextLinkId: 1,
    listeners: new Set(),
    historyPatched: false,
    originalPushState: null,
    originalReplaceState: null,
  };
  return globalState[_LINK_STATUS_STATE_KEY]!;
}

function notifyLinkStatusListeners(): void {
  const state = getLinkStatusState();
  for (const listener of state.listeners) listener();
}

function beginLinkPending(linkId: number): void {
  const state = getLinkStatusState();
  state.activeLinkId = linkId;
  notifyLinkStatusListeners();
}

function clearLinkPending(linkId?: number): void {
  const state = getLinkStatusState();
  if (linkId !== undefined && state.activeLinkId !== linkId) return;
  if (state.activeLinkId === null) return;
  state.activeLinkId = null;
  notifyLinkStatusListeners();
}

function subscribeLinkStatus(listener: LinkStatusListener): () => void {
  const state = getLinkStatusState();
  state.listeners.add(listener);
  return () => {
    state.listeners.delete(listener);
  };
}

function installLinkStatusNavigationListeners(): void {
  if (typeof window === "undefined") return;
  const state = getLinkStatusState();
  if (state.historyPatched) return;
  state.historyPatched = true;
  state.originalPushState = window.history.pushState.bind(window.history);
  state.originalReplaceState = window.history.replaceState.bind(window.history);

  window.addEventListener(LINK_STATUS_NAVIGATION_EVENT, () => clearLinkPending());
  window.addEventListener("popstate", () => clearLinkPending());

  window.history.pushState = function patchedLinkStatusPushState(
    data: unknown,
    unused: string,
    url?: string | URL | null,
  ): void {
    state.originalPushState!.call(window.history, data, unused, url);
    clearLinkPending();
  };

  window.history.replaceState = function patchedLinkStatusReplaceState(
    data: unknown,
    unused: string,
    url?: string | URL | null,
  ): void {
    state.originalReplaceState!.call(window.history, data, unused, url);
    clearLinkPending();
  };
}

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
const __trailingSlash = process.env.__NEXT_ROUTER_TRAILING_SLASH === "true";

function pathnameFromAsPath(asPath: string | undefined): string {
  if (!asPath) return "/";
  const pathname = asPath.split(/[?#]/, 1)[0];
  return pathname || "/";
}

function getCurrentLinkPathname(routerContext: { asPath?: string } | null): string {
  if (routerContext?.asPath) return pathnameFromAsPath(routerContext.asPath);
  if (typeof window !== "undefined") {
    if (typeof window.location.pathname === "string") {
      return stripBasePath(window.location.pathname, __basePath);
    }
    if (typeof window.location.href === "string") {
      try {
        return stripBasePath(new URL(window.location.href).pathname, __basePath);
      } catch {
        return "/";
      }
    }
  }
  return "/";
}

function resolveHref(href: LinkProps["href"], currentPathname = "/"): string {
  if (typeof href === "string") return href;
  let url = href.pathname ?? currentPathname;
  if (href.query) {
    const params = urlQueryToSearchParams(href.query);
    url = appendSearchParamsToUrl(url, params);
  }
  return url;
}

function hasRepeatedForwardSlashOrBackslash(href: string): boolean {
  if (href.includes("\\")) return true;

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(href) || href.startsWith("//")) {
    try {
      return new URL(href, "http://vinext.local").pathname.includes("//");
    } catch {
      return false;
    }
  }

  const pathname = href.split(/[?#]/, 1)[0] ?? "";
  return pathname.includes("//");
}

function warnInvalidNavigationHref(href: string, page: string): void {
  console.error(
    `Invalid href '${href}' passed to next/router in page: '${page}'. Repeated forward-slashes (//) or backslashes \\ are not valid in the href.`,
  );
}

function getPagesDataPathParts(pathname: string): { localePrefix: string; pagePathname: string } {
  const locales = window.__VINEXT_LOCALES__ ?? [];
  const defaultLocale = window.__VINEXT_DEFAULT_LOCALE__;
  const targetLocale = pathname.split("/").filter(Boolean)[0];
  if (targetLocale && locales.includes(targetLocale)) {
    const pagePathname = pathname.slice(targetLocale.length + 1) || "/";
    return { localePrefix: `/${targetLocale}`, pagePathname };
  }

  if (defaultLocale && locales.includes(defaultLocale)) {
    return { localePrefix: `/${defaultLocale}`, pagePathname: pathname };
  }

  // Non-i18n prefetch data URLs do not carry a locale prefix.
  return { localePrefix: "", pagePathname: pathname };
}

function buildPagesPrefetchDataUrl(href: string): string | null {
  if (typeof window === "undefined") return null;

  const buildId = window.__NEXT_DATA__?.buildId ?? process.env.__VINEXT_BUILD_ID;
  if (!buildId) return null;

  const url = new URL(href, window.location.href);
  let pathname = url.pathname;

  for (const [key, value] of url.searchParams) {
    const encoded = encodeURIComponent(value);
    const before = pathname;
    pathname = pathname
      .replace(new RegExp(`\\[\\.\\.\\.${key}\\]`, "g"), encoded)
      .replace(new RegExp(`\\[${key}\\]`, "g"), encoded);
    if (pathname !== before) {
      url.searchParams.delete(key);
    }
  }

  if (pathname.includes("[")) {
    return null;
  }

  const dataPathParts = getPagesDataPathParts(pathname);
  const pagePathname =
    dataPathParts.pagePathname === "/"
      ? dataPathParts.localePrefix
        ? ""
        : "/index"
      : dataPathParts.pagePathname.replace(/\/$/, "");
  const query = url.searchParams.toString();
  return `${window.location.origin}${__basePath}/_next/data/${buildId}${dataPathParts.localePrefix}${pagePathname}.json${query ? `?${query}` : ""}`;
}

function pagesRoutePatternToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&");
  const regex = escaped
    .replace(/\\\[\\\[\\.\\.\\.[^\]]+\\\]\\\]/g, "(?:/.*)?")
    .replace(/\\\[\\.\\.\\.[^\]]+\\\]/g, "/.+")
    .replace(/\\\[[^\]]+\\\]/g, "[^/]+");
  return new RegExp(`^${regex === "/" ? "/" : regex.replace(/\/$/, "")}/?$`);
}

function isPagesSsgPrefetchTarget(href: string): boolean {
  if (typeof window === "undefined") return false;
  const ssgRoutes = window.__VINEXT_PAGES_SSG_ROUTES__;
  if (!ssgRoutes || ssgRoutes.size === 0) return false;

  const url = new URL(href, window.location.href);
  const { pagePathname } = getPagesDataPathParts(url.pathname);
  const pathname = pagePathname === "" ? "/" : pagePathname;

  for (const route of ssgRoutes) {
    if (route === pathname) return true;
    if (route.includes("[") && pagesRoutePatternToRegex(route).test(pathname)) {
      return true;
    }
  }
  return false;
}

function hasDynamicRouteSegment(href: string): boolean {
  try {
    return new URL(href, window.location.href).pathname.includes("[");
  } catch {
    return href.split(/[?#]/, 1)[0]?.includes("[") === true;
  }
}

function isPagesDynamicSsgPrefetchTarget(href: string): boolean {
  if (typeof window === "undefined") return false;
  const ssgRoutes = window.__VINEXT_PAGES_SSG_ROUTES__;
  if (!ssgRoutes || ssgRoutes.size === 0) return false;

  const url = new URL(href, window.location.href);
  const { pagePathname } = getPagesDataPathParts(url.pathname);
  const pathname = pagePathname === "" ? "/" : pagePathname;

  for (const route of ssgRoutes) {
    if (route.includes("[") && pagesRoutePatternToRegex(route).test(pathname)) {
      return true;
    }
  }
  return false;
}

function withVinextPrefetchMarker(href: string): string {
  try {
    const url = new URL(href, window.location.href);
    url.searchParams.set("__vinext_prefetch", "1");
    return url.pathname + url.search + url.hash;
  } catch {
    return href.includes("?") ? `${href}&__vinext_prefetch=1` : `${href}?__vinext_prefetch=1`;
  }
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
function prefetchUrl(href: string, dataHref = href, options: { immediate?: boolean } = {}): void {
  if (typeof window === "undefined") return;

  // Normalize same-origin absolute URLs to local paths before prefetching
  let prefetchHref = href;
  if (href.startsWith("http://") || href.startsWith("https://") || href.startsWith("//")) {
    const localPath = toSameOriginAppPath(href, __basePath);
    if (localPath == null) return; // truly external — don't prefetch
    prefetchHref = localPath;
  }

  const fullHref = toBrowserNavigationHref(prefetchHref, window.location.href, __basePath);

  const schedule = options.immediate
    ? (fn: () => void) => fn()
    : (window.requestIdleCallback ?? ((fn: () => void) => setTimeout(fn, 100)));

  schedule(() => {
    if (typeof window.__VINEXT_RSC_NAVIGATE__ === "function") {
      // Distinguish the same visible URL when it is prefetched from different
      // interception sources such as /feed vs /gallery.
      const rscUrl = toRscUrl(fullHref);
      const interceptionContext = getCurrentInterceptionContext();
      const cacheKey = createAppPayloadCacheKey(rscUrl, interceptionContext);
      const prefetched = getPrefetchedUrls();
      if (prefetched.has(cacheKey)) return;
      prefetched.add(cacheKey);

      const mountedSlotsHeader = getMountedSlotsHeader();
      const headers = new Headers({ Accept: "text/x-component" });
      if (mountedSlotsHeader) {
        headers.set("X-Vinext-Mounted-Slots", mountedSlotsHeader);
      }
      if (interceptionContext !== null) {
        headers.set("X-Vinext-Interception-Context", interceptionContext);
      }
      prefetchRscResponse(
        rscUrl,
        fetch(rscUrl, {
          headers,
          credentials: "include",
          priority: "low" as const,
          // @ts-expect-error — purpose is a valid fetch option in some browsers
          purpose: "prefetch",
        }),
        interceptionContext,
        mountedSlotsHeader,
      );
    } else {
      // Pages Router data can be request-specific (notably getServerSideProps),
      // so only prefetch JSON for routes we know are getStaticProps pages.
      const dataUrl = buildPagesPrefetchDataUrl(dataHref);
      if (!dataUrl) return;
      if (!isPagesSsgPrefetchTarget(dataHref)) return;

      if (options.immediate) {
        const prefetchMarkerHref = withVinextPrefetchMarker(fullHref);
        void fetch(prefetchMarkerHref, {
          headers: { purpose: "prefetch" },
          credentials: "include",
          cache: "no-store",
          priority: "low" as const,
          // @ts-expect-error — purpose is a valid fetch option in some browsers
          purpose: "prefetch",
        }).catch(() => {
          // Best-effort parity signal; navigation still fetches authoritative data.
        });
        return;
      }

      if (isPagesDynamicSsgPrefetchTarget(dataHref) && !hasDynamicRouteSegment(dataHref)) return;

      window.next ??= {};
      window.next.router ??= { sdc: {} } as NonNullable<typeof window.next>["router"];
      const router = window.next.router!;
      router.sdc ??= {};
      if (!options.immediate && router.sdc[dataUrl]) return;

      fetch(dataUrl, {
        headers: { Purpose: "prefetch" },
        credentials: "include",
        cache: "no-store",
        priority: "low" as const,
        // @ts-expect-error — purpose is a valid fetch option in some browsers
        purpose: "prefetch",
      })
        .then(async (response) => {
          if (!response.ok) return;
          if (response.headers.get("x-middleware-cache")?.toLowerCase() === "no-cache") return;
          const contentType = response.headers.get("Content-Type") ?? "";
          if (!contentType.toLowerCase().includes("application/json")) return;

          const nextData = (await response.json()) as VinextNextData;
          if (nextData.gsp !== true) return;
          window.next!.router!.sdc[dataUrl] = nextData;
        })
        .catch(() => {
          // Prefetch failures are non-fatal and should not affect navigation.
        });
    }
  });
}

/**
 * Shared IntersectionObserver for viewport-based prefetching.
 * All Link elements use the same observer to minimize resource usage.
 */
let sharedObserver: IntersectionObserver | null = null;
const observerCallbacks = new WeakMap<Element, () => void>();

function getSharedObserver(): IntersectionObserver | null {
  if (typeof window === "undefined" || typeof IntersectionObserver === "undefined") return null;
  if (sharedObserver) return sharedObserver;

  sharedObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          const callback = observerCallbacks.get(entry.target);
          if (callback) {
            callback();
            // Unobserve after prefetching — only prefetch once
            sharedObserver?.unobserve(entry.target);
            observerCallbacks.delete(entry.target);
          }
        }
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
    return window.__VINEXT_LOCALE__;
  }
  return getI18nContext()?.locale;
}

function getConfiguredLocales(): readonly string[] | undefined {
  if (typeof window !== "undefined") {
    return window.__VINEXT_LOCALES__;
  }
  return getI18nContext()?.locales;
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

function hasLocalePrefix(pathname: string): boolean {
  const locales = getConfiguredLocales();
  if (!locales?.length) return false;

  const firstSegment = pathname.split("/").filter(Boolean)[0];
  return firstSegment !== undefined && locales.includes(firstSegment);
}

/**
 * Apply locale prefix to a URL path based on the locale prop.
 * - locale="fr" → prepend /fr (unless it already has a locale prefix)
 * - locale={false} → use the href as-is (no locale prefix, link to default)
 * - locale=undefined → use the active i18n locale when the current URL is locale-prefixed
 */
function applyLocaleToHref(
  href: string,
  locale: string | false | undefined,
  options: { useImplicitActiveLocale?: boolean } = {},
): string {
  if (locale === false) {
    // Explicit false: no locale prefix
    return href;
  }

  // Absolute and protocol-relative URLs must not be prefixed — locale
  // only applies to local paths.
  if (href.startsWith("http://") || href.startsWith("https://") || href.startsWith("//")) {
    return href;
  }

  const effectiveLocale =
    locale ?? (options.useImplicitActiveLocale === false ? getDefaultLocale() : getCurrentLocale());
  if (effectiveLocale === undefined) {
    return href;
  }

  const domainLocaleHref = getDomainLocaleHref(href, effectiveLocale);
  if (domainLocaleHref) {
    return domainLocaleHref;
  }

  return addLocalePrefix(href, effectiveLocale, getDefaultLocale() ?? "");
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
    onNavigate,
    ...rest
  },
  forwardedRef,
) {
  const routerContext = useContext(RouterContext);
  const currentPathname = getCurrentLinkPathname(routerContext);

  // Extract locale from rest props
  const { locale, ...restWithoutLocale } = rest;

  // If `as` is provided, use it as the actual URL (legacy Next.js pattern
  // where href is a route pattern like "/user/[id]" and as is "/user/1")
  const resolvedHref = as ?? resolveHref(href, currentPathname);
  if (hasRepeatedForwardSlashOrBackslash(resolvedHref)) {
    warnInvalidNavigationHref(resolvedHref, routerContext?.pathname ?? routerContext?.route ?? "");
  }

  const isDangerous = typeof resolvedHref === "string" && isDangerousScheme(resolvedHref);

  // Apply locale prefix if specified (safe even for dangerous hrefs since we
  // won't use the result when isDangerous is true)
  const routeHref = resolveHref(href, currentPathname);
  const useImplicitActiveLocale =
    locale !== undefined || routerContext == null || hasLocalePrefix(currentPathname);
  const localizedRouteHref = normalizeLocalTrailingSlashHref(
    applyLocaleToHref(isDangerous ? "/" : routeHref, locale, { useImplicitActiveLocale }),
    __trailingSlash,
  );
  const localizedHref = normalizeLocalTrailingSlashHref(
    applyLocaleToHref(isDangerous ? "/" : resolvedHref, locale, { useImplicitActiveLocale }),
    __trailingSlash,
  );
  // Full href with basePath for browser URLs and fetches
  const fullHref = withBasePath(localizedHref, __basePath);

  // Track pending state for useLinkStatus()
  const [pending, setPending] = useState(false);
  const linkStatusIdRef = useRef<number | null>(null);
  if (linkStatusIdRef.current === null) {
    linkStatusIdRef.current = getLinkStatusState().nextLinkId++;
  }
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    installLinkStatusNavigationListeners();
    const syncPending = () => {
      const state = getLinkStatusState();
      setPending(state.activeLinkId === linkStatusIdRef.current);
    };
    const unsubscribe = subscribeLinkStatus(syncPending);
    syncPending();
    return () => {
      mountedRef.current = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    clearLinkPending(linkStatusIdRef.current ?? undefined);
  }, [fullHref]);

  // Prefetching: observe the element when it enters the viewport.
  // prefetch={false} disables, prefetch={true} or undefined/null (default) enables.
  const internalRef = useRef<HTMLAnchorElement | null>(null);
  const shouldPrefetch = prefetchProp !== false && !isDangerous && !shallow;

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
    if (!shouldPrefetch || typeof window === "undefined") return;
    const node = internalRef.current;
    if (!node) return;

    // Normalize same-origin absolute URLs; skip truly external ones
    let hrefToPrefetch = localizedHref;
    if (
      localizedHref.startsWith("http://") ||
      localizedHref.startsWith("https://") ||
      localizedHref.startsWith("//")
    ) {
      const localPath = toSameOriginAppPath(localizedHref, __basePath);
      if (localPath == null) return; // truly external
      hrefToPrefetch = localPath;
    }

    const observer = getSharedObserver();
    if (!observer) return;

    observerCallbacks.set(node, () => prefetchUrl(hrefToPrefetch, resolveHref(href)));
    observer.observe(node);

    return () => {
      observer.unobserve(node);
      observerCallbacks.delete(node);
    };
  }, [shouldPrefetch, localizedHref, href]);

  const handleClick = async (e: MouseEvent<HTMLAnchorElement>) => {
    if (onClick) onClick(e);
    if (e.defaultPrevented) return;

    // Only intercept left clicks without modifiers (standard link behavior)
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
      return;
    }

    // Don't intercept links with target (e.g. target="_blank")
    if (e.currentTarget.target && e.currentTarget.target !== "_self") {
      return;
    }

    // Download links keep native browser behavior and do not fire onNavigate.
    if (e.currentTarget.hasAttribute("download")) {
      return;
    }

    // External links: let the browser handle it.
    // Same-origin absolute URLs (e.g. http://localhost:3000/about) are
    // normalized to local paths so they get client-side navigation.
    let navigateHref = localizedHref;
    let navigateRouteHref = localizedRouteHref;
    if (
      resolvedHref.startsWith("http://") ||
      resolvedHref.startsWith("https://") ||
      resolvedHref.startsWith("//")
    ) {
      const localPath = toSameOriginAppPath(resolvedHref, __basePath);
      if (localPath == null) {
        if (replace) {
          e.preventDefault();
          window.location.replace(resolvedHref);
        }
        return; // truly external
      }
      navigateHref = localPath;
    }
    if (
      routeHref.startsWith("http://") ||
      routeHref.startsWith("https://") ||
      routeHref.startsWith("//")
    ) {
      const localPath = toSameOriginAppPath(routeHref, __basePath);
      if (localPath != null) {
        navigateRouteHref = normalizeLocalTrailingSlashHref(localPath, __trailingSlash);
      }
    }

    e.preventDefault();

    const absoluteFullHref = toBrowserNavigationHref(
      navigateHref,
      window.location.href,
      __basePath,
    );
    const explicitLocale =
      typeof locale === "string" && locale !== "" && locale !== getDefaultLocale();
    if (explicitLocale && localizedHref.startsWith("/") && !localizedHref.startsWith("//")) {
      void fetch(absoluteFullHref, {
        method: "HEAD",
        credentials: "include",
      }).catch(() => {
        // Redirect probes are best-effort; the actual router navigation below
        // remains authoritative.
      });
    }

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
    if (typeof window.__VINEXT_RSC_NAVIGATE__ === "function") {
      beginLinkPending(linkStatusIdRef.current!);
      try {
        await navigateClientSide(navigateHref, replace ? "replace" : "push", scroll);
      } finally {
        if (mountedRef.current) clearLinkPending(linkStatusIdRef.current ?? undefined);
      }
    } else {
      // Next.js only consumes onRouterTransitionStart in the App Router.
      // Pages Router still executes instrumentation-client side effects
      // during startup, but it does not invoke the named export on navigation.
      // Pages Router: use the Router singleton
      try {
        const asHref = as === undefined ? undefined : navigateHref;
        if (replace) {
          await Router.replace(navigateRouteHref, asHref, { scroll, shallow });
        } else {
          await Router.push(navigateRouteHref, asHref, { scroll, shallow });
        }
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

  const handleMouseEnter = (e: MouseEvent<HTMLAnchorElement>) => {
    if (onMouseEnter) onMouseEnter(e);
    if (!shouldPrefetch || typeof window === "undefined") return;
    prefetchUrl(localizedHref, resolveHref(href), { immediate: true });
  };

  // Remove props that shouldn't be on <a>
  const { passHref, legacyBehavior, ...anchorProps } = restWithoutLocale;

  const linkStatusValue = React.useMemo(() => ({ pending }), [pending]);

  // Block dangerous URI schemes (javascript:, data:, vbscript:).
  // Render an inert <a> without href to prevent XSS while preserving
  // styling and attributes like className, id, aria-*.
  // This check is placed after all hooks to satisfy the Rules of Hooks.
  if (isDangerous) {
    if (process.env.NODE_ENV !== "production") {
      console.warn(`<Link> blocked dangerous href: ${resolvedHref}`);
    }
    return <a {...anchorProps}>{children}</a>;
  }

  if (legacyBehavior) {
    if (React.isValidElement(children)) {
      const childProps = children.props as AnchorHTMLAttributes<HTMLAnchorElement>;
      const legacyProps: AnchorHTMLAttributes<HTMLAnchorElement> & {
        ref?: React.Ref<HTMLAnchorElement>;
      } = {
        onClick(e) {
          childProps.onClick?.(e);
          if (!e.defaultPrevented) {
            handleClick(e);
          }
        },
        onMouseEnter(e) {
          childProps.onMouseEnter?.(e);
          handleMouseEnter(e);
        },
      };

      if (
        passHref ||
        (typeof children.type === "string" && children.type === "a" && childProps.href == null)
      ) {
        legacyProps.href = fullHref;
      }

      if (typeof children.type === "string" && children.type === "a") {
        legacyProps.ref = setRefs;
      }

      return (
        <LinkStatusContext.Provider value={linkStatusValue}>
          {React.cloneElement(children, legacyProps)}
        </LinkStatusContext.Provider>
      );
    }

    return (
      <LinkStatusContext.Provider value={linkStatusValue}>
        <a
          ref={setRefs}
          href={fullHref}
          onClick={handleClick}
          onMouseEnter={handleMouseEnter}
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
        onClick={handleClick}
        onMouseEnter={handleMouseEnter}
        {...anchorProps}
      >
        {children}
      </a>
    </LinkStatusContext.Provider>
  );
});

export default Link;
