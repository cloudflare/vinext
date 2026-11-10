import { markRouteCacheabilityFinalResponseUncacheable } from "vinext/shims/cacheability-classification";
import { copyLinkHeaderProvenance } from "./app-response-header-provenance.js";
import { applyCdnResponseHeaders, NEVER_CACHE_CONTROL } from "./cache-control.js";
import { preserveFullyBufferedBodyMetadata } from "./fully-buffered-response.js";
import { VINEXT_ROUTE_MISS_HEADER } from "./headers.js";

/**
 * Mark the 404 for params a `dynamicParams = false` route doesn't list, which
 * Next.js rejects while routing and serves as an unmatched URL. Its never-cache
 * policy can't be replaced by middleware or next.config headers: the request
 * stage reasserts it after config headers, and shared-cache admission never
 * stores it.
 */
export function markRouteMissResponse(response: Response): Response {
  markRouteCacheabilityFinalResponseUncacheable("routing-level not-found");
  const headers = new Headers(response.headers);
  applyCdnResponseHeaders(headers, { cacheControl: NEVER_CACHE_CONTROL });
  headers.set(VINEXT_ROUTE_MISS_HEADER, "1");
  const marked = preserveFullyBufferedBodyMetadata(
    response,
    new Response(response.body, {
      headers,
      status: response.status,
      statusText: response.statusText,
    }),
  );
  copyLinkHeaderProvenance(response.headers, marked.headers);
  return marked;
}
