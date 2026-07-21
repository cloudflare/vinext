import { buildRouteTrie, trieMatchRaw } from "../routing/route-trie.js";
import {
  matchRoutePattern,
  matchRoutePatternRaw,
  matchRoutePatternPrefix,
  type RoutePatternParams,
} from "../routing/route-pattern.js";
import {
  decodeMatchedParams,
  splitPathnameForRouteMatch,
  splitPathSegments,
} from "../routing/utils.js";

/**
 * Sentinel slot key used for sibling-style interception entries.
 * When a matched intercept carries this key, the render layer replaces the
 * route's main page element instead of a parallel slot.
 */
export const SIBLING_PAGE_INTERCEPT_SLOT_KEY = "__vinext_page_intercept";

type AppRscRouteParams = RoutePatternParams;

type AppRscInterceptForMatching = {
  targetPattern: string;
  /**
   * URL pattern of the *intercepting route* (the path that owns the slot,
   * with route groups and `@slot` segments stripped). Mirrors Next.js'
   * `interceptingRoute` from `extractInterceptionRouteInformation`.
   *
   * Next.js implements interception as a rewrite that fires only when the
   * `Next-URL` header matches `^<sourceMatchPattern>(?:/.*)?$`. vinext's
   * matcher enforces the same constraint at `findIntercept`: an intercept
   * whose `targetPattern` matches the request URL is only valid when the
   * provided source pathname (X-Vinext-Interception-Context / Next-URL)
   * matches this pattern, with descendants allowed.
   *
   * Optional for backwards compat: when absent or empty, the matcher falls
   * back to the legacy behavior of matching by target alone (still gated on
   * a non-null source pathname).
   *
   * @see https://github.com/vercel/next.js/blob/canary/packages/next/src/lib/generate-interception-routes-rewrites.ts
   */
  sourceMatchPattern?: string;
  sourcePageSegments?: readonly string[];
  interceptLayouts: readonly unknown[];
  interceptLayoutSegments?: readonly (readonly string[])[];
  interceptBranchSegments?: readonly string[];
  interceptLoadings?: readonly unknown[];
  interceptLoadingTreePositions?: readonly number[];
  interceptNotFoundBranchSegments?: readonly string[];
  __loadInterceptLayouts?: readonly (() => Promise<unknown>)[] | null;
  __loadInterceptLoadings?: readonly (() => Promise<unknown>)[] | null;
  page: unknown;
  __pageLoader?: (() => Promise<unknown>) | null;
  notFound?: unknown;
  __loadNotFound?: (() => Promise<unknown>) | null;
  notFoundTreePosition?: number | null;
  params: readonly string[];
};

type AppRscSlotForMatching = {
  id?: string | null;
  intercepts?: readonly AppRscInterceptForMatching[];
};

type AppRscSiblingInterceptForMatching = {
  targetPattern: string;
  sourceMatchPattern: string | null;
  sourcePageSegments?: readonly string[];
  slotId: string | null;
  interceptLayouts: readonly unknown[];
  interceptLayoutSegments?: readonly (readonly string[])[];
  interceptBranchSegments?: readonly string[];
  interceptLoadings?: readonly unknown[];
  interceptLoadingTreePositions?: readonly number[];
  interceptNotFoundBranchSegments?: readonly string[];
  __loadInterceptLayouts?: readonly (() => Promise<unknown>)[] | null;
  __loadInterceptLoadings?: readonly (() => Promise<unknown>)[] | null;
  page: unknown;
  // Sibling intercept pages are lazy-loaded (manifest emits `page: null` plus a
  // `__pageLoader`) so the intercepting page's CSS chunk stays isolated in
  // production, matching slot intercepts (see #1738). The loader is awaited on
  // demand by resolveAppPageInterceptState / probePage.
  __pageLoader?: (() => Promise<unknown>) | null;
  notFound?: unknown;
  __loadNotFound?: (() => Promise<unknown>) | null;
  notFoundTreePosition?: number | null;
  params: readonly string[];
};

type AppRscRouteForMatching = {
  __loadRouteHandler?: unknown;
  pattern: string;
  patternParts: string[];
  routeHandler?: unknown;
  slots?: Record<string, AppRscSlotForMatching>;
  siblingIntercepts?: AppRscSiblingInterceptForMatching[];
};

