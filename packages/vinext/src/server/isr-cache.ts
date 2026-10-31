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

import { createHash } from "node:crypto";
import {
  type CacheControlMetadata,
  type CacheHandlerValue,
  type IncrementalCacheValue,
  type CachedPagesValue,
  type CachedAppPageValue,
} from "vinext/shims/cache-handler";
import { getCdnCacheAdapter } from "vinext/shims/cdn-cache";
import { getExplicitCdnCacheAdapter } from "vinext/shims/cdn-cache-state";
import { normalizePathnameForRouteMatch } from "../routing/utils.js";
import { getRequestExecutionContext } from "vinext/shims/request-context";
import { reportRequestError, type OnRequestErrorContext } from "./instrumentation.js";
import { shareIsolatePromise } from "./isolate-shared-promise.js";
import { normalizeMountedSlotsHeader } from "./app-mounted-slots-header.js";
import {
  APP_RSC_RENDER_MODE_NAVIGATION,
  getRscRenderModeCacheVariant,
  type AppRscRenderMode,
} from "./app-rsc-render-mode.js";
import { isInterceptionMatchedUrlPath } from "./normalize-path.js";
import type { RenderObservation } from "./cache-proof.js";
import { PRERENDER_REVALIDATE_ONLY_GENERATED_HEADER } from "../utils/protocol-headers.js";
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
export {
  getRevalidateSecret,
  isOnDemandRevalidateRequest,
  isRevalidateSecret,
  PRERENDER_REVALIDATE_HEADER,
} from "./revalidation-request.js";

/**
 * Companion header to {@link PRERENDER_REVALIDATE_HEADER}. When set,
 * `res.revalidate(path, { unstable_onlyGenerated: true })` only revalidates the
 * path if it was already generated, and a 404 response counts as a successful
 * no-op. Mirrors Next.js's `PRERENDER_REVALIDATE_ONLY_GENERATED_HEADER`
 * (`x-prerender-revalidate-if-generated`) — see
 * `.nextjs-ref/packages/next/src/lib/constants.ts`.
 */
export { PRERENDER_REVALIDATE_ONLY_GENERATED_HEADER };

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
  return toIsrCacheEntry(await getCdnCacheAdapter().get(key));
}

/**
 * Read a PPR fallback shell. A shell is never a response by itself, so an edge
 * can't serve it: like Next.js's fallback entries, shells live in the data
 * cache on every backend. An adapter that packages the build's shells, such
 * as Static Assets, is read when the data cache has none.
 */
export async function isrGetFallbackShell(key: string): Promise<ISRCacheEntry | null> {
  const { getDataCacheHandler } = await import("vinext/shims/cache-handler");
  const stored = await getDataCacheHandler().get(key);
  if (stored) return toIsrCacheEntry(stored);
  const packaged = await getExplicitCdnCacheAdapter()?.get(key);
  return toIsrCacheEntry(packaged ? withPackagedCacheState(packaged) : null);
}

/**
 * A packaged shell can't see `revalidatePath()` or `revalidateTag()`, so it is
 * served stale: reading it stores a replacement in the data cache, where they
 * act, and an invalidation that drops that replacement serves the packaged
 * shell stale again instead of fresh. Past its expire it is a miss.
 */
function withPackagedCacheState(entry: CacheHandlerValue): CacheHandlerValue {
  if (entry.cacheState !== undefined) return entry;
  const expire = entry.cacheControl?.expire;
  const isExpired = typeof expire === "number" && Date.now() - entry.lastModified > expire * 1000;
  return { ...entry, cacheState: isExpired ? "expired" : "stale" };
}

/** Store a PPR fallback shell in the data cache, where {@link isrGetFallbackShell} reads it. */
export async function isrSetFallbackShell(
  key: string,
  data: CachedAppPageValue,
  policy: IsrWritePolicy,
): Promise<void> {
  const { getDataCacheHandler } = await import("vinext/shims/cache-handler");
  await getDataCacheHandler().set(key, data, {
    cacheControl: policy.cacheControl,
    revalidate: policy.cacheControl.revalidate,
    tags: policy.tags ?? [],
  });
}

function toIsrCacheEntry(result: CacheHandlerValue | null): ISRCacheEntry | null {
  if (!result) return null;
  const isExpired = result.cacheState === "expired";

  return {
    value: result,
    isStale: isExpired || result.cacheState === "stale",
    ...(isExpired ? { isExpired: true } : {}),
  };
}

/**
 * Assemble cache-control metadata, omitting the dimensions the producing
 * render made no claim about. Shared by every ISR writer so `expire`/`stale`
 * are never invented from `revalidate`.
 */
