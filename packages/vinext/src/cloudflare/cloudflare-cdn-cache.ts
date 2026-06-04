/**
 * Cloudflare CDN cache adapter — edge-managed page-level ISR backed by the
 * Cloudflare Workers Cache (`ctx.cache`).
 *
 * Unlike the origin-managed default adapter (which stores rendered artifacts in
 * the data cache and serves HIT/STALE itself), this adapter delegates serving
 * to Cloudflare's edge:
 *
 * - The origin never serves from a store — `get` returns `null`, so any
 *   request that reaches the Worker renders fresh. The edge absorbs HIT/STALE
 *   traffic and revalidates in the background (the `UPDATING` cache status).
 * - `set` is a no-op: the platform caches the *response* based on its
 *   cache headers, so there is nothing to persist at the origin.
 * - `buildResponseHeaders` emits the SWR policy as `CDN-Cache-Control`
 *   (`public, max-age=…, stale-while-revalidate=…`) so the edge caches and
 *   revalidates, while the browser-facing `Cache-Control` is
 *   `public, max-age=0, must-revalidate` so a browser never serves a stored copy
 *   without revalidating against the edge. A `Cache-Tag` header lets entries be
 *   purged by tag. Note the edge directive uses `max-age` (not `s-maxage`):
 *   the framework computes the policy with `s-maxage` for shared caches, but
 *   `CDN-Cache-Control` is already CDN-scoped so `max-age` is the correct knob
 *   for the edge to honor max-age + stale-while-revalidate.
 * - `revalidateTag` purges the edge via the request context's `cache.purge({ tags })`.
 *
 * Tag alignment: the tags emitted in `Cache-Tag` come from the page's render
 * tags (already canonicalised via `encodeCacheTag`), and the framework's
 * `revalidateTag` / `revalidatePath` pass the same canonical form to this
 * adapter's `revalidateTag`, so a purge targets exactly the responses that
 * carried the tag.
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
 * A concrete stale window (1 year) substituted for a value-less
 * `stale-while-revalidate`. The framework emits a bare `stale-while-revalidate`
 * (no `=seconds`) to mean an unbounded stale window — a Vercel CDN extension.
 * Cloudflare follows RFC 5861, which requires `stale-while-revalidate=<seconds>`,
 * and treats the value-less form as a zero-width window (no stale serving →
 * hard expiry at `max-age`, so the next request is a MISS instead of UPDATING).
 * Stamping a large finite value preserves the "serve stale ~indefinitely while
 * revalidating" intent in a form the edge honors.
 */
const UNBOUNDED_SWR_SECONDS = 31_536_000; // 1 year

/**
 * Convert the framework's shared-cache policy into a CDN-scoped one:
 * `s-maxage=…` → `max-age=…` (the edge honors `max-age` inside
 * `CDN-Cache-Control`), give a value-less `stale-while-revalidate` an explicit
 * seconds value (Cloudflare ignores the bare directive), and ensure a leading
 * `public`.
 */
function toEdgeCacheControl(cacheControl: string): string {
  const withMaxAge = cacheControl
    .replace(/\bs-maxage=/g, "max-age=")
    // Bare `stale-while-revalidate` (not followed by `=`) → explicit window.
    .replace(/\bstale-while-revalidate\b(?!=)/g, `stale-while-revalidate=${UNBOUNDED_SWR_SECONDS}`);
  return /\bpublic\b/.test(withMaxAge) ? withMaxAge : `public, ${withMaxAge}`;
}

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
  async get(): Promise<CacheHandlerValue | null> {
    return null;
  }

  /** No-op: the platform caches the response via its headers, not an origin store. */
  async set(
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
  async revalidateTag(tags: string | string[], _durations?: { expire?: number }): Promise<void> {
    const cache = getWorkersCache();
    if (!cache) return; // no host cache in the request context (e.g. Node dev)

    const tagList = (Array.isArray(tags) ? tags : [tags]).filter(
      (t): t is string => typeof t === "string" && t.length > 0,
    );
    if (tagList.length === 0) return;

    await cache.purge({ tags: tagList });
  }
}
