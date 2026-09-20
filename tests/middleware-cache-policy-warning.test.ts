import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { VINEXT_RSC_VARY_HEADER } from "../packages/vinext/src/server/app-rsc-vary.js";
import { warnOnUnreachableMiddlewareCachePolicy } from "../packages/vinext/src/server/middleware-cache-policy-warning.js";
import { executeMiddleware } from "../packages/vinext/src/server/middleware-runtime.js";
import {
  DefaultCdnCacheAdapter,
  setCdnCacheAdapter,
  type CdnCacheAdapter,
  type CdnResponsePolicy,
} from "../packages/vinext/src/shims/cdn-cache.js";
import { withEnvVar } from "./env-test-helpers.js";

/** Minimal edge adapter that owns the client-visible cache policy. */
function edgeAdapter(responsePolicy?: CdnResponsePolicy): CdnCacheAdapter {
  return {
    ownsBackgroundRevalidation: false,
    ...(responsePolicy ? { responsePolicy } : {}),
    async get() {
      return null;
    },
    async set() {},
    buildResponseHeaders() {
      return {};
    },
    async revalidateTag() {},
  };
}

const CDN_CACHE_CONTROL_POLICY: CdnResponsePolicy = {
  isHeader: (name) => name.toLowerCase() === "cdn-cache-control",
  readCacheControl: (headers) => headers.get("CDN-Cache-Control"),
  hasExplicitNonCacheablePolicy: () => false,
};

describe("warnOnUnreachableMiddlewareCachePolicy", () => {
  const warnings: string[] = [];

  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation((message) => {
      warnings.push(String(message));
    });
  });

  afterEach(() => {
    warnings.length = 0;
    vi.restoreAllMocks();
    setCdnCacheAdapter(new DefaultCdnCacheAdapter());
  });

  it("warns for a middleware-authored Cache-Control under a configured CDN adapter", () => {
    setCdnCacheAdapter(edgeAdapter());
    const headers = new Headers({ "Cache-Control": "public, max-age=60" });

    warnOnUnreachableMiddlewareCachePolicy(headers, { fileName: "proxy.ts" });

    expect(warnings).toEqual([
      [
        "[vinext] proxy.ts set response cache headers (cache-control) that the configured CDN cache adapter owns.",
        "  Middleware runs above the cached response stage, so the adapter derives the client-visible Cache-Control, CDN-Cache-Control, and Cache-Tag headers from the framework's own route policy and these values are not delivered as authored.",
        '  Set the cache policy on the route (export const revalidate, cacheLife, or "use cache") instead, or remove the CDN adapter if middleware should own these headers.',
        "  See docs/caching.md.",
      ].join("\n"),
    ]);
  });

  it("does not warn while the origin-managed default adapter is active", () => {
    setCdnCacheAdapter(new DefaultCdnCacheAdapter());
    const headers = new Headers({ "Cache-Control": "public, max-age=60" });

    warnOnUnreachableMiddlewareCachePolicy(headers, { fileName: "middleware.ts" });

    expect(warnings).toEqual([]);
  });

  it("does not warn in production", () => {
    setCdnCacheAdapter(edgeAdapter());
    const headers = new Headers({ "Cache-Control": "public, max-age=60" });

    withEnvVar("NODE_ENV", "production", () => {
      warnOnUnreachableMiddlewareCachePolicy(headers, { fileName: "middleware.ts" });
    });

    expect(warnings).toEqual([]);
  });

  it("dedupes identical header sets but warns again for a different set", () => {
    setCdnCacheAdapter(edgeAdapter());

    warnOnUnreachableMiddlewareCachePolicy(
      new Headers({ "Cache-Control": "public, max-age=60", "Cache-Tag": "post-1" }),
      { fileName: "proxy.ts" },
    );
    warnOnUnreachableMiddlewareCachePolicy(
      new Headers({ "Cache-Control": "public, max-age=60", "Cache-Tag": "post-1" }),
      { fileName: "proxy.ts" },
    );
    expect(warnings).toHaveLength(1);

    warnOnUnreachableMiddlewareCachePolicy(
      new Headers({ "Cache-Control": "public, max-age=60", "Cache-Tag": "post-1", Vary: "Host" }),
      { fileName: "proxy.ts" },
    );
    expect(warnings).toHaveLength(2);
    expect(warnings[1]).toContain("(cache-control, cache-tag, vary)");
  });

  it("warns for middleware-authored Cache-Tag", () => {
    setCdnCacheAdapter(edgeAdapter());

    warnOnUnreachableMiddlewareCachePolicy(new Headers({ "Cache-Tag": "post-1" }), {
      fileName: "middleware.ts",
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("(cache-tag)");
  });

  it("warns for provider policy headers the adapter owns", () => {
    setCdnCacheAdapter(edgeAdapter(CDN_CACHE_CONTROL_POLICY));

    warnOnUnreachableMiddlewareCachePolicy(new Headers({ "CDN-Cache-Control": "max-age=60" }), {
      fileName: "middleware.ts",
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("(cdn-cache-control)");
  });

  it("does not warn for a framework-only Vary", () => {
    setCdnCacheAdapter(edgeAdapter());

    warnOnUnreachableMiddlewareCachePolicy(new Headers({ Vary: VINEXT_RSC_VARY_HEADER }), {
      fileName: "middleware.ts",
    });

    expect(warnings).toEqual([]);
  });

  it("warns for a custom Vary field and names it", () => {
    setCdnCacheAdapter(edgeAdapter());

    warnOnUnreachableMiddlewareCachePolicy(new Headers({ Vary: "Host" }), {
      fileName: "middleware.ts",
    });

    expect(warnings).toEqual([
      [
        "[vinext] middleware.ts set response cache headers (vary) that the configured CDN cache adapter owns.",
        "  Middleware runs above the cached response stage, so the adapter derives the client-visible Cache-Control, CDN-Cache-Control, and Cache-Tag headers from the framework's own route policy and these values are not delivered as authored.",
        '  Set the cache policy on the route (export const revalidate, cacheLife, or "use cache") instead, or remove the CDN adapter if middleware should own these headers.',
        "  Vary: Host cannot partition stored responses either — middleware runs above the cache, and a cached response that carries Cache-Tag plus a custom Vary field is served with Cache-Control: no-store.",
        "  See docs/caching.md.",
      ].join("\n"),
    ]);
  });

  it("ignores x-middleware-* internal headers", () => {
    setCdnCacheAdapter(edgeAdapter());

    warnOnUnreachableMiddlewareCachePolicy(
      new Headers({
        "x-middleware-next": "1",
        "x-middleware-rewrite": "https://example.com/",
      }),
      { fileName: "middleware.ts" },
    );

    expect(warnings).toEqual([]);
  });

  it("warns for cache headers on a middleware response executed by executeMiddleware", async () => {
    setCdnCacheAdapter(edgeAdapter());

    await executeMiddleware({
      filePath: "/app/proxy.ts",
      isProxy: true,
      module: {
        proxy: () =>
          new Response("ok", {
            headers: { "Cache-Control": "public, max-age=60", Vary: "Host" },
          }),
      },
      request: new Request("http://localhost:3000/"),
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("[vinext] proxy.ts set response cache headers");
    expect(warnings[0]).toContain("(cache-control, vary)");
  });
});
