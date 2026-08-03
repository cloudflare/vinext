import {
  cdnCacheAdapterBypassesOriginOnHit,
  getCdnCacheAdapter,
  shouldUseOriginManagedPageCache,
  type CdnCacheableHeaderInput,
} from "vinext/shims/cdn-cache";

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
 * Route a cacheable response's headers through the active CDN cache adapter and
 * apply the result to `headers`. The default adapter yields a single
 * `Cache-Control` identical to `input.cacheControl` (no behavior change); edge
 * adapters may instead emit `CDN-Cache-Control` / `Cache-Tag`.
 *
 * We only clear `Cache-Control` — the one header vinext stamps internally — so
 * a stale vinext value never lingers if an adapter chooses not to emit one. The
 * adapter's own headers are applied via `set()`, which overrides prior values
 * for names it emits. Callers that must also discard provider-specific headers
 * before the adapter recomputes policy clear those explicitly.
 */
export function applyCdnResponseHeaders(headers: Headers, input: CdnCacheableHeaderInput): void {
  headers.delete("Cache-Control");
  // Middleware is part of the request pipeline, above the page artifact cache.
  // If the configured adapter serves HITs without invoking the origin, cache
  // the artifact in the origin store instead and make the composed response
  // non-cacheable to browsers/CDNs. This preserves fresh middleware headers
  // while still serving the page itself as ISR HIT/STALE, matching Next.js.
  const effectiveInput = shouldUseOriginManagedPageCache()
    ? { cacheControl: NEVER_CACHE_CONTROL }
    : input;
  if (shouldUseNextDeployCacheControl() && isSharedCacheControl(effectiveInput.cacheControl)) {
    headers.set("Cache-Control", BROWSER_REVALIDATE_CACHE_CONTROL);
    return;
  }

  const map = getCdnCacheAdapter().buildResponseHeaders(effectiveInput);
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
}

/** Re-assert the middleware-safe policy after user response headers are merged. */
export function applyOriginManagedPageCacheResponseHeaders(headers: Headers): void {
  if (!shouldUseOriginManagedPageCache()) return;
  applyMiddlewareSafePageCacheResponseHeaders(headers, true);
}

/**
 * Apply the safe composed-response policy at a boundary that sits outside the
 * request ALS scope (notably the Pages Router's final header merge).
 */
export function applyMiddlewareSafePageCacheResponseHeaders(
  headers: Headers,
  middlewarePathMatched: boolean,
): void {
  if (!middlewarePathMatched || !cdnCacheAdapterBypassesOriginOnHit()) return;
  applyCdnResponseHeaders(headers, { cacheControl: NEVER_CACHE_CONTROL });
}

/**
 * Apply the middleware-safe policy to headers passed to a Node adapter that
 * writes directly to ServerResponse. Preserve untouched array-valued headers
 * (notably Set-Cookie) by copying back only names changed by the CDN policy.
 */
export function finalizeMiddlewareSafePageCacheHeaderRecord(
  headers: Record<string, string | string[]>,
  middlewarePathMatched: boolean,
): Record<string, string | string[]> {
  if (!middlewarePathMatched || !cdnCacheAdapterBypassesOriginOnHit()) return headers;

  const before = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const item of value) before.append(name, item);
    } else {
      before.set(name, value);
    }
  }
  const after = new Headers(before);
  applyCdnResponseHeaders(after, { cacheControl: NEVER_CACHE_CONTROL });

  const finalized = { ...headers };
  for (const name of Object.keys(headers)) {
    const afterValue = after.get(name);
    if (afterValue === null) {
      delete finalized[name];
    } else if (afterValue !== before.get(name)) {
      finalized[name] = afterValue;
    }
  }
  after.forEach((value, name) => {
    if (!before.has(name)) finalized[name] = value;
  });
  return finalized;
}

/**
 * Finalize a response produced after middleware. Most response headers are
 * mutable; redirect/error responses can carry an immutable guard, so rebuild
 * only when the safe policy cannot be applied in place.
 */
export function finalizeMiddlewareSafePageCacheResponse(
  response: Response,
  middlewarePathMatched: boolean,
): Response {
  if (!middlewarePathMatched || !cdnCacheAdapterBypassesOriginOnHit()) return response;

  try {
    applyCdnResponseHeaders(response.headers, { cacheControl: NEVER_CACHE_CONTROL });
    return response;
  } catch {
    // Status 0 responses cannot be reconstructed with the Response constructor
    // and are not valid HTTP responses that an edge can cache.
    if (response.status === 0) return response;
    const headers = new Headers(response.headers);
    applyCdnResponseHeaders(headers, { cacheControl: NEVER_CACHE_CONTROL });
    return new Response(response.body, {
      headers,
      status: response.status,
      statusText: response.statusText,
    });
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
