/**
 * Shared helper for marking an App Router route as "detected" on the Pages
 * Router singleton when a `<Link>` or `Router.prefetch` targets it.
 *
 * Ported from Next.js: `packages/next/src/shared/lib/router/router.ts:2525`
 *
 *     if (await this._bfl(asPath, resolvedAs, options.locale, true)) {
 *       this.components[urlPathname] = { __appRouter: true } as any
 *     }
 *
 * Next.js uses a bloom filter (`_bfl`) of App Router routes that the Pages
 * Router cannot handle. When the prefetch target matches the filter, the
 * Pages Router records the route on `this.components` with
 * `{ __appRouter: true }`. The Next.js deploy test
 *   test/e2e/app-dir/app/index.test.ts → "should successfully detect app
 *   route during prefetch"
 * reads this through `window.next.router.components["/dashboard"]`.
 *
 * Vinext does not need a bloom filter — the App Router prefetch route
 * manifest (`__VINEXT_LINK_PREFETCH_ROUTES__`) already lives on the client
 * for Link's App Router auto-prefetch decisions. This helper reuses that
 * manifest and the shared trie matcher to decide whether a prefetch target
 * is an App Router route.
 *
 * Lives in `shims/internal/` so both the Pages Router (`router.ts`) and the
 * Link shim's Pages-mode branch (`link.tsx`) can call it without pulling in
 * the other shim at module init.
 *
 * The components map is stored behind a `Symbol.for` global so the Pages
 * Router (`router.ts`) and the Link shim (`link.tsx`) both write through the
 * same instance even when Vite loads the router shim through a different
 * resolved module ID than the link shim (mirrors the same module-split
 * mitigation used by `navigation.ts`'s GLOBAL_ACCESSORS_KEY).
 *
 * Issue: https://github.com/cloudflare/vinext/issues/1526
 */
import type { VinextLinkPrefetchRoute } from "../../client/vinext-next-data.js";
import { createRouteTrieCache, matchRouteWithTrie } from "../../routing/route-matching.js";
import { stripBasePath, removeTrailingSlash } from "../../utils/base-path.js";

const appRouteTrieCache = createRouteTrieCache<VinextLinkPrefetchRoute>();

declare global {
  // oxlint-disable-next-line typescript-eslint/consistent-type-definitions
  interface Window {
    __VINEXT_LINK_PREFETCH_ROUTES__?: VinextLinkPrefetchRoute[];
  }
}

/**
 * Pages Router `components` map shape. Next.js types this loosely (route
 * pattern → `PrivateRouteInfo`), but for the App Router-detected case it
 * stores `{ __appRouter: true }` as a marker (see Next.js source link above).
 * Vinext only writes the marker variant; reads are by test code that checks
 * for `__appRouter: true`.
 */
type PagesRouterComponentsMap = Record<string, { __appRouter: true } | Record<string, unknown>>;

const _COMPONENTS_KEY = Symbol.for("vinext.pagesRouter.components");
type _GlobalWithComponents = typeof globalThis & {
  [_COMPONENTS_KEY]?: PagesRouterComponentsMap;
};

/**
 * Get-or-create the Pages Router `components` map. Returns the same object
 * on every call so `router.components` and `window.next.router.components`
 * have referential identity.
 */
export function getPagesRouterComponentsMap(): PagesRouterComponentsMap {
  const globalState = globalThis as _GlobalWithComponents;
  let components = globalState[_COMPONENTS_KEY];
  if (!components) {
    components = {};
    globalState[_COMPONENTS_KEY] = components;
  }
  return components;
}

/**
 * Resolve a prefetch href to a same-origin pathname (basePath-stripped),
 * suitable as the key used by Next.js for `router.components[urlPathname]`.
 *
 * Returns null for external URLs, malformed URLs, or non-browser contexts.
 */
function resolveSameOriginPathname(href: string, basePath: string): string | null {
  if (typeof window === "undefined") return null;
  let url: URL;
  try {
    url = new URL(href, window.location.href);
  } catch {
    return null;
  }
  if (url.origin !== window.location.origin) return null;
  return stripBasePath(url.pathname, basePath);
}

/**
 * Returns true when the prefetch href matches any route in the App Router
 * prefetch manifest (static or dynamic). Returns false when the manifest is
 * absent (Pages-Router-only build), the URL is external, or no route matches.
 */
function matchesAppRoute(href: string, basePath: string): boolean {
  if (typeof window === "undefined") return false;
  const routes = window.__VINEXT_LINK_PREFETCH_ROUTES__;
  if (!routes || routes.length === 0) return false;

  const pathname = resolveSameOriginPathname(href, basePath);
  if (pathname === null) return false;

  return matchRouteWithTrie(pathname, routes, appRouteTrieCache) !== null;
}

/**
 * Record `components[pathname] = { __appRouter: true }` on the shared
 * Pages Router map when the href matches an App Router route. No-op when the
 * manifest is absent, the URL is external, or no app route matches.
 *
 * `pathname` is the basePath-stripped, trailing-slash-stripped path —
 * matching Next.js's `removeTrailingSlash(removeBasePath(pathname))` key used
 * at read time (router.ts:1442). Stripping here ensures the write and read
 * keys agree regardless of whether the caller normalised trailing slashes
 * first (e.g. `link.tsx` normalises to match `trailingSlash` config before
 * calling, while `router.prefetch()` passes the raw user-supplied URL).
 */
export function markAppRouteDetectedOnPrefetch(href: string, basePath: string): void {
  if (typeof window === "undefined") return;
  if (!matchesAppRoute(href, basePath)) return;

  const rawPathname = resolveSameOriginPathname(href, basePath);
  if (rawPathname === null) return;

  // Normalise to stripped form so the key agrees with the read-side lookup in
  // performNavigation, which also strips trailing slashes before checking.
  const pathname = removeTrailingSlash(rawPathname);
  getPagesRouterComponentsMap()[pathname] = { __appRouter: true };
}
