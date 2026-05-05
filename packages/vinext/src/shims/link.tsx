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
  getPrefetchedUrls,
  getMountedSlotsHeader,
  navigateClientSide,
  prefetchRscResponse,
} from "./navigation.js";
import { AppElementsWire } from "../server/app-elements.js";
import {
  createRscRequestHeaders,
  createRscRequestUrl,
  VINEXT_RSC_MOUNTED_SLOTS_HEADER,
} from "../server/app-rsc-cache-busting.js";
import { isDangerousScheme } from "./url-safety.js";
import {
  resolveRelativeHref,
  toBrowserNavigationHref,
  toSameOriginAppPath,
  withBasePath,
} from "./url-utils.js";
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
  /** Scroll to top on navigation (default: true) */
  scroll?: boolean;
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

function resolveHref(href: LinkProps["href"]): string {
  if (typeof href === "string") return href;
  let url = href.pathname ?? "/";
  if (href.query) {
    const params = urlQueryToSearchParams(href.query);
    url = appendSearchParamsToUrl(url, params);
  }
  return url;
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
function prefetchUrl(href: string): void {
  if (typeof window === "undefined") return;

  // Normalize same-origin absolute URLs to local paths before prefetching
  let prefetchHref = href;
  if (href.startsWith("http://") || href.startsWith("https://") || href.startsWith("//")) {
    const localPath = toSameOriginAppPath(href, __basePath);
    if (localPath == null) return; // truly external — don't prefetch
    prefetchHref = localPath;
  }

  const fullHref = toBrowserNavigationHref(prefetchHref, window.location.href, __basePath);

  const schedule = window.requestIdleCallback ?? ((fn: () => void) => setTimeout(fn, 100));

  schedule(() => {
    void (async () => {
      if (typeof window.__VINEXT_RSC_NAVIGATE__ === "function") {
        const interceptionContext = getCurrentInterceptionContext();
        const mountedSlotsHeader = getMountedSlotsHeader();
        const headers = createRscRequestHeaders({ interceptionContext });
        if (mountedSlotsHeader) {
          headers.set(VINEXT_RSC_MOUNTED_SLOTS_HEADER, mountedSlotsHeader);
        }
        // Distinguish the same visible URL when it is prefetched from different
        // request contexts such as /feed vs /gallery or different mounted slots.
        const rscUrl = await createRscRequestUrl(fullHref, headers);
        const cacheKey = AppElementsWire.encodeCacheKey(rscUrl, interceptionContext);
        const prefetched = getPrefetchedUrls();
        if (prefetched.has(cacheKey)) return;
        prefetched.add(cacheKey);
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
      } else if ((window.__NEXT_DATA__ as VinextNextData | undefined)?.__vinext?.pageModuleUrl) {
        // Pages Router: inject a prefetch link for the target page module
        // We can't easily resolve the target page's module URL from the Link,
        // so we create a <link rel="prefetch"> for the HTML page which helps
        // the browser's preload scanner.
        const link = document.createElement("link");
        link.rel = "prefetch";
        link.href = fullHref;
        link.as = "document";
        document.head.appendChild(link);
      }
    })().catch((error) => {
      console.error("[vinext] RSC prefetch setup error:", error);
    });
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

  if (locale === undefined) {
    // No locale prop: keep current behavior (href as-is)
    return href;
  }

  // Absolute and protocol-relative URLs must not be prefixed — locale
  // only applies to local paths.
  if (href.startsWith("http://") || href.startsWith("https://") || href.startsWith("//")) {
    return href;
  }

  const domainLocaleHref = getDomainLocaleHref(href, locale);
  if (domainLocaleHref) {
    return domainLocaleHref;
  }

  return addLocalePrefix(href, locale, getDefaultLocale() ?? "");
}

const Link = forwardRef<HTMLAnchorElement, LinkProps>(function Link(
  {
    href,
    as,
    replace = false,
    prefetch: prefetchProp,
    scroll = true,
    children,
    onClick,
    onNavigate,
    ...rest
  },
  forwardedRef,
) {
  // Extract locale from rest props
  const { locale, ...restWithoutLocale } = rest;

  // If `as` is provided, use it as the actual URL (legacy Next.js pattern
  // where href is a route pattern like "/user/[id]" and as is "/user/1")
  const resolvedHref = as ?? resolveHref(href);

  const isDangerous = typeof resolvedHref === "string" && isDangerousScheme(resolvedHref);

  // Apply locale prefix if specified (safe even for dangerous hrefs since we
  // won't use the result when isDangerous is true)
  const localizedHref = applyLocaleToHref(isDangerous ? "/" : resolvedHref, locale);
  // Full href with basePath for browser URLs and fetches
  const fullHref = withBasePath(localizedHref, __basePath);

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
  // prefetch={false} disables, prefetch={true} or undefined/null (default) enables.
  const internalRef = useRef<HTMLAnchorElement | null>(null);
  const shouldPrefetch = prefetchProp !== false && !isDangerous;

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

    observerCallbacks.set(node, () => prefetchUrl(hrefToPrefetch));
    observer.observe(node);

    return () => {
      observer.unobserve(node);
      observerCallbacks.delete(node);
    };
  }, [shouldPrefetch, localizedHref]);

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

    // External links: let the browser handle it.
    // Same-origin absolute URLs (e.g. http://localhost:3000/about) are
    // normalized to local paths so they get client-side navigation.
    let navigateHref = localizedHref;
    if (
      resolvedHref.startsWith("http://") ||
      resolvedHref.startsWith("https://") ||
      resolvedHref.startsWith("//")
    ) {
      const localPath = toSameOriginAppPath(resolvedHref, __basePath);
      if (localPath == null) return; // truly external
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
    if (typeof window.__VINEXT_RSC_NAVIGATE__ === "function") {
      setPending(true);
      try {
        await navigateClientSide(navigateHref, replace ? "replace" : "push", scroll);
      } finally {
        if (mountedRef.current) setPending(false);
      }
    } else {
      // Next.js only consumes onRouterTransitionStart in the App Router.
      // Pages Router still executes instrumentation-client side effects
      // during startup, but it does not invoke the named export on navigation.
      // Pages Router: use the Router singleton
      try {
        const routerModule = await import("next/router");
        // oxlint-disable-next-line @typescript-eslint/no-explicit-any -- vinext's Router shim accepts (url, as, options)
        const Router = routerModule.default as any;
        if (replace) {
          await Router.replace(absoluteHref, undefined, { scroll });
        } else {
          await Router.push(absoluteHref, undefined, { scroll });
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

  // Remove props that shouldn't be on <a>
  const { passHref: _p, ...anchorProps } = restWithoutLocale;

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

  return (
    <LinkStatusContext.Provider value={linkStatusValue}>
      <a ref={setRefs} href={fullHref} onClick={handleClick} {...anchorProps}>
        {children}
      </a>
    </LinkStatusContext.Provider>
  );
});

export default Link;
