/**
 * next/cache shim
 *
 * Provides the Next.js caching API surface: revalidateTag, revalidatePath,
 * unstable_cache. Backed by a pluggable CacheHandler that defaults to
 * in-memory but can be swapped for Cloudflare KV, Redis, DynamoDB, etc.
 *
 * The CacheHandler interface matches Next.js 16's CacheHandler class, so
 * existing community adapters (@neshca/cache-handler, @opennextjs/aws, etc.)
 * can be used directly.
 *
 * Recommended configuration is declarative, via the `cache` option on the
 * `vinext()` plugin in vite.config.ts:
 *   import { kvDataAdapter } from '@vinext/cloudflare/cache/kv-data-adapter';
 *   vinext({ cache: { data: kvDataAdapter({ binding: 'VINEXT_KV_CACHE' }) } })
 *
 * The imperative `setCacheHandler` / `setDataCacheHandler` setters are
 * deprecated for consumers and retained only as the internal registration
 * target used by the generated cache-adapter module.
 */

import {
  getHeadersAccessPhase,
  isDraftModeEnabled,
  markDynamicUsage as _markDynamic,
  peekInvalidDynamicUsageError,
  recordInvalidDynamicUsageError,
} from "./headers.js";
import { getOrCreateAls } from "./internal/als-registry.js";
import { fnv1a64 } from "../utils/hash.js";
import { isInsideUnifiedScope, getRequestContext } from "./unified-request-context.js";
import { workUnitAsyncStorage } from "./internal/work-unit-async-storage.js";
import { makeHangingPromise } from "./internal/make-hanging-promise.js";
import { isInvalidDynamicUsageError } from "./internal/invalid-dynamic-usage-error.js";
import { encodeCacheTag, encodeCacheTags } from "../utils/encode-cache-tag.js";
import { getCdnCacheAdapter } from "./cdn-cache.js";
import { getDataCacheHandler, type CachedFetchValue } from "./cache-handler.js";
import { getRequestExecutionContext } from "./request-context.js";
import { isStagedCacheabilityProbeActive } from "./cacheability-classification.js";
import { addCollectedRequestTags, getCurrentFetchSoftTags } from "./fetch-cache.js";
import {
  ACTION_DID_REVALIDATE_DYNAMIC_ONLY,
  ACTION_DID_REVALIDATE_STATIC_AND_DYNAMIC,
  _hasPendingRevalidatedTag,
  _markPendingRevalidatedTag,
  _queuePendingRevalidation,
  _setRequestScopedCacheLife,
  cacheLifeProfiles,
  getRegisteredCacheContext,
  markActionRevalidation,
  recordUnstableCacheObservation,
  shouldServeStaleUnstableCacheEntry,
  type CacheLifeConfig,
} from "./cache-request-state.js";

export * from "./cache-handler.js";
export * from "./cache-request-state.js";

const _g = globalThis as unknown as Record<PropertyKey, unknown>;

// ---------------------------------------------------------------------------
// Request-scoped ExecutionContext ALS
//
// Re-exported from request-context.ts — the canonical implementation.
// These exports are kept here for backward compatibility with any code that
// imports them from "next/cache".
// ---------------------------------------------------------------------------

export type { ExecutionContextLike } from "./request-context.js";
export { runWithExecutionContext, getRequestExecutionContext } from "./request-context.js";

