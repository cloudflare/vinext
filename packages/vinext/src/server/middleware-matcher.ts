import {
  checkHasConditions,
  requestContextFromRequest,
  safeRegExp,
  type RequestContext,
} from "../config/config-matchers.js";
import type { HasCondition, NextI18nConfig } from "../config/next-config.js";

export type MiddlewareMatcherObject = {
  source: string;
  locale?: false;
  has?: HasCondition[];
  missing?: HasCondition[];
};

export type MatcherConfig = string | Array<string | MiddlewareMatcherObject>;

const EMPTY_MIDDLEWARE_REQUEST_CONTEXT: RequestContext = {
  headers: new Headers(),
  cookies: {},
  query: new URLSearchParams(),
  host: "",
};

const _mwPatternCache = new Map<string, RegExp | null>();

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
    return false;
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

    if (isValidMiddlewareMatcherObject(m)) {
      if (!matchObjectMatcher(pathname, m, i18nConfig)) {
        continue;
      }

      if (!checkHasConditions(m.has, m.missing, requestContext)) {
        continue;
      }

      return true;
    }
  }

  return false;
}

function isValidMiddlewareMatcherObject(value: unknown): value is MiddlewareMatcherObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;

  if (!("source" in value) || typeof value.source !== "string") return false;

  for (const key of Object.keys(value)) {
    if (key !== "source" && key !== "locale" && key !== "has" && key !== "missing") {
      return false;
    }
  }

  if ("locale" in value && value.locale !== undefined && value.locale !== false) return false;
  if ("has" in value && value.has !== undefined && !Array.isArray(value.has)) return false;
  if ("missing" in value && value.missing !== undefined && !Array.isArray(value.missing)) {
    return false;
  }

  return true;
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

  const stripped = "/" + segments.slice(2).join("/");
  return stripped === "/" ? "/" : stripped.replace(/\/+$/, "") || "/";
}

export function matchPattern(pathname: string, pattern: string): boolean {
  let cached = _mwPatternCache.get(pattern);
  if (cached === undefined) {
    cached = compileMatcherPattern(pattern);
    _mwPatternCache.set(pattern, cached);
  }
  if (cached === null) return pathname === pattern;
  return cached.test(pathname);
}

function extractConstraint(str: string, re: RegExp): string | null {
  if (str[re.lastIndex] !== "(") return null;
  const start = re.lastIndex + 1;
  let depth = 1;
  let i = start;
  while (i < str.length && depth > 0) {
    if (str[i] === "(") depth++;
    else if (str[i] === ")") depth--;
    i++;
  }
  if (depth !== 0) return null;
  re.lastIndex = i;
  return str.slice(start, i - 1);
}

function compileMatcherPattern(pattern: string): RegExp | null {
  const hasConstraints = /:[\w-]+[*+]?\(/.test(pattern);

  if (!hasConstraints && (pattern.includes("(") || pattern.includes("\\"))) {
    return safeRegExp("^" + pattern + "$");
  }

  let regexStr = "";
  const tokenRe = /\/:([\w-]+)\*|\/:([\w-]+)\+|:([\w-]+)|[.]|[^/:.]+|./g;
  let tok: RegExpExecArray | null;
  while ((tok = tokenRe.exec(pattern)) !== null) {
    if (tok[1] !== undefined) {
      const constraint = hasConstraints ? extractConstraint(pattern, tokenRe) : null;
      regexStr += constraint !== null ? `(?:/(${constraint}))?` : "(?:/.*)?";
    } else if (tok[2] !== undefined) {
      const constraint = hasConstraints ? extractConstraint(pattern, tokenRe) : null;
      regexStr += constraint !== null ? `(?:/(${constraint}))` : "(?:/.+)";
    } else if (tok[3] !== undefined) {
      const constraint = hasConstraints ? extractConstraint(pattern, tokenRe) : null;
      const isOptional = pattern[tokenRe.lastIndex] === "?";
      if (isOptional) tokenRe.lastIndex += 1;

      const group = constraint !== null ? `(${constraint})` : "([^/]+)";

      if (isOptional && regexStr.endsWith("/")) {
        regexStr = regexStr.slice(0, -1) + `(?:/${group})?`;
      } else if (isOptional) {
        regexStr += `${group}?`;
      } else {
        regexStr += group;
      }
    } else if (tok[0] === ".") {
      regexStr += "\\.";
    } else {
      regexStr += tok[0];
    }
  }

  return safeRegExp("^" + regexStr + "$");
}
