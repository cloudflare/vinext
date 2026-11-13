import { NEXTJS_CACHE_HEADER, VINEXT_CACHE_HEADER } from "./headers.js";
import { applyCdnResponseBuildIdentityHeaders } from "./cache-control.js";
import { VINEXT_RSC_BUILD_ID_HEADER } from "./app-rsc-cache-busting.js";
import { isWebSocketUpgradeResponse } from "./websocket-upgrade-response.js";

type VinextCacheState = "HIT" | "MISS" | "STALE" | "STATIC";
type NextJsCacheState = "HIT" | "MISS" | "STALE";

function toNextJsCacheState(cacheState: VinextCacheState): NextJsCacheState {
  return cacheState === "STATIC" ? "HIT" : cacheState;
}

export function setCacheStateHeaders(headers: Headers, cacheState: VinextCacheState): void {
  headers.set(VINEXT_CACHE_HEADER, cacheState);
  headers.set(NEXTJS_CACHE_HEADER, toNextJsCacheState(cacheState));
}

export function buildCacheStateHeaders(cacheState: VinextCacheState): Record<string, string> {
  return {
    [VINEXT_CACHE_HEADER]: cacheState,
    [NEXTJS_CACHE_HEADER]: toNextJsCacheState(cacheState),
  };
}

/**
 * Label a response that middleware or proxy answered in the request stage of a
 * staged deployment. It never reaches the response stage, so no shared cache
 * serves or stores it, and deploy warming reports it as skipped. The adapter's
 * build identity is stamped for every representation, since no route handler
 * or render ran to stamp it. An external rewrite copies the upstream's headers,
 * so its cache status and RSC build identity are dropped: they describe
 * another deployment's cache and render, not this one's.
 */
export function withRequestStageBypassCacheState(response: Response): Response {
  // An upgrade is never cached.
  if (isWebSocketUpgradeResponse(response)) return response;
  let labelled = response;
  try {
    labelRequestStageBypass(response.headers);
  } catch {
    // Response.redirect() and fetch() responses expose immutable headers.
    // Workerd accepts a Response as ResponseInit and keeps its cf and
    // encodeBody, so an already encoded body isn't encoded again.
    labelled = new Response(response.body, response as ResponseInit);
    labelRequestStageBypass(labelled.headers);
  }
  return applyCdnResponseBuildIdentityHeaders(labelled);
}

function labelRequestStageBypass(headers: Headers): void {
  headers.set(VINEXT_CACHE_HEADER, "BYPASS");
  headers.delete("CF-Cache-Status");
  headers.delete(VINEXT_RSC_BUILD_ID_HEADER);
}
