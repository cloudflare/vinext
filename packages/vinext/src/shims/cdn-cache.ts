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
export type CdnCacheAdapter = {
  /**
   * Read a page-level artifact. Returning a value lets the origin serve it
   * (HIT/STALE); returning `null` makes the origin render fresh.
   *
   * Default: reads the data cache. Edge adapters typically return `null` so the
   * edge owns serving.
   */
  readPage(key: string, ctx?: Record<string, unknown>): Promise<CacheHandlerValue | null>;

  /**
   * Persist a freshly-rendered page-level artifact.
   *
   * Default: writes to the data cache. Edge adapters that rely entirely on the
   * CDN may make this a no-op.
   */
  writePage(
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
  revalidate(tags: string | string[], durations?: { expire?: number }): Promise<void>;
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

  async readPage(key: string, ctx?: Record<string, unknown>): Promise<CacheHandlerValue | null> {
    return getDataCacheHandler().get(key, ctx);
  }

  async writePage(
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

  async revalidate(_tags: string | string[], _durations?: { expire?: number }): Promise<void> {
    // Purge-only hook. The default store is the data cache, which already
    // invalidated the matching tags, so there is nothing extra to do here.
  }
}

// ---------------------------------------------------------------------------
// Edge (request-context) CDN cache adapter.
//
// Delegates page-level ISR serving to a host CDN whose cache surface is exposed
// on the per-request execution context (e.g. the Cloudflare Workers Cache at
// `ctx.cache`, enabled via `[cache] enabled = true` in wrangler.jsonc). It is
// platform-agnostic — it only touches the generic request-context cache
// surface, not anything Cloudflare-specific — so any runtime exposing a
// `purge`-capable cache handle activates it automatically (see
// getCdnCacheAdapter below). No import or registration required.
// ---------------------------------------------------------------------------

/** The request-context cache surface this adapter relies on (narrowed from `unknown`). */
type RequestContextCache = {
  purge(options: { tags: string[] }): Promise<unknown>;
};

/** Return the request-context host cache when it exposes a `purge` method, else null. */
function getRequestContextCache(): RequestContextCache | null {
  const cache = getRequestExecutionContext()?.cache;
  if (cache && typeof (cache as Partial<RequestContextCache>).purge === "function") {
    return cache as RequestContextCache;
  }
  return null;
}

/** Non-cacheable responses: nobody (edge or browser) stores them. */
const NO_STORE = "no-store";

/**
 * Browser-facing policy for cacheable responses. `public` allows shared caches
 * to participate, but `max-age=0, must-revalidate` forces every reuse to
 * revalidate (against the edge) rather than serving a stored copy — so the user
 * always sees edge-fresh content while still permitting conditional 304s.
 */
const BROWSER_REVALIDATE = "public, max-age=0, must-revalidate";

/**
 * Convert the framework's shared-cache policy into a CDN-scoped one:
 * `s-maxage=…` → `max-age=…` (the edge honors `max-age` inside
 * `CDN-Cache-Control`) and ensure a leading `public`.
 */
function toEdgeCacheControl(cacheControl: string): string {
  const withMaxAge = cacheControl.replace(/\bs-maxage=/g, "max-age=");
  return /\bpublic\b/.test(withMaxAge) ? withMaxAge : `public, ${withMaxAge}`;
}

/**
 * A host's `Cache-Tag` header budget is typically 16 KB total with each tag
 * capped at 1024 bytes (Cloudflare's limits). Keep a conservative ceiling so a
 * page with a large tag set never produces an oversized (silently-dropped) header.
 */
const MAX_CACHE_TAG_BYTES = 8 * 1024;
const MAX_SINGLE_TAG_BYTES = 1024;

/**
 * Build a `Cache-Tag` header value from canonicalised tags. Tags containing a
 * comma (the header separator) or exceeding the per-tag size are skipped, and
 * the whole value is bounded to stay within the host limit.
 */
function formatCacheTag(tags: readonly string[]): string | null {
  const parts: string[] = [];
  let total = 0;
  for (const tag of tags) {
    if (!tag || tag.includes(",") || tag.length > MAX_SINGLE_TAG_BYTES) continue;
    // +1 accounts for the joining comma.
    const next = total + tag.length + (parts.length > 0 ? 1 : 0);
    if (next > MAX_CACHE_TAG_BYTES) break;
    parts.push(tag);
    total = next;
  }
  return parts.length > 0 ? parts.join(",") : null;
}

/**
 * Edge-managed ISR strategy backed by a request-context host cache. The origin
 * keeps no page store (`readPage` → null, `writePage` → no-op); the host CDN
 * caches the *response* by its headers and revalidates by re-requesting the
 * origin. `buildResponseHeaders` emits the SWR policy on `CDN-Cache-Control`
 * (edge-scoped, so `max-age`, not `s-maxage`) while the browser-facing
 * `Cache-Control` forces revalidation against the edge; a `Cache-Tag` header
 * lets entries be purged by tag.
 */
export class RequestContextCdnCacheAdapter implements CdnCacheAdapter {
  // The edge revalidates by re-requesting the origin (UPDATING), so the origin
  // must not also run in-process background regeneration.
  readonly ownsBackgroundRevalidation = false;

  /** The origin keeps no page store — render fresh; the edge serves HIT/STALE. */
  async readPage(): Promise<CacheHandlerValue | null> {
    return null;
  }

  /** No-op: the platform caches the response via its headers, not an origin store. */
  async writePage(): Promise<void> {
    // intentionally empty
  }

  buildResponseHeaders(input: CdnCacheableHeaderInput): CdnResponseHeaders {
    // No cacheable policy → nobody stores it.
    if (!input.cacheControl) {
      return { "Cache-Control": NO_STORE };
    }

    // A non-cacheable policy (no-store / no-cache / private) must never be
    // promoted to an edge cache — pass it through unchanged.
    if (/\b(?:no-store|no-cache|private)\b/.test(input.cacheControl)) {
      return { "Cache-Control": input.cacheControl };
    }

    // SWR policy on CDN-Cache-Control (edge caches + revalidates); the browser
    // is told to revalidate every reuse so it never serves a stale stored copy.
    const headers: CdnResponseHeaders = {
      "Cache-Control": BROWSER_REVALIDATE,
      "CDN-Cache-Control": toEdgeCacheControl(input.cacheControl),
    };

    if (input.tags && input.tags.length > 0) {
      const cacheTag = formatCacheTag(input.tags);
      if (cacheTag) headers["Cache-Tag"] = cacheTag;
    }

    return headers;
  }

  /** Purge edge-cached responses by tag via the request context's `cache.purge`. */
  async revalidate(tags: string | string[]): Promise<void> {
    const cache = getRequestContextCache();
    if (!cache) return; // no host cache in the request context (e.g. Node dev)

    const tagList = (Array.isArray(tags) ? tags : [tags]).filter(
      (t): t is string => typeof t === "string" && t.length > 0,
    );
    if (tagList.length === 0) return;

    await cache.purge({ tags: tagList });
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
//   2. Otherwise, when the request context exposes a host cache surface, page
//      ISR is served through the edge-managed RequestContextCdnCacheAdapter.
//   3. Otherwise, the origin-managed DefaultCdnCacheAdapter.
//
// Tiers 2/3 are recomputed each call (never cached on the global key) because
// the request-context cache is only observable mid-request: an early call
// (module init, background task) must not lock in the default and shadow the
// edge adapter on a later in-request call. The two built-in adapters are
// stateless, so the per-isolate singletons are safe to reuse.
// ---------------------------------------------------------------------------

const _CDN_KEY = Symbol.for("vinext.cdnCacheAdapter");
const _gCdn = globalThis as unknown as Record<PropertyKey, unknown>;

let _defaultAdapter: DefaultCdnCacheAdapter | null = null;
let _edgeAdapter: RequestContextCdnCacheAdapter | null = null;

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
 * explicit → request-context edge adapter (when `ctx.cache` is present) →
 * origin-managed {@link DefaultCdnCacheAdapter}.
 */
export function getCdnCacheAdapter(): CdnCacheAdapter {
  const explicit = _gCdn[_CDN_KEY] as CdnCacheAdapter | undefined;
  if (explicit) return explicit;

  if (getRequestContextCache()) {
    return (_edgeAdapter ??= new RequestContextCdnCacheAdapter());
  }

  return (_defaultAdapter ??= new DefaultCdnCacheAdapter());
}
