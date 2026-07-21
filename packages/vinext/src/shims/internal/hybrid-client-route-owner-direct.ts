/**
 * Lightweight client-side App/Pages route ownership matching.
 *
 * This module intentionally handles only direct manifest matches. Rewrite
 * evaluation lives in `hybrid-client-route-owner.ts` so clients without
 * rewrites do not eagerly load the config matcher runtime.
 */
import type {
  VinextLinkPrefetchRoute,
  VinextPagesLinkPrefetchRoute,
} from "../../client/vinext-next-data.js";
import { createRouteTrieCache, matchRouteWithTrie } from "../../routing/route-matching.js";
import { compareHybridRoutePatterns } from "../../routing/utils.js";
import { stripBasePath } from "../../utils/base-path.js";
import { getLocalePathPrefix } from "../../utils/domain-locale.js";

export type HybridClientOwner = "app" | "document" | "pages";

type HybridClientRouteMatches = {
  appMatch: VinextLinkPrefetchRoute | null;
  pagesMatch: VinextPagesLinkPrefetchRoute | null;
};

declare global {
  // oxlint-disable-next-line typescript-eslint/consistent-type-definitions
  interface Window {
    __VINEXT_LINK_PREFETCH_ROUTES__?: VinextLinkPrefetchRoute[];
    __VINEXT_PAGES_LINK_PREFETCH_ROUTES__?: VinextPagesLinkPrefetchRoute[];
  }
}

const appRouteTrieCache = createRouteTrieCache<VinextLinkPrefetchRoute>();
const pagesRouteTrieCache = createRouteTrieCache<VinextPagesLinkPrefetchRoute>();

function patternFromParts(parts: readonly string[]): string {
  return "/" + parts.join("/");
}

export function resolveSameOriginPathname(href: string, basePath: string): string | null {
  if (typeof window === "undefined") return null;
  let url: URL;
  try {
    url = new URL(href, window.location.href);
  } catch {
    return null;
  }
  if (url.origin !== window.location.origin) return null;
  const pathname = stripBasePath(url.pathname, basePath);
  const locale = getLocalePathPrefix(pathname, window.__VINEXT_LOCALES__);
  if (!locale) return pathname;
  const localePrefixLength = locale.length + 1;
  return pathname.length === localePrefixLength ? "/" : pathname.slice(localePrefixLength);
}

export function matchDirectHybridClientRoutes(
  href: string,
  basePath: string,
): HybridClientRouteMatches {
  const pathname = resolveSameOriginPathname(href, basePath);
  if (pathname === null) return { appMatch: null, pagesMatch: null };

  const appRoutes = window.__VINEXT_LINK_PREFETCH_ROUTES__;
  const pagesRoutes = window.__VINEXT_PAGES_LINK_PREFETCH_ROUTES__;
  return {
    appMatch: appRoutes
      ? (matchRouteWithTrie(pathname, appRoutes, appRouteTrieCache)?.route ?? null)
      : null,
    pagesMatch: pagesRoutes
      ? (matchRouteWithTrie(pathname, pagesRoutes, pagesRouteTrieCache)?.route ?? null)
      : null,
  };
}

export function resolveMatchedHybridClientRouteOwner({
  appMatch,
  pagesMatch,
}: HybridClientRouteMatches): HybridClientOwner | null {
  if (appMatch === null && pagesMatch === null) return null;
  if (pagesMatch === null) return appMatch!.documentOnly ? "document" : "app";
  if (appMatch === null) return pagesMatch.documentOnly ? "document" : "pages";

  const owner = compareHybridRoutePatterns(
    patternFromParts(pagesMatch.patternParts),
    pagesMatch.isDynamic,
    patternFromParts(appMatch.patternParts),
    appMatch.isDynamic,
  );
  const winningRoute = owner === "app" ? appMatch : pagesMatch;
  return winningRoute.documentOnly ? "document" : owner;
}

export function resolveDirectHybridClientRouteOwner(
  href: string,
  basePath: string,
): HybridClientOwner | null {
  if (typeof window === "undefined") return null;
  return resolveMatchedHybridClientRouteOwner(matchDirectHybridClientRoutes(href, basePath));
}
