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
import { getHeadersContext } from "vinext/shims/headers";
import { getRequestExecutionContext } from "vinext/shims/request-context";
import { getRequestContext, isInsideUnifiedScope } from "vinext/shims/unified-request-context";
import {
  NEXT_ROUTER_PREFETCH_HEADER,
  NEXT_ROUTER_SEGMENT_PREFETCH_HEADER,
  NEXT_ROUTER_STATE_TREE_HEADER,
  NEXT_URL_HEADER,
  RSC_HEADER,
  VINEXT_CLIENT_REUSE_MANIFEST_HEADER,
  VINEXT_INTERCEPTION_CONTEXT_HEADER,
  VINEXT_INTERCEPTION_ID_HEADER,
  VINEXT_MOUNTED_SLOTS_HEADER,
  VINEXT_RSC_RENDER_MODE_HEADER,
  VINEXT_RSC_STATE_FINGERPRINT_HEADER,
} from "vinext/internal/server/headers";
import {
  stripRscSuffix,
  VINEXT_RSC_CONTENT_TYPE,
} from "vinext/internal/server/app-rsc-cache-busting";

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
  purge(options: { tags: string[] }): Promise<{ success: boolean }>;
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
const HTML_CACHE_TAG = "__vinext_html";
const RSC_CACHE_TAG = "__vinext_rsc";
const VINEXT_VERSION_PROBE_HEADER = "X-Vinext-Version-Probe";
const VINEXT_VERSION_PROBE_QUERY = "__vinext_version_probe";
const VINEXT_WORKER_VERSION_HEADER = "X-Vinext-Worker-Version";
const CLOUDFLARE_FORWARDED_PROTO_HEADER = "X-Forwarded-Proto";

type CloudflareCdnCacheAdapterEnv = {
  VINEXT_VERSION_METADATA?: { id?: unknown };
};

const RSC_VARIANT_HEADERS = [
  NEXT_ROUTER_STATE_TREE_HEADER,
  NEXT_ROUTER_PREFETCH_HEADER,
  NEXT_ROUTER_SEGMENT_PREFETCH_HEADER,
  NEXT_URL_HEADER,
  VINEXT_INTERCEPTION_CONTEXT_HEADER,
  VINEXT_INTERCEPTION_ID_HEADER,
  VINEXT_MOUNTED_SLOTS_HEADER,
  VINEXT_RSC_RENDER_MODE_HEADER,
  VINEXT_CLIENT_REUSE_MANIFEST_HEADER,
  VINEXT_RSC_STATE_FINGERPRINT_HEADER,
] as const;

function getCacheRequestMetadata(): { headers: Headers | null; url: string | null } {
  if (isInsideUnifiedScope()) {
    const requestContext = getRequestContext();
    if (requestContext.cdnCacheRequestHeaders) {
      return {
        headers: requestContext.cdnCacheRequestHeaders,
        url: requestContext.cdnCacheRequestUrl,
      };
    }
  }
  const headersContext = getHeadersContext();
  return {
    headers: headersContext?.originalRequestHeaders ?? headersContext?.headers ?? null,
    url: headersContext?.originalRequestUrl ?? null,
  };
}

/**
 * Workers Caching purges every Vary variant of one URL together and requires
 * every stored variant to carry the same Cache-Tag values. Render-specific RSC
 * variants can discover different data tags, so only the two stable request
 * shapes are admitted to the edge cache: ordinary HTML (no RSC headers) and
 * ordinary client navigation (`RSC: 1` with no additional variant headers).
 * Other RSC variants still render normally but bypass the shared cache.
 */
function hasNonCanonicalWorkersCacheVariant(): boolean {
  const { headers, url } = getCacheRequestMetadata();
  if (!headers) return false;

  const rsc = headers.get(RSC_HEADER);
  const originalPathname = url ? new URL(url).pathname : null;
  if (originalPathname && stripRscSuffix(originalPathname) !== originalPathname) {
    return true;
  }
  if (rsc !== null && rsc !== "1") return true;
  if (rsc === "1" && headers.get("Accept") !== VINEXT_RSC_CONTENT_TYPE) return true;
  return RSC_VARIANT_HEADERS.some((header) => headers.has(header));
}

function hasRequestCookies(): boolean {
  const { headers } = getCacheRequestMetadata();
  return headers?.has("Cookie") === true;
}

function hasRequestAuthorization(): boolean {
  const { headers } = getCacheRequestMetadata();
  return headers?.has("Authorization") === true;
}

