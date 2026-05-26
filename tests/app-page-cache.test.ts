import { describe, expect, it, vi } from "vite-plus/test";
import {
  type AppPageCacheOutcomeMetric,
  buildAppPageCacheTags,
  buildAppPageCachedResponse,
  finalizeAppPageHtmlCacheResponse,
  finalizeAppPageRscCacheResponse,
  readAppPageCacheResponse,
  scheduleAppPageRscCacheWrite,
} from "../packages/vinext/src/server/app-page-cache.js";
import type { ISRCacheEntry } from "../packages/vinext/src/server/isr-cache.js";
import {
  VINEXT_RSC_COMPATIBILITY_ID_HEADER,
  VINEXT_RSC_VARY_HEADER,
} from "../packages/vinext/src/server/app-rsc-cache-busting.js";
import type { CachedAppPageValue } from "../packages/vinext/src/shims/cache.js";
import { withEnvVar } from "./env-test-helpers.js";

function buildISRCacheEntry(
  value: CachedAppPageValue,
  isStale = false,
  cacheControl?: { revalidate: number; expire?: number },
): ISRCacheEntry {
  return {
    isStale,
    value: {
      cacheControl,
      lastModified: Date.now(),
      value,
    },
  };
}

function buildCachedAppPageValue(
  html: string,
  rscData?: ArrayBuffer,
  status?: number,
): CachedAppPageValue {
  return {
    kind: "APP_PAGE",
    html,
    rscData,
    headers: undefined,
    postponed: undefined,
    status,
  };
}

