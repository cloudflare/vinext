"use client";

/**
 * next/link shim
 *
 * Renders an <a> tag with client-side navigation support.
 * On click, prevents full page reload and triggers client-side
 * page swap via the router's navigation system.
 */
import React, { forwardRef, useRef, useEffect, useCallback, useContext, createContext, useState, type AnchorHTMLAttributes, type MouseEvent } from "react";
// Import shared RSC prefetch utilities from navigation shim (relative path
// so this resolves both via the Vite plugin and in direct vitest imports)
import { toRscUrl, getPrefetchedUrls, storePrefetchResponse } from "./navigation.js";

interface NavigateEvent {
  url: URL;
  /** Call to prevent the Link's default navigation (e.g. for View Transitions). */
  preventDefault(): void;
  /** Whether preventDefault() has been called. */
  defaultPrevented: boolean;
}

interface LinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> {
  href: string | { pathname?: string; query?: Record<string, string> };
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
}

// ---------------------------------------------------------------------------
// useLinkStatus — reports the pending state of a parent <Link> navigation
// ---------------------------------------------------------------------------

interface LinkStatusContextValue {
  pending: boolean;
}

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
    const params = new URLSearchParams(href.query);
    url += `?${params.toString()}`;
  }
  return url;
}

/** Prepend basePath to an internal path for browser URLs / fetches */
function withBasePath(path: string): string {
  if (!__basePath || path.startsWith("http://") || path.startsWith("https://") || path.startsWith("//")) {
    return path;
  }
  return __basePath + path;
}

/**
 * Check if a href is only a hash change (same pathname, different/added hash).
 * Handles relative hashes like "#foo" and "?query#foo".
 */
function isHashOnlyChange(href: string): boolean {
  if (href.startsWith("#")) return true;
  try {
    const current = new URL(window.location.href);
    const next = new URL(href, window.location.href);
    return current.pathname === next.pathname && current.search === next.search && next.hash !== "";
  } catch {
    return false;
  }
}

/**
 * Resolve a potentially relative href against the current URL.
 * Handles: "#hash", "?query", "?query#hash", relative paths.
 */
function resolveRelativeHref(href: string): string {
  if (typeof window === "undefined") return href;
  // Already absolute
  if (href.startsWith("/") || href.startsWith("http://") || href.startsWith("https://") || href.startsWith("//")) {
    return href;
  }
  // Relative: resolve against current location
  try {
    const resolved = new URL(href, window.location.href);
    return resolved.pathname + resolved.search + resolved.hash;
  } catch {
    return href;
  }
}

/**
 * Scroll to a hash target element, or to the top if no hash.
 */
