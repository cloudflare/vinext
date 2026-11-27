import { decodeMatchedParams } from "./utils";

export type RoutePatternParams = Record<string, string | string[]>;

// Longest first, so `(..)(..)[id]` isn't read as `(..)` before `(..)[id]`.
const INTERCEPTION_MARKERS = ["(..)(..)", "(...)", "(..)", "(.)"] as const;

type InterceptionMarkerParam = { marker: string; name: string };

/**
 * The interception marker and param of a dynamic segment the marker prefixes,
 * `(.)[id]`. Next.js keeps the marker in the URL of a metadata file below one:
 * `@modal/(.)[id]/opengraph-image.tsx` is served at
 * `/(.)1/opengraph-image-<hash>`, its param the rest of the URL segment.
 */
function interceptionMarkerSegmentParam(segment: string): InterceptionMarkerParam | null {
  const marker = INTERCEPTION_MARKERS.find((prefix) => segment.startsWith(prefix));
  const name = marker && segment.slice(marker.length).match(/^\[(?!\[|\.\.\.)([^\]]+)\]$/)?.[1];
  return marker && name ? { marker, name } : null;
}

/** The marker and param of a pattern part such a segment normalizes to, `(.):id`. */
export function interceptionMarkerPatternParam(
  patternPart: string,
): InterceptionMarkerParam | null {
  const marker = INTERCEPTION_MARKERS.find((prefix) => patternPart.startsWith(prefix));
  const name = marker && patternPart.slice(marker.length).match(/^:(.*[^+*])$/)?.[1];
  return marker && name ? { marker, name } : null;
}

/**
 * The dynamic segment an interception marker prefixes, `[id]` for `(.)[id]`,
 * which Next.js reads as that segment; any other segment as it is.
 */
export function withoutInterceptionMarker(segment: string): string {
  const marker = INTERCEPTION_MARKERS.find((prefix) => segment.startsWith(prefix));
  const rest = marker ? segment.slice(marker.length) : segment;
  return rest.startsWith("[") && rest.endsWith("]") ? rest : segment;
}

function routePatternPart(segment: string): string {
  const markerParam = interceptionMarkerSegmentParam(segment);
  if (markerParam) {
    return `${markerParam.marker}:${markerParam.name}`;
  }
  if (segment.startsWith("[[...") && segment.endsWith("]]")) {
    return `:${segment.slice(5, -2)}*`;
  }
  if (segment.startsWith("[...") && segment.endsWith("]")) {
    return `:${segment.slice(4, -1)}+`;
  }
  if (segment.startsWith("[") && segment.endsWith("]")) {
    return `:${segment.slice(1, -1)}`;
  }
  return segment;
}

export function routePatternParts(pathname: string): string[] {
  return pathname.split("/").filter(Boolean).map(routePatternPart);
}

export function routePattern(pathname: string): string {
  const parts = routePatternParts(pathname);
  return parts.length > 0 ? `/${parts.join("/")}` : "";
}

function appendParamValue(target: string[], value: string | string[]): void {
  if (Array.isArray(value)) {
    for (const entry of value) {
      target.push(entry);
    }
    return;
  }

  target.push(value);
}

export function fillRoutePatternSegments(
  pathname: string,
  params: RoutePatternParams,
): string | null {
  const segments = pathname.split("/").filter(Boolean);
  const resolvedSegments: string[] = [];

  for (const segment of segments) {
    if (segment.startsWith("[[...") && segment.endsWith("]]")) {
      const paramName = segment.slice(5, -2);
      const value = params[paramName];
      if (value !== undefined && value !== "") {
        if (Array.isArray(value) && value.length === 0) {
          continue;
        }
        appendParamValue(resolvedSegments, value);
      }
      continue;
    }

    if (segment.startsWith("[...") && segment.endsWith("]")) {
      const paramName = segment.slice(4, -1);
      const value = params[paramName];
      if (value === undefined || (Array.isArray(value) ? value.length === 0 : value === "")) {
        return null;
      }
      appendParamValue(resolvedSegments, value);
      continue;
    }

    const markerParam = interceptionMarkerSegmentParam(segment);
    if (markerParam || (segment.startsWith("[") && segment.endsWith("]"))) {
      const paramName = markerParam ? markerParam.name : segment.slice(1, -1);
      const value = params[paramName];
      const resolved =
        typeof value === "string"
          ? value
          : Array.isArray(value) && value.length === 1
            ? value[0]
            : undefined;
      if (resolved === undefined) {
        return null;
      }
      resolvedSegments.push(markerParam ? `${markerParam.marker}${resolved}` : resolved);
      continue;
    }

    // A catch-all behind a marker, `(...)[...slug]`, has no URL that serves
    // it (Next.js fails the build on a metadata file below one).
    if (
      segment.includes("[") &&
      INTERCEPTION_MARKERS.some((marker) => segment.startsWith(marker))
    ) {
      return null;
    }

    resolvedSegments.push(segment);
  }

  return resolvedSegments.length > 0 ? `/${resolvedSegments.join("/")}` : "/";
}

