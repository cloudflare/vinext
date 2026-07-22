/**
 * ISR (Incremental Static Regeneration) cache layer.
 *
 * Wraps the pluggable CacheHandler with stale-while-revalidate semantics:
 * - Fresh hit: serve immediately
 * - Stale hit: serve immediately + trigger background regeneration
 * - Miss: render synchronously, cache, serve
 *
 * Background regeneration is deduped — only one regeneration per cache key
 * runs at a time, preventing thundering herd on popular pages.
 *
 * This layer works with any CacheHandler backend (memory, Redis, KV, etc.)
 * because it only uses the standard get/set interface.
 */

import {
  type CacheHandlerValue,
  type IncrementalCacheValue,
  type CachedPagesValue,
  type CachedAppPageValue,
} from "vinext/shims/cache-handler";
import { getCdnCacheAdapter } from "vinext/shims/cdn-cache";
import { fnv1a64 } from "../utils/hash.js";
import { getRequestExecutionContext } from "vinext/shims/request-context";
import { reportRequestError, type OnRequestErrorContext } from "./instrumentation.js";
import { normalizeMountedSlotsHeader } from "./app-mounted-slots-header.js";
import {
  APP_RSC_RENDER_MODE_NAVIGATION,
  getRscRenderModeCacheVariant,
  type AppRscRenderMode,
} from "./app-rsc-render-mode.js";
import { normalizeAppPageInterceptionProofPathname } from "./app-page-render-identity.js";
import type { RenderObservation } from "./cache-proof.js";
import {
  PRERENDER_REVALIDATE_HEADER,
  PRERENDER_REVALIDATE_ONLY_GENERATED_HEADER,
} from "../utils/protocol-headers.js";
export { normalizeMountedSlotsHeader };

/**
 * Header set on the internal request that `res.revalidate()` issues to
 * trigger on-demand ISR regeneration of a Pages Router route. Mirrors Next.js's
 * `PRERENDER_REVALIDATE_HEADER` (`x-prerender-revalidate`) — see
 * `.nextjs-ref/packages/next/src/lib/constants.ts`.
 *
 * SECURITY: in Next.js this header is NOT a presence flag — it carries the
 * secret `previewModeId`, and `checkIsOnDemandRevalidate`
 * (`.nextjs-ref/packages/next/src/server/api-utils/index.ts`) only treats a
 * request as on-demand revalidation when the value *equals* that secret. If we
 * gated on presence alone, any external client could send
 * `x-prerender-revalidate: <anything>` to force synchronous regeneration of any
 * ISR page, bypassing the fresh/stale cache short-circuits — a
 * cache-stampede/DoS vector. We therefore validate the value against
 * {@link getRevalidateSecret} (a build-time secret shared across all Workers
 * isolates) with a constant-time comparison, and only the matching value (sent
 * by our own `res.revalidate()`) is honored.
 */
export { PRERENDER_REVALIDATE_HEADER };

/**
 * Companion header to {@link PRERENDER_REVALIDATE_HEADER}. When set,
 * `res.revalidate(path, { unstable_onlyGenerated: true })` only revalidates the
 * path if it was already generated, and a 404 response counts as a successful
 * no-op. Mirrors Next.js's `PRERENDER_REVALIDATE_ONLY_GENERATED_HEADER`
 * (`x-prerender-revalidate-if-generated`) — see
 * `.nextjs-ref/packages/next/src/lib/constants.ts`.
 */
export { PRERENDER_REVALIDATE_ONLY_GENERATED_HEADER };

