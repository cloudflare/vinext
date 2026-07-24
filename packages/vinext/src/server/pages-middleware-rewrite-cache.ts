import type { isrGet, isrSet } from "./isr-cache.js";

export type PagesMiddlewareRewriteCacheState = {
  cachePathname: string;
  bypassCdnCache: boolean;
  /** Query-specific SSR state must not be read from or written to the shared origin ISR cache. */
  bypassOriginCache: boolean;
};

/** Request-local cache dependencies for query-varying middleware rewrites. */
export const bypassedPagesIsrGet: typeof isrGet = async () => null;
export const bypassedPagesIsrSet: typeof isrSet = async () => {};

export function getPagesMiddlewareRewriteCacheState(
  routeUrl: string,
  hasMiddlewareRewrite: boolean,
): PagesMiddlewareRewriteCacheState {
  const url = new URL(routeUrl, "http://vinext.local");
  if (!hasMiddlewareRewrite || !url.search) {
    return {
      cachePathname: url.pathname || "/",
      bypassCdnCache: false,
      bypassOriginCache: false,
    };
  }

  url.searchParams.sort();
  return {
    cachePathname: `${url.pathname || "/"}?${url.searchParams.toString()}`,
    bypassCdnCache: true,
    bypassOriginCache: true,
  };
}
