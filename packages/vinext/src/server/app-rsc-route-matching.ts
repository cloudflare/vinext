import { buildRouteTrie, trieMatchRaw } from "../routing/route-trie.js";
import {
  extractRawRoutePatternParams,
  matchRoutePatternRaw,
  matchRoutePatternPrefix,
  type RoutePatternParams,
} from "../routing/route-pattern.js";
import { createAppRouteGraphInterceptionId } from "../routing/app-route-ids.js";
import {
  decodeMatchedParams,
  decodeRouteSegment,
  isInvisibleSegment,
  splitPathSegments,
} from "../routing/utils.js";
import { ROUTE_MISS_INTERCEPTION_CONTEXT } from "./app-interception-context-header.js";
import { canonicalizeAppPageParams } from "./app-page-segment-state.js";
import { getRenderedConcreteUrlPathsForRoute } from "./pregenerated-concrete-paths.js";

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
  interceptNotFounds?: readonly unknown[];
  interceptNotFoundTreePositions?: readonly number[];
  __loadInterceptLayouts?: readonly (() => Promise<unknown>)[] | null;
  __loadInterceptLoadings?: readonly (() => Promise<unknown>)[] | null;
  __loadInterceptNotFounds?: readonly (() => Promise<unknown>)[] | null;
  page: unknown;
  __pageLoader?: (() => Promise<unknown>) | null;
  notFound?: unknown;
  __loadNotFound?: (() => Promise<unknown>) | null;
  notFoundTreePosition?: number | null;
  interceptForbiddens?: readonly unknown[];
  interceptForbiddenTreePositions?: readonly number[];
  __loadInterceptForbiddens?: readonly (() => Promise<unknown>)[] | null;
  interceptUnauthorizeds?: readonly unknown[];
  interceptUnauthorizedTreePositions?: readonly number[];
  __loadInterceptUnauthorizeds?: readonly (() => Promise<unknown>)[] | null;
  interceptErrors?: readonly unknown[];
  interceptErrorTreePositions?: readonly number[];
  __loadInterceptErrors?: readonly (() => Promise<unknown>)[] | null;
  /** The `default` file of the directory holding the slot, if any. */
  ownerDefault?: unknown;
  __loadOwnerDefault?: (() => Promise<unknown>) | null;
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
  interceptNotFounds?: readonly unknown[];
  interceptNotFoundTreePositions?: readonly number[];
  __loadInterceptLayouts?: readonly (() => Promise<unknown>)[] | null;
  __loadInterceptLoadings?: readonly (() => Promise<unknown>)[] | null;
  __loadInterceptNotFounds?: readonly (() => Promise<unknown>)[] | null;
  page: unknown;
  // Sibling intercept pages are lazy-loaded (manifest emits `page: null` plus a
  // `__pageLoader`) so the intercepting page's CSS chunk stays isolated in
  // production, matching slot intercepts (see #1738). The loader is awaited on
  // demand by resolveAppPageInterceptState.
  __pageLoader?: (() => Promise<unknown>) | null;
  notFound?: unknown;
  __loadNotFound?: (() => Promise<unknown>) | null;
  notFoundTreePosition?: number | null;
  interceptForbiddens?: readonly unknown[];
  interceptForbiddenTreePositions?: readonly number[];
  __loadInterceptForbiddens?: readonly (() => Promise<unknown>)[] | null;
  interceptUnauthorizeds?: readonly unknown[];
  interceptUnauthorizedTreePositions?: readonly number[];
  __loadInterceptUnauthorizeds?: readonly (() => Promise<unknown>)[] | null;
  interceptErrors?: readonly unknown[];
  interceptErrorTreePositions?: readonly number[];
  __loadInterceptErrors?: readonly (() => Promise<unknown>)[] | null;
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
  routeSegments?: readonly string[] | null;
  slots?: Record<string, AppRscSlotForMatching>;
  siblingIntercepts?: AppRscSiblingInterceptForMatching[];
};