/**
 * Build-time secret that authenticates on-demand revalidation requests, the
 * vinext analog of Next.js's prerender-manifest `previewModeId`.
 *
 * `res.revalidate()` loops back into the server via an internal `fetch()`. On
 * Cloudflare Workers that loopback can land on a *different* isolate than the
 * sender, so a per-process random secret would mismatch across isolates and
 * false-reject legitimate revalidations (and, symmetrically, two isolates with
 * independently-rolled secrets could never agree). The fix mirrors Next.js's
 * `previewModeId`: the secret is generated once at BUILD time and baked
 * (server-only — never into the client bundle) into every server bundle via the
 * `__VINEXT_REVALIDATE_SECRET` Vite `define`, so it is byte-for-byte identical in
 * every isolate. See `vinext build` CLI (`__VINEXT_SHARED_REVALIDATE_SECRET`) and
 * the `vinext:compiler-define-server` plugin. The sender attaches it as the
 * {@link PRERENDER_REVALIDATE_HEADER} value; the receiver authorizes a request
 * only when the incoming value equals this secret (see
 * {@link isOnDemandRevalidateRequest}).
 *
 * When the build-time define is absent — dev mode, and any path that doesn't
 * run through `vinext build` — we fall back to a lazily-generated random secret.
 * Those paths are single-process, but Vite can evaluate this module separately
 * in its RSC and SSR module graphs. Store the fallback on `globalThis` under a
 * registry symbol so every module copy in the process reads the same value.
 */
const _DEV_REVALIDATE_SECRET_KEY = Symbol.for("vinext.isrCache.devRevalidateSecret");

export function getRevalidateSecret(): string {
  // Production: the build baked the shared secret into every server bundle.
  // `process.env.__VINEXT_REVALIDATE_SECRET` is statically inlined by Vite's
  // `define`, so this is a constant string identical across all isolates.
  const baked = process.env.__VINEXT_REVALIDATE_SECRET;
  if (baked) return baked;

  // Dev/standalone fallback: no build-time define. Generate a single
  // process-shared secret lazily. 32 random bytes (256 bits) hex-encoded match
  // the build-time secret's entropy. Web Crypto's `getRandomValues` works in
  // both Node and the Workers/edge runtime.
  const globals = globalThis as unknown as Record<PropertyKey, unknown>;
  const existing = globals[_DEV_REVALIDATE_SECRET_KEY];
  if (typeof existing === "string") return existing;

  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const secret = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  globals[_DEV_REVALIDATE_SECRET_KEY] = secret;
  return secret;
}

/**
 * Constant-time string equality. Avoids leaking secret length / prefix via
 * early-exit timing on the on-demand revalidation auth check. Returns false
 * for length mismatch (the only safe option without revealing the secret
 * length, and equality is impossible anyway).
 */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

export function isRevalidateSecret(value: string | null | undefined): boolean {
  if (typeof value !== "string" || value.length === 0) return false;
  return safeEqual(value, getRevalidateSecret());
}

/**
 * Authorize an incoming request as an on-demand revalidation trigger. Mirrors
 * Next.js's `checkIsOnDemandRevalidate`: the {@link PRERENDER_REVALIDATE_HEADER}
 * value must *equal* the process revalidate secret. Header presence alone is
 * NOT sufficient — see the security note on {@link PRERENDER_REVALIDATE_HEADER}.
 */
export function isOnDemandRevalidateRequest(
  headerValue: string | string[] | null | undefined,
): boolean {
  // Reject arrays (duplicate headers) and absent values outright.
  if (typeof headerValue !== "string") return false;
  return isRevalidateSecret(headerValue);
}

export type ISRCacheEntry = {
  value: CacheHandlerValue;
  isStale: boolean;
  /** The entry crossed its hard expire boundary and must not be served. */
  isExpired?: boolean;
};

/**
 * Get a cache entry with staleness information.
 *
 * Returns { value, isStale: false } for fresh entries,
 * { value, isStale: true } for stale-but-usable entries,
 * { value, isStale: true, isExpired: true } for entries that must be retained
 * as regeneration input but not served, or null for cache misses.
 */
export async function isrGet(key: string): Promise<ISRCacheEntry | null> {
  // Page-level reads go through the CDN cache adapter. The default adapter
  // reads the data cache; an edge adapter may return null so the CDN serves.
  const result = await getCdnCacheAdapter().get(key);
  if (!result) return null;
  const isExpired = result.cacheState === "expired";

  return {
    value: result,
    isStale: isExpired || result.cacheState === "stale",
    ...(isExpired ? { isExpired: true } : {}),
  };
}

