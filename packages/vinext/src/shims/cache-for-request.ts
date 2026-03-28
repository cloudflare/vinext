/**
 * Cache a factory function's result for the duration of a request.
 *
 * Returns a function that lazily invokes the factory on first call within
 * a request, then returns the cached result for all subsequent calls in
 * the same request. Each new request gets a fresh invocation.
 *
 * The factory function's identity (reference) is the cache key — no
 * string keys, no collision risk between modules.
 *
 * Async factories are supported: the returned Promise is cached, so
 * concurrent `await` calls within the same request share one invocation.
 * If the Promise rejects, the cached entry is cleared so the next call
 * can retry.
 *
 * Outside a request scope (tests, build-time), the factory runs every
 * time with no caching — safe and predictable.
 *
 * @example
 * ```ts
 * import { cacheForRequest } from "vinext/cache";
 *
 * const getPrisma = cacheForRequest(() => {
 *   const pool = new Pool({ connectionString: env.HYPERDRIVE.connectionString });
 *   return new PrismaClient({ adapter: new PrismaPg(pool) });
 * });
 *
 * // In a route handler or server component:
 * const prisma = getPrisma(); // first call creates, subsequent calls reuse
 * ```
 *
 * @example
 * ```ts
 * // Async factory — Promise is cached, not re-invoked.
 * // If it rejects, the cache is cleared for retry.
 * const getDb = cacheForRequest(async () => {
 *   const pool = new Pool({ connectionString });
 *   await pool.connect();
 *   return drizzle(pool);
 * });
 *
 * const db = await getDb();
 * ```
 *
 * @module
 */

import { getRequestContext, isInsideUnifiedScope } from "./unified-request-context.js";

/**
 * Create a request-scoped cached version of a factory function.
 *
 * @param factory - Function that creates the value. Called once per request for sync
 *   factories. Async factories that reject have their cache cleared, allowing retry.
 * @returns A function with the same return type that caches the result per request.
 */
export function cacheForRequest<T>(factory: () => T): () => T {
  return (): T => {
    if (!isInsideUnifiedScope()) {
      return factory();
    }

    const ctx = getRequestContext();
    const cache = ctx.requestCache;

    if (cache.has(factory)) {
      return cache.get(factory) as T;
    }

    const value = factory();

    // For async factories: if the Promise rejects, clear the cached entry
    // so subsequent calls within the same request can retry.
    if (value instanceof Promise) {
      cache.set(factory, value);
      (value as Promise<unknown>).catch(() => {
        // Only clear if the cached value is still this exact Promise
        // (avoids clearing a newer retry's value).
        if (cache.get(factory) === value) {
          cache.delete(factory);
        }
      });
    } else {
      cache.set(factory, value);
    }

    return value;
  };
}
