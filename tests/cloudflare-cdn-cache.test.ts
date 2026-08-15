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
    expect(response.headers.get("Cache-Tag")).toBe("/dynamic-html");
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
    expect(response.headers.get("Cache-Tag")).toBe("/dashboard");
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
