/**
 * Tests that TPR's KV upload uses the correct cache key format.
 *
 * The runtime KVCacheHandler reads keys as:
 *   ENTRY_PREFIX + isrCacheKey(router, pathname, buildId) + ":" + suffix
 *   → "cache:app:<buildId>:<pathname>:html"
 *
 * TPR must write keys in this exact format, otherwise seeded entries
 * are dead keys that result in guaranteed cache misses.
 */
import { describe, it, expect } from "vite-plus/test";
import { buildTprKVPairs } from "../packages/vinext/src/cloudflare/tpr.js";
import { isrCacheKey } from "../packages/vinext/src/server/isr-cache.js";

function entry(
  path: string,
  headers: Record<string, string> = {},
): Map<string, { html: string; status: number; headers: Record<string, string> }> {
  return new Map([[path, { html: `<html>${path}</html>`, status: 200, headers }]]);
}

describe("TPR KV key format", () => {
  const buildId = "abc123";

  it("produces keys matching the runtime isrCacheKey format", () => {
    const pairs = buildTprKVPairs(entry("/blog/hello"), buildId, 60);

    expect(pairs.length).toBe(1);
    expect(pairs[0].key).toBe(`cache:${isrCacheKey("app", "/blog/hello", buildId)}:html`);
    expect(pairs[0].key).toBe("cache:app:abc123:/blog/hello:html");
  });

  it("uses revalidate from x-vinext-revalidate header when present", () => {
    const pairs = buildTprKVPairs(entry("/products", { "x-vinext-revalidate": "30" }), buildId, 60);
    const parsed = JSON.parse(pairs[0].value);

    expect(parsed.revalidateAt).not.toBeNull();
    // TTL matches the runtime KVCacheHandler: flat 30-day max, regardless of revalidate period.
    // (Tying TTL to 10x revalidate would evict low-traffic pages before they could be reused.)
    expect(pairs[0].expiration_ttl).toBe(30 * 24 * 3600);
  });

  it("falls back to defaultRevalidateSeconds when header is absent", () => {
    const pairs = buildTprKVPairs(entry("/about"), buildId, 120);
    // TTL is flat 30 days — same strategy as runtime KVCacheHandler.set()
    expect(pairs[0].expiration_ttl).toBe(30 * 24 * 3600);
  });

  it("uses flat 30-day TTL even for very short revalidate windows", () => {
    const pairs = buildTprKVPairs(entry("/fast", { "x-vinext-revalidate": "1" }), buildId, 60);
    // KV TTL is decoupled from revalidation interval to prevent premature eviction.
    expect(pairs[0].expiration_ttl).toBe(30 * 24 * 3600);
  });

  it("uses 24-hour fallback TTL when revalidation is disabled", () => {
    const pairs = buildTprKVPairs(entry("/archive", { "x-vinext-revalidate": "0" }), buildId, 60);
    // revalidateSeconds === 0 means no revalidation — use 24h fallback TTL
    expect(pairs[0].expiration_ttl).toBe(24 * 3600);
  });

  it("buildTprKVPairs accepts undefined buildId (documents key format; runTPR now fails fast if BUILD_ID is missing)", () => {
    // Note: runTPR() skips the KV upload entirely when BUILD_ID is missing, so
    // this no-buildId path is not reachable in production. The test preserves
    // coverage of isrCacheKey's no-buildId format in case the helper is used
    // independently.
    const pairs = buildTprKVPairs(entry("/page"), undefined, 60);
    expect(pairs[0].key).toBe(`cache:${isrCacheKey("app", "/page")}:html`);
    expect(pairs[0].key).toBe("cache:app:/page:html");
  });

  it("serializes entry value in KVCacheEntry format", () => {
    const pairs = buildTprKVPairs(entry("/test", { "content-type": "text/html" }), buildId, 60);
    const parsed = JSON.parse(pairs[0].value);

    expect(parsed.value.kind).toBe("APP_PAGE");
    expect(parsed.value.html).toBe("<html>/test</html>");
    expect(parsed.value.headers).toEqual({ "content-type": "text/html" });
    expect(parsed.value.status).toBe(200);
    expect(parsed.tags).toEqual([]);
    expect(parsed.lastModified).toBeTypeOf("number");
  });
});
