import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { dispatchAppRouteHandler } from "../packages/vinext/src/server/app-route-handler-dispatch.js";
import type { CachedRouteValue } from "../packages/vinext/src/shims/cache.js";
import { revalidateTag } from "../packages/vinext/src/shims/cache.js";
import {
  getDataCacheHandler,
  setDataCacheHandler,
} from "../packages/vinext/src/shims/cache-handler.js";
import type { ISRCacheEntry } from "../packages/vinext/src/server/isr-cache.js";
import { draftMode, setHeadersContext } from "../packages/vinext/src/shims/headers.js";
import { after } from "../packages/vinext/src/shims/server.js";
import {
  createWorkerCacheabilityContext,
  finalizeWorkerCacheabilityResponse,
  markRequestCacheabilityUnsafe,
} from "../packages/vinext/src/server/cacheability-request.js";
import { runWithExecutionContext } from "../packages/vinext/src/shims/request-context.js";
import { resetEmbeddedCacheabilityManifestForTests } from "../packages/vinext/src/server/cacheability-manifest.js";
import {
  DefaultCdnCacheAdapter,
  setCdnCacheAdapter,
} from "../packages/vinext/src/shims/cdn-cache.js";
import { CloudflareCdnCacheAdapter } from "../packages/cloudflare/src/cache/cdn-adapter.runtime.js";
import { isKnownDynamicAppRoute } from "../packages/vinext/src/server/app-route-handler-runtime.js";

const manifestGlobal = "__VINEXT_CACHEABILITY_MANIFEST__";

