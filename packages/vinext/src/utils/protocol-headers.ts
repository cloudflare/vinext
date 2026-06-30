/** Serialized middleware context (JSON) forwarded from dev server to RSC entry. */
export const VINEXT_MW_CTX_HEADER = "x-vinext-mw-ctx";

/** Build-time prerender authentication secret. */
export const VINEXT_PRERENDER_SECRET_HEADER = "x-vinext-prerender-secret";

/** URL-encoded JSON route params for build-time prerender renders. */
export const VINEXT_PRERENDER_ROUTE_PARAMS_HEADER = "x-vinext-prerender-route-params";

/** Prefix for forwarded request headers (e.g. `x-middleware-request-cookie`). */
export const MIDDLEWARE_REQUEST_HEADER_PREFIX = "x-middleware-request-";

/** Comma-separated list of header names that middleware wants to override. */
export const MIDDLEWARE_OVERRIDE_HEADERS = "x-middleware-override-headers";

/** Carries cookies set by middleware for same-render reads. */
export const MIDDLEWARE_SET_COOKIE_HEADER = "x-middleware-set-cookie";

/** Generic prefix for all middleware internal headers. */
export const MIDDLEWARE_HEADER_PREFIX = "x-middleware-";
