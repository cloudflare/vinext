/** Maximum response body that an authenticated cacheability probe will drain. */
export const CACHEABILITY_PROBE_BODY_LIMIT = 4 * 1024 * 1024;

/** Leave headroom below the deploy-side request timeout for a fail-closed envelope. */
export const CACHEABILITY_PROBE_TIMEOUT_MS = 20_000;