type AppRscInterceptMatch = AppRscInterceptLookupEntry & {
  matchedParams: AppRscRouteParams;
  sourceRouteIsConcrete: boolean;
  /**
   * /_not-found, which names no route, reaches a root-level intercept whose
   * owner is the intercepting route's own: the root page for a sibling
   * intercept, a root route group's page for its slot. That owner stands in
   * for the source route.
   */
  rendersRootOwnerFromRouteMiss: boolean;
  /**
   * The source route has no slot to render a slot intercept into. Unless the
   * request renders the whole intercepting route, returned only to a caller
   * that accepts such a source, which a source rewrite can still turn into one
   * that has the slot.
   */
  sourceRouteLacksSlot: boolean;
  /**
   * A source without the slot, such as a static page in a sibling route
   * group, shares none of the intercepting route's tree below the root. Like
   * Next.js's interception rewrite, the request then renders that tree whole:
   * the slot owner's route, with the owner's `default` in its children, and
   * the source's values for the owner's params.
   */
  rendersWholeInterceptingRoute: boolean;
  sourceMatchedParams: AppRscRouteParams;
  /**
   * The source route and params the request's interception context names,
   * which the request handler authorizes. They differ from the rendered
   * `sourceRouteIndex` only for a sibling intercept opened from a deeper
   * source, which renders the intercepting route itself.
   */
  authorizationSourceRouteIndex: number;
  authorizationSourceParams: AppRscRouteParams;
  /**
   * Whether a direct request to the target renders the layouts the
   * intercepted render takes from the source, down to the intercepting route,
   * from the same directories with the same params. The target's own request
   * authorized those, so the source adds nothing it must authorize.
   */
  rendersTargetLayouts: boolean;
  /**
   * The same for the raw match, which draft mode and server actions render
   * instead.
   */
  rawRendersTargetLayouts: boolean;
};

type AppRscInterceptLoadState = {
  page: unknown;
  pageLoading: Promise<unknown> | null;
  notFound: unknown;
  notFoundLoading: Promise<unknown> | null;
  ownerDefault: unknown;
  ownerDefaultLoading: Promise<unknown> | null;
  interceptLayoutsLoading: Promise<readonly unknown[]> | null;
};

type AppRscInterceptLookupEntry = {
  interceptionId: string | null;
  interceptionGraphId: string | null;
  sourceRouteIndex: number;
  /**
   * A sibling intercept whose owner route's page sits in the directory of the
   * interception marker, so the owner is the intercepting route itself.
   */
  ownerIsInterceptingRoute: boolean;
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
  interceptNotFounds?: readonly unknown[];
  interceptNotFoundTreePositions?: readonly number[];
  __loadInterceptLayouts?: readonly (() => Promise<unknown>)[] | null;
  __loadInterceptLoadings?: readonly (() => Promise<unknown>)[] | null;
  __loadInterceptNotFounds?: readonly (() => Promise<unknown>)[] | null;
  page: unknown;
  __pageLoader?: (() => Promise<unknown>) | null;
  notFound: unknown;
  __loadNotFound?: (() => Promise<unknown>) | null;
  notFoundTreePosition?: number | null;
  interceptForbiddens?: readonly unknown[];
  interceptForbiddenTreePositions?: readonly number[];
  __loadInterceptForbiddens?: readonly (() => Promise<unknown>)[] | null;
  interceptUnauthorizeds?: readonly unknown[];
  interceptUnauthorizedTreePositions?: readonly number[];
  __loadInterceptUnauthorizeds?: readonly (() => Promise<unknown>)[] | null;
  interceptErrors?: readonly unknown[];
  interceptErrorTreePositions?: readonly number[];
  __loadInterceptErrors?: readonly (() => Promise<unknown>)[] | null;
  ownerDefault?: unknown;
  __loadOwnerDefault?: (() => Promise<unknown>) | null;
  __loadState: AppRscInterceptLoadState;
  params: readonly string[];
  slotId: string | null;
  targetRouteGraphId: string | null;
};

function createRouteParams(): AppRscRouteParams {
  return Object.create(null);
}

/**
 * Whether each encoded raw segment is exactly the spelling the URL parser, as
 * a browser runs it, gives its decoded form: `caf%C3%A9` for `café`, but `q&a`
 * for `q&a`. `%61dmin`, `caf%c3%a9`, `%63af%C3%A9` and `q%26a` are other
 * spellings of a page, which middleware never compared as its pathname.
 */
function isCanonicalPathEncoding(
  rawParts: readonly string[],
  decodedParts: readonly string[],
): boolean {
  return rawParts.every(
    (rawPart, index) =>
      !rawPart.includes("%") ||
      rawPart === new URL(`/${decodedParts[index]}`, "http://n").pathname.slice(1),
  );
}

