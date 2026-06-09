/**
 * Centralised ISR cache-decision module.
 *
 * The HIT/STALE/MISS disposition, the `scheduleRegeneration` flag, and the
 * `Cache-Control` string are all derived here. No caller may produce these
 * values independently — every ISR code path (app-page, app-route, pages,
 * dev-server) routes through `decideIsr`.
 *
 * ## Equivalence table
 *
 * Each call site previously derived its own disposition + Cache-Control.
 * This table documents what the migrated path emits vs what it emitted before.
 *
 * | Call site                              | Before                                           | After              | Changed? |
 * |----------------------------------------|--------------------------------------------------|--------------------|----------|
 * | app-page HIT                           | buildCachedRevalidateCacheControl("HIT", r, e)   | same               | no       |
 * | app-page STALE (expire known)          | buildCachedRevalidateCacheControl("STALE", r, e) | same               | no       |
 * | app-page STALE (no expire)             | buildCachedRevalidateCacheControl("STALE", r)    | same → s-maxage=0  | no       |
 * | app-route HIT/STALE (revalidate=0)     | NEVER_CACHE_CONTROL                              | same               | no       |
 * | app-route HIT/STALE (revalidate=∞)     | STATIC_CACHE_CONTROL                             | same               | no       |
 * | app-route HIT/STALE (finite)           | buildCachedRevalidateCacheControl(state, r, e)   | same               | no       |
 * | pages HIT                              | buildCachedRevalidateCacheControl("HIT", r, e)   | same               | no       |
 * | pages STALE (expire known)             | buildCachedRevalidateCacheControl("STALE", r, e) | same               | no       |
 * | pages STALE (no expire)               | buildCachedRevalidateCacheControl("STALE", r)    | same → s-maxage=0  | no       |
 * | dev HIT (getStaticProps)               | s-maxage=${secs}, stale-while-revalidate         | same               | no       |
 * | dev STALE (getStaticProps)             | s-maxage=${secs}, stale-while-revalidate         | s-maxage=0, ...    | **yes**  |
 * | dev MISS/regen (getStaticProps)        | s-maxage=${secs}, stale-while-revalidate         | same               | no       |
 * | dev gssp default (no-store)            | private, no-cache, no-store, max-age=0...        | same (NEVER_CACHE) | no       |
 * | dev nonce (no-store)                   | no-store, must-revalidate                        | same (NO_STORE)    | no       |
 * | pages-page-response scriptNonce        | no-store, must-revalidate                        | same (NO_STORE)    | no       |
 * | pages-page-response gssp default       | private, no-cache, no-store...                   | same (NEVER_CACHE) | no       |
 * | pages-page-handler _next/data default  | private, no-cache, no-store...                   | same (NEVER_CACHE) | no       |
 *
 * The single deliberate change: dev STALE now emits `s-maxage=0,
 * stale-while-revalidate` (matching the prod Pages Router and the canonical
 * `buildCachedRevalidateCacheControl` helper) instead of `s-maxage=<secs>,
 * stale-while-revalidate`. Dev had no CDN in front and was the only path
 * treating a stale-served payload as freshly cacheable downstream — a
 * dev/prod parity gap, not intentional behaviour.
 */

import type { CacheControlMetadata } from "vinext/shims/cache";
import {
  buildCachedRevalidateCacheControl,
  buildRevalidateCacheControl,
  NEVER_CACHE_CONTROL,
  NO_STORE_CACHE_CONTROL,
  STATIC_CACHE_CONTROL,
} from "./cache-control.js";

export type IsrDisposition = "HIT" | "STALE" | "MISS";

export type IsrDecision = {
  disposition: IsrDisposition;
  /** True when the caller must schedule a background regeneration. */
  scheduleRegeneration: boolean;
  /** The `Cache-Control` string to stamp on the response. */
  cacheControl: string;
};

/**
 * Per-router special-case policies for `Cache-Control`.
 *
 * - `"app-page"` / `"pages"`: `buildCachedRevalidateCacheControl` for HIT/STALE.
 * - `"app-route"`: same, but `revalidateSeconds=0` forces `NEVER_CACHE_CONTROL`
 *   and `revalidateSeconds=Infinity` forces `STATIC_CACHE_CONTROL`.
 * - `"dev"`: like `"pages"`, but `revalidate=0`/`Infinity` guards are absent
 *   (dev never caches when revalidate=0 and never has Infinity entries in practice).
 */
export type IsrPolicyKind = "app-page" | "app-route" | "pages" | "dev";

type DecideIsrOptions = {
  /**
   * True when the cache returned a value that can be forwarded to the client
   * (the content guards — kind-mismatch, empty body, query-variant-unproven —
   * have already passed). MISS = false; HIT or STALE = true.
   */
  hasUsableValue: boolean;
  /**
   * True when the cache entry is past its TTL and the caller must regenerate.
   * Only meaningful when `hasUsableValue` is true.
   */
  isStale: boolean;
  /** Which router is making the decision. */
  kind: IsrPolicyKind;
  /**
   * The route's configured revalidate window in seconds. Used as the fallback
   * when `cacheControlMeta` is absent.
   *
   * For `"dev"` call sites this is the only source of the revalidate value —
   * dev never has metadata attached to a cache entry.
   */
  revalidateSeconds: number;
  /**
   * The expire ceiling (seconds from epoch) read from the route config.
   * Absent when the route pre-dates expire metadata support.
   */
  expireSeconds?: number;
  /**
   * Optional per-entry metadata written alongside the cache value.
   * When present its `revalidate`/`expire` fields override the route defaults,
   * exactly as the call sites do today with `cacheControl?.revalidate ?? revalidateSeconds`.
   */
  cacheControlMeta?: CacheControlMetadata;
};

