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
  /** Render a runtime `unstable_instant` shell that preserves completed Suspense branches. */
  prefetchInstantShell?: true;
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

function resolveMatchedAppRoute(href: string): VinextLinkPrefetchRoute | null {
  if (typeof window === "undefined") return null;
  const routes = window.__VINEXT_LINK_PREFETCH_ROUTES__;
  if (!routes) return null;
  const routeHref = toSameOriginRouteHref(href);
  if (routeHref === null) return null;
  return matchRouteWithTrie(routeHref, routes, linkPrefetchRouteTrieCache)?.route ?? null;
}

function runtimeInstantPolicy(): AppRoutePrefetchPolicy {
  return {
    // The response is a partial Suspense shell. It teaches optimistic routing
    // what can commit immediately, while the click still issues the complete
    // navigation request for blocked dynamic branches.
    cacheForNavigation: false,
    fallbackTtl: "dynamic",
    honorDynamicStaleTime: true,
    prefetchInstantShell: true,
    prefetchShellFirst: false,
    shouldPrefetch: true,
  };
}

export function canAutoPrefetchFullAppRoute(href: string): boolean {
  return resolveAutoAppRoutePrefetch(href).cacheForNavigation;
}

export function resolveAutoAppRoutePrefetch(href: string): AppRoutePrefetchPolicy {
  const routeHref = toSameOriginRouteHref(href);
  if (routeHref === null) return NO_APP_ROUTE_PREFETCH;
  const route = resolveMatchedAppRoute(href);
  if (!route) return NO_APP_ROUTE_PREFETCH;
  if (route.hasRuntimeInstant) return runtimeInstantPolicy();
  // A search-param href renders query-specific output, so its payload can only
  // ever be a shell — never reusable by a navigation to the same route.
  const hasSearchParams = new URL(routeHref, "http://vinext.local").search !== "";
  return {
    // Vinext does not yet have Next.js's per-segment runtime-prefetch hints.
    // Routes with loading boundaries prefetch a shell first so navigation can
    // commit loading.js immediately. Dynamic routes without loading-shell
    // fallbacks can be cached for navigation unless their active parallel
    // branches must be derived from the click-time target tree.
    cacheForNavigation:
      !hasSearchParams &&
      !route.canPrefetchLoadingShell &&
      route.requiresDynamicNavigationRequest !== true,
    fallbackTtl: "static",
    honorDynamicStaleTime: true,
    prefetchShellFirst: hasSearchParams || !route.isDynamic,
    shouldPrefetch: true,
  };
}

export function resolveFullAppRoutePrefetch(href: string): AppRoutePrefetchPolicy {
  if (resolveMatchedAppRoute(href)?.hasRuntimeInstant) return runtimeInstantPolicy();
  return {
    cacheForNavigation: true,
    fallbackTtl: "static",
    honorDynamicStaleTime: false,
    prefetchShellFirst: true,
    shouldPrefetch: true,
  };
}
