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
import {
  finalizeAppRscResponse,
  markAppExternalRewriteResponse,
} from "../packages/vinext/src/server/app-rsc-response-finalizer.js";
import { buildAppPageRscResponse } from "../packages/vinext/src/server/app-page-response.js";
import {
  finalizeAppPageHtmlCacheResponse,
  finalizeAppPageRscCacheResponse,
} from "../packages/vinext/src/server/app-page-cache-finalizer.js";

const CDN_KEY = Symbol.for("vinext.cdnCacheAdapter");

function resetActiveAdapter(): void {
  delete (globalThis as Record<PropertyKey, unknown>)[CDN_KEY];
}

function finalizePendingDynamicRscResponse(): Response {
  return finalizeAppPageRscCacheResponse(
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
        headers: { "X-Vinext-Version-Probe": "1" },
      }),
    );

    expect(response?.status).toBe(204);
    expect(response?.headers.get("X-Vinext-Worker-Version")).toBe("version-new");
    expect(response?.headers.get("Cache-Control")).toBe("no-store");
    expect(response?.headers.has("CDN-Cache-Control")).toBe(false);
    expect(configured.handleRequest(new Request("https://app.example.com/about"))).toBeNull();
    expect(
      configured.handleRequest(
        new Request("https://app.example.com/about?__vinext_version_probe=version-new", {
          method: "POST",
          headers: { "X-Vinext-Version-Probe": "1" },
        }),
      ),
    ).toBeNull();
  });

  it("marks staged Worker version probes unavailable when the binding is absent", () => {
    const response = adapter.handleRequest(
      new Request("https://app.example.com/?__vinext_version_probe=version-new", {
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
      Vary: "Cookie, Authorization, Host, X-Forwarded-Proto",
      "Cloudflare-CDN-Cache-Control": null,
      "Cache-Tag": null,
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
    expect(headers["Cache-Tag"]).toBe("%2Fblog,_N_T_%2Fblog,posts");
    expect(headers["Cache-Control"]).toBe("public, max-age=0, must-revalidate");
    expect(headers["CDN-Cache-Control"]).toBe("public, max-age=60");
  });

  it("does not replace an adapter-owned no-store policy with public caching", () => {
    setCdnCacheAdapter(adapter);
    const headers = new Headers({
      "Cache-Control": "public, max-age=60",
      "Cloudflare-CDN-Cache-Control": "no-store",
    });

    applyCdnResponseHeaders(headers, { cacheControl: "s-maxage=60" });

    expect(headers.get("Cache-Control")).toBe("no-store");
    expect(headers.get("CDN-Cache-Control")).toBeNull();
    expect(headers.get("Cloudflare-CDN-Cache-Control")).toBeNull();
  });

  it("never admits a Set-Cookie response to shared caching", () => {
    setCdnCacheAdapter(adapter);
    const headers = new Headers({ "Set-Cookie": "session=private; Path=/" });

    applyCdnResponseHeaders(headers, { cacheControl: "s-maxage=60" });

    expect(headers.get("Cache-Control")).toBe("no-store");
    expect(headers.get("CDN-Cache-Control")).toBeNull();
    expect(headers.get("Set-Cookie")).toBe("session=private; Path=/");
  });

  it("edge-caches valid digest-keyed RSC variants while rejecting invalid protocol shapes", async () => {
    const input = { cacheControl: "s-maxage=60", tags: ["/blog", "posts"] };
    const buildFor = async (headers: HeadersInit) =>
      runWithHeadersContext(
        headersContextFromRequest(new Request("https://example.com/blog", { headers })),
        () => adapter.buildResponseHeaders(input),
      );

    await expect(buildFor({})).resolves.toMatchObject({
      "CDN-Cache-Control": "public, max-age=60",
      "Cache-Tag": "%2Fblog,posts",
    });
    await expect(buildFor({ RSC: "1", Accept: "text/x-component" })).resolves.toMatchObject({
      "CDN-Cache-Control": "public, max-age=60",
      "Cache-Tag": "%2Fblog,posts",
      Vary: "Accept, Cookie, Authorization, Host, X-Forwarded-Proto",
    });

    const variantHeaders: HeadersInit[] = [
      { RSC: "unexpected" },
      { RSC: "1" },
      { RSC: "1", Accept: "application/json" },
      { RSC: "1", Accept: "text/x-component, */*" },
      { RSC: "1", Accept: "TEXT/X-COMPONENT" },
      { RSC: "1", "Next-Router-State-Tree": "state-without-accept" },
      { RSC: "1", "X-Vinext-Rsc-Render-Mode": "prefetch-without-accept" },
      { RSC: "1", "X-Vinext-Client-Reuse-Manifest": "reuse-without-accept" },
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

    for (const headers of [
      {
        Accept: "text/x-component",
        RSC: "1",
        "Next-Router-State-Tree": "state-a",
        "Next-Url": "/source",
      },
      {
        Accept: "text/x-component",
        RSC: "1",
        "X-Vinext-Interception-Id": "interception:slot:source->target",
      },
      {
        Accept: "text/x-component",
        RSC: "1",
        "X-Vinext-Rsc-Render-Mode": "prefetch-loading-shell",
      },
    ] as HeadersInit[]) {
      await expect(buildFor(headers)).resolves.toMatchObject({
        "CDN-Cache-Control": "public, max-age=60",
        "Cache-Tag": "%2Fblog,posts",
        Vary: "Accept, Cookie, Authorization, Host, X-Forwarded-Proto",
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
    expect(baseResponse.headers.get("Cache-Tag")).toBe("%2Fblog,posts");
    expect(baseResponse.headers.get("Vary")).toContain("RSC");
    expect(baseResponse.headers.get("Vary")).toContain("Cookie");
    expect(baseResponse.headers.get("Vary")).toContain("Host");

    const sourceVariantResponse = await buildFor({
      Accept: "text/x-component",
      RSC: "1",
      "X-Vinext-Interception-Context": "/feed",
    });
    expect(sourceVariantResponse.headers.get("CDN-Cache-Control")).toContain("max-age=31536000");
    expect(sourceVariantResponse.headers.get("Cloudflare-CDN-Cache-Control")).toBeNull();
    expect(sourceVariantResponse.headers.get("Cache-Tag")).toBe("%2Fblog,posts");

    const mountedRequest = new Request("https://example.com/blog?_rsc", {
      headers: {
        Accept: "text/x-component",
        RSC: "1",
        "X-Vinext-Mounted-Slots": "slot:modal:/",
      },
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
    expect(mountedMissResponse.headers.get("CDN-Cache-Control")).toContain("max-age=60");
    expect(mountedMissResponse.headers.get("Cache-Tag")).toBe("%2Fblog,posts");
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
      Vary: "Accept, Cookie, Authorization, Host, X-Forwarded-Proto",
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
          new Request("https://cache-entrypoint.invalid/blog", {
            headers: { Host: host },
          }),
        ),
        () => adapter.buildResponseHeaders({ cacheControl: "s-maxage=60", tags: ["/blog"] }),
      );

    for (const host of ["tenant-a.example.com", "tenant-b.example.com"]) {
      expect(buildForHost(host)).toMatchObject({
        "CDN-Cache-Control": "public, max-age=60",
        Vary: "Cookie, Authorization, Host, X-Forwarded-Proto",
      });
    }
  });

  it("partitions cacheable HTML and RSC entries by Cloudflare's forwarded protocol", async () => {
    const buildVaryIdentity = async (protocol: "http" | "https", rsc: boolean) => {
      const requestHeaders = new Headers({
        "X-Forwarded-Proto": protocol,
        ...(rsc ? { Accept: "text/x-component", RSC: "1" } : {}),
      });
      const responseHeaders = await runWithHeadersContext(
        headersContextFromRequest(
          new Request(`${protocol}://example.com/blog${rsc ? "?_rsc" : ""}`, {
            headers: requestHeaders,
          }),
        ),
        () => adapter.buildResponseHeaders({ cacheControl: "s-maxage=60", tags: ["/blog"] }),
      );
      const vary = responseHeaders.Vary;
      expect(vary).toContain("X-Forwarded-Proto");
      return {
        cacheTag: responseHeaders["Cache-Tag"],
        identity: vary
          ?.split(",")
          .map((field) => requestHeaders.get(field.trim()) ?? "")
          .join("\n"),
      };
    };

    for (const rsc of [false, true]) {
      const http = await buildVaryIdentity("http", rsc);
      const https = await buildVaryIdentity("https", rsc);
      expect(http.identity).not.toBe(https.identity);
      expect(http.cacheTag).toBe("%2Fblog");
      expect(https.cacheTag).toBe(http.cacheTag);
    }
  });

  it("does not store an HTML variant on an RSC transport URL", () => {
    const request = new Request("https://example.com/blog?_rsc");
    const headers = runWithHeadersContext(headersContextFromRequest(request), () =>
      adapter.buildResponseHeaders({ cacheControl: "s-maxage=60", tags: ["/blog"] }),
    );

    expect(headers).toEqual({
      "Cache-Control": "no-store",
      "CDN-Cache-Control": null,
      "Cloudflare-CDN-Cache-Control": null,
      "Cache-Tag": null,
    });
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

  it("makes cacheable App responses no-store when config headers add Set-Cookie", async () => {
    setCdnCacheAdapter(adapter);
    const request = new Request("https://example.com/blog");
    const response = new Response("html", {
      headers: { "Content-Type": "text/html" },
    });

    await runWithHeadersContext(headersContextFromRequest(request), async () => {
      applyCdnResponseHeaders(response.headers, { cacheControl: "s-maxage=60" });
      await finalizeAppRscResponse(response, request, {
        basePath: "",
        configHeaders: [
          {
            source: "/blog",
            headers: [{ key: "Set-Cookie", value: "session=private; Path=/" }],
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
    expect(response.headers.get("Set-Cookie")).toBe("session=private; Path=/");
  });

  it.each([
    ["Cookie", "session=private"],
    ["Authorization", "Bearer private"],
  ])(
    "does not let config headers promote a %s response rejected by the adapter",
    async (headerName, headerValue) => {
      setCdnCacheAdapter(adapter);
      const request = new Request("https://example.com/blog?_rsc", {
        headers: {
          Accept: "text/x-component",
          [headerName]: headerValue,
          RSC: "1",
        },
      });
      const response = new Response("private flight", {
        headers: { "Content-Type": "text/x-component" },
      });

      await runWithHeadersContext(headersContextFromRequest(request), async () => {
        applyCdnResponseHeaders(response.headers, {
          cacheControl: "s-maxage=60",
          tags: ["/blog"],
        });
        await finalizeAppRscResponse(response, request, {
          basePath: "",
          configHeaders: [
            {
              source: "/blog",
              headers: [{ key: "Cache-Control", value: "public, max-age=3600" }],
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
    },
  );

  it("normalizes cacheable external rewrite responses through the adapter", async () => {
    setCdnCacheAdapter(adapter);
    const request = new Request("https://example.com/proxy?_rsc", {
      headers: { Accept: "text/x-component", RSC: "1" },
    });
    const response = markAppExternalRewriteResponse(
      new Response("external flight", {
        headers: {
          "Cache-Control": "public, max-age=60",
          "Content-Type": "text/x-component",
        },
      }),
    );

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

    expect(response.headers.get("Cache-Control")).toBe("public, max-age=0, must-revalidate");
    expect(response.headers.get("CDN-Cache-Control")).toBe("public, max-age=60");
    expect(response.headers.get("Vary")).toContain("Cookie");
    expect(response.headers.get("Vary")).toContain("Authorization");
    expect(response.headers.get("Vary")).toContain("Host");
    expect(response.headers.get("Vary")).toContain("X-Forwarded-Proto");
  });

  it("does not cache credential-bearing external rewrite responses", async () => {
    setCdnCacheAdapter(adapter);
    const request = new Request("https://example.com/proxy?_rsc", {
      headers: {
        Accept: "text/x-component",
        Authorization: "Bearer private",
        RSC: "1",
      },
    });
    const response = markAppExternalRewriteResponse(
      new Response("private external flight", {
        headers: {
          "Cache-Control": "public, max-age=60",
          "Content-Type": "text/x-component",
        },
      }),
    );

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
    expect(response.headers.get("Cache-Tag")).toBeNull();
  });

  it("does not cache credential-bearing external rewrite redirects", async () => {
    setCdnCacheAdapter(adapter);
    const request = new Request("https://example.com/proxy", {
      headers: { Cookie: "session=private" },
    });
    const response = markAppExternalRewriteResponse(
      Response.redirect("https://example.com/private-target", 302),
    );

    const finalized = await runWithHeadersContext(headersContextFromRequest(request), () =>
      finalizeAppRscResponse(response, request, {
        basePath: "",
        configHeaders: [],
        i18nConfig: null,
        requestContext: {
          cookies: { session: "private" },
          headers: request.headers,
          host: "example.com",
          query: new URL(request.url).searchParams,
        },
      }),
    );

    expect(finalized).not.toBe(response);
    expect(finalized.status).toBe(302);
    expect(finalized.headers.get("Location")).toBe("https://example.com/private-target");
    expect(finalized.headers.get("Cache-Control")).toBe("no-store");
    expect(finalized.headers.get("CDN-Cache-Control")).toBeNull();
    expect(finalized.headers.get("Cloudflare-CDN-Cache-Control")).toBeNull();
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

  it("encodes tags that Cloudflare cannot represent verbatim", () => {
    const headers = adapter.buildResponseHeaders({
      cacheControl: "s-maxage=60",
      tags: ["a,b", "tag with space", "ok"],
    });
    expect(headers["Cache-Tag"]).toBe("a%2Cb,tag%20with%20space,ok");
  });

  it("de-duplicates encoded tags using Cloudflare's case-insensitive identity", () => {
    const headers = adapter.buildResponseHeaders({
      cacheControl: "s-maxage=60",
      tags: ["a,b", "A,B", "posts", "POSTS"],
    });
    expect(headers["Cache-Tag"]).toBe("a%2Cb,posts");
  });

  it("fails closed when precise RSC tags exceed provider limits", async () => {
    const request = new Request("https://example.com/blog?_rsc", {
      headers: { Accept: "text/x-component", RSC: "1" },
    });
    const headers = await runWithHeadersContext(headersContextFromRequest(request), () =>
      adapter.buildResponseHeaders({
        cacheControl: "s-maxage=60",
        tags: Array.from({ length: 1001 }, (_, index) => `t${index}`),
      }),
    );
    expect(headers).toEqual({
      "Cache-Control": "no-store",
      "CDN-Cache-Control": null,
      "Cloudflare-CDN-Cache-Control": null,
      "Cache-Tag": null,
    });
  });

  it("counts distinct provider tags after de-duplication", () => {
    const tags = Array.from({ length: 1000 }, (_, index) => `t${index}`);
    tags.push("T0");
    const headers = adapter.buildResponseHeaders({ cacheControl: "s-maxage=60", tags });
    expect(headers["Cache-Tag"]?.split(",")).toHaveLength(1000);
  });

  it("does not cache precise-tag responses when the full tag set is unrepresentable", () => {
    expect(
      adapter.buildResponseHeaders({
        cacheControl: "s-maxage=60",
        tags: ["x".repeat(2000), "ok"],
      }),
    ).toEqual({
      "Cache-Control": "no-store",
      "CDN-Cache-Control": null,
      "Cloudflare-CDN-Cache-Control": null,
      "Cache-Tag": null,
    });
  });

  it("returns no-store and clears owned headers when there is no cacheable policy", () => {
    expect(adapter.buildResponseHeaders({ cacheControl: "" })).toEqual({
      "Cache-Control": "no-store",
      "CDN-Cache-Control": null,
      "Cloudflare-CDN-Cache-Control": null,
      "Cache-Tag": null,
    });
  });

  it("denies source-dependent storage in Cloudflare and downstream shared caches", () => {
    expect(
      adapter.buildSourceDependentResponseHeaders({
        cacheControl: "s-maxage=2, stale-while-revalidate=31535998",
      }),
    ).toEqual({
      "Cache-Control": "no-store",
      "CDN-Cache-Control": null,
      "Cloudflare-CDN-Cache-Control": "no-store",
      "Cache-Tag": null,
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

  it("interprets its own edge policy when checking whether a response opted out", () => {
    expect(
      adapter.hasExplicitNonCacheableResponsePolicy(
        new Headers({
          "Cache-Control": "no-store",
          "CDN-Cache-Control": "public, max-age=60",
        }),
      ),
    ).toBe(false);
    expect(
      adapter.hasExplicitNonCacheableResponsePolicy(
        new Headers({ "Cloudflare-CDN-Cache-Control": "private, no-store" }),
      ),
    ).toBe(true);
  });

  it("recovers a Cloudflare-scoped denial without relying on the separate denial hook", () => {
    expect(
      adapter.readResponseCachePolicy(
        new Headers({ "Cloudflare-CDN-Cache-Control": "private, no-store" }),
      ),
    ).toEqual({ cacheControl: "no-store" });
    expect(
      adapter.readResponseCachePolicy(
        new Headers({
          "Cache-Control": "public, max-age=0, must-revalidate",
          "CDN-Cache-Control": "public, max-age=60",
          "Cloudflare-CDN-Cache-Control": "no-store",
        }),
      ),
    ).toEqual({ cacheControl: "no-store" });
  });

  it("replaces Cloudflare headers on pending HTML and still skips a late-dynamic cache write", async () => {
    setCdnCacheAdapter(new CloudflareCdnCacheAdapter());
    const pendingCacheWrites: Promise<void>[] = [];
    const isrSet = vi.fn();

    const response = finalizeAppPageHtmlCacheResponse(
      new Response("<h1>personalized</h1>", {
        headers: {
          "Cache-Control": "s-maxage=60, stale-while-revalidate",
          "CDN-Cache-Control": "public, max-age=6000",
          "Cloudflare-CDN-Cache-Control": "public, max-age=6000",
          "Cache-Tag": "stale",
          "X-Vinext-Cache": "MISS",
        },
      }),
      {
        capturedRscDataPromise: Promise.resolve(new TextEncoder().encode("flight").buffer),
        cleanPathname: "/dynamic-html",
        consumeDynamicUsage() {
          return true;
        },
        getPageTags() {
          return ["/dynamic-html"];
        },
        isrHtmlKey(pathname) {
          return "html:" + pathname;
        },
        isrRscKey(pathname) {
          return "rsc:" + pathname;
        },
        isrSet,
        revalidateSeconds: 60,
        linkHeader: null,
        waitUntil(promise) {
          pendingCacheWrites.push(promise);
        },
      },
    );

    expect(response.headers.get("Cache-Control")).toBe("public, max-age=0, must-revalidate");
    expect(response.headers.get("CDN-Cache-Control")).toBe(
      "public, max-age=60, stale-while-revalidate=31536000",
    );
    expect(response.headers.get("Cloudflare-CDN-Cache-Control")).toBeNull();
    expect(response.headers.get("Cache-Tag")).toBe("%2Fdynamic-html");
    await expect(response.text()).resolves.toBe("<h1>personalized</h1>");
    await Promise.all(pendingCacheWrites);
    expect(isrSet).not.toHaveBeenCalled();
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

  it("clears Cloudflare cache overrides for mounted slots", async () => {
    setCdnCacheAdapter(new CloudflareCdnCacheAdapter());

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
    setCdnCacheAdapter(new CloudflareCdnCacheAdapter());

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

  it("applies the Cloudflare pending edge policy in a separate adapter case", async () => {
    setCdnCacheAdapter(new CloudflareCdnCacheAdapter());
    const response = finalizePendingDynamicRscResponse();

    expect(response.headers.get("Cache-Control")).toBe("public, max-age=0, must-revalidate");
    expect(response.headers.get("CDN-Cache-Control")).toBe("public, max-age=60");
    expect(response.headers.get("Cloudflare-CDN-Cache-Control")).toBeNull();
    expect(response.headers.get("Cache-Tag")).toBe("%2Fdashboard");
    expect(response.headers.get("X-Vinext-Cache")).toBe("MISS");
    await expect(response.text()).resolves.toBe("pending-dynamic-flight");
  });

  it("revalidateTag purges the Workers Cache by tag via ctx.cache.purge", async () => {
    const purge = vi.fn(async (_options: { tags: string[] }) => ({ success: true }));
    await runWithExecutionContext({ waitUntil() {}, cache: { purge } }, async () => {
      await adapter.revalidateTag(["posts", "_N_T_/blog"]);
    });
    expect(purge).toHaveBeenCalledWith({
      tags: ["posts", "_N_T_%2Fblog"],
    });
  });

  it("revalidateTag normalizes a single tag to an array", async () => {
    const purge = vi.fn(async () => ({ success: true }));
    await runWithExecutionContext({ waitUntil() {}, cache: { purge } }, async () => {
      await adapter.revalidateTag("posts");
    });
    expect(purge).toHaveBeenCalledWith({
      tags: ["posts"],
    });
  });

  it("keeps unrelated page families out of a targeted revalidation", async () => {
    const blogTags = adapter
      .buildResponseHeaders({
        cacheControl: "s-maxage=60",
        tags: ["/blog", "_N_T_/blog", "posts"],
      })
      ["Cache-Tag"]!.split(",");
    const shopTags = adapter
      .buildResponseHeaders({
        cacheControl: "s-maxage=60",
        tags: ["/shop", "_N_T_/shop", "catalog"],
      })
      ["Cache-Tag"]!.split(",");
    const purge = vi.fn(async (_options: { tags: string[] }) => ({ success: true }));

    await runWithExecutionContext({ waitUntil() {}, cache: { purge } }, async () => {
      await adapter.revalidateTag(["posts", "_N_T_/blog"]);
    });

    const purgedTags = purge.mock.calls[0]![0].tags;
    expect(blogTags.some((tag) => purgedTags.includes(tag))).toBe(true);
    expect(shopTags.some((tag) => purgedTags.includes(tag))).toBe(false);
  });

  it("revalidateTag is a no-op when the Workers Cache is absent (e.g. Node dev)", async () => {
    // No runWithExecutionContext scope → getRequestExecutionContext() is null.
    await expect(adapter.revalidateTag("posts")).resolves.toBeUndefined();
  });

  it("revalidateTag does not purge for an empty tag set", async () => {
    const purge = vi.fn(async () => ({ success: true }));
    await runWithExecutionContext({ waitUntil() {}, cache: { purge } }, async () => {
      await adapter.revalidateTag([]);
    });
    expect(purge).not.toHaveBeenCalled();
  });

  it("uses the same encoded and de-duplicated tags for purge as for cache writes", async () => {
    const purge = vi.fn(async () => ({ success: true }));
    await runWithExecutionContext({ waitUntil() {}, cache: { purge } }, async () => {
      await adapter.revalidateTag(["a,b", "A,B", "posts", "POSTS"]);
    });
    expect(purge).toHaveBeenCalledWith({
      tags: ["a%2Cb", "posts"],
    });
  });

  it("throws when a purge result reports failure", async () => {
    const purge = vi.fn(async () => ({ success: false }));
    await runWithExecutionContext({ waitUntil() {}, cache: { purge } }, async () => {
      await expect(adapter.revalidateTag("posts")).rejects.toThrow(
        "Cloudflare cache tag purge failed",
      );
    });
  });

  it("rejects an unrepresentable purge without dropping tags", async () => {
    const purge = vi.fn(async () => ({ success: true }));
    await runWithExecutionContext({ waitUntil() {}, cache: { purge } }, async () => {
      await expect(adapter.revalidateTag("x".repeat(2000))).rejects.toThrow(
        "cannot represent the complete cache tag set",
      );
    });
    expect(purge).not.toHaveBeenCalled();
  });

  it("rejects more than 1000 distinct purge tags after provider de-duplication", async () => {
    const purge = vi.fn(async () => ({ success: true }));
    const tags = Array.from({ length: 1001 }, (_, index) => `t${index}`);
    tags.push("T0");
    await runWithExecutionContext({ waitUntil() {}, cache: { purge } }, async () => {
      // Provider identity is case-insensitive, but 1001 unique tags remain
      // after the duplicate spelling is removed.
      await expect(adapter.revalidateTag(tags)).rejects.toThrow(
        "cannot represent the complete cache tag set",
      );
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
