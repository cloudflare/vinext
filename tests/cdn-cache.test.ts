/**
 * CDN cache adapter unit + integration tests.
 *
 * Covers the page-level ISR serving-strategy split:
 *  - DefaultCdnCacheAdapter delegates storage to the data cache and reproduces
 *    the framework's existing header behavior (byte-for-byte).
 *  - A custom edge adapter can return null from get (origin renders fresh),
 *    no-op set, emit split Cache-Control + CDN-Cache-Control headers, skip
 *    in-process background regeneration, and purge via revalidateTag().
 *  - isrGet/isrSet route through the active CDN adapter.
 *  - revalidateTag/revalidatePath/updateTag invalidate the data cache AND ask
 *    the CDN adapter to purge.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vite-plus/test";
import {
  DefaultCdnCacheAdapter,
  getCdnCacheAdapter,
  setCdnCacheAdapter,
  type CdnCacheAdapter,
  type CdnCacheableHeaderInput,
  type CdnResponseHeaders,
} from "../packages/vinext/src/shims/cdn-cache.js";
import {
  MemoryCacheHandler,
  setDataCacheHandler,
  setCacheHandler,
  getDataCacheHandler,
  getCacheHandler,
  revalidateTag,
  revalidatePath,
  updateTag,
  type CacheHandler,
} from "../packages/vinext/src/shims/cache.js";
import {
  isrGet,
  isrSet,
  triggerBackgroundRegeneration,
  buildPagesCacheValue,
} from "../packages/vinext/src/server/isr-cache.js";
import { setHeadersAccessPhase } from "../packages/vinext/src/shims/headers.js";

function resetAdapters(): void {
  setDataCacheHandler(new MemoryCacheHandler());
  setCdnCacheAdapter(new DefaultCdnCacheAdapter());
}

beforeEach(resetAdapters);
afterEach(resetAdapters);

// ─── Backwards-compatible data cache aliases ─────────────────────────────

describe("data cache handler aliases", () => {
  it("setCacheHandler is an alias for setDataCacheHandler", () => {
    const handler = new MemoryCacheHandler();
    setCacheHandler(handler);
    expect(getDataCacheHandler()).toBe(handler);
    expect(getCacheHandler()).toBe(handler);
  });

  it("setDataCacheHandler is visible through the legacy getter", () => {
    const handler = new MemoryCacheHandler();
    setDataCacheHandler(handler);
    expect(getCacheHandler()).toBe(handler);
  });
});

// ─── DefaultCdnCacheAdapter ──────────────────────────────────────────────

describe("DefaultCdnCacheAdapter", () => {
  it("owns background revalidation (origin-managed ISR)", () => {
    expect(new DefaultCdnCacheAdapter().ownsBackgroundRevalidation).toBe(true);
  });

  it("delegates get/set to the active data cache handler", async () => {
    const get = vi.fn(async () => null);
    const set = vi.fn(async () => {});
    const handler: CacheHandler = { get, set, async revalidateTag() {} };
    setDataCacheHandler(handler);

    const adapter = new DefaultCdnCacheAdapter();
    await adapter.set("k", buildPagesCacheValue("<p>x</p>", {}), { tags: ["t"] });
    await adapter.get("k", { kind: "PAGES" });

    expect(set).toHaveBeenCalledWith("k", expect.objectContaining({ kind: "PAGES" }), {
      tags: ["t"],
    });
    expect(get).toHaveBeenCalledWith("k", { kind: "PAGES" });
  });

  it("emits a single Cache-Control header for a cacheable policy", () => {
    const headers = new DefaultCdnCacheAdapter().buildResponseHeaders({
      cacheControl: "s-maxage=60, stale-while-revalidate",
    });
    expect(headers).toEqual({ "Cache-Control": "s-maxage=60, stale-while-revalidate" });
  });

  it("forces no-store while a streamed render's dynamic-ness is unproven", () => {
    const headers = new DefaultCdnCacheAdapter().buildResponseHeaders({
      cacheControl: "s-maxage=60, stale-while-revalidate",
      pendingDynamicCheck: true,
    });
    // Matches the legacy NO_STORE_CACHE_CONTROL the finalize path used to stamp.
    expect(headers).toEqual({ "Cache-Control": "no-store, must-revalidate" });
  });

  it("revalidateTag() is a no-op (data cache owns store invalidation)", async () => {
    await expect(new DefaultCdnCacheAdapter().revalidateTag("tag")).resolves.toBeUndefined();
  });
});

// ─── Active adapter resolution ───────────────────────────────────────────

describe("getCdnCacheAdapter / setCdnCacheAdapter", () => {
  it("defaults to a DefaultCdnCacheAdapter", () => {
    expect(getCdnCacheAdapter()).toBeInstanceOf(DefaultCdnCacheAdapter);
  });

  it("returns the adapter set via setCdnCacheAdapter", () => {
    const custom = new DefaultCdnCacheAdapter();
    setCdnCacheAdapter(custom);
    expect(getCdnCacheAdapter()).toBe(custom);
  });
});

// ─── Edge-managed (Cloudflare-style) adapter ─────────────────────────────

/** Minimal edge adapter: never serves from origin, emits split headers, purges. */
class EdgeCdnAdapter implements CdnCacheAdapter {
  readonly ownsBackgroundRevalidation = false;
  readonly purges: string[] = [];
  writes = 0;

