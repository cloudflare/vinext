/**
 * CloudflareCdnCacheAdapter tests.
 *
 * Covers two-stage admission through the data cache and Workers Cache:
 *  - get/set delegate to the durable admission store
 *  - fresh streams remain private until a later admitted cache hit
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
import { revalidatePath, revalidateTag } from "../packages/vinext/src/shims/cache.js";
import {
  MemoryCacheHandler,
  NoOpCacheHandler,
  setDataCacheHandler,
  type CacheControlMetadata,
  type CacheHandler,
  type CacheHandlerContext,
  type CacheHandlerValue,
} from "../packages/vinext/src/shims/cache-handler.js";
import {
  isrGet,
  isrSet,
  type AppPageCacheSetter,
} from "../packages/vinext/src/server/isr-cache.js";
import {
  finalizeAppPageHtmlCacheResponse,
  finalizeAppPageRscCacheResponse,
} from "../packages/vinext/src/server/app-page-cache-finalizer.js";
import {
  buildAppPageCachedResponse,
  buildAppPageCacheTags,
  readAppPageCacheResponse,
} from "../packages/vinext/src/server/app-page-cache.js";

const CDN_KEY = Symbol.for("vinext.cdnCacheAdapter");
function resetActiveAdapter(): void {
  delete (globalThis as Record<PropertyKey, unknown>)[CDN_KEY];
}

function createDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

function createContractCacheHandler(): {
  handler: CacheHandler;
  invalidatedTags: string[];
} {
  const entries = new Map<string, CacheHandlerValue>();
  const invalidatedTags: string[] = [];
  const handler: CacheHandler = {
    async get(key) {
      return entries.get(key) ?? null;
    },
    async set(key, value, ctx?: CacheHandlerContext) {
      const metadata = {
        lastModified: Date.now(),
        cacheControl: ctx?.cacheControl as CacheControlMetadata | undefined,
        tags: [...(ctx?.tags ?? [])],
      };
      entries.set(
        key,
        value?.kind === "APP_PAGE" ? { ...metadata, value } : { ...metadata, value },
      );
    },
    async revalidateTag(tags) {
      const requestedTags = Array.isArray(tags) ? tags : [tags];
      invalidatedTags.push(...requestedTags);
      for (const [key, entry] of entries) {
        if (requestedTags.some((tag) => entry.tags?.includes(tag))) {
          entries.delete(key);
        }
      }
    },
  };
  return { handler, invalidatedTags };
}

async function finalizePendingDynamicRscResponse(): Promise<Response> {
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

beforeEach(() => {
  resetActiveAdapter();
  setDataCacheHandler(new MemoryCacheHandler());
});
afterEach(() => {
  resetActiveAdapter();
  vi.restoreAllMocks();
});

// ─── Adapter behavior ────────────────────────────────────────────────────

describe("CloudflareCdnCacheAdapter", () => {
  const adapter = new CloudflareCdnCacheAdapter();

  it("owns admission-store regeneration", () => {
    expect(adapter.ownsBackgroundRevalidation).toBe(true);
  });

  it("persists and reads completed admission artifacts", async () => {
    setCdnCacheAdapter(adapter);
    const durableStore = new MemoryCacheHandler();
    setDataCacheHandler({
      get: durableStore.get.bind(durableStore),
      set: durableStore.set.bind(durableStore),
      revalidateTag: durableStore.revalidateTag.bind(durableStore),
    });
    const value = {
      kind: "APP_PAGE" as const,
      headers: undefined,
      html: "<h1>admitted</h1>",
      postponed: undefined,
      rscData: undefined,
      status: 200,
    };
    await adapter.set("k", value, {
      cacheControl: { revalidate: 60 },
      revalidate: 60,
      tags: ["/admitted"],
    });

    const admitted = await adapter.get("k");
    expect(admitted).toEqual(
      expect.objectContaining({
        cacheControl: { revalidate: 60 },
        value,
      }),
    );
    expect(admitted?.tags).toEqual(["/admitted"]);
    expect(admitted?.value?.kind).toBe("APP_PAGE");
    if (admitted?.value?.kind !== "APP_PAGE") throw new Error("Expected admitted App page");

    const promotedOptions = {
      cacheControl: admitted.cacheControl,
      cacheState: "HIT",
      isRscRequest: false,
      revalidateSeconds: 60,
      tags: admitted.tags,
    } as const;
    const promoted = buildAppPageCachedResponse(admitted.value, promotedOptions);
    expect(await promoted?.text()).toBe("<h1>admitted</h1>");
    expect(promoted?.headers.get("CDN-Cache-Control")).toBe(
      "public, max-age=60, stale-while-revalidate=31536000",
    );
    expect(promoted?.headers.get("Cache-Tag")).toBe("/admitted");
  });

  it("promotes and invalidates artifacts from a conforming custom cache handler", async () => {
    const { handler, invalidatedTags } = createContractCacheHandler();
    const purge = vi.fn(async () => {});
    const pendingInvalidations: Promise<unknown>[] = [];
    setDataCacheHandler(handler);
    setCdnCacheAdapter(adapter);
    const cacheKey = "html:/custom";
    const cacheTags = buildAppPageCacheTags("/custom", ["post:custom"]);
    const value = {
      kind: "APP_PAGE" as const,
      headers: undefined,
      html: "<h1>custom adapter</h1>",
      postponed: undefined,
      rscData: undefined,
      status: 200,
    };

    const seed = () =>
      isrSet(cacheKey, value, {
        cacheControl: { revalidate: 60 },
        tags: cacheTags,
      });
    await seed();

    const promoted = await readAppPageCacheResponse({
      cleanPathname: "/custom",
      clearRequestContext: vi.fn(),
      isRscRequest: false,
      isrGet,
      isrHtmlKey: () => cacheKey,
      isrRscKey: (pathname) => `rsc:${pathname}`,
      isrSet,
      revalidateSeconds: 60,
      renderFreshPageForCache: vi.fn(),
      scheduleBackgroundRegeneration: vi.fn(),
    });

    expect(await promoted?.text()).toBe("<h1>custom adapter</h1>");
    expect(promoted?.headers.get("CDN-Cache-Control")).toBe(
      "public, max-age=60, stale-while-revalidate=31536000",
    );
    expect(promoted?.headers.get("Cache-Tag")?.split(",")).toEqual(cacheTags);

    await runWithExecutionContext(
      {
        waitUntil(promise) {
          pendingInvalidations.push(promise);
        },
        cache: { purge },
      },
      async () => {
        revalidateTag("post:custom");
        await Promise.all(pendingInvalidations.splice(0));
        await expect(adapter.get(cacheKey)).resolves.toBeNull();

        await seed();
        revalidatePath("/custom");
        await Promise.all(pendingInvalidations.splice(0));
        await expect(adapter.get(cacheKey)).resolves.toBeNull();
      },
    );

    expect(invalidatedTags).toEqual(["post:custom", "_N_T_/custom"]);
    expect(purge).toHaveBeenNthCalledWith(1, { tags: ["post:custom"] });
    expect(purge).toHaveBeenNthCalledWith(2, { tags: ["_N_T_/custom"] });
  });

  it("cannot promote when the configured admission store is non-durable", async () => {
    setDataCacheHandler(new NoOpCacheHandler());
    const value = {
      kind: "APP_PAGE" as const,
      headers: undefined,
      html: "<h1>not admitted</h1>",
      postponed: undefined,
      rscData: undefined,
      status: 200,
    };

    await adapter.set("missing", value, {
      cacheControl: { revalidate: 60 },
      tags: ["/missing"],
    });

    await expect(adapter.get("missing")).resolves.toBeNull();
    expect(
      adapter.buildResponseHeaders({
        cacheControl: "s-maxage=60",
        pendingDynamicCheck: true,
        tags: ["/missing"],
      }),
    ).toEqual({
      "Cache-Control": "no-store",
      "CDN-Cache-Control": null,
      "Cloudflare-CDN-Cache-Control": null,
      "Cache-Tag": null,
    });
  });

  it("does not treat the process-local fallback as durable admission", async () => {
    setDataCacheHandler(new MemoryCacheHandler());
    await adapter.set(
      "memory-only",
      {
        kind: "APP_PAGE",
        headers: undefined,
        html: "<h1>ephemeral</h1>",
        postponed: undefined,
        rscData: undefined,
        status: 200,
      },
      { cacheControl: { revalidate: 60 } },
    );

    await expect(adapter.get("memory-only")).resolves.toBeNull();
  });

  it("lets middleware veto promotion of an admitted artifact", () => {
    setCdnCacheAdapter(adapter);
    const responseOptions = {
      cacheControl: { revalidate: 60 },
      cacheState: "HIT",
      isRscRequest: false,
      middlewareHeaders: new Headers({ "Cache-Control": "private, no-store" }),
      revalidateSeconds: 60,
      tags: ["/private"],
    } as const;
    const response = buildAppPageCachedResponse(
      {
        kind: "APP_PAGE",
        headers: undefined,
        html: "<h1>private</h1>",
        postponed: undefined,
        rscData: undefined,
        status: 200,
      },
      responseOptions,
    );

    expect(response?.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response?.headers.get("CDN-Cache-Control")).toBeNull();
    expect(response?.headers.get("Cache-Tag")).toBeNull();
  });

  it("applies a cacheable middleware override only during later promotion", () => {
    setCdnCacheAdapter(adapter);
    const responseOptions = {
      cacheControl: { revalidate: 60 },
      cacheState: "HIT",
      isRscRequest: false,
      middlewareHeaders: new Headers({
        "Cache-Control": "s-maxage=5, stale-while-revalidate=55",
      }),
      revalidateSeconds: 60,
      tags: ["/overridden"],
    } as const;
    const response = buildAppPageCachedResponse(
      {
        kind: "APP_PAGE",
        headers: undefined,
        html: "<h1>overridden</h1>",
        postponed: undefined,
        rscData: undefined,
        status: 200,
      },
      responseOptions,
    );

    expect(response?.headers.get("CDN-Cache-Control")).toBe(
      "public, max-age=5, stale-while-revalidate=55",
    );
    expect(response?.headers.get("Cache-Tag")).toBe("/overridden");
  });

  it("preserves cacheable middleware provider-header overrides during promotion", () => {
    setCdnCacheAdapter(adapter);
    const response = buildAppPageCachedResponse(
      {
        kind: "APP_PAGE",
        headers: undefined,
        html: "<h1>provider override</h1>",
        postponed: undefined,
        rscData: undefined,
        status: 200,
      },
      {
        cacheControl: { revalidate: 60 },
        cacheState: "HIT",
        isRscRequest: false,
        middlewareHeaders: new Headers({
          "Cache-Tag": "middleware-tag",
          "CDN-Cache-Control": "public, max-age=7",
          "Cloudflare-CDN-Cache-Control": "public, max-age=9",
        }),
        revalidateSeconds: 60,
        tags: ["/stored-tag"],
      },
    );

    expect(response?.headers.get("CDN-Cache-Control")).toBe("public, max-age=7");
    expect(response?.headers.get("Cloudflare-CDN-Cache-Control")).toBe("public, max-age=9");
    expect(response?.headers.get("Cache-Tag")).toBe("middleware-tag");
  });

  it("does not restore cacheable middleware provider headers on stale artifacts", () => {
    setCdnCacheAdapter(adapter);
    const response = buildAppPageCachedResponse(
      {
        kind: "APP_PAGE",
        headers: undefined,
        html: "<h1>stale provider override</h1>",
        postponed: undefined,
        rscData: undefined,
        status: 200,
      },
      {
        cacheControl: { revalidate: 60 },
        cacheState: "STALE",
        isRscRequest: false,
        middlewareHeaders: new Headers({
          "Cache-Tag": "middleware-tag",
          "CDN-Cache-Control": "public, max-age=7",
        }),
        revalidateSeconds: 60,
        tags: ["/stored-tag"],
      },
    );

    expect(response?.headers.get("Cache-Control")).toBe("no-store");
    expect(response?.headers.get("CDN-Cache-Control")).toBeNull();
    expect(response?.headers.get("Cache-Tag")).toBeNull();
  });

  it("keeps pending streams private and clears every owned edge header", () => {
    expect(
      adapter.buildResponseHeaders({
        cacheControl: "s-maxage=60",
        pendingDynamicCheck: true,
        tags: ["/private-first"],
      }),
    ).toEqual({
      "Cache-Control": "no-store",
      "CDN-Cache-Control": null,
      "Cloudflare-CDN-Cache-Control": null,
      "Cache-Tag": null,
    });
  });

  it("keeps stale admission artifacts out of the edge until regeneration", () => {
    setCdnCacheAdapter(adapter);
    const response = buildAppPageCachedResponse(
      {
        kind: "APP_PAGE",
        headers: undefined,
        html: "<h1>stale</h1>",
        postponed: undefined,
        rscData: undefined,
        status: 200,
      },
      {
        cacheControl: { revalidate: 60, expire: 600 },
        cacheState: "STALE",
        isRscRequest: false,
        revalidateSeconds: 60,
      },
    );

    expect(response?.headers.get("Cache-Control")).toBe("no-store");
    expect(response?.headers.get("CDN-Cache-Control")).toBeNull();
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
      tags: ["a,b", "line\nbreak", "😀".repeat(300), "x".repeat(2000), "ok"],
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

  it("treats mixed-case non-cacheable directives as an edge-cache veto", () => {
    expect(adapter.buildResponseHeaders({ cacheControl: "Private, No-Store" })).toEqual({
      "Cache-Control": "Private, No-Store",
      "CDN-Cache-Control": null,
      "Cloudflare-CDN-Cache-Control": null,
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

  it("replaces provisional Cloudflare headers after a late-dynamic HTML render", async () => {
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

  it("fails closed when an RSC response has no static proof", async () => {
    setCdnCacheAdapter(new CloudflareCdnCacheAdapter());
    const response = await finalizePendingDynamicRscResponse();

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

// ─── Shared-cache safety for streamed App Router renders ─────────────────

/**
 * An App Router page can only be proven non-dynamic after its stream drains: a
 * Suspended server component may read cookies()/headers() long after the shell
 * has flushed. A header already sent cannot be taken back, so the first stream
 * remains private while its cache branch attempts durable admission.
 *
 * The behaviour under test is therefore the response contract: a render that
 * turns out dynamic must never leave the origin advertising itself as
 * edge-cacheable, because the edge keys on URL and would replay one user's
 * personalized HTML to the next.
 */
