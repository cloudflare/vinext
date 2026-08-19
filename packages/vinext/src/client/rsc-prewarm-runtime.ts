import type { RscCacheKeyMode } from "../cache/cache-adapters-virtual.js";
import { createRscRequestUrl, getRscCacheKeyMode } from "./rsc-request-identity.js";
import {
  NEXT_ROUTER_PREFETCH_HEADER,
  NEXT_ROUTER_SEGMENT_PREFETCH_HEADER,
  NEXT_ROUTER_STATE_TREE_HEADER,
  NEXT_URL_HEADER,
  VINEXT_CLIENT_REUSE_MANIFEST_HEADER,
  VINEXT_INTERCEPTION_CONTEXT_HEADER,
  VINEXT_INTERCEPTION_ID_HEADER,
  VINEXT_MOUNTED_SLOTS_HEADER,
  VINEXT_RSC_RENDER_MODE_HEADER,
  VINEXT_RSC_STATE_FINGERPRINT_HEADER,
} from "../utils/rsc-headers.js";

export * from "./rsc-prewarm-eligibility.js";

export function canonicalizeFullRscRequestHeaders(
  headers: Headers,
  cacheKeyMode: RscCacheKeyMode = getRscCacheKeyMode(),
): boolean {
  if (
    cacheKeyMode !== "response-vary" ||
    headers.has(VINEXT_RSC_RENDER_MODE_HEADER) ||
    headers.has(VINEXT_INTERCEPTION_CONTEXT_HEADER) ||
    headers.has(VINEXT_INTERCEPTION_ID_HEADER) ||
    headers.has(VINEXT_MOUNTED_SLOTS_HEADER) ||
    headers.has(VINEXT_CLIENT_REUSE_MANIFEST_HEADER)
  ) {
    return false;
  }

  headers.delete(NEXT_ROUTER_PREFETCH_HEADER);
  headers.delete(NEXT_ROUTER_SEGMENT_PREFETCH_HEADER);
  headers.delete(NEXT_ROUTER_STATE_TREE_HEADER);
  headers.delete(NEXT_URL_HEADER);
  headers.delete(VINEXT_RSC_STATE_FINGERPRINT_HEADER);
  return true;
}

export async function createRscClientRequestIdentity(
  href: string,
  headers: Headers,
  requestCacheKeyMode: RscCacheKeyMode = "header-digest",
): Promise<{ cacheKeyUrl: string; requestUrl: string }> {
  const requestUrl = await createRscRequestUrl(href, headers, requestCacheKeyMode);
  return {
    cacheKeyUrl: await createRscRequestUrl(href, headers, "header-digest"),
    requestUrl,
  };
}
