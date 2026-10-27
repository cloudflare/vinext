/**
 * App Router prefetch policy resolution, shared by `<Link>` (`link.tsx`) and
 * `router.prefetch()` (`navigation.ts`).
 *
 * Decides, from the client prefetch route manifest
 * (`__VINEXT_LINK_PREFETCH_ROUTES__`), whether a prefetched RSC payload can be
 * cached for navigation reuse or must stay a learning-only / loading-shell
 * prefetch. Lives in `shims/internal/` because `link.tsx` is a `"use client"`
 * React module while `navigation.ts` must stay importable without React —
 * mirrors the layering of `internal/app-route-detection.ts`.
 */
import type { VinextLinkPrefetchRoute } from "../../client/vinext-next-data.js";
import {
  createRouteTrieCache,
  matchRouteWithTrie,
  matchRouteWithTrieRawPathname,
} from "../../routing/route-matching.js";
import { matchRoutePatternPrefix, matchRoutePatternRaw } from "../../routing/route-pattern.js";
import { splitPathSegments } from "../../routing/utils.js";
import { stripBasePath } from "../../utils/base-path.js";

declare global {
  // Window is an ambient interface from lib.dom; interface merging is required
  // for this global browser hook.
  // oxlint-disable-next-line typescript-eslint/consistent-type-definitions
  interface Window {
    __VINEXT_LINK_PREFETCH_ROUTES__?: VinextLinkPrefetchRoute[];
  }
}

/** basePath from next.config.js, injected by the plugin at build time */
const __basePath: string = process.env.__NEXT_ROUTER_BASEPATH ?? "";

const linkPrefetchRouteTrieCache = createRouteTrieCache<VinextLinkPrefetchRoute>();
const ENCODED_PATH_DELIMITER_RE = /%(?:2f|5c)/i;

/**
 * How an App Router prefetch for a given href should behave: whether to issue
 * it at all, whether the response is reusable by a later navigation, and which
 * cache TTL family applies.
 */
export type AppRoutePrefetchPolicy = {
  cacheForNavigation: boolean;
  /**
   * How the dynamic stale-time signal affects this prefetch. Navigation data
   * takes it verbatim, explicit full prefetches fall back to the static window
   * only when it is zero, and loading shells ignore it because their contents
   * are static. "learning-only" keeps a dynamic render out of navigation reuse
   * and holds it for the static window instead.
   */
  dynamicStaleTime: "verbatim" | "full-prefetch" | "ignore" | "learning-only";
  fallbackTtl: "dynamic" | "static";
  prefetchShellFirst: boolean;
  /**
   * The route renders dynamically (`rendersDynamically`), so the prefetch
   * never renders its page: an href with search params fetches the loading
   * shell instead of the page with empty search params.
   */
  rendersDynamically?: true;
  /** Fetch the route tree before the concrete page segment. */
  requiresRouteTreePrefetch?: true;
  shouldPrefetch: boolean;
  /**
   * Fetch the Cache Components page's static shell. It's reused by a
   * navigation only when it holds the whole page; otherwise a navigation
   * shows it while the page renders.
   */
  staticShell?: true;
};

function toSameOriginRouteHref(href: string): string | null {
  if (typeof window === "undefined") return null;

  let url: URL;
  try {
    url = new URL(href, window.location.href);
  } catch {
    return null;
  }

  if (url.origin !== window.location.origin) return null;

  return `${stripBasePath(url.pathname, __basePath)}${url.search}`;
}

/** Href the manifest does not cover: no request, nothing reusable. */
const NO_APP_ROUTE_PREFETCH: AppRoutePrefetchPolicy = {
  cacheForNavigation: false,
  dynamicStaleTime: "verbatim",
  fallbackTtl: "static",
  prefetchShellFirst: false,
  shouldPrefetch: false,
};

export function canAutoPrefetchFullAppRoute(href: string): boolean {
  return resolveAutoAppRoutePrefetch(href).cacheForNavigation;
}

/**
 * Whether the page the href renders is dynamic. Under an interception context
 * that one of the route's intercepting pages matches, that page renders
 * instead, and Next.js classifies it as its own route. When several match,
 * any dynamic one counts. The intercepted response also renders the route the
 * context resolves to, which can be a dynamic descendant of the intercept's
 * source, so that route counts too.
 */
function resolveRendersDynamically(
  routes: VinextLinkPrefetchRoute[],
  route: VinextLinkPrefetchRoute,
  interceptionContext: string | null,
  pathname: string,
): boolean {
  if (interceptionContext !== null && route.intercepts) {
    // Raw segments, as the server's intercept gate matches the still-encoded
    // target and source: `/%70hotos/1` isn't `/photos/:id`, and `/%61dmin`
    // doesn't claim an `/admin` intercept.
    const pathParts = splitPathSegments(pathname);
    const contextParts = splitPathSegments(interceptionContext);
    const matching = route.intercepts.filter(
      (intercept) =>
        matchRoutePatternRaw(pathParts, intercept.targetPatternParts) !== null &&
        matchRoutePatternPrefix(contextParts, intercept.sourcePatternParts),
    );
    if (matching.length > 0) {
      return (
        matching.some((intercept) => intercept.rendersDynamically === true) ||
        matchRouteWithTrieRawPathname(interceptionContext, routes, linkPrefetchRouteTrieCache)
          ?.route.rendersDynamically === true
      );
    }
  }
  return route.rendersDynamically === true;
}

/**
 * `interceptionContext` is the prefetch's interception context
 * (`getPrefetchInterceptionContext`).
 */
