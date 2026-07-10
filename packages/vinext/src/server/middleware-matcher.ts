import {
  checkHasConditions,
  requestContextFromRequest,
  type RequestContext,
} from "../config/config-matchers.js";
import type { NextI18nConfig } from "../config/next-config.js";
import { removeTrailingSlash } from "../utils/base-path.js";
import {
  compileMiddlewareMatcherPattern,
  isValidMiddlewareMatcherObjectConfig,
  type MiddlewareMatcherObject,
} from "./middleware-matcher-pattern.js";

export type MatcherConfig = string | Array<string | MiddlewareMatcherObject>;

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
): boolean {
  if (!matcher) {
    return true;
  }

  if (typeof matcher === "string") {
    return matchMatcherPattern(pathname, matcher, i18nConfig);
  }
  if (!Array.isArray(matcher)) {
    return true;
  }

  const requestContext = request
    ? requestContextFromRequest(request)
    : EMPTY_MIDDLEWARE_REQUEST_CONTEXT;

  for (const m of matcher) {
    if (typeof m === "string") {
      if (matchMatcherPattern(pathname, m, i18nConfig)) {
        return true;
      }
      continue;
    }

    if (!isValidMiddlewareMatcherObjectConfig(m)) {
      return true;
    }
    if (!matchObjectMatcher(pathname, m, i18nConfig)) {
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
): boolean {
  if (!i18nConfig) return matchPattern(pathname, pattern);

  const localeStrippedPathname = stripLocalePrefix(pathname, i18nConfig);
  return matchPattern(localeStrippedPathname ?? pathname, pattern);
}

function matchObjectMatcher(
  pathname: string,
  matcher: MiddlewareMatcherObject,
  i18nConfig?: NextI18nConfig | null,
): boolean {
  return matcher.locale === false
    ? matchPattern(pathname, matcher.source)
    : matchMatcherPattern(pathname, matcher.source, i18nConfig);
}

function stripLocalePrefix(pathname: string, i18nConfig: NextI18nConfig): string | null {
  if (pathname === "/") return null;

  const segments = pathname.split("/");
  const firstSegment = segments[1];
  if (!firstSegment || !i18nConfig.locales.includes(firstSegment)) {
    return null;
  }

  return "/" + segments.slice(2).join("/");
}

export function matchPattern(pathname: string, pattern: string): boolean {
  const hasPatternSyntax = /[\\():*+?]/.test(pattern);
  const normalizedPattern = hasPatternSyntax ? pattern : removeTrailingSlash(pattern);
  let cached = _mwPatternCache.get(normalizedPattern);
  if (cached === undefined) {
    cached = compileMatcherPattern(normalizedPattern);
    _mwPatternCache.set(normalizedPattern, cached);
  }
  if (cached === UNSAFE_MATCHER_PATTERN) return true;
  if (cached.test(pathname)) return true;
  return pathname.endsWith("/") && cached.test(removeTrailingSlash(pathname));
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
