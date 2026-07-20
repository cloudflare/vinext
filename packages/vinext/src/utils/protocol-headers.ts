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
