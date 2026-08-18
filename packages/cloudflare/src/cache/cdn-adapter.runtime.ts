/**
 * Cloudflare CDN cache adapter — page-level ISR admitted through the configured
 * data cache before promotion to Cloudflare Workers Cache (`ctx.cache`).
 *
 * A fresh App Router stream cannot safely emit public edge-cache headers because
 * request APIs may be used after its shell has started streaming. Waiting for
 * completion would destroy streaming, so this adapter uses two-stage admission:
 *
 * - A fresh response streams immediately with `no-store`. Its cache branch is
 *   persisted only after the completed render proves it is static.
 * - A later request reads that admitted artifact and returns it with public edge
 *   headers. Most subsequent HIT/STALE traffic never reaches the Worker.
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
 *
 * The default export is the adapter factory the generated
 * `virtual:vinext-cache-adapters` registration imports; configure it from
 * vite.config via the {@link cdnAdapter} builder in `./cdn-adapter.ts` (which
 * `require.resolve`s this file).
 */

import type {
  CdnCacheAdapter,
  CdnCacheableHeaderInput,
  CdnResponseHeaders,
} from "vinext/shims/cdn-cache";
import type { CacheHandlerValue, IncrementalCacheValue } from "vinext/shims/cache";
import { getDataCacheHandler, MemoryCacheHandler } from "vinext/shims/cache-handler";
import { getRequestExecutionContext } from "vinext/shims/request-context";

const NON_CACHEABLE_DIRECTIVE_RE = /\b(?:private|no-store|no-cache)\b/i;
const CACHEABLE_EDGE_DIRECTIVE_RE = /(?:^|,)\s*(?:s-maxage|max-age)\s*=/i;
const EDGE_POLICY_HEADERS = ["CDN-Cache-Control", "Cloudflare-CDN-Cache-Control"] as const;

/** Remove every response header whose cache semantics are owned by Cloudflare. */
function clearCloudflareCdnResponseHeaders(cacheControl: string): CdnResponseHeaders {
  return {
    "Cache-Control": cacheControl,
    "CDN-Cache-Control": null,
    "Cloudflare-CDN-Cache-Control": null,
    "Cache-Tag": null,
  };
}

/** Interpret Cloudflare's edge policy before core applies a replacement policy. */
function hasExplicitCloudflareNonCacheableResponsePolicy(headers: Headers): boolean {
  const edgePolicies = EDGE_POLICY_HEADERS.map((name) => headers.get(name));
  if (edgePolicies.some((value) => value && NON_CACHEABLE_DIRECTIVE_RE.test(value))) {
    return true;
  }

  const hasCacheableEdgePolicy = edgePolicies.some(
    (value) => value && CACHEABLE_EDGE_DIRECTIVE_RE.test(value),
  );
  const browserPolicy = headers.get("Cache-Control");
  return Boolean(
    !hasCacheableEdgePolicy && browserPolicy && NON_CACHEABLE_DIRECTIVE_RE.test(browserPolicy),
  );
}

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
    // Header separators and control characters are never valid tag content.
    // Count UTF-8 bytes, not UTF-16 code units, against Cloudflare's limits.
    // oxlint-disable-next-line no-control-regex -- intentional header-injection guard
    if (!tag || /[\x00-\x1f\x7f,]/.test(tag)) continue;
    const tagBytes = new TextEncoder().encode(tag).byteLength;
    if (tagBytes > MAX_SINGLE_TAG_BYTES) continue;
    // +1 accounts for the joining comma.
    const next = total + tagBytes + (parts.length > 0 ? 1 : 0);
    if (next > MAX_CACHE_TAG_BYTES) break;
    parts.push(tag);
    total = next;
  }
  return parts.length > 0 ? parts.join(",") : null;
}

export class CloudflareCdnCacheAdapter implements CdnCacheAdapter {
  // Stale admission artifacts regenerate at the origin; otherwise every edge
  // revalidation would replay the same stale artifact indefinitely.
  readonly ownsBackgroundRevalidation = true;

  /**
   * Read a completed artifact from the configured durable admission store.
   */
  async get(key: string, ctx?: Record<string, unknown>): Promise<CacheHandlerValue | null> {
    const handler = getDataCacheHandler();
    // The process-local fallback disappears whenever a Worker isolate is
    // replaced. It is not proof that an artifact was durably admitted.
    if (handler instanceof MemoryCacheHandler) return null;
    return handler.get(key, ctx);
  }

  /** Persist a completed, proven-static artifact for later edge promotion. */
  async set(
    key: string,
    data: IncrementalCacheValue | null,
    ctx?: Record<string, unknown>,
  ): Promise<void> {
    const handler = getDataCacheHandler();
    if (handler instanceof MemoryCacheHandler) return;
    await handler.set(key, data, ctx);
  }

  buildResponseHeaders(input: CdnCacheableHeaderInput): CdnResponseHeaders {
    // Header-time policy is irreversible. A fresh stream remains private while
    // its cache branch is evaluated and, if proven static, durably admitted.
    if (input.pendingDynamicCheck) {
      return clearCloudflareCdnResponseHeaders(NO_STORE);
    }

    if (input.cacheState === "STALE") {
      return clearCloudflareCdnResponseHeaders(NO_STORE);
    }

    // No cacheable policy → nobody stores it.
    if (!input.cacheControl) {
      return clearCloudflareCdnResponseHeaders(NO_STORE);
    }

    // A non-cacheable policy (no-store / no-cache / private) must never be
    // promoted to an edge cache. Clear any cacheable headers this adapter owns
    // in case middleware stamped them before the final policy was known.
    if (NON_CACHEABLE_DIRECTIVE_RE.test(input.cacheControl)) {
      return clearCloudflareCdnResponseHeaders(input.cacheControl);
    }

    // SWR policy on CDN-Cache-Control (edge caches + revalidates); the browser
    // is told to revalidate every reuse so it never serves a stale stored copy.
    const headers: CdnResponseHeaders = {
      "Cache-Control": BROWSER_REVALIDATE,
      "CDN-Cache-Control": toEdgeCacheControl(input.cacheControl),
      "Cloudflare-CDN-Cache-Control": null,
      "Cache-Tag": input.tags ? formatCacheTag(input.tags) : null,
    };

    return headers;
  }

  hasExplicitNonCacheableResponsePolicy(headers: Headers): boolean {
    return hasExplicitCloudflareNonCacheableResponsePolicy(headers);
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

// Config-driven adapter factory (default export).
const createCloudflareCdnCacheAdapter = (): CdnCacheAdapter => new CloudflareCdnCacheAdapter();

export default createCloudflareCdnCacheAdapter;