describe("streamed App Router responses under the Cloudflare CDN adapter", () => {
  let pendingCacheWrites: Promise<void>[] = [];

  function finalize(options: {
    dynamicUsed: boolean;
    /** A `cacheLife()` resolved while the stream was still draining. */
    lateCacheLife?: { revalidate?: number; expire?: number };
    /**
     * Simulates middleware overriding the provisional policy: the merge stamps
     * its value on the response, and the render lifecycle threads the same
     * value to the finalizer (middleware owns Cache-Control).
     */
    middlewareCacheControl?: string;
  }): Promise<Response> {
    return Promise.resolve(
      finalizeAppPageHtmlCacheResponse(
        new Response("<h1>user=alice</h1>", {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            // The provisional ISR policy, computed before the stream drained.
            "Cache-Control":
              options.middlewareCacheControl ?? "s-maxage=60, stale-while-revalidate=540",
          },
        }),
        {
          capturedRscDataPromise: null,
          cleanPathname: "/account",
          // Both resolve only once the stream has been consumed.
          consumeDynamicUsage: () => options.dynamicUsed,
          getRequestCacheLife: () => options.lateCacheLife ?? null,
          getPageTags: () => ["/account"],
          isrHtmlKey: (pathname) => `html:${pathname}`,
          isrRscKey: (pathname) => `rsc:${pathname}`,
          async isrSet() {},
          revalidateSeconds: 60,
          expireSeconds: 600,
          linkHeader: null,
          waitUntil(promise) {
            pendingCacheWrites.push(promise);
          },
        },
      ),
    );
  }

  function finalizeRsc(options: {
    dynamicUsed?: boolean;
    getPageTags?: () => string[];
    isrSet?: AppPageCacheSetter;
  }): Promise<Response> {
    return Promise.resolve(
      finalizeAppPageRscCacheResponse(
        new Response("user=alice", {
          headers: {
            "Cache-Control": "s-maxage=60, stale-while-revalidate=540",
            "CDN-Cache-Control": "public, max-age=6000",
            "Cache-Tag": "stale",
            "Content-Type": "text/x-component",
            "X-Vinext-Cache": "MISS",
          },
        }),
        {
          capturedRscDataPromise: Promise.resolve(new TextEncoder().encode("user=alice").buffer),
          cleanPathname: "/account",
          consumeDynamicUsage: () => options.dynamicUsed ?? false,
          dynamicUsedDuringBuild: false,
          expireSeconds: 600,
          getPageTags: options.getPageTags ?? (() => ["/account"]),
          isrRscKey: (pathname) => `rsc:${pathname}`,
          isrSet: options.isrSet ?? (async () => {}),
          revalidateSeconds: 60,
          waitUntil(promise) {
            pendingCacheWrites.push(promise);
          },
        },
      ),
    );
  }

  beforeEach(() => {
    pendingCacheWrites = [];
    setCdnCacheAdapter(new CloudflareCdnCacheAdapter());
  });

  it("delivers the first HTML bytes before admission completes", async () => {
    const releaseCompletion = createDeferred();
    let sentTail = false;
    const response = finalizeAppPageHtmlCacheResponse(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("<html><shell>"));
          },
          async pull(controller) {
            if (sentTail) return;
            sentTail = true;
            await releaseCompletion.promise;
            controller.enqueue(new TextEncoder().encode("<page></html>"));
            controller.close();
          },
        }),
        { headers: { "Cache-Control": "s-maxage=60" } },
      ),
      {
        capturedRscDataPromise: null,
        cleanPathname: "/slow-static",
        consumeDynamicUsage: () => false,
        getPageTags: () => ["/slow-static"],
        isrHtmlKey: (pathname) => `html:${pathname}`,
        isrRscKey: (pathname) => `rsc:${pathname}`,
        async isrSet() {},
        linkHeader: null,
        revalidateSeconds: 60,
        waitUntil(promise) {
          pendingCacheWrites.push(promise);
        },
      },
    );

    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("CDN-Cache-Control")).toBeNull();
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    const first = await reader!.read();
    expect(new TextDecoder().decode(first.value)).toBe("<html><shell>");
    expect(first.done).toBe(false);

    releaseCompletion.resolve();
    const tail = await reader!.read();
    expect(new TextDecoder().decode(tail.value)).toBe("<page></html>");
    expect((await reader!.read()).done).toBe(true);
    await Promise.all(pendingCacheWrites);
  });

  it("delivers the first RSC bytes before admission completes", async () => {
    const releaseCompletion = createDeferred();
    let sentTail = false;
    const response = finalizeAppPageRscCacheResponse(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("shell"));
          },
          async pull(controller) {
            if (sentTail) return;
            sentTail = true;
            await releaseCompletion.promise;
            controller.enqueue(new TextEncoder().encode("-flight"));
            controller.close();
          },
        }),
        { headers: { "Cache-Control": "s-maxage=60" } },
      ),
      {
        capturedRscDataPromise: releaseCompletion.promise.then(
          () => new TextEncoder().encode("shell-flight").buffer,
        ),
        cleanPathname: "/slow-static",
        consumeDynamicUsage: () => false,
        dynamicUsedDuringBuild: false,
        getPageTags: () => ["/slow-static"],
        isrRscKey: (pathname) => `rsc:${pathname}`,
        async isrSet() {},
        preserveClientResponseHeaders: false,
        revalidateSeconds: 60,
        waitUntil(promise) {
          pendingCacheWrites.push(promise);
        },
      },
    );

    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("CDN-Cache-Control")).toBeNull();
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    const first = await reader!.read();
    expect(new TextDecoder().decode(first.value)).toBe("shell");
    expect(first.done).toBe(false);

    releaseCompletion.resolve();
    const tail = await reader!.read();
    expect(new TextDecoder().decode(tail.value)).toBe("-flight");
    expect((await reader!.read()).done).toBe(true);
    await Promise.all(pendingCacheWrites);
  });

  it("does not advertise a late-dynamic render as edge-cacheable", async () => {
    const response = await finalize({ dynamicUsed: true });

    // Nothing shared may store this: it contains one user's session data.
    expect(response.headers.get("CDN-Cache-Control")).toBeNull();
    expect(response.headers.get("Cloudflare-CDN-Cache-Control")).toBeNull();
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    // The body is still delivered to the user who requested it.
    await expect(response.text()).resolves.toBe("<h1>user=alice</h1>");
  });

  it("keeps the first static render private while admitting its artifact", async () => {
    const response = await finalize({ dynamicUsed: false });

    expect(response.headers.get("CDN-Cache-Control")).toBeNull();
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.text()).resolves.toBe("<h1>user=alice</h1>");
    await Promise.all(pendingCacheWrites);
  });

  it("does not advertise a late-resolved lifetime on the first response", async () => {
    // The route declared 60s, but a cacheLife() during the stream tightened it
    // to 10s. Advertising 60s would let the edge serve stale bytes 50s longer
    // than the page asked for.
    const response = await finalize({
      dynamicUsed: false,
      lateCacheLife: { revalidate: 10, expire: 100 },
    });

    expect(response.headers.get("CDN-Cache-Control")).toBeNull();
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await response.text();
    await Promise.all(pendingCacheWrites);
  });

  it("keeps a middleware no-store even when the render proves static", async () => {
    // Middleware owns Cache-Control (mergeMiddlewareResponseHeaders). A page it
    // marked non-cacheable must not be promoted to the shared edge cache just
    // because the render itself never touched a request API.
    const response = await finalize({ dynamicUsed: false, middlewareCacheControl: "no-store" });

    expect(response.headers.get("CDN-Cache-Control")).toBeNull();
    expect(response.headers.get("Cloudflare-CDN-Cache-Control")).toBeNull();
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.text()).resolves.toBe("<h1>user=alice</h1>");
  });

  it("demotes a middleware private policy to the private-first admission policy", async () => {
    const response = await finalize({
      dynamicUsed: true,
      middlewareCacheControl: "private, max-age=30",
    });

    expect(response.headers.get("CDN-Cache-Control")).toBeNull();
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("does not advertise a cacheable middleware override on the first response", async () => {
    const response = await finalize({
      dynamicUsed: false,
      middlewareCacheControl: "s-maxage=5, stale-while-revalidate=55",
    });

    expect(response.headers.get("CDN-Cache-Control")).toBeNull();
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("does not advertise a policy the render dropped mid-stream", async () => {
    // revalidate = 0 means "never cache". The origin already skips its write;
    // the edge must not be told to store the page either.
    const response = await finalize({ dynamicUsed: false, lateCacheLife: { revalidate: 0 } });

    expect(response.headers.get("CDN-Cache-Control")).toBeNull();
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("keeps the first RSC response private while admitting it", async () => {
    const getPageTags = vi.fn(() => ["/account"]);
    const response = await finalizeRsc({ getPageTags });

    expect(response.headers.get("CDN-Cache-Control")).toBeNull();
    expect(response.headers.get("Cache-Tag")).toBeNull();
    expect(getPageTags).toHaveBeenCalledTimes(1);
    await expect(response.text()).resolves.toBe("user=alice");
    await Promise.all(pendingCacheWrites);
  });

  it("isolates proven RSC tags from cache-writer mutation", async () => {
    const response = await finalizeRsc({
      async isrSet(_key, _data, policy) {
        policy.tags?.splice(0);
      },
    });

    expect(response.headers.get("Cache-Tag")).toBeNull();
    await response.text();
    await Promise.all(pendingCacheWrites);
  });

  it("removes provisional RSC cache headers after late dynamic usage", async () => {
    const isrSet = vi.fn(async () => {});
    const response = await finalizeRsc({ dynamicUsed: true, isrSet });

    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("CDN-Cache-Control")).toBeNull();
    expect(response.headers.get("Cache-Tag")).toBeNull();
    expect(isrSet).not.toHaveBeenCalled();
    await expect(response.text()).resolves.toBe("user=alice");
    await Promise.all(pendingCacheWrites);
  });

  it("fails closed when the RSC cache write rejects", async () => {
    const cacheError = new Error("cache unavailable");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await finalizeRsc({
      isrSet: async () => {
        throw cacheError;
      },
    });

    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("CDN-Cache-Control")).toBeNull();
    expect(response.headers.get("Cache-Tag")).toBeNull();
    await response.text();
    await Promise.all(pendingCacheWrites);
    expect(consoleError).toHaveBeenCalledWith("[vinext] ISR RSC cache write error:", cacheError);
  });

  it("fails closed when the HTML cache write rejects", async () => {
    const cacheError = new Error("cache unavailable");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await Promise.resolve(
      finalizeAppPageHtmlCacheResponse(
        new Response("<h1>user=alice</h1>", {
          headers: { "Cache-Control": "s-maxage=60" },
        }),
        {
          capturedRscDataPromise: null,
          cleanPathname: "/account",
          consumeDynamicUsage: () => false,
          getPageTags: () => ["/account"],
          isrHtmlKey: (pathname) => `html:${pathname}`,
          isrRscKey: (pathname) => `rsc:${pathname}`,
          async isrSet() {
            throw cacheError;
          },
          linkHeader: null,
          revalidateSeconds: 60,
          waitUntil(promise) {
            pendingCacheWrites.push(promise);
          },
        },
      ),
    );

    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("CDN-Cache-Control")).toBeNull();
    expect(response.headers.get("Cache-Tag")).toBeNull();
    await response.text();
    await Promise.all(pendingCacheWrites);
    expect(consoleError).toHaveBeenCalledWith("[vinext] ISR cache write error:", cacheError);
  });

  it("contains a background HTML stream failure after the private response leaves", async () => {
    const streamError = new Error("render stream failed");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = finalizeAppPageHtmlCacheResponse(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.error(streamError);
          },
        }),
        { headers: { "Cache-Control": "s-maxage=60" } },
      ),
      {
        capturedRscDataPromise: null,
        cleanPathname: "/broken-stream",
        consumeDynamicUsage: () => false,
        getPageTags: () => ["/broken-stream"],
        isrHtmlKey: (pathname) => `html:${pathname}`,
        isrRscKey: (pathname) => `rsc:${pathname}`,
        isrSet: vi.fn(),
        linkHeader: null,
        revalidateSeconds: 60,
        waitUntil(promise) {
          pendingCacheWrites.push(promise);
        },
      },
    );

    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(Promise.all(pendingCacheWrites)).resolves.toEqual([undefined]);
    expect(consoleError).toHaveBeenCalledWith("[vinext] ISR cache stream error:", streamError);
  });
});
