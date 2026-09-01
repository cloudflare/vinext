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
import createCloudflareCdnCacheAdapter, {
  CloudflareCdnCacheAdapter,
} from "../packages/cloudflare/src/cache/cdn-adapter.runtime.js";
import {
  getCdnCacheAdapter,
  setCdnCacheAdapter,
  DefaultCdnCacheAdapter,
} from "../packages/vinext/src/shims/cdn-cache.js";
import { runWithExecutionContext } from "../packages/vinext/src/shims/request-context.js";
import {
  finalizeAppPageHtmlCacheResponse,
  finalizeAppPageRscCacheResponse,
} from "../packages/vinext/src/server/app-page-cache-finalizer.js";
import { finalizeAppRscResponse } from "../packages/vinext/src/server/app-rsc-response-finalizer.js";
import { applyCdnResponseIdentityHeaders } from "../packages/vinext/src/server/cache-control.js";
import type { RequestContext } from "../packages/vinext/src/config/request-context.js";
import { VINEXT_CDN_BUILD_ID_HEADER } from "../packages/cloudflare/src/cache/cdn-build-id.js";
import { VINEXT_EXPECTED_WORKER_VERSION_HEADER } from "../packages/cloudflare/src/version-headers.js";

const CDN_KEY = Symbol.for("vinext.cdnCacheAdapter");

function resetActiveAdapter(): void {
  delete (globalThis as Record<PropertyKey, unknown>)[CDN_KEY];
}

