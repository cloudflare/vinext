import { getCdnCacheAdapter, type CdnCacheableHeaderInput } from "vinext/shims/cdn-cache";
import {
  getHeadersContext,
  headersContextFromRequest,
  runWithHeadersContext,
} from "vinext/shims/headers";
import { getRequestContext, isInsideUnifiedScope } from "vinext/shims/unified-request-context";
import { mergeVaryHeader } from "./middleware-response-headers.js";

export const NEVER_CACHE_CONTROL = "private, no-cache, no-store, max-age=0, must-revalidate";

export const BROWSER_REVALIDATE_CACHE_CONTROL = "public, max-age=0, must-revalidate";

export const STATIC_CACHE_CONTROL = "s-maxage=31536000, stale-while-revalidate";

const STALE_REVALIDATE_CACHE_CONTROL = "s-maxage=0, stale-while-revalidate";

export const NO_STORE_CACHE_CONTROL = "no-store, must-revalidate";

const SHARED_CACHE_DIRECTIVE_RE = /(?:^|,)\s*s-maxage\s*=/i;
const NON_CACHEABLE_DIRECTIVE_RE = /(?:private|no-store|no-cache)/i;
const CDN_CACHE_CREDENTIAL_HEADERS = ["Cookie", "Authorization"] as const;

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
  return Boolean(cacheControl && NON_CACHEABLE_DIRECTIVE_RE.test(cacheControl));
}

/**
 * Conservatively retain credentials from the effective post-middleware
 * request alongside the original client request used for CDN cache policy.
 * Middleware can add or delete request headers, but neither transition may
 * turn a credential-influenced response into a shared cache entry.
 */
export function includeEffectiveCdnCacheRequestCredentials(
  effectiveHeaders: Headers,
): Headers | null {
  const unifiedContext = isInsideUnifiedScope() ? getRequestContext() : null;
  const headersContext = getHeadersContext();
  const cacheIdentityHeaders =
    unifiedContext?.cdnCacheRequestHeaders ?? headersContext?.originalRequestHeaders ?? null;
  if (!cacheIdentityHeaders) return null;

  let merged: Headers | null = null;
  for (const name of CDN_CACHE_CREDENTIAL_HEADERS) {
    if (!effectiveHeaders.has(name) || cacheIdentityHeaders.has(name)) continue;
    merged ??= new Headers(cacheIdentityHeaders);
    merged.set(name, effectiveHeaders.get(name) ?? "");
  }
  if (!merged) return cacheIdentityHeaders;

  if (unifiedContext?.cdnCacheRequestHeaders) {
    unifiedContext.cdnCacheRequestHeaders = merged;
  }
  if (headersContext?.originalRequestHeaders) {
    headersContext.originalRequestHeaders = merged;
  }
  return merged;
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
type ApplyCdnResponseHeadersOptions = {
  /**
   * Replace a browser-facing generic denial while intentionally transferring
   * ownership from an inner render to an outer response policy. Adapter-owned
   * denials and Set-Cookie remain monotonic.
   */
  replaceGenericPolicy?: boolean;
};

export function applyCdnResponseHeaders(
  headers: Headers,
  input: CdnCacheableHeaderInput,
  options?: ApplyCdnResponseHeadersOptions,
): void {
  // Cache denial is monotonic. A provider-owned no-store policy or Set-Cookie
  // observed at the final response boundary must not be replaced by a later
  // generic cacheable policy.
  const existingCacheControl = headers.get("Cache-Control");
  const existingGenericDenial =
    existingCacheControl && NON_CACHEABLE_DIRECTIVE_RE.test(existingCacheControl)
      ? existingCacheControl
      : null;
  const hasAdapterDenial = hasExplicitNonCacheableResponsePolicy(headers);
  const requestedDenial = NON_CACHEABLE_DIRECTIVE_RE.test(input.cacheControl);
  const effectiveInput =
    requestedDenial && options?.replaceGenericPolicy
      ? input
      : headers.has("Set-Cookie") ||
          hasAdapterDenial ||
          (existingGenericDenial !== null && !options?.replaceGenericPolicy)
        ? { ...input, cacheControl: existingGenericDenial ?? "no-store" }
        : input;
  headers.delete("Cache-Control");
  const useNextDeployPolicy =
    shouldUseNextDeployCacheControl() && isSharedCacheControl(effectiveInput.cacheControl);
  // An empty policy tells the adapter to remove any provider-specific cache
  // metadata it owns before core applies the deployment-specific browser policy.
  const map = getCdnCacheAdapter().buildResponseHeaders(
    useNextDeployPolicy ? { ...effectiveInput, cacheControl: "" } : effectiveInput,
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
    if (name.toLowerCase() === "vary") {
      mergeVaryHeader(headers, value);
      continue;
    }
    headers.set(name, value);
  }
  if (useNextDeployPolicy) {
    headers.set("Cache-Control", BROWSER_REVALIDATE_CACHE_CONTROL);
  }
}

/**
 * Route a middleware- or upstream-owned response through the active CDN
 * adapter after its final response headers have been assembled.
 *
 * These responses do not pass through the framework render cache, so their
 * generic Cache-Control policy is the only cacheability signal available.
 * Clone the response because redirect headers and some runtime responses are
 * immutable, and never admit a Set-Cookie response to shared storage.
 */
export function applyCdnPolicyToBoundaryResponse(response: Response, request: Request): Response {
  const result = runWithHeadersContext(headersContextFromRequest(request), () => {
    const originalHeaders = [...response.headers];
    const headers = new Headers(response.headers);
    applyCdnResponseHeaders(headers, {
      cacheControl: headers.has("Set-Cookie") ? "no-store" : (headers.get("Cache-Control") ?? ""),
    });
    const nextHeaders = [...headers];
    if (
      originalHeaders.length === nextHeaders.length &&
      originalHeaders.every(
        ([name, value], index) =>
          nextHeaders[index]?.[0] === name && nextHeaders[index]?.[1] === value,
      )
    ) {
      return response;
    }
    return new Response(response.body, {
      headers,
      status: response.status,
      statusText: response.statusText,
    });
  });
  // The callback above is deliberately synchronous; runWithHeadersContext's
  // public overload also accepts async callbacks, so its inferred return is a
  // wider union than this boundary helper can produce.
  return result as Response;
}

/**
 * Preserve a cache denial after late response-header merges without
 * reconstructing an already-emitted cacheable adapter policy from the
 * browser-facing Cache-Control header.
 */
export function enforceCdnCacheDenialOnResponse(response: Response): Response {
  const cacheControl = response.headers.get("Cache-Control");
  if (
    !response.headers.has("Set-Cookie") &&
    !(cacheControl && NON_CACHEABLE_DIRECTIVE_RE.test(cacheControl)) &&
    !hasExplicitNonCacheableResponsePolicy(response.headers)
  ) {
    return response;
  }
  const headers = new Headers(response.headers);
  applyCdnResponseHeaders(headers, { cacheControl: NO_STORE_CACHE_CONTROL });
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
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