afterEach(() => {
  vi.unstubAllGlobals();
  resetEmbeddedCacheabilityManifestForTests();
  setCdnCacheAdapter(new DefaultCdnCacheAdapter());
});

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
  // Ported from Next.js: test/e2e/app-dir/app-static/app-static.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/app-static/app-static.test.ts
  it("returns 404 for Route Handler params excluded by dynamicParams=false", async () => {
    const get = vi.fn(() => new Response("handler ran"));
    const dispatch = (slug: string) =>
      dispatchAppRouteHandler({
        cacheComponents: true,
        cleanPathname: `/api/products/${slug}`,
        clearRequestContext() {},
        draftModeSecret: "test-draft-secret",
        dynamicParamsConfig: false,
        generateStaticParams: async () => [{ slug: "known" }],
        i18n: null,
        isDevelopment: false,
        isProduction: true,
        async isrGet() {
          return null;
        },
        isrRouteKey: (pathname) => `route:${pathname}`,
        async isrSet() {},
        middlewareContext: { headers: null, status: null },
        middlewareRequestHeaders: null,
        params: { slug },
        request: new Request(`https://example.com/api/products/${slug}`),
        route: {
          isDynamic: true,
          pattern: "/api/products/:slug",
          routeHandler: { GET: get },
          routeSegments: ["api", "products", "[slug]"],
        },
        scheduleBackgroundRegeneration() {},
        searchParams: new URLSearchParams(),
      });

    const unknown = await dispatch("unknown");
    expect(unknown.status).toBe(404);
    expect(get).not.toHaveBeenCalled();

    const known = await dispatch("known");
    expect(known.status).toBe(200);
    await expect(known.text()).resolves.toBe("handler ran");
    // Cache Components invokes the known handler once prospectively and once
    // for the final task-bounded representation.
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("classifies force-dynamic GET handlers as dynamic despite public response headers", async () => {
    const request = new Request("https://example.com/api/dynamic", {
      headers: {
        "X-Vinext-Cacheability-Probe": "1",
        "X-Vinext-Prerender-Secret": "secret-a",
      },
    });
    const ctx = createWorkerCacheabilityContext(
      { hostRuntime: "worker", waitUntil() {} },
      request,
      "secret-a",
    );

    const response = await runWithExecutionContext(ctx, async () => {
      const routeResponse = await dispatchAppRouteHandler({
        cleanPathname: "/api/dynamic",
        clearRequestContext() {},
        draftModeSecret: "test-draft-secret",
        i18n: null,
        isDevelopment: false,
        isProduction: true,
        async isrGet() {
          return null;
        },
        isrRouteKey: (pathname) => `route:${pathname}`,
        async isrSet() {},
        middlewareContext: { headers: null, status: null },
        middlewareRequestHeaders: null,
        params: null,
        request,
        route: {
          pattern: "/api/dynamic",
          routeHandler: {
            dynamic: "force-dynamic",
            GET() {
              return new Response("dynamic", {
                headers: {
                  "CDN-Cache-Control": "public, max-age=60",
                  Vary: "Accept",
                },
              });
            },
          },
          routeSegments: ["api", "dynamic"],
        },
        scheduleBackgroundRegeneration() {},
        searchParams: new URLSearchParams(),
      });
      return finalizeWorkerCacheabilityResponse(routeResponse, ctx);
    });

    await expect(response.json()).resolves.toMatchObject({
      kind: "app-route",
      pattern: "/api/dynamic",
      state: "dynamic",
    });
  });

  it("executes Cache Components POST streams once without poisoning sibling GET caching", async () => {
    const pattern = "/api/cache-components-post-regression";
    let pulls = 0;
    const post = vi.fn((request: Request) => {
      request.headers.get("authorization");
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            pulls += 1;
            controller.enqueue(new TextEncoder().encode("posted"));
            controller.close();
          },
        }),
      );
    });

    const response = await dispatchAppRouteHandler({
      cacheComponents: true,
      cleanPathname: pattern,
      clearRequestContext() {},
      draftModeSecret: "test-draft-secret",
      i18n: null,
      isDevelopment: false,
      isProduction: true,
      async isrGet() {
        return null;
      },
      isrRouteKey: (pathname) => `route:${pathname}`,
      async isrSet() {},
      middlewareContext: { headers: null, status: null },
      middlewareRequestHeaders: null,
      params: null,
      request: new Request(`https://example.com${pattern}`, { method: "POST" }),
      route: {
        pattern,
        routeHandler: { GET: () => new Response("get"), POST: post },
        routeSegments: ["api", "cache-components-post-regression"],
      },
      scheduleBackgroundRegeneration() {},
      searchParams: new URLSearchParams(),
    });

    expect(post).toHaveBeenCalledOnce();
    expect(response.body?.locked).toBe(false);
    await expect(response.text()).resolves.toBe("posted");
    expect(pulls).toBe(1);
    expect(isKnownDynamicAppRoute(pattern)).toBe(false);
  });

  it("classifies Cache Components GET routes with non-static sibling methods as dynamic", async () => {
    const request = new Request("https://example.com/api/mixed-methods", {
      headers: {
        "X-Vinext-Cacheability-Probe": "1",
        "X-Vinext-Prerender-Secret": "secret-a",
      },
    });
    const ctx = createWorkerCacheabilityContext(
      { hostRuntime: "worker", waitUntil() {} },
      request,
      "secret-a",
    );
    const get = vi.fn(() => new Response("get"));

    const response = await runWithExecutionContext(ctx, async () => {
      const routeResponse = await dispatchAppRouteHandler({
        cacheComponents: true,
        cleanPathname: "/api/mixed-methods",
        clearRequestContext() {},
        draftModeSecret: "test-draft-secret",
        i18n: null,
        isDevelopment: false,
        isProduction: true,
        async isrGet() {
          return null;
        },
        isrRouteKey: (pathname) => `route:${pathname}`,
        async isrSet() {},
        middlewareContext: { headers: null, status: null },
        middlewareRequestHeaders: null,
        params: null,
        request,
        route: {
          pattern: "/api/mixed-methods",
          routeHandler: { GET: get, POST: () => new Response("post") },
          routeSegments: ["api", "mixed-methods"],
        },
        scheduleBackgroundRegeneration() {},
        searchParams: new URLSearchParams(),
      });
      return finalizeWorkerCacheabilityResponse(routeResponse, ctx);
    });

    expect(get).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      kind: "app-route",
      pattern: "/api/mixed-methods",
      state: "dynamic",
    });
  });

  it("streams manifest-proven dynamic Cache Components handlers without a prospective pass", async () => {
    vi.stubGlobal(
      manifestGlobal,
      JSON.stringify({
        routes: {
          "app-route:/api/stream": {
            kind: "app-route",
            pattern: "/api/stream",
            state: "dynamic",
          },
        },
        version: 1,
      }),
    );
    resetEmbeddedCacheabilityManifestForTests();
    setCdnCacheAdapter(new CloudflareCdnCacheAdapter());
    const request = new Request("https://example.com/api/stream");
    const context = createWorkerCacheabilityContext(
      { hostRuntime: "worker", isCloudflareWorker: true, waitUntil() {} },
      request,
      "secret-a",
    );
    let pulls = 0;
    let cancellations = 0;
    let releasePull!: () => void;
    const pullGate = new Promise<void>((resolve) => {
      releasePull = resolve;
    });
    const get = vi.fn(
      () =>
        new Response(
          new ReadableStream(
            {
              cancel() {
                cancellations += 1;
              },
              async pull(controller) {
                pulls += 1;
                await pullGate;
                controller.enqueue(new TextEncoder().encode("streamed"));
                controller.close();
              },
            },
            { highWaterMark: 0 },
          ),
        ),
    );

    const response = await runWithExecutionContext(context, () =>
      dispatchAppRouteHandler({
        cacheComponents: true,
        cleanPathname: "/api/stream",
        clearRequestContext() {},
        draftModeSecret: "test-draft-secret",
        i18n: null,
        isDevelopment: false,
        isProduction: true,
        async isrGet() {
          return null;
        },
        isrRouteKey: (pathname) => `route:${pathname}`,
        async isrSet() {},
        middlewareContext: { headers: null, status: null },
        middlewareRequestHeaders: null,
        params: null,
        request,
        route: {
          isDynamic: false,
          pattern: "/api/stream",
          routeHandler: { GET: get },
          routeSegments: ["api", "stream"],
        },
        scheduleBackgroundRegeneration() {},
        searchParams: new URLSearchParams(),
      }),
    );

    expect(get).toHaveBeenCalledOnce();
    expect(pulls).toBeLessThanOrEqual(1);
    expect(cancellations).toBe(0);
    releasePull();
    await expect(response.text()).resolves.toBe("streamed");
    expect(pulls).toBe(1);
    expect(cancellations).toBe(0);
  });

  it("streams pre-route unsafe Cache Components GET handlers without observation", async () => {
    setCdnCacheAdapter(new CloudflareCdnCacheAdapter());
    const request = new Request("https://example.com/api/unsafe-stream");
    const context = createWorkerCacheabilityContext(
      { hostRuntime: "worker", isCloudflareWorker: true, waitUntil() {} },
      request,
      "secret-a",
    );
    let pulls = 0;
    const get = vi.fn(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              pulls += 1;
              controller.enqueue(new TextEncoder().encode("unsafe"));
              controller.close();
            },
          }),
        ),
    );

    const response = await runWithExecutionContext(context, async () => {
      markRequestCacheabilityUnsafe("request-conditional config can vary this pathname");
      const routeResponse = await dispatchAppRouteHandler({
        cacheComponents: true,
        cleanPathname: "/api/unsafe-stream",
        clearRequestContext() {},
        draftModeSecret: "test-draft-secret",
        i18n: null,
        isDevelopment: false,
        isProduction: true,
        async isrGet() {
          return null;
        },
        isrRouteKey: (pathname) => `route:${pathname}`,
        async isrSet() {},
        middlewareContext: { headers: null, status: null },
        middlewareRequestHeaders: null,
        params: null,
        request,
        route: {
          pattern: "/api/unsafe-stream",
          routeHandler: { GET: get },
          routeSegments: ["api", "unsafe-stream"],
        },
        scheduleBackgroundRegeneration() {},
        searchParams: new URLSearchParams(),
      });
      return finalizeWorkerCacheabilityResponse(routeResponse, context);
    });

    expect(get).toHaveBeenCalledOnce();
    expect(response.body?.locked).toBe(false);
    expect(response.headers.get("Cache-Control")).toBe("no-store, must-revalidate");
    await expect(response.text()).resolves.toBe("unsafe");
    expect(pulls).toBe(1);
  });

  it.each([
    {
      enabled: true,
      expectedDraftMode: true,
      expectedCookie: "__prerender_bypass=test-draft-secret",
    },
    { enabled: false, expectedDraftMode: false, expectedCookie: "__prerender_bypass=;" },
  ])(
    "bypasses a prewarmed cache and preserves a pending draft transition (enabled: $enabled)",
    async ({ enabled, expectedDraftMode, expectedCookie }) => {
      const cookies = new Map<string, string>();
      if (!enabled) cookies.set("__prerender_bypass", "test-draft-secret");
      setHeadersContext({
        headers: new Headers(),
        cookies,
        draftModeSecret: "test-draft-secret",
      });

      const draft = await draftMode();
      if (enabled) draft.enable();
      else draft.disable();

      const isrGet = vi.fn(async () =>
        buildISRCacheEntry(buildCachedRouteValue("prewarmed-public-response")),
      );
      const isrSet = vi.fn();

      try {
        const response = await dispatchAppRouteHandler({
          cleanPathname: "/api/middleware-draft",
          clearRequestContext() {
            setHeadersContext(null);
          },
          draftModeSecret: "test-draft-secret",
          i18n: null,
          isDevelopment: false,
          isProduction: true,
          isrGet,
          isrRouteKey(pathname) {
            return "route:" + pathname;
          },
          isrSet,
          middlewareContext: { headers: null, status: null },
          middlewareRequestHeaders: null,
          params: null,
          request: new Request("https://example.com/api/middleware-draft"),
          route: {
            pattern: `/api/middleware-draft-${enabled}`,
            routeHandler: {
              async GET() {
                return Response.json({ draftMode: (await draftMode()).isEnabled });
              },
              revalidate: 60,
            },
            routeSegments: ["api", "middleware-draft"],
          },
          scheduleBackgroundRegeneration() {},
          searchParams: new URLSearchParams(),
        });

        expect(isrGet).not.toHaveBeenCalled();
        expect(isrSet).not.toHaveBeenCalled();
        expect(await response.json()).toEqual({ draftMode: expectedDraftMode });
        expect(response.headers.get("set-cookie")).toContain(expectedCookie);
        expect(response.headers.get("cache-control")).toContain("no-store");
        expect(response.headers.get("x-vinext-cache")).toBeNull();
      } finally {
        setHeadersContext(null);
      }
    },
  );

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
      draftModeSecret: "test-draft-secret",
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
      draftModeSecret: "test-draft-secret",
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
      draftModeSecret: "test-draft-secret",
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
      draftModeSecret: "test-draft-secret",
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

  // Matches Next.js behavior: route handlers on non-dynamic routes receive
  // `context.params` as null (not `{}`). User code typically does
  // `const resolved = params ? await params : null`, and the resolved value
  // is observable through tests like `expect(meta.params).toEqual(null)`.
  // Ported from Next.js: test/e2e/app-dir/app-routes/app-custom-routes.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/app-routes/app-custom-routes.test.ts#L424-L431
  it("passes params: null to route handlers on non-dynamic routes", async () => {
    let receivedParams: unknown = "untouched";
    const route = {
      pattern: "/api/static",
      routeHandler: {
        GET(_request: Request, context: { params: unknown }) {
          receivedParams = context.params;
          return new Response("ok");
        },
      },
      routeSegments: ["api", "static"],
    };

    await dispatchAppRouteHandler({
      cleanPathname: "/api/static",
      clearRequestContext() {},
      draftModeSecret: "test-draft-secret",
      i18n: null,
      isDevelopment: false,
      isProduction: true,
      async isrGet() {
        return null;
      },
      isrRouteKey(pathname) {
        return "route:" + pathname;
      },
      async isrSet() {},
      middlewareContext: { headers: null, status: null },
      middlewareRequestHeaders: null,
      params: null,
      request: new Request("https://example.com/api/static"),
      route,
      scheduleBackgroundRegeneration() {},
      searchParams: new URLSearchParams(),
    });

    expect(receivedParams).toBeNull();
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
      draftModeSecret: "test-draft-secret",
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

  // Parity with upstream's app-route module: `dynamic = "force-dynamic"` sets
  // `workStore.forceDynamic`, which patch-fetch turns into a no-store default
  // for fetches without explicit cache config — for route handlers as well as
  // pages.
  it("applies the force-dynamic fetch default before invoking the route handler", async () => {
    const fetchCacheShims = await import("../packages/vinext/src/shims/fetch-cache.js");
    const modeSpy = vi.spyOn(fetchCacheShims, "setCurrentFetchCacheMode");
    const revalidateSpy = vi.spyOn(fetchCacheShims, "setCurrentFetchRevalidate");
    const forceDynamicSpy = vi.spyOn(fetchCacheShims, "setCurrentForceDynamicFetchDefault");

    let forceDynamicDefaultAtHandlerTime: boolean | undefined;
    let fetchCacheModeAtHandlerTime: unknown = "unset";

    const response = await dispatchAppRouteHandler({
      cleanPathname: "/api/force-dynamic",
      clearRequestContext() {},
      draftModeSecret: "test-draft-secret",
      i18n: null,
      isDevelopment: false,
      isProduction: true,
      async isrGet() {
        throw new Error("force-dynamic handler should not read route cache");
      },
      isrRouteKey(pathname) {
        return "route:" + pathname;
      },
      async isrSet() {
        throw new Error("force-dynamic handler should not write route cache");
      },
      middlewareContext: { headers: null, status: null },
      middlewareRequestHeaders: null,
      params: {},
      request: new Request("https://example.com/api/force-dynamic"),
      route: {
        pattern: "/api/force-dynamic",
        routeHandler: {
          dynamic: "force-dynamic",
          GET() {
            forceDynamicDefaultAtHandlerTime = forceDynamicSpy.mock.calls.at(-1)?.[0];
            fetchCacheModeAtHandlerTime = modeSpy.mock.calls.at(-1)?.[0];
            return new Response("dynamic");
          },
        },
        routeSegments: ["api", "force-dynamic"],
      },
      scheduleBackgroundRegeneration() {
        throw new Error("force-dynamic handler should not schedule regeneration");
      },
      searchParams: new URLSearchParams(),
    });

    expect(response.status).toBe(200);
    expect(forceDynamicDefaultAtHandlerTime).toBe(true);
    expect(fetchCacheModeAtHandlerTime).toBeNull();
    expect(revalidateSpy).toHaveBeenCalledWith(null);

    modeSpy.mockRestore();
    revalidateSpy.mockRestore();
    forceDynamicSpy.mockRestore();
  });

  it("applies the handler's explicit fetchCache export without the force-dynamic default", async () => {
    const fetchCacheShims = await import("../packages/vinext/src/shims/fetch-cache.js");
    const modeSpy = vi.spyOn(fetchCacheShims, "setCurrentFetchCacheMode");
    const revalidateSpy = vi.spyOn(fetchCacheShims, "setCurrentFetchRevalidate");
    const forceDynamicSpy = vi.spyOn(fetchCacheShims, "setCurrentForceDynamicFetchDefault");

    let forceDynamicDefaultAtHandlerTime: boolean | undefined;
    let fetchCacheModeAtHandlerTime: unknown = "unset";

    const response = await dispatchAppRouteHandler({
      cleanPathname: "/api/segment-fetch-cache",
      clearRequestContext() {},
      draftModeSecret: "test-draft-secret",
      i18n: null,
      isDevelopment: false,
      isProduction: false,
      async isrGet() {
        return null;
      },
      isrRouteKey(pathname) {
        return "route:" + pathname;
      },
      async isrSet() {},
      middlewareContext: { headers: null, status: null },
      middlewareRequestHeaders: null,
      params: {},
      request: new Request("https://example.com/api/segment-fetch-cache"),
      route: {
        pattern: "/api/segment-fetch-cache",
        routeHandler: {
          fetchCache: "force-cache",
          GET() {
            forceDynamicDefaultAtHandlerTime = forceDynamicSpy.mock.calls.at(-1)?.[0];
            fetchCacheModeAtHandlerTime = modeSpy.mock.calls.at(-1)?.[0];
            return new Response("cached-fetches");
          },
        },
        routeSegments: ["api", "segment-fetch-cache"],
      },
      scheduleBackgroundRegeneration() {
        throw new Error("uncached handler should not schedule regeneration");
      },
      searchParams: new URLSearchParams(),
    });

    expect(response.status).toBe(200);
    expect(forceDynamicDefaultAtHandlerTime).toBe(false);
    expect(fetchCacheModeAtHandlerTime).toBe("force-cache");
    expect(revalidateSpy).toHaveBeenCalledWith(null);

    modeSpy.mockRestore();
    revalidateSpy.mockRestore();
    forceDynamicSpy.mockRestore();
  });

  it("re-applies the handler's fetch cache mode inside the background regeneration context", async () => {
    const fetchCacheShims = await import("../packages/vinext/src/shims/fetch-cache.js");
    const modeSpy = vi.spyOn(fetchCacheShims, "setCurrentFetchCacheMode");
    const revalidateSpy = vi.spyOn(fetchCacheShims, "setCurrentFetchRevalidate");
    const forceDynamicSpy = vi.spyOn(fetchCacheShims, "setCurrentForceDynamicFetchDefault");

    let scheduledRender: (() => Promise<void>) | undefined;
    let forceDynamicDefaultAtRegenTime: boolean | undefined;
    let fetchCacheModeAtRegenTime: unknown = "unset";
    let afterRan = false;

    const response = await dispatchAppRouteHandler({
      cleanPathname: "/api/stale-fetch-cache",
      clearRequestContext() {},
      draftModeSecret: "test-draft-secret",
      i18n: null,
      isDevelopment: false,
      isProduction: true,
      async isrGet() {
        return buildISRCacheEntry(buildCachedRouteValue("stale"), true);
      },
      isrRouteKey(pathname) {
        return "route:" + pathname;
      },
      async isrSet() {},
      middlewareContext: { headers: null, status: null },
      middlewareRequestHeaders: null,
      params: {},
      request: new Request("https://example.com/api/stale-fetch-cache"),
      route: {
        pattern: "/api/stale-fetch-cache",
        routeHandler: {
          fetchCache: "force-cache",
          revalidate: 60,
          GET() {
            forceDynamicDefaultAtRegenTime = forceDynamicSpy.mock.calls.at(-1)?.[0];
            fetchCacheModeAtRegenTime = modeSpy.mock.calls.at(-1)?.[0];
            after(() => {
              afterRan = true;
            });
            return new Response("regenerated");
          },
        },
        routeSegments: ["api", "stale-fetch-cache"],
      },
      scheduleBackgroundRegeneration(_key, renderFn) {
        scheduledRender = renderFn;
      },
      searchParams: new URLSearchParams(),
    });

    expect(response.headers.get("x-vinext-cache")).toBe("STALE");
    expect(typeof scheduledRender).toBe("function");
    if (typeof scheduledRender !== "function") {
      throw new Error("expected stale route handler cache to schedule regeneration");
    }

    await scheduledRender();

    expect(forceDynamicDefaultAtRegenTime).toBe(false);
    expect(fetchCacheModeAtRegenTime).toBe("force-cache");
    expect(revalidateSpy).toHaveBeenLastCalledWith(60);
    expect(afterRan).toBe(true);

    modeSpy.mockRestore();
    revalidateSpy.mockRestore();
    forceDynamicSpy.mockRestore();
  });

  it("drains tag invalidation during stale route background regeneration", async () => {
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
    let routeCacheWritten = false;
    let scheduledRender: (() => Promise<void>) | undefined;

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
      const response = await dispatchAppRouteHandler({
        cleanPathname: "/api/stale-revalidate",
        clearRequestContext() {},
        draftModeSecret: "test-draft-secret",
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
          expect(invalidationFinished).toBe(true);
          routeCacheWritten = true;
        },
        middlewareContext: { headers: null, status: null },
        middlewareRequestHeaders: null,
        params: {},
        request: new Request("https://example.com/api/stale-revalidate"),
        route: {
          pattern: "/api/stale-revalidate",
          routeHandler: {
            revalidate: 60,
            GET() {
              expect(revalidateTag("dashboard", { expire: 0 })).toBeUndefined();
              return new Response("regenerated");
            },
          },
          routeSegments: ["api", "stale-revalidate"],
        },
        scheduleBackgroundRegeneration(_key, renderFn) {
          scheduledRender = renderFn;
        },
        searchParams: new URLSearchParams(),
      });

      expect(response.headers.get("x-vinext-cache")).toBe("STALE");
      if (!scheduledRender) {
        throw new Error("expected stale route handler cache to schedule regeneration");
      }

      const regenerationPromise = scheduledRender();
      await invalidationStarted;
      expect(routeCacheWritten).toBe(false);
      releaseInvalidation();
      await regenerationPromise;
      expect(routeCacheWritten).toBe(false);
    } finally {
      releaseInvalidation();
      setDataCacheHandler(previousHandler);
    }
  });

  it("does not replace a stale Route Handler entry with a regenerated 500", async () => {
    let scheduledRender: (() => Promise<void>) | undefined;
    const isrSet = vi.fn(async () => {});
    const response = await dispatchAppRouteHandler({
      cleanPathname: "/api/stale-error",
      clearRequestContext() {},
      draftModeSecret: "test-draft-secret",
      i18n: null,
      isDevelopment: false,
      isProduction: true,
      async isrGet() {
        return buildISRCacheEntry(buildCachedRouteValue("stale"), true);
      },
      isrRouteKey: (pathname) => `route:${pathname}`,
      isrSet,
      middlewareContext: { headers: null, status: null },
      middlewareRequestHeaders: null,
      params: null,
      request: new Request("https://example.com/api/stale-error"),
      route: {
        pattern: "/api/stale-error",
        routeHandler: {
          revalidate: 60,
          GET() {
            return new Response("failed", { status: 500 });
          },
        },
        routeSegments: ["api", "stale-error"],
      },
      scheduleBackgroundRegeneration(_key, renderFn) {
        scheduledRender = renderFn;
      },
      searchParams: new URLSearchParams(),
    });

    expect(response.headers.get("x-vinext-cache")).toBe("STALE");
    expect(scheduledRender).toBeTypeOf("function");
    await scheduledRender!();
    expect(isrSet).not.toHaveBeenCalled();
  });
});
