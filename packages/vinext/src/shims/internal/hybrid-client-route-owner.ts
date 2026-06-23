/**
 * Client-side resolver that decides whether a URL should be soft-navigated
 * (App Router / RSC) or hard-navigated (Pages Router / document). Delegates
 * the owner decision to `compareHybridRoutePatterns` in `routing/utils.ts`
 * so the server and the client reach the same answer for the same
 * (pages pattern, app pattern) pair.
 *
 * Lives in `shims/internal/` because both `link.tsx` and the App Router
 * browser entry import it without pulling in the server route graph.
 *
 * The App + Pages route manifests are emitted once per page load by the
 * Vite plugin onto the matching `__VINEXT_*_PREFETCH_ROUTES__` window
 * globals (see `entries/app-browser-entry.ts` and
 * `entries/pages-client-entry.ts`). Hybrid builds expose both globals; a
 * single-router build only sets its own.
 */
import { createRouteTrieCache, matchRouteWithTrie } from "../../routing/route-matching.js";
import { compareHybridRoutePatterns } from "../../routing/utils.js";
import {
  isExternalUrl,
  matchRewrite,
  parseCookies,
  type RequestContext,
} from "../../config/config-matchers.js";
import type { NextRewrite } from "../../config/next-config.js";
import { stripBasePath } from "../../utils/base-path.js";
import { getLocalePathPrefix } from "../../utils/domain-locale.js";
import { mergeRewriteQuery } from "../../utils/query.js";
import type {
  VinextLinkPrefetchRoute,
  VinextPagesLinkPrefetchRoute,
} from "../../client/vinext-next-data.js";

export type HybridClientOwner = "app" | "document" | "pages";

declare global {
  // oxlint-disable-next-line typescript-eslint/consistent-type-definitions
  interface Window {
    __VINEXT_LINK_PREFETCH_ROUTES__?: VinextLinkPrefetchRoute[];
    __VINEXT_PAGES_LINK_PREFETCH_ROUTES__?: VinextPagesLinkPrefetchRoute[];
    __VINEXT_CLIENT_REWRITES__?: {
      afterFiles: NextRewrite[];
      beforeFiles: NextRewrite[];
      fallback: NextRewrite[];
    };
  }
}

function resolveClientRewrite(
  href: string,
  basePath: string,
  rewrites: readonly NextRewrite[],
  continueAfterMatch = false,
): { kind: "document" } | { href: string; kind: "rewrite" } | null {
  const initialUrl = new URL(href, window.location.href);
  const basePathState = {
    basePath,
    hadBasePath: basePath
      ? initialUrl.pathname === basePath || initialUrl.pathname.startsWith(`${basePath}/`)
      : true,
  };
  let currentHref = href;
  let matched = false;

  for (const rewrite of rewrites) {
    const pathname = resolveSameOriginPathname(currentHref, basePath);
    if (pathname === null) return null;
    const url = new URL(currentHref, window.location.href);
    const headers = new Headers({ "user-agent": globalThis.navigator?.userAgent ?? "" });
    const context: RequestContext = {
      cookies: parseCookies(globalThis.document?.cookie ?? ""),
      headers,
      host: url.hostname,
      query: url.searchParams,
    };
    const rewritten = matchRewrite(pathname, [rewrite], context, basePathState);
    if (rewritten === null) continue;
    if (isExternalUrl(rewritten)) return { kind: "document" };
    currentHref = mergeRewriteQuery(currentHref, rewritten);
    matched = true;
    if (!continueAfterMatch) break;
  }

  return matched ? { href: currentHref, kind: "rewrite" } : null;
}

const appRouteTrieCache = createRouteTrieCache<VinextLinkPrefetchRoute>();
const pagesRouteTrieCache = createRouteTrieCache<VinextPagesLinkPrefetchRoute>();

/**
 * Build a `/`-joined pattern from a manifest's `patternParts`. Mirrors the
 * server-side route-graph shape (`{ pattern: string }`) so the
 * `compareHybridRoutePatterns` segment-rank comparator can score both Pages
 * and App patterns. The
 * `patternParts` array never includes an empty string for the static `/`
 * route (the App catch-all handles the bare path), so the simple join is
 * safe for everything the route trie actually matches.
 */