/**
 * Store a value in the ISR cache with a revalidation period.
 */
export async function isrSet(
  key: string,
  data: IncrementalCacheValue | null,
  revalidateSeconds: number | false,
  tags?: string[],
  expireSeconds?: number,
): Promise<void> {
  await getCdnCacheAdapter().set(key, data, {
    cacheControl:
      expireSeconds === undefined
        ? { revalidate: revalidateSeconds }
        : { revalidate: revalidateSeconds, expire: expireSeconds },
    // `revalidate` is the legacy vinext CacheHandler context field. `expire`
    // is new metadata and intentionally only lives inside cacheControl.
    revalidate: revalidateSeconds,
    tags: tags ?? [],
  });
}

export async function isrSetPrerenderedAppPage(
  key: string,
  data: CachedAppPageValue,
  metadata: {
    expireSeconds?: number;
    revalidateSeconds?: number;
    /**
     * Implicit/path tags to attach to the seeded entry. Required so that
     * `revalidatePath()` (and `revalidateTag()`) can invalidate prerender-seeded
     * cache entries — without tags the entry is unreachable by tag-based
     * invalidation and remains stale until natural `revalidateAt` expiry.
     * See cloudflare/vinext#1486.
     */
    tags?: string[];
  },
): Promise<void> {
  const revalidateSeconds = metadata.revalidateSeconds;
  const tags = metadata.tags;
  if (process.env.NEXT_PRIVATE_DEBUG_CACHE) {
    console.debug("[vinext] ISR: seed", key);
  }
  // Route page-level seeding through the CDN cache adapter (default adapter
  // writes the data cache; edge adapters no-op). Merge in main's tag support
  // (cloudflare/vinext#1486) so prerender-seeded entries are reachable by
  // revalidatePath()/revalidateTag().
  const ctx: Record<string, unknown> = {};
  if (revalidateSeconds !== undefined) {
    ctx.revalidate = revalidateSeconds;
    ctx.cacheControl =
      metadata.expireSeconds === undefined
        ? { revalidate: revalidateSeconds }
        : { revalidate: revalidateSeconds, expire: metadata.expireSeconds };
  }
  if (tags && tags.length > 0) {
    ctx.tags = tags;
  }
  await getCdnCacheAdapter().set(key, data, ctx);

  if (revalidateSeconds !== undefined) {
    setRevalidateDuration(key, revalidateSeconds);
  }
}

// ---------------------------------------------------------------------------
// Background regeneration dedup — one in-flight regeneration per cache key.
// Uses Symbol.for() on globalThis so the map is shared across Vite's
// separate RSC and SSR module instances.
// ---------------------------------------------------------------------------

const _PENDING_REGEN_KEY = Symbol.for("vinext.isrCache.pendingRegenerations");
const _g = globalThis as unknown as Record<PropertyKey, unknown>;
const pendingRegenerations = (_g[_PENDING_REGEN_KEY] ??= new Map<string, Promise<void>>()) as Map<
  string,
  Promise<void>
>;

// Keep on-demand work in a distinct batch from ordinary/stale regeneration.
// This mirrors Next.js ResponseCache's `{ key, isOnDemandRevalidate }` batch
// key: concurrent `res.revalidate()` calls for the same page share one render,
// while normal traffic remains free to read the existing representation.
const _PENDING_ON_DEMAND_REGEN_KEY = Symbol.for("vinext.isrCache.pendingOnDemandRegenerations");
const pendingOnDemandRegenerations = (_g[_PENDING_ON_DEMAND_REGEN_KEY] ??= new Map<
  string,
  Promise<unknown>
>()) as Map<string, Promise<unknown>>;

