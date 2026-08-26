import { describe, expect, it, vi } from "vite-plus/test";
import {
  consumeDynamicUsage,
  cookies,
  draftMode,
  getActiveDraftModeState,
  getAndClearPendingCookies,
  getDraftModeCookieHeader,
  headers,
  markDynamicUsage,
  setHeadersAccessPhase,
  setHeadersContext,
} from "../packages/vinext/src/shims/headers.js";
import { isKnownDynamicAppRoute } from "../packages/vinext/src/server/app-route-handler-runtime.js";
import {
  executeAppRouteHandler,
  runAppRouteHandler,
} from "../packages/vinext/src/server/app-route-handler-execution.js";
import { getRootParam, runWithRootParamsScope } from "../packages/vinext/src/shims/root-params.js";
import {
  getDataCacheHandler,
  setDataCacheHandler,
  type CachedRouteValue,
} from "../packages/vinext/src/shims/cache-handler.js";
import {
  createRequestContext,
  runWithRequestContext,
} from "../packages/vinext/src/shims/unified-request-context.js";
import { CACHEABILITY_RESPONSE_CAPTURE_TIMEOUT_MS } from "../packages/vinext/src/server/cacheability-request.js";

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
const { revalidateTag, unstable_cache } = await import("../packages/vinext/src/shims/cache.js");

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

  // Ported from Next.js: test/e2e/app-dir/app-root-params-getters/simple.test.ts
  // https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-dir/app-root-params-getters/simple.test.ts
  it("rejects next/root-params inside route handlers", async () => {
    const dynamicUsage = createDynamicUsageState();

    await expect(
      runAppRouteHandler({
        consumeDynamicUsage: dynamicUsage.consumeDynamicUsage,
        async handlerFn() {
          await getRootParam("lang");
          return new Response("unreachable");
        },
        markDynamicUsage: dynamicUsage.markDynamicUsage,
        params: { lang: "en", locale: "us" },
        request: new Request("https://example.com/en/us/route-handler"),
        routePattern: "/[lang]/[locale]/route-handler",
      }),
    ).rejects.toThrow(
      "Route /[lang]/[locale]/route-handler used `import('next/root-params').lang()` inside a Route Handler. Support for this API in Route Handlers is planned for a future version of Next.js.",
    );
  });

  it("keeps route-handler root params restrictions for deferred work", async () => {
    const dynamicUsage = createDynamicUsageState();
    let deferredRead!: Promise<string | string[] | undefined>;
    let releaseDeferred!: () => void;
    const deferred = new Promise<void>((resolve) => {
      releaseDeferred = resolve;
    });

    await runWithRootParamsScope({ lang: "en" }, () =>
      runAppRouteHandler({
        consumeDynamicUsage: dynamicUsage.consumeDynamicUsage,
        async handlerFn() {
          deferredRead = deferred.then(() => getRootParam("lang"));
          return new Response("ok");
        },
        markDynamicUsage: dynamicUsage.markDynamicUsage,
        params: { lang: "en" },
        request: new Request("https://example.com/en/route-handler"),
        routePattern: "/[lang]/route-handler",
      }),
    );

    releaseDeferred();
    await expect(deferredRead).rejects.toThrow("inside a Route Handler");
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
      revalidateSeconds: number | false;
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
        return null;
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
      async isrSet(key, value, policy) {
        expect(value.kind).toBe("APP_ROUTE");
        isrSetCalls.push({
          key,
          expireSeconds: policy.cacheControl.expire,
          revalidateSeconds: policy.cacheControl.revalidate,
          tags: policy.tags ?? [],
        });
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
    expect(response.headers.getSetCookie?.()).toEqual(["session=1; Path=/"]);
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

  it("observes dynamic API usage while a cacheable Route Handler stream is consumed", async () => {
    const dynamicUsage = createDynamicUsageState();
    const isrSet = vi.fn(async () => {});
    const routePattern = `/api/late-dynamic-${Date.now()}`;

    const response = await executeAppRouteHandler({
      buildPageCacheTags: () => [],
      cleanPathname: routePattern,
      clearRequestContext() {},
      consumeDynamicUsage: dynamicUsage.consumeDynamicUsage,
      executionContext: null,
      getAndClearPendingCookies: () => [],
      getCollectedFetchTags: () => [],
      getDraftModeCookieHeader: () => null,
      handler: { revalidate: false },
      handlerFn() {
        return new Response(
          new ReadableStream({
            pull(controller) {
              dynamicUsage.markDynamicUsage();
              controller.enqueue(new TextEncoder().encode("late dynamic"));
              controller.close();
            },
          }),
        );
      },
      isAutoHead: false,
      isProduction: true,
      isrRouteKey: (pathname) => `route:${pathname}`,
      isrSet,
      markDynamicUsage: dynamicUsage.markDynamicUsage,
      method: "GET",
      middlewareContext: { headers: null, status: null },
      observeCompletedBody: true,
      params: null,
      reportRequestError() {},
      request: new Request(`https://example.com${routePattern}`),
      revalidateSeconds: Infinity,
      routePattern,
      setHeadersAccessPhase: () => "render",
    });

    expect(isKnownDynamicAppRoute(routePattern)).toBe(true);
    expect(isrSet).not.toHaveBeenCalled();
    expect(response.headers.get("cache-control")).toBeNull();
    await expect(response.text()).resolves.toBe("late dynamic");
  });

  it("classifies Cache Components handlers that cross a task boundary as dynamic", async () => {
    const dynamicUsage = createDynamicUsageState();
    const result = await runAppRouteHandler({
      cacheComponents: true,
      consumeDynamicUsage: dynamicUsage.consumeDynamicUsage,
      async handlerFn() {
        await new Promise((resolve) => setTimeout(resolve, 0));
        return new Response("task");
      },
      markDynamicUsage: dynamicUsage.markDynamicUsage,
      params: null,
      request: new Request("https://example.com/api/task"),
    });

    expect(result.crossedTaskBoundary).toBe(true);
  });

  it("uses synchronous platform I/O to decide Cache Components route eligibility", async () => {
    const execute = (
      routePattern: string,
      handlerFn: () => Response | Promise<Response>,
      isrSet: Parameters<typeof executeAppRouteHandler>[0]["isrSet"],
    ) =>
      executeAppRouteHandler({
        buildPageCacheTags: () => [],
        cacheComponents: true,
        cleanPathname: routePattern,
        clearRequestContext() {},
        consumeDynamicUsage,
        executionContext: null,
        getAndClearPendingCookies: () => [],
        getCollectedFetchTags: () => [],
        getDraftModeCookieHeader: () => null,
        handler: {},
        handlerFn,
        isAutoHead: false,
        isCacheabilityProbe: true,
        isProduction: true,
        isrRouteKey: (pathname) => `route:${pathname}`,
        isrSet,
        markDynamicUsage,
        method: "GET",
        middlewareContext: { headers: null, status: null },
        observeCompletedBody: true,
        params: null,
        reportRequestError() {},
        request: new Request(`https://example.com${routePattern}`),
        revalidateSeconds: Infinity,
        routePattern,
        setHeadersAccessPhase: () => "render",
      });

    consumeDynamicUsage();
    const dynamicPattern = `/api/platform-dynamic-${Date.now()}`;
    const dynamicSet = vi.fn(async () => {});
    let dynamicExecutions = 0;
    const dynamicResponse = await execute(
      dynamicPattern,
      () => {
        dynamicExecutions += 1;
        return new Response(String(Date.now()));
      },
      dynamicSet,
    );
    expect(dynamicExecutions).toBe(1);
    expect(dynamicSet).not.toHaveBeenCalled();
    expect(isKnownDynamicAppRoute(dynamicPattern)).toBe(true);
    await dynamicResponse.text();

    consumeDynamicUsage();
    const cachedPattern = `/api/platform-cached-${Date.now()}`;
    const cachedTime = unstable_cache(async () => Date.now(), [cachedPattern]);
    const cachedSet = vi.fn(async () => {});
    const cachedResponse = await execute(
      cachedPattern,
      async () => new Response(String(await cachedTime())),
      cachedSet,
    );
    expect(cachedSet).toHaveBeenCalledOnce();
    expect(isKnownDynamicAppRoute(cachedPattern)).toBe(false);
    expect(cachedResponse.headers.get("cache-control")).toContain("s-maxage=31536000");
    await cachedResponse.text();
    consumeDynamicUsage();
  });

  it.each([
    ["synchronously", false],
    ["after a microtask", true],
  ])("keeps Cache Components handlers cacheable when they finish %s", async (_name, microtask) => {
    const dynamicUsage = createDynamicUsageState();
    const result = await runAppRouteHandler({
      cacheComponents: true,
      consumeDynamicUsage: dynamicUsage.consumeDynamicUsage,
      async handlerFn() {
        if (microtask) await Promise.resolve();
        return new Response("static");
      },
      markDynamicUsage: dynamicUsage.markDynamicUsage,
      params: null,
      request: new Request("https://example.com/api/static"),
    });

    expect(result.crossedTaskBoundary).toBe(false);
  });

  // Ported from Next.js: test/e2e/app-dir/cache-components/cache-components.routes.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/cache-components/cache-components.routes.test.ts
  it("warms cached Route Handler I/O prospectively before applying the final task bound", async () => {
    const originalHandler = getDataCacheHandler();
    const values = new Map<string, Parameters<typeof originalHandler.set>[1]>();
    setDataCacheHandler({
      async get(key) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        const value = values.get(key);
        return value === undefined ? null : { lastModified: Date.now(), value };
      },
      async set(key, value) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        values.set(key, value);
      },
      async revalidateTag() {},
    });
    const dynamicUsage = createDynamicUsageState();
    let executions = 0;
    const cached = unstable_cache(async () => {
      executions += 1;
      await new Promise((resolve) => setTimeout(resolve, 0));
      return "cached";
    }, ["prospective-route-handler"]);

    try {
      const result = await runAppRouteHandler({
        cacheComponents: true,
        consumeDynamicUsage: dynamicUsage.consumeDynamicUsage,
        async handlerFn() {
          return new Response(await cached());
        },
        isCacheabilityProbe: true,
        markDynamicUsage: dynamicUsage.markDynamicUsage,
        params: null,
        request: new Request("https://example.com/api/cached-io"),
      });

      expect(executions).toBe(1);
      expect(result.crossedTaskBoundary).toBe(false);
      expect(result.dynamicUsedInHandler).toBe(false);
      await expect(result.response.text()).resolves.toBe("cached");
    } finally {
      setDataCacheHandler(originalHandler);
    }
  });

  it("reuses a pre-existing remote cache hit during the final prospective pass", async () => {
    const originalHandler = getDataCacheHandler();
    const values = new Map<string, Parameters<typeof originalHandler.set>[1]>();
    setDataCacheHandler({
      async get(key) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        const value = values.get(key);
        return value === undefined ? null : { lastModified: Date.now(), value };
      },
      async set(key, value) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        values.set(key, value);
      },
      async revalidateTag() {},
    });
    const dynamicUsage = createDynamicUsageState();
    let executions = 0;
    const cached = unstable_cache(async () => {
      executions += 1;
      return "warm";
    }, ["warm-prospective-route-handler"]);

    try {
      await cached();
      expect(executions).toBe(1);
      const isrSet = vi.fn(async () => {});

      const response = await executeAppRouteHandler({
        buildPageCacheTags: () => [],
        cacheComponents: true,
        cleanPathname: "/api/warm-cached-io",
        clearRequestContext() {},
        consumeDynamicUsage: dynamicUsage.consumeDynamicUsage,
        executionContext: null,
        getAndClearPendingCookies: () => [],
        getCollectedFetchTags: () => [],
        getDraftModeCookieHeader: () => null,
        handler: {},
        async handlerFn() {
          return new Response(await cached());
        },
        isAutoHead: false,
        isProduction: true,
        isrRouteKey: (pathname) => `route:${pathname}`,
        isrSet,
        markDynamicUsage: dynamicUsage.markDynamicUsage,
        method: "GET",
        middlewareContext: { headers: null, status: null },
        observeCompletedBody: true,
        params: null,
        reportRequestError() {},
        request: new Request("https://example.com/api/warm-cached-io"),
        revalidateSeconds: Infinity,
        routePattern: "/api/warm-cached-io",
        setHeadersAccessPhase: () => "render",
      });

      expect(executions).toBe(1);
      expect(isrSet).toHaveBeenCalledOnce();
      expect(response.headers.get("cache-control")).toContain("s-maxage=31536000");
      await expect(response.text()).resolves.toBe("warm");
    } finally {
      setDataCacheHandler(originalHandler);
    }
  });

  it("does not warm body-deferred cached I/O during the prospective pass", async () => {
    const originalHandler = getDataCacheHandler();
    const values = new Map<string, Parameters<typeof originalHandler.set>[1]>();
    setDataCacheHandler({
      async get(key) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        const value = values.get(key);
        return value === undefined ? null : { lastModified: Date.now(), value };
      },
      async set(key, value) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        values.set(key, value);
      },
      async revalidateTag() {},
    });
    const dynamicUsage = createDynamicUsageState();
    const routePattern = `/api/deferred-cache-${Date.now()}`;
    const cached = unstable_cache(async () => "deferred", [routePattern]);
    let pulls = 0;
    let cancellations = 0;

    try {
      const response = await executeAppRouteHandler({
        buildPageCacheTags: () => [],
        cacheComponents: true,
        cleanPathname: routePattern,
        clearRequestContext() {},
        consumeDynamicUsage: dynamicUsage.consumeDynamicUsage,
        executionContext: null,
        getAndClearPendingCookies: () => [],
        getCollectedFetchTags: () => [],
        getDraftModeCookieHeader: () => null,
        handler: {},
        handlerFn() {
          return new Response(
            new ReadableStream(
              {
                cancel() {
                  cancellations += 1;
                },
                async pull(controller) {
                  pulls += 1;
                  controller.enqueue(new TextEncoder().encode(await cached()));
                  controller.close();
                },
              },
              { highWaterMark: 0 },
            ),
          );
        },
        isAutoHead: false,
        isCacheabilityProbe: true,
        isProduction: true,
        isrRouteKey: (pathname) => `route:${pathname}`,
        isrSet: vi.fn(async () => {}),
        markDynamicUsage: dynamicUsage.markDynamicUsage,
        method: "GET",
        middlewareContext: { headers: null, status: null },
        observeCompletedBody: true,
        params: null,
        reportRequestError() {},
        request: new Request(`https://example.com${routePattern}`),
        revalidateSeconds: Infinity,
        routePattern,
        setHeadersAccessPhase: () => "render",
      });

      expect(pulls).toBe(1);
      expect(cancellations).toBe(0);
      expect(isKnownDynamicAppRoute(routePattern)).toBe(true);
      await expect(response.text()).resolves.toBe("deferred");
    } finally {
      setDataCacheHandler(originalHandler);
    }
  });

  it("awaits an owned regeneration cache write", async () => {
    const dynamicUsage = createDynamicUsageState();
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const isrSet = vi.fn(async () => writeGate);
    let settled = false;
    const pending = executeAppRouteHandler({
      awaitCacheWrite: true,
      buildPageCacheTags: () => [],
      cleanPathname: "/api/regenerate",
      clearRequestContext() {},
      consumeDynamicUsage: dynamicUsage.consumeDynamicUsage,
      executionContext: null,
      getAndClearPendingCookies: () => [],
      getCollectedFetchTags: () => [],
      getDraftModeCookieHeader: () => null,
      handler: { revalidate: 60 },
      handlerFn: () => new Response("fresh"),
      isAutoHead: false,
      isProduction: true,
      isrRouteKey: (pathname) => `route:${pathname}`,
      isrSet,
      markDynamicUsage: dynamicUsage.markDynamicUsage,
      method: "GET",
      middlewareContext: { headers: null, status: null },
      observeCompletedBody: true,
      params: null,
      reportRequestError() {},
      request: new Request("https://example.com/api/regenerate"),
      revalidateSeconds: 60,
      routePattern: "/api/regenerate",
      setHeadersAccessPhase: () => "render",
    }).then((response) => {
      settled = true;
      return response;
    });

    await vi.waitFor(() => expect(isrSet).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    releaseWrite();
    await expect(pending).resolves.toBeInstanceOf(Response);
  });

  // Ported from Next.js: test/e2e/app-dir/cache-components/cache-components.routes.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/cache-components/cache-components.routes.test.ts
  it("classifies Cache Components streams that cross a task boundary while pulling as dynamic", async () => {
    const dynamicUsage = createDynamicUsageState();
    const isrSet = vi.fn(async () => {});
    const routePattern = `/api/dynamic-stream-${Date.now()}`;

    const response = await executeAppRouteHandler({
      buildPageCacheTags: () => [],
      cacheComponents: true,
      cleanPathname: routePattern,
      clearRequestContext() {},
      consumeDynamicUsage: dynamicUsage.consumeDynamicUsage,
      executionContext: null,
      getAndClearPendingCookies: () => [],
      getCollectedFetchTags: () => [],
      getDraftModeCookieHeader: () => null,
      handler: { revalidate: false },
      handlerFn() {
        let sent = false;
        return new Response(
          new ReadableStream({
            async pull(controller) {
              controller.enqueue(new TextEncoder().encode(sent ? "stream" : "dynamic "));
              if (sent) controller.close();
              sent = true;
              await new Promise((resolve) => setTimeout(resolve, 0));
            },
          }),
        );
      },
      isAutoHead: false,
      isCacheabilityProbe: true,
      isProduction: true,
      isrRouteKey: (pathname) => `route:${pathname}`,
      isrSet,
      markDynamicUsage: dynamicUsage.markDynamicUsage,
      method: "GET",
      middlewareContext: { headers: null, status: null },
      observeCompletedBody: true,
      params: null,
      reportRequestError() {},
      request: new Request(`https://example.com${routePattern}`),
      revalidateSeconds: Infinity,
      routePattern,
      setHeadersAccessPhase: () => "render",
    });

    expect(isKnownDynamicAppRoute(routePattern)).toBe(true);
    expect(isrSet).not.toHaveBeenCalled();
    expect(response.headers.get("cache-control")).toBeNull();
    await expect(response.text()).resolves.toBe("dynamic stream");
  });

  it("rejects an uncached fetch started while a Route Handler body is pulled", async () => {
    const routePattern = `/api/stream-fetch-${Date.now()}`;
    const isrSet = vi.fn(async () => {});
    const restoreFetchCache = withFetchCache();

    try {
      consumeDynamicUsage();
      const response = await executeAppRouteHandler({
        buildPageCacheTags: () => [],
        cacheComponents: true,
        cleanPathname: routePattern,
        clearRequestContext() {},
        consumeDynamicUsage,
        executionContext: null,
        getAndClearPendingCookies: () => [],
        getCollectedFetchTags: () => [],
        getDraftModeCookieHeader: () => null,
        handler: {},
        handlerFn() {
          return new Response(
            new ReadableStream(
              {
                async pull(controller) {
                  const upstream = await fetch("https://api.example.com/stream-live");
                  controller.enqueue(new TextEncoder().encode(await upstream.text()));
                  controller.close();
                },
              },
              { highWaterMark: 0 },
            ),
          );
        },
        isAutoHead: false,
        isProduction: true,
        isrRouteKey: (pathname) => `route:${pathname}`,
        isrSet,
        markDynamicUsage,
        method: "GET",
        middlewareContext: { headers: null, status: null },
        observeCompletedBody: true,
        params: null,
        reportRequestError() {},
        request: new Request(`https://example.com${routePattern}`),
        revalidateSeconds: Infinity,
        routePattern,
        setHeadersAccessPhase: () => "render",
      });

      expect(isKnownDynamicAppRoute(routePattern)).toBe(true);
      expect(isrSet).not.toHaveBeenCalled();
      expect(response.headers.get("cache-control")).toBeNull();
      await expect(response.json()).resolves.toEqual({ ok: true });
    } finally {
      consumeDynamicUsage();
      restoreFetchCache();
    }
  });

  it("still rejects uncached task-bound I/O after the prospective pass", async () => {
    const dynamicUsage = createDynamicUsageState();
    let executions = 0;
    const result = await runAppRouteHandler({
      cacheComponents: true,
      consumeDynamicUsage: dynamicUsage.consumeDynamicUsage,
      async handlerFn() {
        executions += 1;
        await new Promise((resolve) => setTimeout(resolve, 0));
        return new Response("dynamic");
      },
      isCacheabilityProbe: true,
      markDynamicUsage: dynamicUsage.markDynamicUsage,
      params: null,
      request: new Request("https://example.com/api/uncached-io"),
    });

    expect(executions).toBe(2);
    expect(result.crossedTaskBoundary).toBe(true);
  });

  it("does not drain or cache Route Handler event streams", async () => {
    const isrSet = vi.fn(async () => {});
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: ready\n\n"));
      },
    });

    const response = await executeAppRouteHandler({
      buildPageCacheTags: () => [],
      cleanPathname: "/api/events",
      clearRequestContext() {},
      consumeDynamicUsage: () => false,
      executionContext: null,
      getAndClearPendingCookies: () => [],
      getCollectedFetchTags: () => [],
      getDraftModeCookieHeader: () => null,
      handler: { revalidate: false },
      handlerFn: () => new Response(stream, { headers: { "Content-Type": "text/event-stream" } }),
      isAutoHead: false,
      isProduction: true,
      isrRouteKey: (pathname) => `route:${pathname}`,
      isrSet,
      markDynamicUsage() {},
      method: "GET",
      middlewareContext: { headers: null, status: null },
      observeCompletedBody: true,
      params: null,
      reportRequestError() {},
      request: new Request("https://example.com/api/events"),
      revalidateSeconds: Infinity,
      routePattern: "/api/events",
      setHeadersAccessPhase: () => "render",
    });

    expect(response.headers.get("cache-control")).toBeNull();
    expect(isrSet).not.toHaveBeenCalled();
    const reader = response.body!.getReader();
    await expect(reader.read()).resolves.toMatchObject({ done: false });
    await reader.cancel();
  });

  it("bounds completed-body observation without losing a slow streamed response", async () => {
    vi.useFakeTimers();
    try {
      const isrSet = vi.fn(async () => {});
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const stream = new ReadableStream<Uint8Array>({
        start(value) {
          controller = value;
          controller.enqueue(new TextEncoder().encode("first"));
        },
      });

      const pending = executeAppRouteHandler({
        buildPageCacheTags: () => [],
        cleanPathname: "/api/slow",
        clearRequestContext() {},
        consumeDynamicUsage: () => false,
        executionContext: null,
        getAndClearPendingCookies: () => [],
        getCollectedFetchTags: () => [],
        getDraftModeCookieHeader: () => null,
        handler: { revalidate: false },
        handlerFn: () => new Response(stream),
        isAutoHead: false,
        isProduction: true,
        isrRouteKey: (pathname) => `route:${pathname}`,
        isrSet,
        markDynamicUsage() {},
        method: "GET",
        middlewareContext: { headers: null, status: null },
        observeCompletedBody: true,
        params: null,
        reportRequestError() {},
        request: new Request("https://example.com/api/slow"),
        revalidateSeconds: Infinity,
        routePattern: "/api/slow",
        setHeadersAccessPhase: () => "render",
      });
      await vi.advanceTimersByTimeAsync(CACHEABILITY_RESPONSE_CAPTURE_TIMEOUT_MS);
      const response = await pending;

      expect(response.headers.get("cache-control")).toBeNull();
      expect(isrSet).not.toHaveBeenCalled();
      const reader = response.body!.getReader();
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toBe("first");
      controller.close();
      await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
    } finally {
      vi.useRealTimers();
    }
  });

  it("persists revalidate=false route handlers as immutable Full Route Cache entries", async () => {
    const writes: Array<number | false> = [];
    const pendingWrites: Promise<unknown>[] = [];
    const response = await executeAppRouteHandler({
      buildPageCacheTags(pathname, extraTags) {
        return [pathname, ...extraTags];
      },
      cleanPathname: "/api/immutable",
      clearRequestContext() {},
      consumeDynamicUsage() {
        return false;
      },
      executionContext: {
        waitUntil(promise) {
          pendingWrites.push(promise);
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
      handler: { dynamic: "auto", revalidate: false },
      handlerFn() {
        return new Response("immutable");
      },
      isAutoHead: false,
      isProduction: true,
      isrRouteKey(pathname) {
        return `route:${pathname}`;
      },
      async isrSet(_key, _value, policy) {
        writes.push(policy.cacheControl.revalidate);
      },
      markDynamicUsage() {},
      method: "GET",
      middlewareContext: { headers: null, status: null },
      params: {},
      reportRequestError(error) {
        throw error;
      },
      request: new Request("https://example.com/api/immutable"),
      revalidateSeconds: Infinity,
      routePattern: "/api/immutable",
      setHeadersAccessPhase() {
        return "render";
      },
    });
    await Promise.all(pendingWrites);

    expect(response.headers.get("cache-control")).toBe("s-maxage=31536000, stale-while-revalidate");
    expect(writes).toEqual([false]);
  });

  it("persists a static Route Handler body without replacing its custom Cache-Control", async () => {
    const pendingWrites: Promise<unknown>[] = [];
    const isrSet = vi.fn(async (_key, value: CachedRouteValue) => {
      expect(value.headers["cache-control"]).toBe("private, max-age=30");
    });
    const response = await executeAppRouteHandler({
      buildPageCacheTags: () => [],
      cleanPathname: "/api/custom-policy",
      clearRequestContext() {},
      consumeDynamicUsage: () => false,
      executionContext: {
        waitUntil(promise) {
          pendingWrites.push(promise);
        },
      },
      getAndClearPendingCookies: () => [],
      getCollectedFetchTags: () => [],
      getDraftModeCookieHeader: () => null,
      handler: { revalidate: 60 },
      handlerFn: () =>
        new Response("custom", { headers: { "Cache-Control": "private, max-age=30" } }),
      isAutoHead: false,
      isProduction: true,
      isrRouteKey: (pathname) => `route:${pathname}`,
      isrSet,
      markDynamicUsage() {},
      method: "GET",
      middlewareContext: { headers: null, status: null },
      observeCompletedBody: true,
      params: null,
      reportRequestError() {},
      request: new Request("https://example.com/api/custom-policy"),
      revalidateSeconds: 60,
      routePattern: "/api/custom-policy",
      setHeadersAccessPhase: () => "render",
    });

    await Promise.all(pendingWrites);
    expect(isrSet).toHaveBeenCalledOnce();
    expect(response.headers.get("cache-control")).toBe("private, max-age=30");
  });

  it("uses the completed fetch revalidation minimum for the response and cache entry", async () => {
    // Ported from Next.js App Route cache collection:
    // packages/next/src/build/templates/app-route.ts (`collectedRevalidate`).
    const dynamicUsage = createDynamicUsageState();
    const waitUntilPromises: Promise<unknown>[] = [];
    const writes: Array<{ expire?: number; revalidate: number | false }> = [];
    const restoreFetchCache = withFetchCache();
    fetchMock.mockClear();

    try {
      const response = await runWithRequestContext(createRequestContext(), () =>
        executeAppRouteHandler({
          buildPageCacheTags: () => [],
          cleanPathname: "/api/minimum",
          clearRequestContext() {},
          consumeDynamicUsage: dynamicUsage.consumeDynamicUsage,
          executionContext: {
            waitUntil(promise) {
              waitUntilPromises.push(promise);
            },
          },
          getAndClearPendingCookies: () => [],
          getCollectedFetchTags: () => [],
          getDraftModeCookieHeader: () => null,
          handler: { dynamic: "auto" },
          async handlerFn() {
            await fetch("https://api.example.com/minimum", {
              next: { revalidate: 5 },
            });
            return new Response("minimum");
          },
          isAutoHead: false,
          isProduction: true,
          isrRouteKey: (pathname) => `route:${pathname}`,
          async isrSet(_key, _value, policy) {
            writes.push({
              expire: policy.cacheControl.expire,
              revalidate: policy.cacheControl.revalidate,
            });
          },
          markDynamicUsage: dynamicUsage.markDynamicUsage,
          method: "GET",
          middlewareContext: { headers: null, status: null },
          params: {},
          reportRequestError() {},
          request: new Request("https://example.com/api/minimum"),
          expireSeconds: 300,
          revalidateSeconds: 60,
          routePattern: "/api/minimum",
          setHeadersAccessPhase: () => "render",
        }),
      );

      await Promise.all(waitUntilPromises);
      expect(response.headers.get("cache-control")).toBe("s-maxage=5, stale-while-revalidate=295");
      expect(writes).toEqual([{ expire: 300, revalidate: 5 }]);
    } finally {
      restoreFetchCache();
      fetchMock.mockClear();
    }
  });

  it.each([
    { enabled: true, initialDraftMode: false, expectedCookie: "__prerender_bypass=draft-secret" },
    { enabled: false, initialDraftMode: true, expectedCookie: "__prerender_bypass=;" },
  ])(
    "does not cache a force-static handler draft transition (enabled: $enabled)",
    async ({ enabled, initialDraftMode, expectedCookie }) => {
      const waitUntilPromises: Promise<unknown>[] = [];
      const isrSet = vi.fn();
      const routePattern = `/api/force-static-draft-${enabled}-${Date.now()}`;
      const request = new Request(`https://example.com${routePattern}`, {
        headers: initialDraftMode ? { cookie: "__prerender_bypass=draft-secret" } : undefined,
      });

      setHeadersContext({
        headers: request.headers,
        cookies: new Map(initialDraftMode ? [["__prerender_bypass", "draft-secret"]] : []),
        draftModeSecret: "draft-secret",
      });

      try {
        const response = await executeAppRouteHandler({
          buildPageCacheTags(pathname, extraTags) {
            return [pathname, ...extraTags];
          },
          cleanPathname: routePattern,
          clearRequestContext() {
            setHeadersContext(null);
          },
          consumeDynamicUsage,
          draftModeSecret: "draft-secret",
          executionContext: {
            waitUntil(promise) {
              waitUntilPromises.push(promise);
            },
          },
          getActiveDraftModeState,
          getAndClearPendingCookies,
          getCollectedFetchTags() {
            return [];
          },
          getDraftModeCookieHeader,
          handler: { dynamic: "force-static", revalidate: 60 },
          async handlerFn() {
            const draft = await draftMode();
            if (enabled) draft.enable();
            else draft.disable();
            return Response.json({ draftMode: draft.isEnabled });
          },
          isAutoHead: false,
          isProduction: true,
          isrRouteKey(pathname) {
            return "route:" + pathname;
          },
          isrSet,
          markDynamicUsage,
          method: "GET",
          middlewareContext: { headers: null, status: null },
          params: null,
          reportRequestError() {},
          request,
          revalidateSeconds: 60,
          routePattern,
          setHeadersAccessPhase() {
            return "render";
          },
        });

        expect(waitUntilPromises).toEqual([]);
        expect(isrSet).not.toHaveBeenCalled();
        expect(isKnownDynamicAppRoute(routePattern)).toBe(true);
        expect(await response.json()).toEqual({ draftMode: enabled });
        expect(response.headers.get("set-cookie")).toContain(expectedCookie);
        expect(response.headers.get("cache-control")).toContain("no-store");
        expect(response.headers.get("x-vinext-cache")).toBeNull();
      } finally {
        setHeadersContext(null);
        consumeDynamicUsage();
      }
    },
  );

  // Next.js commits mutable cookies for redirect control flow, but access-fallback
  // responses omit them and ordinary errors are rethrown without finalization.
  // https://github.com/vercel/next.js/blob/canary/packages/next/src/server/route-modules/app-route/module.ts#L712-L747
  it.each([
    {
      kind: "redirect",
      commitsCookies: true,
      expectedStatus: 307,
      throwValue: { digest: "NEXT_REDIRECT;replace;%2Ftarget;307" },
    },
    {
      kind: "not-found",
      commitsCookies: false,
      expectedStatus: 404,
      throwValue: { digest: "NEXT_NOT_FOUND" },
    },
    {
      kind: "error",
      commitsCookies: false,
      expectedStatus: 500,
      throwValue: new Error("draft failure"),
    },
  ])(
    "applies the draft policy on $kind responses",
    async ({ commitsCookies, expectedStatus, throwValue }) => {
      const routePattern = `/api/draft-error-${expectedStatus}-${Date.now()}`;
      const isrSet = vi.fn();
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      setHeadersContext({
        headers: new Headers(),
        cookies: new Map(),
        draftModeSecret: "draft-secret",
      });

      try {
        const response = await executeAppRouteHandler({
          buildPageCacheTags(pathname, extraTags) {
            return [pathname, ...extraTags];
          },
          cleanPathname: routePattern,
          clearRequestContext() {
            setHeadersContext(null);
          },
          consumeDynamicUsage,
          draftModeSecret: "draft-secret",
          executionContext: null,
          getActiveDraftModeState,
          getAndClearPendingCookies,
          getCollectedFetchTags() {
            return [];
          },
          getDraftModeCookieHeader,
          handler: { dynamic: "auto", revalidate: 60 },
          async handlerFn() {
            (await cookies()).set("pending", "value");
            (await draftMode()).enable();
            throw throwValue;
          },
          isAutoHead: false,
          isProduction: true,
          isrRouteKey(pathname) {
            return "route:" + pathname;
          },
          isrSet,
          markDynamicUsage,
          method: "GET",
          middlewareContext: { headers: null, status: null },
          params: null,
          reportRequestError() {},
          request: new Request(`https://example.com${routePattern}`),
          revalidateSeconds: 60,
          routePattern,
          setHeadersAccessPhase,
        });

        expect(response.status).toBe(expectedStatus);
        if (commitsCookies) {
          expect(response.headers.get("set-cookie")).toContain("pending=value");
          expect(response.headers.get("set-cookie")).toContain("__prerender_bypass=draft-secret");
        } else {
          expect(response.headers.get("set-cookie")).toBeNull();
        }
        expect(response.headers.get("cache-control")).toContain("no-store");
        expect(isrSet).not.toHaveBeenCalled();
        expect(isKnownDynamicAppRoute(routePattern)).toBe(true);
      } finally {
        errorSpy.mockRestore();
        setHeadersContext(null);
        consumeDynamicUsage();
      }
    },
  );

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

  it("applies the draft cache policy to responses with immutable headers", async () => {
    const dynamicUsage = createDynamicUsageState();
    let wroteCache = false;

    const response = await executeAppRouteHandler({
      buildPageCacheTags(pathname, extraTags) {
        return [pathname, ...extraTags];
      },
      cleanPathname: "/api/draft-redirect",
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
        return Response.redirect("https://example.com/target");
      },
      isAutoHead: false,
      isDraftMode: true,
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
      request: new Request("https://example.com/api/draft-redirect"),
      revalidateSeconds: 60,
      routePattern: "/api/draft-redirect",
      setHeadersAccessPhase() {
        return "render";
      },
    });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://example.com/target");
    expect(response.headers.get("cache-control")).toBe(
      "private, no-cache, no-store, max-age=0, must-revalidate",
    );
    expect(response.headers.get("x-vinext-cache")).toBeNull();
    expect(wroteCache).toBe(false);
  });

  // Route Handler revalidation is finalized by Next.js' App Route module:
  // packages/next/src/server/route-modules/app-route/module.ts
  it("finishes tag invalidation before finalizing a route handler response", async () => {
    const dynamicUsage = createDynamicUsageState();
    const previousHandler = getDataCacheHandler();
    let markInvalidationStarted!: () => void;
    const invalidationStarted = new Promise<void>((resolve) => {
      markInvalidationStarted = resolve;
    });
    let releaseInvalidation!: () => void;
    const invalidationGate = new Promise<void>((resolve) => {
      releaseInvalidation = resolve;
    });
    let invalidationFinished = false;
    let didClearRequestContext = false;

    setDataCacheHandler({
      get: previousHandler.get.bind(previousHandler),
      set: previousHandler.set.bind(previousHandler),
      async revalidateTag() {
        markInvalidationStarted();
        await invalidationGate;
        invalidationFinished = true;
      },
    });

    try {
      const responsePromise = runWithRequestContext(createRequestContext(), () =>
        executeAppRouteHandler({
          buildPageCacheTags(pathname, extraTags) {
            return [pathname, ...extraTags];
          },
          cleanPathname: "/api/revalidate",
          clearRequestContext() {
            expect(invalidationFinished).toBe(true);
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
            expect(revalidateTag("dashboard", { expire: 0 })).toBeUndefined();
            return new Response("revalidated");
          },
          isAutoHead: false,
          isProduction: true,
          isrRouteKey(pathname) {
            return "route:" + pathname;
          },
          async isrSet() {},
          markDynamicUsage: dynamicUsage.markDynamicUsage,
          method: "POST",
          middlewareContext: { headers: null, status: null },
          params: {},
          reportRequestError() {},
          request: new Request("https://example.com/api/revalidate", { method: "POST" }),
          revalidateSeconds: null,
          routePattern: "/api/revalidate",
          setHeadersAccessPhase() {
            return "render";
          },
        }),
      );

      await invalidationStarted;
      expect(didClearRequestContext).toBe(false);
      releaseInvalidation();

      const response = await responsePromise;
      expect(didClearRequestContext).toBe(true);
      await expect(response.text()).resolves.toBe("revalidated");
    } finally {
      releaseInvalidation();
      setDataCacheHandler(previousHandler);
    }
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
      isDraftMode: true,
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
    expect(redirectResponse.headers.get("cache-control")).toBe(
      "private, no-cache, no-store, max-age=0, must-revalidate",
    );
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

  it.each([
    {
      digest: "NEXT_REDIRECT;replace;%2Ftarget;308",
      expectedLocation: "https://example.com/target",
      expectedStatus: 308,
      name: "redirect",
    },
    {
      digest: "NEXT_HTTP_ERROR_FALLBACK;404",
      expectedLocation: null,
      expectedStatus: 404,
      name: "not-found",
    },
  ])("persists static $name Route Handler outcomes", async (testCase) => {
    const dynamicUsage = createDynamicUsageState();
    const pendingWrites: Promise<unknown>[] = [];
    const writes: CachedRouteValue[] = [];
    const response = await executeAppRouteHandler({
      buildPageCacheTags: () => [],
      cleanPathname: `/api/${testCase.name}`,
      clearRequestContext() {},
      consumeDynamicUsage: dynamicUsage.consumeDynamicUsage,
      executionContext: {
        waitUntil(promise) {
          pendingWrites.push(promise);
        },
      },
      getAndClearPendingCookies: () => [],
      getCollectedFetchTags: () => [],
      getDraftModeCookieHeader: () => null,
      handler: { revalidate: 60 },
      handlerFn() {
        throw { digest: testCase.digest };
      },
      isAutoHead: false,
      isProduction: true,
      isrRouteKey: (pathname) => `route:${pathname}`,
      async isrSet(_key, value) {
        writes.push(value);
      },
      markDynamicUsage: dynamicUsage.markDynamicUsage,
      method: "GET",
      middlewareContext: { headers: null, status: null },
      params: null,
      reportRequestError() {},
      request: new Request(`https://example.com/api/${testCase.name}`),
      revalidateSeconds: 60,
      routePattern: `/api/${testCase.name}`,
      setHeadersAccessPhase: () => "render",
    });
    await Promise.all(pendingWrites);

    expect(response.status).toBe(testCase.expectedStatus);
    expect(response.headers.get("location")).toBe(testCase.expectedLocation);
    expect(response.headers.get("cache-control")).toBe("s-maxage=60, stale-while-revalidate");
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ kind: "APP_ROUTE", status: testCase.expectedStatus });
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
