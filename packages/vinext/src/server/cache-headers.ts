import { NEXTJS_CACHE_HEADER, VINEXT_CACHE_HEADER } from "./headers.js";
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
 * serves or stores it, and deploy warming reports it as skipped.
 */
export function withRequestStageBypassCacheState(response: Response): Response {
  // An upgrade is never cached, and rebuilding it drops its webSocket.
  if (isWebSocketUpgradeResponse(response)) return response;
  try {
    response.headers.set(VINEXT_CACHE_HEADER, "BYPASS");
    return response;
  } catch {
    // Response.redirect() and some middleware responses expose immutable headers.
    const headers = new Headers(response.headers);
    headers.set(VINEXT_CACHE_HEADER, "BYPASS");
    return new Response(response.body, {
      headers,
      status: response.status,
      statusText: response.statusText,
    });
  }
}
