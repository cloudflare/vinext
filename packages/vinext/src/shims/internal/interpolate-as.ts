/**
 * Port of Next.js' Pages Router `interpolateAs` helper, plus the minimal
 * subset of its transitive dependencies (`getRouteRegex` + `getRouteMatcher`
 * and the parameter-pattern parsers they rely on).
 *
 * Upstream sources:
 *   - packages/next/src/shared/lib/router/utils/interpolate-as.ts
 *   - packages/next/src/shared/lib/router/utils/route-regex.ts
 *   - packages/next/src/shared/lib/router/utils/route-matcher.ts
 *   - packages/next/src/shared/lib/router/utils/get-dynamic-param.ts
 *   - packages/next/src/shared/lib/router/utils/remove-trailing-slash.ts
 *   - packages/next/src/shared/lib/escape-regexp.ts
 *
 * Used by the Pages Router shim to project a route pattern + `as` pathname +
 * query back into a fully-interpolated browser URL (the `<Link href as>`
 * masking path). Interception-route markers (`(.)`, `(..)`, `(...)`,
 * `(..)(..)`) are intentionally omitted — they only apply to App Router and
 * never appear in Pages Router patterns.
 */

import { removeTrailingSlash } from "../../utils/base-path.js";
import type { UrlQuery } from "../../utils/query.js";

/**
 * Wire-compatible alias for Node's `querystring.ParsedUrlQuery`. Inlined here
 * so this module has no dependency on the `querystring` types package.
 */
type ParsedUrlQuery = { [key: string]: string | string[] | undefined };

export type DynamicRouteHrefProjection = {
  href: string;
  params: string[];
  query: ParsedUrlQuery;
  routePathname: string;
};

export type DynamicRouteHrefResolution = {
  /** Route-pattern URL passed to the Pages Router. */
  href: string;
  /** Interpolated URL rendered in the anchor and displayed in the browser. */
  as: string;
};

function normalizeQuery(query: UrlQuery | undefined): ParsedUrlQuery {
  const normalized: ParsedUrlQuery = {};
  if (!query) return normalized;

  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    normalized[key] = Array.isArray(value) ? value.map(String) : String(value);
  }
  return normalized;
}

function parseRouteHrefQuery(
  routeHref: string,
  queryIndex: number,
  hashIndex: number,
): ParsedUrlQuery {
  const query: ParsedUrlQuery = {};
  if (queryIndex === -1 || (hashIndex !== -1 && queryIndex > hashIndex)) return query;

  const searchEnd = hashIndex === -1 ? routeHref.length : hashIndex;
  for (const [key, value] of new URLSearchParams(routeHref.slice(queryIndex + 1, searchEnd))) {
    const existing = query[key];
    if (existing === undefined) query[key] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else query[key] = [existing, value];
  }
  return query;
}

type RouteRegexGroup = {
  pos: number;
  repeat: boolean;
  optional: boolean;
};

type RouteRegex = {
  re: RegExp;
  groups: Record<string, RouteRegexGroup>;
};

// regexp is based on https://github.com/sindresorhus/escape-string-regexp
const reHasRegExp = /[|\\{}()[\]^$+*?.-]/;
const reReplaceRegExp = /[|\\{}()[\]^$+*?.-]/g;
function escapeStringRegexp(str: string): string {
  if (reHasRegExp.test(str)) {
    return str.replace(reReplaceRegExp, "\\$&");
  }
  return str;
}

/**
 * Regular expression pattern used to match route parameters.
 * Matches both single parameters and parameter groups.
 * Examples:
 *   - `[[...slug]]` matches parameter group with key 'slug', repeat: true, optional: true
 *   - `[...slug]` matches parameter group with key 'slug', repeat: true, optional: false
 *   - `[[foo]]` matches parameter with key 'foo', repeat: false, optional: true
 *   - `[bar]` matches parameter with key 'bar', repeat: false, optional: false
 */
const PARAMETER_PATTERN = /^([^[]*)\[((?:\[[^\]]*\])|[^\]]+)\](.*)$/;

