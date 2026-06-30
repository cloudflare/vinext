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
import { stripBasePath, removeTrailingSlash } from "../../utils/base-path.js";
import { getLocalePathPrefix } from "../../utils/domain-locale.js";
import { getPagesRouterComponentsMap } from "./pages-router-components.js";

declare global {
  // oxlint-disable-next-line typescript-eslint/consistent-type-definitions
  interface Window {
    __VINEXT_LINK_PREFETCH_ROUTES__?: VinextLinkPrefetchRoute[];
  }
}

export { getPagesRouterComponentsMap } from "./pages-router-components.js";

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
  const pathname = stripBasePath(url.pathname, basePath);
  const locale = getLocalePathPrefix(pathname, window.__VINEXT_LOCALES__);
  if (!locale) return pathname;

  const localePrefixLength = locale.length + 1;
  return pathname.length === localePrefixLength ? "/" : pathname.slice(localePrefixLength);
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
export async function markAppRouteDetectedOnPrefetch(
  href: string,
  basePath: string,
): Promise<void> {
  if (typeof window === "undefined") return;
  if (!window.__VINEXT_LINK_PREFETCH_ROUTES__?.length) return;
  const { resolveHybridClientRouteOwner } = await import("./hybrid-client-route-owner.js");
  if (resolveHybridClientRouteOwner(href, basePath) !== "app") return;

  const rawPathname = resolveSameOriginPathname(href, basePath);
  if (rawPathname === null) return;

  // Normalise to stripped form so the key agrees with the read-side lookup in
  // performNavigation, which also strips trailing slashes before checking.
  const pathname = removeTrailingSlash(rawPathname);
  getPagesRouterComponentsMap()[pathname] = { __appRouter: true };
}
