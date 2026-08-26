/**
 * Identifies framework errors that must remain fatal even when user code
 * catches the immediate throw.
 *
 * Next.js records these errors on the request work store. Vinext additionally
 * coalesces some cache fills across requests, so the error object also needs a
 * process-local marker that a joining request can replay into its own store.
 */
const INVALID_DYNAMIC_USAGE_ERROR = Symbol.for("vinext.invalidDynamicUsageError");

type MarkedInvalidDynamicUsageError = Error & {
  [INVALID_DYNAMIC_USAGE_ERROR]?: true;
};

export function markInvalidDynamicUsageError<T extends Error>(error: T): T {
  Object.defineProperty(error, INVALID_DYNAMIC_USAGE_ERROR, {
    configurable: false,
    enumerable: false,
    value: true,
    writable: false,
  });
  return error;
}

export function isInvalidDynamicUsageError(error: unknown): error is Error {
  return (
    error instanceof Error &&
    (error as MarkedInvalidDynamicUsageError)[INVALID_DYNAMIC_USAGE_ERROR] === true
  );
}
