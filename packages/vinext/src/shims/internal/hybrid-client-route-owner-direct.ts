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
import { hashRoutePathname } from "../../routing/hashed-route-patterns.js";
import { createRouteTrieCache, matchRouteWithTrie } from "../../routing/route-matching.js";
import { compareHybridRoutePatterns } from "../../routing/utils.js";
import { stripBasePath } from "../../utils/base-path.js";
import { getLocalePathPrefix } from "../../utils/domain-locale.js";

export type HybridClientOwner = "app" | "document" | "pages";

type HybridClientRouteMatches = {
  appMatch: VinextLinkPrefetchRoute | null;
  /** A Pages Router URL under `/api`, which only API routes serve. */
  pagesApiRequest: boolean;
  pagesMatch: VinextPagesLinkPrefetchRoute | null;
};

declare global {
  // oxlint-disable-next-line typescript-eslint/consistent-type-definitions
  interface Window {
    __VINEXT_APP_ROUTE_HANDLERS__?: VinextLinkPrefetchRoute[];
    __VINEXT_LINK_PREFETCH_ROUTES__?: VinextLinkPrefetchRoute[];
    __VINEXT_PAGES_LINK_PREFETCH_ROUTES__?: VinextPagesLinkPrefetchRoute[];
  }
}

const appRouteTrieCache = createRouteTrieCache<VinextLinkPrefetchRoute>();
const appRouteHandlerTrieCache = createRouteTrieCache<VinextLinkPrefetchRoute>();
const pagesRouteTrieCache = createRouteTrieCache<VinextPagesLinkPrefetchRoute>();

function patternFromParts(parts: readonly string[]): string {
  return "/" + parts.join("/");
}

function resolveSameOriginPathnames(
  href: string,
  basePath: string,
): { appPathname: string; pagesApiRequest: boolean; pagesPathname: string } | null {
  if (typeof window === "undefined") return null;
  let url: URL;
  try {
    url = new URL(href, window.location.href);
  } catch {
    return null;
  }
  if (url.origin !== window.location.origin) return null;
  const appPathname = stripBasePath(url.pathname, basePath);
  const locale = getLocalePathPrefix(appPathname, window.__VINEXT_LOCALES__);
  const localePrefixLength = locale ? locale.length + 1 : 0;
  const pagesPathname = !locale
    ? appPathname
    : appPathname.length === localePrefixLength
      ? "/"
      : appPathname.slice(localePrefixLength);
  return {
    appPathname,
    pagesApiRequest: appPathname === "/api" || appPathname.startsWith("/api/"),
    pagesPathname,
  };
}

export function resolveSameOriginAppPathname(href: string, basePath: string): string | null {
  return resolveSameOriginPathnames(href, basePath)?.appPathname ?? null;
}

function patternPartRank(part: string | undefined): number {
  if (part === undefined) return 0;
  if (!part.startsWith(":")) return 1;
  if (part.endsWith("+")) return 3;
  if (part.endsWith("*")) return 4;
  return 2;
}

/**
 * The route the App router picks when both match the same URL: the first part
 * whose kind differs decides, static > dynamic > catch-all > optional
 * catch-all, as in `routing/route-trie.ts`.
 */
function preferredAppRoute(
  page: VinextLinkPrefetchRoute | null,
  handler: VinextLinkPrefetchRoute | null,
): VinextLinkPrefetchRoute | null {
  if (page === null || handler === null) return page ?? handler;
  const length = Math.max(page.patternParts.length, handler.patternParts.length);
  for (let index = 0; index < length; index++) {
    const pageRank = patternPartRank(page.patternParts[index]);
    const handlerRank = patternPartRank(handler.patternParts[index]);
    if (pageRank !== handlerRank) return pageRank < handlerRank ? page : handler;
  }
  return page;
}

export function matchDirectHybridClientRoutes(
  href: string,
  basePath: string,
): HybridClientRouteMatches {
  const pathnames = resolveSameOriginPathnames(href, basePath);
  if (pathnames === null) return { appMatch: null, pagesApiRequest: false, pagesMatch: null };

  const appRoutes = window.__VINEXT_LINK_PREFETCH_ROUTES__;
  const appRouteHandlers = window.__VINEXT_APP_ROUTE_HANDLERS__;
  const pagesRoutes = window.__VINEXT_PAGES_LINK_PREFETCH_ROUTES__;
  return {
    appMatch: preferredAppRoute(
      appRoutes
        ? (matchRouteWithTrie(pathnames.appPathname, appRoutes, appRouteTrieCache)?.route ?? null)
        : null,
      appRouteHandlers?.length
        ? (matchRouteWithTrie(
            hashRoutePathname(pathnames.appPathname),
            appRouteHandlers,
            appRouteHandlerTrieCache,
          )?.route ?? null)
        : null,
    ),
    pagesApiRequest: pathnames.pagesApiRequest,
    pagesMatch:
      pagesRoutes && !pathnames.pagesApiRequest
        ? (matchRouteWithTrie(pathnames.pagesPathname, pagesRoutes, pagesRouteTrieCache)?.route ??
          null)
        : null,
  };
}

export function resolveMatchedHybridClientRouteOwner({
  appMatch,
  pagesApiRequest,
  pagesMatch,
}: HybridClientRouteMatches): HybridClientOwner | null {
  // The client gets no Pages API route list. Pages serves nothing but API
  // routes under /api, and only a static App route outranks every one of them,
  // so any other owner is left to the document request.
  if (pagesApiRequest) {
    return appMatch?.isDynamic === false && !appMatch.documentOnly ? "app" : "document";
  }
  if (appMatch === null && pagesMatch === null) return null;
  if (pagesMatch === null) return appMatch!.documentOnly ? "document" : "app";
  if (appMatch === null) return "pages";

  const owner = compareHybridRoutePatterns(
    patternFromParts(pagesMatch.patternParts),
    pagesMatch.isDynamic,
    patternFromParts(appMatch.patternParts),
    appMatch.isDynamic,
  );
  return owner === "app" && appMatch.documentOnly ? "document" : owner;
}

export function resolveDirectHybridClientRouteOwner(
  href: string,
  basePath: string,
): HybridClientOwner | null {
  if (typeof window === "undefined") return null;
  return resolveMatchedHybridClientRouteOwner(matchDirectHybridClientRoutes(href, basePath));
}