function scrollToHash(hash: string): void {
  if (!hash || hash === "#") {
    window.scrollTo(0, 0);
    return;
  }
  const id = hash.slice(1); // Remove leading #
  const element = document.getElementById(id);
  if (element) {
    element.scrollIntoView({ behavior: "auto" });
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
function prefetchUrl(href: string): void {
  if (typeof window === "undefined") return;

  const fullHref = withBasePath(href);

  // Don't prefetch external URLs
  if (fullHref.startsWith("http://") || fullHref.startsWith("https://") || fullHref.startsWith("//")) return;

  // Don't prefetch the same URL twice (keyed by rscUrl so the browser
  // entry can clear the key when a cache entry is consumed)
  const rscUrl = toRscUrl(fullHref);
  const prefetched = getPrefetchedUrls();
  if (prefetched.has(rscUrl)) return;
  prefetched.add(rscUrl);

  const schedule = (window as any).requestIdleCallback ?? ((fn: () => void) => setTimeout(fn, 100));

  schedule(() => {
    const win = window as any;
    if (typeof win.__VINEXT_RSC_NAVIGATE__ === "function") {
      // App Router: prefetch the RSC payload and store in cache
      fetch(rscUrl, {
        headers: { Accept: "text/x-component" },
        credentials: "include",
        priority: "low" as any,
        // @ts-expect-error — purpose is a valid fetch option in some browsers
        purpose: "prefetch",
      }).then((response) => {
        if (response.ok) {
          storePrefetchResponse(rscUrl, response);
        } else {
          // Non-ok response: allow retry on next viewport intersection
          prefetched.delete(rscUrl);
        }
      }).catch(() => {
        // Network error: allow retry on next viewport intersection
        prefetched.delete(rscUrl);
      });
    } else if (win.__NEXT_DATA__?.__vinext?.pageModuleUrl) {
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
    return (window as any).__VINEXT_DEFAULT_LOCALE__ as string | undefined;
  }
  return (globalThis as any).__VINEXT_DEFAULT_LOCALE__ as string | undefined;
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

  // locale is a string: prepend the locale prefix if not already present
  const defaultLocale = getDefaultLocale();
  // For the default locale, Next.js doesn't add a prefix
  if (locale === defaultLocale) {
    return href;
  }

  // Check if href already starts with the locale
  if (href.startsWith(`/${locale}/`) || href === `/${locale}`) {
    return href;
  }

  return `/${locale}${href.startsWith("/") ? href : `/${href}`}`;
}

const Link = forwardRef<HTMLAnchorElement, LinkProps>(function Link(
  { href, as, replace = false, prefetch: prefetchProp, scroll = true, children, onClick, onNavigate, ...rest },
  forwardedRef,
) {
  // Extract locale from rest props
  const { locale, ...restWithoutLocale } = rest as any;

  // If `as` is provided, use it as the actual URL (legacy Next.js pattern
  // where href is a route pattern like "/user/[id]" and as is "/user/1")
  const resolvedHref = as ?? resolveHref(href);
  // Apply locale prefix if specified
  const localizedHref = applyLocaleToHref(resolvedHref, locale);
  // Full href with basePath for browser URLs and fetches
  const fullHref = withBasePath(localizedHref);

  // Track pending state for useLinkStatus()
  const [pending, setPending] = useState(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // Prefetching: observe the element when it enters the viewport.
  // prefetch={false} disables, prefetch={true} or undefined/null (default) enables.
  const internalRef = useRef<HTMLAnchorElement | null>(null);
  const shouldPrefetch = prefetchProp !== false;

  const setRefs = useCallback(
    (node: HTMLAnchorElement | null) => {
      internalRef.current = node;
      if (typeof forwardedRef === "function") forwardedRef(node);
      else if (forwardedRef) (forwardedRef as React.MutableRefObject<HTMLAnchorElement | null>).current = node;
    },
    [forwardedRef],
  );

  useEffect(() => {
    if (!shouldPrefetch || typeof window === "undefined") return;
    const node = internalRef.current;
    if (!node) return;

    // Don't prefetch external URLs
    if (localizedHref.startsWith("http://") || localizedHref.startsWith("https://") || localizedHref.startsWith("//")) return;

    const observer = getSharedObserver();
    if (!observer) return;

    observerCallbacks.set(node, () => prefetchUrl(localizedHref));
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
    if (
      e.button !== 0 ||
      e.metaKey ||
      e.ctrlKey ||
      e.shiftKey ||
      e.altKey
    ) {
      return;
    }

    // Don't intercept links with target (e.g. target="_blank")
    if (e.currentTarget.target && e.currentTarget.target !== "_self") {
      return;
    }

    // External links: let the browser handle it
    if (
      resolvedHref.startsWith("http://") ||
      resolvedHref.startsWith("https://") ||
      resolvedHref.startsWith("//")
    ) {
      return;
    }

    e.preventDefault();

    // Call onNavigate callback if provided (Next.js 16 View Transitions support)
    if (onNavigate) {
      try {
        const navUrl = new URL(resolvedHref, window.location.origin);
        let prevented = false;
        const navEvent: NavigateEvent = {
          url: navUrl,
          preventDefault() { prevented = true; },
          get defaultPrevented() { return prevented; },
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

    // Save scroll position for back/forward restoration
    if (!replace) {
      const state = window.history.state ?? {};
      window.history.replaceState(
        { ...state, __vinext_scrollX: window.scrollX, __vinext_scrollY: window.scrollY },
        "",
      );
    }

    // Resolve relative hrefs (#hash, ?query) against current URL
    const absoluteHref = resolveRelativeHref(resolvedHref);
    const absoluteFullHref = withBasePath(absoluteHref);

    // Hash-only change: update URL and scroll to target, skip RSC fetch
    if (typeof window !== "undefined" && isHashOnlyChange(absoluteFullHref)) {
      const hash = absoluteFullHref.includes("#") ? absoluteFullHref.slice(absoluteFullHref.indexOf("#")) : "";
      if (replace) {
        window.history.replaceState(null, "", absoluteFullHref);
      } else {
        window.history.pushState(null, "", absoluteFullHref);
      }
      if (scroll) {
        scrollToHash(hash);
      }
      return;
    }

    // Extract hash for scroll-after-navigation
    const hashIdx = absoluteFullHref.indexOf("#");
    const hash = hashIdx !== -1 ? absoluteFullHref.slice(hashIdx) : "";

    // Try RSC navigation first (App Router), then Pages Router
    const win = window as any;
    if (typeof win.__VINEXT_RSC_NAVIGATE__ === "function") {
      // App Router: push/replace history state, then fetch RSC stream.
      // Await the RSC navigate so scroll-to-top happens after the new
      // content is committed to the DOM (prevents flash of old page at top).
      if (replace) {
        window.history.replaceState(null, "", absoluteFullHref);
      } else {
        window.history.pushState(null, "", absoluteFullHref);
      }
      setPending(true);
      try {
        await win.__VINEXT_RSC_NAVIGATE__(absoluteFullHref);
      } finally {
        if (mountedRef.current) setPending(false);
      }
    } else {
      // Pages Router: use the Router singleton
      try {
        const routerModule = await import("next/router");
        // eslint-disable-next-line -- vinext's Router shim accepts (url, as, options)
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

    if (scroll) {
      if (hash) {
        scrollToHash(hash);
      } else {
        window.scrollTo(0, 0);
      }
    }
  };

  // Remove props that shouldn't be on <a>
  const { passHref: _p, ...anchorProps } = restWithoutLocale;

  const linkStatusValue = React.useMemo(() => ({ pending }), [pending]);

  return (
    <LinkStatusContext.Provider value={linkStatusValue}>
      <a ref={setRefs} href={fullHref} onClick={handleClick} {...anchorProps}>
        {children}
      </a>
    </LinkStatusContext.Provider>
  );
});

export default Link;
