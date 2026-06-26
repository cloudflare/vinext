import type { VinextLinkPrefetchRoute } from "./vinext-next-data.js";
import { createRouteTrieCache, matchRouteWithTrie } from "../routing/route-matching.js";
import { stripBasePath } from "../utils/base-path.js";

export type AppRoutePrefetchPolicy = {
  cacheForNavigation: boolean;
  prefetchInstantShell: boolean;
  prefetchShellFirst: boolean;
  prefetchSuspenseShell: boolean;
  shouldPrefetch: boolean;
};

const routeTrieCache = createRouteTrieCache<VinextLinkPrefetchRoute>();
const unavailablePolicy: AppRoutePrefetchPolicy = {
  cacheForNavigation: false,
  prefetchInstantShell: false,
  prefetchShellFirst: false,
  prefetchSuspenseShell: false,
  shouldPrefetch: false,
};

export function resolveAppRoutePrefetchPolicy(options: {
  basePath: string;
  currentHref: string;
  href: string;
  routes: VinextLinkPrefetchRoute[] | undefined;
}): AppRoutePrefetchPolicy {
  if (!options.routes) return unavailablePolicy;

  let url: URL;
  let currentUrl: URL;
  try {
    currentUrl = new URL(options.currentHref);
    url = new URL(options.href, currentUrl);
  } catch {
    return unavailablePolicy;
  }
  if (url.origin !== currentUrl.origin) return unavailablePolicy;

  const routeHref = `${stripBasePath(url.pathname, options.basePath)}${url.search}`;
  const match = matchRouteWithTrie(routeHref, options.routes, routeTrieCache);
  if (!match) return unavailablePolicy;

  const route = match.route;
  const hasLoadingShell = route.canPrefetchLoadingShell;
  if (route.hasInstant) {
    return {
      cacheForNavigation: true,
      prefetchInstantShell: true,
      prefetchSuspenseShell: true,
      prefetchShellFirst: false,
      shouldPrefetch: true,
    };
  }

  return {
    cacheForNavigation: !hasLoadingShell,
    prefetchInstantShell: false,
    prefetchSuspenseShell: route.isDynamic && !hasLoadingShell,
    prefetchShellFirst: !route.isDynamic,
    shouldPrefetch: true,
  };
}
