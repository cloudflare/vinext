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
});
