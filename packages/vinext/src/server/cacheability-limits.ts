/** Maximum completed response retained before CDN admission. */
export const CACHEABILITY_ADMISSION_RESPONSE_BODY_LIMIT = 16 * 1024 * 1024;

/** Maximum completed-response capture retained across concurrent isolate requests. */
export const CACHEABILITY_ADMISSION_ISOLATE_BODY_LIMIT = 32 * 1024 * 1024;

/** Leave headroom below the deploy-side request timeout for a fail-closed envelope. */
export const CACHEABILITY_PROBE_TIMEOUT_MS = 20_000;