export function matchRoutePattern(
  urlParts: readonly string[],
  patternParts: readonly string[],
): RoutePatternParams | null {
  const params = matchRoutePatternRaw(urlParts, patternParts);
  if (params) decodeMatchedParams(params);
  return params;
}

export function matchRoutePatternRaw(
  urlParts: readonly string[],
  patternParts: readonly string[],
): RoutePatternParams | null {
  const params: RoutePatternParams = Object.create(null);

  function matchFrom(urlIndex: number, patternIndex: number): boolean {
    if (patternIndex === patternParts.length) {
      return urlIndex === urlParts.length;
    }

    const patternPart = patternParts[patternIndex];
    if (patternPart.startsWith(":") && (patternPart.endsWith("+") || patternPart.endsWith("*"))) {
      const paramName = patternPart.slice(1, -1);
      const minLength = patternPart.endsWith("+") ? 1 : 0;
      for (let endIndex = urlIndex + minLength; endIndex <= urlParts.length; endIndex++) {
        const value = urlParts.slice(urlIndex, endIndex);
        if (value.length > 0) {
          params[paramName] = value;
        } else {
          delete params[paramName];
        }
        if (matchFrom(endIndex, patternIndex + 1)) {
          return true;
        }
      }
      delete params[paramName];
      return false;
    }

    if (patternPart.startsWith(":")) {
      if (urlIndex >= urlParts.length) {
        return false;
      }
      const paramName = patternPart.slice(1);
      params[paramName] = urlParts[urlIndex];
      if (matchFrom(urlIndex + 1, patternIndex + 1)) {
        return true;
      }
      delete params[paramName];
      return false;
    }

    const markerParam = interceptionMarkerPatternParam(patternPart);
    if (markerParam) {
      const urlPart = urlParts[urlIndex];
      if (
        urlPart === undefined ||
        urlPart.length <= markerParam.marker.length ||
        !urlPart.startsWith(markerParam.marker)
      ) {
        return false;
      }
      params[markerParam.name] = urlPart.slice(markerParam.marker.length);
      if (matchFrom(urlIndex + 1, patternIndex + 1)) {
        return true;
      }
      delete params[markerParam.name];
      return false;
    }

    if (urlIndex >= urlParts.length || urlParts[urlIndex] !== patternPart) {
      return false;
    }
    return matchFrom(urlIndex + 1, patternIndex + 1);
  }

  return matchFrom(0, 0) ? params : null;
}

/**
 * Extract params from the original encoded URL parts after route selection has
 * already succeeded against normalized parts. Static parts are positional and
 * intentionally not compared because their raw encoding can differ from the
 * normalized route spelling (for example `%5Fsites` versus `_sites`).
 */
export function extractRawRoutePatternParams(
  patternParts: readonly string[],
  urlParts: readonly string[],
): RoutePatternParams {
  const params: RoutePatternParams = Object.create(null);
  let urlIndex = 0;

  for (const patternPart of patternParts) {
    if (!patternPart.startsWith(":")) {
      urlIndex += 1;
      continue;
    }

    const isCatchAll = patternPart.endsWith("+") || patternPart.endsWith("*");
    const paramName = patternPart.slice(1, isCatchAll ? -1 : undefined);
    if (isCatchAll) {
      const remaining = urlParts.slice(urlIndex);
      if (remaining.length > 0) params[paramName] = [...remaining];
      break;
    }

    const value = urlParts[urlIndex];
    if (value !== undefined) params[paramName] = value;
    urlIndex += 1;
  }

  return params;
}

export function matchRoutePatternPrefix(
  pathParts: readonly string[],
  patternParts: readonly string[],
): boolean {
  let pathIndex = 0;
  for (let patternIndex = 0; patternIndex < patternParts.length; patternIndex++) {
    const patternPart = patternParts[patternIndex];
    const isTerminal = patternIndex === patternParts.length - 1;

    if (patternPart.startsWith(":") && patternPart.endsWith("+")) {
      return isTerminal && pathParts.length - pathIndex >= 1;
    }
    if (patternPart.startsWith(":") && patternPart.endsWith("*")) {
      return isTerminal;
    }
    if (pathIndex >= pathParts.length) return false;
    if (patternPart.startsWith(":")) {
      pathIndex++;
      continue;
    }
    const markerParam = interceptionMarkerPatternParam(patternPart);
    if (markerParam) {
      const pathPart = pathParts[pathIndex];
      if (
        pathPart.length <= markerParam.marker.length ||
        !pathPart.startsWith(markerParam.marker)
      ) {
        return false;
      }
      pathIndex++;
      continue;
    }
    if (pathParts[pathIndex] !== patternPart) return false;
    pathIndex++;
  }

  return true;
}

