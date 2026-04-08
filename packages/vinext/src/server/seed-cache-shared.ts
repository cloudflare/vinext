/**
 * Shared types and helpers for seed-cache modules (Node.js and Workers).
 *
 * Both `seed-cache.ts` (eager, fs-based) and `seed-cache-workers.ts`
 * (lazy, fetch-based) read the same vinext-prerender.json manifest and
 * produce identical cache entries. This module holds the shared contract.
 */

import type { CachedAppPageValue } from "../shims/cache.js";

// ─── Manifest types ──────────────────────────────────────────────────────────

export type PrerenderManifest = {
  buildId: string;
  basePath?: string;
  trailingSlash?: boolean;
  routes: PrerenderManifestRoute[];
};

export type PrerenderManifestRoute = {
  route: string;
  status: string;
  revalidate?: number | false;
  path?: string;
  router?: "app" | "pages";
};

// ─── Cache value construction ────────────────────────────────────────────────

/**
 * Build the CacheHandler context object from a revalidate value.
 * `revalidate: undefined` (static routes) → empty context → no expiry.
 */
export function revalidateCtx(seconds: number | undefined): Record<string, unknown> {
  return seconds !== undefined ? { revalidate: seconds } : {};
}

/** Build an APP_PAGE cache value for an HTML entry. */
export function makeHtmlCacheValue(html: string): CachedAppPageValue {
  return {
    kind: "APP_PAGE",
    html,
    rscData: undefined,
    headers: undefined,
    postponed: undefined,
    status: undefined,
  };
}

/** Build an APP_PAGE cache value for an RSC entry. */
export function makeRscCacheValue(rscData: ArrayBuffer): CachedAppPageValue {
  return {
    kind: "APP_PAGE",
    html: "",
    rscData,
    headers: undefined,
    postponed: undefined,
    status: undefined,
  };
}
