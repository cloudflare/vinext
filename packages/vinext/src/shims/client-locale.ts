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