function scheduleRevalidation(promise: Promise<void>): undefined {
  const executionContext = getRequestExecutionContext();
  const queued = _queuePendingRevalidation(promise);
  if (executionContext) {
    executionContext.waitUntil(promise);
  } else if (!queued) {
    void promise.catch((error) => {
      console.error("[vinext] cache revalidation failed:", error);
    });
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Public API — what app code imports from 'next/cache'
// ---------------------------------------------------------------------------

/**
 * Revalidate cached data associated with a specific cache tag.
 *
 * Works with both `fetch(..., { next: { tags: ['myTag'] } })` and
 * `unstable_cache(fn, keys, { tags: ['myTag'] })`.
 *
 * Next.js 16 updated signature: accepts a cacheLife profile as second argument
 * for stale-while-revalidate (SWR) behavior. The single-argument form is
 * deprecated but still supported for backward compatibility.
 *
 * @param tag - Cache tag to revalidate
 * @param profile - cacheLife profile name (e.g. 'max', 'hours') or inline { expire: number }
 */
export function revalidateTag(tag: string, profile?: string | { expire?: number }): undefined {
  if (isStagedCacheabilityProbeActive()) {
    _markDynamic();
    return undefined;
  }
  // Resolve the profile to durations for the handler
  let durations: { expire?: number } | undefined;
  if (typeof profile === "string") {
    const resolved = cacheLifeProfiles[profile];
    if (resolved) {
      durations = { expire: resolved.expire };
    }
  } else if (profile && typeof profile === "object") {
    durations = profile;
  }
  // Notify the client router whenever the server-side cache is fully
  // invalidated (no SWR window). An unknown profile name resolves to no
  // durations, in which case the handler treats it as a full invalidation —
  // so we mark here too, matching what actually happens server-side.
  if (!profile || !durations || durations.expire === 0) {
    markActionRevalidation(ACTION_DID_REVALIDATE_STATIC_AND_DYNAMIC);
  }
  const encodedTag = encodeCacheTag(tag);
  _markPendingRevalidatedTag(encodedTag);
  return scheduleRevalidation(_invalidateEncodedTag(encodedTag, durations));
}

/**
 * Invalidate one already-encoded tag across both cache layers.
 *
 * Ordering is intentional and load-bearing: invalidate the data cache store
 * FIRST (covers fetch data, `"use cache"`, and page entries stored there by the
 * default CDN adapter), THEN ask the CDN adapter to purge its edge (a no-op for
 * the default adapter). Purging the edge before the store is invalidated would
 * let the edge re-fetch and re-cache stale data.
 */
async function _invalidateEncodedTag(
  encoded: string,
  durations?: { expire?: number },
): Promise<void> {
  await getDataCacheHandler().revalidateTag(encoded, durations);
  await getCdnCacheAdapter().revalidateTag(encoded, durations);
}

/**
 * Revalidate cached data associated with a specific path.
 *
 * Invalidation works through implicit tags generated at render time by
 * `buildAppPageCacheTags`, matching Next.js's getDerivedTags:
 *
 * - `type: "layout"` → invalidates `_N_T_<path>/layout`, cascading to all
 *   descendant pages (they carry ancestor layout tags from render time).
 * - `type: "page"` → invalidates `_N_T_<path>/page`, targeting only the
 *   exact route's page component.
 * - No type → invalidates `_N_T_<path>` (broader, exact path).
 *
 * The `type` parameter is App Router only — Pages Router does not generate
 * layout/page hierarchy tags, so only no-type invalidation applies there.
 */
export function revalidatePath(path: string, type?: "page" | "layout"): undefined {
  if (isStagedCacheabilityProbeActive()) {
    _markDynamic();
    return undefined;
  }
  markActionRevalidation(ACTION_DID_REVALIDATE_STATIC_AND_DYNAMIC);
  // Strip trailing slash so root "/" becomes "" — avoids double-slash in _N_T_//layout
  const stem = path.endsWith("/") ? path.slice(0, -1) : path;
  const tag = type ? `_N_T_${stem}/${type}` : `_N_T_${stem || "/"}`;
  const encodedTag = encodeCacheTag(tag);
  _markPendingRevalidatedTag(encodedTag);
  return scheduleRevalidation(_invalidateEncodedTag(encodedTag));
}

/**
 * No-op shim for API compatibility.
 *
 * In Next.js, calling `refresh()` inside a Server Action triggers a
 * client-side router refresh so the user immediately sees updated data.
 * vinext reports the dynamic-only invalidation through the Server Action
 * response header that the client router already understands.
 */
export function refresh(): void {
  markActionRevalidation(ACTION_DID_REVALIDATE_DYNAMIC_ONLY);
}

/**
 * Expire a cache tag immediately (Next.js 16).
 *
 * Server Actions-only API that expires a tag so the next request
 * fetches fresh data. Unlike `revalidateTag`, which uses stale-while-revalidate,
 * `updateTag` invalidates synchronously within the same request context.
 *
 * Throws if called outside a Server Action — e.g. from a Route Handler or
 * during render — matching Next.js's enforcement. For Route Handlers, callers
 * should use `revalidateTag` instead.
 *
 * @see https://nextjs.org/docs/app/api-reference/functions/updateTag
 */
export function updateTag(tag: string): undefined {
  if (getHeadersAccessPhase() !== "action") {
    throw new Error(
      "updateTag can only be called from within a Server Action. " +
        "To invalidate cache tags in Route Handlers or other contexts, use revalidateTag instead. " +
        "See more info here: https://nextjs.org/docs/app/api-reference/functions/updateTag",
    );
  }
  markActionRevalidation(ACTION_DID_REVALIDATE_STATIC_AND_DYNAMIC);
  // Expire the tag immediately (same as revalidateTag without SWR)
  const encodedTag = encodeCacheTag(tag);
  _markPendingRevalidatedTag(encodedTag);
  return scheduleRevalidation(_invalidateEncodedTag(encodedTag));
}

/**
 * Opt out of static rendering and indicate a particular component should not be cached.
 *
 * In Next.js, calling noStore() inside a Server Component ensures the component
 * is dynamically rendered. In our implementation, this is a no-op since we don't
 * have the same static/dynamic rendering split — all server rendering is on-demand.
 * It's provided for API compatibility so apps importing it don't break.
 */
export function unstable_noStore(): void {
  if (isInsideUnstableCacheScope()) {
    return;
  }
  // Signal dynamic usage so ISR-configured routes bypass the cache
  _markDynamic();
}

// Also export as `noStore` (Next.js 15+ naming)
export { unstable_noStore as noStore };

/**
 * A fulfilled thenable that React can unwrap synchronously via `use()`
 * without ever suspending. Reusing a single instance avoids allocating
 * on every call — matching Next.js's browser/client implementation.
 *
 * @see https://github.com/vercel/next.js/blob/canary/packages/next/src/client/request/io.browser.ts
 */
const _resolvedIOPromise: Promise<void> = Promise.resolve(undefined);
(_resolvedIOPromise as unknown as Record<string, unknown>).status = "fulfilled";
(_resolvedIOPromise as unknown as Record<string, unknown>).value = undefined;

/**
 * Marks an IO boundary in server components by returning a resolved promise
 * during requests and a hanging promise during prerendering.
 *
 * See: https://github.com/vercel/next.js/pull/92521
 * Guard removed: https://github.com/vercel/next.js/pull/92923
 * Stabilized (renamed from unstable_io): https://github.com/vercel/next.js/pull/93621
 *
 * Ported from Next.js: packages/next/src/server/request/io.ts
 * https://github.com/vercel/next.js/blob/canary/packages/next/src/server/request/io.ts
 *
 * Behavior by work unit type:
 * - request → resolve immediately (no delay needed for dynamic SSR)
 * - prerender / prerender-client / prerender-runtime → hang (prevent
 *   execution past IO boundary during static generation)
 * - cache / private-cache / unstable-cache → resolve immediately
 *   (caches capture IO results at fill time)
 * - generate-static-params → resolve immediately (build time, no prerender to stall)
 * - prerender-legacy → resolve immediately (no cache components)
 *
 * When no work unit store is present (e.g. client-side, standalone script),
 * resolves immediately — matching the browser/client implementation.
 */
export function io(): Promise<void> {
  const workUnitStore = workUnitAsyncStorage.getStore();

  if (workUnitStore) {
    switch (workUnitStore.type) {
      case "request":
        return _resolvedIOPromise;
      case "prerender":
      case "prerender-client":
      case "prerender-runtime":
        // Prevent execution past the IO boundary during prerendering.
        // The hanging promise suspends React's render indefinitely until
        // the prerender is aborted or completed.
        return makeHangingPromise(
          workUnitStore.renderSignal,
          /* route */ workUnitStore.route ?? "unknown",
          "`io()`",
        );
      case "cache":
      case "private-cache":
      case "unstable-cache":
      case "generate-static-params":
      case "prerender-legacy":
        return _resolvedIOPromise;
      default:
        workUnitStore satisfies never;
        return _resolvedIOPromise;
    }
  }

  // No work store — outside rendering context (client, standalone script).
  return _resolvedIOPromise;
}

/**
 * @deprecated Use `io` instead. Kept as a transitional alias since vinext
 * shipped the unstable name longer than upstream Next.js (see #805). Will be
 * removed in a future minor.
 */
export function unstable_io(): Promise<void> {
  if (!_unstableIoWarned) {
    _unstableIoWarned = true;
    console.warn("[vinext] `unstable_io` is deprecated. Import `io` from 'next/cache' instead.");
  }
  return io();
}

let _unstableIoWarned = false;

// ---------------------------------------------------------------------------
// cacheLife / cacheTag — Next.js 15+ "use cache" APIs
// ---------------------------------------------------------------------------

/**
 * Set the cache lifetime for a "use cache" function.
 *
 * Accepts either a built-in profile name (e.g., "hours", "days") or a custom
 * configuration object. In Next.js, this only works inside "use cache" functions.
 *
 * When called inside a "use cache" function, this sets the cache TTL.
 * The "minimum-wins" rule applies: if called multiple times, the shortest
 * duration for each field wins.
 *
 * When called outside a "use cache" context, this is a validated no-op.
 */
export function cacheLife(profile: string | CacheLifeConfig): void {
  let resolvedConfig: CacheLifeConfig;

  if (typeof profile === "string") {
    // Validate the profile name exists
    if (!cacheLifeProfiles[profile]) {
      console.warn(
        `[vinext] cacheLife: unknown profile "${profile}". ` +
          `Available profiles: ${Object.keys(cacheLifeProfiles).join(", ")}`,
      );
      return;
    }
    resolvedConfig = { ...cacheLifeProfiles[profile] };
  } else if (typeof profile === "object" && profile !== null) {
    // Validate the config shape
    if (
      profile.expire !== undefined &&
      profile.revalidate !== undefined &&
      profile.expire < profile.revalidate
    ) {
      console.warn("[vinext] cacheLife: expire must be >= revalidate");
    }
    resolvedConfig = { ...cacheLifeProfiles.default, ...profile };
  } else {
    return;
  }

  // If we're inside a "use cache" context, push the config
  try {
    const ctx = getRegisteredCacheContext();
    if (ctx) {
      ctx.lifeConfigs.push(resolvedConfig);
      // Note: these flags are slightly misnamed — they really mean
      // "cacheLife() was called and the resolved config includes this field"
      // rather than "the user explicitly passed this field". Because we merge
      // user input over the default profile (`{ ...default, ...profile }`),
      // calling `cacheLife({ expire: 60 })` still resolves a `revalidate`
      // from the default profile, so `hasExplicitRevalidate` becomes true.
      // This matches Next.js, which tracks the flag at the work unit store
      // level (set when `cacheLife()` is called at all), not per-field. The
      // suppression semantics are correct: calling `cacheLife()` is itself
      // the explicit choice that opts the outer out of the nested-dynamic
      // throw, regardless of which fields the user specified.
      //
      // The `!== undefined` checks below are therefore effectively
      // unconditional in normal use: `resolvedConfig` always merges over the
      // default profile, which has both `revalidate` and `expire` set. They
      // remain as defensive guards in case `cacheLifeProfiles.default` is
      // ever overridden to omit a field, or a future refactor lets callers
      // pass `resolvedConfig` without the default merge. If per-field
      // suppression is ever desired (e.g. `cacheLife({ expire: 60 })`
      // suppressing only the expire-side throw), the flags would need to
      // inspect the *raw user input* rather than `resolvedConfig` — but
      // that would also diverge from Next.js semantics, so it should be a
      // deliberate, documented design change rather than an incidental one.
      if (resolvedConfig.revalidate !== undefined) ctx.hasExplicitRevalidate = true;
      if (resolvedConfig.expire !== undefined) ctx.hasExplicitExpire = true;
      _setRequestScopedCacheLife(resolvedConfig);
      return;
    }
  } catch {
    // Fall through to request-scoped
  }

  // Outside a "use cache" context (e.g., page component with file-level "use cache"):
  // store as request-scoped so the server can read it after rendering.
  _setRequestScopedCacheLife(resolvedConfig);
}

/**
 * Tag a "use cache" function's cached result for on-demand revalidation.
 *
 * Tags set here can be invalidated via revalidateTag(). In Next.js, this only
 * works inside "use cache" functions.
 *
 * When called inside a "use cache" function, tags are attached to the cached
 * entry. They can later be invalidated via revalidateTag().
 *
 * When called outside a "use cache" context, this is a no-op.
 */
export function cacheTag(...tags: string[]): void {
  try {
    const ctx = getRegisteredCacheContext();
    if (ctx) {
      ctx.tags.push(...encodeCacheTags(tags));
    }
  } catch {
    // Not in a cache context — no-op
  }
}

/**
 * @deprecated Use `cacheLife` instead. `unstable_cacheLife` was stabilized
 * upstream and the `unstable_`-prefixed name will be removed in a future
 * version of Next.js. Kept as a delegating alias for parity.
 *
 * Emits a one-time deprecation warning via `console.error` (matching Next.js),
 * then delegates to `cacheLife`.
 *
 * Ported from Next.js: packages/next/cache.js
 * https://github.com/vercel/next.js/blob/canary/packages/next/cache.js
 *
 * Asserted by Next.js test:
 * test/e2e/app-dir/cache-components-errors/cache-components-unstable-deprecations.test.ts
 */
let _unstableCacheLifeWarned = false;
export function unstable_cacheLife(profile: string | CacheLifeConfig): void {
  if (!_unstableCacheLifeWarned) {
    _unstableCacheLifeWarned = true;
    const error = new Error(
      "`unstable_cacheLife` was recently stabilized and should be imported as `cacheLife`. The `unstable` prefixed form will be removed in a future version of Next.js.",
    );
    console.error(error);
  }
  return cacheLife(profile);
}

/**
 * @deprecated Use `cacheTag` instead. `unstable_cacheTag` was stabilized
 * upstream and the `unstable_`-prefixed name will be removed in a future
 * version of Next.js. Kept as a delegating alias for parity.
 *
 * Emits a one-time deprecation warning via `console.error` (matching Next.js),
 * then delegates to `cacheTag`.
 *
 * Ported from Next.js: packages/next/cache.js
 * https://github.com/vercel/next.js/blob/canary/packages/next/cache.js
 *
 * Asserted by Next.js test:
 * test/e2e/app-dir/cache-components-errors/cache-components-unstable-deprecations.test.ts
 */
let _unstableCacheTagWarned = false;
export function unstable_cacheTag(...tags: string[]): void {
  if (!_unstableCacheTagWarned) {
    _unstableCacheTagWarned = true;
    const error = new Error(
      "`unstable_cacheTag` was recently stabilized and should be imported as `cacheTag`. The `unstable` prefixed form will be removed in a future version of Next.js.",
    );
    console.error(error);
  }
  return cacheTag(...tags);
}

// ---------------------------------------------------------------------------
// unstable_cache — the older caching API
// ---------------------------------------------------------------------------

/**
 * AsyncLocalStorage to track whether we're inside an unstable_cache() callback.
 * Stored on globalThis via Symbol so headers.ts can detect the scope without
 * a direct import (avoiding circular dependencies).
 */
const _unstableCacheAls = getOrCreateAls<boolean>("vinext.unstableCache.als");

/**
 * Wrapper used to serialize `unstable_cache` results so that `undefined` can
 * round-trip through JSON without confusion.  Using a structural wrapper
 * avoids any sentinel-string collision risk. The `v` / `undef` fields remain
 * readable by the previous Worker during a staged rollout and rollback, while
 * the version marker lets the new reader reject payloads written before the
 * cache-ownership boundary was enforced.
 */
type CacheResultWrapper = { version: 2; v: unknown } | { version: 2; undef: true };

function serializeUnstableCacheResult(value: unknown): string {
  const wrapper: CacheResultWrapper =
    value === undefined ? { version: 2, undef: true } : { version: 2, v: value };
  return JSON.stringify(wrapper);
}

function deserializeUnstableCacheResult(body: string): unknown {
  const wrapper = JSON.parse(body) as unknown;
  if (!wrapper || typeof wrapper !== "object" || Reflect.get(wrapper, "version") !== 2) {
    throw new Error("Unsupported unstable_cache entry version");
  }
  if (Reflect.get(wrapper, "undef") === true) return undefined;
  if (Reflect.has(wrapper, "v")) return Reflect.get(wrapper, "v");
  throw new Error("Invalid unstable_cache entry");
}

type UnstableCacheReadResult = { ok: true; value: unknown } | { ok: false };

function tryDeserializeUnstableCacheResult(body: string): UnstableCacheReadResult {
  try {
    return { ok: true, value: deserializeUnstableCacheResult(body) };
  } catch {
    return { ok: false };
  }
}

/**
 * Check if the current execution context is inside an unstable_cache() callback.
 * Used by headers(), cookies(), and connection() to throw errors when
 * dynamic request APIs are called inside a cache scope.
 */
export function isInsideUnstableCacheScope(): boolean {
  return _unstableCacheAls.getStore() === true;
}

type UnstableCacheOptions = {
  revalidate?: number | false;
  tags?: string[];
};

const _UNSTABLE_CACHE_PENDING_REVALIDATIONS_KEY = Symbol.for(
  "vinext.unstableCache.pendingRevalidations",
);
const _UNSTABLE_CACHE_PENDING_FILLS_KEY = Symbol.for("vinext.unstableCache.pendingFills");
const _UNSTABLE_CACHE_PENDING_FILL_KEY_CHARS_KEY = Symbol.for(
  "vinext.unstableCache.pendingFillKeyChars",
);
const _UNSTABLE_CACHE_POISONED_KEYS_KEY = Symbol.for("vinext.unstableCache.poisonedKeys");
const _UNSTABLE_CACHE_PUBLICATION_DISABLED_KEY = Symbol.for(
  "vinext.unstableCache.publicationDisabled",
);
const _UNSTABLE_CACHE_POISON_OVERFLOW_COUNT_KEY = Symbol.for(
  "vinext.unstableCache.poisonOverflowCount",
);

// A shared fill is only a short-lived stampede guard, not ownership of the
// callback's lifetime. Next.js defaults cache-fill detection to its static
// generation timeout (60 seconds); after the same bounded lease, later callers
// compute without waiting while the validated original retains publication
// ownership.
const UNSTABLE_CACHE_PENDING_FILL_LEASE_MS = 60_000;
const MAX_PENDING_UNSTABLE_CACHE_FILLS = 1_000;
const MAX_PENDING_UNSTABLE_CACHE_KEY_CHARS = 1_000_000;
const MAX_POISONED_UNSTABLE_CACHE_KEYS = 10_000;

type PendingUnstableCacheFill = {
  promise: Promise<unknown>;
  expiresAt: number;
  leaseTimer: ReturnType<typeof setTimeout>;
  poisonRegistration?: PoisonedUnstableCacheRegistration;
};

type PoisonedUnstableCacheRegistration = {
  overflow: boolean;
  token: string;
};

function getPendingUnstableCacheRevalidations(): Map<string, Promise<void>> {
  const existing = _g[_UNSTABLE_CACHE_PENDING_REVALIDATIONS_KEY];
  if (existing instanceof Map) return existing;

  const pending = new Map<string, Promise<void>>();
  _g[_UNSTABLE_CACHE_PENDING_REVALIDATIONS_KEY] = pending;
  return pending;
}

function getPendingUnstableCacheFills(): Map<string, PendingUnstableCacheFill> {
  const existing = _g[_UNSTABLE_CACHE_PENDING_FILLS_KEY];
  if (existing instanceof Map) {
    return existing as Map<string, PendingUnstableCacheFill>;
  }

  const pending = new Map<string, PendingUnstableCacheFill>();
  _g[_UNSTABLE_CACHE_PENDING_FILLS_KEY] = pending;
  return pending;
}

function getPendingUnstableCacheKeyChars(pending: Map<string, PendingUnstableCacheFill>): number {
  const existing = _g[_UNSTABLE_CACHE_PENDING_FILL_KEY_CHARS_KEY];
  if (typeof existing === "number" && existing >= 0) return existing;
  let total = 0;
  for (const key of pending.keys()) total += key.length;
  _g[_UNSTABLE_CACHE_PENDING_FILL_KEY_CHARS_KEY] = total;
  return total;
}

function addPendingUnstableCacheFill(
  pending: Map<string, PendingUnstableCacheFill>,
  cacheKey: string,
  entry: PendingUnstableCacheFill,
): void {
  const previousTotal = getPendingUnstableCacheKeyChars(pending);
  pending.set(cacheKey, entry);
  _g[_UNSTABLE_CACHE_PENDING_FILL_KEY_CHARS_KEY] = previousTotal + cacheKey.length;
}

function deletePendingUnstableCacheFill(
  pending: Map<string, PendingUnstableCacheFill>,
  cacheKey: string,
  entry: PendingUnstableCacheFill,
): boolean {
  if (pending.get(cacheKey) !== entry) return false;
  const previousTotal = getPendingUnstableCacheKeyChars(pending);
  pending.delete(cacheKey);
  _g[_UNSTABLE_CACHE_PENDING_FILL_KEY_CHARS_KEY] = Math.max(0, previousTotal - cacheKey.length);
  return true;
}

function canRetainPendingUnstableCacheFill(
  pending: Map<string, PendingUnstableCacheFill>,
  cacheKey: string,
): boolean {
  return (
    pending.size < MAX_PENDING_UNSTABLE_CACHE_FILLS &&
    getPendingUnstableCacheKeyChars(pending) + cacheKey.length <=
      MAX_PENDING_UNSTABLE_CACHE_KEY_CHARS
  );
}

function getPoisonedUnstableCacheKeys(): Map<string, number> {
  const existing = _g[_UNSTABLE_CACHE_POISONED_KEYS_KEY];
  if (existing instanceof Map) return existing as Map<string, number>;

  const poisoned = new Map<string, number>();
  _g[_UNSTABLE_CACHE_POISONED_KEYS_KEY] = poisoned;
  return poisoned;
}

function isUnstableCachePublicationDisabled(): boolean {
  return _g[_UNSTABLE_CACHE_PUBLICATION_DISABLED_KEY] === true;
}

function isUnstableCacheKeyPoisoned(cacheKey: string): boolean {
  if (isUnstableCachePublicationDisabled()) return true;
  const poisoned = _g[_UNSTABLE_CACHE_POISONED_KEYS_KEY];
  return poisoned instanceof Map && poisoned.size > 0 && poisoned.has(fnv1a64(cacheKey));
}

/**
 * Fail closed after a shared fill outlives its lease. The lease only bounds
 * single-flight sharing; it does not revoke a validated original fill's right
 * to publish. New callers bypass shared reads and writes until that original
 * settles, so no replacement publication can be overwritten by the old fill.
 *
 * Fixed-size key tokens bound retained memory; collisions only cause a safe,
 * temporary extra bypass. If the registry fills, disable publication until all
 * overflow registrations settle rather than forgetting an outstanding writer.
 */
function poisonUnstableCacheKey(cacheKey: string): PoisonedUnstableCacheRegistration {
  const token = fnv1a64(cacheKey);
  const poisoned = getPoisonedUnstableCacheKeys();
  const existingCount = poisoned.get(token);
  if (existingCount !== undefined) {
    poisoned.set(token, existingCount + 1);
    return { overflow: false, token };
  }
  if (poisoned.size >= MAX_POISONED_UNSTABLE_CACHE_KEYS) {
    const overflowCount = _g[_UNSTABLE_CACHE_POISON_OVERFLOW_COUNT_KEY];
    _g[_UNSTABLE_CACHE_POISON_OVERFLOW_COUNT_KEY] =
      (typeof overflowCount === "number" ? overflowCount : 0) + 1;
    _g[_UNSTABLE_CACHE_PUBLICATION_DISABLED_KEY] = true;
    return { overflow: true, token };
  }
  poisoned.set(token, 1);
  return { overflow: false, token };
}

function releasePoisonedUnstableCacheKey(registration: PoisonedUnstableCacheRegistration): void {
  if (registration.overflow) {
    const current = _g[_UNSTABLE_CACHE_POISON_OVERFLOW_COUNT_KEY];
    const next = Math.max(0, (typeof current === "number" ? current : 0) - 1);
    _g[_UNSTABLE_CACHE_POISON_OVERFLOW_COUNT_KEY] = next;
    if (next === 0) _g[_UNSTABLE_CACHE_PUBLICATION_DISABLED_KEY] = false;
    return;
  }

  const poisoned = getPoisonedUnstableCacheKeys();
  const current = poisoned.get(registration.token);
  if (current === undefined) return;
  if (current === 1) poisoned.delete(registration.token);
  else poisoned.set(registration.token, current - 1);
}

function waitUntilUnstableCacheRevalidation(promise: Promise<void>): void {
  if (!isInsideUnifiedScope()) return;
  getRequestContext().executionContext?.waitUntil(promise);
}

function scheduleUnstableCacheBackgroundRevalidation(
  cacheKey: string,
  refresh: () => Promise<unknown>,
): void {
  const pending = getPendingUnstableCacheRevalidations();
  if (pending.has(cacheKey)) return;

  const revalidation = refresh()
    .then(() => undefined)
    .catch((err) => {
      console.error(`[vinext] unstable_cache background revalidation failed for ${cacheKey}:`, err);
    });
  const trackedRevalidation = revalidation.finally(() => {
    if (pending.get(cacheKey) === trackedRevalidation) {
      pending.delete(cacheKey);
    }
  });

  pending.set(cacheKey, trackedRevalidation);
  waitUntilUnstableCacheRevalidation(trackedRevalidation);
}

async function refreshUnstableCacheResult<Args extends unknown[], Result>(
  fn: (...args: Args) => Promise<Result>,
  args: Args,
  cacheKey: string,
  tags: string[],
  revalidateSeconds: number | false | undefined,
  canPublish: () => boolean,
): Promise<Result> {
  const result = await _unstableCacheAls.run(true, () => fn(...args));
  const invalidDynamicUsageError = peekInvalidDynamicUsageError();
  if (invalidDynamicUsageError !== null && invalidDynamicUsageError !== undefined) {
    throw invalidDynamicUsageError;
  }

  if (!canPublish()) return result;

  const cacheValue: CachedFetchValue = {
    kind: "FETCH",
    data: {
      headers: {},
      body: serializeUnstableCacheResult(result),
      url: cacheKey,
    },
    tags,
    // revalidate: false means "cache indefinitely" (no time-based expiry).
    // A positive number means time-based revalidation in seconds.
    // When unset (undefined), default to false (indefinite) matching
    // Next.js behavior for unstable_cache without explicit revalidate.
    revalidate: typeof revalidateSeconds === "number" ? revalidateSeconds : false,
  };

  const handler = getDataCacheHandler();
  const context = {
    fetchCache: true,
    tags,
    revalidate: revalidateSeconds,
  };
  await handler.set(cacheKey, cacheValue, context);

  return result;
}

function fillUnstableCacheResult<Args extends unknown[], Result>(
  fn: (...args: Args) => Promise<Result>,
  args: Args,
  cacheKey: string,
  tags: string[],
  revalidateSeconds: number | false | undefined,
): Promise<Result> {
  const pending = getPendingUnstableCacheFills();
  const existing = pending.get(cacheKey);
  if (existing && existing.expiresAt > Date.now()) {
    return observeUnstableCacheFill(existing.promise as Promise<Result>);
  }
  if (existing) {
    clearTimeout(existing.leaseTimer);
    if (deletePendingUnstableCacheFill(pending, cacheKey, existing)) {
      existing.poisonRegistration = poisonUnstableCacheKey(cacheKey);
    }
    return refreshUnstableCacheResult(fn, args, cacheKey, tags, revalidateSeconds, () => false);
  }

  if (!canRetainPendingUnstableCacheFill(pending, cacheKey)) {
    return refreshUnstableCacheResult(fn, args, cacheKey, tags, revalidateSeconds, () => false);
  }

  let entry: PendingUnstableCacheFill;
  const canPublish = () => !isUnstableCachePublicationDisabled();
  const fill = refreshUnstableCacheResult(fn, args, cacheKey, tags, revalidateSeconds, canPublish);
  const trackedFill = fill.finally(() => {
    deletePendingUnstableCacheFill(pending, cacheKey, entry);
    clearTimeout(entry.leaseTimer);
    if (entry.poisonRegistration) {
      releasePoisonedUnstableCacheKey(entry.poisonRegistration);
    }
  });
  const leaseTimer = setTimeout(() => {
    if (deletePendingUnstableCacheFill(pending, cacheKey, entry)) {
      entry.poisonRegistration = poisonUnstableCacheKey(cacheKey);
    }
  }, UNSTABLE_CACHE_PENDING_FILL_LEASE_MS);
  // Do not keep a Node.js process alive solely for an in-isolate stampede
  // lease. Cloudflare's numeric timer handle intentionally has no `unref`.
  if (typeof leaseTimer === "object" && "unref" in leaseTimer) {
    leaseTimer.unref();
  }
  entry = {
    promise: trackedFill,
    expiresAt: Date.now() + UNSTABLE_CACHE_PENDING_FILL_LEASE_MS,
    leaseTimer,
  };
  addPendingUnstableCacheFill(pending, cacheKey, entry);
  return observeUnstableCacheFill(trackedFill);
}

async function observeUnstableCacheFill<Result>(fill: Promise<Result>): Promise<Result> {
  try {
    return await fill;
  } catch (error) {
    if (isInvalidDynamicUsageError(error)) {
      recordInvalidDynamicUsageError(error);
    }
    throw error;
  }
}

/**
 * Wrap an async function with caching.
 *
 * Returns a new function that caches results. The cache key is derived
 * from keyParts + serialized arguments.
 */
// oxlint-disable-next-line @typescript-eslint/no-explicit-any
export function unstable_cache<T extends (...args: any[]) => Promise<any>>(
  fn: T,
  keyParts?: string[],
  options?: UnstableCacheOptions,
): T {
  const baseKey = keyParts ? keyParts.join(":") : fnv1a64(fn.toString());
  // Warning: fn.toString() as a cache key is minification-sensitive. In
  // production builds where the function body is mangled, two logically
  // different functions may hash to the same key, or the same function may
  // hash differently across builds. Always pass explicit keyParts in
  // production to get a stable, collision-free cache key.
  const tags = encodeCacheTags(options?.tags ?? []);
  const revalidateSeconds = options?.revalidate;

  const cachedFn = async (...args: Parameters<T>) => {
    const argsKey = JSON.stringify(args);
    const cacheKey = `unstable_cache:${baseKey}:${argsKey}`;
    addCollectedRequestTags(tags);
    recordUnstableCacheObservation({
      kind: "unstable_cache",
      keyHash: fnv1a64(cacheKey),
      revalidate:
        typeof revalidateSeconds === "number"
          ? revalidateSeconds
          : revalidateSeconds === false
            ? false
            : null,
      tagCount: tags.length,
      tagHash: tags.length > 0 ? fnv1a64(JSON.stringify(tags)) : null,
    });

    const isDraftMode = isDraftModeEnabled();
    const isPoisoned = isUnstableCacheKeyPoisoned(cacheKey);
    if (!isDraftMode && !isPoisoned) {
      // Try to get from cache. Stale entries are usable in normal App Router
      // requests, but foreground-refresh inside revalidation scopes so the
      // regenerated page/route stores fresh data.
      const softTags = getCurrentFetchSoftTags();
      const existing = _hasPendingRevalidatedTag([...tags, ...softTags])
        ? null
        : await getDataCacheHandler().get(cacheKey, {
            kind: "FETCH",
            tags,
            softTags,
          });
      if (existing?.value && existing.value.kind === "FETCH") {
        const cached = tryDeserializeUnstableCacheResult(existing.value.data.body);
        if (cached.ok) {
          if (existing.cacheState === "stale") {
            if (shouldServeStaleUnstableCacheEntry()) {
              scheduleUnstableCacheBackgroundRevalidation(cacheKey, () =>
                refreshUnstableCacheResult(
                  fn,
                  args,
                  cacheKey,
                  tags,
                  revalidateSeconds,
                  () => !isUnstableCacheKeyPoisoned(cacheKey),
                ),
              );
              return cached.value;
            }
          } else {
            return cached.value;
          }
        }
        // Corrupted entries fall through to a foreground refresh.
      }
    }

    // Cache miss — call the function inside the unstable_cache ALS scope
    // so that headers()/cookies()/connection() can detect they're in a
    // cache scope and throw an appropriate error.
    if (isDraftMode || isPoisoned) {
      return await refreshUnstableCacheResult(
        fn,
        args,
        cacheKey,
        tags,
        revalidateSeconds,
        () => false,
      );
    }
    return await fillUnstableCacheResult(fn, args, cacheKey, tags, revalidateSeconds);
  };

  return cachedFn as T;
}
