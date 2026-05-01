import { buildRouteTrie, trieMatch } from "../routing/route-trie.js";

type AppRscRouteParams = Record<string, string | string[]>;

type AppRscInterceptForMatching = {
  targetPattern: string;
  interceptLayouts: readonly unknown[];
  page: unknown;
  params: readonly string[];
};

type AppRscSlotForMatching = {
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
  interceptLayouts: readonly unknown[];
  page: unknown;
  params: readonly string[];
};

function createRouteParams(): AppRscRouteParams {
  return Object.create(null);
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
      const pathname = url.split("?")[0];
      const normalizedUrl = pathname === "/" ? "/" : pathname.replace(/\/$/, "");
      // The request entry point owns decoding. Matching here preserves the
      // already-normalized segment bytes so middleware and routing stay aligned.
      const urlParts = normalizedUrl.split("/").filter(Boolean);
      return trieMatch(routeTrie, urlParts);
    },
    findIntercept(pathname, sourcePathname = null) {
      const urlParts = pathname.split("/").filter(Boolean);
      for (const entry of interceptLookup) {
        const params = matchAppRscRoutePattern(urlParts, entry.targetPatternParts);
        if (params !== null) {
          let sourceParams = createRouteParams();
          if (sourcePathname !== null) {
            const sourceRoute = routes[entry.sourceRouteIndex];
            const sourceParts = sourcePathname.split("/").filter(Boolean);
            const matchedSourceParams = sourceRoute
              ? matchAppRscRoutePattern(sourceParts, sourceRoute.patternParts)
              : null;
            if (matchedSourceParams !== null) {
              sourceParams = matchedSourceParams;
            }
          }
          return { ...entry, matchedParams: mergeMatchedParams(sourceParams, params) };
        }
      }
      return null;
    },
  };
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
        interceptLookup.push({
          sourceRouteIndex: routeIndex,
          slotKey,
          targetPattern: intercept.targetPattern,
          targetPatternParts: intercept.targetPattern.split("/").filter(Boolean),
          interceptLayouts: intercept.interceptLayouts,
          page: intercept.page,
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
  const params = createRouteParams();
  for (let i = 0; i < patternParts.length; i++) {
    const patternPart = patternParts[i];
    if (patternPart.startsWith(":") && patternPart.endsWith("+")) {
      if (i !== patternParts.length - 1) return null;
      const paramName = patternPart.slice(1, -1);
      const remaining = urlParts.slice(i);
      if (remaining.length === 0) return null;
      params[paramName] = remaining;
      return params;
    }
    if (patternPart.startsWith(":") && patternPart.endsWith("*")) {
      if (i !== patternParts.length - 1) return null;
      const paramName = patternPart.slice(1, -1);
      const remaining = urlParts.slice(i);
      if (remaining.length > 0) {
        params[paramName] = remaining;
      }
      return params;
    }
    if (patternPart.startsWith(":")) {
      if (i >= urlParts.length) return null;
      params[patternPart.slice(1)] = urlParts[i];
      continue;
    }
    if (i >= urlParts.length || urlParts[i] !== patternPart) return null;
  }
  if (urlParts.length !== patternParts.length) return null;
  return params;
}

function mergeMatchedParams(
  sourceParams: AppRscRouteParams,
  targetParams: AppRscRouteParams,
): AppRscRouteParams {
  return Object.assign(createRouteParams(), sourceParams, targetParams);
}
