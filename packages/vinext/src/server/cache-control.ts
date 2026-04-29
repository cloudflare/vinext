export const NEVER_CACHE_CONTROL = "private, no-cache, no-store, max-age=0, must-revalidate";

export const STATIC_CACHE_CONTROL = "s-maxage=31536000, stale-while-revalidate";

const STALE_REVALIDATE_CACHE_CONTROL = "s-maxage=0, stale-while-revalidate";

export const NO_STORE_CACHE_CONTROL = "no-store, must-revalidate";

/**
 * Matches Next.js's `getCacheControlHeader` stale window semantics while
 * preserving vinext's legacy unbounded SWR header when no expire ceiling is
 * available yet.
 *
 * Next.js source:
 * https://github.com/vercel/next.js/blob/canary/packages/next/src/server/lib/cache-control.ts
 */
export function buildRevalidateCacheControl(
  revalidateSeconds: number,
  expireSeconds?: number,
): string {
  const staleWhileRevalidate =
    expireSeconds === undefined
      ? ", stale-while-revalidate"
      : revalidateSeconds < expireSeconds
        ? `, stale-while-revalidate=${expireSeconds - revalidateSeconds}`
        : "";

  return `s-maxage=${revalidateSeconds}${staleWhileRevalidate}`;
}

export function buildCachedRevalidateCacheControl(
  cacheState: "HIT" | "STALE",
  revalidateSeconds: number,
  expireSeconds?: number,
): string {
  // When expire is known, match Next.js and emit the route policy even for
  // vinext-served STALE entries. The hard-expire gate has already decided the
  // stale payload is still usable, and downstream caches should see the same
  // finite SWR window Next.js would emit from cacheControl metadata.
  if (cacheState === "STALE" && expireSeconds === undefined) {
    return STALE_REVALIDATE_CACHE_CONTROL;
  }

  return buildRevalidateCacheControl(revalidateSeconds, expireSeconds);
}