describe("app page cache helpers", () => {
  it("builds implicit page cache tags with unique extra tags", () => {
    expect(buildAppPageCacheTags("/blog/hello", ["custom", "_N_T_/blog/layout"])).toEqual([
      "/blog/hello",
      "_N_T_/blog/hello",
      "_N_T_/layout",
      "_N_T_/blog/layout",
      "_N_T_/blog/hello/layout",
      "_N_T_/blog/hello/page",
      "custom",
    ]);
  });

  it("builds cached HTML and RSC responses", async () => {
    const rscData = new TextEncoder().encode("flight").buffer;
    const cachedValue = buildCachedAppPageValue("<h1>cached</h1>", rscData, 201);

    const htmlResponse = buildAppPageCachedResponse(cachedValue, {
      cacheState: "HIT",
      expireSeconds: 300,
      isRscRequest: false,
      revalidateSeconds: 60,
    });
    expect(htmlResponse?.status).toBe(201);
    expect(htmlResponse?.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(htmlResponse?.headers.get("cache-control")).toBe("s-maxage=60, stale-while-revalidate");
    expect(htmlResponse?.headers.get("x-vinext-cache")).toBe("HIT");
    // Ported from Next.js: test/e2e/app-dir/app-root-params-getters/generate-static-params.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/app-root-params-getters/generate-static-params.test.ts
    expect(htmlResponse?.headers.get("x-nextjs-cache")).toBe("HIT");
    await expect(htmlResponse?.text()).resolves.toBe("<h1>cached</h1>");

    const rscResponse = withEnvVar("__VINEXT_RSC_COMPATIBILITY_ID", "compat-a", () =>
      buildAppPageCachedResponse(cachedValue, {
        cacheState: "STALE",
        expireSeconds: 300,
        isRscRequest: true,
        revalidateSeconds: 60,
      }),
    );
    expect(rscResponse?.headers.get("content-type")).toBe("text/x-component");
    expect(rscResponse?.headers.get("cache-control")).toBe("s-maxage=0, stale-while-revalidate");
    expect(rscResponse?.headers.get(VINEXT_RSC_COMPATIBILITY_ID_HEADER)).toBe("compat-a");
    expect(rscResponse?.headers.get("x-nextjs-cache")).toBe("STALE");
    expect(await rscResponse?.arrayBuffer()).toEqual(rscData);
  });

  it("merges middleware response headers into cached HTML responses", async () => {
    const middlewareHeaders = new Headers({
      "Cache-Control": "private, no-store",
      "Content-Security-Policy": "frame-ancestors 'none'",
      Vary: "Accept-Encoding",
      "X-Frame-Options": "DENY",
    });
    middlewareHeaders.append("Set-Cookie", "session=abc; Path=/; HttpOnly");

    const response = buildAppPageCachedResponse(buildCachedAppPageValue("<h1>cached</h1>"), {
      cacheState: "HIT",
      isRscRequest: false,
      middlewareHeaders,
      revalidateSeconds: 60,
    });

    expect(response?.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response?.headers.get("Content-Security-Policy")).toBe("frame-ancestors 'none'");
    expect(response?.headers.get("Set-Cookie")).toBe("session=abc; Path=/; HttpOnly");
    expect(response?.headers.get("Vary")).toBe(`${VINEXT_RSC_VARY_HEADER}, Accept-Encoding`);
    expect(response?.headers.get("X-Frame-Options")).toBe("DENY");
    expect(response?.headers.get("X-Vinext-Cache")).toBe("HIT");
  });

  it("merges middleware response headers into cached RSC responses", async () => {
    const rscData = new TextEncoder().encode("flight").buffer;
    const middlewareHeaders = new Headers({
      "Access-Control-Allow-Origin": "https://example.com",
      [VINEXT_RSC_COMPATIBILITY_ID_HEADER]: "middleware-compat",
      Vary: "Origin",
    });

    const response = withEnvVar("__VINEXT_RSC_COMPATIBILITY_ID", "framework-compat", () =>
      buildAppPageCachedResponse(buildCachedAppPageValue("", rscData), {
        cacheState: "STALE",
        isRscRequest: true,
        middlewareHeaders,
        revalidateSeconds: 60,
      }),
    );

    expect(response?.headers.get("Access-Control-Allow-Origin")).toBe("https://example.com");
    expect(response?.headers.get(VINEXT_RSC_COMPATIBILITY_ID_HEADER)).toBe("framework-compat");
    expect(response?.headers.get("Vary")).toBe(`${VINEXT_RSC_VARY_HEADER}, Origin`);
    expect(response?.headers.get("X-Vinext-Cache")).toBe("STALE");
    await expect(response?.arrayBuffer()).resolves.toEqual(rscData);
  });

  it("uses stored cache-control metadata instead of global config for cached HIT responses", async () => {
    const cachedValue = buildCachedAppPageValue("<h1>cached</h1>");

    const response = await readAppPageCacheResponse({
      cleanPathname: "/cached",
      clearRequestContext: vi.fn(),
      isRscRequest: false,
      isrGet: vi.fn(async () =>
        buildISRCacheEntry(cachedValue, false, { revalidate: 60, expire: 300 }),
      ),
      isrHtmlKey(pathname) {
        return `html:${pathname}`;
      },
      isrRscKey(pathname) {
        return `rsc:${pathname}`;
      },
      isrSet: vi.fn(async () => {}),
      expireSeconds: 31_536_000,
      revalidateSeconds: 60,
      renderFreshPageForCache: vi.fn(),
      scheduleBackgroundRegeneration: vi.fn(),
    });

    expect(response?.headers.get("cache-control")).toBe("s-maxage=60, stale-while-revalidate=240");
  });

  it("emits static cache-control for cached indefinite app pages", async () => {
    const response = buildAppPageCachedResponse(buildCachedAppPageValue("<h1>cached</h1>"), {
      cacheState: "HIT",
      isRscRequest: false,
      revalidateSeconds: Infinity,
    });

    expect(response?.headers.get("cache-control")).toBe(
      "s-maxage=31536000, stale-while-revalidate",
    );
  });

  it("preserves legacy STALE headers when cached entries lack cache-control metadata", async () => {
    const cachedValue = buildCachedAppPageValue("<h1>cached</h1>");

    const response = await readAppPageCacheResponse({
      cleanPathname: "/cached",
      clearRequestContext: vi.fn(),
      isRscRequest: false,
      isrGet: vi.fn(async () => buildISRCacheEntry(cachedValue, true)),
      isrHtmlKey(pathname) {
        return `html:${pathname}`;
      },
      isrRscKey(pathname) {
        return `rsc:${pathname}`;
      },
      isrSet: vi.fn(async () => {}),
      expireSeconds: 31_536_000,
      revalidateSeconds: 60,
      renderFreshPageForCache: vi.fn(async () => ({
        html: "<h1>fresh</h1>",
        rscData: new ArrayBuffer(0),
        tags: [],
      })),
      scheduleBackgroundRegeneration: vi.fn(),
    });

    expect(response?.headers.get("cache-control")).toBe("s-maxage=0, stale-while-revalidate");
  });

  it("falls back to 200 for falsy cached status values", () => {
    const response = buildAppPageCachedResponse(
      buildCachedAppPageValue("<h1>cached</h1>", undefined, 0),
      {
        cacheState: "HIT",
        isRscRequest: false,
        revalidateSeconds: 60,
      },
    );

    expect(response?.status).toBe(200);
  });

  it("uses middleware status for cached responses when middleware continues", () => {
    const response = buildAppPageCachedResponse(
      buildCachedAppPageValue("<h1>cached</h1>", undefined, 201),
      {
        cacheState: "HIT",
        isRscRequest: false,
        middlewareStatus: 202,
        revalidateSeconds: 60,
      },
    );

    expect(response?.status).toBe(202);
  });

  it("returns null when a cached entry lacks the requested HTML or RSC payload", () => {
    const htmlOnly = buildCachedAppPageValue("<h1>cached</h1>");
    const rscOnly = buildCachedAppPageValue("", new TextEncoder().encode("flight").buffer);

    expect(
      buildAppPageCachedResponse(htmlOnly, {
        cacheState: "HIT",
        isRscRequest: true,
        revalidateSeconds: 60,
      }),
    ).toBeNull();
    expect(
      buildAppPageCachedResponse(rscOnly, {
        cacheState: "HIT",
        isRscRequest: false,
        revalidateSeconds: 60,
      }),
    ).toBeNull();
  });

  it("emits the `x-edge-runtime: 1` marker on cached responses for edge-runtime routes", () => {
    const rscData = new TextEncoder().encode("flight").buffer;
    const cached = buildCachedAppPageValue("<h1>cached</h1>", rscData);

    const htmlResponse = buildAppPageCachedResponse(cached, {
      cacheState: "HIT",
      isEdgeRuntime: true,
      isRscRequest: false,
      revalidateSeconds: 60,
    });
    expect(htmlResponse?.headers.get("x-edge-runtime")).toBe("1");

    const rscResponse = buildAppPageCachedResponse(cached, {
      cacheState: "HIT",
      isEdgeRuntime: true,
      isRscRequest: true,
      revalidateSeconds: 60,
    });
    expect(rscResponse?.headers.get("x-edge-runtime")).toBe("1");
  });

  it("omits the `x-edge-runtime` marker on cached responses for nodejs-runtime routes", () => {
    const rscData = new TextEncoder().encode("flight").buffer;
    const cached = buildCachedAppPageValue("<h1>cached</h1>", rscData);

    const htmlResponse = buildAppPageCachedResponse(cached, {
      cacheState: "HIT",
      isRscRequest: false,
      revalidateSeconds: 60,
    });
    expect(htmlResponse?.headers.get("x-edge-runtime")).toBeNull();

    const rscResponse = buildAppPageCachedResponse(cached, {
      cacheState: "HIT",
      isRscRequest: true,
      revalidateSeconds: 60,
    });
    expect(rscResponse?.headers.get("x-edge-runtime")).toBeNull();
  });

  it("returns cached HIT responses and clears request state", async () => {
    let didClearRequestContext = false;
    const middlewareHeaders = new Headers({ "X-From-Middleware": "hit" });
    const cacheOutcomes: AppPageCacheOutcomeMetric[] = [];

    const response = await readAppPageCacheResponse({
      cleanPathname: "/cached",
      clearRequestContext() {
        didClearRequestContext = true;
      },
      isRscRequest: false,
      async isrGet() {
        return buildISRCacheEntry(buildCachedAppPageValue("<h1>cached</h1>"));
      },
      isrHtmlKey(pathname) {
        return "html:" + pathname;
      },
      isrRscKey(pathname) {
        return "rsc:" + pathname;
      },
      async isrSet() {},
      middlewareHeaders,
      middlewareStatus: 203,
      recordCacheOutcome(metric) {
        cacheOutcomes.push(metric);
      },
      revalidateSeconds: 60,
      async renderFreshPageForCache() {
        throw new Error("should not render");
      },
      scheduleBackgroundRegeneration() {
        throw new Error("should not schedule regeneration");
      },
    });

    expect(response?.headers.get("x-vinext-cache")).toBe("HIT");
    expect(response?.headers.get("x-from-middleware")).toBe("hit");
    expect(response?.status).toBe(203);
    await expect(response?.text()).resolves.toBe("<h1>cached</h1>");
    expect(didClearRequestContext).toBe(true);
    expect(cacheOutcomes).toEqual([
      {
        artifact: "html",
        cacheKey: "html:/cached",
        outcome: "hit",
        reason: "served",
      },
    ]);
  });

  it("returns cached HIT responses when the cache outcome recorder throws", async () => {
    let didClearRequestContext = false;

    const response = await readAppPageCacheResponse({
      cleanPathname: "/cached",
      clearRequestContext() {
        didClearRequestContext = true;
      },
      isRscRequest: false,
      async isrGet() {
        return buildISRCacheEntry(buildCachedAppPageValue("<h1>cached</h1>"));
      },
      isrHtmlKey(pathname) {
        return "html:" + pathname;
      },
      isrRscKey(pathname) {
        return "rsc:" + pathname;
      },
      async isrSet() {},
      recordCacheOutcome() {
        throw new Error("metrics sink unavailable");
      },
      revalidateSeconds: 60,
      async renderFreshPageForCache() {
        throw new Error("should not render");
      },
      scheduleBackgroundRegeneration() {
        throw new Error("should not schedule regeneration");
      },
    });

    expect(response?.headers.get("x-vinext-cache")).toBe("HIT");
    await expect(response?.text()).resolves.toBe("<h1>cached</h1>");
    expect(didClearRequestContext).toBe(true);
  });

  it("keys RSC cache reads by mounted-slot header and echoes the variant header", async () => {
    const response = await readAppPageCacheResponse({
      cleanPathname: "/cached",
      clearRequestContext() {},
      isRscRequest: true,
      async isrGet(key) {
        expect(key).toBe("rsc:/cached:slot:auth:/");
        return buildISRCacheEntry(
          buildCachedAppPageValue("", new TextEncoder().encode("flight").buffer),
        );
      },
      isrHtmlKey(pathname) {
        return "html:" + pathname;
      },
      isrRscKey(pathname, mountedSlotsHeader) {
        return `rsc:${pathname}:${mountedSlotsHeader ?? "none"}`;
      },
      async isrSet() {},
      mountedSlotsHeader: "slot:auth:/",
      revalidateSeconds: 60,
      async renderFreshPageForCache() {
        throw new Error("should not render");
      },
      scheduleBackgroundRegeneration() {
        throw new Error("should not schedule regeneration");
      },
    });

    expect(response?.headers.get("x-vinext-mounted-slots")).toBe("slot:auth:/");
  });

  it("serves stale RSC entries and regenerates only the matching RSC cache key", async () => {
    const scheduledRegenerations: Array<() => Promise<void>> = [];
    const isrSetCalls: Array<{
      key: string;
      html: string;
      hasRscData: boolean;
      expireSeconds: number | undefined;
      revalidateSeconds: number;
      tags: string[];
    }> = [];
    const rscData = new TextEncoder().encode("fresh-flight").buffer;

    const response = await readAppPageCacheResponse({
      cleanPathname: "/stale",
      clearRequestContext() {},
      isRscRequest: true,
      async isrGet() {
        return buildISRCacheEntry(buildCachedAppPageValue("", rscData), true);
      },
      isrHtmlKey(pathname) {
        return "html:" + pathname;
      },
      isrRscKey(pathname, mountedSlotsHeader) {
        return `rsc:${pathname}:${mountedSlotsHeader ?? "none"}`;
      },
      async isrSet(key, data, revalidateSeconds, tags, expireSeconds) {
        isrSetCalls.push({
          key,
          html: data.html,
          hasRscData: Boolean(data.rscData),
          expireSeconds,
          revalidateSeconds,
          tags,
        });
      },
      mountedSlotsHeader: "slot:auth:/",
      expireSeconds: 300,
      revalidateSeconds: 60,
      async renderFreshPageForCache() {
        return {
          cacheControl: { revalidate: 10, expire: 20 },
          html: "<h1>fresh</h1>",
          rscData,
          tags: ["/stale", "_N_T_/stale"],
        };
      },
      scheduleBackgroundRegeneration(_key, renderFn) {
        scheduledRegenerations.push(renderFn);
      },
    });

    expect(response?.headers.get("x-vinext-cache")).toBe("STALE");
    expect(scheduledRegenerations).toHaveLength(1);

    await scheduledRegenerations[0]();

    expect(isrSetCalls).toEqual([
      {
        key: "rsc:/stale:slot:auth:/",
        html: "",
        hasRscData: true,
        expireSeconds: 20,
        revalidateSeconds: 10,
        tags: ["/stale", "_N_T_/stale"],
      },
    ]);
  });

  it("dedups stale RSC regeneration by the slot-specific cache key", async () => {
    const scheduledKeys: string[] = [];
    const rscData = new TextEncoder().encode("stale-flight").buffer;

    await readAppPageCacheResponse({
      cleanPathname: "/parallel",
      clearRequestContext() {},
      isRscRequest: true,
      async isrGet() {
        return buildISRCacheEntry(buildCachedAppPageValue("", rscData), true);
      },
      isrHtmlKey(pathname) {
        return "html:" + pathname;
      },
      isrRscKey(pathname, mountedSlotsHeader) {
        return `rsc:${pathname}:${mountedSlotsHeader ?? "none"}`;
      },
      async isrSet() {},
      mountedSlotsHeader: "slot:auth:/",
      revalidateSeconds: 60,
      async renderFreshPageForCache() {
        return {
          html: "<h1>fresh</h1>",
          rscData,
          tags: ["/parallel", "_N_T_/parallel"],
        };
      },
      scheduleBackgroundRegeneration(key) {
        scheduledKeys.push(key);
      },
    });

    expect(scheduledKeys).toEqual(["rsc:/parallel:slot:auth:/"]);
  });

  it("serves stale HTML entries and regenerates HTML plus canonical RSC cache keys", async () => {
    const scheduledRegenerations: Array<() => Promise<void>> = [];
    const isrSetCalls: Array<{
      key: string;
      expireSeconds: number | undefined;
      revalidateSeconds: number;
    }> = [];
    const rscData = new TextEncoder().encode("fresh-flight").buffer;

    const response = await readAppPageCacheResponse({
      cleanPathname: "/stale-html",
      clearRequestContext() {},
      isRscRequest: false,
      async isrGet() {
        return buildISRCacheEntry(buildCachedAppPageValue("<h1>stale</h1>"), true);
      },
      isrHtmlKey(pathname) {
        return "html:" + pathname;
      },
      isrRscKey(pathname, mountedSlotsHeader) {
        return `rsc:${pathname}:${mountedSlotsHeader ?? "none"}`;
      },
      async isrSet(key, _data, revalidateSeconds, _tags, expireSeconds) {
        isrSetCalls.push({ key, expireSeconds, revalidateSeconds });
      },
      expireSeconds: 300,
      revalidateSeconds: 60,
      async renderFreshPageForCache() {
        return {
          cacheControl: { revalidate: 10, expire: 20 },
          html: "<h1>fresh</h1>",
          rscData,
          tags: ["/stale-html", "_N_T_/stale-html"],
        };
      },
      scheduleBackgroundRegeneration(_key, renderFn) {
        scheduledRegenerations.push(renderFn);
      },
    });

    expect(response?.headers.get("x-vinext-cache")).toBe("STALE");
    await scheduledRegenerations[0]();
    expect(isrSetCalls).toEqual([
      { key: "rsc:/stale-html:none", expireSeconds: 20, revalidateSeconds: 10 },
      { key: "html:/stale-html", expireSeconds: 20, revalidateSeconds: 10 },
    ]);
  });

  it("still schedules stale regeneration when the stale payload is unusable for this request", async () => {
    const debugCalls: Array<[string, string]> = [];
    const scheduledRegenerations: Array<() => Promise<void>> = [];

    const response = await readAppPageCacheResponse({
      cleanPathname: "/stale-html-miss",
      clearRequestContext() {
        throw new Error("should not clear request context when falling through");
      },
      isRscRequest: false,
      async isrGet() {
        return buildISRCacheEntry(
          buildCachedAppPageValue("", new TextEncoder().encode("flight").buffer),
          true,
        );
      },
      isrDebug(event, detail) {
        debugCalls.push([event, detail]);
      },
      isrHtmlKey(pathname) {
        return "html:" + pathname;
      },
      isrRscKey(pathname) {
        return "rsc:" + pathname;
      },
      async isrSet() {},
      revalidateSeconds: 60,
      async renderFreshPageForCache() {
        return {
          html: "<h1>fresh</h1>",
          rscData: new TextEncoder().encode("fresh-flight").buffer,
          tags: ["/stale-html-miss", "_N_T_/stale-html-miss"],
        };
      },
      scheduleBackgroundRegeneration(_key, renderFn) {
        scheduledRegenerations.push(renderFn);
      },
    });

    expect(response).toBeNull();
    expect(scheduledRegenerations).toHaveLength(1);
    expect(debugCalls).toContainEqual(["STALE MISS (empty stale entry)", "/stale-html-miss"]);

    await expect(scheduledRegenerations[0]()).resolves.toBeUndefined();
  });

  it("falls through and logs on cache read errors", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const cacheOutcomes: AppPageCacheOutcomeMetric[] = [];

    const response = await readAppPageCacheResponse({
      cleanPathname: "/broken",
      clearRequestContext() {},
      isRscRequest: false,
      async isrGet() {
        throw new Error("cache failed");
      },
      isrHtmlKey(pathname) {
        return "html:" + pathname;
      },
      isrRscKey(pathname) {
        return "rsc:" + pathname;
      },
      async isrSet() {},
      recordCacheOutcome(metric) {
        cacheOutcomes.push(metric);
      },
      revalidateSeconds: 60,
      async renderFreshPageForCache() {
        throw new Error("should not render");
      },
      scheduleBackgroundRegeneration() {},
    });

    expect(response).toBeNull();
    expect(cacheOutcomes).toEqual([
      {
        artifact: "html",
        cacheKey: "html:/broken",
        outcome: "miss",
        reason: "read-error",
      },
    ]);
    expect(errorSpy).toHaveBeenCalledOnce();
    errorSpy.mockRestore();
  });

  it("records a miss when a cache key contains a non-app-page value", async () => {
    const cacheOutcomes: AppPageCacheOutcomeMetric[] = [];

    const response = await readAppPageCacheResponse({
      cleanPathname: "/wrong-kind",
      clearRequestContext() {
        throw new Error("should not clear request context when falling through");
      },
      isRscRequest: false,
      async isrGet() {
        return {
          isStale: false,
          value: {
            lastModified: Date.now(),
            value: {
              kind: "REDIRECT",
              props: {},
            },
          },
        };
      },
      isrHtmlKey(pathname) {
        return "html:" + pathname;
      },
      isrRscKey(pathname) {
        return "rsc:" + pathname;
      },
      async isrSet() {},
      recordCacheOutcome(metric) {
        cacheOutcomes.push(metric);
      },
      revalidateSeconds: 60,
      async renderFreshPageForCache() {
        throw new Error("should not render");
      },
      scheduleBackgroundRegeneration() {
        throw new Error("should not schedule regeneration");
      },
    });

    expect(response).toBeNull();
    expect(cacheOutcomes).toEqual([
      {
        artifact: "html",
        cacheKey: "html:/wrong-kind",
        outcome: "miss",
        reason: "non-app-page-entry",
      },
    ]);
  });

  it("finalizes HTML responses by teeing the stream and writing HTML and RSC cache keys", async () => {
    const pendingCacheWrites: Promise<void>[] = [];
    const isrSetCalls: Array<{
      key: string;
      html: string;
      hasRscData: boolean;
      expireSeconds: number | undefined;
      revalidateSeconds: number;
      tags: string[];
    }> = [];
    const debugCalls: Array<[string, string]> = [];
    const rscData = new TextEncoder().encode("flight").buffer;

    const response = finalizeAppPageHtmlCacheResponse(
      new Response("<h1>fresh</h1>", {
        status: 201,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "s-maxage=60, stale-while-revalidate",
          Vary: "RSC, Accept",
          "X-Vinext-Cache": "MISS",
        },
      }),
      {
        capturedRscDataPromise: Promise.resolve(rscData),
        cleanPathname: "/fresh",
        consumeDynamicUsage() {
          return false;
        },
        getPageTags() {
          return ["/fresh", "_N_T_/fresh"];
        },
        isrDebug(event, detail) {
          debugCalls.push([event, detail]);
        },
        isrHtmlKey(pathname) {
          return "html:" + pathname;
        },
        isrRscKey(pathname) {
          return "rsc:" + pathname;
        },
        async isrSet(key, data, revalidateSeconds, tags, expireSeconds) {
          isrSetCalls.push({
            key,
            html: data.html,
            hasRscData: Boolean(data.rscData),
            expireSeconds,
            revalidateSeconds,
            tags,
          });
        },
        expireSeconds: 300,
        revalidateSeconds: 60,
        waitUntil(promise) {
          pendingCacheWrites.push(promise);
        },
      },
    );

    expect(response.status).toBe(201);
    expect(response.headers.get("Cache-Control")).toBe("no-store, must-revalidate");
    expect(response.headers.get("X-Vinext-Cache")).toBe("MISS");
    await expect(response.text()).resolves.toBe("<h1>fresh</h1>");
    expect(pendingCacheWrites).toHaveLength(1);

    await pendingCacheWrites[0];

    expect(isrSetCalls).toEqual([
      {
        key: "html:/fresh",
        html: "<h1>fresh</h1>",
        hasRscData: false,
        expireSeconds: 300,
        revalidateSeconds: 60,
        tags: ["/fresh", "_N_T_/fresh"],
      },
      {
        key: "rsc:/fresh",
        html: "",
        hasRscData: true,
        expireSeconds: 300,
        revalidateSeconds: 60,
        tags: ["/fresh", "_N_T_/fresh"],
      },
    ]);
    expect(debugCalls).toEqual([["HTML cache written", "html:/fresh"]]);
  });

  it("skips HTML and RSC cache writes when dynamic usage appears during stream rendering", async () => {
    const pendingCacheWrites: Promise<void>[] = [];
    const debugCalls: Array<[string, string]> = [];
    const isrSet = vi.fn();
    const options = {
      capturedRscDataPromise: Promise.resolve(new TextEncoder().encode("flight").buffer),
      cleanPathname: "/dynamic-html",
      consumeDynamicUsage() {
        return true;
      },
      getPageTags() {
        return ["/dynamic-html", "_N_T_/dynamic-html"];
      },
      isrDebug(event: string, detail: string) {
        debugCalls.push([event, detail]);
      },
      isrHtmlKey(pathname: string) {
        return "html:" + pathname;
      },
      isrRscKey(pathname: string) {
        return "rsc:" + pathname;
      },
      isrSet,
      revalidateSeconds: 60,
      waitUntil(promise: Promise<void>) {
        pendingCacheWrites.push(promise);
      },
    };

    const response = finalizeAppPageHtmlCacheResponse(
      new Response("<h1>personalized</h1>", {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "s-maxage=60, stale-while-revalidate",
          Vary: "RSC, Accept",
          "X-Vinext-Cache": "MISS",
        },
      }),
      options,
    );

    expect(response.headers.get("Cache-Control")).toBe("no-store, must-revalidate");
    expect(response.headers.get("X-Vinext-Cache")).toBe("MISS");
    await expect(response.text()).resolves.toBe("<h1>personalized</h1>");
    expect(pendingCacheWrites).toHaveLength(1);

    await pendingCacheWrites[0];

    expect(isrSet).not.toHaveBeenCalled();
    expect(debugCalls).toEqual([
      ["HTML cache write skipped (dynamic usage during render)", "html:/dynamic-html"],
    ]);
  });

  it("skips HTML and RSC cache writes when dynamic usage was captured before context cleanup", async () => {
    const pendingCacheWrites: Promise<void>[] = [];
    const debugCalls: Array<[string, string]> = [];
    const isrSet = vi.fn();

    const response = finalizeAppPageHtmlCacheResponse(
      new Response("<h1>personalized</h1>", {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "s-maxage=60, stale-while-revalidate",
          Vary: "RSC, Accept",
          "X-Vinext-Cache": "MISS",
        },
      }),
      {
        capturedDynamicUsageBeforeContextCleanup() {
          return true;
        },
        capturedRscDataPromise: Promise.resolve(new TextEncoder().encode("flight").buffer),
        cleanPathname: "/dynamic-html-cleanup",
        consumeDynamicUsage() {
          return false;
        },
        getPageTags() {
          return ["/dynamic-html-cleanup", "_N_T_/dynamic-html-cleanup"];
        },
        isrDebug(event, detail) {
          debugCalls.push([event, detail]);
        },
        isrHtmlKey(pathname) {
          return "html:" + pathname;
        },
        isrRscKey(pathname) {
          return "rsc:" + pathname;
        },
        isrSet,
        revalidateSeconds: 60,
        waitUntil(promise) {
          pendingCacheWrites.push(promise);
        },
      },
    );

    await expect(response.text()).resolves.toBe("<h1>personalized</h1>");
    expect(pendingCacheWrites).toHaveLength(1);

    await pendingCacheWrites[0];

    expect(isrSet).not.toHaveBeenCalled();
    expect(debugCalls).toEqual([
      ["HTML cache write skipped (dynamic usage during render)", "html:/dynamic-html-cleanup"],
    ]);
  });

  it("schedules RSC cache writes when the page stayed static through stream consumption", async () => {
    const pendingCacheWrites: Promise<void>[] = [];
    const debugCalls: Array<[string, string]> = [];
    const isrSetCalls: Array<{
      key: string;
      html: string;
      hasRscData: boolean;
      expireSeconds: number | undefined;
      revalidateSeconds: number;
      tags: string[];
    }> = [];

    const didSchedule = scheduleAppPageRscCacheWrite({
      capturedRscDataPromise: Promise.resolve(new TextEncoder().encode("flight").buffer),
      cleanPathname: "/fresh-rsc",
      consumeDynamicUsage() {
        return false;
      },
      dynamicUsedDuringBuild: false,
      getPageTags() {
        return ["/fresh-rsc", "_N_T_/fresh-rsc"];
      },
      isrDebug(event, detail) {
        debugCalls.push([event, detail]);
      },
      isrRscKey(pathname) {
        return "rsc:" + pathname;
      },
      async isrSet(key, data, revalidateSeconds, tags, expireSeconds) {
        isrSetCalls.push({
          key,
          html: data.html,
          hasRscData: Boolean(data.rscData),
          expireSeconds,
          revalidateSeconds,
          tags,
        });
      },
      expireSeconds: 300,
      revalidateSeconds: 60,
      waitUntil(promise) {
        pendingCacheWrites.push(promise);
      },
    });

    expect(didSchedule).toBe(true);
    expect(pendingCacheWrites).toHaveLength(1);

    await pendingCacheWrites[0];

    expect(isrSetCalls).toEqual([
      {
        key: "rsc:/fresh-rsc",
        html: "",
        hasRscData: true,
        expireSeconds: 300,
        revalidateSeconds: 60,
        tags: ["/fresh-rsc", "_N_T_/fresh-rsc"],
      },
    ]);
    expect(debugCalls).toEqual([["RSC cache written", "rsc:/fresh-rsc"]]);
  });

  it("marks client-facing RSC cache MISS responses no-store until the stream dynamic check finishes", async () => {
    const pendingCacheWrites: Promise<void>[] = [];
    const isrSetCalls: string[] = [];

    const response = finalizeAppPageRscCacheResponse(
      new Response("flight", {
        headers: {
          "Content-Type": "text/x-component",
          "Cache-Control": "s-maxage=60, stale-while-revalidate",
          "X-Vinext-Cache": "MISS",
        },
      }),
      {
        capturedRscDataPromise: Promise.resolve(new TextEncoder().encode("flight").buffer),
        cleanPathname: "/fresh-rsc",
        consumeDynamicUsage() {
          return false;
        },
        dynamicUsedDuringBuild: false,
        getPageTags() {
          return ["/fresh-rsc"];
        },
        isrRscKey(pathname) {
          return "rsc:" + pathname;
        },
        async isrSet(key) {
          isrSetCalls.push(key);
        },
        revalidateSeconds: 60,
        waitUntil(promise) {
          pendingCacheWrites.push(promise);
        },
      },
    );

    expect(response.headers.get("Cache-Control")).toBe("no-store, must-revalidate");
    expect(response.headers.get("X-Vinext-Cache")).toBe("MISS");
    await expect(response.text()).resolves.toBe("flight");
    expect(pendingCacheWrites).toHaveLength(1);

    await pendingCacheWrites[0];

    expect(isrSetCalls).toEqual(["rsc:/fresh-rsc"]);
  });

  it("skips RSC cache writes when dynamic usage appears during stream rendering", async () => {
    const pendingCacheWrites: Promise<void>[] = [];
    const debugCalls: Array<[string, string]> = [];
    const isrSet = vi.fn();

    const didSchedule = scheduleAppPageRscCacheWrite({
      capturedRscDataPromise: Promise.resolve(new TextEncoder().encode("flight").buffer),
      cleanPathname: "/dynamic-rsc",
      consumeDynamicUsage() {
        return true;
      },
      dynamicUsedDuringBuild: false,
      getPageTags() {
        return ["/dynamic-rsc", "_N_T_/dynamic-rsc"];
      },
      isrDebug(event, detail) {
        debugCalls.push([event, detail]);
      },
      isrRscKey(pathname) {
        return "rsc:" + pathname;
      },
      isrSet,
      revalidateSeconds: 60,
      waitUntil(promise) {
        pendingCacheWrites.push(promise);
      },
    });

    expect(didSchedule).toBe(true);
    expect(pendingCacheWrites).toHaveLength(1);

    await pendingCacheWrites[0];

    expect(isrSet).not.toHaveBeenCalled();
    expect(debugCalls).toEqual([
      ["RSC cache write skipped (dynamic usage during render)", "rsc:/dynamic-rsc"],
    ]);
  });

  it("skips cache writes when request cacheLife resolves to a non-finite revalidate", async () => {
    const pendingCacheWrites: Promise<void>[] = [];
    const debugCalls: Array<[string, string]> = [];
    const isrSet = vi.fn();

    const didSchedule = scheduleAppPageRscCacheWrite({
      capturedRscDataPromise: Promise.resolve(new TextEncoder().encode("flight").buffer),
      cleanPathname: "/invalid-cache-life",
      consumeDynamicUsage() {
        return false;
      },
      dynamicUsedDuringBuild: false,
      getPageTags() {
        return ["/invalid-cache-life"];
      },
      getRequestCacheLife() {
        return { revalidate: Number.NaN };
      },
      isrDebug(event, detail) {
        debugCalls.push([event, detail]);
      },
      isrRscKey(pathname) {
        return "rsc:" + pathname;
      },
      isrSet,
      revalidateSeconds: null,
      waitUntil(promise) {
        pendingCacheWrites.push(promise);
      },
    });

    expect(didSchedule).toBe(true);
    expect(pendingCacheWrites).toHaveLength(1);

    await pendingCacheWrites[0];

    expect(isrSet).not.toHaveBeenCalled();
    expect(debugCalls).toEqual([
      ["RSC cache write skipped (no cache policy)", "rsc:/invalid-cache-life"],
    ]);
  });
});
