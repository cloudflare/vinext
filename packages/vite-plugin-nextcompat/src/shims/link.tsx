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

function resolveHref(href: LinkProps["href"]): string {
  if (typeof href === "string") return href;
  let url = href.pathname ?? "/";
  if (href.query) {
    const params = new URLSearchParams(href.query);
    url += `?${params.toString()}`;
  }
  return url;
}

const Link = forwardRef<HTMLAnchorElement, LinkProps>(function Link(
  { href, as, replace = false, scroll = true, children, onClick, ...rest },
  ref,
) {
  // If `as` is provided, use it as the actual URL (legacy Next.js pattern
  // where href is a route pattern like "/user/[id]" and as is "/user/1")
  const resolvedHref = as ?? resolveHref(href);

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

    // Only intercept internal links
    if (
      resolvedHref.startsWith("http://") ||
      resolvedHref.startsWith("https://") ||
      resolvedHref.startsWith("//")
    ) {
      return;
    }

    e.preventDefault();

    // Use the Router singleton to navigate (which triggers client-side page swap)
    try {
      const routerModule = await import("next/router");
      const Router = routerModule.default;
      if (replace) {
        await Router.replace(resolvedHref);
      } else {
        await Router.push(resolvedHref);
      }
    } catch {
      // Fallback to hard navigation if router fails
      if (replace) {
        window.history.replaceState({}, "", resolvedHref);
      } else {
        window.history.pushState({}, "", resolvedHref);
      }
      window.dispatchEvent(new PopStateEvent("popstate"));
    }

    if (scroll) {
      window.scrollTo(0, 0);
    }
  };

  // Remove props that shouldn't be on <a>
  const { prefetch: _, passHref: _p, locale: _l, ...anchorProps } = rest;

  return (
    <a ref={ref} href={resolvedHref} onClick={handleClick} {...anchorProps}>
      {children}
    </a>
  );
});

export default Link;