/** Resolve effective revalidate/expire, preferring per-entry metadata. */
function resolveRevalidate(options: DecideIsrOptions): {
  effectiveRevalidate: number;
  effectiveExpire: number | undefined;
} {
  const effectiveRevalidate = options.cacheControlMeta?.revalidate ?? options.revalidateSeconds;
  // `expireSeconds` is the route-level config fallback. It is only meaningful
  // when per-entry metadata is present — it acts as the fallback for entries
  // written before expire support was added. When `cacheControlMeta` is absent
  // entirely, the expire ceiling is unknown (undefined), matching the
  // original per-call-site logic:
  //
  //   const expire = options.cacheControl === undefined
  //     ? undefined
  //     : (options.cacheControl.expire ?? options.expireSeconds);
  const effectiveExpire =
    options.cacheControlMeta === undefined
      ? undefined
      : (options.cacheControlMeta.expire ?? options.expireSeconds);
  return { effectiveRevalidate, effectiveExpire };
}

function buildCacheControl(
  disposition: "HIT" | "STALE",
  kind: IsrPolicyKind,
  revalidate: number,
  expire: number | undefined,
): string {
  if (kind === "app-route") {
    if (revalidate === 0) return NEVER_CACHE_CONTROL;
    if (revalidate === Infinity) return STATIC_CACHE_CONTROL;
  }
  return buildCachedRevalidateCacheControl(disposition, revalidate, expire);
}

/**
 * Make the ISR cache policy decision.
 *
 * Returns the disposition, whether the caller must schedule a background
 * regeneration, and the exact `Cache-Control` string to apply to the response.
 *
 * Content guards (kind mismatch, query-variant-unproven, empty body) are the
 * caller's responsibility and must happen *before* this call. `hasUsableValue`
 * must only be true when those guards have already passed.
 */
export function decideIsr(options: DecideIsrOptions): IsrDecision {
  if (!options.hasUsableValue) {
    return { disposition: "MISS", scheduleRegeneration: false, cacheControl: "" };
  }

  if (!options.isStale) {
    const { effectiveRevalidate, effectiveExpire } = resolveRevalidate(options);
    return {
      disposition: "HIT",
      scheduleRegeneration: false,
      cacheControl: buildCacheControl("HIT", options.kind, effectiveRevalidate, effectiveExpire),
    };
  }

  // Stale: serve + schedule regen.
  const { effectiveRevalidate, effectiveExpire } = resolveRevalidate(options);
  return {
    disposition: "STALE",
    scheduleRegeneration: true,
    cacheControl: buildCacheControl("STALE", options.kind, effectiveRevalidate, effectiveExpire),
  };
}

/**
 * Build the `Cache-Control` string for a fresh MISS response whose ISR policy
 * is known (i.e. revalidate is set and > 0). Uses the unbounded SWR form when
 * no expire ceiling is available, exactly as `buildRevalidateCacheControl` does.
 *
 * Separate from `decideIsr` because a MISS doesn't read a cache entry and
 * therefore never has `cacheControlMeta`. `expireSeconds` here is the route
 * config ceiling passed directly from the caller (not a per-entry fallback).
 */
export function buildMissIsrCacheControl(
  revalidateSeconds: number,
  expireSeconds?: number,
): string {
  return buildRevalidateCacheControl(revalidateSeconds, expireSeconds);
}

/**
 * Build the `Cache-Control` string for a fresh (MISS) app-route response.
 *
 * Applies the same `revalidateSeconds=0`→NEVER and `Infinity`→STATIC gates
 * that `decideIsr` uses for app-route cached responses. `expireSeconds` is
 * the route config ceiling passed directly (not per-entry metadata fallback).
 *
 * Used by `applyRouteHandlerRevalidateHeader` which operates on a fresh
 * response that has no per-entry cache metadata.
 */
export function buildAppRouteMissIsrCacheControl(
  revalidateSeconds: number,
  expireSeconds?: number,
): string {
  if (revalidateSeconds === 0) return NEVER_CACHE_CONTROL;
  if (revalidateSeconds === Infinity) return STATIC_CACHE_CONTROL;
  return buildRevalidateCacheControl(revalidateSeconds, expireSeconds);
}

/**
 * The `Cache-Control` for a response that must never be cached (getServerSideProps
 * default, on-demand revalidation, nonce-bearing pages). Matches `NEVER_CACHE_CONTROL`.
 */
export { NEVER_CACHE_CONTROL as ISR_NEVER_CACHE_CONTROL };

/**
 * The `Cache-Control` for a nonce-bearing ISR response (the page has a
 * script nonce, so it must not enter any shared cache). Matches `NO_STORE_CACHE_CONTROL`.
 */
export { NO_STORE_CACHE_CONTROL as ISR_NO_STORE_CACHE_CONTROL };