export function isrCacheControl(
  revalidateSeconds: number | false,
  claims: { expireSeconds?: number; staleSeconds?: number } = {},
): CacheControlMetadata {
  return {
    revalidate: revalidateSeconds,
    ...(claims.expireSeconds === undefined ? {} : { expire: claims.expireSeconds }),
    ...(claims.staleSeconds === undefined ? {} : { stale: claims.staleSeconds }),
  };
}

/**
 * The route-level `expireTime` only bounds a finite revalidate. Like Next.js,
 * a `revalidate = false` entry keeps no expire of its own and stays until it
 * is invalidated; only a cacheLife expire can bound it.
 * https://github.com/vercel/next.js/blob/v16.2.7/packages/next/src/build/index.ts#L3035-L3058
 */
export function resolveRouteExpireSeconds(
  revalidateSeconds: number | false | null,
  expireSeconds: number | undefined,
): number | undefined {
  return revalidateSeconds === false || revalidateSeconds === Infinity ? undefined : expireSeconds;
}

/**
 * Write policy for one ISR entry: the cache metadata the producing render
 * resolved, plus the tags that can invalidate it. Routers differ only in which
 * `cacheControl` dimensions they populate — App pages carry the client-router
 * `stale` bound, Pages Router and route handlers do not.
 */
export type IsrWritePolicy = {
  cacheControl: CacheControlMetadata;
  tags?: string[];
};

/**
 * Store a value in the ISR cache under the given write policy.
 */
export async function isrSet(
  key: string,
  data: IncrementalCacheValue | null,
  policy: IsrWritePolicy,
): Promise<void> {
  await getCdnCacheAdapter().set(key, data, {
    cacheControl: policy.cacheControl,
    // `revalidate` is the legacy vinext CacheHandler context field. `expire`
    // and `stale` are newer metadata and intentionally only live inside
    // cacheControl.
    revalidate: policy.cacheControl.revalidate,
    tags: policy.tags ?? [],
  });
}

export type AppPageCacheSetter = (
  key: string,
  data: CachedAppPageValue,
  policy: IsrWritePolicy,
) => Promise<void>;

type PrerenderedAppPageMetadata = {
  expireSeconds?: number;
  revalidateSeconds?: number;
  /** Client reuse bound from the prerender's `cacheLife`. */
  staleSeconds?: number;
  /**
   * Implicit/path tags to attach to the seeded entry. Required so that
   * `revalidatePath()` (and `revalidateTag()`) can invalidate prerender-seeded
   * cache entries — without tags the entry is unreachable by tag-based
   * invalidation and remains stale until natural `revalidateAt` expiry.
   * See cloudflare/vinext#1486.
   */
  tags?: string[];
};

function prerenderedAppPageContext(
  key: string,
  metadata: PrerenderedAppPageMetadata,
): Record<string, unknown> {
  const revalidateSeconds = metadata.revalidateSeconds;
  const tags = metadata.tags;
  if (process.env.NEXT_PRIVATE_DEBUG_CACHE) {
    console.debug("[vinext] ISR: seed", key);
  }
  const ctx: Record<string, unknown> = {};
  if (revalidateSeconds !== undefined) {
    ctx.revalidate = revalidateSeconds;
    ctx.cacheControl = isrCacheControl(revalidateSeconds, metadata);
  }
  if (tags && tags.length > 0) {
    ctx.tags = tags;
  }
  return ctx;
}

export async function isrSetPrerenderedAppPage(
  key: string,
  data: CachedAppPageValue,
  metadata: PrerenderedAppPageMetadata,
): Promise<void> {
  // Route page-level seeding through the CDN cache adapter (default adapter
  // writes the data cache; edge adapters no-op). Merge in main's tag support
  // (cloudflare/vinext#1486) so prerender-seeded entries are reachable by
  // revalidatePath()/revalidateTag().
  await getCdnCacheAdapter().set(key, data, prerenderedAppPageContext(key, metadata));
}