function appRscPathnameParts(pathname: string): string[] {
  const pathOnly = pathname.split("?")[0];
  const normalizedPathname = pathOnly === "/" ? "/" : pathOnly.replace(/\/$/, "");
  return splitPathSegments(normalizedPathname);
}

export function isAppRouteHandlerRoute(
  route: Pick<AppRscRouteForMatching, "__loadRouteHandler" | "routeHandler">,
): boolean {
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

/**
 * @param decodedPathnamePatterns Static page patterns that answer their
 *   segment-decoded pathname (built by `buildAppDecodedPathnamePatterns`).
 */
export function createAppRscRouteMatcher<Route extends AppRscRouteForMatching>(
  routes: Route[],
  decodedPathnamePatterns: readonly string[] = [],
): {
  hasInterceptionId(interceptionId: string): boolean;
  matchRoute(url: string): { route: Route; params: AppRscRouteParams } | null;
  matchRequestRoute(url: string): { route: Route; params: AppRscRouteParams } | null;
  matchRawRequestRoute(url: string): { route: Route; params: AppRscRouteParams } | null;
  findIntercept(
    pathname: string,
    sourcePathname?: string | null,
    interceptionId?: string | null,
    acceptsSourceWithoutSlot?: boolean,
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
  const decodedPathnamePatternSet = new Set(decodedPathnamePatterns);
  const decodedPathnameRoutes = new Map<string, Route>();
  for (const route of routes) {
    const key = route.patternParts.join("/");
    if (decodedPathnamePatternSet.has(route.pattern) && !decodedPathnameRoutes.has(key)) {
      decodedPathnameRoutes.set(key, route);
    }
  }

  function matchRawRequestParts(
    rawParts: string[],
  ): { route: Route; params: AppRscRouteParams } | null {
    const result = trieMatchRaw(routeTrie, rawParts);
    if (result) normalizeMatchedParamsForRoute(result);
    return result;
  }

  function matchRequestParts(
    rawParts: string[],
  ): { route: Route; params: AppRscRouteParams } | null {
    const result = matchRawRequestParts(rawParts);
    if (!result) return null;
    // Next.js matches the raw pathname, so `/%61` reaches `/[slug]`, but that
    // page then answers from the response cached under the decoded pathname:
    // the prerendered static `/a`. Render the static page itself instead, so
    // the response and the cache entry it shares belong to one route. Encoded
    // path delimiters (`%2F`) stay inside their segment, and a raw path that
    // matches nothing or a Route Handler keeps that outcome, as in Next.js.
    // Draft mode and server actions skip that cache, so the handler renders
    // their `matchRawRequestRoute` instead.
    //
    // The build list only says a page may be prerendered: segment config can't
    // tell a page that reads cookies() or searchParams, which has no cached
    // response. So another spelling of a page (`/%61dmin`), which middleware
    // never compared as `/admin`, renders the raw match unless the build
    // recorded the decoded pathname's prerender. The exact spelling a browser
    // sends for the page (`/caf%C3%A9`) is that page's own pathname, so it
    // renders the page without one.
    if (
      decodedPathnameRoutes.size > 0 &&
      result.route.patternParts.some((part) => part.startsWith(":")) &&
      !isAppRouteHandlerRoute(result.route) &&
      rawParts.some((part) => part.includes("%"))
    ) {
      const decodedParts = rawParts.map(decodeRouteSegment);
      const decodedPathname = decodedParts.join("/");
      const route = decodedPathnameRoutes.get(decodedPathname);
      if (
        route &&
        route !== result.route &&
        (isCanonicalPathEncoding(rawParts, decodedParts) ||
          getRenderedConcreteUrlPathsForRoute(route.pattern)?.has(`/${decodedPathname}`) === true)
      ) {
        return { route, params: createRouteParams() };
      }
    }
    return result;
  }

  return {
    hasInterceptionId(interceptionId) {
      return interceptionIds.has(interceptionId);
    },
    matchRoute(url) {
      // Next.js routes a rewrite destination exactly like a direct request to
      // it: on its still-encoded segments, so `/en/%64ashboard` is not the
      // static `/en/dashboard` that middleware compared the pathname against.
      return matchRequestParts(appRscPathnameParts(url));
    },
    matchRequestRoute(url) {
      return matchRequestParts(appRscPathnameParts(url));
    },
    matchRawRequestRoute(url) {
      return matchRawRequestParts(appRscPathnameParts(url));
    },
    findIntercept(
      pathname,
      sourcePathname = null,
      interceptionId = null,
      acceptsSourceWithoutSlot = false,
    ) {
      // Mirror Next.js' rewrite semantics: interception only fires when the
      // Next-URL header is present AND matches the intercepting route's regex
      // (with descendants allowed). Without a source pathname there is no
      // header for the rewrite to gate on, so we render the direct route.
      // https://github.com/vercel/next.js/blob/canary/packages/next/src/lib/generate-interception-routes-rewrites.ts
      if (sourcePathname === null) return null;

      const urlParts = appRscPathnameParts(pathname);
      // Match the source against the raw, still-encoded path, as the Next-Url
      // header regex does. Decoding first would let `/%66eed` claim the static
      // `/feed` source, and the decoded static page substitution would let
      // `/%61dmin` claim a static `/admin` that doesn't own the intercept.
      const sourceParts = appRscPathnameParts(sourcePathname);
      const matchedSourceRoute = matchRawRequestParts(sourceParts);
      let slotlessSourceMatch: AppRscInterceptMatch | null = null;
      // From an unmatched URL's not-found page, the first intercept whose
      // source and target match decides, as Next.js's first matching
      // interception rewrite does. When it can't render here, the target
      // renders directly rather than a later intercept.
      const isRouteMissSource = sourcePathname === ROUTE_MISS_INTERCEPTION_CONTEXT;

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
        if (sourceRoute && isAppRouteHandlerRoute(sourceRoute)) {
          if (isRouteMissSource) return null;
          continue;
        }
        const matchedSourceParams = concreteSourceRoute
          ? concreteSourceRoute.params
          : sourceRoute
            ? matchSlotOwnerSourceParams(
                sourceParts,
                sourceRoute.patternParts,
                entry.sourceMatchPatternParts !== null,
              )
            : null;
        if (!concreteSourceRoute && matchedSourceParams) {
          canonicalizeAppPageParams(matchedSourceParams);
        }
        // A slot intercept renders into its owner's slot within the source
        // route. A source outside the owner's tree, such as a static sibling in
        // another route group, has no such slot. Next.js's interception rewrite
        // still applies to it, and renders the intercepting route's tree whole,
        // which takes the slot owner's own route. Without one, the request
        // renders the target directly, as for a source that matches no page. A
        // caller that authorizes the source first can accept that source
        // anyway, since its middleware can rewrite it to a route with the slot.
        const sourceRouteLacksSlot =
          entry.slotKey !== SIBLING_PAGE_INTERCEPT_SLOT_KEY &&
          sourceRoute?.slots?.[entry.slotKey] === undefined;
        const ownerRoute = routes[entry.sourceRouteIndex];
        // An unmatched URL's not-found page shows none of the intercepting
        // route's tree, so it keeps no source segment beneath the intercept:
        // Next.js's client then shows the intercepting route's own render,
        // with nothing in the owner's children.
        const rendersFromRouteMiss =
          isRouteMissSource && entry.slotKey !== SIBLING_PAGE_INTERCEPT_SLOT_KEY;
        const rendersWholeInterceptingRoute =
          (sourceRouteLacksSlot || rendersFromRouteMiss) &&
          ownerRoute !== undefined &&
          !isAppRouteHandlerRoute(ownerRoute) &&
          ownerRoute.slots?.[entry.slotKey] !== undefined &&
          isSlotOwnerRoute(ownerRoute.routeSegments, entry.sourcePageSegments);
        if (rendersFromRouteMiss && !rendersWholeInterceptingRoute) return null;
        // A sibling intercept whose marker directory has no page of its own
        // would render from it through a stand-in owner, or the route that
        // /_not-found happens to match, never the intercepting route Next.js
        // shows.
        if (
          isRouteMissSource &&
          entry.slotKey === SIBLING_PAGE_INTERCEPT_SLOT_KEY &&
          !entry.ownerIsInterceptingRoute
        ) {
          return null;
        }
        // Among sources without the slot, the first whole intercepting route
        // wins over an earlier intercept that only a rewrite can give a slot.
        if (
          sourceRouteLacksSlot &&
          ((!rendersWholeInterceptingRoute && !acceptsSourceWithoutSlot) ||
            (slotlessSourceMatch !== null &&
              (slotlessSourceMatch.rendersWholeInterceptingRoute ||
                !rendersWholeInterceptingRoute)))
        ) {
          continue;
        }
        // A sibling intercept renders the intercepting route itself, whatever
        // the source: Next.js rewrites it to the fixed intercepting route, so
        // its layouts come from the owner, never from a deeper source page.
        // The source the context names is still the one authorized.
        const rendersOwnerRoute =
          rendersWholeInterceptingRoute ||
          (entry.ownerIsInterceptingRoute &&
            concreteSourceRouteIndex !== entry.sourceRouteIndex &&
            ownerRoute !== undefined);
        // The whole intercepting route takes every param of the intercepting
        // route from the source, as the interception rewrite captures them,
        // including those of the slot's folders above the marker, such as
        // `[album]` in `@modal/[album]/(.)pics/[id]`.
        const renderedSourceParams = rendersOwnerRoute
          ? matchSlotOwnerSourceParams(
              sourceParts,
              rendersWholeInterceptingRoute && entry.sourceMatchPatternParts !== null
                ? entry.sourceMatchPatternParts
                : ownerRoute.patternParts,
              true,
            )
          : matchedSourceParams;
        if (rendersOwnerRoute && renderedSourceParams) {
          canonicalizeAppPageParams(renderedSourceParams);
        }

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
          if (isRouteMissSource) return null;
          continue;
        }
        const sourceParams =
          renderedSourceParams && entry.sourceMatchPatternParts !== null
            ? pickPatternParams(renderedSourceParams, entry.sourceMatchPatternParts)
            : (renderedSourceParams ?? createRouteParams());
        const renderedSourceSegments =
          routes[rendersOwnerRoute ? entry.sourceRouteIndex : concreteSourceRouteIndex]
            ?.routeSegments;
        const match = {
          ...entry,
          page: entry.__loadState.page,
          ownerDefault: entry.__loadState.ownerDefault,
          // A source without the slot never skips source authorization, since
          // its middleware can rewrite it to a route with the slot, which then
          // renders as the source instead. Nor does the whole intercepting
          // route, whose source decides whether it renders at all.
          rendersTargetLayouts:
            !sourceRouteLacksSlot &&
            !rendersWholeInterceptingRoute &&
            rendersTargetLayouts(
              entry,
              renderedSourceSegments,
              sourceParts,
              sourceParams,
              params,
              matchRequestParts(urlParts),
            ),
          rawRendersTargetLayouts:
            !sourceRouteLacksSlot &&
            !rendersWholeInterceptingRoute &&
            rendersTargetLayouts(
              entry,
              renderedSourceSegments,
              sourceParts,
              sourceParams,
              params,
              matchRawRequestParts(urlParts),
            ),
          sourceRouteIsConcrete: concreteSourceRoute !== null,
          rendersRootOwnerFromRouteMiss:
            isRouteMissSource &&
            concreteSourceRoute === null &&
            entry.sourceMatchPatternParts?.length === 0,
          sourceRouteLacksSlot,
          rendersWholeInterceptingRoute,
          sourceRouteIndex: rendersOwnerRoute ? entry.sourceRouteIndex : concreteSourceRouteIndex,
          // The params above the interception marker, the owner's and those of
          // the slot's folders, take the values the interception rewrite
          // captures from the source pathname, as the root params do. Where
          // they differ from the target's, `rendersTargetLayouts` is false, so
          // the source is authorized like a direct request to it, or dropped.
          matchedParams: mergeMatchedParams(params, sourceParams),
          sourceMatchedParams: renderedSourceParams ?? createRouteParams(),
          authorizationSourceRouteIndex: concreteSourceRouteIndex,
          authorizationSourceParams: matchedSourceParams ?? createRouteParams(),
        };
        // An intercept whose source has the slot wins over an earlier one
        // whose source lacks it. A route miss renders the whole intercepting
        // route either way.
        if (!sourceRouteLacksSlot || isRouteMissSource) return match;
        slotlessSourceMatch = match;
      }
      return slotlessSourceMatch;
    },
  };
}