export function resolveAutoAppRoutePrefetch(
  href: string,
  interceptionContext: string | null = null,
): AppRoutePrefetchPolicy {
  if (typeof window === "undefined") return NO_APP_ROUTE_PREFETCH;

  const routes = window.__VINEXT_LINK_PREFETCH_ROUTES__;
  if (!routes) return NO_APP_ROUTE_PREFETCH;

  const routeHref = toSameOriginRouteHref(href);
  if (routeHref === null) return NO_APP_ROUTE_PREFETCH;

  const match = matchRouteWithTrie(routeHref, routes, linkPrefetchRouteTrieCache);
  if (!match) return NO_APP_ROUTE_PREFETCH;

  // Export builds only emit one full-route Flight artifact per pathname; they
  // have no server that can produce loading-shell, route-tree, or per-segment
  // variants. Reuse that full payload for every matched App route prefetch.
  if (process.env.NODE_ENV === "production" && process.env.__NEXT_CONFIG_OUTPUT === "export") {
    return resolveFullAppRoutePrefetch();
  }

  const route = match.route;
  const requiresRouteTreePrefetch =
    String(process.env.__NEXT_CACHE_COMPONENTS) === "true" && route.hasRootParams === true;
  // A search-param href renders query-specific output, so its payload can only
  // ever be a shell — never reusable by a navigation to the same route.
  const routeUrl = new URL(routeHref, "http://vinext.local");
  const hasSearchParams = routeUrl.search !== "";
  // A Cache Components dynamic href with an encoded path delimiter must stay
  // in the learning-only Segment Cache. The server decodes the param while the
  // client cache key retains its encoded spelling; publishing that payload for
  // navigation reuse would make the two segment identities disagree. A
  // root-level dynamic route also stays learning-only: Next's unencoded control
  // for this case still performs a dynamic request during navigation. Ordinary
  // prefixed dynamic hrefs do not have either constraint and remain reusable.
  //
  // Next.js parity:
  // test/e2e/app-dir/segment-cache/encoded-slash-params/encoded-slash-params.test.ts
  const isFullyDynamicRootRoute =
    route.patternParts.length === 1 && route.patternParts[0]?.startsWith(":");
  const hasCacheComponentsLearningOnlyDynamicPath =
    route.isDynamic &&
    String(process.env.__NEXT_CACHE_COMPONENTS) === "true" &&
    (ENCODED_PATH_DELIMITER_RE.test(routeUrl.pathname) ||
      (isFullyDynamicRootRoute && !requiresRouteTreePrefetch));
  // Next.js's automatic prefetch of a route it renders dynamically never
  // renders the page. It stops at the nearest loading boundary below the shared
  // layout, or sends only the route tree when there is none
  // (`walkTreeWithFlightRouterState`), and keeps that for `staleTimes.static`.
  // The loading shell is vinext's equivalent. A full prefetch would render the
  // page for a payload that is only fresh for `staleTimes.dynamic` (0 by
  // default).
  const rendersDynamically = resolveRendersDynamically(
    routes,
    route,
    interceptionContext,
    routeUrl.pathname,
  );
  const isReusablePage =
    !hasSearchParams &&
    !hasCacheComponentsLearningOnlyDynamicPath &&
    (requiresRouteTreePrefetch ||
      (!route.canPrefetchLoadingShell &&
        route.requiresDynamicNavigationRequest !== true &&
        !rendersDynamically));
  // Like Next.js, a Cache Components build prefetches a page's static shell,
  // so the prefetch never renders the page's dynamic holes. An intercepted
  // page has none: it's never prerendered.
  //
  // A route that prefetches at runtime renders the prefetch with the request's
  // search params and root params, so those hrefs get one too
  // (`PrefetchHint.HasRuntimePrefetch`).
  const staticShell =
    (isReusablePage ||
      (route.instant === "runtime" && !hasCacheComponentsLearningOnlyDynamicPath)) &&
    (!requiresRouteTreePrefetch || route.instant === "runtime") &&
    interceptionContext === null &&
    process.env.NODE_ENV === "production" &&
    String(process.env.__NEXT_CACHE_COMPONENTS) === "true";
  const cacheForNavigation = isReusablePage && !staticShell;
  return {
    // Vinext does not yet have Next.js's per-segment runtime-prefetch hints.
    // Routes with loading boundaries prefetch a shell first so navigation can
    // commit loading.js immediately. Other routes that may be static can be
    // cached for navigation unless their active parallel branches must be
    // derived from the click-time target tree.
    cacheForNavigation,
    // Without Cache Components, Next.js's automatic prefetch of a route it
    // renders dynamically never carries the page (see above). A full prefetch
    // of a route that turns out dynamic while rendering, which the build can't
    // classify, is kept the same way: never reused by a navigation, and fresh
    // for the static period.
    dynamicStaleTime: !cacheForNavigation
      ? "ignore"
      : String(process.env.__NEXT_CACHE_COMPONENTS) === "true"
        ? "verbatim"
        : "learning-only",
    fallbackTtl: "static",
    prefetchShellFirst: requiresRouteTreePrefetch || hasSearchParams || !route.isDynamic,
    ...(rendersDynamically ? { rendersDynamically: true } : {}),
    ...(requiresRouteTreePrefetch ? { requiresRouteTreePrefetch: true } : {}),
    shouldPrefetch: true,
    ...(staticShell ? { staticShell: true } : {}),
  };
}

export function resolveFullAppRoutePrefetch(): AppRoutePrefetchPolicy {
  return {
    cacheForNavigation: true,
    dynamicStaleTime: "full-prefetch",
    fallbackTtl: "static",
    prefetchShellFirst: true,
    shouldPrefetch: true,
  };
}