  async get(): Promise<null> {
    return null; // origin renders fresh; the edge serves the cache
  }
  async set(): Promise<void> {
    this.writes++; // intentionally does not persist anything
  }
  buildResponseHeaders(input: CdnCacheableHeaderInput): CdnResponseHeaders {
    if (!input.cacheControl) return { "Cache-Control": "no-store" };
    return { "Cache-Control": "no-store", "CDN-Cache-Control": input.cacheControl };
  }
  async revalidateTag(tags: string | string[]): Promise<void> {
    for (const tag of Array.isArray(tags) ? tags : [tags]) this.purges.push(tag);
  }
}

describe("edge CDN adapter integration", () => {
  it("isrGet returns null (origin renders) even after isrSet", async () => {
    setCdnCacheAdapter(new EdgeCdnAdapter());
    await isrSet("app:/p:html", buildPagesCacheValue("<p>cached</p>", {}), 60, []);
    expect(await isrGet("app:/p:html")).toBeNull();
  });

  it("isrSet does not write to the data cache when the edge adapter no-ops storage", async () => {
    const set = vi.fn(async () => {});
    setDataCacheHandler({
      async get() {
        return null;
      },
      set,
      async revalidateTag() {},
    });
    const edge = new EdgeCdnAdapter();
    setCdnCacheAdapter(edge);

    await isrSet("app:/p:html", buildPagesCacheValue("<p>x</p>", {}), 60, []);

    expect(edge.writes).toBe(1);
    expect(set).not.toHaveBeenCalled();
  });

  it("skips in-process background regeneration when the adapter does not own it", async () => {
    setCdnCacheAdapter(new EdgeCdnAdapter());
    const renderFn = vi.fn(async () => {});
    triggerBackgroundRegeneration("regen-edge", renderFn);
    await new Promise((r) => setTimeout(r, 10));
    expect(renderFn).not.toHaveBeenCalled();
  });

  it("still runs background regeneration under the default adapter", async () => {
    const renderFn = vi.fn(async () => {});
    triggerBackgroundRegeneration("regen-default-cdn", renderFn);
    await new Promise((r) => setTimeout(r, 10));
    expect(renderFn).toHaveBeenCalledOnce();
  });
});

// ─── Invalidation propagation ────────────────────────────────────────────

describe("revalidation propagates to both data cache and CDN adapter", () => {
  function spyAdapters() {
    const dataRevalidate = vi.fn(
      async (_tags: string | string[], _durations?: { expire?: number }) => {},
    );
    setDataCacheHandler({
      async get() {
        return null;
      },
      async set() {},
      revalidateTag: dataRevalidate,
    });
    const edge = new EdgeCdnAdapter();
    setCdnCacheAdapter(edge);
    return { dataRevalidate, edge };
  }

  it("revalidateTag invalidates the data cache and purges the CDN", async () => {
    const { dataRevalidate, edge } = spyAdapters();
    await revalidateTag("posts");
    expect(dataRevalidate).toHaveBeenCalledWith("posts", undefined);
    expect(edge.purges).toEqual(["posts"]);
  });

  it("revalidatePath invalidates the data cache and purges the CDN", async () => {
    const { dataRevalidate, edge } = spyAdapters();
    await revalidatePath("/blog");
    // Same encoded tag is sent to both layers.
    expect(dataRevalidate).toHaveBeenCalledTimes(1);
    const tag = dataRevalidate.mock.calls[0][0];
    expect(edge.purges).toEqual([tag]);
  });

  it("updateTag invalidates the data cache and purges the CDN", async () => {
    const { dataRevalidate, edge } = spyAdapters();
    // updateTag may only be called from within a Server Action.
    const previousPhase = setHeadersAccessPhase("action");
    try {
      await updateTag("cart");
    } finally {
      setHeadersAccessPhase(previousPhase);
    }
    expect(dataRevalidate).toHaveBeenCalledTimes(1);
    expect(dataRevalidate.mock.calls[0][0]).toBe("cart");
    expect(edge.purges).toEqual(["cart"]);
  });
});
