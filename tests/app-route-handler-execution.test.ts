import { describe, expect, it, vi } from "vite-plus/test";
import { isKnownDynamicAppRoute } from "../packages/vinext/src/server/app-route-handler-runtime.js";
import {
  executeAppRouteHandler,
  runAppRouteHandler,
} from "../packages/vinext/src/server/app-route-handler-execution.js";

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

describe("app route handler execution helpers", () => {
  it("runs route handlers with tracked requests and returns dynamic usage", async () => {
    const dynamicUsage = createDynamicUsageState();
    let receivedParams: Record<string, string | string[]> | null = null;

    const { dynamicUsedInHandler, response } = await runAppRouteHandler({
      consumeDynamicUsage: dynamicUsage.consumeDynamicUsage,
      handlerFn(request, context) {
        receivedParams = context.params;
        return Response.json({
          header: request.headers.get("x-test"),
        });
      },
      markDynamicUsage: dynamicUsage.markDynamicUsage,
      params: { slug: "demo" },
      request: new Request("https://example.com/api/demo", {
        headers: { "x-test": "pong" },
      }),
    });

    expect(receivedParams).toEqual({ slug: "demo" });
    expect(dynamicUsedInHandler).toBe(true);
    await expect(response.json()).resolves.toEqual({ header: "pong" });
  });

  it("finalizes static route handler responses and schedules cache writes", async () => {
    const dynamicUsage = createDynamicUsageState();
    const waitUntilPromises: Promise<unknown>[] = [];
    const isrSetCalls: Array<{
      key: string;
      revalidateSeconds: number;
      tags: string[];
    }> = [];
    const phaseCalls: string[] = [];
    const reportCalls: Error[] = [];
    let didClearRequestContext = false;

    const response = await executeAppRouteHandler({
      buildPageCacheTags(pathname, extraTags) {
        return [pathname, ...extraTags];
      },
      cleanPathname: "/api/static-data",
      clearRequestContext() {
        didClearRequestContext = true;
      },
      consumeDynamicUsage: dynamicUsage.consumeDynamicUsage,
      executionContext: {
        waitUntil(promise) {
          waitUntilPromises.push(promise);
        },
      },
      getAndClearPendingCookies() {
        return ["session=1; Path=/"];
      },
      getCollectedFetchTags() {
        return ["tag:demo"];
      },
      getDraftModeCookieHeader() {
        return "draft=1; Path=/";
      },
      handler: { dynamic: "auto" },
      handlerFn() {
        return new Response("ok", {
          status: 201,
          headers: {
            "content-type": "text/plain",
          },
        });
      },
      isAutoHead: false,
      isProduction: true,
      isrDebug() {},
      isrRouteKey(pathname) {
        return "route:" + pathname;
      },
      async isrSet(key, value, revalidateSeconds, tags) {
        expect(value.kind).toBe("APP_ROUTE");
        isrSetCalls.push({ key, revalidateSeconds, tags });
      },
      markDynamicUsage: dynamicUsage.markDynamicUsage,
      method: "GET",
      middlewareContext: {
        headers: new Headers([["x-middleware", "present"]]),
        status: 202,
      },
      params: { slug: "demo" },
      reportRequestError(error) {
        reportCalls.push(error);
      },
      request: new Request("https://example.com/api/static-data"),
      revalidateSeconds: 60,
      routePattern: "/api/static-data",
      setHeadersAccessPhase(phase) {
        phaseCalls.push(phase);
        return "render";
      },
    });

    await Promise.all(waitUntilPromises);

    expect(response.status).toBe(202);
    expect(response.headers.get("cache-control")).toBe("s-maxage=60, stale-while-revalidate");
    expect(response.headers.get("x-vinext-cache")).toBe("MISS");
    expect(response.headers.get("x-middleware")).toBe("present");
    expect(response.headers.getSetCookie?.()).toEqual(["session=1; Path=/", "draft=1; Path=/"]);
    await expect(response.text()).resolves.toBe("ok");
    expect(isrSetCalls).toEqual([
      {
        key: "route:/api/static-data",
        revalidateSeconds: 60,
        tags: ["/api/static-data", "tag:demo"],
      },
    ]);
    expect(phaseCalls).toEqual(["route-handler", "render"]);
    expect(didClearRequestContext).toBe(true);
    expect(reportCalls).toEqual([]);
  });

  it("marks dynamic route handlers and skips cache writes when request data is read", async () => {
    const dynamicUsage = createDynamicUsageState();
    const routePattern = "/api/dynamic-" + Date.now();
    let wroteCache = false;

    const response = await executeAppRouteHandler({
      buildPageCacheTags(pathname, extraTags) {
        return [pathname, ...extraTags];
      },
      cleanPathname: "/api/dynamic",
      clearRequestContext() {},
      consumeDynamicUsage: dynamicUsage.consumeDynamicUsage,
      executionContext: null,
      getAndClearPendingCookies() {
        return [];
      },
      getCollectedFetchTags() {
        return [];
      },
      getDraftModeCookieHeader() {
        return null;
      },
      handler: { dynamic: "auto" },
      handlerFn(request) {
        return Response.json({
          ping: request.headers.get("x-test"),
        });
      },
      isAutoHead: false,
      isProduction: true,
      isrRouteKey(pathname) {
        return "route:" + pathname;
      },
      async isrSet() {
        wroteCache = true;
      },
      markDynamicUsage: dynamicUsage.markDynamicUsage,
      method: "GET",
      middlewareContext: { headers: null, status: null },
      params: {},
      reportRequestError() {},
      request: new Request("https://example.com/api/dynamic", {
        headers: { "x-test": "from-header" },
      }),
      revalidateSeconds: 60,
      routePattern,
      setHeadersAccessPhase() {
        return "render";
      },
    });

    expect(isKnownDynamicAppRoute(routePattern)).toBe(true);
    expect(response.headers.get("cache-control")).toBeNull();
    expect(response.headers.get("x-vinext-cache")).toBeNull();
    expect(wroteCache).toBe(false);
    await expect(response.json()).resolves.toEqual({ ping: "from-header" });
  });

  it("maps special route handler errors and reports generic failures", async () => {
    const dynamicUsage = createDynamicUsageState();
    const reportedErrors: Error[] = [];
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const redirectResponse = await executeAppRouteHandler({
      buildPageCacheTags(pathname, extraTags) {
        return [pathname, ...extraTags];
      },
      cleanPathname: "/api/redirect",
      clearRequestContext() {},
      consumeDynamicUsage: dynamicUsage.consumeDynamicUsage,
      executionContext: null,
      getAndClearPendingCookies() {
        return [];
      },
      getCollectedFetchTags() {
        return [];
      },
      getDraftModeCookieHeader() {
        return null;
      },
      handler: { dynamic: "auto" },
      handlerFn() {
        throw { digest: "NEXT_REDIRECT;replace;%2Ftarget;308" };
      },
      isAutoHead: false,
      isProduction: true,
      isrRouteKey(pathname) {
        return "route:" + pathname;
      },
      async isrSet() {},
      markDynamicUsage: dynamicUsage.markDynamicUsage,
      method: "GET",
      middlewareContext: { headers: null, status: null },
      params: {},
      reportRequestError(error) {
        reportedErrors.push(error);
      },
      request: new Request("https://example.com/api/redirect"),
      revalidateSeconds: 60,
      routePattern: "/api/redirect",
      setHeadersAccessPhase() {
        return "render";
      },
    });

    expect(redirectResponse.status).toBe(308);
    expect(redirectResponse.headers.get("location")).toBe("https://example.com/target");
    expect(reportedErrors).toEqual([]);

    const errorResponse = await executeAppRouteHandler({
      buildPageCacheTags(pathname, extraTags) {
        return [pathname, ...extraTags];
      },
      cleanPathname: "/api/error",
      clearRequestContext() {},
      consumeDynamicUsage: dynamicUsage.consumeDynamicUsage,
      executionContext: null,
      getAndClearPendingCookies() {
        return [];
      },
      getCollectedFetchTags() {
        return [];
      },
      getDraftModeCookieHeader() {
        return null;
      },
      handler: { dynamic: "auto" },
      handlerFn() {
        throw new Error("boom");
      },
      isAutoHead: false,
      isProduction: true,
      isrRouteKey(pathname) {
        return "route:" + pathname;
      },
      async isrSet() {},
      markDynamicUsage: dynamicUsage.markDynamicUsage,
      method: "GET",
      middlewareContext: { headers: null, status: null },
      params: {},
      reportRequestError(error) {
        reportedErrors.push(error);
      },
      request: new Request("https://example.com/api/error"),
      revalidateSeconds: 60,
      routePattern: "/api/error",
      setHeadersAccessPhase() {
        return "render";
      },
    });

    expect(errorResponse.status).toBe(500);
    expect(reportedErrors.map((error) => error.message)).toEqual(["boom"]);

    errorSpy.mockRestore();
  });
});
