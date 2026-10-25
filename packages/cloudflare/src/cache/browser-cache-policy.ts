import { NEXTJS_CACHE_HEADER, VINEXT_CACHE_HEADER } from "vinext/internal/server/headers";

export type SharedResponseStage = {
  headers: Headers;
};

const CLOUDFLARE_EDGE_POLICY_HEADER = "Cloudflare-CDN-Cache-Control";
export const SHARED_RESPONSE_STAGE_HEADER = "x-vinext-cloudflare-shared-response-stage";
const PRIVATE_RESPONSE_HEADERS = new Set([
  SHARED_RESPONSE_STAGE_HEADER,
  CLOUDFLARE_EDGE_POLICY_HEADER.toLowerCase(),
  "cdn-cache-control",
  "cache-tag",
  VINEXT_CACHE_HEADER.toLowerCase(),
  NEXTJS_CACHE_HEADER.toLowerCase(),
]);

export function finalizeGatewayResponse(
  response: Response,
  sharedResponses: Map<string, SharedResponseStage>,
  cacheStatusHeader = "CF-Cache-Status",
): Response {
  const provenance = response.headers.get(SHARED_RESPONSE_STAGE_HEADER);
  const sharedResponse = provenance === null ? undefined : sharedResponses.get(provenance);
  const usedSharedResponseStage = sharedResponse !== undefined;
  // The marker is reserved for adapter-internal provenance. If outer response
  // composition replaces it, fail closed rather than forwarding shared cache
  // policy on a response whose origin can no longer be authenticated.
  const sharedResponseStageCollision = provenance !== null && !usedSharedResponseStage;
  if (
    !response.headers.has(CLOUDFLARE_EDGE_POLICY_HEADER) &&
    !usedSharedResponseStage &&
    !sharedResponseStageCollision
  ) {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.delete(SHARED_RESPONSE_STAGE_HEADER);
  headers.delete(CLOUDFLARE_EDGE_POLICY_HEADER);
  if (usedSharedResponseStage || sharedResponseStageCollision) {
    for (const name of PRIVATE_RESPONSE_HEADERS) headers.delete(name);
    // Browser policy belongs to the app. Admission and the backing store read
    // the independent provider policy before this uncached gateway runs.
    if (sharedResponseStageCollision) headers.set("Cache-Control", "no-store");
    else if (!headers.has("Cache-Control"))
      headers.set("Cache-Control", "private, max-age=0, must-revalidate");
  }
  const cacheStatus = sharedResponse?.headers.get(cacheStatusHeader);
  if (cacheStatus) {
    headers.set(VINEXT_CACHE_HEADER, cacheStatus);
    headers.set(NEXTJS_CACHE_HEADER, cacheStatus);
  }
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}
