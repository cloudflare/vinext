import type { NextI18nConfig } from "../config/next-config.js";

export type DomainLocale = NonNullable<NextI18nConfig["domains"]>[number];

export function normalizeDomainHostname(hostname: string | null | undefined): string | undefined {
  if (!hostname) return undefined;
  return hostname.split(",", 1)[0]?.trim().split(":", 1)[0]?.toLowerCase() || undefined;
}

/**
 * Match a configured domain either by hostname or locale.
 * When both are provided, the checks intentionally use OR semantics so the
 * same helper can cover Next.js's hostname lookup and preferred-locale lookup.
 * If both are passed, the first domain matching either input wins, so callers
 * should pass hostname or detectedLocale, not both.
 */
export function detectDomainLocale(
  domainItems?: readonly DomainLocale[],
  hostname?: string,
  detectedLocale?: string,
): DomainLocale | undefined {
  if (!domainItems?.length) return undefined;

  const normalizedHostname = normalizeDomainHostname(hostname);
  const normalizedLocale = detectedLocale?.toLowerCase();

  for (const item of domainItems) {
    const domainHostname = normalizeDomainHostname(item.domain);
    if (
      normalizedHostname === domainHostname ||
      normalizedLocale === item.defaultLocale.toLowerCase() ||
      item.locales?.some((locale) => locale.toLowerCase() === normalizedLocale)
    ) {
      return item;
    }
  }

  return undefined;
}

export function addLocalePrefix(path: string, locale: string, localeDefault: string): string {
  const normalizedLocale = locale.toLowerCase();
  if (normalizedLocale === localeDefault.toLowerCase()) return path;

  const pathWithLeadingSlash = path.startsWith("/") ? path : `/${path}`;
  const pathname = pathWithLeadingSlash.split(/[?#]/, 1)[0] ?? pathWithLeadingSlash;
  const normalizedPathname = pathname.toLowerCase();
  const localePrefix = `/${normalizedLocale}`;

  if (normalizedPathname === localePrefix || normalizedPathname.startsWith(`${localePrefix}/`)) {
    return path.startsWith("/") ? path : pathWithLeadingSlash;
  }

  return `/${locale}${pathWithLeadingSlash}`;
}

function withBasePath(path: string, basePath = ""): string {
  if (!basePath) return path;
  return basePath + path;
}

export function getDomainLocaleUrl(
  url: string,
  locale: string,
  {
    basePath,
    currentHostname,
    domainItems,
  }: {
    basePath?: string;
    currentHostname?: string | null;
    domainItems?: readonly DomainLocale[];
  },
): string | undefined {
  if (!domainItems?.length) return undefined;

  const targetDomain = detectDomainLocale(domainItems, undefined, locale);
  if (!targetDomain) return undefined;

  const currentDomain = detectDomainLocale(domainItems, currentHostname ?? undefined);
  const localizedPath = addLocalePrefix(url, locale, targetDomain.defaultLocale);

  if (
    currentDomain &&
    normalizeDomainHostname(currentDomain.domain) === normalizeDomainHostname(targetDomain.domain)
  ) {
    // Same-domain switches fall back to the caller's standard locale-prefix
    // logic. This relies on __VINEXT_DEFAULT_LOCALE__ matching the current
    // domain's defaultLocale, which the server entry keeps in sync.
    return undefined;
  }

  const scheme = `http${targetDomain.http ? "" : "s"}://`;
  return `${scheme}${targetDomain.domain}${withBasePath(localizedPath, basePath)}`;
}
