/**
 * Unit tests for Cloudflare KV cache handler.
 *
 * Tests validation and robustness:
 * - Schema validation of deserialized cache entries
 * - Safe base64 decoding (no crash on invalid input)
 * - Corrupted/poisoned entries treated as cache miss
 * - Valid entries round-trip correctly
 */

import { describe, it, expect, beforeEach, vi } from "vite-plus/test";
import { KVCacheHandler } from "../packages/cloudflare/src/cache/kv-data-adapter.runtime.js";
import {
  revalidatePath,
  revalidateTag,
  setCacheHandler,
  MemoryCacheHandler,
} from "../packages/vinext/src/shims/cache.js";
import { buildAppPageCacheTags } from "../packages/vinext/src/server/app-page-cache.js";

// ---------------------------------------------------------------------------
// Mock KV namespace
// ---------------------------------------------------------------------------

function createMockKV(store: Map<string, string> = new Map()) {
  // Metadata store mirrors what Cloudflare KV returns on list()
  const metadataStore = new Map<string, Record<string, unknown>>();

  return {
    // Mirrors Workers KV: an array of keys resolves to a Map, a single key to a string.
    get: vi.fn(async (key: string | string[]) => {
      if (Array.isArray(key)) {
        return new Map(key.map((k) => [k, store.get(k) ?? null]));
      }
      return store.get(key) ?? null;
    }),
    put: vi.fn(
      async (
        key: string,
        value: string,
        options?: { expirationTtl?: number; metadata?: Record<string, unknown> },
      ) => {
        store.set(key, value);
        if (options?.metadata) metadataStore.set(key, options.metadata);
      },
    ),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
      metadataStore.delete(key);
    }),
    list: vi.fn(async (options?: { prefix?: string; limit?: number; cursor?: string }) => {
      const prefix = options?.prefix ?? "";
      const limit = options?.limit ?? 1000;
      const cursor = options?.cursor;

      const allKeys = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();

      let startIdx = 0;
      if (cursor) {
        const idx = allKeys.indexOf(cursor);
        startIdx = idx >= 0 ? idx + 1 : 0;
      }

      const pageKeys = allKeys.slice(startIdx, startIdx + limit);
      const hasMore = startIdx + limit < allKeys.length;

      return {
        keys: pageKeys.map((name) => ({ name, metadata: metadataStore.get(name) })),
        list_complete: !hasMore,
        cursor: hasMore ? pageKeys[pageKeys.length - 1] : undefined,
      };
    }),
  };
}

/**
 * KV double that records every get() in start order, together with the reads
 * still in flight when it started. `hold(key)` blocks reads of that key until
 * the returned release() runs, so a test can prove two reads share one hop.
 */
function createTracingKV(store: Map<string, string> = new Map()) {
  const base = createMockKV(store);
  const calls: Array<{ keys: string[]; options?: unknown; inFlightAtStart: string[] }> = [];
  const pending = new Map<number, string[]>();
  const gates = new Map<string, Promise<void>>();
  const failing = new Set<string>();
  let nextId = 0;

  const get = vi.fn(async (key: string | string[], options?: unknown) => {
    const keys = Array.isArray(key) ? key : [key];
    const id = nextId++;
    calls.push({ keys, options, inFlightAtStart: [...pending.values()].flat() });
    pending.set(id, keys);
    // Snapshot at call time: a real read cannot see a write that lands later.
    const snapshot = new Map(keys.map((k) => [k, store.get(k) ?? null]));
    try {
      await gates.get(keys[0]);
      const failed = keys.find((k) => failing.has(k));
      if (failed) throw new Error(`KV read failed: ${failed}`);
      return Array.isArray(key) ? snapshot : (snapshot.get(key) ?? null);
    } finally {
      pending.delete(id);
    }
  });

  return {
    ...base,
    get,
    calls,
    /** Make any read that includes `key` reject. */
    fail(key: string) {
      failing.add(key);
    },
    /** Block reads of `key` until the returned function runs. */
    hold(key: string) {
      let release!: () => void;
      gates.set(
        key,
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      );
      return () => {
        gates.delete(key);
        release();
      };
    },
  };
}

