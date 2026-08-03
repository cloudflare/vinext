/**
 * CloudflareCdnCacheAdapter tests.
 *
 * Covers the edge-managed adapter backed by the Workers Cache (ctx.cache):
 *  - get null / set no-op / ownsBackgroundRevalidation false
 *  - buildResponseHeaders emits a cacheable Cache-Control + Cache-Tag
 *  - revalidateTag purges via ctx.cache.purge({ tags })
 *  - getCdnCacheAdapter() only selects the Cloudflare adapter when it is
 *    explicitly configured.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vite-plus/test";
import { CloudflareCdnCacheAdapter } from "../packages/cloudflare/src/cache/cdn-adapter.runtime.js";
import {
  getCdnCacheAdapter,
  setCdnCacheAdapter,
  DefaultCdnCacheAdapter,
} from "../packages/vinext/src/shims/cdn-cache.js";
import { runWithExecutionContext } from "../packages/vinext/src/shims/request-context.js";
import {
  createRequestContext,
  runWithRequestContext,
} from "../packages/vinext/src/shims/unified-request-context.js";
import {
  headersContextFromRequest,
  runWithHeadersContext,
} from "../packages/vinext/src/shims/headers.js";
import { createStaticGenerationHeadersContext } from "../packages/vinext/src/server/app-static-generation.js";
import { applyCdnResponseHeaders } from "../packages/vinext/src/server/cache-control.js";
import { finalizeAppRscResponse } from "../packages/vinext/src/server/app-rsc-response-finalizer.js";
import { buildAppPageRscResponse } from "../packages/vinext/src/server/app-page-response.js";
import { finalizeAppPageRscCacheResponse } from "../packages/vinext/src/server/app-page-cache-finalizer.js";

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

  it("get returns null so the origin always renders fresh", async () => {
    expect(await adapter.get()).toBeNull();
  });

  it("set is a no-op (platform caches the response, not an origin store)", async () => {
    await expect(adapter.set("k", null)).resolves.toBeUndefined();
  });

  it("handles staged Worker version probes using the captured Cloudflare env", () => {
    const configured = new CloudflareCdnCacheAdapter({
      VINEXT_VERSION_METADATA: { id: "version-new" },
    });
    const response = configured.handleRequest(
      new Request("https://app.example.com/about?__vinext_version_probe=version-new", {
        method: "POST",
        headers: { "X-Vinext-Version-Probe": "1" },
      }),
    );

    expect(response?.status).toBe(204);
    expect(response?.headers.get("X-Vinext-Worker-Version")).toBe("version-new");
    expect(response?.headers.get("Cache-Control")).toBe("no-store");
    expect(response?.headers.has("CDN-Cache-Control")).toBe(false);
    expect(configured.handleRequest(new Request("https://app.example.com/about"))).toBeNull();
  });

  it("marks staged Worker version probes unavailable when the binding is absent", () => {
    const response = adapter.handleRequest(
      new Request("https://app.example.com/?__vinext_version_probe=version-new", {
        method: "POST",
        headers: { "X-Vinext-Version-Probe": "1" },
      }),
    );

    expect(response?.status).toBe(503);
    expect(response?.headers.get("X-Vinext-Worker-Version")).toBe("unavailable");
  });

  it("carries SWR on CDN-Cache-Control (public + max-age) and revalidates the browser", () => {
    // A value-less `stale-while-revalidate` is normalized to an explicit window
    // (Cloudflare ignores the bare directive — RFC 5861 requires a value).
    expect(
      adapter.buildResponseHeaders({ cacheControl: "s-maxage=60, stale-while-revalidate" }),
    ).toEqual({
      "Cache-Control": "public, max-age=0, must-revalidate",
      "CDN-Cache-Control": "public, max-age=60, stale-while-revalidate=31536000",
      Vary: "Cookie, Authorization, Host",
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

  it("only edge-caches the stable HTML and base RSC navigation variants", async () => {
    const input = { cacheControl: "s-maxage=60", tags: ["/blog", "posts"] };
    const buildFor = async (headers: HeadersInit) =>
      runWithHeadersContext(
        headersContextFromRequest(new Request("https://example.com/blog", { headers })),
        () => adapter.buildResponseHeaders(input),
      );

    await expect(buildFor({})).resolves.toMatchObject({
      "CDN-Cache-Control": "public, max-age=60",
      "Cache-Tag": "__vinext_html",
    });
    await expect(buildFor({ RSC: "1", Accept: "text/x-component" })).resolves.toMatchObject({
      "CDN-Cache-Control": "public, max-age=60",
      "Cache-Tag": "/blog,posts",
    });

    const variantHeaders: HeadersInit[] = [
      { RSC: "unexpected" },
      { RSC: "1" },
      { RSC: "1", Accept: "application/json" },
      { RSC: "1", Accept: "text/x-component, */*" },
      { RSC: "1", Accept: "TEXT/X-COMPONENT" },
      { RSC: "1", "Next-Router-State-Tree": "state-a" },
      { RSC: "1", "X-Vinext-Rsc-Render-Mode": "prefetch-loading-shell" },
      { RSC: "1", "X-Vinext-Client-Reuse-Manifest": "source-state" },
      { "X-Vinext-Interception-Context": "/feed" },
    ];
    for (const headers of variantHeaders) {
      await expect(buildFor(headers)).resolves.toEqual({
        "Cache-Control": "no-store",
        "CDN-Cache-Control": null,
        "Cloudflare-CDN-Cache-Control": null,
        "Cache-Tag": null,
      });
    }
  });

  it("routes static RSC responses through stable-variant cache admission", async () => {
    setCdnCacheAdapter(adapter);
    const buildFor = async (headers: HeadersInit) => {
      const request = new Request("https://example.com/blog?_rsc", { headers });
      return runWithHeadersContext(headersContextFromRequest(request), () =>
        buildAppPageRscResponse(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("flight"));
              controller.close();
            },
          }),
          {
            cdnTags: ["/blog", "posts"],
            middlewareContext: { headers: null, status: null },
            policy: {
              cacheControl: "s-maxage=31536000, stale-while-revalidate",
              cacheState: "STATIC",
            },
          },
        ),
      );
    };

    const baseResponse = await buildFor({ RSC: "1", Accept: "text/x-component" });
    expect(baseResponse.headers.get("CDN-Cache-Control")).toContain("max-age=31536000");
    expect(baseResponse.headers.get("Cache-Tag")).toBe("/blog,posts");
    expect(baseResponse.headers.get("Vary")).toContain("RSC");
    expect(baseResponse.headers.get("Vary")).toContain("Cookie");

    const sourceVariantResponse = await buildFor({
      RSC: "1",
      "X-Vinext-Interception-Context": "/feed",
    });
    expect(sourceVariantResponse.headers.get("Cache-Control")).toBe("no-store");
    expect(sourceVariantResponse.headers.get("CDN-Cache-Control")).toBeNull();
    expect(sourceVariantResponse.headers.get("Cloudflare-CDN-Cache-Control")).toBeNull();
    expect(sourceVariantResponse.headers.get("Cache-Tag")).toBeNull();

    const mountedRequest = new Request("https://example.com/blog?_rsc", {
      headers: { RSC: "1", "X-Vinext-Mounted-Slots": "slot:modal:/" },
    });
    const mountedMissResponse = await runWithHeadersContext(
      headersContextFromRequest(mountedRequest),
      () =>
        buildAppPageRscResponse(
          new ReadableStream({
            start(controller) {
              controller.close();
            },
          }),
          {
            cdnTags: ["/blog", "posts"],
            middlewareContext: { headers: null, status: null },
            mountedSlotsHeader: "slot:modal:/",
            policy: {
              cacheControl: "s-maxage=60, stale-while-revalidate",
              cacheState: "MISS",
            },
          },
        ),
    );
    expect(mountedMissResponse.headers.get("Cache-Control")).toBe("no-store");
    expect(mountedMissResponse.headers.get("CDN-Cache-Control")).toBeNull();
    expect(mountedMissResponse.headers.get("Cache-Tag")).toBeNull();
  });

  it("bypasses non-base variants after force-static rendering hides request APIs", async () => {
    const context = createStaticGenerationHeadersContext({
      dynamicConfig: "force-static",
      originalRequestHeaders: new Headers({
        RSC: "1",
        "Next-Router-Prefetch": "1",
      }),
      routeKind: "page",
    });

    expect(Array.from(context.headers)).toEqual([]);
    const responseHeaders = await runWithHeadersContext(context, () =>
      adapter.buildResponseHeaders({ cacheControl: "s-maxage=60", tags: ["/blog", "posts"] }),
    );
    expect(responseHeaders).toEqual({
      "Cache-Control": "no-store",
      "CDN-Cache-Control": null,
      "Cloudflare-CDN-Cache-Control": null,
      "Cache-Tag": null,
    });
  });

  it("does not edge-cache headerless .rsc compatibility transports", async () => {
    const context = createStaticGenerationHeadersContext({
      dynamicConfig: "force-static",
      originalRequestHeaders: new Headers({ Accept: "text/x-component" }),
      originalRequestUrl: "https://example.com/blog%2Ersc",
      routeKind: "page",
    });

    const responseHeaders = await runWithHeadersContext(context, () =>
      adapter.buildResponseHeaders({ cacheControl: "s-maxage=60", tags: ["/blog", "posts"] }),
    );
    expect(responseHeaders).toEqual({
      "Cache-Control": "no-store",
      "CDN-Cache-Control": null,
      "Cloudflare-CDN-Cache-Control": null,
      "Cache-Tag": null,
    });
  });

  it("does not edge-cache headerful .rsc compatibility transports", async () => {
    const context = createStaticGenerationHeadersContext({
      dynamicConfig: "force-static",
      originalRequestHeaders: new Headers({ RSC: "1", Accept: "text/x-component" }),
      originalRequestUrl: "https://example.com/blog.rsc?_rsc",
      routeKind: "page",
    });

    const responseHeaders = await runWithHeadersContext(context, () =>
      adapter.buildResponseHeaders({ cacheControl: "s-maxage=60", tags: ["/blog", "posts"] }),
    );
    expect(responseHeaders).toEqual({
      "Cache-Control": "no-store",
      "CDN-Cache-Control": null,
      "Cloudflare-CDN-Cache-Control": null,
      "Cache-Tag": null,
    });
  });

  it("varies anonymous entries on credentials and never stores credential-bearing requests", async () => {
    const buildFor = async (headers: HeadersInit) =>
      runWithHeadersContext(
        headersContextFromRequest(new Request("https://example.com/blog?_rsc", { headers })),
        () =>
          adapter.buildResponseHeaders({
            cacheControl: "s-maxage=60",
            tags: ["/blog", "posts"],
          }),
      );

    await expect(buildFor({ RSC: "1", Accept: "text/x-component" })).resolves.toMatchObject({
      "CDN-Cache-Control": "public, max-age=60",
      Vary: "Accept, Cookie, Authorization",
    });
    await expect(
      buildFor({
        RSC: "1",
        Accept: "text/x-component",
        Cookie: "__prerender_bypass=draft-secret",
      }),
    ).resolves.toEqual({
      "Cache-Control": "no-store",
      "CDN-Cache-Control": null,
      "Cloudflare-CDN-Cache-Control": null,
      "Cache-Tag": null,
    });
    await expect(
      buildFor({
        RSC: "1",
        Accept: "text/x-component",
        Authorization: "Bearer user-token",
      }),
    ).resolves.toEqual({
      "Cache-Control": "no-store",
      "CDN-Cache-Control": null,
      "Cloudflare-CDN-Cache-Control": null,
      "Cache-Tag": null,
    });
  });

  it("partitions cacheable HTML entries by request host", () => {
    const buildForHost = (host: string) =>
      runWithHeadersContext(
        headersContextFromRequest(
          new Request("https://cache-entrypoint.invalid/blog?_rsc", {
            headers: { Host: host },
          }),
        ),
        () => adapter.buildResponseHeaders({ cacheControl: "s-maxage=60", tags: ["/blog"] }),
      );

    for (const host of ["tenant-a.example.com", "tenant-b.example.com"]) {
      expect(buildForHost(host)).toMatchObject({
        "CDN-Cache-Control": "public, max-age=60",
        Vary: "Cookie, Authorization, Host",
      });
    }
  });

  it("uses original unified request Authorization after force-static hides request APIs", async () => {
    const requestHeaders = new Headers({
      Accept: "text/x-component",
      Authorization: "Bearer user-token",
      RSC: "1",
    });
    const requestContext = createRequestContext({
      cdnCacheRequestHeaders: requestHeaders,
      cdnCacheRequestUrl: "https://example.com/blog?_rsc",
      headersContext: createStaticGenerationHeadersContext({
        dynamicConfig: "force-static",
        originalRequestHeaders: requestHeaders,
        routeKind: "page",
      }),
    });

    expect(Array.from(requestContext.headersContext!.headers)).toEqual([]);
    expect(
      runWithRequestContext(requestContext, () =>
        adapter.buildResponseHeaders({ cacheControl: "s-maxage=60", tags: ["/blog"] }),
      ),
    ).toEqual({
      "Cache-Control": "no-store",
      "CDN-Cache-Control": null,
      "Cloudflare-CDN-Cache-Control": null,
      "Cache-Tag": null,
    });
  });

  it("keeps denied RSC variants no-store after matching config headers", async () => {
    setCdnCacheAdapter(adapter);
    const request = new Request("https://example.com/blog?_rsc", {
      headers: { RSC: "1", "Next-Router-State-Tree": "state-a" },
    });
    const response = new Response("flight", {
      status: 200,
      headers: { "Content-Type": "text/x-component" },
    });
    await runWithHeadersContext(headersContextFromRequest(request), async () => {
      applyCdnResponseHeaders(response.headers, {
        cacheControl: "s-maxage=60",
        tags: ["/blog", "posts"],
      });
      await finalizeAppRscResponse(response, request, {
        basePath: "",
        configHeaders: [
          {
            source: "/blog",
            headers: [
              { key: "CDN-Cache-Control", value: "public, max-age=3600" },
              { key: "Cloudflare-CDN-Cache-Control", value: "public, max-age=3600" },
            ],
          },
        ],
        i18nConfig: null,
        requestContext: {
          cookies: {},
          headers: request.headers,
          host: "example.com",
          query: new URL(request.url).searchParams,
        },
      });
    });

    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("CDN-Cache-Control")).toBeNull();
    expect(response.headers.get("Cloudflare-CDN-Cache-Control")).toBeNull();
    expect(response.headers.get("Cache-Tag")).toBeNull();
  });

  it("removes middleware cache directives from no-store responses without config headers", async () => {
    setCdnCacheAdapter(adapter);
    const request = new Request("https://example.com/blog?_rsc", {
      headers: { RSC: "1", "Next-Router-State-Tree": "state-a" },
    });
    const response = new Response("flight", {
      headers: {
        "Cache-Control": "no-store",
        "CDN-Cache-Control": "public, max-age=3600",
        "Cloudflare-CDN-Cache-Control": "public, max-age=3600",
      },
    });

    await runWithHeadersContext(headersContextFromRequest(request), () =>
      finalizeAppRscResponse(response, request, {
        basePath: "",
        configHeaders: [],
        i18nConfig: null,
        requestContext: {
          cookies: {},
          headers: request.headers,
          host: "example.com",
          query: new URL(request.url).searchParams,
        },
      }),
    );

    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("CDN-Cache-Control")).toBeNull();
    expect(response.headers.get("Cloudflare-CDN-Cache-Control")).toBeNull();
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
      "Private, No-Cache, No-Store, max-age=0, must-revalidate",
    ]) {
      const headers = adapter.buildResponseHeaders({ cacheControl: cc, tags: ["x"] });
      expect(headers).toEqual({
        "Cache-Control": cc,
        "CDN-Cache-Control": null,
        "Cloudflare-CDN-Cache-Control": null,
        "Cache-Tag": null,
      });
    }
  });

  it("uses a CDN-scoped no-store policy for browser no-cache responses", () => {
    expect(
      adapter.buildResponseHeaders({ cacheControl: "no-cache, max-age=0", tags: ["x"] }),
    ).toEqual({
      "Cache-Control": "no-cache, max-age=0",
      "CDN-Cache-Control": null,
      "Cloudflare-CDN-Cache-Control": "no-store",
      "Cache-Tag": null,
    });
  });

  it.each(["MISS", "STATIC"] as const)(
    "keeps mounted-slot %s RSC responses out of the edge cache",
    async (cacheState) => {
      setCdnCacheAdapter(new CloudflareCdnCacheAdapter());
      const isrSet = vi.fn();

      const response = finalizeAppPageRscCacheResponse(
        new Response("slot-specific-flight", {
          headers: {
            "Cache-Control": "s-maxage=60, stale-while-revalidate",
            "Cache-Tag": "/dashboard",
            "CDN-Cache-Control": "public, max-age=60",
            "Content-Type": "text/x-component",
            "X-Vinext-Cache": cacheState,
          },
        }),
        {
          capturedRscDataPromise: Promise.resolve(
            new TextEncoder().encode("slot-specific-flight").buffer,
          ),
          cleanPathname: "/dashboard",
          consumeDynamicUsage() {
            return false;
          },
          dynamicUsedDuringBuild: false,
          getPageTags() {
            return ["/dashboard"];
          },
          isrRscKey: vi.fn(),
          isrSet,
          mountedSlotsHeader: "slot:auth:/",
          preserveClientResponseHeaders: cacheState !== "MISS",
          revalidateSeconds: 60,
        },
      );

      expect(response.headers.get("Cache-Control")).toBe("no-store, must-revalidate");
      expect(response.headers.get("CDN-Cache-Control")).toBeNull();
      expect(response.headers.get("Cache-Tag")).toBeNull();
      expect(response.headers.get("X-Vinext-Cache")).toBe("MISS");
      await expect(response.text()).resolves.toBe("slot-specific-flight");
      expect(isrSet).not.toHaveBeenCalled();
    },
  );

  it("clears middleware CDN overrides for mounted slots with the default adapter", async () => {
    setCdnCacheAdapter(new DefaultCdnCacheAdapter());

    const response = finalizeAppPageRscCacheResponse(
      new Response("slot-specific-flight", {
        headers: {
          "Cache-Control": "s-maxage=60",
          "Cache-Tag": "/dashboard",
          "CDN-Cache-Control": "public, max-age=60",
          "Cloudflare-CDN-Cache-Control": "public, max-age=60",
          "X-Vinext-Cache": "STATIC",
        },
      }),
      {
        capturedRscDataPromise: Promise.resolve(
          new TextEncoder().encode("slot-specific-flight").buffer,
        ),
        cleanPathname: "/dashboard",
        consumeDynamicUsage() {
          return false;
        },
        dynamicUsedDuringBuild: false,
        getPageTags() {
          return ["/dashboard"];
        },
        isrRscKey: vi.fn(),
        isrSet: vi.fn(),
        mountedSlotsHeader: "slot:auth:/",
        preserveClientResponseHeaders: true,
        revalidateSeconds: 60,
      },
    );

    expect(response.headers.get("Cache-Control")).toBe("no-store, must-revalidate");
    expect(response.headers.get("CDN-Cache-Control")).toBeNull();
    expect(response.headers.get("Cloudflare-CDN-Cache-Control")).toBeNull();
    expect(response.headers.get("Cache-Tag")).toBeNull();
    expect(response.headers.get("X-Vinext-Cache")).toBe("MISS");
    await expect(response.text()).resolves.toBe("slot-specific-flight");
  });

  it("keeps mounted dynamic responses headerless while clearing CDN overrides", async () => {
    setCdnCacheAdapter(new DefaultCdnCacheAdapter());

    const response = finalizeAppPageRscCacheResponse(
      new Response("dynamic-slot-flight", {
        headers: {
          "Cache-Control": "no-store, must-revalidate",
          "Cache-Tag": "/dashboard",
          "CDN-Cache-Control": "public, max-age=60",
          "Cloudflare-CDN-Cache-Control": "public, max-age=60",
        },
      }),
      {
        capturedRscDataPromise: null,
        cleanPathname: "/dashboard",
        consumeDynamicUsage() {
          return true;
        },
        dynamicUsedDuringBuild: true,
        getPageTags() {
          return ["/dashboard"];
        },
        isrRscKey: vi.fn(),
        isrSet: vi.fn(),
        mountedSlotsHeader: "slot:auth:/",
        preserveClientResponseHeaders: true,
        revalidateSeconds: null,
      },
    );

    expect(response.headers.get("Cache-Control")).toBe("no-store, must-revalidate");
    expect(response.headers.get("CDN-Cache-Control")).toBeNull();
    expect(response.headers.get("Cloudflare-CDN-Cache-Control")).toBeNull();
    expect(response.headers.get("Cache-Tag")).toBeNull();
    expect(response.headers.get("X-Vinext-Cache")).toBeNull();
    expect(response.headers.get("X-Nextjs-Cache")).toBeNull();
    await expect(response.text()).resolves.toBe("dynamic-slot-flight");
  });

  it("clears middleware CDN overrides for pending dynamic misses", async () => {
    setCdnCacheAdapter(new DefaultCdnCacheAdapter());

    const response = finalizeAppPageRscCacheResponse(
      new Response("pending-dynamic-flight", {
        headers: {
          "Cache-Control": "s-maxage=60",
          "Cache-Tag": "/dashboard",
          "CDN-Cache-Control": "public, max-age=60",
          "Cloudflare-CDN-Cache-Control": "public, max-age=60",
          "X-Vinext-Cache": "MISS",
        },
      }),
      {
        capturedRscDataPromise: null,
        cleanPathname: "/dashboard",
        consumeDynamicUsage() {
          return false;
        },
        dynamicUsedDuringBuild: false,
        getPageTags() {
          return ["/dashboard"];
        },
        isrRscKey: vi.fn(),
        isrSet: vi.fn(),
        preserveClientResponseHeaders: false,
        revalidateSeconds: 60,
      },
    );

    expect(response.headers.get("Cache-Control")).toBe("no-store, must-revalidate");
    expect(response.headers.get("CDN-Cache-Control")).toBeNull();
    expect(response.headers.get("Cloudflare-CDN-Cache-Control")).toBeNull();
    expect(response.headers.get("Cache-Tag")).toBeNull();
    expect(response.headers.get("X-Vinext-Cache")).toBe("MISS");
    await expect(response.text()).resolves.toBe("pending-dynamic-flight");
  });

  it("revalidateTag purges the Workers Cache by tag via ctx.cache.purge", async () => {
    const purge = vi.fn(async () => {});
    await runWithExecutionContext({ waitUntil() {}, cache: { purge } }, async () => {
      await adapter.revalidateTag(["posts", "_N_T_/blog"]);
    });
    expect(purge).toHaveBeenCalledWith({
      tags: ["posts", "_N_T_/blog", "__vinext_html"],
    });
  });

  it("revalidateTag normalizes a single tag to an array", async () => {
    const purge = vi.fn(async () => {});
    await runWithExecutionContext({ waitUntil() {}, cache: { purge } }, async () => {
      await adapter.revalidateTag("posts");
    });
    expect(purge).toHaveBeenCalledWith({ tags: ["posts", "__vinext_html"] });
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

// ─── Adapter selection ────────────────────────────────────────────────────

describe("CDN cache adapter selection", () => {
  it("uses the default adapter even when ctx.cache exists", async () => {
    resetActiveAdapter();

    const adapter = await runWithExecutionContext(
      { waitUntil() {}, cache: { async purge() {} } },
      async () => getCdnCacheAdapter(),
    );
    expect(adapter).toBeInstanceOf(DefaultCdnCacheAdapter);
  });

  it("uses the default adapter when ctx.cache is absent", () => {
    resetActiveAdapter();
    expect(getCdnCacheAdapter()).toBeInstanceOf(DefaultCdnCacheAdapter);
  });

  it("uses an explicitly configured adapter", async () => {
    resetActiveAdapter();
    const explicit = new CloudflareCdnCacheAdapter();
    setCdnCacheAdapter(explicit);

    const adapter = await runWithExecutionContext(
      { waitUntil() {}, cache: { async purge() {} } },
      async () => getCdnCacheAdapter(),
    );
    expect(adapter).toBe(explicit);
  });
});
