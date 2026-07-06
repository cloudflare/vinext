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
import type { NextRewrite } from "../../config/next-config.js";
import { createRouteTrieCache, matchRouteWithTrie } from "../../routing/route-matching.js";
import { compareHybridRoutePatterns } from "../../routing/utils.js";
import { stripBasePath } from "../../utils/base-path.js";
import { getLocalePathPrefix } from "../../utils/domain-locale.js";

export type HybridClientOwner = "app" | "document" | "pages";

type HybridClientRouteMatches = {
  appMatch: VinextLinkPrefetchRoute | null;
  pagesMatch: VinextPagesLinkPrefetchRoute | null;
};

export type HybridClientRouteOwnerPrecheck =
  | { kind: "needsRewriteEvaluation" }
  | { kind: "resolved"; owner: HybridClientOwner | null };

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

function hasRewriteRules(rewrites: Window["__VINEXT_CLIENT_REWRITES__"]): boolean {
  return (
    rewrites !== undefined &&
    (rewrites.beforeFiles.length > 0 ||
      rewrites.afterFiles.length > 0 ||
      rewrites.fallback.length > 0)
  );
}

function splitPathname(pathname: string): string[] {
  return pathname.replace(/\/+$/, "").split("/").filter(Boolean);
}

function segmentCanBeMatchedStatically(patternSegment: string): boolean {
  return !/[():*+?{}[\]\\]/.test(patternSegment) && !patternSegment.includes(":");
}

function rewriteSourceMayMatchPathname(source: string, pathname: string): boolean {
  if (!source.startsWith("/") || source.includes("?") || source.includes("#")) return true;

  const patternSegments = splitPathname(source);
  const pathnameSegments = splitPathname(pathname);

  for (let patternIndex = 0, pathnameIndex = 0; ; patternIndex++, pathnameIndex++) {
    const patternSegment = patternSegments[patternIndex];
    const pathnameSegment = pathnameSegments[pathnameIndex];

    if (patternSegment === undefined) {
      return pathnameSegment === undefined;
    }

    if (patternSegment.startsWith(":")) {
      const match = /^:[A-Za-z][A-Za-z0-9_-]*([+*])?$/.exec(patternSegment);
      if (!match) return true;

      const modifier = match[1];
      if (modifier === "*") return true;
      if (modifier === "+") return pathnameSegment !== undefined;
      if (pathnameSegment === undefined) return false;
      continue;
    }

    if (!segmentCanBeMatchedStatically(patternSegment)) return true;
    if (pathnameSegment !== patternSegment) return false;
  }
}

function hasPotentialRewriteMatch(
  href: string,
  basePath: string,
  rewrites: readonly NextRewrite[],
): boolean {
  if (rewrites.length === 0) return false;
  const pathname = resolveSameOriginPathname(href, basePath);
  if (pathname === null) return false;
  return rewrites.some((rewrite) => rewriteSourceMayMatchPathname(rewrite.source, pathname));
}

export function hasPotentialHybridClientRewrite(href: string, basePath: string): boolean {
  if (typeof window === "undefined") return false;

  const rewrites = window.__VINEXT_CLIENT_REWRITES__;
  if (rewrites === undefined || !hasRewriteRules(rewrites)) return false;

  if (hasPotentialRewriteMatch(href, basePath, rewrites.beforeFiles)) return true;

  const matches = matchDirectHybridClientRoutes(href, basePath);
  if (
    (matches.appMatch === null || matches.appMatch.isDynamic) &&
    (matches.pagesMatch === null || matches.pagesMatch.isDynamic) &&
    hasPotentialRewriteMatch(href, basePath, rewrites.afterFiles)
  ) {
    return true;
  }

  return (
    matches.appMatch === null &&
    matches.pagesMatch === null &&
    hasPotentialRewriteMatch(href, basePath, rewrites.fallback)
  );
}

export function resolveHybridClientRouteOwnerPrecheck(
  href: string,
  basePath: string,
): HybridClientRouteOwnerPrecheck {
  if (hasPotentialHybridClientRewrite(href, basePath)) {
    return { kind: "needsRewriteEvaluation" };
  }
  return {
    kind: "resolved",
    owner:
      typeof window === "undefined"
        ? null
        : resolveMatchedHybridClientRouteOwner(matchDirectHybridClientRoutes(href, basePath)),
  };
}
