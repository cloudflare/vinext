/**
 * Centralised ISR `Cache-Control` derivation module.
 *
 * `decideIsr` is the single place that maps (router kind, cache state,
 * revalidate/expire metadata) → the exact `Cache-Control` string to stamp on
 * an ISR response. Every ISR code path (app-page, app-route, pages,
 * dev-server) routes through it.
 *
 * `disposition` and `scheduleRegeneration` are informational fields for
 * callers that want them; all current callers only read `cacheControl`.
 */

import type { CacheControlMetadata } from "vinext/shims/cache";
import {
  buildCachedRevalidateCacheControl,
  buildRevalidateCacheControl,
  NEVER_CACHE_CONTROL,
  NO_STORE_CACHE_CONTROL,
  STATIC_CACHE_CONTROL,
} from "./cache-control.js";

type IsrDisposition = "HIT" | "STALE" | "MISS";

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
type IsrPolicyKind = "app-page" | "app-route" | "pages" | "dev";

type DecideIsrOptions = {
  /**
   * The cache state. Content guards (kind-mismatch, empty body,
   * query-variant-unproven) must have already passed before passing
   * `"HIT"` or `"STALE"` here.
   */
  cacheState: "HIT" | "STALE" | "MISS";
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
 * Derive the `Cache-Control` string for an ISR response.
 *
 * Content guards (kind mismatch, query-variant-unproven, empty body) are the
 * caller's responsibility and must happen *before* this call. `cacheState`
 * must only be `"HIT"` or `"STALE"` when those guards have already passed.
 */
export function decideIsr(options: DecideIsrOptions): IsrDecision {
  if (options.cacheState === "MISS") {
    return { disposition: "MISS", scheduleRegeneration: false, cacheControl: "" };
  }

  const { effectiveRevalidate, effectiveExpire } = resolveRevalidate(options);

  if (options.cacheState === "HIT") {
    return {
      disposition: "HIT",
      scheduleRegeneration: false,
      cacheControl: buildCacheControl("HIT", options.kind, effectiveRevalidate, effectiveExpire),
    };
  }

  // STALE: serve + schedule regen.
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
