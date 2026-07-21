import { stripBasePath } from "../utils/base-path.js";
import { getLocalePathPrefix } from "../utils/domain-locale.js";

type PagesRouterLinkTransitionOptions = {
  scroll?: boolean;
  shallow?: boolean;
  locale?: string | false;
  _vinextInterpolateDynamicRoute?: boolean;
};

type PagesRouterLinkRuntime = {
  push(url: string, as?: string, options?: PagesRouterLinkTransitionOptions): Promise<boolean>;
  replace(url: string, as?: string, options?: PagesRouterLinkTransitionOptions): Promise<boolean>;
};

type PagesRouterLinkNavigation = {
  href: string;
  /**
   * Optional `as` mask — the browser-bar URL when it differs from `href`
   * (a Pages Router route pattern, e.g. `<Link href="/posts/[id]" as="/posts/1">`).
   * When present, `router.push/replace(href, as, ...)` is invoked with both
   * values so the upstream (url, as) pair survives end-to-end. Mirrors
   * Next.js's Link → Router contract: packages/next/src/client/link.tsx
   * → router.push(href, as).
   */
  as?: string;
  replace: boolean;
  scroll: boolean;
  shallow?: boolean;
  locale?: string | false;
  interpolateDynamicRoute?: boolean;
};

export function resolvePagesRouterQueryOnlyHref(
  href: string,
  {
    asPath,
    basePath,
    fallbackHref,
    locales,
  }: {
    asPath?: string;
    basePath: string;
    fallbackHref: string;
    locales?: readonly string[];
  },
): string {
  if (!href.startsWith("?") && !href.startsWith("#")) return href;

  try {
    const fallbackUrl = new URL(fallbackHref);
    const base = new URL(
      asPath ??
        `${stripBasePath(fallbackUrl.pathname, basePath)}${fallbackUrl.search}${fallbackUrl.hash}`,
      "http://vinext.local",
    );
    const locale = getLocalePathPrefix(base.pathname, locales);
    if (locale) base.pathname = base.pathname.slice(locale.length + 1) || "/";
    const resolved = new URL(href, base);
    return resolved.href.slice(resolved.origin.length);
  } catch {
    return href;
  }
}

export async function navigatePagesRouterLink(
  router: PagesRouterLinkRuntime,
  {
    href,
    as,
    replace,
    scroll,
    shallow,
    locale,
    interpolateDynamicRoute = false,
  }: PagesRouterLinkNavigation,
): Promise<void> {
  const routerOptions: PagesRouterLinkTransitionOptions = {
    scroll,
    locale,
  };
  if (interpolateDynamicRoute) routerOptions._vinextInterpolateDynamicRoute = true;
  if (shallow !== undefined) routerOptions.shallow = shallow;
  if (replace) {
    await router.replace(href, as, routerOptions);
  } else {
    await router.push(href, as, routerOptions);
  }
}

export async function navigatePagesRouterLinkWithFallback({
  router,
  loadRouter,
  navigation,
  fallback,
}: {
  router?: PagesRouterLinkRuntime;
  loadRouter: () => Promise<PagesRouterLinkRuntime | undefined>;
  navigation: PagesRouterLinkNavigation;
  fallback: () => void;
}): Promise<void> {
  let pagesRouter = router;
  if (!pagesRouter) {
    try {
      pagesRouter = await loadRouter();
    } catch {
      fallback();
      return;
    }
  }
  if (!pagesRouter) {
    fallback();
    return;
  }

  await navigatePagesRouterLink(pagesRouter, navigation);
}
