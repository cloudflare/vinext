// Runtime-check responses are temporarily represented by the source stream,
// an unread tee branch, and the final contiguous buffer. These limits are also
// consumed by the staged deploy client so it cannot create more in-flight
// probes than a Worker isolate can queue safely.
export const CACHEABILITY_RESPONSE_BODY_LIMIT = 4 * 1024 * 1024;
export const CACHEABILITY_RESPONSE_CAPTURE_BUDGET = 4 * CACHEABILITY_RESPONSE_BODY_LIMIT;
export const CACHEABILITY_RESPONSE_CAPTURE_CONCURRENCY = Math.max(
  1,
  Math.floor(CACHEABILITY_RESPONSE_CAPTURE_BUDGET / CACHEABILITY_RESPONSE_BODY_LIMIT),
);
export const CACHEABILITY_RESPONSE_CAPTURE_PENDING_LIMIT = 32;
export const CACHEABILITY_RESPONSE_CAPTURE_MAX_IN_FLIGHT =
  CACHEABILITY_RESPONSE_CAPTURE_CONCURRENCY + CACHEABILITY_RESPONSE_CAPTURE_PENDING_LIMIT;
// Leave headroom below the deploy probe's 30s request timeout so a slow or
// never-ending response can still return its fail-closed probe envelope.
export const CACHEABILITY_RESPONSE_CAPTURE_TIMEOUT_MS = 20_000;
