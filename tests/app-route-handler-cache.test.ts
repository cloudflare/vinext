import { describe, expect, it, vi } from "vite-plus/test";
import { readAppRouteHandlerCacheResponse } from "../packages/vinext/src/server/app-route-handler-cache.js";
import { isKnownDynamicAppRoute } from "../packages/vinext/src/server/app-route-handler-runtime.js";
import type { ISRCacheEntry } from "../packages/vinext/src/server/isr-cache.js";
import type { CachedRouteValue } from "../packages/vinext/src/shims/cache.js";

function createDynamicUsageState(): {
  consumeDynamicUsage: () => boolean;
  markDynamicUsage: () => void;
} {
  let didUseDynamic = false;

  return {
    consumeDynamicUsage() {
      const used = didUseDynamic;
      didUseDynamic = false;
      return used;
    },
    markDynamicUsage() {
      didUseDynamic = true;
    },
  };
}

function buildISRCacheEntry(value: CachedRouteValue, isStale = false): ISRCacheEntry {
  return {
    isStale,
    value: {
      lastModified: Date.now(),
      value,
    },
  };
}

function buildCachedRouteValue(
  body: string,
  headers: Record<string, string> = {},
): CachedRouteValue {
  return {
    kind: "APP_ROUTE",
    body: new TextEncoder().encode(body).buffer,
    status: 200,
    headers,
  };
}