function patternFromParts(parts: readonly string[]): string {
  return "/" + parts.join("/");
}

function resolveSameOriginPathname(href: string, basePath: string): string | null {
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

function matchAppRoute(
  href: string,
  basePath: string,
  routes: readonly VinextLinkPrefetchRoute[],
): VinextLinkPrefetchRoute | null {
  const pathname = resolveSameOriginPathname(href, basePath);
  if (pathname === null) return null;
  return (
    matchRouteWithTrie(pathname, routes as VinextLinkPrefetchRoute[], appRouteTrieCache)?.route ??
    null
  );
}

function matchPagesRoute(
  href: string,
  basePath: string,
  routes: readonly VinextPagesLinkPrefetchRoute[],
): VinextPagesLinkPrefetchRoute | null {
  const pathname = resolveSameOriginPathname(href, basePath);
  if (pathname === null) return null;
  return (
    matchRouteWithTrie(pathname, routes as VinextPagesLinkPrefetchRoute[], pagesRouteTrieCache)
      ?.route ?? null
  );
}

/**
 * Decide which router should own a soft-navigated URL. Returns:
 *   - "app"    → the App Router runtime handles the navigation (RSC fetch).
 *   - "pages"  → Pages owns the URL; the caller must hard-navigate instead.
 *   - null     → no router matched (preserves the existing 404 path).
 *
 * `basePath` must match what the page uses (typically `process.env.__NEXT_ROUTER_BASEPATH`).
 *
 * The lookup uses the App and Pages manifests on `window` so the same
 * matcher trie produces the same result the server will see when the
 * request lands.
 */
export function resolveHybridClientRouteOwner(
  href: string,
  basePath: string,
): HybridClientOwner | null {
  if (typeof window === "undefined") return null;

  const appRoutes = window.__VINEXT_LINK_PREFETCH_ROUTES__;
  const pagesRoutes = window.__VINEXT_PAGES_LINK_PREFETCH_ROUTES__;
  const rewrites = window.__VINEXT_CLIENT_REWRITES__;

  if (rewrites) {
    const beforeFilesRewrite = resolveClientRewrite(href, basePath, rewrites.beforeFiles, true);
    if (beforeFilesRewrite?.kind === "document") return "document";
    if (beforeFilesRewrite?.kind === "rewrite") href = beforeFilesRewrite.href;
  }

  let appMatch = appRoutes ? matchAppRoute(href, basePath, appRoutes) : null;
  let pagesMatch = pagesRoutes ? matchPagesRoute(href, basePath, pagesRoutes) : null;

  if (
    rewrites &&
    (appMatch === null || appMatch.isDynamic) &&
    (pagesMatch === null || pagesMatch.isDynamic)
  ) {
    for (const rewrite of rewrites.afterFiles) {
      const afterFilesRewrite = resolveClientRewrite(href, basePath, [rewrite]);
      if (afterFilesRewrite?.kind === "document") return "document";
      if (afterFilesRewrite?.kind !== "rewrite") continue;
      href = afterFilesRewrite.href;
      appMatch = appRoutes ? matchAppRoute(href, basePath, appRoutes) : null;
      pagesMatch = pagesRoutes ? matchPagesRoute(href, basePath, pagesRoutes) : null;
      if (appMatch || pagesMatch) break;
    }
  }

  if (rewrites && appMatch === null && pagesMatch === null) {
    for (const rewrite of rewrites.fallback) {
      const fallbackRewrite = resolveClientRewrite(href, basePath, [rewrite]);
      if (fallbackRewrite?.kind === "document") return "document";
      if (fallbackRewrite?.kind !== "rewrite") continue;
      href = fallbackRewrite.href;
      appMatch = appRoutes ? matchAppRoute(href, basePath, appRoutes) : null;
      pagesMatch = pagesRoutes ? matchPagesRoute(href, basePath, pagesRoutes) : null;
      if (appMatch || pagesMatch) break;
    }
  }

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
