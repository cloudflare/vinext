import { describe, expect, it, vi } from "vite-plus/test";
import {
  buildAppPageCachedResponse,
  finalizeAppPageHtmlCacheResponse,
  readAppPageCacheResponse,
  scheduleAppPageRscCacheWrite,
} from "../packages/vinext/src/server/app-page-cache.js";
import type { ISRCacheEntry } from "../packages/vinext/src/server/isr-cache.js";
import type { CachedAppPageValue } from "../packages/vinext/src/shims/cache.js";

function buildISRCacheEntry(value: CachedAppPageValue, isStale = false): ISRCacheEntry {
  return {
    isStale,
    value: {
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
  it("builds cached HTML and RSC responses", async () => {
    const rscData = new TextEncoder().encode("flight").buffer;
    const cachedValue = buildCachedAppPageValue("<h1>cached</h1>", rscData, 201);

    const htmlResponse = buildAppPageCachedResponse(cachedValue, {
      cacheState: "HIT",
      isRscRequest: false,
      revalidateSeconds: 60,
    });
    expect(htmlResponse?.status).toBe(201);
    expect(htmlResponse?.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(htmlResponse?.headers.get("x-vinext-cache")).toBe("HIT");
    await expect(htmlResponse?.text()).resolves.toBe("<h1>cached</h1>");

    const rscResponse = buildAppPageCachedResponse(cachedValue, {
      cacheState: "STALE",
      isRscRequest: true,
      revalidateSeconds: 60,
    });
    expect(rscResponse?.headers.get("content-type")).toBe("text/x-component; charset=utf-8");
    expect(rscResponse?.headers.get("cache-control")).toBe("s-maxage=0, stale-while-revalidate");
    expect(await rscResponse?.arrayBuffer()).toEqual(rscData);
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

  it("returns cached HIT responses and clears request state", async () => {
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

  it("serves stale entries and regenerates HTML and RSC cache keys", async () => {
    const scheduledRegenerations: Array<() => Promise<void>> = [];
    const isrSetCalls: Array<{
      key: string;
      html: string;
      hasRscData: boolean;
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
      isrRscKey(pathname) {
        return "rsc:" + pathname;
      },
      async isrSet(key, data, revalidateSeconds, tags) {
        isrSetCalls.push({
          key,
          html: data.html,
          hasRscData: Boolean(data.rscData),
          revalidateSeconds,
          tags,
        });
      },
      revalidateSeconds: 60,
      async renderFreshPageForCache() {
        return {
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
        key: "html:/stale",
        html: "<h1>fresh</h1>",
        hasRscData: false,
        revalidateSeconds: 60,
        tags: ["/stale", "_N_T_/stale"],
      },
      {
        key: "rsc:/stale",
        html: "",
        hasRscData: true,
        revalidateSeconds: 60,
        tags: ["/stale", "_N_T_/stale"],
      },
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
      revalidateSeconds: 60,
      async renderFreshPageForCache() {
        throw new Error("should not render");
      },
      scheduleBackgroundRegeneration() {},
    });

    expect(response).toBeNull();
    expect(errorSpy).toHaveBeenCalledOnce();
    errorSpy.mockRestore();
  });

  it("finalizes HTML responses by teeing the stream and writing HTML and RSC cache keys", async () => {
    const pendingCacheWrites: Promise<void>[] = [];
    const isrSetCalls: Array<{
      key: string;
      html: string;
      hasRscData: boolean;
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
          Vary: "RSC, Accept",
          "X-Vinext-Cache": "MISS",
        },
      }),
      {
        capturedRscDataPromise: Promise.resolve(rscData),
        cleanPathname: "/fresh",
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
        async isrSet(key, data, revalidateSeconds, tags) {
          isrSetCalls.push({
            key,
            html: data.html,
            hasRscData: Boolean(data.rscData),
            revalidateSeconds,
            tags,
          });
        },
        revalidateSeconds: 60,
        waitUntil(promise) {
          pendingCacheWrites.push(promise);
        },
      },
    );

    expect(response.status).toBe(201);
    await expect(response.text()).resolves.toBe("<h1>fresh</h1>");
    expect(pendingCacheWrites).toHaveLength(1);

    await pendingCacheWrites[0];

    expect(isrSetCalls).toEqual([
      {
        key: "html:/fresh",
        html: "<h1>fresh</h1>",
        hasRscData: false,
        revalidateSeconds: 60,
        tags: ["/fresh", "_N_T_/fresh"],
      },
      {
        key: "rsc:/fresh",
        html: "",
        hasRscData: true,
        revalidateSeconds: 60,
        tags: ["/fresh", "_N_T_/fresh"],
      },
    ]);
    expect(debugCalls).toEqual([["HTML cache written", "html:/fresh"]]);
  });

  it("schedules RSC cache writes when the page stayed static through stream consumption", async () => {
    const pendingCacheWrites: Promise<void>[] = [];
    const debugCalls: Array<[string, string]> = [];
    const isrSetCalls: Array<{
      key: string;
      html: string;
      hasRscData: boolean;
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
      async isrSet(key, data, revalidateSeconds, tags) {
        isrSetCalls.push({
          key,
          html: data.html,
          hasRscData: Boolean(data.rscData),
          revalidateSeconds,
          tags,
        });
      },
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
        revalidateSeconds: 60,
        tags: ["/fresh-rsc", "_N_T_/fresh-rsc"],
      },
    ]);
    expect(debugCalls).toEqual([["RSC cache written", "rsc:/fresh-rsc"]]);
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
});