/** Seed a prerendered fallback shell where {@link isrGetFallbackShell} reads it. */
export async function isrSetPrerenderedFallbackShell(
  key: string,
  data: CachedAppPageValue,
  metadata: PrerenderedAppPageMetadata,
): Promise<void> {
  const { getDataCacheHandler } = await import("vinext/shims/cache-handler");
  await getDataCacheHandler().set(key, data, prerenderedAppPageContext(key, metadata));
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

// Like Next.js ResponseCache, requests that find no fallback shell share one
// blocking render of it.
const _PENDING_FALLBACK_SHELL_KEY = Symbol.for("vinext.isrCache.pendingFallbackShellProductions");
const pendingFallbackShellProductions = (_g[_PENDING_FALLBACK_SHELL_KEY] ??= new Map<
  string,
  Promise<unknown>
>()) as Map<string, Promise<unknown>>;

/** Coalesce same-key synchronous on-demand revalidations. */
export function coalesceOnDemandRevalidation<T>(
  key: string,
  renderFn: () => Promise<T>,
): Promise<T> {
  return coalesceRender(pendingOnDemandRegenerations, key, renderFn);
}

/** Coalesce same-key blocking renders of a missing fallback shell. */
export function coalesceFallbackShellProduction<T>(
  key: string,
  renderFn: () => Promise<T>,
): Promise<T> {
  return coalesceRender(pendingFallbackShellProductions, key, renderFn);
}

function coalesceRender<T>(
  pendingRenders: Map<string, Promise<unknown>>,
  key: string,
  renderFn: () => Promise<T>,
): Promise<T> {
  const pending = pendingRenders.get(key) as Promise<T> | undefined;
  if (pending) return pending;

  // Defer invocation until after the promise is registered, matching Next.js's
  // response-cache scheduler and closing the same-tick stampede window.
  const promise: Promise<T> = shareIsolatePromise(
    Promise.resolve()
      .then(renderFn)
      .finally(() => {
        if (pendingRenders.get(key) === promise) {
          pendingRenders.delete(key);
        }
      }),
  );
  pendingRenders.set(key, promise);
  return promise;
}

/**
 * Coalesce same-key on-demand revalidations whose render answers with a
 * Response, or null for no match. Every caller gets its own copy of the one
 * render's response. `method` is the request method the response answers.
 */
export async function coalesceOnDemandResponse<R extends Response | null>(
  key: string,
  method: string,
  renderFn: () => Promise<R>,
): Promise<R> {
  const snapshot = await coalesceOnDemandRevalidation(key, async () => {
    const response = await renderFn();
    if (!response) return null;
    const hasBody =
      method !== "HEAD" &&
      response.status !== 204 &&
      response.status !== 205 &&
      response.status !== 304;
    // An omitted body is released rather than held until it's collected.
    if (!hasBody) await response.body?.cancel();
    return {
      body: hasBody ? new Uint8Array(await response.arrayBuffer()) : null,
      headers: [...response.headers.entries()] as Array<[string, string]>,
      status: response.status,
      statusText: response.statusText,
    };
  });
  if (!snapshot) return null as R;
  return new Response(snapshot.body?.slice() ?? null, {
    headers: snapshot.headers,
    status: snapshot.status,
    statusText: snapshot.statusText,
  }) as R;
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
 * `revalidateReason: "stale"`, unless `shouldReport` suppresses an error that
 * an inner render boundary already reported.
 */
export function triggerBackgroundRegeneration(
  key: string,
  renderFn: () => Promise<void>,
  errorContext?: BackgroundRegenerationErrorContext,
): void {
  // Edge-managed CDN adapters revalidate by re-requesting the origin, so the
  // origin must not also run in-process regeneration.
  if (!getCdnCacheAdapter().ownsBackgroundRevalidation) return;
  runBackgroundRegeneration(key, renderFn, errorContext);
}

/**
 * Regenerate a PPR fallback shell in the background. Shells live in the data
 * cache, which no edge revalidates, so the origin regenerates them on every
 * backend.
 */
export function triggerFallbackShellRegeneration(
  key: string,
  renderFn: () => Promise<void>,
  errorContext?: BackgroundRegenerationErrorContext,
): void {
  runBackgroundRegeneration(key, renderFn, errorContext);
}

type BackgroundRegenerationErrorContext = {
  routerKind: OnRequestErrorContext["routerKind"];
  routePath: string;
  routeType: OnRequestErrorContext["routeType"];
  shouldReport?: (error: unknown) => boolean;
};

function runBackgroundRegeneration(
  key: string,
  renderFn: () => Promise<void>,
  errorContext?: BackgroundRegenerationErrorContext,
): void {
  if (pendingRegenerations.has(key)) return;

  const promise = renderFn()
    .catch(async (err) => {
      console.error(`[vinext] ISR background regeneration failed for ${key}:`, err);
      if (errorContext && (errorContext.shouldReport?.(err) ?? true)) {
        await reportRequestError(
          err,
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

/**
 * Digest a request-controlled key part. It must be collision resistant: a
 * crafted value that shared a weaker hash with another would share its entry.
 */
function digestKeyPart(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function buildCacheKey(prefix: string, pathname: string, suffix?: string): string {
  const normalized = normalizeCachePathname(pathname);
  const suffixPart = suffix ? `:${suffix}` : "";
  const key = `${prefix}:${normalized}${suffixPart}`;
  if (key.length <= 200) return key;
  return `${prefix}:__hash:${digestKeyPart(normalized)}${suffixPart}`;
}

/**
 * Compute an ISR cache key for a given router type and pathname.
 * Long pathnames are hashed to stay within KV key-length limits (512 bytes).
 */
export function isrCacheKey(router: string, pathname: string, buildId?: string): string {
  const prefix = buildId ? `${router}:${buildId}` : router;
  return buildCacheKey(prefix, pathname);
}

/** Build and request time share the same locale-stripped Pages pathname identity. */
export function pagesIsrCacheKey(
  pathname: string,
  buildId?: string,
  i18nCacheVariant?: string | null,
): string {
  // Decode once per segment, preserving escaped delimiters and literal escapes.
  // Strip the pathname's trailing slash before appending the locale/domain variant.
  const normalized = normalizeCachePathname(normalizePathnameForRouteMatch(pathname));
  const variant = i18nCacheVariant ? `::i18n=${encodeURIComponent(i18nCacheVariant)}` : "";
  // Legacy keys retained raw escapes. A stable build ID must not let a new
  // literal-percent pathname reinterpret an old encoded-parameter entry.
  return isrCacheKey("pages:v2", normalized + variant, buildId);
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
  // Keep incompatible App cache identities unreachable even when generateBuildId is stable.
  const prefix = buildId ? `app:v2:${buildId}` : "app:v2";
  return buildCacheKey(prefix, pathname, suffix);
}

/**
 * Compute the ISR key for a PPR fallback shell artifact, such as the HTML for
 * `/en/[slug]`. Shells get their own namespace: a request for the literal path
 * `/en/%5Bslug%5D` decodes to the same pathname, and its render must not be
 * stored where every unknown `[slug]` reads its shell. The namespace is a
 * prefix of its own rather than a part after the build ID, which can contain
 * `:` and so could spell it.
 */
export function appIsrFallbackShellKey(
  pathname: string,
  suffix: "html" | "rsc",
  buildId = process.env.__VINEXT_BUILD_ID,
): string {
  const prefix = buildId ? `app-fallback-shell:v1:${buildId}` : "app-fallback-shell:v1";
  return buildCacheKey(prefix, pathname, suffix);
}

export function appIsrHtmlKey(pathname: string): string {
  return appIsrCacheKey(pathname, "html");
}

export function appIsrFallbackShellHtmlKey(pathname: string): string {
  return appIsrFallbackShellKey(pathname, "html");
}

function normalizeInterceptionContextForCacheKey(interceptionContext: string): string | null {
  // Key on the raw context. The source is matched on its raw segments, so two
  // spellings that decode alike (`/feed` and `/%66eed`) can render different
  // source trees and must not share an entry.
  return isInterceptionMatchedUrlPath(interceptionContext) ? interceptionContext : null;
}

/**
 * Build the ISR cache key for an RSC payload.
 *
 * Variants are sequenced in order: `source:<hash>` (intercepted source context,
 * only when an interception context is present), `selector:<hash>` (a verified
 * supplemental interception edge), `slots:<hash>` (mounted parallel route slots),
 * and optionally `<render-mode-variant>` (for example,
 * `prefetch-loading-shell`). Existing cached entries under the old format will
 * become unreachable after deployment. This is acceptable because ISR entries
 * have TTLs and will be regenerated on the next request.
 */
export function appIsrRscKey(
  pathname: string,
  mountedSlotsHeader?: string | null,
  renderMode: AppRscRenderMode = APP_RSC_RENDER_MODE_NAVIGATION,
  interceptionContext?: string | null,
  interceptionId?: string | null,
): string {
  const normalizedMountedSlotsHeader = normalizeMountedSlotsHeader(mountedSlotsHeader);
  const sourceVariant =
    interceptionContext === undefined || interceptionContext === null
      ? null
      : normalizeInterceptionContextForCacheKey(interceptionContext);
  const variant = [
    sourceVariant ? `source:${digestKeyPart(sourceVariant)}` : null,
    interceptionId ? `selector:${digestKeyPart(interceptionId)}` : null,
    normalizedMountedSlotsHeader ? `slots:${digestKeyPart(normalizedMountedSlotsHeader)}` : null,
    getRscRenderModeCacheVariant(renderMode),
  ]
    .filter((part) => part !== null)
    .join(":");
  return appIsrCacheKey(pathname, variant ? `rsc:${variant}` : "rsc");
}

export function appIsrRouteKey(pathname: string): string {
  const suffix = pathname !== "/" && pathname.endsWith("/") ? "route:trailing-slash" : "route";
  return appIsrCacheKey(pathname, suffix);
}
