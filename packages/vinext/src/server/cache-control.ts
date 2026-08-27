import {
  getCdnCacheAdapter,
  isNonCacheableCacheControl,
  type CdnCacheableHeaderInput,
} from "vinext/shims/cdn-cache";

export { isNonCacheableCacheControl } from "vinext/shims/cdn-cache";

export const NEVER_CACHE_CONTROL = "private, no-cache, no-store, max-age=0, must-revalidate";

export const BROWSER_REVALIDATE_CACHE_CONTROL = "public, max-age=0, must-revalidate";

export const STATIC_CACHE_CONTROL = "s-maxage=31536000, stale-while-revalidate";

const STALE_REVALIDATE_CACHE_CONTROL = "s-maxage=0, stale-while-revalidate";

export const NO_STORE_CACHE_CONTROL = "no-store, must-revalidate";

const SHARED_CACHE_DIRECTIVE_RE = /(?:^|,)\s*s-maxage\s*=/i;
export function shouldUseNextDeployCacheControl(): boolean {
  return process.env.VINEXT_NEXT_DEPLOY_CACHE_CONTROL === "1";
}

function isSharedCacheControl(cacheControl: string): boolean {
  return SHARED_CACHE_DIRECTIVE_RE.test(cacheControl);
}

/**
 * Whether an existing response explicitly opted out of storage. Adapters may
 * inspect the provider-specific policy headers they own; the generic fallback
 * only understands the framework-owned `Cache-Control` header.
 */
export function hasExplicitNonCacheableResponsePolicy(headers: Headers): boolean {
  const adapter = getCdnCacheAdapter();
  if (adapter.hasExplicitNonCacheableResponsePolicy) {
    return adapter.hasExplicitNonCacheableResponsePolicy(headers);
  }
  const cacheControl = headers.get("Cache-Control");
  return Boolean(cacheControl && isNonCacheableCacheControl(cacheControl));
}

/** Delegate provider-specific request routing validation to the CDN adapter. */
export async function validateCdnRequest(request: Request): Promise<Response | null> {
  return (await getCdnCacheAdapter().validateRequest?.(request)) ?? null;
}

/**
 * Route a cacheable response's headers through the active CDN cache adapter and
 * apply the result to `headers`. The default adapter yields a single
 * `Cache-Control` identical to `input.cacheControl` (no behavior change); edge
 * adapters may instead emit provider-specific cache and invalidation headers.
 *
 * The adapter owns its provider-specific output: returning a value sets it,
 * while returning `null` removes it. Core only clears the generic header it
 * owns before applying that map.
 */
export function applyCdnResponseHeaders(headers: Headers, input: CdnCacheableHeaderInput): void {
  headers.delete("Cache-Control");
  const useNextDeployPolicy =
    shouldUseNextDeployCacheControl() && isSharedCacheControl(input.cacheControl);
  // An empty policy tells the adapter to remove any provider-specific cache
  // metadata it owns before core applies the deployment-specific browser policy.
  const map = getCdnCacheAdapter().buildResponseHeaders(
    useNextDeployPolicy ? { ...input, cacheControl: "" } : input,
  );
  for (const [name, value] of Object.entries(map)) {
    if (value === null) {
      headers.delete(name);
      continue;
    }
    // Never stamp an empty header. An adapter returns an empty `Cache-Control`
    // only when it has no default for an empty policy (e.g. the default
    // origin-managed adapter), in which case the header should stay absent
    // rather than being emitted as a blank value.
    if (value === "") continue;
    headers.set(name, value);
  }
  if (useNextDeployPolicy) {
    headers.set("Cache-Control", BROWSER_REVALIDATE_CACHE_CONTROL);
  }
}

/** Apply adapter-owned build identity to an HTML or RSC page response. */
export function applyCdnResponseIdentityHeaders(response: Response, request: Request): Response {
  const accept = request.headers.get("Accept")?.toLowerCase() ?? "";
  const isPagesDataRequest = /(?:^|\/)_next\/data\/[^/]+\/.+\.json$/.test(
    new URL(request.url).pathname,
  );
  if (request.headers.get("RSC") !== "1" && !accept.includes("text/html") && !isPagesDataRequest) {
    return response;
  }
  return applyCdnResponseBuildIdentityHeaders(response);
}

/** Apply adapter-owned build identity to an already-classified response. */
export function applyCdnResponseBuildIdentityHeaders(response: Response): Response {
  const map = getCdnCacheAdapter().buildResponseIdentityHeaders?.();
  if (!map || Object.keys(map).length === 0) return response;

  try {
    applyResponseHeaderMap(response.headers, map);
    return response;
  } catch {
    // Response.redirect() has immutable headers. Recreate only those responses
    // that need adapter identity so the outer runtime boundary can stamp them.
    const headers = new Headers(response.headers);
    applyResponseHeaderMap(headers, map);
    return new Response(response.body, {
      headers,
      status: response.status,
      statusText: response.statusText,
    });
  }
}

function applyResponseHeaderMap(headers: Headers, map: Record<string, string | null>): void {
  for (const [name, value] of Object.entries(map)) {
    if (value === null) headers.delete(name);
    else headers.set(name, value);
  }
}

/**
 * Matches Next.js's `getCacheControlHeader` stale window semantics while
 * preserving vinext's legacy unbounded SWR header when no expire ceiling is
 * available yet.
 *
 * Next.js source:
 * https://github.com/vercel/next.js/blob/canary/packages/next/src/server/lib/cache-control.ts
 */
export function buildRevalidateCacheControl(
  revalidateSeconds: number | false,
  expireSeconds?: number,
): string {
  if (revalidateSeconds === false) return STATIC_CACHE_CONTROL;

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
 */
export function buildCachedRevalidateCacheControl(
  cacheState: "HIT" | "STALE",
  revalidateSeconds: number | false,
  expireSeconds?: number,
): string {
  if (revalidateSeconds === false || revalidateSeconds === Infinity) {
    return STATIC_CACHE_CONTROL;
  }

  // When expire is known, match Next.js and emit the route policy even for
  // vinext-served STALE entries. The hard-expire gate has already decided the
  // stale payload is still usable, and downstream caches should see the same
  // finite SWR window Next.js would emit from cacheControl metadata.
  if (cacheState === "STALE" && expireSeconds === undefined) {
    return STALE_REVALIDATE_CACHE_CONTROL;
  }

  return buildRevalidateCacheControl(revalidateSeconds, expireSeconds);
}