type AppRscInterceptMatch = AppRscInterceptLookupEntry & {
  matchedParams: AppRscRouteParams;
  sourceMatchedParams: AppRscRouteParams;
};

type AppRscInterceptLoadState = {
  page: unknown;
  pageLoading: Promise<unknown> | null;
  notFound: unknown;
  notFoundLoading: Promise<unknown> | null;
  interceptLayoutsLoading: Promise<readonly unknown[]> | null;
};

type AppRscInterceptLookupEntry = {
  sourceRouteIndex: number;
  slotKey: string;
  targetPattern: string;
  targetPatternParts: string[];
  sourceMatchPattern: string | null;
  sourceMatchPatternParts: string[] | null;
  sourcePageSegments: readonly string[] | null;
  interceptLayouts: readonly unknown[];
  interceptLayoutSegments?: readonly (readonly string[])[];
  interceptBranchSegments?: readonly string[];
  interceptLoadings?: readonly unknown[];
  interceptLoadingTreePositions?: readonly number[];
  interceptNotFoundBranchSegments?: readonly string[];
  __loadInterceptLayouts?: readonly (() => Promise<unknown>)[] | null;
  __loadInterceptLoadings?: readonly (() => Promise<unknown>)[] | null;
  page: unknown;
  __pageLoader?: (() => Promise<unknown>) | null;
  notFound: unknown;
  __loadNotFound?: (() => Promise<unknown>) | null;
  notFoundTreePosition?: number | null;
  __loadState: AppRscInterceptLoadState;
  params: readonly string[];
  slotId: string | null;
};

function createRouteParams(): AppRscRouteParams {
  return Object.create(null);
}

function appRscPathnameParts(pathname: string, isNormalized = false): string[] {
  const pathOnly = pathname.split("?")[0];
  const normalizedPathname = pathOnly === "/" ? "/" : pathOnly.replace(/\/$/, "");
  return isNormalized
    ? splitPathSegments(normalizedPathname)
    : splitPathnameForRouteMatch(normalizedPathname);
}

function appRscInterceptionSourcePathnameParts(pathname: string): string[] {
  const pathOnly = pathname.split("?")[0];
  const normalizedPathname = pathOnly === "/" ? "/" : pathOnly.replace(/\/$/, "");
  return splitPathSegments(normalizedPathname).map((segment) => {
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment;
    }
  });
}

function canonicalizeAppPageParam(value: string): string {
  try {
    return encodeURIComponent(decodeURIComponent(value));
  } catch {
    return value;
  }
}

function canonicalizeAppPageParams(params: AppRscRouteParams): void {
  for (const key of Object.keys(params)) {
    const value = params[key];
    params[key] = Array.isArray(value)
      ? value.map(canonicalizeAppPageParam)
      : canonicalizeAppPageParam(value);
  }
}

function isAppRouteHandlerRoute(route: AppRscRouteForMatching): boolean {
  // Generated manifests retain the lazy loader before the first request and
  // hydrate routeHandler afterwards. Classification must not change when that
  // module load completes.
  return route.routeHandler != null || typeof route.__loadRouteHandler === "function";
}

function normalizeMatchedParamsForRoute(result: {
  route: AppRscRouteForMatching;
  params: AppRscRouteParams;
}): void {
  if (isAppRouteHandlerRoute(result.route)) {
    decodeMatchedParams(result.params);
  } else {
    canonicalizeAppPageParams(result.params);
  }
}

function extractRawParamsForMatchedRoute(
  patternParts: readonly string[],
  pathnameParts: readonly string[],
): AppRscRouteParams {
  // Route selection uses the normalized pathname so encoded static segments
  // cannot alias filesystem routes. Param values come from the encoded URL
  // parts, matching Next.js client/route-params.ts before the route-kind-
  // specific canonicalize/decode step below.
  const params = createRouteParams();
  let pathnameIndex = 0;

  for (const part of patternParts) {
    if (!part.startsWith(":")) {
      pathnameIndex += 1;
      continue;
    }

    const isCatchAll = part.endsWith("+") || part.endsWith("*");
    const paramName = part.slice(1, isCatchAll ? -1 : undefined);
    if (isCatchAll) {
      const remaining = pathnameParts.slice(pathnameIndex);
      if (remaining.length > 0) params[paramName] = [...remaining];
      break;
    }

    const value = pathnameParts[pathnameIndex];
    if (value !== undefined) params[paramName] = value;
    pathnameIndex += 1;
  }

  return params;
}

