"use client";

import React, {
  createContext,
  forwardRef,
  useContext,
  type AnchorHTMLAttributes,
  type MouseEvent,
} from "react";
import { appendSearchParamsToUrl, type UrlQuery, urlQueryToSearchParams } from "../utils/query.js";
import {
  isAbsoluteOrProtocolRelativeUrl,
  normalizePathTrailingSlash,
  withBasePath,
} from "./url-utils.js";
import { isDangerousScheme, reportBlockedDangerousNavigation } from "./url-safety.js";

type NavigateEvent = {
  url: URL;
  preventDefault(): void;
  defaultPrevented: boolean;
};

type LinkProps = {
  href: string | { pathname?: string; query?: UrlQuery };
  as?: string;
  replace?: boolean;
  prefetch?: boolean | "auto" | null;
  unstable_dynamicOnHover?: boolean;
  passHref?: boolean;
  legacyBehavior?: boolean;
  scroll?: boolean;
  shallow?: boolean;
  locale?: string | false;
  onNavigate?: (event: NavigateEvent) => void;
  children?: React.ReactNode;
} & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href">;

type LinkStatusContextValue = {
  pending: boolean;
};

const LinkStatusContext = createContext<LinkStatusContextValue>({ pending: false });
const IDLE_LINK_STATUS = { pending: false };
const BASE_PATH: string = process.env.__NEXT_ROUTER_BASEPATH ?? "";
const TRAILING_SLASH = process.env.__VINEXT_TRAILING_SLASH === "true";

export function useLinkStatus(): LinkStatusContextValue {
  return useContext(LinkStatusContext);
}

function resolveHref(href: LinkProps["href"]): string {
  if (typeof href === "string") return href;
  let url = href.pathname ?? "";
  if (href.query) {
    url = appendSearchParamsToUrl(url, urlQueryToSearchParams(href.query));
  }
  return url;
}

function normalizeRepeatedSlashes(url: string): string {
  const [pathname = "", ...queryParts] = url.split("?");
  const query = queryParts.join("?");
  const normalized = pathname.replace(/\\/g, "/").replace(/\/\/+/g, "/");
  return query ? `${normalized}?${query}` : normalized;
}

function resolveDocumentHref(href: LinkProps["href"], as: string | undefined): string {
  const resolved = as ?? resolveHref(href);
  if (isAbsoluteOrProtocolRelativeUrl(resolved)) return resolved;
  return normalizePathTrailingSlash(
    withBasePath(normalizeRepeatedSlashes(resolved), BASE_PATH),
    TRAILING_SLASH,
  );
}

function shouldHandleNavigation(event: MouseEvent<HTMLAnchorElement>): boolean {
  return (
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey &&
    !event.currentTarget.hasAttribute("download") &&
    (!event.currentTarget.target || event.currentTarget.target === "_self")
  );
}

function isExternalDocumentHref(href: string): boolean {
  const url = new URL(href, window.location.href);
  return url.origin !== window.location.origin;
}

const Link = forwardRef<HTMLAnchorElement, LinkProps>(function Link(
  {
    href,
    as,
    replace = false,
    prefetch: _prefetch,
    unstable_dynamicOnHover: _unstableDynamicOnHover,
    passHref = false,
    legacyBehavior = false,
    scroll: _scroll,
    shallow: _shallow,
    locale: _locale,
    onNavigate,
    children,
    onClick,
    ...anchorProps
  },
  forwardedRef,
) {
  const rawHref = as ?? resolveHref(href);
  const dangerous = isDangerousScheme(rawHref);
  const documentHref = dangerous ? undefined : resolveDocumentHref(href, as);

  const handleClick = (event: MouseEvent<HTMLAnchorElement>): void => {
    onClick?.(event);
    if (event.defaultPrevented) return;
    if (dangerous) {
      event.preventDefault();
      reportBlockedDangerousNavigation();
      return;
    }

    if (!documentHref || !shouldHandleNavigation(event)) return;
    if (isExternalDocumentHref(documentHref)) {
      if (replace) {
        event.preventDefault();
        window.location.replace(documentHref);
      }
      return;
    }

    if (onNavigate) {
      let prevented = false;
      const url = new URL(documentHref, window.location.href);
      onNavigate({
        url,
        preventDefault() {
          prevented = true;
        },
        get defaultPrevented() {
          return prevented;
        },
      });
      if (prevented) {
        event.preventDefault();
        return;
      }
    }

    if (replace) {
      event.preventDefault();
      window.location.replace(documentHref);
    }
  };

  if (legacyBehavior) {
    const child = React.Children.only(children) as React.ReactElement<{
      href?: string;
      onClick?: (event: MouseEvent<HTMLAnchorElement>) => void;
      ref?: React.Ref<HTMLAnchorElement>;
    }>;
    const childHasOwnHref = child.type === "a" && "href" in child.props;
    const shouldForwardHref = passHref || (child.type === "a" && !childHasOwnHref);
    const childOnClick = child.props.onClick;
    const childRef = child.props.ref;
    const setRefs = (node: HTMLAnchorElement | null): void => {
      if (typeof childRef === "function") childRef(node);
      else if (childRef) childRef.current = node;
    };
    return (
      <LinkStatusContext.Provider value={IDLE_LINK_STATUS}>
        {React.cloneElement(child, {
          ...(shouldForwardHref ? { href: documentHref } : {}),
          ref: setRefs,
          onClick: (event: MouseEvent<HTMLAnchorElement>) => {
            childOnClick?.(event);
            if (!event.defaultPrevented) handleClick(event);
          },
        })}
      </LinkStatusContext.Provider>
    );
  }

  return (
    <LinkStatusContext.Provider value={IDLE_LINK_STATUS}>
      <a ref={forwardedRef} href={documentHref} onClick={handleClick} {...anchorProps}>
        {children}
      </a>
    </LinkStatusContext.Provider>
  );
});

export default Link;
