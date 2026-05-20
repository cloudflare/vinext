import { DEPLOY_CACHE_CONTROL, isDeployRuntime } from "./deploy-runtime.js";

export const NEVER_CACHE_CONTROL = "private, no-cache, no-store, max-age=0, must-revalidate";

export const STATIC_CACHE_CONTROL = "s-maxage=31536000, stale-while-revalidate";

const STALE_REVALIDATE_CACHE_CONTROL = "s-maxage=0, stale-while-revalidate";

export const NO_STORE_CACHE_CONTROL = "no-store, must-revalidate";

export { DEPLOY_CACHE_CONTROL };

/**
 * Matches Next.js's `getCacheControlHeader` stale window semantics while
 * preserving vinext's legacy unbounded SWR header when no expire ceiling is
 * available yet.
 *
 * When running in deploy mode (Cloudflare Workers), the per-revalidate
 * `s-maxage` output is replaced with `public, max-age=0, must-revalidate` to
 * match Next.js' deploy adapters. ISR freshness is then governed by cache
 * tags + the in-Worker cache handler, not by the HTTP cache header. See
 * `deploy-runtime.ts` for rationale.
 *
 * Next.js source:
 * https://github.com/vercel/next.js/blob/canary/packages/next/src/server/lib/cache-control.ts
 */
export function buildRevalidateCacheControl(
  revalidateSeconds: number,
  expireSeconds?: number,
  /**
   * Override the runtime deploy-mode detection. Defaults to
   * `isDeployRuntime()` so production behavior is automatic; unit tests pass
   * `true`/`false` explicitly to exercise both modes without manipulating
   * global state.
   */
  isDeploy: boolean = isDeployRuntime(),
): string {
  if (isDeploy) {
    return DEPLOY_CACHE_CONTROL;
  }

  if (expireSeconds === undefined) {
    return `s-maxage=${revalidateSeconds}, stale-while-revalidate`;
  }

  // `expire <= revalidate` is a zero-width stale window: downstream caches
  // should refetch after s-maxage instead of serving stale.
  if (revalidateSeconds >= expireSeconds) {
    return `s-maxage=${revalidateSeconds}`;
  }

  return `s-maxage=${revalidateSeconds}, stale-while-revalidate=${
    expireSeconds - revalidateSeconds
  }`;
}

/**
 * Builds Cache-Control for ISR cache reads. HIT responses and STALE responses
 * with stored expire metadata use the same route policy because Next.js derives
 * this header from cache-control metadata, not from the cache hit/stale state.
 * STALE entries without expire metadata keep vinext's legacy `s-maxage=0`
 * fallback so older cache entries are not treated as newly fresh downstream.
 *
 * In deploy mode (Cloudflare Workers), every cacheable output (including
 * `revalidate === Infinity` "static" pages) collapses to
 * `public, max-age=0, must-revalidate` — see `buildRevalidateCacheControl`.
 * Cache-tag invalidation and the in-Worker cache handler govern freshness,
 * not the HTTP cache header. Next.js' `test/e2e/prerender.test.ts` asserts
 * this for both `revalidate: 2` pages and no-revalidate static pages.
 */
export function buildCachedRevalidateCacheControl(
  cacheState: "HIT" | "STALE",
  revalidateSeconds: number,
  expireSeconds?: number,
  isDeploy: boolean = isDeployRuntime(),
): string {
  if (isDeploy) {
    return DEPLOY_CACHE_CONTROL;
  }

  if (revalidateSeconds === Infinity) {
    return STATIC_CACHE_CONTROL;
  }

  // When expire is known, match Next.js and emit the route policy even for
  // vinext-served STALE entries. The hard-expire gate has already decided the
  // stale payload is still usable, and downstream caches should see the same
  // finite SWR window Next.js would emit from cacheControl metadata.
  if (cacheState === "STALE" && expireSeconds === undefined) {
    return STALE_REVALIDATE_CACHE_CONTROL;
  }

  return buildRevalidateCacheControl(revalidateSeconds, expireSeconds, false);
}
