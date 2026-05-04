import { describe, expect, it, vi } from "vite-plus/test";
import { dispatchAppRouteHandler } from "../packages/vinext/src/server/app-route-handler-dispatch.js";
import type { CachedRouteValue } from "../packages/vinext/src/shims/cache.js";
import type { ISRCacheEntry } from "../packages/vinext/src/server/isr-cache.js";

function buildCachedRouteValue(body: string): CachedRouteValue {
  return {
    kind: "APP_ROUTE",
    body: new TextEncoder().encode(body).buffer,
    status: 200,
    headers: {
      "content-type": "text/plain",
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

describe("app route handler dispatch", () => {
  it("rejects invalid HTTP methods with 400 before auto-OPTIONS/405 logic", async () => {
    // Ported from Next.js: test/e2e/app-dir/app-routes/app-custom-routes.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/app-routes/app-custom-routes.test.ts#L531-L538
    const route = {
      pattern: "/api/status",
      routeHandler: {
        GET() {
          throw new Error("GET should not run for invalid methods");
        },
      },
      routeSegments: ["api", "status"],
    };
    let clearCount = 0;

    const invalidMethodResponse = await dispatchAppRouteHandler({
      cleanPathname: "/api/status",
      clearRequestContext() {
        clearCount += 1;
      },
      i18n: null,
      isDevelopment: false,
      isProduction: false,
      async isrGet() {
        throw new Error("invalid method should not read route cache");
      },
      isrRouteKey(pathname) {
        return "route:" + pathname;
      },
      async isrSet() {
        throw new Error("invalid method should not write route cache");
      },
      middlewareContext: {
        headers: new Headers([["x-middleware", "present"]]),
        status: null,
      },
      middlewareRequestHeaders: null,
      params: {},
      request: new Request("https://example.com/api/status", { method: "HEADER" }),
      route,
      scheduleBackgroundRegeneration() {
        throw new Error("invalid method should not schedule regeneration");
      },
      searchParams: new URLSearchParams(),
    });

    expect(invalidMethodResponse.status).toBe(400);
    expect(invalidMethodResponse.headers.get("x-middleware")).toBe("present");
    await expect(invalidMethodResponse.text()).resolves.toBe("");
    expect(clearCount).toBe(1);
  });

  it("handles framework-generated OPTIONS responses and unsupported methods at the dispatch boundary", async () => {
    const route = {
      pattern: "/api/demo",
      routeHandler: {
        GET() {
          throw new Error("GET should not run for OPTIONS or DELETE");
        },
        POST() {
          throw new Error("POST should not run for OPTIONS or DELETE");
        },
      },
      routeSegments: ["api", "demo"],
    };
    let clearCount = 0;

    const optionsResponse = await dispatchAppRouteHandler({
      cleanPathname: "/api/demo",
      clearRequestContext() {
        clearCount += 1;
      },
      i18n: null,
      isDevelopment: false,
      isProduction: false,
      async isrGet() {
        throw new Error("OPTIONS should not read route cache");
      },
      isrRouteKey(pathname) {
        return "route:" + pathname;
      },
      async isrSet() {
        throw new Error("OPTIONS should not write route cache");
      },
      middlewareContext: {
        headers: new Headers([["x-middleware", "present"]]),
        status: null,
      },
      middlewareRequestHeaders: null,
      params: {},
      request: new Request("https://example.com/api/demo", { method: "OPTIONS" }),
      route,
      scheduleBackgroundRegeneration() {
        throw new Error("OPTIONS should not schedule regeneration");
      },
      searchParams: new URLSearchParams(),
    });

    expect(optionsResponse.status).toBe(204);
    expect(optionsResponse.headers.get("allow")).toBe("GET, HEAD, OPTIONS, POST");
    expect(optionsResponse.headers.get("x-middleware")).toBe("present");
    await expect(optionsResponse.text()).resolves.toBe("");

    const unsupportedResponse = await dispatchAppRouteHandler({
      cleanPathname: "/api/demo",
      clearRequestContext() {
        clearCount += 1;
      },
      i18n: null,
      isDevelopment: false,
      isProduction: false,
      async isrGet() {
        throw new Error("DELETE should not read route cache");
      },
      isrRouteKey(pathname) {
        return "route:" + pathname;
      },
      async isrSet() {
        throw new Error("DELETE should not write route cache");
      },
      middlewareContext: {
        headers: new Headers([["x-middleware-delete", "present"]]),
        status: null,
      },
      middlewareRequestHeaders: null,
      params: {},
      request: new Request("https://example.com/api/demo", { method: "DELETE" }),
      route,
      scheduleBackgroundRegeneration() {
        throw new Error("DELETE should not schedule regeneration");
      },
      searchParams: new URLSearchParams(),
    });

    expect(unsupportedResponse.status).toBe(405);
    expect(unsupportedResponse.headers.get("x-middleware-delete")).toBe("present");
    await expect(unsupportedResponse.text()).resolves.toBe("");
    expect(clearCount).toBe(2);
  });

  it("reads eligible ISR route handler responses before executing user code", async () => {
    const handlerSpy = vi.fn(() => new Response("should not run"));
    let didClearRequestContext = false;
    let requestedCacheKey: string | null = null;

    const response = await dispatchAppRouteHandler({
      cleanPathname: "/api/static",
      clearRequestContext() {
        didClearRequestContext = true;
      },
      i18n: null,
      isDevelopment: false,
      isProduction: true,
      async isrGet(key) {
        requestedCacheKey = key;
        return buildISRCacheEntry(buildCachedRouteValue("from-cache"));
      },
      isrRouteKey(pathname) {
        return "route:" + pathname;
      },
      async isrSet() {
        throw new Error("cache hit should not write route cache");
      },
      middlewareContext: { headers: null, status: null },
      middlewareRequestHeaders: null,
      params: {},
      request: new Request("https://example.com/api/static"),
      route: {
        pattern: "/api/static",
        routeHandler: {
          GET: handlerSpy,
          revalidate: 60,
        },
        routeSegments: ["api", "static"],
      },
      scheduleBackgroundRegeneration() {
        throw new Error("fresh cache hit should not schedule regeneration");
      },
      searchParams: new URLSearchParams(),
    });

    expect(requestedCacheKey).toBe("route:/api/static");
    expect(response.status).toBe(200);
    expect(response.headers.get("x-vinext-cache")).toBe("HIT");
    await expect(response.text()).resolves.toBe("from-cache");
    expect(handlerSpy).not.toHaveBeenCalled();
    expect(didClearRequestContext).toBe(true);
  });

  it("attaches App Router route context when stale route handler cache schedules regeneration", async () => {
    const handlerSpy = vi.fn(() => new Response("regenerated"));
    let scheduledContext:
      | {
          routerKind: "App Router";
          routePath: string;
          routeType: "route";
        }
      | undefined;

    const response = await dispatchAppRouteHandler({
      cleanPathname: "/api/stale",
      clearRequestContext() {},
      i18n: null,
      isDevelopment: false,
      isProduction: true,
      async isrGet() {
        return buildISRCacheEntry(buildCachedRouteValue("stale"), true);
      },
      isrRouteKey(pathname) {
        return "route:" + pathname;
      },
      async isrSet() {
        throw new Error("stale response should not synchronously write route cache");
      },
      middlewareContext: { headers: null, status: null },
      middlewareRequestHeaders: null,
      params: {},
      request: new Request("https://example.com/api/stale"),
      route: {
        pattern: "/api/stale",
        routeHandler: {
          GET: handlerSpy,
          revalidate: 60,
        },
        routeSegments: ["api", "stale"],
      },
      scheduleBackgroundRegeneration(_key, _renderFn, errorContext) {
        scheduledContext = errorContext;
      },
      searchParams: new URLSearchParams(),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("x-vinext-cache")).toBe("STALE");
    await expect(response.text()).resolves.toBe("stale");
    expect(handlerSpy).not.toHaveBeenCalled();
    expect(scheduledContext).toEqual({
      routerKind: "App Router",
      routePath: "/api/stale",
      routeType: "route",
    });
  });
});
