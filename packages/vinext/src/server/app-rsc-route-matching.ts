import { buildRouteTrie, trieMatchRaw } from "../routing/route-trie.js";
import {
  extractRawRoutePatternParams,
  matchRoutePatternRaw,
  matchRoutePatternPrefix,
  type RoutePatternParams,
} from "../routing/route-pattern.js";
import { createAppRouteGraphInterceptionId } from "../routing/app-route-graph.js";
import {
  decodeMatchedParams,
  splitPathnameForRouteMatch,
  splitPathSegments,
} from "../routing/utils.js";
import { canonicalizeAppPageParams } from "./app-page-segment-state.js";

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
  id?: string | null;
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
  ids?: {
    route?: string | null;
  } | null;
  pattern: string;
  patternParts: string[];
  routeHandler?: unknown;
  slots?: Record<string, AppRscSlotForMatching>;
  siblingIntercepts?: AppRscSiblingInterceptForMatching[];
};

type AppRscInterceptMatch = AppRscInterceptLookupEntry & {
  matchedParams: AppRscRouteParams;
  sourceRouteIsConcrete: boolean;
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
  interceptionId: string | null;
  interceptionGraphId: string | null;
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
  targetRouteGraphId: string | null;
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

export function createAppRscRouteMatcher<Route extends AppRscRouteForMatching>(
  routes: Route[],
): {
  hasInterceptionId(interceptionId: string): boolean;
  matchRoute(url: string): { route: Route; params: AppRscRouteParams } | null;
  matchRequestRoute(url: string): { route: Route; params: AppRscRouteParams } | null;
  findIntercept(
    pathname: string,
    sourcePathname?: string | null,
    interceptionId?: string | null,
  ): AppRscInterceptMatch | null;
} {
  const routeTrie = buildRouteTrie(routes);
  const interceptLookup = createInterceptLookup(routes);
  const interceptionIds = new Set(
    interceptLookup.flatMap((entry) =>
      entry.interceptionId === null ? [] : [entry.interceptionId],
    ),
  );
  const routeIndexes = new Map<Route, number>(routes.map((route, index) => [route, index]));

  return {
    hasInterceptionId(interceptionId) {
      return interceptionIds.has(interceptionId);
    },
    matchRoute(url) {
      const rawParts = appRscPathnameParts(url, true);
      const result = trieMatchRaw(routeTrie, appRscPathnameParts(url, false));
      if (!result) return null;
      result.params = extractRawRoutePatternParams(result.route.patternParts, rawParts);
      normalizeMatchedParamsForRoute(result);
      return result;
    },
    matchRequestRoute(url) {
      const result = trieMatchRaw(routeTrie, appRscPathnameParts(url, true));
      if (!result) return null;
      normalizeMatchedParamsForRoute(result);
      return result;
    },
    findIntercept(pathname, sourcePathname = null, interceptionId = null) {
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
        if (interceptionId !== null && entry.interceptionId !== interceptionId) continue;
        // Primary gate: when the intercept declares a `sourceMatchPattern`
        // (the intercepting route's path, descendants allowed), require the
        // request's source pathname to satisfy it. This mirrors Next.js'
        // `^<interceptingRoute>(?:/.*)?$` header regex precisely and is the
        // authoritative gate when the manifest carries the pattern.
        if (!matchInterceptSource(sourceParts, entry)) continue;

        const params = matchRoutePatternRaw(urlParts, entry.targetPatternParts);
        if (params === null) continue;
        canonicalizeAppPageParams(params);

        // Resolving the claimed source pathname to its concrete descendant
        // route (#2042) keeps dynamic source params intact, but the source
        // pathname is an unauthenticated client header and the resolved route
        // becomes the route that renders or dispatches. A Route Handler has no
        // page, layouts, or parallel slots, so it can never own or sit inside
        // an interception source tree; promoting one only lets a crafted
        // interception context execute a `route.ts` that happens to live under
        // the intercepting route. Fall back to the slot owner instead, which is
        // the fixed destination Next.js' generated interception rewrite uses.
        const concreteSourceRoute =
          matchedSourceRoute &&
          entry.sourceMatchPatternParts !== null &&
          !isAppRouteHandlerRoute(matchedSourceRoute.route)
            ? matchedSourceRoute
            : null;
        const concreteSourceRouteIndex = concreteSourceRoute
          ? (routeIndexes.get(concreteSourceRoute.route) ?? entry.sourceRouteIndex)
          : entry.sourceRouteIndex;
        const sourceRoute = routes[concreteSourceRouteIndex];
        // The fallback owner can itself be a Route Handler. The route graph
        // retains slots discovered beside `route.ts`, so rejecting only a
        // concrete descendant handler is insufficient: promoting that owner
        // would reach the same handler dispatch branch. A handler cannot be a
        // renderable interception source, so let another matching intercept
        // win or reject this interception entirely.
        if (sourceRoute && isAppRouteHandlerRoute(sourceRoute)) continue;
        const matchedSourceParams = concreteSourceRoute
          ? concreteSourceRoute.params
          : sourceRoute
            ? matchSlotOwnerSourceParams(
                sourceParts,
                sourceRoute.patternParts,
                entry.sourceMatchPatternParts !== null,
              )
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
          sourceRouteIsConcrete: concreteSourceRoute !== null,
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
 * Params for the slot owner when interception falls back to it instead of a
 * concrete descendant source route. The owner is what renders, and
 * `matchInterceptRoute` reads the promoted route's params solely from these,
 * so dropping them would render a dynamic owner without its segments.
 *
 * An exact match covers a source that names the owner itself. It cannot
 * succeed when the source names a deeper descendant — a rejected Route
 * Handler, or a path with no concrete route — so once the descendants-allowed
 * gate has approved the source, take the owner's params from that prefix.
 */
function matchSlotOwnerSourceParams(
  sourceParts: readonly string[],
  patternParts: readonly string[],
  descendantsAllowed: boolean,
): AppRscRouteParams | null {
  const exact = matchRoutePatternRaw(sourceParts, patternParts);
  if (exact !== null) return exact;
  if (!descendantsAllowed || !matchRoutePatternPrefix(sourceParts, patternParts)) return null;
  return extractRawRoutePatternParams(patternParts, sourceParts);
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

function createRoutePatternStructureKey(patternParts: readonly string[]): string {
  return JSON.stringify(
    patternParts.map((part) => {
      if (!part.startsWith(":")) return ["static", part];
      if (part.endsWith("*")) return ["optional-catch-all"];
      if (part.endsWith("+")) return ["catch-all"];
      return ["dynamic"];
    }),
  );
}

function createPatternStructureToRouteGraphId<Route extends AppRscRouteForMatching>(
  routes: readonly Route[],
): ReadonlyMap<string, string | null> {
  const routeGraphIds = new Map<string, string | null>();

  for (const route of routes) {
    const routeGraphId = route.ids?.route;
    if (typeof routeGraphId !== "string") continue;

    const key = createRoutePatternStructureKey(route.patternParts);
    const previous = routeGraphIds.get(key);
    if (previous === undefined) {
      routeGraphIds.set(key, routeGraphId);
    } else if (previous !== routeGraphId) {
      // Route validation normally rejects structurally ambiguous patterns.
      // Keep the request-time lookup conservative if malformed/generated input
      // still contains more than one graph identity for the same URL shape.
      routeGraphIds.set(key, null);
    }
  }

  return routeGraphIds;
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
  const patternStructureToRouteGraphId = createPatternStructureToRouteGraphId(routes);
  const resolveTargetRouteGraphId = (targetPattern: string): string | null =>
    patternStructureToRouteGraphId.get(
      createRoutePatternStructureKey(targetPattern.split("/").filter(Boolean)),
    ) ?? null;

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
            interceptionId:
              typeof slotModule.id === "string" && sourceMatchPattern !== null
                ? createAppRouteGraphInterceptionId(
                    slotModule.id,
                    sourceMatchPattern,
                    intercept.targetPattern,
                  )
                : null,
            interceptionGraphId: null,
            sourceRouteIndex: ownerRouteIndex,
            slotKey,
            slotId: typeof slotModule.id === "string" ? slotModule.id : null,
            targetRouteGraphId: resolveTargetRouteGraphId(intercept.targetPattern),
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
          interceptionId: typeof intercept.id === "string" ? intercept.id : null,
          interceptionGraphId: typeof intercept.id === "string" ? intercept.id : null,
          sourceRouteIndex: routeIndex,
          slotKey: SIBLING_PAGE_INTERCEPT_SLOT_KEY,
          slotId: typeof intercept.slotId === "string" ? intercept.slotId : null,
          targetRouteGraphId: resolveTargetRouteGraphId(intercept.targetPattern),
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