export function matchRoutePatternWithOptionalDynamicSegments(
  pathParts: readonly string[],
  patternParts: readonly string[],
): boolean {
  function matchFrom(pathIndex: number, patternIndex: number): boolean {
    if (patternIndex === patternParts.length) {
      return pathIndex === pathParts.length;
    }

    const patternPart = patternParts[patternIndex];
    const isCatchAll =
      patternPart.startsWith(":") && (patternPart.endsWith("+") || patternPart.endsWith("*"));

    if (isCatchAll) {
      const minLength = patternPart.endsWith("+") ? 1 : 0;
      for (let endIndex = pathIndex + minLength; endIndex <= pathParts.length; endIndex++) {
        if (matchFrom(endIndex, patternIndex + 1)) return true;
      }
      return false;
    }

    if (patternPart.startsWith(":")) {
      return (
        matchFrom(pathIndex, patternIndex + 1) ||
        (pathIndex < pathParts.length && matchFrom(pathIndex + 1, patternIndex + 1))
      );
    }

    if (pathIndex >= pathParts.length || pathParts[pathIndex] !== patternPart) return false;
    return matchFrom(pathIndex + 1, patternIndex + 1);
  }

  return matchFrom(0, 0);
}

/**
 * A single entry from `getStaticPaths().paths`.
 *
 * Next.js allows both shapes:
 *   - a raw string path, e.g. `"/blog/hello"`
 *   - an object `{ params, locale? }`
 *
 * See:
 *   https://nextjs.org/docs/pages/api-reference/functions/get-static-paths
 *   .nextjs-ref/packages/next/src/build/static-paths/pages.ts (the
 *     `typeof entry === 'string'` branch around line 89, and the object
 *     branch around line 132)
 */
export type StaticPathsEntry =
  | string
  | { params?: RoutePatternParams; locale?: string }
  | null
  | undefined;

/**
 * Result of {@link normalizeStaticPathsEntry}: either a params object, or a
 * descriptive error string the caller can surface as a per-route error result.
 */
type NormalizedStaticPathsEntry = { params: RoutePatternParams } | { error: string };

/**
 * Strip query string and a single trailing slash from a pathname.
 *
 * Mirrors the Next.js `removeTrailingSlash` helper used in
 * `.nextjs-ref/packages/next/src/build/static-paths/pages.ts`. Kept here so
 * both the build-time prerender and the request-time matchers normalize the
 * same way.
 */
export function normalizeStaticPathname(pathname: string): string {
  const noQuery = pathname.split("?")[0];
  return noQuery === "/" ? "/" : noQuery.replace(/\/$/, "");
}

/**
 * Normalize a single `getStaticPaths` entry into a `{ params }` object.
 *
 * Handles both Next.js-supported shapes:
 *   - For a string entry, match it against `routePattern` to extract params,
 *     mirroring `_routeMatcher(cleanedEntry)` in
 *     `.nextjs-ref/packages/next/src/build/static-paths/pages.ts`. If the
 *     string does not match the pattern, Next.js throws; we return an
 *     `{ error }` result so the caller can record a per-route error instead
 *     of crashing the build.
 *   - For an object entry, require a `params` key (Next.js raises
 *     "A required parameter (X) was not provided..." otherwise).
 *
 * Note: this intentionally does NOT strip a locale prefix. The build pipeline
 * currently passes empty `locales` to `getStaticPaths`, so locale-prefixed
 * string entries are not produced. If/when i18n is wired through prerender,
 * locale handling should be added here, not duplicated at call sites.
 */
export function normalizeStaticPathsEntry(
  entry: StaticPathsEntry,
  routePattern: string,
): NormalizedStaticPathsEntry {
  if (entry === null || entry === undefined) {
    return {
      error: `getStaticPaths returned a ${entry === null ? "null" : "undefined"} entry`,
    };
  }

  if (typeof entry === "string") {
    const trimmed = normalizeStaticPathname(entry);
    const urlParts = trimmed.split("/").filter(Boolean);
    const patternParts = routePattern.split("/").filter(Boolean);
    const matched = matchRoutePattern(urlParts, patternParts);
    if (!matched) {
      return {
        error: `The provided path \`${entry}\` from getStaticPaths does not match the route pattern \`${routePattern}\`.`,
      };
    }
    return { params: matched };
  }

  if (typeof entry !== "object") {
    return {
      error: `getStaticPaths entry must be a string or an object, got ${typeof entry}`,
    };
  }

  const { params } = entry;
  if (params === undefined || params === null) {
    return {
      error:
        `getStaticPaths entry is missing the \`params\` key for pattern \`${routePattern}\`. ` +
        `Return either a string path or { params: { ... } }.`,
    };
  }

  return { params };
}
