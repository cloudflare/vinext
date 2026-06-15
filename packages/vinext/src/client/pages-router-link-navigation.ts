import { stripBasePath } from "../utils/base-path.js";
import { getLocalePathPrefix } from "../utils/domain-locale.js";

type PagesRouterLinkTransitionOptions = {
  scroll?: boolean;
  shallow?: boolean;
  locale?: string | false;
};

type PagesRouterLinkRuntime = {
  push(url: string, as?: string, options?: PagesRouterLinkTransitionOptions): Promise<boolean>;
  replace(url: string, as?: string, options?: PagesRouterLinkTransitionOptions): Promise<boolean>;
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
  if (!href.startsWith("?")) return href;

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
    replace,
    scroll,
    shallow,
    locale,
  }: {
    href: string;
    replace: boolean;
    scroll: boolean;
    shallow?: boolean;
    locale?: string | false;
  },
): Promise<void> {
  const routerOptions: PagesRouterLinkTransitionOptions = { scroll, locale };
  if (shallow !== undefined) routerOptions.shallow = shallow;
  if (replace) {
    await router.replace(href, undefined, routerOptions);
  } else {
    await router.push(href, undefined, routerOptions);
  }
}