function getWorkersCacheRequestKind(): "html" | "rsc" | null {
  const { headers } = getCacheRequestMetadata();
  if (!headers) return null;
  return headers.get(RSC_HEADER) === "1" ? "rsc" : "html";
}

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
 * Cloudflare's `Cache-Tag` header budget is 16 KB total, while tags supplied to
 * a purge are capped at 1024 characters. Keep a conservative header ceiling
 * and use the purge limit for writes too, so every stored tag remains purgeable.
 */
const MAX_CACHE_TAG_BYTES = 8 * 1024;
const MAX_SINGLE_TAG_BYTES = 1024;
const MAX_CACHE_TAGS = 1000;

/**
 * Build a `Cache-Tag` header value from canonicalised tags. Provider-unsafe
 * characters are percent-encoded, and the whole value is bounded to stay
 * within Cloudflare's limits.
 */
function encodeWorkersCacheTag(tag: string): string | null {
  try {
    const encoded = encodeURIComponent(tag);
    return encoded.length > 0 && encoded.length <= MAX_SINGLE_TAG_BYTES ? encoded : null;
  } catch {
    return null;
  }
}

/**
 * Encode and de-duplicate tags exactly as they will be sent to Cloudflare.
 * Cache tags are case-insensitive, so the first spelling of each encoded tag
 * is retained while subsequent case-only duplicates do not consume the limit.
 */
function encodeWorkersCacheTags(tags: readonly string[]): string[] | null {
  const encodedTags: string[] = [];
  const identities = new Set<string>();
  for (const tag of tags) {
    const encoded = encodeWorkersCacheTag(tag);
    if (encoded === null) return null;

    const identity = encoded.toLowerCase();
    if (identities.has(identity)) continue;
    identities.add(identity);
    encodedTags.push(encoded);
    if (encodedTags.length > MAX_CACHE_TAGS) return null;
  }
  return encodedTags;
}

function formatCacheTag(tags: readonly string[]): { complete: boolean; value: string | null } {
  const encodedTags = encodeWorkersCacheTags(tags);
  if (encodedTags === null) return { complete: false, value: null };

  const parts: string[] = [];
  let total = 0;
  for (const encoded of encodedTags) {
    // +1 accounts for the joining comma.
    const next = total + encoded.length + (parts.length > 0 ? 1 : 0);
    if (next > MAX_CACHE_TAG_BYTES) return { complete: false, value: null };
    parts.push(encoded);
    total = next;
  }
  return { complete: true, value: parts.length > 0 ? parts.join(",") : null };
}

export class CloudflareCdnCacheAdapter implements CdnCacheAdapter {
  constructor(private readonly env?: CloudflareCdnCacheAdapterEnv) {}

  // The Cloudflare edge revalidates by re-requesting the origin (UPDATING),
  // so the origin must not also run in-process background regeneration.
  readonly ownsBackgroundRevalidation = false;

