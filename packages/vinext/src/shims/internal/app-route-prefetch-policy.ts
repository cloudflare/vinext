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
import type {
  VinextLinkPrefetchRoute,
  VinextPrefetchVaryMetadata,
} from "../../client/vinext-next-data.js";
import { createRouteTrieCache, matchRouteWithTrie } from "../../routing/route-matching.js";
import { matchRoutePattern } from "../../routing/route-pattern.js";
import { splitPathnameForRouteMatch } from "../../routing/utils.js";
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

export function isAppPrefetchVaryEnabled(): boolean {
  if (
    typeof window !== "undefined" &&
    typeof window.__VINEXT_PREFETCH_VARY_ENABLED__ === "boolean"
  ) {
    return window.__VINEXT_PREFETCH_VARY_ENABLED__;
  }
  const enabled = (value: unknown) => value === true || value === "true";
  return (
    enabled(process.env.__NEXT_CACHE_COMPONENTS) &&
    enabled(process.env.__VINEXT_VARY_PARAMS) &&
    enabled(process.env.__VINEXT_OPTIMISTIC_ROUTING)
  );
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
  /** Render only the nearest loading boundary instead of the route's prefetchable body. */
  renderLoadingShell: boolean;
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
  renderLoadingShell: false,
  shouldPrefetch: false,
};

function encodePrefetchParamValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value.map(encodeURIComponent).join("/");
  return encodeURIComponent(value ?? "");
}

function mergeVaryParamNames(
  current: readonly string[] | undefined,
  observed: readonly string[],
): string[] | undefined {
  if (current === undefined && observed.length === 0) return undefined;
  return Array.from(new Set([...(current ?? []), ...observed])).sort();
}

function getAllRouteParamNames(route: VinextLinkPrefetchRoute): string[] {
  const names = new Set<string>();
  for (const part of route.patternParts) {
    if (!part.startsWith(":")) continue;
    names.add(part.replace(/^:/, "").replace(/[+*]$/, ""));
  }
  for (const slot of route.slotParamPatterns ?? []) {
    for (const name of slot.paramNames) names.add(name);
  }
  return [...names];
}

function resolvePrefetchSlotVaryKey(
  url: URL,
  route: VinextLinkPrefetchRoute,
  varyParams: ReadonlySet<string>,
  routeParamNames: ReadonlySet<string>,
): string {
  const pathname = stripBasePath(url.pathname, __basePath) || "/";
  const conservativePathIdentity = `!${encodeURIComponent(pathname)}`;
  const urlParts = splitPathnameForRouteMatch(pathname);
  const coveredNames = new Set<string>();
  const entries: string[] = [];
  for (const [index, slotPattern] of (route.slotParamPatterns ?? []).entries()) {
    const matched = matchRoutePattern(urlParts, slotPattern.patternParts);
    for (const name of slotPattern.paramNames) {
      if (!varyParams.has(name)) continue;
      coveredNames.add(name);
      const value = matched?.[name];
      entries.push(
        `${index}:${encodeURIComponent(name)}=${value === undefined ? conservativePathIdentity : encodePrefetchParamValue(value)}`,
      );
    }
  }
  for (const name of [...varyParams].sort()) {
    if (routeParamNames.has(name) || coveredNames.has(name)) continue;
    entries.push(`?:${encodeURIComponent(name)}=${conservativePathIdentity}`);
  }
  return entries.join("&");
}

/**
 * Teach the client route manifest the dependency set observed by a completed
 * server prefetch render. Observations are monotonic: a later conditional
 * render can add a dependency but can never make an earlier dependency safe to
 * forget.
 */
export function learnAppPrefetchVaryMetadata(
  href: string,
  metadata: VinextPrefetchVaryMetadata,
): void {
  if (!isAppPrefetchVaryEnabled() || typeof window === "undefined") return;
  const routes = window.__VINEXT_LINK_PREFETCH_ROUTES__;
  if (!routes) return;

  let url: URL;
  try {
    url = new URL(href, window.location.href);
  } catch {
    return;
  }
  if (url.origin !== window.location.origin) return;

  const routeHref = `${stripBasePath(url.pathname, __basePath)}${url.search}`;
  const match = matchRouteWithTrie(routeHref, routes, linkPrefetchRouteTrieCache);
  if (!match) return;

  const route = match.route;
  const conservativeParamNames = metadata.varyAllParams ? getAllRouteParamNames(route) : [];
  route.loadingShellVaryParamNames = mergeVaryParamNames(route.loadingShellVaryParamNames, [
    ...metadata.loadingParamNames,
    ...conservativeParamNames,
  ]);
  route.metadataVaryParamNames = mergeVaryParamNames(route.metadataVaryParamNames, [
    ...metadata.metadataParamNames,
    ...conservativeParamNames,
  ]);
  route.prefetchVaryParamNames = mergeVaryParamNames(route.prefetchVaryParamNames, [
    ...metadata.pageParamNames,
    ...conservativeParamNames,
  ]);
  route.runtimePrefetchVaryParamNames = mergeVaryParamNames(route.runtimePrefetchVaryParamNames, [
    ...metadata.pageParamNames,
    ...conservativeParamNames,
  ]);
  route.prefetchVarySearchParams ||= metadata.pageSearchParams;
  route.loadingShellVarySearchParams ||= metadata.metadataSearchParams;
  route.metadataVarySearchParams ||= metadata.metadataSearchParams;
  route.runtimePrefetchVarySearchParams ||=
    metadata.pageSearchParams || metadata.metadataSearchParams;
}

