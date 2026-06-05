/**
 * CDN cache adapter — owns the *page-level ISR serving strategy*.
 *
 * This is deliberately distinct from the data cache handler (see `./cache.ts`):
 *
 * - The **data cache** stores cached data (fetch, `"use cache"`,
 *   `unstable_cache`, route-handler data). It is a pure key/value store.
 *
 * - The **CDN cache adapter** decides *how page-level ISR is served*: where the
 *   rendered page/route/image artifacts live, what cache headers the response
 *   carries, whether the origin runs background regeneration, and how
 *   invalidation propagates to a CDN edge.
 *
 * Two strategies sit behind one interface:
 *
 * | Concern            | DefaultCdnCacheAdapter (origin-managed) | Edge adapter (CDN-managed)                  |
 * | ------------------ | --------------------------------------- | ------------------------------------------- |
 * | Serve from store?  | Yes — reads the data cache              | No — origin renders fresh, edge caches      |
 * | Background regen   | In-process via `waitUntil`              | Edge re-requests origin                     |
 * | Response headers   | `Cache-Control` (SWR)                   | `Cache-Control: no-store` + `CDN-Cache-Control: <SWR>` |
 * | Invalidation       | (data cache handles tag invalidation)   | purge / revalidate via request context      |
 *
 * The default adapter is a thin shim over the data cache + the framework's
 * existing header logic, so default behavior is byte-for-byte identical to the
 * pre-split implementation.
 */

import {
  getDataCacheHandler,
  type CacheHandlerValue,
  type IncrementalCacheValue,
} from "./cache.js";
import { getRequestExecutionContext } from "./request-context.js";
// The edge adapter lives with the Cloudflare integration; the resolver below
// imports it to use as the built-in default when a request-context host cache
// is present.
import { CloudflareCdnCacheAdapter } from "../cloudflare/cache/cdn-adapter.runtime.js";

/** A map of response header name -> value the adapter wants applied. */
export type CdnResponseHeaders = Record<string, string>;

export type CdnCacheableHeaderInput = {
  /**
   * The cacheable `Cache-Control` value the framework computed for shared
   * caches (e.g. `s-maxage=60, stale-while-revalidate`). May be an empty string
   * when no cacheable policy applies.
   */
  cacheControl: string;
  /**
   * True when this is a freshly-rendered **streaming** response whose
   * dynamic-ness is not yet proven (late Server Component request-API usage can
   * only be detected after the stream drains).
   *
   * The default adapter forces `no-store` for the browser in this case — the
   * page is instead served from the origin store on subsequent requests. Edge
   * adapters may instead emit edge-only cache headers (e.g. `CDN-Cache-Control`)
   * so the CDN performs SWR while the browser still sees `no-store`.
   */
  pendingDynamicCheck?: boolean;
  /**
   * The cache tags associated with this page/route, already canonicalised
   * (e.g. via `encodeCacheTag`). Edge adapters use these to emit a tag header
   * (e.g. a `Cache-Tag` header) so tag-based purging can target the response.
   * The default adapter ignores them.
   */
  tags?: readonly string[];
};

/**
 * The serving strategy for page-level ISR. Implement this to delegate
 * page/route/image caching to a CDN edge instead of the origin store.
 */
// Method names mirror the data cache adapter (`CacheHandler` in `./cache.ts`:
// `get` / `set` / `revalidateTag`) so the two adapters read consistently.
// `buildResponseHeaders` / `ownsBackgroundRevalidation` have no data-cache
// equivalent and stay CDN-specific.
export type CdnCacheAdapter = {
  /**
   * Read a page-level artifact. Returning a value lets the origin serve it
   * (HIT/STALE); returning `null` makes the origin render fresh.
   *
   * Default: reads the data cache. Edge adapters typically return `null` so the
   * edge owns serving.
   */
  get(key: string, ctx?: Record<string, unknown>): Promise<CacheHandlerValue | null>;

  /**
   * Persist a freshly-rendered page-level artifact.
   *
   * Default: writes to the data cache. Edge adapters that rely entirely on the
   * CDN may make this a no-op.
   */
  set(
    key: string,
    data: IncrementalCacheValue | null,
    ctx?: Record<string, unknown>,
  ): Promise<void>;

  /**
   * Build the response cache headers for a given cacheable policy. Returns a map
   * so an adapter can emit more than one header (e.g. `Cache-Control` +
   * `CDN-Cache-Control`).
   */
  buildResponseHeaders(input: CdnCacheableHeaderInput): CdnResponseHeaders;

  /**
   * Whether the **origin** runs in-process background regeneration when a stale
   * entry is served. Edge adapters set this to `false` because the CDN
   * revalidates by re-requesting the origin.
   */
  readonly ownsBackgroundRevalidation: boolean;

  /**
   * Propagate a tag/path invalidation to the CDN edge (purge). Called *in
   * addition to* the data cache's own tag invalidation, so the default
   * implementation is a no-op (the data cache already invalidated its entries).
   *
   * Edge adapters implement this to purge the edge cache — typically firing the
   * purge through the request execution context (`ctx.waitUntil`).
   */
  revalidateTag(tags: string | string[], durations?: { expire?: number }): Promise<void>;
};