function makeRequestContext(): RequestContext {
  return {
    headers: new Headers(),
    cookies: {},
    query: new URLSearchParams(),
    host: "example.com",
  };
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
afterEach(() => {
  resetActiveAdapter();
  vi.unstubAllEnvs();
});

// ─── Adapter behavior ────────────────────────────────────────────────────

describe("CloudflareCdnCacheAdapter", () => {
  const adapter = new CloudflareCdnCacheAdapter();

  it("does not own background revalidation (the edge re-requests origin)", () => {
    expect(adapter.ownsBackgroundRevalidation).toBe(false);
  });

  it("accepts a staged warmup only in its expected Worker version", async () => {
    const routedAdapter = createCloudflareCdnCacheAdapter({
      env: { CF_VERSION_METADATA: { id: "version-b", tag: "", timestamp: "" } },
    });
    const matching = new Request("https://example.com/page", {
      headers: {
        "Cloudflare-Workers-Version-Overrides": 'upstream="version-a", app="version-b"',
        [VINEXT_EXPECTED_WORKER_VERSION_HEADER]: "version-b",
      },
    });
    const mismatching = new Request("https://example.com/page", {
      headers: {
        "Cloudflare-Workers-Version-Overrides": 'app="version-c"',
        [VINEXT_EXPECTED_WORKER_VERSION_HEADER]: "version-c",
      },
    });

    expect(await routedAdapter.validateRequest?.(matching)).toBeNull();
    const response = await routedAdapter.validateRequest?.(mismatching);
    expect(response?.status).toBe(503);
    expect(response?.headers.get("Content-Type")).toContain("application/json");
    expect(response?.headers.get("Cache-Control")).toBe("no-store");
    await expect(response?.text()).resolves.toContain(
      "Cloudflare invoked Worker version version-b, but vinext warmup expected version-c",
    );
  });

  it("ignores version overrides that are not vinext staged warmup assertions", async () => {
    const routedAdapter = createCloudflareCdnCacheAdapter({
      env: { CF_VERSION_METADATA: { id: "version-a", tag: "", timestamp: "" } },
    });
    const downstreamOnly = new Request("https://example.com/page", {
      headers: {
        "Cloudflare-Workers-Version-Overrides": 'downstream="version-b"',
      },
    });

    expect(await routedAdapter.validateRequest?.(downstreamOnly)).toBeNull();
  });

  it("rejects a vinext version assertion without a Cloudflare version override", async () => {
    const routedAdapter = createCloudflareCdnCacheAdapter({
      env: { CF_VERSION_METADATA: { id: "version-a", tag: "", timestamp: "" } },
    });
    const request = new Request("https://example.com/page", {
      headers: { [VINEXT_EXPECTED_WORKER_VERSION_HEADER]: "version-a" },
    });

    const response = await routedAdapter.validateRequest?.(request);
    expect(response?.status).toBe(500);
    expect(response?.headers.get("Content-Type")).toContain("application/json");
    await expect(response?.text()).resolves.toContain(
      `received ${VINEXT_EXPECTED_WORKER_VERSION_HEADER} without Cloudflare-Workers-Version-Overrides`,
    );
  });

  it("fails an override loudly when its configured version metadata binding is missing", async () => {
    const routedAdapter = createCloudflareCdnCacheAdapter({
      env: {},
      options: { versionMetadataBinding: "CUSTOM_VERSION" },
    });
    const request = new Request("https://example.com/page", {
      headers: {
        "Cloudflare-Workers-Version-Overrides": 'app="version-b"',
        [VINEXT_EXPECTED_WORKER_VERSION_HEADER]: "version-b",
      },
    });

    const response = await routedAdapter.validateRequest?.(request);
    expect(response?.status).toBe(500);
    expect(response?.headers.get("Content-Type")).toContain("application/json");
    const body = (await response?.json()) as { error: string };
    expect(body.error).toContain("requires the `CUSTOM_VERSION` version metadata binding");
    expect(body.error).toContain("Named environments do not inherit this binding");
  });

  it("does not require version metadata for ordinary requests without an override", async () => {
    const routedAdapter = createCloudflareCdnCacheAdapter();
    expect(
      await routedAdapter.validateRequest?.(new Request("https://example.com/page")),
    ).toBeNull();
  });

  it("stamps the application build identity on cacheable and no-store responses", () => {
    vi.stubEnv("__VINEXT_BUILD_ID", "pinned-build");
    vi.stubEnv("__VINEXT_RSC_BUILD_IDENTITY", "instance-a");

    expect(adapter.buildResponseHeaders({ cacheControl: "s-maxage=60" })).toMatchObject({
      [VINEXT_CDN_BUILD_ID_HEADER]: "instance-a",
    });
    expect(adapter.buildResponseHeaders({ cacheControl: "no-store" })).toMatchObject({
      [VINEXT_CDN_BUILD_ID_HEADER]: "instance-a",
    });
  });

  it("stamps build identity at the outer response boundary, including redirects", () => {
    vi.stubEnv("__VINEXT_BUILD_ID", "build-a");
    setCdnCacheAdapter(adapter);

    const response = applyCdnResponseIdentityHeaders(
      Response.redirect("https://example.com/target", 307),
      new Request("https://example.com/source", { headers: { Accept: "text/html" } }),
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("https://example.com/target");
    expect(response.headers.get(VINEXT_CDN_BUILD_ID_HEADER)).toBe("build-a");

    const pagesData = applyCdnResponseIdentityHeaders(
      Response.json({ pageProps: {} }),
      new Request("https://example.com/_next/data/build-a/source.json", {
        headers: { Accept: "application/json" },
      }),
    );
    expect(pagesData.headers.get(VINEXT_CDN_BUILD_ID_HEADER)).toBe("build-a");
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
      "Cloudflare-CDN-Cache-Control": null,
      "Cache-Tag": null,
    });
  });

  it("fails closed while an App Page render still has a pending dynamic check", () => {
    const headers = adapter.buildResponseHeaders({
      cacheControl: "s-maxage=60, stale-while-revalidate=540",
      pendingDynamicCheck: true,
    });
    expect(headers).toEqual({
      "Cache-Control": "no-store",
      "CDN-Cache-Control": null,
      "Cloudflare-CDN-Cache-Control": null,
      "Cache-Tag": null,
    });
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

  it("returns no-store and clears owned headers when there is no cacheable policy", () => {
    expect(adapter.buildResponseHeaders({ cacheControl: "" })).toEqual({
      "Cache-Control": "no-store",
      "CDN-Cache-Control": null,
      "Cloudflare-CDN-Cache-Control": null,
      "Cache-Tag": null,
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
      expect(headers).toEqual({
        "Cache-Control": cc,
        "CDN-Cache-Control": null,
        "Cloudflare-CDN-Cache-Control": null,
        "Cache-Tag": null,
      });
    }
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

  it("preserves mixed-case generic opt-outs during final response normalization", async () => {
    setCdnCacheAdapter(adapter);
    const response = new Response("body", { headers: { "Cache-Control": "No-Cache" } });

    await finalizeAppRscResponse(response, new Request("https://example.com/page"), {
      basePath: "",
      configHeaders: [],
      i18nConfig: null,
      requestContext: makeRequestContext(),
    });

    expect(response.headers.get("Cache-Control")).toBe("No-Cache");
    expect(response.headers.get("CDN-Cache-Control")).toBeNull();
  });

  it("does not promote an adapter opt-out when Cache-Control has a similar extension", async () => {
    setCdnCacheAdapter(adapter);
    const response = new Response("body", {
      headers: {
        "Cache-Control": "xprivate=1, s-maxage=60",
        "CDN-Cache-Control": "no-store",
      },
    });

    await finalizeAppRscResponse(response, new Request("https://example.com/page"), {
      basePath: "",
      configHeaders: [],
      i18nConfig: null,
      requestContext: makeRequestContext(),
    });

    expect(response.headers.get("Cache-Control")).toBe("no-store, must-revalidate");
    expect(response.headers.get("CDN-Cache-Control")).toBeNull();
  });

  it("keeps pending HTML private and skips a late-dynamic cache write", async () => {
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

    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("CDN-Cache-Control")).toBeNull();
    expect(response.headers.get("Cloudflare-CDN-Cache-Control")).toBeNull();
    expect(response.headers.get("Cache-Tag")).toBeNull();
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

  it("keeps a pending RSC response out of the Cloudflare edge cache", async () => {
    setCdnCacheAdapter(new CloudflareCdnCacheAdapter());
    const response = finalizePendingDynamicRscResponse();

    expect(response.headers.get("Cache-Control")).toBe("no-store");
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
