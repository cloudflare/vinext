// Runtime-check App Pages can retain one raw-RSC artifact while HTML capture
// temporarily holds the source stream, unread tee branch, and final contiguous
// buffer. Reserve for that combined 4x peak so every response up to the
// advertised body limit can complete.
export const CACHEABILITY_RESPONSE_BODY_LIMIT = 4 * 1024 * 1024;
// Two full-size captures may progress concurrently while leaving most of the
// Worker heap for rendering and framework/runtime state.
export const CACHEABILITY_RESPONSE_CAPTURE_BUDGET = 8 * CACHEABILITY_RESPONSE_BODY_LIMIT;
export const CACHEABILITY_RESPONSE_CAPTURE_CONCURRENCY = Math.max(
  1,
  Math.floor(CACHEABILITY_RESPONSE_CAPTURE_BUDGET / (4 * CACHEABILITY_RESPONSE_BODY_LIMIT)),
);
// Every deploy request must own a guaranteed-progress capture slot. Starting
// more requests would spend their shared request deadlines waiting in-Worker.
export const CACHEABILITY_DEPLOY_REQUEST_CONCURRENCY = CACHEABILITY_RESPONSE_CAPTURE_CONCURRENCY;
export const CACHEABILITY_RESPONSE_CAPTURE_PENDING_LIMIT = 32;
export const CACHEABILITY_RESPONSE_CAPTURE_MAX_IN_FLIGHT =
  CACHEABILITY_RESPONSE_CAPTURE_CONCURRENCY + CACHEABILITY_RESPONSE_CAPTURE_PENDING_LIMIT;
// Leave headroom below the deploy probe's 30s request timeout so a slow or
// never-ending response can still return its fail-closed probe envelope.
export const CACHEABILITY_RESPONSE_CAPTURE_TIMEOUT_MS = 20_000;