// `finalizeAppPage*CacheResponse` historically stamped this exact value on the
// streamed MISS response. Keep it identical so default behavior is unchanged.
const PENDING_DYNAMIC_CACHE_CONTROL = "no-store, must-revalidate";

/**
 * Default origin-managed ISR strategy: store page artifacts in the data cache,
 * serve HIT/STALE from it, run in-process background regeneration, and emit the
 * framework's standard `Cache-Control` headers.
 */
export class DefaultCdnCacheAdapter implements CdnCacheAdapter {
  readonly ownsBackgroundRevalidation = true;

  async get(key: string, ctx?: Record<string, unknown>): Promise<CacheHandlerValue | null> {
    return getDataCacheHandler().get(key, ctx);
  }

  async set(
    key: string,
    data: IncrementalCacheValue | null,
    ctx?: Record<string, unknown>,
  ): Promise<void> {
    await getDataCacheHandler().set(key, data, ctx);
  }

  buildResponseHeaders(input: CdnCacheableHeaderInput): CdnResponseHeaders {
    if (input.pendingDynamicCheck) {
      // Until the stream proves the render was non-dynamic, browsers and shared
      // caches must not store it. The origin serves subsequent requests from the
      // data cache instead.
      return { "Cache-Control": PENDING_DYNAMIC_CACHE_CONTROL };
    }
    return { "Cache-Control": input.cacheControl };
  }

  async revalidateTag(_tags: string | string[], _durations?: { expire?: number }): Promise<void> {
    // Purge-only hook. The default store is the data cache, which already
    // invalidated the matching tags, so there is nothing extra to do here.
  }
}

// ---------------------------------------------------------------------------
// Active adapter resolution.
//
// Precedence:
//   1. An adapter set explicitly via setCdnCacheAdapter() always wins. It is
//      stored on globalThis (Symbol.for) so a call in the worker entry is
//      visible across Vite environments (RSC + SSR), mirroring the data cache
//      handler resolution in cache.ts.
//   2. Otherwise, the origin-managed DefaultCdnCacheAdapter.
//
// Auto-detection of a request-context host cache (e.g. the Cloudflare Workers
// Cache at `ctx.cache`) is gated behind the VINEXT_CDN_CACHE_AUTO_DETECT env
// flag and is OFF by default. Edge-managed page ISR needs deployment skew
// protection to be safe (a stale isolate purging/serving against a newer build
// can mismatch), so until that is figured out the edge adapter is only selected
// when an operator explicitly opts in via the flag (value "1"). When enabled
// and `ctx.cache` is present, the resolved CloudflareCdnCacheAdapter is stored
// on the same global slot setCdnCacheAdapter() uses, so there is no separate
// "edge" variable and it is reused on subsequent calls.
// ---------------------------------------------------------------------------

const _CDN_KEY = Symbol.for("vinext.cdnCacheAdapter");
const _gCdn = globalThis as unknown as Record<PropertyKey, unknown>;

let _defaultAdapter: DefaultCdnCacheAdapter | null = null;

/**
 * Set a custom CDN cache adapter. Call during server startup to delegate
 * page-level ISR to a CDN edge. An explicit adapter always wins over the
 * built-in request-context / default selection.
 */
export function setCdnCacheAdapter(adapter: CdnCacheAdapter): void {
  _gCdn[_CDN_KEY] = adapter;
}

/**
 * Get the active CDN cache adapter. See the precedence note above:
 * explicit (or an already-resolved auto-detected edge adapter) → origin-managed
 * {@link DefaultCdnCacheAdapter}.
 *
 * Auto-detection of the Cloudflare Workers Cache (`ctx.cache`) only runs when
 * `VINEXT_CDN_CACHE_AUTO_DETECT === "1"`; otherwise the default adapter is used
 * unless an adapter was set explicitly.
 */
export function getCdnCacheAdapter(): CdnCacheAdapter {
  const active = _gCdn[_CDN_KEY] as CdnCacheAdapter | undefined;
  if (active) return active;

  if (process.env.VINEXT_CDN_CACHE_AUTO_DETECT === "1" && getRequestExecutionContext()?.cache) {
    // Resolve once and store on the single active-adapter slot so the explicit
    // and auto-detected paths share one mechanism (and one reused instance).
    const edge = new CloudflareCdnCacheAdapter();
    _gCdn[_CDN_KEY] = edge;
    return edge;
  }

  return (_defaultAdapter ??= new DefaultCdnCacheAdapter());
}
