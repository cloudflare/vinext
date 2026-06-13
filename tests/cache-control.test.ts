import { describe, expect, it, afterEach } from "vite-plus/test";
import {
  applyCdnResponseHeaders,
  buildCachedRevalidateCacheControl,
  buildRevalidateCacheControl,
} from "../packages/vinext/src/server/cache-control.js";
import {
  setCdnCacheAdapter,
  DefaultCdnCacheAdapter,
  type CdnCacheAdapter,
  type CdnCacheableHeaderInput,
} from "../packages/vinext/src/shims/cdn-cache.js";

describe("cache-control helpers", () => {
  it("uses Next.js expire minus revalidate for finite SWR windows", () => {
    expect(buildRevalidateCacheControl(60, 300)).toBe("s-maxage=60, stale-while-revalidate=240");
  });

  it("omits stale-while-revalidate when expire does not exceed revalidate", () => {
    expect(buildRevalidateCacheControl(300, 300)).toBe("s-maxage=300");
  });

  it("preserves vinext's legacy unbounded SWR header when expire is unknown", () => {
    expect(buildRevalidateCacheControl(60)).toBe("s-maxage=60, stale-while-revalidate");
  });

  it("uses route policy for STALE cached responses when expire is known", () => {
    expect(buildCachedRevalidateCacheControl("STALE", 60, 300)).toBe(
      "s-maxage=60, stale-while-revalidate=240",
    );
  });

  it("uses route policy for HIT cached responses when expire is known", () => {
    expect(buildCachedRevalidateCacheControl("HIT", 60, 300)).toBe(
      "s-maxage=60, stale-while-revalidate=240",
    );
  });

  it("uses static cache-control for cached indefinite responses", () => {
    expect(buildCachedRevalidateCacheControl("HIT", Infinity)).toBe(
      "s-maxage=31536000, stale-while-revalidate",
    );
  });

  it("preserves legacy STALE cached response headers when expire is unknown", () => {
    expect(buildCachedRevalidateCacheControl("STALE", 60)).toBe(
      "s-maxage=0, stale-while-revalidate",
    );
  });

  it("keeps the full expire window when revalidate is zero", () => {
    expect(buildRevalidateCacheControl(0, 300)).toBe("s-maxage=0, stale-while-revalidate=300");
  });
});

describe("applyCdnResponseHeaders", () => {
  const CDN_KEY = Symbol.for("vinext.cdnCacheAdapter");
  afterEach(() => {
    delete (globalThis as Record<PropertyKey, unknown>)[CDN_KEY];
  });

  it("default adapter sets a single Cache-Control identical to the input", () => {
    const headers = new Headers();
    applyCdnResponseHeaders(headers, { cacheControl: "s-maxage=60, stale-while-revalidate" });
    expect(headers.get("Cache-Control")).toBe("s-maxage=60, stale-while-revalidate");
    expect(headers.get("CDN-Cache-Control")).toBeNull();
  });

  it("routes through the active adapter (edge: CDN-Cache-Control + Cache-Tag) and clears stale headers", () => {
    // Minimal edge adapter that splits headers and emits a tag header.
    const edge: CdnCacheAdapter = {
      ownsBackgroundRevalidation: false,
      async get() {
        return null;
      },
      async set() {},
      buildResponseHeaders(input: CdnCacheableHeaderInput) {
        return {
          "Cache-Control": "no-store",
          "CDN-Cache-Control": input.cacheControl,
          ...(input.tags?.length ? { "Cache-Tag": input.tags.join(",") } : {}),
        };
      },
      async revalidateTag() {},
    };
    setCdnCacheAdapter(edge);

    const headers = new Headers({ "Cache-Control": "stale", "CDN-Cache-Control": "stale" });
    applyCdnResponseHeaders(headers, { cacheControl: "s-maxage=60", tags: ["a", "b"] });

    expect(headers.get("Cache-Control")).toBe("no-store");
    expect(headers.get("CDN-Cache-Control")).toBe("s-maxage=60");
    expect(headers.get("Cache-Tag")).toBe("a,b");
  });

  it("default adapter restores baseline after the edge adapter is cleared", () => {
    setCdnCacheAdapter(new DefaultCdnCacheAdapter());
    const headers = new Headers();
    applyCdnResponseHeaders(headers, { cacheControl: "s-maxage=10" });
    expect(headers.get("Cache-Control")).toBe("s-maxage=10");
  });
});
