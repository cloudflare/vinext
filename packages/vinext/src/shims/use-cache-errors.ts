/**
 * "use cache" error classes
 *
 * Ported from Next.js: packages/next/src/server/use-cache/use-cache-errors.ts
 * https://github.com/vercel/next.js/blob/canary/packages/next/src/server/use-cache/use-cache-errors.ts
 *
 * These errors surface when a "use cache" fill stalls in dev mode.
 * - UseCacheTimeoutError: generic timeout (likely hanging I/O or request-specific
 *   APIs used inside the cache body).
 * - UseCacheDeadlockError: detected via the dev probe — the cache function
 *   completed in isolation, suggesting module-scope state is deadlocking the
 *   main render.
 */

const USE_CACHE_TIMEOUT_ERROR_CODE = "USE_CACHE_TIMEOUT";
const USE_CACHE_DEADLOCK_ERROR_CODE = "USE_CACHE_DEADLOCK";

export class UseCacheTimeoutError extends Error {
  digest: typeof USE_CACHE_TIMEOUT_ERROR_CODE = USE_CACHE_TIMEOUT_ERROR_CODE;

  constructor() {
    super(
      'Filling a cache during prerender timed out, likely because request-specific arguments such as params, searchParams, cookies() or dynamic data were used inside "use cache".',
    );
  }
}

export class UseCacheDeadlockError extends Error {
  digest: typeof USE_CACHE_DEADLOCK_ERROR_CODE = USE_CACHE_DEADLOCK_ERROR_CODE;

  constructor() {
    super(
      'Filling a "use cache" entry appears to be stuck on shared state from the outer render scope. The same function completed when run in isolation, which usually means a module-scoped value (for example a top-level Map used to dedupe fetches) is joining a promise created outside the cache. "use cache" already dedupes calls with the same arguments — within a request and across requests on the same server instance — so the surrounding dedupe layer is both unnecessary and the likely cause. Remove it and rely on "use cache" alone for deduping.',
    );
  }
}

export function isUseCacheTimeoutError(err: unknown): err is UseCacheTimeoutError {
  if (
    typeof err !== "object" ||
    err === null ||
    !("digest" in err) ||
    typeof (err as Record<string, unknown>).digest !== "string"
  ) {
    return false;
  }
  return (err as Record<string, unknown>).digest === USE_CACHE_TIMEOUT_ERROR_CODE;
}

export function isUseCacheDeadlockError(err: unknown): err is UseCacheDeadlockError {
  if (
    typeof err !== "object" ||
    err === null ||
    !("digest" in err) ||
    typeof (err as Record<string, unknown>).digest !== "string"
  ) {
    return false;
  }
  return (err as Record<string, unknown>).digest === USE_CACHE_DEADLOCK_ERROR_CODE;
}