export function createAppRscRouteMatcher<Route extends AppRscRouteForMatching>(
  routes: Route[],
): {
  matchRoute(url: string): { route: Route; params: AppRscRouteParams } | null;
  matchRequestRoute(url: string): { route: Route; params: AppRscRouteParams } | null;
  findIntercept(pathname: string, sourcePathname?: string | null): AppRscInterceptMatch | null;
} {
  const routeTrie = buildRouteTrie(routes);
  const interceptLookup = createInterceptLookup(routes);
  const routeIndexes = new Map<Route, number>(routes.map((route, index) => [route, index]));

  return {
    matchRoute(url) {
      const rawParts = appRscPathnameParts(url, true);
      const result = trieMatchRaw(routeTrie, appRscPathnameParts(url, false));
      if (!result) return null;
      result.params = extractRawParamsForMatchedRoute(result.route.patternParts, rawParts);
      normalizeMatchedParamsForRoute(result);
      return result;
    },
    matchRequestRoute(url) {
      const result = trieMatchRaw(routeTrie, appRscPathnameParts(url, true));
      if (!result) return null;
      normalizeMatchedParamsForRoute(result);
      return result;
    },
    findIntercept(pathname, sourcePathname = null) {
      // Mirror Next.js' rewrite semantics: interception only fires when the
      // Next-URL header is present AND matches the intercepting route's regex
      // (with descendants allowed). Without a source pathname there is no
      // header for the rewrite to gate on, so we render the direct route.
      // https://github.com/vercel/next.js/blob/canary/packages/next/src/lib/generate-interception-routes-rewrites.ts
      if (sourcePathname === null) return null;

      const urlParts = appRscPathnameParts(pathname, true);
      const sourceParts = appRscInterceptionSourcePathnameParts(sourcePathname);
      const matchedSourceRoute = trieMatchRaw(routeTrie, sourceParts);

      for (const entry of interceptLookup) {
        // Primary gate: when the intercept declares a `sourceMatchPattern`
        // (the intercepting route's path, descendants allowed), require the
        // request's source pathname to satisfy it. This mirrors Next.js'
        // `^<interceptingRoute>(?:/.*)?$` header regex precisely and is the
        // authoritative gate when the manifest carries the pattern.
        if (!matchInterceptSource(sourceParts, entry)) continue;

        const params = matchRoutePatternRaw(urlParts, entry.targetPatternParts);
        if (params === null) continue;
        canonicalizeAppPageParams(params);

        const concreteSourceRouteIndex =
          matchedSourceRoute && entry.sourceMatchPatternParts !== null
            ? (routeIndexes.get(matchedSourceRoute.route) ?? entry.sourceRouteIndex)
            : entry.sourceRouteIndex;
        const sourceRoute = routes[concreteSourceRouteIndex];
        const matchedSourceParams =
          matchedSourceRoute && entry.sourceMatchPatternParts !== null
            ? matchedSourceRoute.params
            : sourceRoute
              ? matchRoutePatternRaw(sourceParts, sourceRoute.patternParts)
              : null;

        // Secondary gate (from #1249): when the entry has no
        // `sourceMatchPatternParts` declared (older manifest shapes), reject
        // sources that don't match the slot owner's route pattern exactly.
        // This is the safety net that keeps unrelated sources from pulling
        // in a modal they have no slot for. When `sourceMatchPatternParts`
        // *is* declared, `matchInterceptSource` above has already approved
        // the source (including descendants), so a stricter exact-match
        // check on the slot-owner route here would defeat the descendant
        // semantics — fall back to empty params instead.
        if (matchedSourceParams === null && entry.sourceMatchPatternParts === null) {
          continue;
        }
        const sourceParams =
          matchedSourceParams && entry.sourceMatchPatternParts !== null
            ? pickPatternParams(matchedSourceParams, entry.sourceMatchPatternParts)
            : (matchedSourceParams ?? createRouteParams());
        return {
          ...entry,
          page: entry.__loadState.page,
          sourceRouteIndex: concreteSourceRouteIndex,
          matchedParams: mergeMatchedParams(sourceParams, params),
          sourceMatchedParams: matchedSourceParams ?? createRouteParams(),
        };
      }
      return null;
    },
  };
}

