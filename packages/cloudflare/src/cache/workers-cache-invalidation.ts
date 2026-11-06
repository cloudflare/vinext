/**
 * Workers Cache tag invalidation shared by the CDN adapter, its worker
 * entrypoints, and the Response Store data adapter.
 */

type CacheInvalidationOptions = { tags: string[] };

type CacheMethodName = "invalidate" | "purge";

type CacheMethods<Name extends CacheMethodName> = Record<
  Name,
  (options: CacheInvalidationOptions) => unknown
>;

/**
 * Whether `revalidateTag` marks its tags stale rather than expiring them.
 *
 * Next.js marks a tag stale whenever durations are passed, and expires it
 * immediately when they are absent (`updateTag`, `revalidatePath`, the legacy
 * single-argument `revalidateTag`) or `expire` is 0.
 * https://github.com/vercel/next.js/blob/canary/packages/next/src/server/lib/incremental-cache/file-system-cache.ts
 */
export function isStaleTagInvalidation(durations?: { expire?: number }): boolean {
  return (
    durations !== undefined && !(typeof durations.expire === "number" && durations.expire <= 0)
  );
}

export function hasCacheMethod<Name extends CacheMethodName>(
  value: unknown,
  name: Name,
): value is CacheMethods<Name> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    name in value &&
    typeof Reflect.get(value, name) === "function"
  );
}

/**
 * Mark matching Workers Cache responses stale so the edge keeps serving them
 * while it refetches in the background. Local Miniflare does not implement
 * `invalidate()` yet, so it falls back to a hard purge there. Returns
 * `undefined` when the cache supports neither.
 */
export function invalidateOrPurge(cache: unknown, options: CacheInvalidationOptions): unknown {
  if (hasCacheMethod(cache, "invalidate")) return cache.invalidate(options);
  return hasCacheMethod(cache, "purge") ? cache.purge(options) : undefined;
}
