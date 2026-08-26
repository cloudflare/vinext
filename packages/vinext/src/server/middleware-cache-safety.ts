import type { NextI18nConfig } from "../config/next-config.js";
import { matchPattern, matchesMiddleware } from "./middleware-matcher.js";

export type MiddlewareCacheSafetyMatcher =
  | string
  | Array<
      | {
          has?: readonly unknown[];
          locale?: false;
          missing?: readonly unknown[];
          source: string;
        }
      | string
    >;

/**
 * Whether a middleware/proxy matcher can run for a public pathname.
 *
 * This deliberately ignores `has` and `missing` predicates. A headerless
 * deploy probe cannot prove that a future cookie/header/query value will not
 * satisfy those predicates, so source/locale coverage alone makes a path
 * ineligible for whole-response CDN caching.
 */
export function middlewareMatcherCanRunForPath(
  pathname: string,
  matcher: MiddlewareCacheSafetyMatcher | undefined,
  i18n?: NextI18nConfig | null,
): boolean {
  // Next.js middleware without a matcher runs for every route.
  if (matcher === undefined) return true;

  const entries = typeof matcher === "string" ? [matcher] : matcher;
  for (const entry of entries) {
    if (typeof entry === "string") {
      if (matchesMiddleware(pathname, entry, undefined, i18n)) return true;
      continue;
    }

    if (entry.locale !== false) {
      if (matchesMiddleware(pathname, entry.source, undefined, i18n)) return true;
      continue;
    }

    // `locale: false` matches the locale-bearing pathname. Domain default
    // locales are request-host dependent, so consider every configured
    // default locale rather than certifying a path from the deploy host alone.
    const candidates = new Set([pathname]);
    if (i18n) {
      const defaultLocales = new Set([
        i18n.defaultLocale,
        ...(i18n.domains?.map((domain) => domain.defaultLocale) ?? []),
      ]);
      for (const locale of defaultLocales) {
        candidates.add(`/${locale}${pathname === "/" ? "" : pathname}`);
      }
    }
    if (Array.from(candidates).some((candidate) => matchPattern(candidate, entry.source))) {
      return true;
    }
  }

  return false;
}
