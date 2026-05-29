/**
 * Cloudflare CDN cache adapter — edge-managed page-level ISR backed by the
 * Cloudflare Workers Cache (`ctx.cache`).
 *
 * Unlike the origin-managed default adapter (which stores rendered artifacts in
 * the data cache and serves HIT/STALE itself), this adapter delegates serving
 * to Cloudflare's edge:
 *
 * - The origin never serves from a store — `readPage` returns `null`, so any
 *   request that reaches the Worker renders fresh. The edge absorbs HIT/STALE
 *   traffic and revalidates in the background (the `UPDATING` cache status).
 * - `writePage` is a no-op: the platform caches the *response* based on its
 *   cache headers, so there is nothing to persist at the origin.
 * - `buildResponseHeaders` emits the SWR policy as `CDN-Cache-Control` (so the
 *   edge caches + revalidates) while stamping `Cache-Control: no-store` (so a
 *   browser/private cache never stores the response), plus a `Cache-Tag` header
 *   so entries can be purged by tag.
 * - `revalidate` purges the edge via the request context's `cache.purge({ tags })`.
 *
 * Tag alignment: the tags emitted in `Cache-Tag` come from the page's render
 * tags (already canonicalised via `encodeCacheTag`), and `revalidateTag` /
 * `revalidatePath` pass the same canonical form to `revalidate`, so a purge
 * targets exactly the responses that carried the tag.
 */

import type {
  CdnCacheAdapter,
  CdnCacheableHeaderInput,
  CdnResponseHeaders,
} from "vinext/shims/cdn-cache";
import type { CacheHandlerValue, IncrementalCacheValue } from "vinext/shims/cache";
import { getRequestExecutionContext } from "vinext/shims/request-context";

/** The request-context cache surface this adapter relies on (narrowed from `unknown`). */
type WorkersCacheLike = {
  purge(options: { tags: string[] }): Promise<unknown>;
};

function getWorkersCache(): WorkersCacheLike | null {
  const cache = getRequestExecutionContext()?.cache;
  if (cache && typeof (cache as Partial<WorkersCacheLike>).purge === "function") {
    return cache as WorkersCacheLike;
  }
  return null;
}

/** Don't-cache value: prevents any browser/private cache from storing the response. */
const NO_STORE = "no-store";

/**
 * Cloudflare's `Cache-Tag` header budget is 16 KB total with each tag capped at
 * 1024 bytes. Keep a conservative ceiling so a page with a large tag set never
 * produces an oversized (silently-dropped) header.
 */
const MAX_CACHE_TAG_BYTES = 8 * 1024;
const MAX_SINGLE_TAG_BYTES = 1024;

/**
 * Build a `Cache-Tag` header value from canonicalised tags. Tags containing a
 * comma (the header separator) or exceeding the per-tag size are skipped, and
 * the whole value is bounded to stay within Cloudflare's limit.
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

export class CloudflareCdnCacheAdapter implements CdnCacheAdapter {
  // The Cloudflare edge revalidates by re-requesting the origin (UPDATING),
  // so the origin must not also run in-process background regeneration.
  readonly ownsBackgroundRevalidation = false;

  /**
   * The origin keeps no page store — return null so the request renders fresh.
   * The edge serves cached HIT/STALE responses without reaching the origin.
   */
  async readPage(): Promise<CacheHandlerValue | null> {
    return null;
  }

  /** No-op: the platform caches the response via its headers, not an origin store. */
  async writePage(
    _key: string,
    _data: IncrementalCacheValue | null,
    _ctx?: Record<string, unknown>,
  ): Promise<void> {
    // intentionally empty
  }

  buildResponseHeaders(input: CdnCacheableHeaderInput): CdnResponseHeaders {
    // No cacheable policy → nobody stores it.
    if (!input.cacheControl) {
      return { "Cache-Control": NO_STORE };
    }

    // Browsers/private caches must never store the response (`Cache-Control:
    // no-store`); the SWR policy is carried on `CDN-Cache-Control`, which the
    // edge honors to cache + stale-while-revalidate while the browser does not.
    const headers: CdnResponseHeaders = {
      "Cache-Control": NO_STORE,
      "CDN-Cache-Control": input.cacheControl,
    };

    if (input.tags && input.tags.length > 0) {
      const cacheTag = formatCacheTag(input.tags);
      if (cacheTag) headers["Cache-Tag"] = cacheTag;
    }

    return headers;
  }

  /** Purge edge-cached responses by tag via the request context's `cache.purge`. */
  async revalidate(tags: string | string[], _durations?: { expire?: number }): Promise<void> {
    const cache = getWorkersCache();
    if (!cache) return; // no host cache in the request context (e.g. Node dev)

    const tagList = (Array.isArray(tags) ? tags : [tags]).filter(
      (t): t is string => typeof t === "string" && t.length > 0,
    );
    if (tagList.length === 0) return;

    await cache.purge({ tags: tagList });
  }
}
