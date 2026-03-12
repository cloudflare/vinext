/**
 * Unit tests for Cloudflare KV cache handler.
 *
 * Tests validation and robustness:
 * - Schema validation of deserialized cache entries
 * - Safe base64 decoding (no crash on invalid input)
 * - Corrupted/poisoned entries treated as cache miss
 * - Valid entries round-trip correctly
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { KVCacheHandler } from "../packages/vinext/src/cloudflare/kv-cache-handler.js";

// ---------------------------------------------------------------------------
// Mock KV namespace
// ---------------------------------------------------------------------------

function createMockKV(store: Map<string, string> = new Map()) {
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    list: vi.fn(async () => ({ keys: [], list_complete: true })),
  };
}

// ---------------------------------------------------------------------------
// Mock ExecutionContext
// ---------------------------------------------------------------------------

function createMockCtx() {
  const registered: Promise<unknown>[] = [];
  return {
    waitUntil: vi.fn((p: Promise<unknown>) => {
      registered.push(p);
    }),
    registered,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a valid KV cache entry JSON string. */
function validEntry(value: object | null, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    value,
    tags: [],
    lastModified: Date.now(),
    revalidateAt: null,
    ...overrides,
  });
}

describe("KVCacheHandler", () => {
  let store: Map<string, string>;
  let kv: ReturnType<typeof createMockKV>;
  let handler: KVCacheHandler;

  beforeEach(() => {
    store = new Map();
    kv = createMockKV(store);
    handler = new KVCacheHandler(kv as any);
  });

  // -------------------------------------------------------------------------
  // Basic round-trip
  // -------------------------------------------------------------------------

  it("returns null for missing key", async () => {
    const result = await handler.get("nonexistent");
    expect(result).toBeNull();
  });

  it("returns valid PAGES entry", async () => {
    store.set(
      "cache:my-page",
      validEntry({
        kind: "PAGES",
        html: "<html></html>",
        pageData: {},
        headers: undefined,
        status: 200,
      }),
    );
    const result = await handler.get("my-page");
    expect(result).not.toBeNull();
    expect(result!.value!.kind).toBe("PAGES");
  });

  it("returns valid entry with null value", async () => {
    store.set("cache:null-val", validEntry(null));
    const result = await handler.get("null-val");
    expect(result).not.toBeNull();
    expect(result!.value).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Schema validation (H12)
  // -------------------------------------------------------------------------

  describe("schema validation", () => {
    it("rejects non-JSON string as cache miss", async () => {
      store.set("cache:bad-json", "not valid json {{{");
      const result = await handler.get("bad-json");
      expect(result).toBeNull();
      expect(kv.delete).toHaveBeenCalledWith("cache:bad-json");
    });

    it("rejects primitive value as cache miss", async () => {
      store.set("cache:prim", JSON.stringify(42));
      const result = await handler.get("prim");
      expect(result).toBeNull();
      expect(kv.delete).toHaveBeenCalledWith("cache:prim");
    });

    it("rejects null as cache miss", async () => {
      store.set("cache:null", JSON.stringify(null));
      const result = await handler.get("null");
      expect(result).toBeNull();
      expect(kv.delete).toHaveBeenCalledWith("cache:null");
    });

    it("rejects entry missing lastModified", async () => {
      store.set(
        "cache:no-lm",
        JSON.stringify({
          value: null,
          tags: [],
          revalidateAt: null,
        }),
      );
      const result = await handler.get("no-lm");
      expect(result).toBeNull();
      expect(kv.delete).toHaveBeenCalledWith("cache:no-lm");
    });

    it("rejects entry missing tags", async () => {
      store.set(
        "cache:no-tags",
        JSON.stringify({
          value: null,
          lastModified: 123,
          revalidateAt: null,
        }),
      );
      const result = await handler.get("no-tags");
      expect(result).toBeNull();
      expect(kv.delete).toHaveBeenCalledWith("cache:no-tags");
    });

    it("rejects entry with non-array tags", async () => {
      store.set(
        "cache:bad-tags",
        JSON.stringify({
          value: null,
          tags: "not-an-array",
          lastModified: 123,
          revalidateAt: null,
        }),
      );
      const result = await handler.get("bad-tags");
      expect(result).toBeNull();
      expect(kv.delete).toHaveBeenCalledWith("cache:bad-tags");
    });

    it("rejects entry with invalid revalidateAt type", async () => {
      store.set(
        "cache:bad-reval",
        JSON.stringify({
          value: null,
          tags: [],
          lastModified: 123,
          revalidateAt: "not-a-number",
        }),
      );
      const result = await handler.get("bad-reval");
      expect(result).toBeNull();
      expect(kv.delete).toHaveBeenCalledWith("cache:bad-reval");
    });

    it("rejects entry with unknown value kind", async () => {
      store.set("cache:bad-kind", validEntry({ kind: "UNKNOWN_KIND", data: {} }));
      const result = await handler.get("bad-kind");
      expect(result).toBeNull();
      expect(kv.delete).toHaveBeenCalledWith("cache:bad-kind");
    });

    it("rejects entry where value is a non-object", async () => {
      store.set(
        "cache:val-str",
        JSON.stringify({
          value: "a string",
          tags: [],
          lastModified: 123,
          revalidateAt: null,
        }),
      );
      const result = await handler.get("val-str");
      expect(result).toBeNull();
      expect(kv.delete).toHaveBeenCalledWith("cache:val-str");
    });

    it("rejects entry where value has no kind field", async () => {
      store.set("cache:no-kind", validEntry({ html: "<html></html>" }));
      const result = await handler.get("no-kind");
      expect(result).toBeNull();
      expect(kv.delete).toHaveBeenCalledWith("cache:no-kind");
    });

    it("accepts all valid cache value kinds", async () => {
      const kinds = ["FETCH", "APP_PAGE", "PAGES", "APP_ROUTE", "REDIRECT", "IMAGE"];
      for (const kind of kinds) {
        store.set(`cache:kind-${kind}`, validEntry({ kind }));
        const result = await handler.get(`kind-${kind}`);
        expect(result).not.toBeNull();
        expect(result!.value!.kind).toBe(kind);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Base64 decode safety (H13)
  // -------------------------------------------------------------------------

  describe("base64 decode safety", () => {
    it("handles valid base64 in APP_ROUTE body", async () => {
      // btoa("hello") === "aGVsbG8="
      store.set(
        "cache:valid-b64",
        validEntry({
          kind: "APP_ROUTE",
          body: "aGVsbG8=",
          status: 200,
          headers: {},
        }),
      );
      const result = await handler.get("valid-b64");
      expect(result).not.toBeNull();
      // body should be restored to ArrayBuffer
      const body = (result!.value as any).body;
      expect(body).toBeInstanceOf(ArrayBuffer);
      expect(new TextDecoder().decode(body)).toBe("hello");
    });

    it("treats invalid base64 in APP_ROUTE body as cache miss", async () => {
      store.set(
        "cache:bad-b64-route",
        validEntry({
          kind: "APP_ROUTE",
          body: "!!!not-valid-base64!!!",
          status: 200,
          headers: {},
        }),
      );
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const result = await handler.get("bad-b64-route");
      expect(result).toBeNull();
      expect(kv.delete).toHaveBeenCalledWith("cache:bad-b64-route");
      expect(consoleSpy).toHaveBeenCalledWith("[vinext] Invalid base64 in cache entry");
      consoleSpy.mockRestore();
    });

    it("treats invalid base64 in APP_PAGE rscData as cache miss", async () => {
      store.set(
        "cache:bad-b64-page",
        validEntry({
          kind: "APP_PAGE",
          html: "<html></html>",
          rscData: "%%%garbage%%%",
          headers: undefined,
          postponed: undefined,
          status: 200,
        }),
      );
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const result = await handler.get("bad-b64-page");
      expect(result).toBeNull();
      expect(kv.delete).toHaveBeenCalledWith("cache:bad-b64-page");
      consoleSpy.mockRestore();
    });

    it("treats invalid base64 in IMAGE buffer as cache miss", async () => {
      store.set(
        "cache:bad-b64-img",
        validEntry({
          kind: "IMAGE",
          etag: "abc",
          buffer: "===broken===",
          extension: "png",
        }),
      );
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const result = await handler.get("bad-b64-img");
      expect(result).toBeNull();
      expect(kv.delete).toHaveBeenCalledWith("cache:bad-b64-img");
      consoleSpy.mockRestore();
    });

    it("does not crash on empty string base64 field", async () => {
      store.set(
        "cache:empty-b64",
        validEntry({
          kind: "APP_ROUTE",
          body: "",
          status: 200,
          headers: {},
        }),
      );
      // Empty string is valid base64 (decodes to empty buffer)
      const result = await handler.get("empty-b64");
      expect(result).not.toBeNull();
      const body = (result!.value as any).body;
      expect(body).toBeInstanceOf(ArrayBuffer);
      expect(body.byteLength).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // set() + get() round-trip
  // -------------------------------------------------------------------------

  describe("set and get round-trip", () => {
    it("round-trips APP_ROUTE with ArrayBuffer body", async () => {
      const bodyBytes = new TextEncoder().encode("response body");
      await handler.set("rt-route", {
        kind: "APP_ROUTE",
        body: bodyBytes.buffer as ArrayBuffer,
        status: 200,
        headers: { "content-type": "text/plain" },
      });

      const result = await handler.get("rt-route");
      expect(result).not.toBeNull();
      expect(result!.value!.kind).toBe("APP_ROUTE");
      const decoded = new TextDecoder().decode((result!.value as any).body);
      expect(decoded).toBe("response body");
    });

    it("round-trips PAGES entry", async () => {
      await handler.set("rt-pages", {
        kind: "PAGES",
        html: "<div>hi</div>",
        pageData: { foo: 1 },
        headers: undefined,
        status: 200,
      });

      const result = await handler.get("rt-pages");
      expect(result).not.toBeNull();
      expect(result!.value!.kind).toBe("PAGES");
      expect((result!.value as any).html).toBe("<div>hi</div>");
    });

    it("preserves slash-based path tags for Workers invalidation", async () => {
      await handler.set(
        "rt-path-tags",
        {
          kind: "APP_PAGE",
          html: "<div>hi</div>",
          rscData: undefined,
          headers: undefined,
          postponed: undefined,
          status: 200,
        },
        {
          revalidate: 60,
          tags: ["/revalidate-tag-test", "_N_T_/revalidate-tag-test", "test-data"],
        },
      );

      const raw = store.get("cache:rt-path-tags");
      expect(raw).toBeTruthy();
      const parsed = JSON.parse(raw!);
      expect(parsed.tags).toEqual([
        "/revalidate-tag-test",
        "_N_T_/revalidate-tag-test",
        "test-data",
      ]);
    });
  });

  describe("tag invalidation", () => {
    it("revalidateTag persists slash-based path invalidation markers", async () => {
      await handler.revalidateTag(["/revalidate-tag-test", "_N_T_/revalidate-tag-test"]);

      expect(store.get("__tag:/revalidate-tag-test")).toMatch(/^\d+$/);
      expect(store.get("__tag:_N_T_/revalidate-tag-test")).toMatch(/^\d+$/);
    });

    it("slash-based path tags invalidate persisted APP_PAGE entries", async () => {
      const entryTime = 1000;
      const invalidatedTime = 2000;

      store.set(
        "cache:app-page",
        JSON.stringify({
          value: {
            kind: "APP_PAGE",
            html: "<html>cached</html>",
            rscData: undefined,
            headers: undefined,
            postponed: undefined,
            status: 200,
          },
          tags: ["/revalidate-tag-test", "_N_T_/revalidate-tag-test"],
          lastModified: entryTime,
          revalidateAt: null,
        }),
      );
      store.set("__tag:/revalidate-tag-test", String(invalidatedTime));

      const result = await handler.get("app-page");

      expect(result).toBeNull();
      expect(kv.delete).toHaveBeenCalledWith("cache:app-page");
    });
  });

  // -------------------------------------------------------------------------
  // ArrayBuffer base64 roundtrip edge cases
  // -------------------------------------------------------------------------

  describe("ArrayBuffer base64 roundtrip edge cases", () => {
    it("round-trips a large buffer (1 MiB)", async () => {
      const size = 1024 * 1024; // 1 MiB
      const original = new Uint8Array(size);
      for (let i = 0; i < size; i++) {
        original[i] = i % 256;
      }

      await handler.set("large-buf", {
        kind: "APP_ROUTE",
        body: original.buffer as ArrayBuffer,
        status: 200,
        headers: { "content-type": "application/octet-stream" },
      });

      const result = await handler.get("large-buf");
      expect(result).not.toBeNull();
      const restored = new Uint8Array((result!.value as any).body);
      expect(restored.byteLength).toBe(size);
      // Verify every byte survived the roundtrip
      expect(restored).toEqual(original);
    });

    it("round-trips a buffer containing null bytes", async () => {
      const original = new Uint8Array([0, 0, 0, 72, 101, 108, 108, 111, 0, 0, 0]);

      await handler.set("null-bytes", {
        kind: "APP_ROUTE",
        body: original.buffer as ArrayBuffer,
        status: 200,
        headers: {},
      });

      const result = await handler.get("null-bytes");
      expect(result).not.toBeNull();
      const restored = new Uint8Array((result!.value as any).body);
      expect(restored).toEqual(original);
    });

    it("round-trips a buffer with all 256 byte values", async () => {
      const original = new Uint8Array(256);
      for (let i = 0; i < 256; i++) {
        original[i] = i;
      }

      await handler.set("all-bytes", {
        kind: "APP_ROUTE",
        body: original.buffer as ArrayBuffer,
        status: 200,
        headers: {},
      });

      const result = await handler.get("all-bytes");
      expect(result).not.toBeNull();
      const restored = new Uint8Array((result!.value as any).body);
      expect(restored).toEqual(original);
    });
  });

  // -------------------------------------------------------------------------
  // ctx.waitUntil registration
  // -------------------------------------------------------------------------

  describe("ctx.waitUntil registration", () => {
    it("registers corrupt-JSON delete with waitUntil when ctx is provided", async () => {
      const ctx = createMockCtx();
      const handlerWithCtx = new KVCacheHandler(kv as any, { ctx });
      store.set("cache:corrupt", "not valid json {{{");

      await handlerWithCtx.get("corrupt");

      expect(ctx.waitUntil).toHaveBeenCalledOnce();
      // The registered promise must be the delete promise returned by kv.delete
      expect(kv.delete).toHaveBeenCalledWith("cache:corrupt");
      await Promise.all(ctx.registered); // let the background op settle
      expect(store.has("cache:corrupt")).toBe(false);
    });

    it("registers invalid-shape delete with waitUntil when ctx is provided", async () => {
      const ctx = createMockCtx();
      const handlerWithCtx = new KVCacheHandler(kv as any, { ctx });
      store.set("cache:bad-shape", JSON.stringify({ notValid: true }));

      await handlerWithCtx.get("bad-shape");

      expect(ctx.waitUntil).toHaveBeenCalledOnce();
      expect(kv.delete).toHaveBeenCalledWith("cache:bad-shape");
    });

    it("registers tag-invalidation delete with waitUntil when ctx is provided", async () => {
      const ctx = createMockCtx();
      const handlerWithCtx = new KVCacheHandler(kv as any, { ctx });
      const entryTime = 1000;
      const tagInvalidatedTime = 2000; // after entry — triggers invalidation

      store.set(
        "cache:tagged",
        JSON.stringify({
          value: { kind: "PAGES", html: "", pageData: {}, status: 200 },
          tags: ["my-tag"],
          lastModified: entryTime,
          revalidateAt: null,
        }),
      );
      store.set("__tag:my-tag", String(tagInvalidatedTime));

      await handlerWithCtx.get("tagged");

      expect(ctx.waitUntil).toHaveBeenCalledOnce();
      expect(kv.delete).toHaveBeenCalledWith("cache:tagged");
    });

    it("registers KV put with waitUntil on set() when ctx is provided", async () => {
      const ctx = createMockCtx();
      const handlerWithCtx = new KVCacheHandler(kv as any, { ctx });

      await handlerWithCtx.set("write-me", {
        kind: "PAGES",
        html: "<html></html>",
        pageData: {},
        headers: undefined,
        status: 200,
      });

      expect(ctx.waitUntil).toHaveBeenCalledOnce();
      expect(kv.put).toHaveBeenCalledWith(
        "cache:write-me",
        expect.any(String),
        expect.objectContaining({}),
      );
      await Promise.all(ctx.registered);
      expect(store.has("cache:write-me")).toBe(true);
    });

    it("fires delete without waitUntil when no ctx (fire-and-forget fallback)", async () => {
      // handler created without ctx in beforeEach
      store.set("cache:no-ctx-del", "not valid json");
      await handler.get("no-ctx-del");
      // kv.delete was called directly (no waitUntil involved)
      expect(kv.delete).toHaveBeenCalledWith("cache:no-ctx-del");
    });

    it("fires put without waitUntil when no ctx (fire-and-forget fallback)", async () => {
      await handler.set("no-ctx-put", {
        kind: "PAGES",
        html: "<p>hi</p>",
        pageData: {},
        headers: undefined,
        status: 200,
      });
      expect(kv.put).toHaveBeenCalledWith(
        "cache:no-ctx-put",
        expect.any(String),
        expect.any(Object),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Local tag cache
  // -------------------------------------------------------------------------

  describe("local tag cache", () => {
    it("cached tags skip KV on second get()", async () => {
      const entryTime = 1000;
      store.set(
        "cache:tagged-page",
        JSON.stringify({
          value: { kind: "PAGES", html: "<p>hi</p>", pageData: {}, status: 200 },
          tags: ["t1", "t2"],
          lastModified: entryTime,
          revalidateAt: null,
        }),
      );
      // No tag invalidation timestamps in KV — tags are valid

      // First get() — should fetch tags from KV (cache miss in local cache)
      const result1 = await handler.get("tagged-page");
      expect(result1).not.toBeNull();

      // kv.get calls: 1 for the entry + 2 for the tags = 3
      expect(kv.get).toHaveBeenCalledTimes(3);

      // Reset call counts
      kv.get.mockClear();

      // Second get() — tags should come from local cache, NOT from KV
      const result2 = await handler.get("tagged-page");
      expect(result2).not.toBeNull();

      // kv.get calls: 1 for the entry only, 0 for tags
      expect(kv.get).toHaveBeenCalledTimes(1);
      expect(kv.get).toHaveBeenCalledWith("cache:tagged-page");
    });

    it("revalidateTag() updates local cache so subsequent get() skips KV for that tag", async () => {
      const entryTime = 1000;

      // revalidateTag sets the invalidation timestamp
      await handler.revalidateTag("t1");

      kv.get.mockClear();

      // Now store an entry with tag t1 that was created BEFORE the invalidation
      store.set(
        "cache:rt-page",
        JSON.stringify({
          value: { kind: "PAGES", html: "<p>old</p>", pageData: {}, status: 200 },
          tags: ["t1"],
          lastModified: entryTime,
          revalidateAt: null,
        }),
      );

      // get() should see tag t1 is invalidated via local cache — no KV GET for __tag:t1
      const result = await handler.get("rt-page");
      expect(result).toBeNull(); // invalidated

      // kv.get: 1 for entry, 0 for tags (t1 was in local cache)
      expect(kv.get).toHaveBeenCalledTimes(1);
      expect(kv.get).toHaveBeenCalledWith("cache:rt-page");
    });

    it("TTL expiry triggers fresh KV fetch", async () => {
      // Use tagCacheTtlMs: 0 so entries expire immediately — no fake timers needed.
      const shortTtlHandler = new KVCacheHandler(kv as any, { tagCacheTtlMs: 0 });

      const entryTime = 1000;
      store.set(
        "cache:ttl-page",
        JSON.stringify({
          value: { kind: "PAGES", html: "<p>hi</p>", pageData: {}, status: 200 },
          tags: ["t1"],
          lastModified: entryTime,
          revalidateAt: null,
        }),
      );

      // First get() — populates local tag cache (entry + tag = 2 calls)
      await shortTtlHandler.get("ttl-page");
      expect(kv.get).toHaveBeenCalledTimes(2);
      kv.get.mockClear();

      // Second get() — TTL is 0ms so entry is already expired; must re-fetch tag from KV
      await shortTtlHandler.get("ttl-page");
      expect(kv.get).toHaveBeenCalledTimes(2); // entry + tag again
    });

    it("tag invalidation works end-to-end with local cache", async () => {
      const entryTime = 1000;
      store.set(
        "cache:e2e-page",
        JSON.stringify({
          value: { kind: "PAGES", html: "<p>original</p>", pageData: {}, status: 200 },
          tags: ["t1"],
          lastModified: entryTime,
          revalidateAt: null,
        }),
      );

      // First get() succeeds (no invalidation yet)
      const result1 = await handler.get("e2e-page");
      expect(result1).not.toBeNull();

      // Now invalidate tag t1
      await handler.revalidateTag("t1");

      // get() should return null (cache miss due to tag invalidation)
      const result2 = await handler.get("e2e-page");
      expect(result2).toBeNull();
    });

    it("uncached tags are still fetched from KV", async () => {
      const entryTime = 1000;

      // Store entry with two tags
      store.set(
        "cache:partial-page",
        JSON.stringify({
          value: { kind: "PAGES", html: "<p>hi</p>", pageData: {}, status: 200 },
          tags: ["t1", "t2"],
          lastModified: entryTime,
          revalidateAt: null,
        }),
      );

      // First get() populates local cache for both t1 and t2
      await handler.get("partial-page");
      kv.get.mockClear();

      // Now add a DIFFERENT entry that shares t1 but also has t3 (not yet cached)
      store.set(
        "cache:partial-page2",
        JSON.stringify({
          value: { kind: "PAGES", html: "<p>other</p>", pageData: {}, status: 200 },
          tags: ["t1", "t3"],
          lastModified: entryTime,
          revalidateAt: null,
        }),
      );

      const result = await handler.get("partial-page2");
      expect(result).not.toBeNull();

      // kv.get: 1 for entry + 1 for t3 (t1 was cached). NOT 2 for tags.
      expect(kv.get).toHaveBeenCalledTimes(2);
      // Verify the calls are for the entry and t3 only
      expect(kv.get).toHaveBeenCalledWith("cache:partial-page2");
      expect(kv.get).toHaveBeenCalledWith("__tag:t3");
    });

    it("NaN tag timestamp in local cache treated as invalidation", async () => {
      const entryTime = 1000;

      // Put a non-numeric tag value in KV
      store.set("__tag:bad-tag", "not-a-number");

      store.set(
        "cache:nan-page",
        JSON.stringify({
          value: { kind: "PAGES", html: "<p>hi</p>", pageData: {}, status: 200 },
          tags: ["bad-tag"],
          lastModified: entryTime,
          revalidateAt: null,
        }),
      );

      // First get() — fetches from KV, gets NaN, caches it, returns null
      const result1 = await handler.get("nan-page");
      expect(result1).toBeNull();

      kv.get.mockClear();

      // Re-store the entry (it was deleted by the first get)
      store.set(
        "cache:nan-page",
        JSON.stringify({
          value: { kind: "PAGES", html: "<p>hi</p>", pageData: {}, status: 200 },
          tags: ["bad-tag"],
          lastModified: entryTime,
          revalidateAt: null,
        }),
      );

      // Second get() — NaN is in local cache, should still treat as invalidation
      const result2 = await handler.get("nan-page");
      expect(result2).toBeNull();

      // kv.get: 1 for entry, 0 for tag (NaN was cached locally)
      expect(kv.get).toHaveBeenCalledTimes(1);
    });

    it("resetRequestCache() forces tags to be re-fetched from KV", async () => {
      const entryTime = 1000;
      store.set(
        "cache:reset-page",
        JSON.stringify({
          value: { kind: "PAGES", html: "<p>hi</p>", pageData: {}, status: 200 },
          tags: ["t1", "t2"],
          lastModified: entryTime,
          revalidateAt: null,
        }),
      );

      // First get() — populates local tag cache (1 entry + 2 tags = 3 calls)
      const result1 = await handler.get("reset-page");
      expect(result1).not.toBeNull();
      expect(kv.get).toHaveBeenCalledTimes(3);
      kv.get.mockClear();

      // Second get() without reset — tags served from local cache (1 entry only)
      const result2 = await handler.get("reset-page");
      expect(result2).not.toBeNull();
      expect(kv.get).toHaveBeenCalledTimes(1);
      kv.get.mockClear();

      // Clear the local cache
      handler.resetRequestCache();

      // Third get() after reset — tags must be re-fetched from KV (1 entry + 2 tags = 3 calls)
      const result3 = await handler.get("reset-page");
      expect(result3).not.toBeNull();
      expect(kv.get).toHaveBeenCalledTimes(3);
      expect(kv.get).toHaveBeenCalledWith("cache:reset-page");
      expect(kv.get).toHaveBeenCalledWith("__tag:t1");
      expect(kv.get).toHaveBeenCalledWith("__tag:t2");
    });
  });

  // -------------------------------------------------------------------------
  // STALE → regen → HIT lifecycle
  //
  // Regression test for: KVCacheHandler.set() was returning Promise.resolve()
  // immediately, so await __isrSet() in the background regen resolved BEFORE
  // the KV put network operation completed. The renderFn() resolved early,
  // ctx.waitUntil(renderFnPromise) expired, and the KV write was killed by
  // the Workers runtime — leaving the entry perpetually STALE.
  //
  // Fix: KVCacheHandler.set() now returns the real kv.put() promise so
  // await __isrSet() only resolves after the write is fully persisted.
  // -------------------------------------------------------------------------

  describe("STALE → regen → HIT lifecycle", () => {
    it("set() resolves only after the KV put completes", async () => {
      // Use a controlled put that we can observe — kv from createMockKV resolves
      // synchronously in the mock, but what matters is that awaiting set() sees
      // the key in the store before the await returns.
      const handler2 = new KVCacheHandler(kv as any);

      await handler2.set(
        "stale-regen",
        {
          kind: "APP_PAGE",
          html: "<html>fresh</html>",
          rscData: undefined,
          headers: undefined,
          postponed: undefined,
          status: 200,
        },
        { revalidate: 10 },
      );

      // After await, the KV store must already contain the key.
      // Before the fix this would also pass (synchronous mock), but the
      // important invariant is that the returned promise IS the kv.put promise.
      expect(store.has("cache:stale-regen")).toBe(true);
      const raw = store.get("cache:stale-regen")!;
      const parsed = JSON.parse(raw);
      expect(parsed.value.html).toBe("<html>fresh</html>");
      expect(parsed.revalidateAt).toBeTypeOf("number");
    });

    it("set() returned promise is the kv.put promise (not an immediately-resolved stub)", async () => {
      // Swap out kv.put with a delayed version so we can verify that the
      // promise returned by set() is NOT resolved until the put completes.
      let resolveKvPut!: () => void;
      const kvPutLatch = new Promise<void>((r) => {
        resolveKvPut = r;
      });
      kv.put = vi.fn(async (key: string, value: string) => {
        await kvPutLatch;
        store.set(key, value);
      });

      const setPromise = handler.set("delayed-put", {
        kind: "PAGES",
        html: "<p>test</p>",
        pageData: {},
        headers: undefined,
        status: 200,
      });

      // The set() promise should NOT be resolved yet because the kv.put hasn't resolved.
      let setSettled = false;
      setPromise.then(() => {
        setSettled = true;
      });

      // Give microtasks a chance to run
      await Promise.resolve();
      await Promise.resolve();

      expect(setSettled).toBe(false);
      expect(store.has("cache:delayed-put")).toBe(false);

      // Now let the kv.put complete
      resolveKvPut();
      await setPromise;

      expect(setSettled).toBe(true);
      expect(store.has("cache:delayed-put")).toBe(true);
    });

    it("background regen waitUntil covers actual KV write with delayed put", async () => {
      // Simulate a delayed KV put (network latency) to prove that
      // ctx.waitUntil keeps the isolate alive until the write completes.
      let resolveKvPut!: () => void;
      const kvPutLatch = new Promise<void>((r) => {
        resolveKvPut = r;
      });

      kv.put = vi.fn(async (key: string, value: string) => {
        await kvPutLatch;
        store.set(key, value);
      });

      const ctx = createMockCtx();
      const handlerWithCtx = new KVCacheHandler(kv as any, { ctx });

      // Simulate the regen renderFn pattern from app-rsc-entry.ts
      const renderFn = async () => {
        await handlerWithCtx.set(
          "regen-key",
          {
            kind: "APP_PAGE",
            html: "<html>revalidated</html>",
            rscData: undefined,
            headers: undefined,
            postponed: undefined,
            status: 200,
          },
          { revalidate: 30 },
        );
      };

      // Trigger background regen as the generated entry does
      let regenSettled = false;
      const regenPromise = renderFn()
        .catch(() => {})
        .finally(() => {
          regenSettled = true;
        });
      ctx.waitUntil(regenPromise);

      // Regen should not have settled yet (put is blocked)
      await Promise.resolve();
      await Promise.resolve();
      expect(regenSettled).toBe(false);
      expect(store.has("cache:regen-key")).toBe(false);

      // Unblock the KV put
      resolveKvPut();
      await Promise.all(ctx.registered);

      expect(regenSettled).toBe(true);
      expect(store.has("cache:regen-key")).toBe(true);
      const entry = JSON.parse(store.get("cache:regen-key")!);
      expect(entry.value.html).toBe("<html>revalidated</html>");
    });
  });

  describe("revalidate: 0 skips storage", () => {
    it("skips KV write when ctx.revalidate is 0", async () => {
      await handler.set(
        "no-cache-ctx",
        {
          kind: "FETCH",
          data: { headers: {}, body: "test", url: "" },
          tags: [],
          revalidate: false,
        },
        { revalidate: 0 },
      );

      expect(store.has("cache:no-cache-ctx")).toBe(false);
      const result = await handler.get("no-cache-ctx");
      expect(result).toBeNull();
    });

    it("skips KV write when data.revalidate is 0", async () => {
      await handler.set(
        "no-cache-data",
        { kind: "FETCH", data: { headers: {}, body: "test", url: "" }, tags: [], revalidate: 0 },
        { tags: [] },
      );

      expect(store.has("cache:no-cache-data")).toBe(false);
      const result = await handler.get("no-cache-data");
      expect(result).toBeNull();
    });

    it("stores entry when ctx.revalidate is 0 but data.revalidate is positive", async () => {
      await handler.set(
        "override-positive",
        { kind: "FETCH", data: { headers: {}, body: "test", url: "" }, tags: [], revalidate: 60 },
        { revalidate: 0 },
      );

      expect(store.has("cache:override-positive")).toBe(true);
      const result = await handler.get("override-positive");
      expect(result).not.toBeNull();
    });
  });
});