/** Coalesce same-key synchronous on-demand revalidations. */
export function coalesceOnDemandRevalidation<T>(
  key: string,
  renderFn: () => Promise<T>,
): Promise<T> {
  const pending = pendingOnDemandRegenerations.get(key) as Promise<T> | undefined;
  if (pending) return pending;

  // Defer invocation until after the promise is registered, matching Next.js's
  // response-cache scheduler and closing the same-tick stampede window.
  const promise = Promise.resolve()
    .then(renderFn)
    .finally(() => {
      if (pendingOnDemandRegenerations.get(key) === promise) {
        pendingOnDemandRegenerations.delete(key);
      }
    });
  pendingOnDemandRegenerations.set(key, promise);
  return promise;
}

/**
 * Trigger a background regeneration for a cache key.
 *
 * If a regeneration for this key is already in progress, this is a no-op.
 * The renderFn should produce the new cache value and call isrSet internally.
 *
 * On Cloudflare Workers the regeneration promise is registered with
 * `ctx.waitUntil()` via the ALS-backed ExecutionContext, keeping the isolate
 * alive until the regeneration completes even after the Response is returned.
 *
 * When `errorContext` is provided and the render function fails, the error
 * is reported via `reportRequestError` (instrumentation hook) with
 * `revalidateReason: "stale"`.
 */
export function triggerBackgroundRegeneration(
  key: string,
  renderFn: () => Promise<void>,
  errorContext?: {
    routerKind: OnRequestErrorContext["routerKind"];
    routePath: string;
    routeType: OnRequestErrorContext["routeType"];
  },
): void {
  // Edge-managed CDN adapters revalidate by re-requesting the origin, so the
  // origin must not also run in-process regeneration.
  if (!getCdnCacheAdapter().ownsBackgroundRevalidation) return;
  if (pendingRegenerations.has(key)) return;

  const promise = renderFn()
    .catch((err) => {
      console.error(`[vinext] ISR background regeneration failed for ${key}:`, err);
      if (errorContext) {
        void reportRequestError(
          err instanceof Error ? err : new Error(String(err)),
          { path: key, method: "GET", headers: {} },
          {
            routerKind: errorContext.routerKind,
            routePath: errorContext.routePath,
            routeType: errorContext.routeType,
            revalidateReason: "stale",
          },
        );
      }
    })
    .finally(() => {
      pendingRegenerations.delete(key);
    });

  pendingRegenerations.set(key, promise);

  // Register with the Workers ExecutionContext (retrieved from ALS) so the
  // runtime keeps the isolate alive until the regeneration completes, even
  // after the Response has already been sent to the client.
  getRequestExecutionContext()?.waitUntil(promise);
}

// ---------------------------------------------------------------------------
// Helpers for building ISR cache values
// ---------------------------------------------------------------------------

/**
 * Build a CachedPagesValue for the Pages Router ISR cache.
 */
export function buildPagesCacheValue(
  html: string,
  pageData: object,
  status?: number,
): CachedPagesValue {
  return {
    kind: "PAGES",
    html,
    pageData,
    headers: undefined,
    status,
  };
}

/**
 * Build a CachedAppPageValue for the App Router ISR cache.
 */
export function buildAppPageCacheValue(
  html: string,
  rscData?: ArrayBuffer,
  status?: number,
  renderObservation?: RenderObservation,
  headers?: CachedAppPageValue["headers"],
): CachedAppPageValue {
  const value: CachedAppPageValue = {
    kind: "APP_PAGE",
    html,
    rscData,
    headers,
    postponed: undefined,
    status,
  };
  if (renderObservation) {
    value.renderObservation = renderObservation;
  }
  return value;
}

function normalizeCachePathname(pathname: string): string {
  return pathname === "/" ? "/" : pathname.replace(/\/$/, "");
}

function buildCacheKey(prefix: string, pathname: string, suffix?: string): string {
  const normalized = normalizeCachePathname(pathname);
  const suffixPart = suffix ? `:${suffix}` : "";
  const key = `${prefix}:${normalized}${suffixPart}`;
  if (key.length <= 200) return key;
  return `${prefix}:__hash:${fnv1a64(normalized)}${suffixPart}`;
}