/**
 * Resolve the route-pattern cache identity for a prefetch segment. Only params
 * observed before a runtime boundary contribute values; all others remain
 * pattern placeholders and can share a cached prefetch across concrete URLs.
 */
export function resolveAppPrefetchSharedCacheKey(
  href: string,
  kind: "loading-shell" | "metadata" | "navigation" | "runtime",
): string | null {
  if (!isAppPrefetchVaryEnabled()) return null;
  if (typeof window === "undefined") return null;
  const routes = window.__VINEXT_LINK_PREFETCH_ROUTES__;
  if (!routes) return null;

  let url: URL;
  try {
    url = new URL(href, window.location.href);
  } catch {
    return null;
  }
  if (url.origin !== window.location.origin) return null;

  const routeHref = `${stripBasePath(url.pathname, __basePath)}${url.search}`;
  const match = matchRouteWithTrie(routeHref, routes, linkPrefetchRouteTrieCache);
  if (!match) return null;

  const route = match.route;
  const varyParamNames =
    kind === "loading-shell"
      ? route.loadingShellVaryParamNames
      : kind === "metadata"
        ? route.metadataVaryParamNames
        : kind === "runtime"
          ? route.runtimePrefetchVaryParamNames
          : route.prefetchVaryParamNames;
  const varyParams = new Set(varyParamNames ?? []);
  const routeParamNames = new Set<string>();
  const keyParts = route.patternParts.map((part) => {
    if (!part.startsWith(":")) return part;
    const name = part.replace(/^:/, "").replace(/[+*]$/, "");
    routeParamNames.add(name);
    return varyParams.has(name) ? encodePrefetchParamValue(match.params[name]) : `:${name}`;
  });
  const slotVaryKey = resolvePrefetchSlotVaryKey(url, route, varyParams, routeParamNames);
  const search =
    kind === "loading-shell" && route.loadingShellVarySearchParams === true
      ? url.search
      : kind === "metadata" && route.metadataVarySearchParams === true
        ? url.search
        : kind === "runtime" && route.runtimePrefetchVarySearchParams === true
          ? url.search
          : kind === "navigation" && route.prefetchVarySearchParams === true
            ? url.search
            : "";
  return `${route.patternParts.join("/")}\0${keyParts.join("/")}${slotVaryKey ? `\0${slotVaryKey}` : ""}${search}`;
}

/** Encode the runtime and loading-shell identities without separator ambiguity. */
export function encodeAppPrefetchRuntimeTemplateVariantKey(
  runtimeSharedCacheKey: string,
  loadingShellSharedCacheKey: string | null,
): string {
  return JSON.stringify([runtimeSharedCacheKey, loadingShellSharedCacheKey ?? ""]);
}

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
  if (isAppPrefetchVaryEnabled() && route.canPrefetchRuntimeShell) {
    return {
      cacheForNavigation: false,
      fallbackTtl: "static",
      // The response's dynamic tail is discarded when learning the optimistic
      // template, so a dynamic stale-time of zero must not expire the shell.
      honorDynamicStaleTime: false,
      prefetchShellFirst: false,
      renderLoadingShell: false,
      shouldPrefetch: true,
    };
  }
  if (isAppPrefetchVaryEnabled() && route.canPrefetchStaticRoute) {
    const requiresDynamicNavigationRequest =
      route.requiresDynamicNavigationRequest === true ||
      (route.isDynamic &&
        route.canPrefetchLoadingShell &&
        route.canPrefetchFullStaticRoute !== true);
    return {
      cacheForNavigation: !requiresDynamicNavigationRequest,
      fallbackTtl: "static",
      honorDynamicStaleTime: false,
      prefetchShellFirst: false,
      renderLoadingShell: requiresDynamicNavigationRequest,
      shouldPrefetch: true,
    };
  }
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
    renderLoadingShell:
      hasSearchParams ||
      hasCacheComponentsLearningOnlyDynamicPath ||
      route.canPrefetchLoadingShell ||
      route.requiresDynamicNavigationRequest === true,
    shouldPrefetch: true,
  };
}

export function resolveFullAppRoutePrefetch(): AppRoutePrefetchPolicy {
  return {
    cacheForNavigation: true,
    fallbackTtl: "static",
    honorDynamicStaleTime: false,
    prefetchShellFirst: true,
    renderLoadingShell: false,
    shouldPrefetch: true,
  };
}
