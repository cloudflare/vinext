/**
 * Registry of prefetch calls whose asynchronous setup is still running. Both
 * `router.prefetch()` (navigation.ts) and `<Link>`'s `prefetchUrl` (link.tsx)
 * register a token before their first `await` and re-check `cancelled` after,
 * so superseded setup cannot register a cache entry or start a request.
 *
 * Cancellation is sticky and scoped to the destination:
 *   - a navigation to the same href (`notifyAppNavigationStart` in
 *     navigation.ts) will fetch that route itself, so a late prefetch would
 *     duplicate the request. Navigations elsewhere leave the prefetch alone —
 *     nothing else is going to fetch it, and dropping it would make the
 *     prefetch timing-dependent.
 *   - invalidating the whole cache (`invalidatePrefetchCache`, reached via
 *     `router.refresh()`) cancels every pending setup, which would otherwise
 *     repopulate one route from the pre-refresh generation.
 *
 * Sticky matters: a navigation to `/a` followed by one to `/b` must leave a
 * pending `/a` prefetch cancelled, which comparing against a "current
 * destination" value would not.
 *
 * This lives in shims/internal/ rather than navigation.ts because link.tsx
 * must register synchronously but only loads navigation.ts lazily — a static
 * import of the registry must not pull the navigation runtime onto Link's
 * startup path. Keep this module free of React and route-trie dependencies.
 */
import { isExternalUrl } from "../../utils/external-url.js";
import { toBrowserNavigationHref, toSameOriginAppPath } from "../url-utils.js";

/** basePath from next.config.js, injected by the plugin at build time */
const __basePath: string = process.env.__NEXT_ROUTER_BASEPATH ?? "";

const isServer = typeof window === "undefined";

export type PendingPrefetchSetup = { readonly destination: string; cancelled: boolean };
const pendingPrefetchSetups = new Set<PendingPrefetchSetup>();

export function beginPrefetchSetup(destination: string): PendingPrefetchSetup {
  const setup: PendingPrefetchSetup = { destination, cancelled: false };
  pendingPrefetchSetups.add(setup);
  return setup;
}

/** Passing `null` cancels every pending setup regardless of destination. */
export function cancelPendingPrefetchSetups(destination: string | null): void {
  for (const setup of pendingPrefetchSetups) {
    if (destination === null || setup.destination === destination) {
      setup.cancelled = true;
    }
  }
}

/** Unregister a token once its setup closure has settled, cancelled or not. */
export function finishPrefetchSetup(setup: PendingPrefetchSetup): void {
  pendingPrefetchSetups.delete(setup);
}

/**
 * Normalize a navigation or prefetch target to the browser href both sides
 * compare on. Returns null when the target is not same-origin — no same-origin
 * prefetch can be a duplicate of it — and on the server, where
 * `navigateClientSide` can still be reached but there is nothing to cancel.
 */
export function toAppPrefetchDestination(href: string): string | null {
  if (isServer) return null;
  let localHref = href;
  if (isExternalUrl(href)) {
    const localPath = toSameOriginAppPath(href, __basePath);
    if (localPath == null) return null;
    localHref = localPath;
  }
  const browserHref = toBrowserNavigationHref(localHref, window.location.href, __basePath);
  try {
    const url = new URL(browserHref, window.location.href);
    return `${url.pathname}${url.search}`;
  } catch {
    return browserHref.split("#", 1)[0];
  }
}