/**
 * Compute an ISR cache key for a given router type and pathname.
 * Long pathnames are hashed to stay within KV key-length limits (512 bytes).
 */
export function isrCacheKey(router: string, pathname: string, buildId?: string): string {
  const prefix = buildId ? `${router}:${buildId}` : router;
  return buildCacheKey(prefix, pathname);
}

/**
 * Compute an App Router ISR key for one cache artifact.
 *
 * App pages store HTML, RSC payloads, and route-handler responses separately.
 * The suffix mirrors Next.js's separate on-disk app artifacts while keeping the
 * Cloudflare KV key under its 512-byte limit for long pathnames.
 */
export function appIsrCacheKey(
  pathname: string,
  suffix: string,
  buildId = process.env.__VINEXT_BUILD_ID,
): string {
  const prefix = buildId ? `app:${buildId}` : "app";
  return buildCacheKey(prefix, pathname, suffix);
}

export function appIsrHtmlKey(pathname: string): string {
  return appIsrCacheKey(pathname, "html");
}

function normalizeInterceptionContextForCacheKey(interceptionContext: string): string | null {
  return normalizeAppPageInterceptionProofPathname(interceptionContext);
}

/**
 * Build the ISR cache key for an RSC payload.
 *
 * Variants are sequenced in order: `source:<hash>` (intercepted source context,
 * only when an interception context is present), `slots:<hash>` (mounted parallel
 * route slots), and optionally `<render-mode-variant>` (for example,
 * `prefetch-loading-shell`). Existing cached entries under the old format will
 * become unreachable after deployment. This is acceptable because ISR entries
 * have TTLs and will be regenerated on the next request.
 */
export function appIsrRscKey(
  pathname: string,
  mountedSlotsHeader?: string | null,
  renderMode: AppRscRenderMode = APP_RSC_RENDER_MODE_NAVIGATION,
  interceptionContext?: string | null,
): string {
  const normalizedMountedSlotsHeader = normalizeMountedSlotsHeader(mountedSlotsHeader);
  const sourceVariant =
    interceptionContext === undefined || interceptionContext === null
      ? null
      : normalizeInterceptionContextForCacheKey(interceptionContext);
  const variant = [
    sourceVariant ? `source:${fnv1a64(sourceVariant)}` : null,
    normalizedMountedSlotsHeader ? `slots:${fnv1a64(normalizedMountedSlotsHeader)}` : null,
    getRscRenderModeCacheVariant(renderMode),
  ]
    .filter((part) => part !== null)
    .join(":");
  return appIsrCacheKey(pathname, variant ? `rsc:${variant}` : "rsc");
}

export function appIsrRouteKey(pathname: string): string {
  return appIsrCacheKey(pathname, "route");
}

// ---------------------------------------------------------------------------
// Revalidate duration tracking — remembers how long each ISR key's TTL is
// so we can emit correct Cache-Control headers on cache hits.
// ---------------------------------------------------------------------------

const MAX_REVALIDATE_ENTRIES = 10_000;
const _REVALIDATE_KEY = Symbol.for("vinext.isrCache.revalidateDurations");
const revalidateDurations = (_g[_REVALIDATE_KEY] ??= new Map<string, number>()) as Map<
  string,
  number
>;

/**
 * Store the revalidate duration for a cache key.
 * Uses insertion-order LRU eviction to prevent unbounded growth.
 */
export function setRevalidateDuration(key: string, seconds: number): void {
  // Simple LRU: delete and re-insert to move to end (most recent)
  revalidateDurations.delete(key);
  revalidateDurations.set(key, seconds);
  // Evict oldest entries if over limit
  while (revalidateDurations.size > MAX_REVALIDATE_ENTRIES) {
    const first = revalidateDurations.keys().next().value;
    if (first !== undefined) revalidateDurations.delete(first);
    else break;
  }
}

/**
 * Get the revalidate duration for a cache key.
 */
export function getRevalidateDuration(key: string): number | undefined {
  return revalidateDurations.get(key);
}
