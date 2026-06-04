import { buildRouteTrie, trieMatch } from "../routing/route-trie.js";
import {
  matchRoutePattern,
  matchRoutePatternPrefix,
  type RoutePatternParams,
} from "../routing/route-pattern.js";
import { splitPathnameForRouteMatch } from "../routing/utils.js";

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
  interceptLayouts: readonly unknown[];
  page: unknown;
  __pageLoader?: (() => Promise<unknown>) | null;
  params: readonly string[];
};

type AppRscSlotForMatching = {
  id?: string | null;
  intercepts?: readonly AppRscInterceptForMatching[];
};

type AppRscRouteForMatching = {
  patternParts: string[];
  slots?: Record<string, AppRscSlotForMatching>;
};

type AppRscInterceptMatch = AppRscInterceptLookupEntry & {
  matchedParams: AppRscRouteParams;
};

type AppRscInterceptLookupEntry = {
  sourceRouteIndex: number;
  slotKey: string;
  targetPattern: string;
  targetPatternParts: string[];
  sourceMatchPattern: string | null;
  sourceMatchPatternParts: string[] | null;
  interceptLayouts: readonly unknown[];
  page: unknown;
  __pageLoader?: (() => Promise<unknown>) | null;
  params: readonly string[];
  slotId: string | null;
};

function createRouteParams(): AppRscRouteParams {
  return Object.create(null);
}

function appRscPathnameParts(pathname: string): string[] {
  const pathOnly = pathname.split("?")[0];
  const normalized = pathOnly === "/" ? "/" : pathOnly.replace(/\/$/, "");
  return splitPathnameForRouteMatch(normalized);
}

export function createAppRscRouteMatcher<Route extends AppRscRouteForMatching>(
  routes: Route[],
): {
  matchRoute(url: string): { route: Route; params: AppRscRouteParams } | null;
  findIntercept(pathname: string, sourcePathname?: string | null): AppRscInterceptMatch | null;
} {
  const routeTrie = buildRouteTrie(routes);
  const interceptLookup = createInterceptLookup(routes);

  return {
    matchRoute(url) {
      return trieMatch(routeTrie, appRscPathnameParts(url));
    },
    findIntercept(pathname, sourcePathname = null) {
      // Mirror Next.js' rewrite semantics: interception only fires when the
      // Next-URL header is present AND matches the intercepting route's regex
      // (with descendants allowed). Without a source pathname there is no
      // header for the rewrite to gate on, so we render the direct route.
      // https://github.com/vercel/next.js/blob/canary/packages/next/src/lib/generate-interception-routes-rewrites.ts
      if (sourcePathname === null) return null;

      const urlParts = appRscPathnameParts(pathname);
      const sourceParts = appRscPathnameParts(sourcePathname);

      for (const entry of interceptLookup) {
        // Primary gate: when the intercept declares a `sourceMatchPattern`
        // (the intercepting route's path, descendants allowed), require the
        // request's source pathname to satisfy it. This mirrors Next.js'
        // `^<interceptingRoute>(?:/.*)?$` header regex precisely and is the
        // authoritative gate when the manifest carries the pattern.
        if (!matchInterceptSource(sourceParts, entry)) continue;

        const params = matchAppRscRoutePattern(urlParts, entry.targetPatternParts);
        if (params === null) continue;

        const sourceRoute = routes[entry.sourceRouteIndex];
        const matchedSourceParams = sourceRoute
          ? matchAppRscRoutePattern(sourceParts, sourceRoute.patternParts)
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
        const sourceParams = matchedSourceParams ?? createRouteParams();
        return { ...entry, matchedParams: mergeMatchedParams(sourceParams, params) };
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

function createInterceptLookup<Route extends AppRscRouteForMatching>(
  routes: Route[],
): AppRscInterceptLookupEntry[] {
  const interceptLookup: AppRscInterceptLookupEntry[] = [];
  for (let routeIndex = 0; routeIndex < routes.length; routeIndex++) {
    const route = routes[routeIndex];
    if (!route.slots) continue;
    for (const [slotKey, slotModule] of Object.entries(route.slots)) {
      if (!slotModule.intercepts) continue;
      for (const intercept of slotModule.intercepts) {
        const sourceMatchPattern = intercept.sourceMatchPattern ?? null;
        const sourceMatchPatternParts = sourceMatchPattern
          ? sourceMatchPattern.split("/").filter(Boolean)
          : null;
        interceptLookup.push({
          sourceRouteIndex: routeIndex,
          slotKey,
          slotId: typeof slotModule.id === "string" ? slotModule.id : null,
          targetPattern: intercept.targetPattern,
          targetPatternParts: intercept.targetPattern.split("/").filter(Boolean),
          sourceMatchPattern,
          sourceMatchPatternParts,
          interceptLayouts: intercept.interceptLayouts,
          page: intercept.page,
          __pageLoader: intercept.__pageLoader,
          params: intercept.params,
        });
      }
    }
  }
  return interceptLookup;
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
