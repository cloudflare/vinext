import { describe, expect, it, vi } from "vite-plus/test";
import {
  consumeDynamicUsage,
  cookies,
  draftMode,
  headers,
  markDynamicUsage,
  setHeadersContext,
} from "../packages/vinext/src/shims/headers.js";
import { isKnownDynamicAppRoute } from "../packages/vinext/src/server/app-route-handler-runtime.js";
import {
  executeAppRouteHandler,
  runAppRouteHandler,
} from "../packages/vinext/src/server/app-route-handler-execution.js";

// The fetch-cache shim captures `originalFetch` from globalThis at import
// time, so stub fetch BEFORE importing it (same pattern as
// tests/fetch-cache.test.ts). None of the static imports above pull
// fetch-cache.js into the runtime module graph — its only reference there is
// the type-only `FetchCacheState` re-export — so the stub is in place before
// the capture happens.
const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
  Response.json({ ok: true }),
);
vi.stubGlobal("fetch", fetchMock);
const { withFetchCache } = await import("../packages/vinext/src/shims/fetch-cache.js");

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

  it("runs force-static route handlers with empty request APIs without marking dynamic usage", async () => {
    const dynamicUsage = createDynamicUsageState();

    try {
      const { dynamicUsedInHandler, response } = await runAppRouteHandler({
        consumeDynamicUsage: dynamicUsage.consumeDynamicUsage,
        dynamicConfig: "force-static",
        async handlerFn(request) {
          const headerStore = await headers();
          const cookieStore = await cookies();
          const draft = await draftMode();
          const draftModeInitiallyEnabled = draft.isEnabled;
          draft.disable();
          return Response.json({
            cookie: cookieStore.get("session")?.value ?? null,
            draftMode: draftModeInitiallyEnabled,
            draftModeAfterDisable: draft.isEnabled,
            geo: request.geo ?? null,
            header: headerStore.get("x-test"),
            ip: request.ip ?? null,
            requestCookie: request.cookies.get("session")?.value ?? null,
            requestHeader: request.headers.get("x-test"),
            requestUrl: request.url,
            search: request.nextUrl.search,
            searchParam: request.nextUrl.searchParams.get("token"),
          });
        },
        markDynamicUsage: dynamicUsage.markDynamicUsage,
        params: {},
        request: new Request("https://tenant.example.com/api/static?token=secret", {
          headers: {
            "cf-connecting-ip": "203.0.113.10",
            "cf-ipcountry": "AU",
            cookie: "session=abc; __prerender_bypass=draft-secret",
            "x-test": "pong",
          },
        }),
        routePattern: "/api/static",
        draftModeSecret: "draft-secret",
        setHeadersAccessPhase() {
          return "render";
        },
      });

      expect(dynamicUsedInHandler).toBe(false);
      await expect(response.json()).resolves.toEqual({
        cookie: null,
        draftMode: true,
        draftModeAfterDisable: false,
        geo: null,
        header: null,
        ip: null,
        requestCookie: null,
        requestHeader: null,
        requestUrl: "http://localhost:3000/api/static",
        search: "",
        searchParam: null,
      });
    } finally {
      setHeadersContext(null);
    }
  });

  it("finalizes static route handler responses and schedules cache writes", async () => {
    const dynamicUsage = createDynamicUsageState();
    const waitUntilPromises: Promise<unknown>[] = [];
    const isrSetCalls: Array<{
      key: string;
      expireSeconds: number | undefined;
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
      async isrSet(key, value, revalidateSeconds, tags, expireSeconds) {
        expect(value.kind).toBe("APP_ROUTE");
        isrSetCalls.push({ key, expireSeconds, revalidateSeconds, tags });
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
      expireSeconds: 300,
      revalidateSeconds: 60,
      routePattern: "/api/static-data",
      setHeadersAccessPhase(phase) {
        phaseCalls.push(phase);
        return "render";
      },
    });

    await Promise.all(waitUntilPromises);

    expect(response.status).toBe(202);
    expect(response.headers.get("cache-control")).toBe("s-maxage=60, stale-while-revalidate=240");
    expect(response.headers.get("x-vinext-cache")).toBe("MISS");
    expect(response.headers.get("x-middleware")).toBe("present");
    expect(response.headers.getSetCookie?.()).toEqual(["session=1; Path=/", "draft=1; Path=/"]);
    await expect(response.text()).resolves.toBe("ok");
    expect(isrSetCalls).toEqual([
      {
        key: "route:/api/static-data",
        expireSeconds: 300,
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

  it("skips cache writes and marks the route dynamic when a revalidating handler fetches with no-store", async () => {
    // Regression test for the patched fetch's explicit no-store branch
    // calling markDynamicUsage() (upstream patch-fetch parity, where
    // markCurrentScopeAsDynamic bails ISR for the surrounding scope): a route
    // handler with `revalidate = 60` that performs
    // `fetch(url, { cache: "no-store" })` must not write its ISR entry and
    // must be marked known-dynamic. Uses the real headers-shim
    // consumeDynamicUsage/markDynamicUsage pair — the same wiring as
    // app-route-handler-dispatch — so the mark set by the fetch shim flows
    // into `dynamicUsedInHandler`.
    const routePattern = "/api/no-store-fetch-" + Date.now();
    const waitUntilPromises: Promise<unknown>[] = [];
    let wroteCache = false;
    const restoreFetchCache = withFetchCache();

    try {
      // Clear any dynamic usage left over from earlier tests.
      consumeDynamicUsage();

      const response = await executeAppRouteHandler({
        buildPageCacheTags(pathname, extraTags) {
          return [pathname, ...extraTags];
        },
        cleanPathname: "/api/no-store-fetch",
        clearRequestContext() {},
        consumeDynamicUsage,
        executionContext: {
          waitUntil(promise) {
            waitUntilPromises.push(promise);
          },
        },
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
        async handlerFn() {
          const upstream = await fetch("https://api.example.com/live", {
            cache: "no-store",
          });
          return Response.json(await upstream.json());
        },
        isAutoHead: false,
        isProduction: true,
        isrRouteKey(pathname) {
          return "route:" + pathname;
        },
        async isrSet() {
          wroteCache = true;
        },
        markDynamicUsage,
        method: "GET",
        middlewareContext: { headers: null, status: null },
        params: {},
        reportRequestError() {},
        request: new Request("https://example.com/api/no-store-fetch"),
        revalidateSeconds: 60,
        routePattern,
        setHeadersAccessPhase() {
          return "render";
        },
      });

      await Promise.all(waitUntilPromises);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.example.com/live");
      expect(fetchMock.mock.calls[0]?.[1]?.cache).toBe("no-store");
      expect(isKnownDynamicAppRoute(routePattern)).toBe(true);
      expect(wroteCache).toBe(false);
      expect(response.headers.get("cache-control")).toBeNull();
      expect(response.headers.get("x-vinext-cache")).toBeNull();
      await expect(response.json()).resolves.toEqual({ ok: true });
    } finally {
      consumeDynamicUsage();
      restoreFetchCache();
    }
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

  it("rejects middleware control responses returned from route handlers", async () => {
    // The NextResponse.next() case is ported from Next.js:
    // test/e2e/app-dir/app-routes/app-custom-routes.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/app-routes/app-custom-routes.test.ts
    // The NextResponse.rewrite() case mirrors the adjacent App Route module validation.
    const cases = [
      {
        headerName: "x-middleware-next",
        headerValue: "1",
        message:
          "NextResponse.next() was used in a app route handler, this is not supported. See here for more info: https://nextjs.org/docs/messages/next-response-next-in-app-route-handler",
      },
      {
        headerName: "x-middleware-rewrite",
        headerValue: "https://example.com/rewritten",
        message:
          "NextResponse.rewrite() was used in a app route handler, this is not currently supported. Please remove the invocation to continue.",
      },
    ];

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      for (const testCase of cases) {
        const dynamicUsage = createDynamicUsageState();
        const reportedErrors: Error[] = [];
        let wroteCache = false;
        let didClearRequestContext = false;

        const response = await executeAppRouteHandler({
          buildPageCacheTags(pathname, extraTags) {
            return [pathname, ...extraTags];
          },
          cleanPathname: "/api/middleware-control",
          clearRequestContext() {
            didClearRequestContext = true;
          },
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
            return new Response("should not be sent", {
              headers: { [testCase.headerName]: testCase.headerValue },
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
          reportRequestError(error) {
            reportedErrors.push(error);
          },
          request: new Request("https://example.com/api/middleware-control"),
          revalidateSeconds: 60,
          routePattern: "/api/middleware-control",
          setHeadersAccessPhase() {
            return "render";
          },
        });

        expect(response.status).toBe(500);
        await expect(response.text()).resolves.toBe("");
        expect(reportedErrors.map((error) => error.message)).toEqual([testCase.message]);
        expect(wroteCache).toBe(false);
        expect(didClearRequestContext).toBe(true);
      }
    } finally {
      errorSpy.mockRestore();
    }
  });
});
