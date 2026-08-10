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
import { createRouteTrieCache, matchRouteWithTrie } from "../../routing/route-matching.js";
import { normalizePathnameForRouteMatch } from "../../routing/utils.js";
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
let partialPrerenderPathsPromise: Promise<ReadonlySet<string>> | undefined;

async function loadPartialPrerenderPaths(): Promise<ReadonlySet<string>> {
  partialPrerenderPathsPromise ??= fetch(`${__basePath}/__vinext/prefetch-policy`, {
    credentials: "same-origin",
  })
    .then(async (response) => {
      if (!response.ok) return new Set<string>();
      const payload: unknown = await response.json();
      if (
        typeof payload !== "object" ||
        payload === null ||
        !("partialPrerenderPaths" in payload) ||
        !Array.isArray(payload.partialPrerenderPaths)
      ) {
        return new Set<string>();
      }
      return new Set(
        payload.partialPrerenderPaths.filter(
          (pathname): pathname is string => typeof pathname === "string",
        ),
      );
    })
    .catch(() => new Set<string>());
  return partialPrerenderPathsPromise;
}

export async function hasPartialPrerenderForRoute(href: string): Promise<boolean> {
  const routeHref = toSameOriginRouteHref(href);
  if (routeHref === null) return false;
  const pathname = normalizePathnameForRouteMatch(
    new URL(routeHref, "http://vinext.local").pathname,
  );
  return (await loadPartialPrerenderPaths()).has(pathname);
}

/**
 * How an App Router prefetch for a given href should behave: whether to issue
 * it at all, whether the response is reusable by a later navigation, and which
 * cache TTL family applies.
 */
export type AppRoutePrefetchPolicy = {
  cacheForNavigation: boolean;
  fallbackTtl: "dynamic" | "static";
  /**
   * Whether a dynamic render's stale-time bound applies verbatim, including
   * below the 30s prefetch floor. Automatic prefetches take it verbatim, so a
   * dynamic `0` is never reused. `prefetch={true}` opts into caching dynamic
   * content and keeps the floored static window, mirroring Next's split
   * between `auto` and `full` in `getPrefetchEntryCacheStatus`.
   */
  honorDynamicStaleTime: boolean;
  prefetchShellFirst: boolean;
  shouldPrefetch: boolean;
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
  fallbackTtl: "static",
  honorDynamicStaleTime: true,
  prefetchShellFirst: false,
  shouldPrefetch: false,
};

export function canAutoPrefetchFullAppRoute(href: string): boolean {
  return resolveAutoAppRoutePrefetch(href).cacheForNavigation;
}

export function resolveAutoAppRoutePrefetch(href: string): AppRoutePrefetchPolicy {
  if (typeof window === "undefined") return NO_APP_ROUTE_PREFETCH;

  const routes = window.__VINEXT_LINK_PREFETCH_ROUTES__;
  if (!routes) return NO_APP_ROUTE_PREFETCH;

  const routeHref = toSameOriginRouteHref(href);
  if (routeHref === null) return NO_APP_ROUTE_PREFETCH;

  const match = matchRouteWithTrie(routeHref, routes, linkPrefetchRouteTrieCache);
  if (!match) return NO_APP_ROUTE_PREFETCH;

  const route = match.route;
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
    (isFullyDynamicRootRoute || ENCODED_PATH_DELIMITER_RE.test(routeUrl.pathname));
  return {
    // Vinext does not yet have Next.js's per-segment runtime-prefetch hints.
    // Routes with loading boundaries prefetch a shell first so navigation can
    // commit loading.js immediately. Dynamic routes without loading-shell
    // fallbacks can be cached for navigation unless their active parallel
    // branches must be derived from the click-time target tree.
    cacheForNavigation:
      !hasSearchParams &&
      !route.canPrefetchLoadingShell &&
      !hasCacheComponentsLearningOnlyDynamicPath &&
      route.requiresDynamicNavigationRequest !== true,
    fallbackTtl: "static",
    honorDynamicStaleTime: true,
    prefetchShellFirst: hasSearchParams || !route.isDynamic,
    shouldPrefetch: true,
  };
}

export function resolveFullAppRoutePrefetch(): AppRoutePrefetchPolicy {
  return {
    cacheForNavigation: true,
    fallbackTtl: "static",
    honorDynamicStaleTime: false,
    prefetchShellFirst: true,
    shouldPrefetch: true,
  };
}