// The interception markers the route graph recognizes. A route group such as
// `(....)` only looks like one.
const INTERCEPTION_MARKER_PREFIXES = ["(...)", "(..)(..)", "(..)", "(.)"] as const;

function findInterceptionMarkerIndex(segments: readonly string[]): number {
  return segments.findIndex((segment) =>
    INTERCEPTION_MARKER_PREFIXES.some((prefix) => segment.startsWith(prefix)),
  );
}

/**
 * Whether a sibling intercept's owner route is the intercepting route: its
 * page lives in the directory that holds the interception marker. An owner
 * found elsewhere stands in for a marker directory without a page.
 */
function isInterceptingRoute(
  routeSegments: readonly string[] | null | undefined,
  sourcePageSegments: readonly string[] | null | undefined,
): boolean {
  if (!routeSegments || !sourcePageSegments) return false;
  const markerIndex = findInterceptionMarkerIndex(sourcePageSegments);
  return (
    markerIndex === routeSegments.length &&
    routeSegments.every((segment, index) => segment === sourcePageSegments[index])
  );
}

/**
 * Whether a route's directory is the one holding a slot intercept's `@slot`
 * directory, so the route is the slot's owner itself. A page in route groups
 * below that directory, such as `(children)/page.tsx`, is at the slot's URL
 * level too, as the route graph places the slot there.
 */