/**
 * Check whether the request's source pathname (Next-URL / interception
 * context) satisfies the intercept entry's intercepting-route pattern, with
 * descendants allowed. Mirrors the header regex shape Next.js emits for the
 * generated interception rewrite: `^<pattern>(?:/.*)?$`.
 *
 * When the entry has no declared `sourceMatchPatternParts`, fall back to the
 * legacy behavior of accepting any source (we still require the source to be
 * non-null at the caller — see `findIntercept`).
 */
function matchInterceptSource(sourceParts: string[], entry: AppRscInterceptLookupEntry): boolean {
  const patternParts = entry.sourceMatchPatternParts;
  if (!patternParts) return true;
  // Root pattern (`/`) matches any source.
  if (patternParts.length === 0) return true;
  return matchRoutePatternPrefix(sourceParts, patternParts);
}

function interceptSegmentPrecedence(segment: string): number {
  if (!segment.startsWith(":")) return 0;
  if (segment.endsWith("*")) return 3;
  if (segment.endsWith("+")) return 2;
  return 1;
}

function compareInterceptTargetPatterns(
  a: AppRscInterceptLookupEntry,
  b: AppRscInterceptLookupEntry,
): number {
  const sharedLength = Math.min(a.targetPatternParts.length, b.targetPatternParts.length);
  for (let index = 0; index < sharedLength; index++) {
    const aSegment = a.targetPatternParts[index];
    const bSegment = b.targetPatternParts[index];
    const precedence = interceptSegmentPrecedence(aSegment) - interceptSegmentPrecedence(bSegment);
    if (precedence !== 0) return precedence;

    if (aSegment !== bSegment) {
      return aSegment.localeCompare(bSegment);
    }
  }

  const lengthDifference = a.targetPatternParts.length - b.targetPatternParts.length;
  return lengthDifference !== 0 ? lengthDifference : a.targetPattern.localeCompare(b.targetPattern);
}