  /** Handle the deploy-time staged-version probe owned by this adapter. */
  handleRequest(request: Request): Response | null {
    if (
      request.method !== "GET" ||
      request.headers.get(VINEXT_VERSION_PROBE_HEADER) !== "1" ||
      !new URL(request.url).searchParams.has(VINEXT_VERSION_PROBE_QUERY)
    ) {
      return null;
    }

    const metadata = this.env?.VINEXT_VERSION_METADATA;
    const versionId = typeof metadata?.id === "string" ? metadata.id : null;
    return new Response(null, {
      status: versionId ? 204 : 503,
      headers: {
        "Cache-Control": NO_STORE,
        [VINEXT_WORKER_VERSION_HEADER]: versionId ?? "unavailable",
      },
    });
  }

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
      return clearCloudflareCdnResponseHeaders(NO_STORE);
    }

    // A non-cacheable policy (no-store / no-cache / private) must never be
    // promoted to an edge cache. Clear any cacheable headers this adapter owns
    // in case middleware stamped them before the final policy was known.
    if (/\b(?:no-store|private)\b/i.test(input.cacheControl)) {
      return clearCloudflareCdnResponseHeaders(input.cacheControl);
    }

    // Workers Caching stores `Cache-Control: no-cache` responses and
    // revalidates them on every request. Preserve that browser-facing policy,
    // but use Cloudflare's higher-priority CDN-scoped header to prohibit edge
    // storage entirely.
    if (/\bno-cache\b/i.test(input.cacheControl)) {
      return {
        "Cache-Control": input.cacheControl,
        "CDN-Cache-Control": null,
        "Cloudflare-CDN-Cache-Control": NO_STORE,
        "Cache-Tag": null,
      };
    }

    // Workers Caching keys the URI path and query string, but not scheme, Host,
    // Cookie, or Authorization. Credential-bearing requests must reach vinext
    // and are never stored because the framework cannot prove arbitrary
    // credentials shareable. Host and Cloudflare's trusted forwarded protocol
    // are isolated through the response Vary contract below.
    if (hasRequestCookies() || hasRequestAuthorization()) {
      return {
        "Cache-Control": NO_STORE,
        "CDN-Cache-Control": null,
        "Cloudflare-CDN-Cache-Control": null,
        "Cache-Tag": null,
      };
    }

    if (hasNonCanonicalWorkersCacheVariant()) {
      return {
        "Cache-Control": NO_STORE,
        "CDN-Cache-Control": null,
        "Cloudflare-CDN-Cache-Control": null,
        "Cache-Tag": null,
      };
    }

    // SWR policy on CDN-Cache-Control (edge caches + revalidates); the browser
    // is told to revalidate every reuse so it never serves a stale stored copy.
    const requestKind = getWorkersCacheRequestKind();
    const headers: CdnResponseHeaders = {
      "Cache-Control": BROWSER_REVALIDATE,
      "CDN-Cache-Control": toEdgeCacheControl(input.cacheControl),
      // Workers Caching is shared across every hostname and URL scheme that
      // reaches one Worker. Host and Cloudflare's overwritten
      // X-Forwarded-Proto are therefore required for both HTML and canonical
      // RSC so one ingress identity cannot reuse another's response.
      Vary:
        requestKind === "rsc"
          ? `Accept, Cookie, Authorization, Host, ${CLOUDFLARE_FORWARDED_PROTO_HEADER}`
          : `Cookie, Authorization, Host, ${CLOUDFLARE_FORWARDED_PROTO_HEADER}`,
      "Cloudflare-CDN-Cache-Control": null,
      "Cache-Tag": null,
    };

    // Workers Caching requires every Vary variant of one URL to carry the same
    // Cache-Tag set. HTML and canonical RSC can legitimately vary by host, so
    // give every stored variant a stable family tag. Any tag/path invalidation
    // purges both families below. Requests outside a known page request context
    // retain their precise render-derived tags.
    const responseTags =
      requestKind === "html"
        ? [HTML_CACHE_TAG]
        : requestKind === "rsc"
          ? [RSC_CACHE_TAG]
          : input.tags;
    if (responseTags && responseTags.length > 0) {
      const cacheTag = formatCacheTag(responseTags);
      if (!cacheTag.complete && requestKind !== "html") {
        return {
          "Cache-Control": NO_STORE,
          "CDN-Cache-Control": null,
          "Cloudflare-CDN-Cache-Control": null,
          "Cache-Tag": null,
        };
      }
      if (cacheTag.value) headers["Cache-Tag"] = cacheTag.value;
    }

    return headers;
  }

  hasExplicitNonCacheableResponsePolicy(headers: Headers): boolean {
    return hasExplicitCloudflareNonCacheableResponsePolicy(headers);
  }

  /** Purge edge-cached responses by tag via the request context's `cache.purge`. */
  async revalidateTag(tags: string | string[], _durations?: { expire?: number }): Promise<void> {
    const cache = getWorkersCache();
    if (!cache) return; // no host cache in the request context (e.g. Node dev)

    const sourceTags = (Array.isArray(tags) ? [...tags] : [tags]).filter(
      (t): t is string => typeof t === "string" && t.length > 0,
    );
    if (sourceTags.length === 0) return;
    const tagList = encodeWorkersCacheTags([...sourceTags, HTML_CACHE_TAG, RSC_CACHE_TAG]);
    if (tagList === null) {
      throw new Error("Cloudflare cache purge cannot represent the complete cache tag set");
    }

    const result = await cache.purge({ tags: tagList });
    if (result.success !== true) {
      throw new Error("Cloudflare cache tag purge failed");
    }
  }
}

// Config-driven adapter factory (default export).
const createCloudflareCdnCacheAdapter = ({
  env,
}: {
  env?: CloudflareCdnCacheAdapterEnv;
} = {}): CdnCacheAdapter => new CloudflareCdnCacheAdapter(env);

export default createCloudflareCdnCacheAdapter;
