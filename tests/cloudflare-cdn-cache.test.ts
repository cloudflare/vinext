/**
 * CloudflareCdnCacheAdapter + auto-detection tests.
 *
 * Covers the edge-managed adapter backed by the Workers Cache (ctx.cache):
 *  - get null / set no-op / ownsBackgroundRevalidation false
 *  - buildResponseHeaders emits a cacheable Cache-Control + Cache-Tag
 *  - revalidateTag purges via ctx.cache.purge({ tags })
 *  - getCdnCacheAdapter() auto-switches to the Cloudflare adapter when the
 *    VINEXT_CDN_CACHE_AUTO_DETECT flag is set and ctx.cache exists.
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
const AUTO_DETECT_ENV = "VINEXT_CDN_CACHE_AUTO_DETECT";

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

  it("get returns null so the origin always renders fresh", async () => {
    expect(await adapter.get()).toBeNull();
  });

  it("set is a no-op (platform caches the response, not an origin store)", async () => {
    await expect(adapter.set("k", null)).resolves.toBeUndefined();
  });

  it("carries SWR on CDN-Cache-Control (public + max-age) and revalidates the browser", () => {
    // A value-less `stale-while-revalidate` is normalized to an explicit window
    // (Cloudflare ignores the bare directive — RFC 5861 requires a value).
    expect(
      adapter.buildResponseHeaders({ cacheControl: "s-maxage=60, stale-while-revalidate" }),
    ).toEqual({
      "Cache-Control": "public, max-age=0, must-revalidate",
      "CDN-Cache-Control": "public, max-age=60, stale-while-revalidate=31536000",
    });
  });

  it("uses max-age (not s-maxage) and public on the edge directive, even pending-dynamic", () => {
    const headers = adapter.buildResponseHeaders({
      cacheControl: "s-maxage=60, stale-while-revalidate=540",
      pendingDynamicCheck: true,
    });
    // Edge caches + SWRs via CDN-Cache-Control; the browser always revalidates.
    // An already-valued stale-while-revalidate is passed through unchanged.
    expect(headers["CDN-Cache-Control"]).toBe("public, max-age=60, stale-while-revalidate=540");
    expect(headers["Cache-Control"]).toBe("public, max-age=0, must-revalidate");
  });

  it("adds a Cache-Tag header from the page tags", () => {
    const headers = adapter.buildResponseHeaders({
      cacheControl: "s-maxage=60",
      tags: ["/blog", "_N_T_/blog", "posts"],
    });
    expect(headers["Cache-Tag"]).toBe("/blog,_N_T_/blog,posts");
    expect(headers["Cache-Control"]).toBe("public, max-age=0, must-revalidate");
    expect(headers["CDN-Cache-Control"]).toBe("public, max-age=60");
  });

  it("skips tags containing the comma separator or that are too long", () => {
    const headers = adapter.buildResponseHeaders({
      cacheControl: "s-maxage=60",
      tags: ["a,b", "x".repeat(2000), "ok"],
    });
    expect(headers["Cache-Tag"]).toBe("ok");
  });

  it("returns only no-store (no CDN-Cache-Control) when there is no cacheable policy", () => {
    expect(adapter.buildResponseHeaders({ cacheControl: "" })).toEqual({
      "Cache-Control": "no-store",
    });
  });

  it("passes a non-cacheable policy through without promoting it to the edge", () => {
    // revalidate=0 / gssp paths produce no-store / private — must never become
    // a CDN-Cache-Control directive (which would cache an uncacheable response).
    for (const cc of [
      "no-store, must-revalidate",
      "private, no-cache, no-store, max-age=0, must-revalidate",
    ]) {
      const headers = adapter.buildResponseHeaders({ cacheControl: cc, tags: ["x"] });
      expect(headers).toEqual({ "Cache-Control": cc });
      expect(headers["CDN-Cache-Control"]).toBeUndefined();
      expect(headers["Cache-Tag"]).toBeUndefined();
    }
  });

  it("revalidateTag purges the Workers Cache by tag via ctx.cache.purge", async () => {
    const purge = vi.fn(async () => {});
    await runWithExecutionContext({ waitUntil() {}, cache: { purge } }, async () => {
      await adapter.revalidateTag(["posts", "_N_T_/blog"]);
    });
    expect(purge).toHaveBeenCalledWith({ tags: ["posts", "_N_T_/blog"] });
  });

  it("revalidateTag normalizes a single tag to an array", async () => {
    const purge = vi.fn(async () => {});
    await runWithExecutionContext({ waitUntil() {}, cache: { purge } }, async () => {
      await adapter.revalidateTag("posts");
    });
    expect(purge).toHaveBeenCalledWith({ tags: ["posts"] });
  });

  it("revalidateTag is a no-op when the Workers Cache is absent (e.g. Node dev)", async () => {
    // No runWithExecutionContext scope → getRequestExecutionContext() is null.
    await expect(adapter.revalidateTag("posts")).resolves.toBeUndefined();
  });

  it("revalidateTag does not purge for an empty tag set", async () => {
    const purge = vi.fn(async () => {});
    await runWithExecutionContext({ waitUntil() {}, cache: { purge } }, async () => {
      await adapter.revalidateTag([]);
    });
    expect(purge).not.toHaveBeenCalled();
  });
});

// ─── Auto-detection (flag-gated) ───────────────────────────────────────────

describe("auto-switch to the Cloudflare adapter when ctx.cache exists", () => {
  afterEach(() => {
    delete process.env[AUTO_DETECT_ENV];
  });

  it("selects the Cloudflare adapter when the flag is on and ctx.cache exists", async () => {
    process.env[AUTO_DETECT_ENV] = "1";
    resetActiveAdapter();

    const adapter = await runWithExecutionContext(
      { waitUntil() {}, cache: { async purge() {} } },
      async () => getCdnCacheAdapter(),
    );
    expect(adapter).toBeInstanceOf(CloudflareCdnCacheAdapter);
  });

  it("does NOT auto-detect when the flag is off, even with ctx.cache present", async () => {
    delete process.env[AUTO_DETECT_ENV];
    resetActiveAdapter();

    const adapter = await runWithExecutionContext(
      { waitUntil() {}, cache: { async purge() {} } },
      async () => getCdnCacheAdapter(),
    );
    expect(adapter).toBeInstanceOf(DefaultCdnCacheAdapter);
  });

  it("falls back to the default adapter when ctx.cache is absent (flag on)", async () => {
    process.env[AUTO_DETECT_ENV] = "1";
    resetActiveAdapter();
    // No request context / no ctx.cache → no auto-detection.
    expect(getCdnCacheAdapter()).toBeInstanceOf(DefaultCdnCacheAdapter);
  });

  it("an explicitly set adapter wins over auto-detection", async () => {
    process.env[AUTO_DETECT_ENV] = "1";
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
