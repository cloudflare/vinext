const CACHEABILITY_CLASSIFICATION_ERROR_CODE = "VINEXT_CACHEABILITY_CLASSIFICATION_FAILURE";

/**
 * Infrastructure prevented a completed-response cacheability decision.
 *
 * The string code is intentionally structural: App RSC and SSR are separate
 * Vite module graphs, so class identity is not stable across their boundary.
 */
export class CacheabilityClassificationError extends Error {
  readonly code = CACHEABILITY_CLASSIFICATION_ERROR_CODE;
  override name = "CacheabilityClassificationError";
}

export function isCacheabilityClassificationError(
  error: unknown,
): error is CacheabilityClassificationError {
  return (
    typeof error === "object" &&
    error !== null &&
    Reflect.get(error, "code") === CACHEABILITY_CLASSIFICATION_ERROR_CODE
  );
}
