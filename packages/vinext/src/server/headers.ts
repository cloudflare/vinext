/**
 * Internal HTTP header name constants used throughout vinext.
 *
 * Centralizes all custom header names so they are defined once and referenced
 * everywhere via imports. Keeping them in one module prevents typos, makes
 * rename-refactors trivial, and lets grep find every consumer instantly.
 *
 * Standard HTTP headers (Content-Type, Cache-Control, etc.) are intentionally
 * omitted — only vinext-internal and Next.js-protocol headers belong here.
 */

// ---------------------------------------------------------------------------
// Vinext-proprietary headers (`x-vinext-*` / `X-Vinext-*`)
// ---------------------------------------------------------------------------

/** ISR / page cache state indicator: "HIT" | "MISS" | "STALE" | "STATIC". */
export const VINEXT_CACHE_HEADER = "X-Vinext-Cache";

/** Static file signal — value is URL-encoded pathname. */
export const VINEXT_STATIC_FILE_HEADER = "x-vinext-static-file";

/** Serialized middleware context (JSON) forwarded from dev server to RSC entry. */
export const VINEXT_MW_CTX_HEADER = "x-vinext-mw-ctx";

/** Timing metrics: `handlerStart,compileMs,renderMs`. */
export const VINEXT_TIMING_HEADER = "x-vinext-timing";

/** Build-time prerender authentication secret. */
export const VINEXT_PRERENDER_SECRET_HEADER = "x-vinext-prerender-secret";

/** TPR (Tailored Per-Request) revalidation interval in seconds. */
export const VINEXT_REVALIDATE_HEADER = "x-vinext-revalidate";

/** Marker on cached ISR entries indicating RSC payload (value "1"). */
export const VINEXT_RSC_MARKER_HEADER = "x-vinext-rsc";

/** URL-encoded JSON route params carried on RSC responses. */
export const VINEXT_PARAMS_HEADER = "X-Vinext-Params";

/** Deduplicated, sorted list of mounted layout slots for cache keying. */
export const VINEXT_MOUNTED_SLOTS_HEADER = "X-Vinext-Mounted-Slots";

/** Route interception context for parallel/intercepting routes. */
export const VINEXT_INTERCEPTION_CONTEXT_HEADER = "X-Vinext-Interception-Context";

/** RSC render mode (e.g. "navigation", "prefetch"). */
export const VINEXT_RSC_RENDER_MODE_HEADER = "X-Vinext-Rsc-Render-Mode";

// ---------------------------------------------------------------------------
// RSC protocol headers
// ---------------------------------------------------------------------------

/** Standard RSC header — value "1" indicates an RSC payload request. */
export const RSC_HEADER = "RSC";

/** Server Action invocation header (vinext/vite-rsc protocol). */
export const RSC_ACTION_HEADER = "x-rsc-action";

// ---------------------------------------------------------------------------
// Next.js compatibility headers
// ---------------------------------------------------------------------------

/** Next.js Server Action invocation header (fallback for x-rsc-action). */
export const NEXT_ACTION_HEADER = "next-action";

/** Next.js action-not-found indicator (value "1"). */
export const NEXTJS_ACTION_NOT_FOUND_HEADER = "x-nextjs-action-not-found";

/** Forwarded action marker — set when a request has already been forwarded between workers. */
export const ACTION_FORWARDED_HEADER = "x-action-forwarded";

// ---------------------------------------------------------------------------
// Server Action response headers (`x-action-*`)
// ---------------------------------------------------------------------------

/** Indicates revalidation occurred — value is JSON kind (1 = path/tag, 2 = dynamic-only). */
export const ACTION_REVALIDATED_HEADER = "x-action-revalidated";

/** Redirect URL from a Server Action. */
export const ACTION_REDIRECT_HEADER = "x-action-redirect";

/** Redirect type from a Server Action ("push" | "replace"). */
export const ACTION_REDIRECT_TYPE_HEADER = "x-action-redirect-type";