describe("app route handler cache helpers", () => {
  it("returns HIT responses from cached APP_ROUTE entries", async () => {
    let didClearRequestContext = false;

    const response = await readAppRouteHandlerCacheResponse({
      buildPageCacheTags(pathname, extraTags) {
        return [pathname, ...extraTags];
      },
      cleanPathname: "/api/cached",
      clearRequestContext() {
        didClearRequestContext = true;
      },
      consumeDynamicUsage() {
        return false;
      },
      getCollectedFetchTags() {
        return [];
      },
      handlerFn() {
        throw new Error("should not run");
      },
      isAutoHead: false,
      async isrGet() {
        return buildISRCacheEntry(
          buildCachedRouteValue("from-cache", { "content-type": "text/plain" }),
        );
      },
      isrRouteKey(pathname) {
        return "route:" + pathname;
      },
      async isrSet() {},
      markDynamicUsage() {},
      middlewareContext: {
        headers: new Headers([["x-middleware", "present"]]),
        status: 202,
      },
      params: {},
      requestUrl: "https://example.com/api/cached",
      revalidateSearchParams: new URLSearchParams("a=1"),
      revalidateSeconds: 60,
      routePattern: "/api/cached",
      async runInRevalidationContext(renderFn) {
        await renderFn();
      },
      scheduleBackgroundRegeneration() {
        throw new Error("should not schedule regeneration");
      },
      setNavigationContext() {},
    });

    expect(response?.status).toBe(202);
    expect(response?.headers.get("x-vinext-cache")).toBe("HIT");
    expect(response?.headers.get("x-middleware")).toBe("present");
    await expect(response?.text()).resolves.toBe("from-cache");
    expect(didClearRequestContext).toBe(true);
  });

  it("returns STALE responses and regenerates cached route handlers in the background", async () => {
    const dynamicUsage = createDynamicUsageState();
    const scheduledRegenerations: Array<() => Promise<void>> = [];
    const isrSetCalls: Array<{
      key: string;
      revalidateSeconds: number;
      tags: string[];
    }> = [];
    const navigationCalls: Array<string | null> = [];

    const response = await readAppRouteHandlerCacheResponse({
      basePath: "/base",
      buildPageCacheTags(pathname, extraTags) {
        return [pathname, ...extraTags];
      },
      cleanPathname: "/api/stale",
      clearRequestContext() {},
      consumeDynamicUsage: dynamicUsage.consumeDynamicUsage,
      getCollectedFetchTags() {
        return ["tag:regen"];
      },
      handlerFn() {
        return Response.json({
          ok: true,
        });
      },
      i18n: { locales: ["en"], defaultLocale: "en" },
      isAutoHead: false,
      async isrGet() {
        return buildISRCacheEntry(buildCachedRouteValue("from-stale"), true);
      },
      isrRouteKey(pathname) {
        return "route:" + pathname;
      },
      async isrSet(key, value, revalidateSeconds, tags) {
        expect(value.kind).toBe("APP_ROUTE");
        isrSetCalls.push({ key, revalidateSeconds, tags });
      },
      markDynamicUsage: dynamicUsage.markDynamicUsage,
      middlewareContext: { headers: null, status: null },
      params: { slug: "demo" },
      requestUrl: "https://example.com/base/api/stale?ping=pong",
      revalidateSearchParams: new URLSearchParams("ping=pong"),
      revalidateSeconds: 60,
      routePattern: "/api/stale",
      async runInRevalidationContext(renderFn) {
        await renderFn();
      },
      scheduleBackgroundRegeneration(_key, renderFn) {
        scheduledRegenerations.push(renderFn);
      },
      setNavigationContext(context) {
        navigationCalls.push(context?.pathname ?? null);
      },
    });

    expect(response?.headers.get("x-vinext-cache")).toBe("STALE");
    await expect(response?.text()).resolves.toBe("from-stale");
    expect(scheduledRegenerations).toHaveLength(1);

    await scheduledRegenerations[0]();

    expect(isrSetCalls).toEqual([
      {
        key: "route:/api/stale",
        revalidateSeconds: 60,
        tags: ["/api/stale", "tag:regen"],
      },
    ]);
    expect(navigationCalls).toEqual(["/api/stale", null]);
  });

  it("skips regeneration writes when the stale handler reads dynamic request data", async () => {
    const dynamicUsage = createDynamicUsageState();
    const routePattern = "/api/stale-dynamic-" + Date.now();
    const scheduledRegens: Array<() => Promise<void>> = [];
    let wroteCache = false;

    await readAppRouteHandlerCacheResponse({
      buildPageCacheTags(pathname, extraTags) {
        return [pathname, ...extraTags];
      },
      cleanPathname: "/api/stale-dynamic",
      clearRequestContext() {},
      consumeDynamicUsage: dynamicUsage.consumeDynamicUsage,
      getCollectedFetchTags() {
        return [];
      },
      handlerFn(request) {
        return Response.json({
          ping: request.headers.get("x-test"),
        });
      },
      isAutoHead: false,
      async isrGet() {
        return buildISRCacheEntry(buildCachedRouteValue("from-stale"), true);
      },
      isrRouteKey(pathname) {
        return "route:" + pathname;
      },
      async isrSet() {
        wroteCache = true;
      },
      markDynamicUsage: dynamicUsage.markDynamicUsage,
      middlewareContext: { headers: null, status: null },
      params: {},
      requestUrl: "https://example.com/api/stale-dynamic",
      revalidateSearchParams: new URLSearchParams(),
      revalidateSeconds: 60,
      routePattern,
      async runInRevalidationContext(renderFn) {
        await renderFn();
      },
      scheduleBackgroundRegeneration(_key, renderFn) {
        scheduledRegens.push(renderFn);
      },
      setNavigationContext() {},
    });

    const scheduledRegenRun = scheduledRegens[0];
    expect(scheduledRegens).toHaveLength(1);
    if (!scheduledRegenRun) {
      throw new Error("Expected scheduled route regeneration");
    }
    await scheduledRegenRun();

    expect(wroteCache).toBe(false);
    expect(isKnownDynamicAppRoute(routePattern)).toBe(true);
  });

  it("falls through on cache read errors", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await readAppRouteHandlerCacheResponse({
      buildPageCacheTags(pathname, extraTags) {
        return [pathname, ...extraTags];
      },
      cleanPathname: "/api/cache-error",
      clearRequestContext() {},
      consumeDynamicUsage() {
        return false;
      },
      getCollectedFetchTags() {
        return [];
      },
      handlerFn() {
        throw new Error("should not run");
      },
      isAutoHead: false,
      async isrGet() {
        throw new Error("cache blew up");
      },
      isrRouteKey(pathname) {
        return "route:" + pathname;
      },
      async isrSet() {},
      markDynamicUsage() {},
      middlewareContext: { headers: null, status: null },
      params: {},
      requestUrl: "https://example.com/api/cache-error",
      revalidateSearchParams: new URLSearchParams(),
      revalidateSeconds: 60,
      routePattern: "/api/cache-error",
      async runInRevalidationContext(renderFn) {
        await renderFn();
      },
      scheduleBackgroundRegeneration() {},
      setNavigationContext() {},
    });

    expect(response).toBeNull();
    expect(errorSpy).toHaveBeenCalledOnce();
    errorSpy.mockRestore();
  });
});