/**
 * Parses a matched parameter from the PARAMETER_PATTERN regex.
 * Examples:
 *   - `[...slug]` -> `{ key: 'slug', repeat: true, optional: true }`
 *   - `...slug`   -> `{ key: 'slug', repeat: true, optional: false }`
 *   - `[foo]`     -> `{ key: 'foo',  repeat: false, optional: true }`
 *   - `bar`       -> `{ key: 'bar',  repeat: false, optional: false }`
 */
function parseMatchedParameter(param: string): {
  key: string;
  repeat: boolean;
  optional: boolean;
} {
  const optional = param.startsWith("[") && param.endsWith("]");
  if (optional) {
    param = param.slice(1, -1);
  }
  const repeat = param.startsWith("...");
  if (repeat) {
    param = param.slice(3);
  }
  return { key: param, repeat, optional };
}

function getParametrizedRoute(route: string): {
  parameterizedRoute: string;
  groups: Record<string, RouteRegexGroup>;
} {
  const groups: Record<string, RouteRegexGroup> = {};
  let groupIndex = 1;
  const segments: string[] = [];
  for (const segment of removeTrailingSlash(route).slice(1).split("/")) {
    const paramMatches = segment.match(PARAMETER_PATTERN);
    if (paramMatches && paramMatches[2]) {
      const { key, repeat, optional } = parseMatchedParameter(paramMatches[2]);
      groups[key] = { pos: groupIndex++, repeat, optional };
      const s = repeat ? (optional ? "(?:/(.+?))?" : "/(.+?)") : "/([^/]+?)";
      segments.push(s);
    } else {
      segments.push(`/${escapeStringRegexp(segment)}`);
    }
  }
  return { parameterizedRoute: segments.join(""), groups };
}

/**
 * From a normalized route this function generates a regular expression and a
 * corresponding groups object intended to be used to store matching groups
 * from the regular expression.
 */
function getRouteRegex(normalizedRoute: string): RouteRegex {
  const { parameterizedRoute, groups } = getParametrizedRoute(normalizedRoute);
  return {
    re: new RegExp(`^${parameterizedRoute}(?:/)?$`),
    groups,
  };
}

/**
 * Compile a route regex into a function that extracts decoded params from a
 * pathname. Returns `false` if the pathname does not match the route.
 *
 * The `safeRouteMatcher`/`stripParameterSeparators` wrapper that Next.js
 * applies (for adjacent-parameter normalization) is omitted — Pages Router
 * patterns never contain adjacent parameters, so the wrapper is a no-op for
 * this caller.
 */
function getRouteMatcher({ re, groups }: RouteRegex) {
  return (pathname: string): false | Record<string, string | string[]> => {
    const routeMatch = re.exec(pathname);
    if (!routeMatch) return false;

    const decode = (param: string): string => {
      try {
        return decodeURIComponent(param);
      } catch {
        // Mirrors Next.js' `DecodeError` — callers in this package don't
        // distinguish the subclass, so a plain Error suffices.
        throw new Error("failed to decode param");
      }
    };

    const params: Record<string, string | string[]> = {};
    for (const [key, group] of Object.entries(groups)) {
      const match = routeMatch[group.pos];
      if (match !== undefined) {
        if (group.repeat) {
          params[key] = match.split("/").map((entry) => decode(entry));
        } else {
          params[key] = decode(match);
        }
      }
    }
    return params;
  };
}

/**
 * Project a `(route, asPathname, query)` triple back into a fully-interpolated
 * browser URL. Used by the `<Link href as>` masking path in the Pages Router
 * shim: extract param values from the rendered `as` path when it differs from
 * the route pattern, otherwise fall back to reading them from the href query.
 *
 * Returns `{ params, result }`. `result` is the interpolated URL, or the empty
 * string when one or more required params could not be resolved. Callers warn
 * (in dev) on the empty-string case; this helper deliberately stays silent —
 * matching Next.js' behavior, where `<Link>` itself owns the dev warning.
 */
