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

  return (
    detectDomainLocale(domainLocales, hostname ?? undefined)?.defaultLocale ??
    window.__VINEXT_DEFAULT_LOCALE__ ??
    window.__VINEXT_LOCALE__
  );
}
