import { describe, expect, it, afterEach } from "vite-plus/test";
import {
  applyCdnResponseHeaders,
  BROWSER_REVALIDATE_CACHE_CONTROL,
  buildCachedRevalidateCacheControl,
  buildRevalidateCacheControl,
  hasExplicitNonCacheableResponsePolicy,
  shouldUseNextDeployCacheControl,
  validateCdnRequest,
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
  const originalNextDeployCacheControl = process.env.VINEXT_NEXT_DEPLOY_CACHE_CONTROL;
  afterEach(() => {
    delete (globalThis as Record<PropertyKey, unknown>)[CDN_KEY];
    if (originalNextDeployCacheControl === undefined) {
      delete process.env.VINEXT_NEXT_DEPLOY_CACHE_CONTROL;
    } else {
      process.env.VINEXT_NEXT_DEPLOY_CACHE_CONTROL = originalNextDeployCacheControl;
    }
  });

  it("default adapter sets a single Cache-Control identical to the input", () => {
    const headers = new Headers();
    applyCdnResponseHeaders(headers, { cacheControl: "s-maxage=60, stale-while-revalidate" });
    expect(headers.get("Cache-Control")).toBe("s-maxage=60, stale-while-revalidate");
  });

  it("uses browser revalidation Cache-Control and adapter-owned cleanup in Next deploy mode", () => {
    process.env.VINEXT_NEXT_DEPLOY_CACHE_CONTROL = "1";
    const edge: CdnCacheAdapter = {
      ownsBackgroundRevalidation: false,
      async get() {
        return null;
      },
      async set() {},
      buildResponseHeaders(input) {
        return {
          "Cache-Control": input.cacheControl,
          "X-Example-Edge-Policy": null,
        };
      },
      async revalidateTag() {},
    };
    setCdnCacheAdapter(edge);
    const headers = new Headers({ "X-Example-Edge-Policy": "stale" });

    applyCdnResponseHeaders(headers, { cacheControl: "s-maxage=60, stale-while-revalidate" });

    expect(shouldUseNextDeployCacheControl()).toBe(true);
    expect(headers.get("Cache-Control")).toBe(BROWSER_REVALIDATE_CACHE_CONTROL);
    expect(headers.get("X-Example-Edge-Policy")).toBeNull();
  });

  it("routes response policy and tags through the active adapter", () => {
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
          "X-Example-Edge-Policy": input.cacheControl,
          ...(input.tags?.length ? { "X-Example-Cache-Tag": input.tags.join(",") } : {}),
        };
      },
      async revalidateTag() {},
    };
    setCdnCacheAdapter(edge);

    const headers = new Headers({
      "Cache-Control": "stale",
      "X-Example-Edge-Policy": "stale",
    });
    applyCdnResponseHeaders(headers, { cacheControl: "s-maxage=60", tags: ["a", "b"] });

    expect(headers.get("Cache-Control")).toBe("no-store");
    expect(headers.get("X-Example-Edge-Policy")).toBe("s-maxage=60");
    expect(headers.get("X-Example-Cache-Tag")).toBe("a,b");
  });

  it("applies adapter-owned header removals without knowing their names", () => {
    const edge: CdnCacheAdapter = {
      ownsBackgroundRevalidation: false,
      async get() {
        return null;
      },
      async set() {},
      buildResponseHeaders() {
        return {
          "Cache-Control": "no-store",
          "X-Example-Edge-Policy": null,
          "X-Example-Cache-Tag": null,
        };
      },
      async revalidateTag() {},
    };
    setCdnCacheAdapter(edge);

    const headers = new Headers({
      "Cache-Control": "public, max-age=3600",
      "X-Example-Edge-Policy": "public, max-age=3600",
      "X-Example-Cache-Tag": "stale",
    });
    applyCdnResponseHeaders(headers, { cacheControl: "no-store" });

    expect(headers.get("Cache-Control")).toBe("no-store");
    expect(headers.get("X-Example-Edge-Policy")).toBeNull();
    expect(headers.get("X-Example-Cache-Tag")).toBeNull();
  });

  it("default adapter restores baseline after the edge adapter is cleared", () => {
    setCdnCacheAdapter(new DefaultCdnCacheAdapter());
    const headers = new Headers();
    applyCdnResponseHeaders(headers, { cacheControl: "s-maxage=10" });
    expect(headers.get("Cache-Control")).toBe("s-maxage=10");
  });

  it("preserves unrelated headers the active adapter does not own", () => {
    setCdnCacheAdapter(new DefaultCdnCacheAdapter());
    const headers = new Headers({ "X-Example-Edge-Policy": "public, max-age=60" });

    applyCdnResponseHeaders(headers, { cacheControl: "no-store" });

    expect(headers.get("Cache-Control")).toBe("no-store");
    expect(headers.get("X-Example-Edge-Policy")).toBe("public, max-age=60");
  });

  it("detects explicit no-store from the generic Cache-Control fallback", () => {
    expect(
      hasExplicitNonCacheableResponsePolicy(new Headers({ "Cache-Control": "no-store" })),
    ).toBe(true);
    expect(
      hasExplicitNonCacheableResponsePolicy(new Headers({ "Cache-Control": "public, max-age=0" })),
    ).toBe(false);
  });

  it("matches exact non-cacheable directives case-insensitively", () => {
    expect(
      hasExplicitNonCacheableResponsePolicy(new Headers({ "Cache-Control": "No-Cache" })),
    ).toBe(true);
    expect(
      hasExplicitNonCacheableResponsePolicy(
        new Headers({ "Cache-Control": 'extension="value, no-store", xprivate=1, s-maxage=60' }),
      ),
    ).toBe(false);
  });

  it("keeps field-qualified private and no-cache policies cacheable", () => {
    expect(
      hasExplicitNonCacheableResponsePolicy(
        new Headers({
          "Cache-Control": 'public, max-age=60, private="set-cookie", no-cache="set-cookie"',
        }),
      ),
    ).toBe(false);
    expect(
      hasExplicitNonCacheableResponsePolicy(
        new Headers({ "Cache-Control": 'private="set-cookie", no-store' }),
      ),
    ).toBe(true);
  });

  it("delegates provider-specific policy interpretation to the active adapter", () => {
    const edge: CdnCacheAdapter = {
      ownsBackgroundRevalidation: false,
      async get() {
        return null;
      },
      async set() {},
      buildResponseHeaders() {
        return {};
      },
      hasExplicitNonCacheableResponsePolicy(headers) {
        return headers.get("X-Example-Edge-Policy") === "no-store";
      },
      async revalidateTag() {},
    };
    setCdnCacheAdapter(edge);

    expect(
      hasExplicitNonCacheableResponsePolicy(
        new Headers({
          "Cache-Control": "no-store",
          "X-Example-Edge-Policy": "public, max-age=60",
        }),
      ),
    ).toBe(false);
    expect(
      hasExplicitNonCacheableResponsePolicy(new Headers({ "X-Example-Edge-Policy": "no-store" })),
    ).toBe(true);
  });

  it("delegates request routing validation without interpreting provider headers", async () => {
    const rejected = new Response("retry", { status: 503 });
    const request = new Request("https://example.com/page", {
      headers: { "X-Provider-Version": "version-b" },
    });
    const edge: CdnCacheAdapter = {
      ownsBackgroundRevalidation: false,
      async get() {
        return null;
      },
      async set() {},
      buildResponseHeaders() {
        return {};
      },
      validateRequest(received) {
        expect(received).toBe(request);
        return rejected;
      },
      async revalidateTag() {},
    };
    setCdnCacheAdapter(edge);

    await expect(validateCdnRequest(request)).resolves.toBe(rejected);
  });
});