function interpolateAs(
  route: string,
  asPathname: string,
  query: ParsedUrlQuery,
): { params: string[]; result: string } {
  let interpolatedRoute = "";

  const dynamicRegex = getRouteRegex(route);
  const dynamicGroups = dynamicRegex.groups;
  const dynamicMatches =
    // Try to match the dynamic route against the asPath
    (asPathname !== route ? getRouteMatcher(dynamicRegex)(asPathname) : "") ||
    // Fall back to reading the values from the href
    // TODO: should this take priority; also need to change in the router.
    query;

  interpolatedRoute = route;
  const params = Object.keys(dynamicGroups);

  if (
    !params.every((param) => {
      let value = (dynamicMatches as Record<string, unknown>)[param] || "";
      const { repeat, optional } = dynamicGroups[param];

      // support single-level catch-all
      // TODO: more robust handling for user-error (passing `/`)
      let replaced = `[${repeat ? "..." : ""}${param}]`;
      if (optional) {
        replaced = `${!value ? "/" : ""}[${replaced}]`;
      }
      if (repeat && !Array.isArray(value)) value = [value];

      return (
        (optional || param in dynamicMatches) &&
        // Interpolate group into data URL if present
        (interpolatedRoute =
          interpolatedRoute!.replace(
            replaced,
            repeat
              ? (value as string[])
                  .map(
                    // these values should be fully encoded instead of just
                    // path delimiter escaped since they are being inserted
                    // into the URL and we expect URL encoded segments
                    // when parsing dynamic route params
                    (segment) => encodeURIComponent(segment),
                  )
                  .join("/")
              : encodeURIComponent(value as string),
          ) || "/")
      );
    })
  ) {
    interpolatedRoute = ""; // did not satisfy all requirements

    // n.b. We ignore this error because we handle warning for this case in
    // development in the `<Link>` component directly.
  }
  return {
    params,
    result: interpolatedRoute,
  };
}

/**
 * Resolve a bracket-pattern route href against its displayed href. Query
 * values can be supplied directly (object-form hrefs) or parsed from the route
 * href (string-form hrefs). A `?` after `#` is part of the fragment, not a
 * query delimiter.
 */
export function interpolateDynamicRouteHref(
  routeHref: string,
  asHref: string,
  queryInput?: UrlQuery,
): DynamicRouteHrefProjection | null {
  const hashIndex = routeHref.indexOf("#");
  const queryIndex = routeHref.indexOf("?");
  const pathEnd = [hashIndex, queryIndex]
    .filter((index) => index !== -1)
    .reduce((earliest, index) => Math.min(earliest, index), routeHref.length);
  const routePathname = routeHref.slice(0, pathEnd);
  if (!routePathname.includes("[")) return null;
  const trailing = routeHref.slice(pathEnd);
  const asPathname = asHref.split(/[?#]/, 1)[0];
  const query = queryInput
    ? normalizeQuery(queryInput)
    : parseRouteHrefQuery(routeHref, queryIndex, hashIndex);
  const { result, params } = interpolateAs(routePathname, asPathname, query);

  return {
    href: result ? `${result}${trailing}` : "",
    params,
    query,
    routePathname,
  };
}

/**
 * Resolve the two URLs that Next.js' Pages Router derives from a dynamic
 * href: the original route-pattern URL used to load the page and the
 * interpolated browser URL. Dynamic params are consumed from the latter's
 * query string while unrelated query values and the hash are retained.
 *
 * Mirrors `resolveHref(router, href, true)` from Next.js:
 * packages/next/src/client/resolve-href.ts.
 */
export function resolveDynamicRouteHref(routeHref: string): DynamicRouteHrefResolution | null {
  const projection = interpolateDynamicRouteHref(routeHref, routeHref);
  if (!projection?.href) return null;

  const hashIndex = projection.href.indexOf("#");
  const hash = hashIndex === -1 ? "" : projection.href.slice(hashIndex);
  const hrefWithoutHash = hashIndex === -1 ? projection.href : projection.href.slice(0, hashIndex);
  const queryIndex = hrefWithoutHash.indexOf("?");
  const pathname = queryIndex === -1 ? hrefWithoutHash : hrefWithoutHash.slice(0, queryIndex);
  const searchParams = new URLSearchParams(
    queryIndex === -1 ? "" : hrefWithoutHash.slice(queryIndex + 1),
  );

  for (const param of projection.params) searchParams.delete(param);

  const search = searchParams.toString();
  return {
    href: routeHref,
    as: `${pathname}${search ? `?${search}` : ""}${hash}`,
  };
}
