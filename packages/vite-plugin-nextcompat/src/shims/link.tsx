"use client";

/**
 * next/link shim
 *
 * Renders an <a> tag with client-side navigation support.
 * On click, prevents full page reload and triggers client-side
 * page swap via the router's navigation system.
 */
import React, { forwardRef, type AnchorHTMLAttributes, type MouseEvent } from "react";

interface LinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> {
  href: string | { pathname?: string; query?: Record<string, string> };
  /** URL displayed in the browser (when href is a route pattern like /user/[id]) */
  as?: string;
  /** Replace the current history entry instead of pushing */
  replace?: boolean;
  /** Prefetch the page in the background (no-op for now) */
  prefetch?: boolean;
  /** Whether to pass the href to the child element */
  passHref?: boolean;
  /** Scroll to top on navigation (default: true) */
  scroll?: boolean;
  /** Locale for i18n (no-op for now) */
  locale?: string | false;
  children?: React.ReactNode;
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

const Link = forwardRef<HTMLAnchorElement, LinkProps>(function Link(
  { href, as, replace = false, scroll = true, children, onClick, ...rest },
  ref,
) {
  // If `as` is provided, use it as the actual URL (legacy Next.js pattern
  // where href is a route pattern like "/user/[id]" and as is "/user/1")
  const resolvedHref = as ?? resolveHref(href);
  // Full href with basePath for browser URLs and fetches
  const fullHref = withBasePath(resolvedHref);

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

    // External links: let the browser handle it
    if (
      resolvedHref.startsWith("http://") ||
      resolvedHref.startsWith("https://") ||
      resolvedHref.startsWith("//")
    ) {
      return;
    }

    e.preventDefault();

    // Save scroll position for back/forward restoration
    if (!replace) {
      const state = window.history.state ?? {};
      window.history.replaceState(
        { ...state, __nextcompat_scrollX: window.scrollX, __nextcompat_scrollY: window.scrollY },
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
    if (typeof win.__NEXTCOMPAT_RSC_NAVIGATE__ === "function") {
      // App Router: push/replace history state, then fetch RSC stream
      if (replace) {
        window.history.replaceState(null, "", absoluteFullHref);
      } else {
        window.history.pushState(null, "", absoluteFullHref);
      }
      win.__NEXTCOMPAT_RSC_NAVIGATE__(absoluteFullHref);
    } else {
      // Pages Router: use the Router singleton
      try {
        const routerModule = await import("next/router");
        const Router = routerModule.default;
        if (replace) {
          await Router.replace(absoluteHref);
        } else {
          await Router.push(absoluteHref);
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
  const { prefetch: _, passHref: _p, locale: _l, ...anchorProps } = rest;

  return (
    <a ref={ref} href={fullHref} onClick={handleClick} {...anchorProps}>
      {children}
    </a>
  );
});

export default Link;
