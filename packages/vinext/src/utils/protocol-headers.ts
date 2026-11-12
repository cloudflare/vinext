/** Serialized middleware context (JSON) forwarded from dev server to RSC entry. */
export const VINEXT_MW_CTX_HEADER = "x-vinext-mw-ctx";

/** Build-time prerender authentication secret. */
export const VINEXT_PRERENDER_SECRET_HEADER = "x-vinext-prerender-secret";

/** URL-encoded JSON route params for build-time prerender renders. */
export const VINEXT_PRERENDER_ROUTE_PARAMS_HEADER = "x-vinext-prerender-route-params";

/** Indicates a build-time prerender render is probing whether a route can be static. */
export const VINEXT_PRERENDER_SPECULATIVE_HEADER = "x-vinext-prerender-speculative";

/** Logical hostname carried only by authenticated Node revalidation loopbacks. */
export const VINEXT_REVALIDATE_HOST_HEADER = "x-vinext-revalidate-host";

/** Prefix for forwarded request headers (e.g. `x-middleware-request-cookie`). */
export const MIDDLEWARE_REQUEST_HEADER_PREFIX = "x-middleware-request-";

/** Comma-separated list of header names that middleware wants to override. */
export const MIDDLEWARE_OVERRIDE_HEADERS = "x-middleware-override-headers";

/** Carries cookies set by middleware for same-render reads. */
export const MIDDLEWARE_SET_COOKIE_HEADER = "x-middleware-set-cookie";

/** True for the internal middleware cookie header, regardless of source casing. */
export function isMiddlewareSetCookieHeader(name: string): boolean {
  return name.toLowerCase() === MIDDLEWARE_SET_COOKIE_HEADER;
}

/**
 * Drop `x-middleware-set-cookie` from a response that is about to be sent.
 *
 * The header is only how middleware publishes cookie mutations for the rest of
 * this render. `Set-Cookie` is the client-visible copy. Mutable headers are
 * edited in place so response identity (and any marks on it) stays put.
 */
export function responseWithoutMiddlewareSetCookie(response: Response): Response {
  if (!response.headers.has(MIDDLEWARE_SET_COOKIE_HEADER)) return response;
  try {
    response.headers.delete(MIDDLEWARE_SET_COOKIE_HEADER);
    return response;
  } catch {
    const headers = new Headers(response.headers);
    headers.delete(MIDDLEWARE_SET_COOKIE_HEADER);
    const cloned = new Response(response.body, {
      headers,
      status: response.status,
      statusText: response.statusText,
    });
    const streamedHtml = (response as { __vinextStreamedHtmlResponse?: boolean })
      .__vinextStreamedHtmlResponse;
    const streamedApi = (response as { __vinextStreamedApiResponse?: boolean })
      .__vinextStreamedApiResponse;
    if (streamedHtml) {
      (cloned as { __vinextStreamedHtmlResponse?: boolean }).__vinextStreamedHtmlResponse = true;
    }
    if (streamedApi) {
      (cloned as { __vinextStreamedApiResponse?: boolean }).__vinextStreamedApiResponse = true;
    }
    return cloned;
  }
}

/** Signals Pages Router prefetch cache opt-out. */
export const MIDDLEWARE_CACHE_HEADER = "x-middleware-cache";

/** Skip-middleware signal. */
export const MIDDLEWARE_SKIP_HEADER = "x-middleware-skip";

/** Generic prefix for all middleware internal headers. */
export const MIDDLEWARE_HEADER_PREFIX = "x-middleware-";

/** Authenticates an internal Pages Router on-demand revalidation request. */
export const PRERENDER_REVALIDATE_HEADER = "x-prerender-revalidate";

/** Restricts on-demand revalidation to paths that were already generated. */
export const PRERENDER_REVALIDATE_ONLY_GENERATED_HEADER = "x-prerender-revalidate-if-generated";
