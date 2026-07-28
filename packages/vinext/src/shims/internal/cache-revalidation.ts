import { getRequestExecutionContext } from "../request-context.js";

const PENDING_BACKGROUND_CACHE_REVALIDATIONS = Symbol.for(
  "vinext.cache.pendingBackgroundRevalidations",
);
const globalState = globalThis as unknown as Record<PropertyKey, unknown>;

function getPendingBackgroundCacheRevalidations(): Map<string, Promise<void>> {
  const existing = globalState[PENDING_BACKGROUND_CACHE_REVALIDATIONS];
  if (existing instanceof Map) return existing;

  const pending = new Map<string, Promise<void>>();
  globalState[PENDING_BACKGROUND_CACHE_REVALIDATIONS] = pending;
  return pending;
}

/**
 * Start at most one background refresh for a logical data-cache key.
 *
 * The caller owns the refresh's execution context and error message. This
 * helper owns only isolate-wide deduplication, cleanup, rejection guarding,
 * and attachment to the triggering request's runtime lifetime.
 */
export function scheduleBackgroundCacheRevalidation(
  cacheKey: string,
  refresh: () => Promise<unknown>,
  reportError: (error: unknown) => void,
): void {
  const pending = getPendingBackgroundCacheRevalidations();
  if (pending.has(cacheKey)) return;

  const revalidation = Promise.resolve()
    .then(refresh)
    .then(() => undefined)
    .catch((error) => {
      reportError(error);
    });
  const trackedRevalidation = revalidation.finally(() => {
    if (pending.get(cacheKey) === trackedRevalidation) {
      pending.delete(cacheKey);
    }
  });

  pending.set(cacheKey, trackedRevalidation);
  const executionContext = getRequestExecutionContext();
  if (executionContext) {
    executionContext.waitUntil(trackedRevalidation);
  } else {
    void trackedRevalidation;
  }
}