/** HTTP status for a Server Action redirect (e.g. "308"). */
export const ACTION_REDIRECT_STATUS_HEADER = "x-action-redirect-status";

// ---------------------------------------------------------------------------
// Middleware protocol headers (`x-middleware-*`)
// ---------------------------------------------------------------------------

/** Prefix for forwarded request headers (e.g. `x-middleware-request-cookie`). */
export const MIDDLEWARE_REQUEST_HEADER_PREFIX = "x-middleware-request-";

/** Comma-separated list of header names that middleware wants to override. */
export const MIDDLEWARE_OVERRIDE_HEADERS = "x-middleware-override-headers";

/** Carries cookies set by middleware for same-render reads. */
export const MIDDLEWARE_SET_COOKIE_HEADER = "x-middleware-set-cookie";

/** Signal from `NextResponse.next()` — value "1" means "continue to next handler". */
export const MIDDLEWARE_NEXT_HEADER = "x-middleware-next";

/** Rewrite destination URL set by `NextResponse.rewrite()`. */
export const MIDDLEWARE_REWRITE_HEADER = "x-middleware-rewrite";

/** Redirect URL set by middleware. */
const MIDDLEWARE_REDIRECT_HEADER = "x-middleware-redirect";

/** Skip-middleware signal. */
const MIDDLEWARE_SKIP_HEADER = "x-middleware-skip";

/** Generic prefix for all middleware internal headers. */
export const MIDDLEWARE_HEADER_PREFIX = "x-middleware-";

// ---------------------------------------------------------------------------
// Next.js / RSC flight headers (forwarded through middleware)
// ---------------------------------------------------------------------------

export const NEXT_ROUTER_STATE_TREE_HEADER = "Next-Router-State-Tree";
export const NEXT_ROUTER_PREFETCH_HEADER = "Next-Router-Prefetch";
export const NEXT_ROUTER_SEGMENT_PREFETCH_HEADER = "Next-Router-Segment-Prefetch";
export const NEXT_URL_HEADER = "Next-Url";

/** Lowercase flight header variants used in middleware forwarding. */
export const FLIGHT_HEADERS: readonly string[] = [
  "rsc",
  "next-router-state-tree",
  "next-router-prefetch",
  "next-hmr-refresh",
  "next-router-segment-prefetch",
];

// ---------------------------------------------------------------------------
// Vercel / Now.sh legacy internal headers (stripped from inbound requests)
// ---------------------------------------------------------------------------

const NOW_ROUTE_MATCHES_HEADER = "x-now-route-matches";
const MATCHED_PATH_HEADER = "x-matched-path";
const NEXTJS_DATA_HEADER = "x-nextjs-data";
const NEXT_RESUME_STATE_LENGTH_HEADER = "x-next-resume-state-length";

// ---------------------------------------------------------------------------
// Internal headers blocklist — stripped from inbound requests for security
// ---------------------------------------------------------------------------

/**
 * Headers that must be stripped from external requests before any handler
 * processes them. An attacker could forge these to influence routing or
 * impersonate internal data fetches.
 *
 * Ported from Next.js `INTERNAL_HEADERS`:
 * https://github.com/vercel/next.js/blob/canary/packages/next/src/server/lib/server-ipc/utils.ts
 */
export const INTERNAL_HEADERS = [
  MIDDLEWARE_REWRITE_HEADER,
  MIDDLEWARE_REDIRECT_HEADER,
  MIDDLEWARE_SET_COOKIE_HEADER,
  MIDDLEWARE_SKIP_HEADER,
  MIDDLEWARE_OVERRIDE_HEADERS,
  MIDDLEWARE_NEXT_HEADER,
  NOW_ROUTE_MATCHES_HEADER,
  MATCHED_PATH_HEADER,
  NEXTJS_DATA_HEADER,
  NEXT_RESUME_STATE_LENGTH_HEADER,
  ACTION_FORWARDED_HEADER,
];
