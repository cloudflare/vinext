import {
  checkHasConditions,
  requestContextFromRequest,
  type RequestContext,
} from "../config/config-matchers.js";
import type { NextI18nConfig } from "../config/next-config.js";
import {
  compileMiddlewareMatcherPattern,
  isValidMiddlewareMatcherObjectConfig,
  type MiddlewareMatcherObject,
} from "./middleware-matcher-pattern.js";

export type MatcherConfig = string | Array<string | MiddlewareMatcherObject>;

export type MiddlewareLocaleMatchContext =
  | { kind: "defaulted"; defaultLocale: string }
  | { kind: "internal" | "literal" };

const EMPTY_MIDDLEWARE_REQUEST_CONTEXT: RequestContext = {
  headers: new Headers(),
  cookies: {},
  query: new URLSearchParams(),
  host: "",
};

const UNSAFE_MATCHER_PATTERN = Symbol("unsafe matcher pattern");
type CompiledMatcherPattern = RegExp | typeof UNSAFE_MATCHER_PATTERN;

const _mwPatternCache = new Map<string, CompiledMatcherPattern>();

export function matchesMiddleware(
  pathname: string,
  matcher: MatcherConfig | undefined,
  request?: Request,
  i18nConfig?: NextI18nConfig | null,
  localeContext?: MiddlewareLocaleMatchContext,
): boolean {
  if (!matcher) {
    return true;
  }

  if (typeof matcher === "string") {
    return matchMatcherPattern(pathname, matcher, i18nConfig, localeContext);
  }
  if (!Array.isArray(matcher)) {
    return true;
  }

  const requestContext = request
    ? requestContextFromRequest(request)
    : EMPTY_MIDDLEWARE_REQUEST_CONTEXT;

  for (const m of matcher) {
    if (typeof m === "string") {
      if (matchMatcherPattern(pathname, m, i18nConfig, localeContext)) {
        return true;
      }
      continue;
    }

    if (!isValidMiddlewareMatcherObjectConfig(m)) {
      return true;
    }
    if (!matchObjectMatcher(pathname, m, i18nConfig, localeContext)) {
      continue;
    }

    if (!checkHasConditions(m.has, m.missing, requestContext)) {
      continue;
    }

    return true;
  }

  return false;
}

function matchMatcherPattern(
  pathname: string,
  pattern: string,
  i18nConfig?: NextI18nConfig | null,
  localeContext?: MiddlewareLocaleMatchContext,
): boolean {
  if (!i18nConfig) return matchPattern(pathname, pattern);

  if (localeContext) {
    if (localeContext.kind === "internal") return false;
    return matchPattern(
      localeContext.kind === "literal" ? stripFirstPathSegment(pathname) : pathname,
      pattern,
    );
  }

  const localeStrippedPathname = stripLocalePrefix(pathname, i18nConfig);
  return matchPattern(localeStrippedPathname ?? pathname, pattern);
}

function matchObjectMatcher(
  pathname: string,
  matcher: MiddlewareMatcherObject,
  i18nConfig?: NextI18nConfig | null,
  localeContext?: MiddlewareLocaleMatchContext,
): boolean {
  if (matcher.locale !== false) {
    return matchMatcherPattern(pathname, matcher.source, i18nConfig, localeContext);
  }

  const matchPathname =
    localeContext?.kind === "defaulted"
      ? `/${localeContext.defaultLocale}${pathname === "/" ? "" : pathname}`
      : pathname;
  return matchPattern(matchPathname, matcher.source);
}

function stripLocalePrefix(pathname: string, i18nConfig: NextI18nConfig): string | null {
  if (pathname === "/") return null;

  const segments = pathname.split("/");
  const firstSegment = segments[1];
  const lowerFirstSegment = firstSegment?.toLowerCase();
  if (
    !lowerFirstSegment ||
    !i18nConfig.locales.some((locale) => locale.toLowerCase() === lowerFirstSegment)
  ) {
    return null;
  }

  return stripFirstPathSegment(pathname);
}

function stripFirstPathSegment(pathname: string): string {
  return "/" + pathname.split("/").slice(2).join("/");
}

export function matchPattern(pathname: string, pattern: string): boolean {
  if (pattern === "/" && (pathname === "//" || pathname === "/?" || pathname === "/#")) {
    return false;
  }
  let cached = _mwPatternCache.get(pattern);
  if (cached === undefined) {
    cached = compileMatcherPattern(pattern);
    _mwPatternCache.set(pattern, cached);
  }
  if (cached === UNSAFE_MATCHER_PATTERN) return true;
  return cached.test(pathname);
}

function compileMatcherPattern(pattern: string): CompiledMatcherPattern {
  const result = compileMiddlewareMatcherPattern(pattern);
  if (result.regexp) return result.regexp;

  const problem = result.kind === "unsafe" ? "potentially unsafe" : "invalid";
  console.warn(
    `[vinext] Rejecting ${problem} middleware matcher: ${pattern}\n` +
      `  ${result.error}.\n` +
      `  Middleware will run for all paths to avoid bypassing request guards.`,
  );
  return UNSAFE_MATCHER_PATTERN;
}
