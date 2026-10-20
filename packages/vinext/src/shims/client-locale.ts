import { stripBasePath } from "../utils/base-path.js";
import {
  detectDomainLocale,
  getLocalePathPrefix,
  type DomainLocale,
} from "../utils/domain-locale.js";

export function getCurrentBrowserLocale({
  basePath,
  domainLocales,
  hostname,
}: {
  basePath: string;
  domainLocales: readonly DomainLocale[] | undefined;
  hostname: string | null | undefined;
}): string | undefined {
  if (typeof window === "undefined") return undefined;

  const pathnameLocale = getLocalePathPrefix(
    stripBasePath(window.location.pathname, basePath),
    window.__VINEXT_LOCALES__,
  );
  if (pathnameLocale) return pathnameLocale;

  // Prefer the actually-active locale (set by SSR for the rendered page) over
  // the configured default. This matters for the i18n-sticky-locale flow
  // (issue #1336): a default-locale path served under a non-default locale —
  // e.g. `id` rendered at `/about` with no `/id` prefix — must still report
  // its active locale so Router.push can stamp it into history state. Falling
  // back to the default would erase that stickiness on every client nav.
  return (
    detectDomainLocale(domainLocales, hostname ?? undefined)?.defaultLocale ??
    window.__VINEXT_LOCALE__ ??
    window.__VINEXT_DEFAULT_LOCALE__
  );
}

/**
 * Splice the (domain-aware) default locale into an unprefixed pathname before
 * matching config rules, like the server's `normalizeDefaultLocalePathname`
 * (Next.js resolve-routes). Locale-prefixed, `/_next/` and `/__vinext/` paths
 * are left as is. Pages documents carry the defaults in `__NEXT_DATA__`; App
 * documents in `__VINEXT_CONFIG_DEFAULT_LOCALE__`.
 */
export function addClientConfigDefaultLocale(
  pathname: string,
  hostname: string | undefined,
  restoreRootTrailingSlash: boolean,
): string {
  if (typeof window === "undefined") return pathname;
  const locales = window.__VINEXT_LOCALES__;
  if (!locales?.length) return pathname;
  if (pathname.startsWith("/_next/") || pathname.startsWith("/__vinext/")) return pathname;
  if (getLocalePathPrefix(pathname, locales)) return pathname;

  const appDefaults = window.__VINEXT_CONFIG_DEFAULT_LOCALE__;
  const domainLocales =
    (window.__NEXT_DATA__ as { domainLocales?: readonly DomainLocale[] } | undefined)
      ?.domainLocales ?? appDefaults?.domains;
  const defaultLocale =
    detectDomainLocale(domainLocales, hostname)?.defaultLocale ??
    window.__VINEXT_DEFAULT_LOCALE__ ??
    appDefaults?.defaultLocale;
  if (!defaultLocale) return pathname;
  if (pathname === "/") {
    return restoreRootTrailingSlash ? `/${defaultLocale}/` : `/${defaultLocale}`;
  }
  return `/${defaultLocale}${pathname}`;
}
