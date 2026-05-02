import { describe, expect, it, vi } from "vite-plus/test";
import { readAppRouteHandlerCacheResponse } from "../packages/vinext/src/server/app-route-handler-cache.js";
import { isKnownDynamicAppRoute } from "../packages/vinext/src/server/app-route-handler-runtime.js";
import type { ISRCacheEntry } from "../packages/vinext/src/server/isr-cache.js";
import type { CachedRouteValue } from "../packages/vinext/src/shims/cache.js";
import type { HeadersAccessPhase } from "../packages/vinext/src/shims/headers.js";

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
      setHeadersAccessPhase() {
        return "render";
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
      expireSeconds: number | undefined;
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
      async isrSet(key, value, revalidateSeconds, tags, expireSeconds) {
        expect(value.kind).toBe("APP_ROUTE");
        isrSetCalls.push({ key, expireSeconds, revalidateSeconds, tags });
      },
      markDynamicUsage: dynamicUsage.markDynamicUsage,
      middlewareContext: { headers: null, status: null },
      params: { slug: "demo" },
      requestUrl: "https://example.com/base/api/stale?ping=pong",
      revalidateSearchParams: new URLSearchParams("ping=pong"),
      expireSeconds: 300,
      revalidateSeconds: 60,
      routePattern: "/api/stale",
      async runInRevalidationContext(renderFn) {
        await renderFn();
      },
      scheduleBackgroundRegeneration(_key, renderFn) {
        scheduledRegenerations.push(renderFn);
      },
      setHeadersAccessPhase() {
        return "render";
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
        expireSeconds: 300,
        revalidateSeconds: 60,
        tags: ["/api/stale", "tag:regen"],
      },
    ]);
    expect(navigationCalls).toEqual(["/api/stale", null]);
  });

  it("sets the route-handler header access phase while stale route handlers regenerate", async () => {
    const dynamicUsage = createDynamicUsageState();
    const scheduledRegens: Array<() => Promise<void>> = [];
    const phases: string[] = [];
    const options = {
      buildPageCacheTags(pathname: string, extraTags: string[]) {
        return [pathname, ...extraTags];
      },
      cleanPathname: "/api/stale-force-static",
      clearRequestContext() {},
      consumeDynamicUsage: dynamicUsage.consumeDynamicUsage,
      dynamicConfig: "force-static",
      getCollectedFetchTags() {
        return [];
      },
      handlerFn() {
        return new Response("regenerated");
      },
      isAutoHead: false,
      async isrGet() {
        return buildISRCacheEntry(buildCachedRouteValue("from-stale"), true);
      },
      isrRouteKey(pathname: string) {
        return "route:" + pathname;
      },
      async isrSet() {},
      markDynamicUsage: dynamicUsage.markDynamicUsage,
      middlewareContext: { headers: null, status: null },
      params: {},
      requestUrl: "https://example.com/api/stale-force-static",
      revalidateSearchParams: new URLSearchParams(),
      revalidateSeconds: 60,
      routePattern: "/api/stale-force-static",
      async runInRevalidationContext(renderFn: () => Promise<void>) {
        await renderFn();
      },
      scheduleBackgroundRegeneration(_key: string, renderFn: () => Promise<void>) {
        scheduledRegens.push(renderFn);
      },
      setHeadersAccessPhase(phase: HeadersAccessPhase): HeadersAccessPhase {
        phases.push(phase);
        return "render";
      },
      setNavigationContext() {},
    };

    await readAppRouteHandlerCacheResponse(options);

    const scheduledRegenRun = scheduledRegens[0];
    expect(scheduledRegens).toHaveLength(1);
    if (!scheduledRegenRun) {
      throw new Error("Expected scheduled route regeneration");
    }
    await scheduledRegenRun();

    expect(phases).toEqual(["route-handler"]);
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
      setHeadersAccessPhase() {
        return "render";
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

  it("rejects invalid route handler responses during background regeneration", async () => {
    const dynamicUsage = createDynamicUsageState();
    const scheduledRegens: Array<() => Promise<void>> = [];
    let wroteCache = false;

    const response = await readAppRouteHandlerCacheResponse({
      buildPageCacheTags(pathname, extraTags) {
        return [pathname, ...extraTags];
      },
      cleanPathname: "/api/stale-invalid",
      clearRequestContext() {},
      consumeDynamicUsage: dynamicUsage.consumeDynamicUsage,
      getCollectedFetchTags() {
        return [];
      },
      handlerFn() {
        return new Response("should not be cached", {
          headers: { "x-middleware-next": "1" },
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
      requestUrl: "https://example.com/api/stale-invalid",
      revalidateSearchParams: new URLSearchParams(),
      revalidateSeconds: 60,
      routePattern: "/api/stale-invalid",
      async runInRevalidationContext(renderFn) {
        await renderFn();
      },
      scheduleBackgroundRegeneration(_key, renderFn) {
        scheduledRegens.push(renderFn);
      },
      setHeadersAccessPhase() {
        return "render";
      },
      setNavigationContext() {},
    });

    expect(response?.headers.get("x-vinext-cache")).toBe("STALE");
    await expect(response?.text()).resolves.toBe("from-stale");
    expect(scheduledRegens).toHaveLength(1);

    const scheduledRegenRun = scheduledRegens[0];
    if (!scheduledRegenRun) {
      throw new Error("Expected scheduled route regeneration");
    }

    await expect(scheduledRegenRun()).rejects.toThrow(
      "NextResponse.next() was used in a app route handler",
    );
    expect(wroteCache).toBe(false);
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
      setHeadersAccessPhase() {
        return "render";
      },
      setNavigationContext() {},
    });

    expect(response).toBeNull();
    expect(errorSpy).toHaveBeenCalledOnce();
    errorSpy.mockRestore();
  });
});
