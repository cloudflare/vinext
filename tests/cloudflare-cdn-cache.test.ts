/**
 * CloudflareCdnCacheAdapter + auto-detection tests.
 *
 * Covers the edge-managed adapter backed by the Workers Cache (ctx.cache):
 *  - readPage null / writePage no-op / ownsBackgroundRevalidation false
 *  - buildResponseHeaders emits a cacheable Cache-Control + Cache-Tag
 *  - revalidate purges via ctx.cache.purge({ tags })
 *  - importing vinext/cloudflare auto-switches getCdnCacheAdapter() to the
 *    Cloudflare adapter when ctx.cache exists in the request context.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vite-plus/test";
import { CloudflareCdnCacheAdapter } from "../packages/vinext/src/cloudflare/cloudflare-cdn-cache.js";
import {
  getCdnCacheAdapter,
  setCdnCacheAdapter,
  DefaultCdnCacheAdapter,
} from "../packages/vinext/src/shims/cdn-cache.js";
import { runWithExecutionContext } from "../packages/vinext/src/shims/request-context.js";

const CDN_KEY = Symbol.for("vinext.cdnCacheAdapter");

function resetActiveAdapter(): void {
  delete (globalThis as Record<PropertyKey, unknown>)[CDN_KEY];
}

beforeEach(resetActiveAdapter);
afterEach(resetActiveAdapter);

// ─── Adapter behavior ────────────────────────────────────────────────────

describe("CloudflareCdnCacheAdapter", () => {
  const adapter = new CloudflareCdnCacheAdapter();

  it("does not own background revalidation (the edge re-requests origin)", () => {
    expect(adapter.ownsBackgroundRevalidation).toBe(false);
  });

  it("readPage returns null so the origin always renders fresh", async () => {
    expect(await adapter.readPage()).toBeNull();
  });

  it("writePage is a no-op (platform caches the response, not an origin store)", async () => {
    await expect(adapter.writePage("k", null)).resolves.toBeUndefined();
  });

  it("carries SWR on CDN-Cache-Control and forbids browser storage with no-store", () => {
    expect(adapter.buildResponseHeaders({ cacheControl: "s-maxage=60, stale-while-revalidate" })).toEqual(
      {
        "Cache-Control": "no-store",
        "CDN-Cache-Control": "s-maxage=60, stale-while-revalidate",
      },
    );
  });

  it("uses CDN-Cache-Control (not Cache-Control) even on the pending-dynamic streamed response", () => {
    const headers = adapter.buildResponseHeaders({
      cacheControl: "s-maxage=60, stale-while-revalidate",
      pendingDynamicCheck: true,
    });
    // Edge caches via CDN-Cache-Control; the browser is told not to store.
    expect(headers["CDN-Cache-Control"]).toBe("s-maxage=60, stale-while-revalidate");
    expect(headers["Cache-Control"]).toBe("no-store");
  });

  it("adds a Cache-Tag header from the page tags", () => {
    const headers = adapter.buildResponseHeaders({
      cacheControl: "s-maxage=60",
      tags: ["/blog", "_N_T_/blog", "posts"],
    });
    expect(headers["Cache-Tag"]).toBe("/blog,_N_T_/blog,posts");
    expect(headers["Cache-Control"]).toBe("no-store");
    expect(headers["CDN-Cache-Control"]).toBe("s-maxage=60");
  });

  it("skips tags containing the comma separator or that are too long", () => {
    const headers = adapter.buildResponseHeaders({
      cacheControl: "s-maxage=60",
      tags: ["a,b", "x".repeat(2000), "ok"],
    });
    expect(headers["Cache-Tag"]).toBe("ok");
  });

  it("returns only no-store (no CDN-Cache-Control) when there is no cacheable policy", () => {
    expect(adapter.buildResponseHeaders({ cacheControl: "" })).toEqual({ "Cache-Control": "no-store" });
  });

  it("revalidate purges the Workers Cache by tag via ctx.cache.purge", async () => {
    const purge = vi.fn(async () => {});
    await runWithExecutionContext({ waitUntil() {}, cache: { purge } }, async () => {
      await adapter.revalidate(["posts", "_N_T_/blog"]);
    });
    expect(purge).toHaveBeenCalledWith({ tags: ["posts", "_N_T_/blog"] });
  });

  it("revalidate normalizes a single tag to an array", async () => {
    const purge = vi.fn(async () => {});
    await runWithExecutionContext({ waitUntil() {}, cache: { purge } }, async () => {
      await adapter.revalidate("posts");
    });
    expect(purge).toHaveBeenCalledWith({ tags: ["posts"] });
  });

  it("revalidate is a no-op when the Workers Cache is absent (e.g. Node dev)", async () => {
    // No runWithExecutionContext scope → getRequestExecutionContext() is null.
    await expect(adapter.revalidate("posts")).resolves.toBeUndefined();
  });

  it("revalidate does not purge for an empty tag set", async () => {
    const purge = vi.fn(async () => {});
    await runWithExecutionContext({ waitUntil() {}, cache: { purge } }, async () => {
      await adapter.revalidate([]);
    });
    expect(purge).not.toHaveBeenCalled();
  });
});

// ─── Auto-detection ──────────────────────────────────────────────────────

describe("auto-switch to the Cloudflare adapter when ctx.cache exists", () => {
  it("importing vinext/cloudflare registers a detector that activates on ctx.cache", async () => {
    // Importing the barrel registers the Workers-Cache detector (side effect).
    await import("../packages/vinext/src/cloudflare/index.js");
    resetActiveAdapter();

    const adapter = await runWithExecutionContext(
      { waitUntil() {}, cache: { async purge() {} } },
      async () => getCdnCacheAdapter(),
    );
    expect(adapter).toBeInstanceOf(CloudflareCdnCacheAdapter);
  });

  it("falls back to the default adapter when ctx.cache is absent", async () => {
    await import("../packages/vinext/src/cloudflare/index.js");
    resetActiveAdapter();
    // No request context / no ctx.cache → detector returns null.
    expect(getCdnCacheAdapter()).toBeInstanceOf(DefaultCdnCacheAdapter);
  });

  it("an explicitly set adapter wins over the detector", async () => {
    await import("../packages/vinext/src/cloudflare/index.js");
    resetActiveAdapter();
    const explicit = new DefaultCdnCacheAdapter();
    setCdnCacheAdapter(explicit);

    const adapter = await runWithExecutionContext(
      { waitUntil() {}, cache: { async purge() {} } },
      async () => getCdnCacheAdapter(),
    );
    expect(adapter).toBe(explicit);
  });
});