function createInterceptLookup<Route extends AppRscRouteForMatching>(
  routes: Route[],
): AppRscInterceptLookupEntry[] {
  // Build a pattern→index map so slot intercepts resolve to the actual owner
  // route rather than the inheriting descendant that carries the slot copy.
  // When a route inherits a @slot from an ancestor (e.g. /groups/:id/new
  // inheriting @modal from /interception-dyn-single), the inherited slot's
  // interceptingRoutes include a sourceMatchPattern that names the real owner
  // ("/interception-dyn-single"). Using that pattern's index as sourceRouteIndex
  // ensures resolveAppPageInterceptState produces kind="source-route" (owner ≠
  // current) rather than kind="current-route" (owner === current), which would
  // render the descendant page instead of the owner's layout+page tree.
  const patternToIndex = new Map<string, number>(routes.map((r, i) => [r.pattern, i]));

  const interceptLookup: AppRscInterceptLookupEntry[] = [];
  for (let routeIndex = 0; routeIndex < routes.length; routeIndex++) {
    const route = routes[routeIndex];
    if (route.slots) {
      for (const [slotKey, slotModule] of Object.entries(route.slots)) {
        if (!slotModule.intercepts) continue;
        for (const intercept of slotModule.intercepts) {
          const sourceMatchPattern = intercept.sourceMatchPattern ?? null;
          const sourceMatchPatternParts = sourceMatchPattern
            ? sourceMatchPattern.split("/").filter(Boolean)
            : null;
          // Prefer the route whose pattern matches sourceMatchPattern (the actual
          // slot-owner route). Fall back to routeIndex when no match is found.
          const ownerRouteIndex =
            sourceMatchPattern !== null
              ? (patternToIndex.get(sourceMatchPattern) ?? routeIndex)
              : routeIndex;
          interceptLookup.push({
            sourceRouteIndex: ownerRouteIndex,
            slotKey,
            slotId: typeof slotModule.id === "string" ? slotModule.id : null,
            targetPattern: intercept.targetPattern,
            targetPatternParts: intercept.targetPattern.split("/").filter(Boolean),
            sourceMatchPattern,
            sourceMatchPatternParts,
            sourcePageSegments: intercept.sourcePageSegments ?? null,
            interceptLayouts: intercept.interceptLayouts,
            interceptLayoutSegments: intercept.interceptLayoutSegments,
            interceptBranchSegments: intercept.interceptBranchSegments,
            interceptLoadings: intercept.interceptLoadings,
            interceptLoadingTreePositions: intercept.interceptLoadingTreePositions,
            interceptNotFoundBranchSegments: intercept.interceptNotFoundBranchSegments,
            __loadInterceptLayouts: intercept.__loadInterceptLayouts,
            __loadInterceptLoadings: intercept.__loadInterceptLoadings,
            page: intercept.page,
            __pageLoader: intercept.__pageLoader,
            notFound: intercept.notFound,
            __loadNotFound: intercept.__loadNotFound,
            notFoundTreePosition: intercept.notFoundTreePosition,
            __loadState: {
              page: intercept.page,
              pageLoading: null,
              notFound: intercept.notFound,
              notFoundLoading: null,
              interceptLayoutsLoading: null,
            },
            params: intercept.params,
          });
        }
      }
    }
    if (route.siblingIntercepts) {
      for (const intercept of route.siblingIntercepts) {
        const sourceMatchPattern = intercept.sourceMatchPattern ?? null;
        const sourceMatchPatternParts = sourceMatchPattern
          ? sourceMatchPattern.split("/").filter(Boolean)
          : null;
        interceptLookup.push({
          sourceRouteIndex: routeIndex,
          slotKey: SIBLING_PAGE_INTERCEPT_SLOT_KEY,
          slotId: typeof intercept.slotId === "string" ? intercept.slotId : null,
          targetPattern: intercept.targetPattern,
          targetPatternParts: intercept.targetPattern.split("/").filter(Boolean),
          sourceMatchPattern,
          sourceMatchPatternParts,
          sourcePageSegments: intercept.sourcePageSegments ?? null,
          interceptLayouts: intercept.interceptLayouts,
          interceptLayoutSegments: intercept.interceptLayoutSegments,
          interceptBranchSegments: intercept.interceptBranchSegments,
          interceptLoadings: intercept.interceptLoadings,
          interceptLoadingTreePositions: intercept.interceptLoadingTreePositions,
          interceptNotFoundBranchSegments: intercept.interceptNotFoundBranchSegments,
          __loadInterceptLayouts: intercept.__loadInterceptLayouts,
          __loadInterceptLoadings: intercept.__loadInterceptLoadings,
          page: intercept.page,
          __pageLoader: intercept.__pageLoader,
          notFound: intercept.notFound,
          __loadNotFound: intercept.__loadNotFound,
          notFoundTreePosition: intercept.notFoundTreePosition,
          __loadState: {
            page: intercept.page,
            pageLoading: null,
            notFound: intercept.notFound,
            notFoundLoading: null,
            interceptLayoutsLoading: null,
          },
          params: intercept.params,
        });
      }
    }
  }
  // Array.prototype.sort is stable, so entries with identical target patterns
  // retain declaration order across slots and sources.
  return interceptLookup.sort(compareInterceptTargetPatterns);
}

export function matchAppRscRoutePattern(
  urlParts: string[],
  patternParts: string[],
): AppRscRouteParams | null {
  return matchRoutePattern(urlParts, patternParts);
}

function mergeMatchedParams(
  sourceParams: AppRscRouteParams,
  targetParams: AppRscRouteParams,
): AppRscRouteParams {
  return Object.assign(createRouteParams(), sourceParams, targetParams);
}

function pickPatternParams(
  params: AppRscRouteParams,
  patternParts: readonly string[],
): AppRscRouteParams {
  const picked = createRouteParams();
  for (const patternPart of patternParts) {
    if (!patternPart.startsWith(":")) continue;
    const paramName =
      patternPart.endsWith("+") || patternPart.endsWith("*")
        ? patternPart.slice(1, -1)
        : patternPart.slice(1);
    const value = params[paramName];
    if (value !== undefined) picked[paramName] = value;
  }
  return picked;
}