function isSlotOwnerRoute(
  routeSegments: readonly string[] | null | undefined,
  sourcePageSegments: readonly string[] | null | undefined,
): boolean {
  if (!routeSegments || !sourcePageSegments) return false;
  const slotIndex = sourcePageSegments.findIndex((segment) => segment.startsWith("@"));
  return (
    slotIndex >= 0 &&
    slotIndex <= routeSegments.length &&
    sourcePageSegments
      .slice(0, slotIndex)
      .every((segment, index) => segment === routeSegments[index]) &&
    routeSegments.slice(slotIndex).every(isInvisibleSegment)
  );
}

/**
 * Whether the target's own route renders the intercepting route's layouts with
 * the source's params. A slot intercept takes from the source only the layouts
 * down to the slot's owner; the client keeps the rest, and everything from the
 * slot down is the intercepting branch, like the intercepting page. When the
 * owner's directories are the ones the target's route starts with, and every
 * param down to the marker holds the target's value, a direct request to the
 * target renders those layouts too. A sibling intercept renders its whole
 * source route.
 *
 * The values are the ones the interception rewrite captures from the source
 * and target paths, since a static route beside a dynamic folder binds none.
 * Wherever the routes that render bind the param, they must agree too.
 */
function rendersTargetLayouts(
  entry: AppRscInterceptLookupEntry,
  renderedSegments: readonly string[] | null | undefined,
  sourceParts: readonly string[],
  sourceParams: AppRscRouteParams,
  targetCaptures: AppRscRouteParams,
  target: { route: { routeSegments?: readonly string[] | null }; params: AppRscRouteParams } | null,
): boolean {
  const { sourcePageSegments, sourceMatchPatternParts } = entry;
  const targetSegments = target?.route.routeSegments;
  if (!sourcePageSegments || !sourceMatchPatternParts || !renderedSegments || !targetSegments) {
    return false;
  }
  const markerIndex = findInterceptionMarkerIndex(sourcePageSegments);
  const slotIndex = sourcePageSegments.findIndex((segment) => segment.startsWith("@"));
  if (markerIndex === -1 || slotIndex === -1 || slotIndex > markerIndex) return false;
  // A slot nested in another renders beneath that slot's own branch, which
  // the target's request may not render.
  if (
    sourcePageSegments.slice(slotIndex + 1, markerIndex).some((segment) => segment.startsWith("@"))
  ) {
    return false;
  }
  const ownerSegments = sourcePageSegments.slice(0, slotIndex);
  const startsWithOwner = (segments: readonly string[]) =>
    ownerSegments.every((segment, index) => segment === segments[index]);
  if (!startsWithOwner(renderedSegments) || !startsWithOwner(targetSegments)) return false;
  const sourceCaptures = matchSlotOwnerSourceParams(sourceParts, sourceMatchPatternParts, true);
  if (!sourceCaptures) return false;
  canonicalizeAppPageParams(sourceCaptures);
  const targetParams = Object.assign(createRouteParams(), target.params);
  canonicalizeAppPageParams(targetParams);
  return sourcePageSegments.slice(0, markerIndex).every((segment) => {
    const name = /^\[{1,2}(?:\.\.\.)?([^\]]+)\]{1,2}$/.exec(segment)?.[1];
    if (name === undefined) return true;
    const value = targetCaptures[name];
    if (value === undefined || !sameParam(sourceCaptures[name], value)) return false;
    return [sourceParams[name], targetParams[name]].every(
      (bound) => bound === undefined || sameParam(bound, value),
    );
  });
}