/** Let every already-scheduled task run, without releasing a held read. */
function flushTasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
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

  describe("KV key length guard", () => {
    const pageValue = {
      kind: "PAGES" as const,
      html: "<html></html>",
      pageData: {},
      headers: undefined,
      status: 200,
    };

    it("keeps short fully-prefixed entry keys unchanged", async () => {
      const prefixedHandler = new KVCacheHandler(kv as any, { appPrefix: "docs" });

      await prefixedHandler.set("short", pageValue);

      expect(kv.put).toHaveBeenCalledWith(
        "docs:cache:short",
        expect.any(String),
        expect.any(Object),
      );
    });

    it("hashes a logical key when the complete prefixed entry key exceeds 512 bytes", async () => {
      const prefixedHandler = new KVCacheHandler(kv as any, { appPrefix: "docs" });
      // This mirrors buildUseCacheKey's former boundary bug: the readable
      // scoped key consumed 480 bytes before a 24-byte args hash was appended.
      const logicalKey = `use-cache:${"m".repeat(470)}:__hash:${"a".repeat(16)}`;

      await prefixedHandler.set(logicalKey, pageValue);

      const storedKey = kv.put.mock.calls.at(-1)![0] as string;
      expect(new TextEncoder().encode(storedKey).length).toBeLessThanOrEqual(512);
      expect(storedKey).toMatch(/^docs:cache:__hash:[0-9a-f]{16}$/);

      kv.get.mockClear();
      expect(await prefixedHandler.get(logicalKey)).not.toBeNull();
      expect(kv.get).toHaveBeenCalledWith(storedKey);
    });

    it("measures multibyte logical keys by UTF-8 byte length", async () => {
      const logicalKey = "🔥".repeat(130);

      await handler.set(logicalKey, pageValue);

      const storedKey = kv.put.mock.calls.at(-1)![0] as string;
      expect(new TextEncoder().encode(storedKey).length).toBeLessThanOrEqual(512);
      expect(storedKey).toMatch(/^cache:__hash:[0-9a-f]{16}$/);
      expect(await handler.get(logicalKey)).not.toBeNull();
    });

    it("normalizes an oversized app prefix while preserving entry listing", async () => {
      const prefixedHandler = new KVCacheHandler(kv as any, {
        appPrefix: "🚀".repeat(130),
      });

      await prefixedHandler.set("short", pageValue);

      const storedKey = kv.put.mock.calls.at(-1)![0] as string;
      expect(new TextEncoder().encode(storedKey).length).toBeLessThanOrEqual(512);
      expect(storedKey).toMatch(/^__app:[0-9a-f]{16}:cache:short$/);

      await prefixedHandler.revalidateByPathPrefix!("/");
      expect(kv.list).toHaveBeenCalledWith(
        expect.objectContaining({ prefix: storedKey.slice(0, -"short".length) }),
      );
    });

    it("uses the same bounded storage key for multibyte tag writes and reads", async () => {
      const tag = "é".repeat(256);
      await handler.revalidateTag(tag);

      const tagKey = kv.put.mock.calls.at(-1)![0] as string;
      expect(new TextEncoder().encode(tagKey).length).toBeLessThanOrEqual(512);
      expect(tagKey).toMatch(/^__tag:__hash:[0-9a-f]{16}$/);

      store.set(
        "cache:tagged-with-long-tag",
        validEntry(pageValue, { tags: [tag], lastModified: Date.now() + 1_000 }),
      );
      const freshHandler = new KVCacheHandler(kv as any);
      kv.get.mockClear();

      expect(await freshHandler.get("tagged-with-long-tag")).not.toBeNull();
      expect(kv.get).toHaveBeenCalledWith(tagKey);
    });
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

    it("rejects entry with invalid expireAt type", async () => {
      store.set(
        "cache:bad-expire",
        JSON.stringify({
          value: null,
          tags: [],
          lastModified: 123,
          revalidateAt: null,
          expireAt: "not-a-number",
        }),
      );
      const result = await handler.get("bad-expire");
      expect(result).toBeNull();
      expect(kv.delete).toHaveBeenCalledWith("cache:bad-expire");
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
    beforeEach(() => {
      vi.useRealTimers();
    });

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

    it("serves stale within expire and returns a hard miss beyond expire", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(1_000);

      await handler.set(
        "expire-test",
        {
          kind: "PAGES",
          html: "<html>cached</html>",
          pageData: {},
          headers: undefined,
          status: 200,
        },
        { cacheControl: { revalidate: 1, expire: 3 } },
      );

      vi.setSystemTime(2_500);
      const stale = await handler.get("expire-test");
      expect(stale?.cacheState).toBe("stale");
      expect(stale?.value?.kind).toBe("PAGES");

      vi.setSystemTime(4_500);
      await expect(handler.get("expire-test")).resolves.toBeNull();
      expect(kv.delete).toHaveBeenCalledWith("cache:expire-test");
    });

    it("round-trips the client stale claim through stored cacheControl", async () => {
      await handler.set(
        "stale-round-trip",
        {
          kind: "APP_PAGE",
          html: "<div>hi</div>",
          rscData: undefined,
          headers: undefined,
          postponed: undefined,
          status: 200,
        },
        { cacheControl: { revalidate: 60, expire: 300, stale: 30 } },
      );

      const hit = await handler.get("stale-round-trip");
      expect(hit?.cacheControl).toEqual({ revalidate: 60, expire: 300, stale: 30 });
    });

    it("serves stale when a shorter read-time revalidate has elapsed", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(1_000);

      await handler.set(
        "shorter-read-revalidate",
        {
          kind: "FETCH",
          data: { headers: {}, body: "cached", url: "https://example.com/data" },
          tags: [],
          revalidate: 60,
        },
        { revalidate: 60 },
      );

      vi.setSystemTime(3_500);
      const stale = await handler.get("shorter-read-revalidate", { revalidate: 2 });

      expect(stale?.cacheState).toBe("stale");
      const value = stale?.value;
      expect(value?.kind).toBe("FETCH");
      if (value?.kind !== "FETCH") throw new Error("expected FETCH cache value");
      expect(value.data.body).toBe("cached");
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

    it("softTags invalidate FETCH reads without deleting the shared entry", async () => {
      store.set(
        "cache:fetch-entry",
        JSON.stringify({
          value: {
            kind: "FETCH",
            data: { headers: {}, body: "cached", url: "https://example.test/data" },
            revalidate: 3600,
          },
          tags: [],
          lastModified: 1000,
          revalidateAt: null,
        }),
      );
      store.set("__tag:_N_T_/posts/hello", "2000");

      const withoutSoftTags = await handler.get("fetch-entry", { kind: "FETCH", tags: [] });
      const withSoftTags = await handler.get("fetch-entry", {
        kind: "FETCH",
        tags: [],
        softTags: ["_N_T_/posts/hello"],
      });

      expect(withoutSoftTags).not.toBeNull();
      expect(withSoftTags).toBeNull();
      expect(kv.delete).not.toHaveBeenCalledWith("cache:fetch-entry");
    });

    it("validates and dedupes softTags before reading KV tag markers", async () => {
      store.set(
        "cache:fetch-entry",
        JSON.stringify({
          value: {
            kind: "FETCH",
            data: { headers: {}, body: "cached", url: "https://example.test/data" },
            revalidate: 3600,
          },
          tags: [],
          lastModified: 1000,
          revalidateAt: null,
        }),
      );

      const result = await handler.get("fetch-entry", {
        kind: "FETCH",
        softTags: ["_N_T_/posts/hello", "_N_T_/posts/hello", "bad:tag", ""],
      });

      expect(result).not.toBeNull();
      expect(kv.get).toHaveBeenCalledWith("cache:fetch-entry");
      expect(kv.get).toHaveBeenCalledWith("__tag:_N_T_/posts/hello");
      expect(kv.get).not.toHaveBeenCalledWith("__tag:bad:tag");
      expect(kv.get).not.toHaveBeenCalledWith("__tag:");
      expect(kv.get).toHaveBeenCalledTimes(2);
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
    it("registers a speculative soft-tag read with waitUntil", async () => {
      const ctx = createMockCtx();
      const handlerWithCtx = new KVCacheHandler(kv as any, { ctx });

      await handlerWithCtx.get("absent", { softTags: ["soft"] });

      expect(ctx.waitUntil).toHaveBeenCalledOnce();
      await Promise.all(ctx.registered);
    });

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

      // kv.get calls: 1 for the entry + 1 bulk read covering both tags = 2
      expect(kv.get).toHaveBeenCalledTimes(2);
      expect(kv.get).toHaveBeenCalledWith(["__tag:t1", "__tag:t2"]);

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

      // First get() — populates local tag cache (1 entry + 1 bulk tag read = 2 calls)
      const result1 = await handler.get("reset-page");
      expect(result1).not.toBeNull();
      expect(kv.get).toHaveBeenCalledTimes(2);
      kv.get.mockClear();

      // Second get() without reset — tags served from local cache (1 entry only)
      const result2 = await handler.get("reset-page");
      expect(result2).not.toBeNull();
      expect(kv.get).toHaveBeenCalledTimes(1);
      kv.get.mockClear();

      // Clear the local cache
      handler.resetRequestCache();

      // Third get() after reset — tags re-fetched (1 entry + 1 bulk tag read = 2 calls)
      const result3 = await handler.get("reset-page");
      expect(result3).not.toBeNull();
      expect(kv.get).toHaveBeenCalledTimes(2);
      expect(kv.get).toHaveBeenCalledWith("cache:reset-page");
      expect(kv.get).toHaveBeenCalledWith(["__tag:t1", "__tag:t2"]);
    });
  });

  // -------------------------------------------------------------------------
  // KV read options
  // -------------------------------------------------------------------------
  describe("entry read options", () => {
    function seedTaggedEntry(store: Map<string, string>, key: string) {
      store.set(
        `cache:${key}`,
        JSON.stringify({
          value: { kind: "PAGES", html: "<p>hi</p>", pageData: {}, status: 200 },
          tags: ["t1", "t2"],
          lastModified: Date.now(),
          revalidateAt: null,
        }),
      );
    }

    it("passes no options at all when entryCacheTtlSeconds is unset", async () => {
      const store = new Map<string, string>();
      const kv = createMockKV(store);
      seedTaggedEntry(store, "no-ttl");

      const handler = new KVCacheHandler(kv as never);
      expect(await handler.get("no-ttl")).not.toBeNull();

      for (const call of kv.get.mock.calls) {
        expect(call).toHaveLength(1);
      }
    });

    it("passes cacheTtl on the entry read only, never on tag markers", async () => {
      const store = new Map<string, string>();
      const kv = createMockKV(store);
      seedTaggedEntry(store, "ttl");

      const handler = new KVCacheHandler(kv as never, { entryCacheTtlSeconds: 300 });
      expect(await handler.get("ttl", { softTags: ["soft1"] })).not.toBeNull();

      expect(kv.get).toHaveBeenCalledWith("cache:ttl", { cacheTtl: 300 });
      // A colo cache on a marker would hide a revalidateTag() for that long.
      expect(kv.get).toHaveBeenCalledWith("__tag:soft1");
      expect(kv.get).toHaveBeenCalledWith(["__tag:t1", "__tag:t2"]);
    });

    it("raises a cacheTtl below the runtime's 30s floor", async () => {
      const store = new Map<string, string>();
      const kv = createMockKV(store);
      seedTaggedEntry(store, "floor");

      const handler = new KVCacheHandler(kv as never, { entryCacheTtlSeconds: 5 });
      expect(await handler.get("floor")).not.toBeNull();

      expect(kv.get).toHaveBeenCalledWith("cache:floor", { cacheTtl: 30 });
    });
  });

  // -------------------------------------------------------------------------
  // Read round trips
  // -------------------------------------------------------------------------
  describe("read round trips", () => {
    function seedEntry(store: Map<string, string>, key: string, tags: string[]) {
      store.set(
        `cache:${key}`,
        JSON.stringify({
          value: { kind: "PAGES", html: "<p>hi</p>", pageData: {}, status: 200 },
          tags,
          lastModified: Date.now(),
          revalidateAt: null,
        }),
      );
    }

    it("reads soft-tag markers while the entry read is still in flight", async () => {
      const store = new Map<string, string>();
      const kv = createTracingKV(store);
      seedEntry(store, "overlap", ["own"]);
      const release = kv.hold("cache:overlap");

      const handler = new KVCacheHandler(kv as never);
      const pending = handler.get("overlap", { softTags: ["soft1", "soft2"] });
      await flushTasks();

      const softCall = kv.calls.find((call) => call.keys[0] === "__tag:soft1");
      expect(softCall?.keys).toEqual(["__tag:soft1", "__tag:soft2"]);
      expect(softCall?.inFlightAtStart).toContain("cache:overlap");

      release();
      expect(await pending).not.toBeNull();
      // Entry read plus soft markers on hop one, the entry's own tag on hop two.
      expect(kv.calls.map((call) => call.keys[0])).toEqual([
        "cache:overlap",
        "__tag:soft1",
        "__tag:own",
      ]);
    });

    it("reads a tag shared by the soft set and the entry only once", async () => {
      const store = new Map<string, string>();
      const kv = createTracingKV(store);
      seedEntry(store, "dedupe", ["shared", "own"]);

      const handler = new KVCacheHandler(kv as never);
      expect(await handler.get("dedupe", { softTags: ["shared", "soft-only"] })).not.toBeNull();

      const readKeys = kv.calls.flatMap((call) => call.keys);
      expect(readKeys.filter((key) => key === "__tag:shared")).toHaveLength(1);
      expect(readKeys).toEqual([
        "cache:dedupe",
        "__tag:shared",
        "__tag:soft-only",
        // "shared" came from the soft batch, so hop two reads "own" alone.
        "__tag:own",
      ]);
    });

    it("skips the second hop when the entry has no tags of its own", async () => {
      const store = new Map<string, string>();
      const kv = createTracingKV(store);
      seedEntry(store, "untagged", []);

      const handler = new KVCacheHandler(kv as never);
      expect(await handler.get("untagged", { softTags: ["soft1"] })).not.toBeNull();

      expect(kv.calls).toHaveLength(2);
      expect(kv.calls[1].inFlightAtStart).toContain("cache:untagged");
    });

    it("reads nothing beyond the entry when there are no tags at all", async () => {
      const store = new Map<string, string>();
      const kv = createTracingKV(store);
      seedEntry(store, "plain", []);

      const handler = new KVCacheHandler(kv as never);
      expect(await handler.get("plain")).not.toBeNull();

      expect(kv.calls.map((call) => call.keys)).toEqual([["cache:plain"]]);
    });

    it("deletes the entry on entry-tag invalidation but not on soft-tag invalidation", async () => {
      const store = new Map<string, string>();
      const kv = createTracingKV(store);
      seedEntry(store, "soft-hit", ["own"]);
      store.set("__tag:soft1", String(Date.now() + 1000));

      const handler = new KVCacheHandler(kv as never);
      expect(await handler.get("soft-hit", { softTags: ["soft1"] })).toBeNull();
      expect(kv.delete).not.toHaveBeenCalled();
      expect(store.has("cache:soft-hit")).toBe(true);

      seedEntry(store, "own-hit", ["own"]);
      store.set("__tag:own", String(Date.now() + 1000));
      handler.resetRequestCache();

      expect(await handler.get("own-hit", { softTags: ["soft1"] })).toBeNull();
      expect(kv.delete).toHaveBeenCalledWith("cache:own-hit");
    });

    it("does not delete a newer stored entry when the configured entry cache is stale", async () => {
      const store = new Map<string, string>();
      const kv = createMockKV(store);
      const value = { kind: "PAGES", html: "<p>hi</p>", pageData: {}, status: 200 };
      const stale = validEntry(value, { tags: ["own"], lastModified: 1000 });
      const replacement = validEntry(value, { tags: ["own"], lastModified: 3000 });
      store.set("cache:edge-cached", replacement);
      store.set("__tag:own", "2000");
      kv.get.mockImplementation(async (key: string | string[]) => {
        if (key === "cache:edge-cached") return stale;
        if (Array.isArray(key)) {
          return new Map(key.map((item) => [item, store.get(item) ?? null]));
        }
        return store.get(key) ?? null;
      });

      const handler = new KVCacheHandler(kv as never, { entryCacheTtlSeconds: 300 });
      expect(await handler.get("edge-cached")).toBeNull();

      expect(kv.delete).not.toHaveBeenCalled();
      expect(store.get("cache:edge-cached")).toBe(replacement);
    });

    it("a failing soft-tag read leaves an entry miss as an ordinary miss", async () => {
      const store = new Map<string, string>();
      const kv = createTracingKV(store);
      kv.fail("__tag:soft1");

      const handler = new KVCacheHandler(kv as never);
      expect(await handler.get("absent", { softTags: ["soft1"] })).toBeNull();
    });

    it("a failing soft-tag read still rejects a hit that must validate it", async () => {
      const store = new Map<string, string>();
      const kv = createTracingKV(store);
      seedEntry(store, "hit", ["own"]);
      kv.fail("__tag:soft1");

      const handler = new KVCacheHandler(kv as never);
      await expect(handler.get("hit", { softTags: ["soft1"] })).rejects.toThrow(
        "KV read failed: __tag:soft1",
      );
    });

    it("a cached invalidated entry tag skips the second hop for the remaining tags", async () => {
      const store = new Map<string, string>();
      const kv = createTracingKV(store);
      seedEntry(store, "known-bad", ["known", "unrelated"]);
      store.set("__tag:known", String(Date.now() + 1000));
      // Prime "known" alone, so the entry read below finds it already invalid.
      const handler = new KVCacheHandler(kv as never);
      seedEntry(store, "primer", ["known"]);
      expect(await handler.get("primer")).toBeNull();

      // An unrelated tag that would break the second hop if it were read.
      kv.fail("__tag:unrelated");
      kv.calls.length = 0;

      expect(await handler.get("known-bad")).toBeNull();
      expect(kv.calls.map((call) => call.keys)).toEqual([["cache:known-bad"]]);
      expect(kv.delete).toHaveBeenCalledWith("cache:known-bad");
    });

    it("a miss resolves without waiting for the soft-tag batch", async () => {
      const store = new Map<string, string>();
      const kv = createTracingKV(store);
      const release = kv.hold("__tag:soft1");
      const handler = new KVCacheHandler(kv as never);

      let settled = false;
      const pending = handler.get("absent", { softTags: ["soft1"] }).then((v) => {
        settled = true;
        return v;
      });
      await flushTasks();
      expect(settled).toBe(true);
      expect(await pending).toBeNull();
      release();
    });

    it("a cached invalid entry tag wins over a failing soft-tag read", async () => {
      const store = new Map<string, string>();
      const kv = createTracingKV(store);
      // Cache the "known" marker with a first read, then break the soft batch.
      seedEntry(store, "primer", ["known"]);
      store.set("__tag:known", String(Date.now() + 1000));
      const handler = new KVCacheHandler(kv as never);
      expect(await handler.get("primer")).toBeNull();

      seedEntry(store, "known-bad", ["known"]);
      kv.fail("__tag:soft1");

      expect(await handler.get("known-bad", { softTags: ["soft1"] })).toBeNull();
      expect(kv.delete).toHaveBeenCalledWith("cache:known-bad");
    });

    it("re-reads an expired NaN marker instead of trusting it forever", async () => {
      const store = new Map<string, string>();
      const kv = createTracingKV(store);
      store.set("__tag:bad", "not-a-number");
      seedEntry(store, "nan", ["bad"]);

      const handler = new KVCacheHandler(kv as never, { tagCacheTtlMs: 0 });
      expect(await handler.get("nan")).toBeNull();

      // The marker is gone and the cached NaN has expired, so the entry is valid.
      store.delete("__tag:bad");
      seedEntry(store, "nan", ["bad"]);
      kv.calls.length = 0;

      expect(await handler.get("nan")).not.toBeNull();
      expect(kv.calls.map((call) => call.keys)).toEqual([["cache:nan"], ["__tag:bad"]]);
    });

    it("re-reads an expired positive marker instead of trusting it forever", async () => {
      const store = new Map<string, string>();
      const kv = createTracingKV(store);
      store.set("__tag:gone", String(Date.now() + 1000));
      seedEntry(store, "expired", ["gone"]);

      const handler = new KVCacheHandler(kv as never, { tagCacheTtlMs: 0 });
      expect(await handler.get("expired")).toBeNull();

      store.delete("__tag:gone");
      seedEntry(store, "expired", ["gone"]);
      expect(await handler.get("expired")).not.toBeNull();
    });

    it("a detached prime does not overwrite a revalidateTag it raced", async () => {
      const store = new Map<string, string>();
      const kv = createTracingKV(store);
      const release = kv.hold("__tag:soft1");
      const handler = new KVCacheHandler(kv as never);

      // A miss detaches the soft-tag prime while its read is still held.
      expect(await handler.get("absent", { softTags: ["soft1"] })).toBeNull();
      await handler.revalidateTag("soft1");
      release();
      await flushTasks();

      // The stale read must not have erased the newer marker, so an entry
      // older than the invalidation still reads as invalid.
      store.set(
        "cache:after",
        JSON.stringify({
          value: { kind: "PAGES", html: "<p>hi</p>", pageData: {}, status: 200 },
          tags: [],
          lastModified: 1000,
          revalidateAt: null,
        }),
      );
      expect(await handler.get("after", { softTags: ["soft1"] })).toBeNull();
    });

    it("a newer same-millisecond prime wins over an older detached prime", async () => {
      const now = vi.spyOn(Date, "now").mockReturnValue(1000);
      const store = new Map<string, string>();
      const kv = createTracingKV(store);
      const releaseOld = kv.hold("__tag:soft1");
      const handler = new KVCacheHandler(kv as never);

      try {
        // The detached miss snapshots no marker and remains in flight.
        expect(await handler.get("absent", { softTags: ["soft1"] })).toBeNull();

        // A newer hit snapshots the marker in the same millisecond.
        store.set("__tag:soft1", "2000");
        seedEntry(store, "same-millisecond", []);
        const releaseNew = kv.hold("__tag:soft1");
        const pending = handler.get("same-millisecond", { softTags: ["soft1"] });

        // Let the older null result populate first, then the newer marker.
        releaseOld();
        await flushTasks();
        releaseNew();

        expect(await pending).toBeNull();
      } finally {
        releaseOld();
        now.mockRestore();
      }
    });

    it("a detached prime does not repopulate the tag cache after reset", async () => {
      const store = new Map<string, string>();
      const kv = createTracingKV(store);
      const release = kv.hold("__tag:soft1");
      const handler = new KVCacheHandler(kv as never);

      expect(await handler.get("absent", { softTags: ["soft1"] })).toBeNull();
      handler.resetRequestCache();
      store.set("__tag:soft1", "2000");
      release();
      await flushTasks();

      seedEntry(store, "after-reset", []);
      const raw = JSON.parse(store.get("cache:after-reset")!);
      raw.lastModified = 1000;
      store.set("cache:after-reset", JSON.stringify(raw));

      expect(await handler.get("after-reset", { softTags: ["soft1"] })).toBeNull();
    });

    it("re-primes soft tags when reset races an in-flight cache hit", async () => {
      const store = new Map<string, string>();
      const kv = createTracingKV(store);
      store.set("__tag:soft1", "2000");
      seedEntry(store, "reset-hit", []);
      const raw = JSON.parse(store.get("cache:reset-hit")!);
      raw.lastModified = 1000;
      store.set("cache:reset-hit", JSON.stringify(raw));

      const release = kv.hold("__tag:soft1");
      const handler = new KVCacheHandler(kv as never);
      const pending = handler.get("reset-hit", { softTags: ["soft1"] });
      await flushTasks();

      handler.resetRequestCache();
      release();

      expect(await pending).toBeNull();
      expect(kv.calls.filter((call) => call.keys[0] === "__tag:soft1")).toHaveLength(2);
    });

    it("re-primes soft tags when reset races the entry-tag hop", async () => {
      const store = new Map<string, string>();
      const kv = createTracingKV(store);
      store.set("__tag:soft1", "2000");
      seedEntry(store, "reset-entry-tags", ["own"]);
      const raw = JSON.parse(store.get("cache:reset-entry-tags")!);
      raw.lastModified = 1000;
      store.set("cache:reset-entry-tags", JSON.stringify(raw));

      const release = kv.hold("__tag:own");
      const handler = new KVCacheHandler(kv as never);
      const pending = handler.get("reset-entry-tags", { softTags: ["soft1"] });
      await flushTasks();

      handler.resetRequestCache();
      release();

      expect(await pending).toBeNull();
      expect(kv.calls.filter((call) => call.keys[0] === "__tag:soft1")).toHaveLength(2);
    });

    it("chunks tag marker reads at 100 keys per call", async () => {
      const store = new Map<string, string>();
      const kv = createTracingKV(store);
      const tags = Array.from({ length: 150 }, (_, i) => `t${i}`);
      seedEntry(store, "many-tags", tags);

      const handler = new KVCacheHandler(kv as never);
      expect(await handler.get("many-tags")).not.toBeNull();

      const markerCalls = kv.calls.filter((call) => call.keys[0].startsWith("__tag:"));
      expect(markerCalls.map((call) => call.keys.length)).toEqual([100, 50]);
      expect(markerCalls[1].inFlightAtStart).toContain("__tag:t0");
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
      void setPromise.then(() => {
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

  // -------------------------------------------------------------------------
  // revalidateByPathPrefix
  // -------------------------------------------------------------------------

  describe("revalidateByPathPrefix", () => {
    async function setPageEntry(h: KVCacheHandler, pathname: string, extraTags: string[] = []) {
      const tags = [pathname, `_N_T_${pathname}`, ...extraTags];
      await h.set(
        pathname,
        {
          kind: "APP_PAGE",
          html: `<html>${pathname}</html>`,
          rscData: undefined,
          headers: undefined,
          postponed: undefined,
          status: 200,
        },
        { revalidate: 60, tags },
      );
    }

    it("invalidates entries whose paths match the prefix (segment-aware)", async () => {
      await setPageEntry(handler, "/dashboard");
      await setPageEntry(handler, "/dashboard/settings");
      await setPageEntry(handler, "/about");

      handler.resetRequestCache();
      await handler.revalidateByPathPrefix!("/dashboard");
      handler.resetRequestCache();

      expect(await handler.get("/dashboard")).toBeNull();
      expect(await handler.get("/dashboard/settings")).toBeNull();
      expect(await handler.get("/about")).not.toBeNull();
    });

    it("does NOT match partial segment names", async () => {
      await setPageEntry(handler, "/dashboard");
      await setPageEntry(handler, "/dashboard-admin");

      handler.resetRequestCache();
      await handler.revalidateByPathPrefix!("/dashboard");
      handler.resetRequestCache();

      expect(await handler.get("/dashboard")).toBeNull();
      expect(await handler.get("/dashboard-admin")).not.toBeNull();
    });

    it("root prefix / invalidates all path-tagged entries", async () => {
      await setPageEntry(handler, "/");
      await setPageEntry(handler, "/dashboard");
      await setPageEntry(handler, "/about");

      handler.resetRequestCache();
      await handler.revalidateByPathPrefix!("/");
      handler.resetRequestCache();

      expect(await handler.get("/")).toBeNull();
      expect(await handler.get("/dashboard")).toBeNull();
      expect(await handler.get("/about")).toBeNull();
    });

    it("skips entries with only non-path custom tags", async () => {
      await handler.set(
        "custom-only",
        {
          kind: "FETCH",
          data: { headers: {}, body: "data", url: "/api" },
          tags: ["api-tag"],
          revalidate: 60,
        },
        { tags: ["api-tag"] },
      );

      handler.resetRequestCache();
      await handler.revalidateByPathPrefix!("/dashboard");
      handler.resetRequestCache();

      expect(await handler.get("custom-only")).not.toBeNull();
    });

    it("gracefully skips entries without metadata (written before metadata support)", async () => {
      // Manually write an entry without metadata (simulating old entries)
      store.set(
        "cache:/legacy",
        JSON.stringify({
          value: { kind: "APP_PAGE", html: "<html>/legacy</html>", status: 200 },
          tags: ["/legacy", "_N_T_/legacy"],
          lastModified: Date.now(),
          revalidateAt: null,
        }),
      );

      handler.resetRequestCache();
      await handler.revalidateByPathPrefix!("/legacy");
      handler.resetRequestCache();

      // Legacy entry is NOT invalidated — no metadata to read tags from
      expect(await handler.get("/legacy")).not.toBeNull();
    });

    it("omits metadata when tags exceed 1024-byte KV limit, entry still cached", async () => {
      // Generate tags that exceed 1024 bytes when JSON-serialized
      const longTags = Array.from({ length: 50 }, (_, i) => `/very/deep/nested/path/segment-${i}`);
      const allTags = longTags.flatMap((t) => [t, `_N_T_${t}`]);

      await handler.set(
        "/big-tags",
        {
          kind: "APP_PAGE",
          html: "<html>big</html>",
          rscData: undefined,
          headers: undefined,
          postponed: undefined,
          status: 200,
        },
        { revalidate: 60, tags: allTags },
      );

      // Entry IS cached (set didn't fail)
      handler.resetRequestCache();
      const result = await handler.get("/big-tags");
      expect(result).not.toBeNull();
      expect(result!.value!.kind).toBe("APP_PAGE");

      // But prefix invalidation skips it (no metadata to read)
      handler.resetRequestCache();
      await handler.revalidateByPathPrefix!("/very");
      handler.resetRequestCache();
      expect(await handler.get("/big-tags")).not.toBeNull();

      // Exact-path invalidation via revalidateTag still works
      await handler.revalidateTag(allTags.slice(0, 2));
      handler.resetRequestCache();
      expect(await handler.get("/big-tags")).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // revalidatePath() — end-to-end via the active handler
  //
  // Regression coverage for issue #1486: ensure a server-action style
  // `revalidatePath()` call invalidates the cached HTML/RSC entry stored in
  // KV under the full set of tags produced by buildAppPageCacheTags.
  // -------------------------------------------------------------------------
  describe("revalidatePath via active handler (#1486)", () => {
    beforeEach(() => {
      // Wire KVCacheHandler in as the active handler so the public
      // `revalidatePath` API exercised by user code routes through KV.
      setCacheHandler(handler);
    });

    /** Helper: seed an APP_PAGE entry using the same tag set the dispatcher uses. */
    async function seedAppPage(pathname: string, html: string): Promise<void> {
      const tags = buildAppPageCacheTags(pathname, []);
      await handler.set(
        pathname,
        {
          kind: "APP_PAGE",
          html,
          rscData: undefined,
          headers: undefined,
          postponed: undefined,
          status: 200,
        },
        { revalidate: 60, tags },
      );
    }

    it("invalidates the cached page after revalidatePath('/foo')", async () => {
      await seedAppPage("/foo", "<html>foo</html>");

      // Sanity: entry is present before invalidation.
      handler.resetRequestCache();
      const beforeHit = await handler.get("/foo");
      expect(beforeHit).not.toBeNull();
      expect((beforeHit!.value as any).html).toBe("<html>foo</html>");

      // Public revalidatePath API call (no type → bare _N_T_/foo tag).
      await Promise.resolve(revalidatePath("/foo"));

      // The cached entry must now be a hard miss.
      handler.resetRequestCache();
      expect(await handler.get("/foo")).toBeNull();
    });

    it("invalidates a deep nested page after revalidatePath('/blog/hello')", async () => {
      await seedAppPage("/blog/hello", "<html>hello</html>");
      await seedAppPage("/blog/world", "<html>world</html>");

      await Promise.resolve(revalidatePath("/blog/hello"));

      handler.resetRequestCache();
      expect(await handler.get("/blog/hello")).toBeNull();
      // Sibling entry must remain — bare path tag is exact.
      expect(await handler.get("/blog/world")).not.toBeNull();
    });

    it("invalidates the root page after revalidatePath('/')", async () => {
      await seedAppPage("/", "<html>home</html>");

      await Promise.resolve(revalidatePath("/"));

      handler.resetRequestCache();
      expect(await handler.get("/")).toBeNull();
    });

    it("type='layout' invalidates the page (carries the layout tag)", async () => {
      await seedAppPage("/dashboard/settings", "<html>settings</html>");

      // /dashboard/layout tag is included in the page's cache tags by
      // buildAppPageCacheTags. revalidatePath('/dashboard', 'layout') should
      // therefore invalidate this nested entry.
      await Promise.resolve(revalidatePath("/dashboard", "layout"));

      handler.resetRequestCache();
      expect(await handler.get("/dashboard/settings")).toBeNull();
    });

    it("type='page' invalidates only the exact route's /page tag", async () => {
      await seedAppPage("/about", "<html>about</html>");
      await seedAppPage("/about/team", "<html>team</html>");

      await Promise.resolve(revalidatePath("/about", "page"));

      handler.resetRequestCache();
      expect(await handler.get("/about")).toBeNull();
      // /about/team has tag _N_T_/about/team/page, not _N_T_/about/page.
      expect(await handler.get("/about/team")).not.toBeNull();
    });

    // -------------------------------------------------------------------------
    // Regression: prerender-seeded entries must carry path tags so
    // revalidatePath() can invalidate them. Pre-#1486 fix, `isrSetPrerenderedAppPage`
    // (and TPR uploads) wrote entries with `tags: []`, so revalidatePath would
    // mark `__tag:_N_T_/foo` but the cached entry had no matching tag — leaving
    // the stale entry served forever (until natural revalidateAt expiry).
    // -------------------------------------------------------------------------
    it("invalidates a prerender-seeded entry via revalidatePath when tags are passed", async () => {
      const { isrSetPrerenderedAppPage } =
        await import("../packages/vinext/src/server/isr-cache.js");

      // Simulate the build-time prerender seed for a page at /seeded.
      // The seeder must attach the path's implicit tags so that a later
      // revalidatePath('/seeded') call can invalidate this entry. See #1486.
      const tags = buildAppPageCacheTags("/seeded", []);

      await isrSetPrerenderedAppPage(
        "/seeded",
        {
          kind: "APP_PAGE",
          html: "<html>seeded</html>",
          rscData: undefined,
          headers: undefined,
          postponed: undefined,
          status: 200,
        },
        { revalidateSeconds: 60, tags },
      );

      handler.resetRequestCache();
      const beforeHit = await handler.get("/seeded");
      expect(beforeHit).not.toBeNull();

      await Promise.resolve(revalidatePath("/seeded"));

      handler.resetRequestCache();
      expect(await handler.get("/seeded")).toBeNull();
    });

    it("prerender-seeded entry without tags is NOT invalidated (legacy behavior — regression guard)", async () => {
      const { isrSetPrerenderedAppPage } =
        await import("../packages/vinext/src/server/isr-cache.js");

      // Pre-#1486 callers passed no tags. Document the legacy behavior so
      // future refactors notice the contract: the seeder controls whether
      // tag-based invalidation works.
      await isrSetPrerenderedAppPage(
        "/legacy-seeded",
        {
          kind: "APP_PAGE",
          html: "<html>legacy</html>",
          rscData: undefined,
          headers: undefined,
          postponed: undefined,
          status: 200,
        },
        { revalidateSeconds: 60 },
      );

      await Promise.resolve(revalidatePath("/legacy-seeded"));

      handler.resetRequestCache();
      // Entry remains because it has no tags to match against the
      // revalidatePath tag marker.
      expect(await handler.get("/legacy-seeded")).not.toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Reset to a clean MemoryCacheHandler between top-level test files.
  // -------------------------------------------------------------------------
});

// Ensure the active handler is restored after this file runs, so other test
// files relying on the default MemoryCacheHandler are not affected.
setCacheHandler(new MemoryCacheHandler());
void revalidateTag;