function sameParam(value: string | string[] | undefined, other: string | string[]): boolean {
  return Array.isArray(value)
    ? Array.isArray(other) &&
        value.length === other.length &&
        value.every((part, index) => part === other[index])
    : value === other;
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
          // With slot folders above the marker, as in
          // `@modal/[album]/(.)pics/[id]`, that pattern names a deeper path,
          // so the route holding the slot's directory is the owner itself.
          const ownerRouteIndex = isSlotOwnerRoute(
            route.routeSegments,
            intercept.sourcePageSegments,
          )
            ? routeIndex
            : sourceMatchPattern !== null
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
            ownerIsInterceptingRoute: false,
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
            interceptNotFounds: intercept.interceptNotFounds,
            interceptNotFoundTreePositions: intercept.interceptNotFoundTreePositions,
            __loadInterceptNotFounds: intercept.__loadInterceptNotFounds,
            __loadInterceptLayouts: intercept.__loadInterceptLayouts,
            __loadInterceptLoadings: intercept.__loadInterceptLoadings,
            page: intercept.page,
            __pageLoader: intercept.__pageLoader,
            notFound: intercept.notFound,
            __loadNotFound: intercept.__loadNotFound,
            notFoundTreePosition: intercept.notFoundTreePosition,
            interceptForbiddens: intercept.interceptForbiddens,
            interceptForbiddenTreePositions: intercept.interceptForbiddenTreePositions,
            __loadInterceptForbiddens: intercept.__loadInterceptForbiddens,
            interceptUnauthorizeds: intercept.interceptUnauthorizeds,
            interceptUnauthorizedTreePositions: intercept.interceptUnauthorizedTreePositions,
            __loadInterceptUnauthorizeds: intercept.__loadInterceptUnauthorizeds,
            interceptErrors: intercept.interceptErrors,
            interceptErrorTreePositions: intercept.interceptErrorTreePositions,
            __loadInterceptErrors: intercept.__loadInterceptErrors,
            ownerDefault: intercept.ownerDefault,
            __loadOwnerDefault: intercept.__loadOwnerDefault,
            __loadState: {
              page: intercept.page,
              pageLoading: null,
              notFound: intercept.notFound,
              notFoundLoading: null,
              ownerDefault: intercept.ownerDefault,
              ownerDefaultLoading: null,
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
          // A Route Handler can stand in as the owner, but never renders a tree.
          ownerIsInterceptingRoute:
            !isAppRouteHandlerRoute(route) &&
            isInterceptingRoute(route.routeSegments, intercept.sourcePageSegments),
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
          interceptNotFounds: intercept.interceptNotFounds,
          interceptNotFoundTreePositions: intercept.interceptNotFoundTreePositions,
          __loadInterceptNotFounds: intercept.__loadInterceptNotFounds,
          __loadInterceptLayouts: intercept.__loadInterceptLayouts,
          __loadInterceptLoadings: intercept.__loadInterceptLoadings,
          page: intercept.page,
          __pageLoader: intercept.__pageLoader,
          notFound: intercept.notFound,
          __loadNotFound: intercept.__loadNotFound,
          notFoundTreePosition: intercept.notFoundTreePosition,
          interceptForbiddens: intercept.interceptForbiddens,
          interceptForbiddenTreePositions: intercept.interceptForbiddenTreePositions,
          __loadInterceptForbiddens: intercept.__loadInterceptForbiddens,
          interceptUnauthorizeds: intercept.interceptUnauthorizeds,
          interceptUnauthorizedTreePositions: intercept.interceptUnauthorizedTreePositions,
          __loadInterceptUnauthorizeds: intercept.__loadInterceptUnauthorizeds,
          interceptErrors: intercept.interceptErrors,
          interceptErrorTreePositions: intercept.interceptErrorTreePositions,
          __loadInterceptErrors: intercept.__loadInterceptErrors,
          __loadState: {
            page: intercept.page,
            pageLoading: null,
            notFound: intercept.notFound,
            notFoundLoading: null,
            ownerDefault: null,
            ownerDefaultLoading: null,
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
  targetParams: AppRscRouteParams,
  sourceParams: AppRscRouteParams,
): AppRscRouteParams {
  return Object.assign(createRouteParams(), targetParams, sourceParams);
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
