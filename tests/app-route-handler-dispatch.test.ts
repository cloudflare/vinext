import { describe, expect, it, vi } from "vite-plus/test";
import { dispatchAppRouteHandler } from "../packages/vinext/src/server/app-route-handler-dispatch.js";
import type { CachedRouteValue } from "../packages/vinext/src/shims/cache.js";
import { io, revalidatePath, revalidateTag } from "../packages/vinext/src/shims/cache.js";
import { workUnitAsyncStorage } from "../packages/vinext/src/shims/internal/work-unit-async-storage.js";
import {
  getDataCacheHandler,
  setDataCacheHandler,
} from "../packages/vinext/src/shims/cache-handler.js";
import type { ISRCacheEntry } from "../packages/vinext/src/server/isr-cache.js";
import {
  DefaultCdnCacheAdapter,
  getCdnCacheAdapter,
  setCdnCacheAdapter,
} from "../packages/vinext/src/shims/cdn-cache.js";
import {
  cookies,
  draftMode,
  headers,
  markDynamicUsage,
  setHeadersContext,
} from "../packages/vinext/src/shims/headers.js";
import { runWithExecutionContext } from "../packages/vinext/src/shims/request-context.js";
import {
  createRequestContext,
  getRequestContext,
  runWithRequestContext,
} from "../packages/vinext/src/shims/unified-request-context.js";
import { setCurrentFetchSoftTags } from "../packages/vinext/src/shims/fetch-cache.js";
import { getRootParam } from "../packages/vinext/src/shims/root-params.js";
import { withResponseStageCacheability } from "../packages/vinext/src/server/response-stage-cacheability.js";
import { VINEXT_ROUTE_MISS_HEADER } from "../packages/vinext/src/server/headers.js";
import { CloudflareCdnCacheAdapter } from "../packages/cloudflare/src/cache/cdn-adapter.runtime.js";
import { after, connection } from "../packages/vinext/src/shims/server.js";
import { _isOnDemandRevalidate } from "../packages/vinext/src/shims/cache-request-state.js";
import {
  getRevalidateSecret,
  PRERENDER_REVALIDATE_HEADER,
} from "../packages/vinext/src/server/revalidation-request.js";

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
  it.each([400, 500])(
    "retains established ISR eligibility after hard expiry for status %s",
    async (status) => {
      const write = vi.fn();
      const response = await dispatchAppRouteHandler({
        cleanPathname: "/api/expired-status",
        clearRequestContext() {},
        draftModeSecret: "test-secret",
        isDevelopment: false,
        isProduction: true,
        isrGet: async () => ({
          ...buildISRCacheEntry(buildCachedRouteValue("old")),
          isExpired: true,
        }),
        isrRouteKey: (path) => path,
        isrSet: write,
        middlewareContext: { headers: null, status: null },
        params: null,
        request: new Request("https://example.com/api/expired-status"),
        route: {
          pattern: "/api/expired-status",
          routeSegments: ["api", "expired-status"],
          routeHandler: {
            revalidate: 2,
            GET: () =>
              new Response("regenerated error", {
                status,
                headers: { "Cache-Control": "private, max-age=300" },
              }),
          },
        },
        scheduleBackgroundRegeneration() {
          throw new Error("expired entries regenerate in the foreground");
        },
        searchParams: new URLSearchParams(),
      });
      expect(response.status).toBe(status);
      expect(response.headers.get("Cache-Control")).toBe("private, max-age=300");
      await expect.poll(() => write.mock.calls.length).toBe(1);
      expect(write.mock.calls[0][1].status).toBe(status);
    },
  );

  // Ported from Next.js: test/e2e/on-request-error/isr/isr.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/on-request-error/isr/isr.test.ts
  it.each([
    { reason: "stale" as const, onDemand: false },
    { reason: "on-demand" as const, onDemand: true },
  ])("reports $reason App Route revalidation errors", async ({ reason, onDemand }) => {
    let markReportingStarted!: () => void;
    const reportingStarted = new Promise<void>((resolve) => {
      markReportingStarted = resolve;
    });
    let releaseReporting!: () => void;
    const reportingGate = new Promise<void>((resolve) => {
      releaseReporting = resolve;
    });
    const onRequestError = vi.fn(async () => {
      markReportingStarted();
      await reportingGate;
    });
    globalThis.__VINEXT_onRequestErrorHandler__ = onRequestError;

    try {
      let dispatchSettled = false;
      const responsePromise = dispatchAppRouteHandler({
        cleanPathname: "/api/failed/123",
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
        params: { id: "123" },
        request: new Request("https://example.com/api/failed/123", {
          headers: onDemand ? { [PRERENDER_REVALIDATE_HEADER]: getRevalidateSecret() } : undefined,
        }),
        route: {
          pattern: "/api/failed/[id]",
          routeHandler: {
            GET() {
              throw new Error("route revalidation failed");
            },
            revalidate: 60,
          },
          routeSegments: ["api", "failed", "[id]"],
        },
        scheduleBackgroundRegeneration() {},
        searchParams: new URLSearchParams(),
      }).then((response) => {
        dispatchSettled = true;
        return response;
      });
      await reportingStarted;
      expect(dispatchSettled).toBe(false);
      releaseReporting();

      const response = await responsePromise;
      expect(response.status).toBe(500);
      expect(onRequestError).toHaveBeenCalledWith(
        expect.objectContaining({ message: "route revalidation failed" }),
        expect.objectContaining({ path: "/api/failed/123" }),
        {
          routerKind: "App Router",
          routePath: "/api/failed/[id]",
          routeType: "route",
          revalidateReason: reason,
        },
      );
    } finally {
      delete globalThis.__VINEXT_onRequestErrorHandler__;
    }
  });

  it.each([
    { label: "revalidate = 0", revalidate: 0 },
    { label: "revalidate = false", revalidate: false },
    { dynamic: "force-dynamic", label: "force-dynamic", revalidate: 60 },
    { draft: true, label: "draft mode", revalidate: 60 },
  ])(
    "does not label $label App Route errors as stale",
    async ({ draft = false, dynamic, revalidate }) => {
      const onRequestError = vi.fn();
      globalThis.__VINEXT_onRequestErrorHandler__ = onRequestError;
      const isrGet = vi.fn(async () => null);

      try {
        const response = await dispatchAppRouteHandler({
          cleanPathname: "/api/uncached",
          clearRequestContext() {},
          draftModeSecret: "test-draft-secret",
          i18n: null,
          isDevelopment: false,
          isProduction: true,
          isrGet,
          isrRouteKey(pathname) {
            return "route:" + pathname;
          },
          async isrSet() {},
          middlewareContext: { headers: null, status: null },
          middlewareRequestHeaders: null,
          params: null,
          request: new Request("https://example.com/api/uncached", {
            headers: draft ? { cookie: "__prerender_bypass=test-draft-secret" } : undefined,
          }),
          route: {
            pattern: "/api/uncached",
            routeHandler: {
              dynamic,
              GET() {
                throw new Error("uncached route failed");
              },
              revalidate,
            },
            routeSegments: ["api", "uncached"],
          },
          scheduleBackgroundRegeneration() {},
          searchParams: new URLSearchParams(),
        });

        expect(response.status).toBe(500);
        expect(isrGet).toHaveBeenCalledTimes(revalidate === false ? 1 : 0);
        expect(onRequestError.mock.calls[0]?.[2]).toEqual({
          routerKind: "App Router",
          routePath: "/api/uncached",
          routeType: "route",
          revalidateReason: undefined,
        });
      } finally {
        delete globalThis.__VINEXT_onRequestErrorHandler__;
      }
    },
  );

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

  it("keeps route-identity-divergent handlers out of origin and CDN caches", async () => {
    const isrGet = vi.fn(async () => buildISRCacheEntry(buildCachedRouteValue("victim")));
    const isrSet = vi.fn();
    const handlerSpy = vi.fn(
      () =>
        new Response("encoded catch-all", {
          headers: { "Cache-Control": "public, s-maxage=3600" },
        }),
    );

    const response = await dispatchAppRouteHandler({
      bypassSharedCache: true,
      cleanPathname: "/api/about",
      clearRequestContext() {},
      draftModeSecret: "test-draft-secret",
      i18n: null,
      isDevelopment: false,
      isProduction: true,
      isrGet,
      isrRouteKey: (pathname) => `route:${pathname}`,
      isrSet,
      middlewareContext: { headers: null, status: null },
      middlewareRequestHeaders: null,
      params: { slug: ["about"] },
      request: new Request("https://example.com/api/%61bout"),
      route: {
        pattern: "/api/:slug+",
        routeHandler: { GET: handlerSpy, revalidate: 3600 },
        routeSegments: ["api", "[...slug]"],
      },
      scheduleBackgroundRegeneration() {},
      searchParams: new URLSearchParams(),
    });

    expect(isrGet).not.toHaveBeenCalled();
    expect(isrSet).not.toHaveBeenCalled();
    expect(handlerSpy).toHaveBeenCalledOnce();
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    await expect(response.text()).resolves.toBe("encoded catch-all");
  });

  it("keeps mixed-method handlers out of the normal ISR cache path", async () => {
    const isrGet = vi.fn(async () => buildISRCacheEntry(buildCachedRouteValue("unsafe-hit")));
    const isrSet = vi.fn();
    const response = await dispatchAppRouteHandler({
      cleanPathname: "/api/mixed",
      clearRequestContext() {},
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
      request: new Request("https://example.com/api/mixed"),
      route: {
        pattern: "/api/mixed",
        routeHandler: {
          GET() {
            return new Response("fresh");
          },
          POST() {
            return new Response(null, { status: 204 });
          },
          revalidate: 60,
        },
        routeSegments: ["api", "mixed"],
      },
      scheduleBackgroundRegeneration() {},
      searchParams: new URLSearchParams(),
    });

    expect(isrGet).not.toHaveBeenCalled();
    expect(isrSet).not.toHaveBeenCalled();
    expect(response.headers.get("cache-control")).toBeNull();
    expect(response.headers.get("x-vinext-cache")).toBeNull();
    await expect(response.text()).resolves.toBe("fresh");
  });

  describe("dynamicParams = false", () => {
    function dispatchClosedRoute(options: {
      cached?: boolean;
      generateStaticParams?: () => Record<string, unknown>[] | Promise<Record<string, unknown>[]>;
      handlerConfig?: Record<string, unknown>;
      isProduction?: boolean;
      method?: string;
      params: Record<string, string | string[]>;
      pathname: string;
      pattern: string;
      renderNotFound?: () => Promise<Response>;
      skipStaticParamsValidation?: boolean;
    }) {
      const handlerCalls: unknown[] = [];
      const renderNotFound = vi.fn(
        options.renderNotFound ?? (async () => new Response("not found page", { status: 404 })),
      );
      const response = dispatchAppRouteHandler({
        cleanPathname: options.pathname,
        clearRequestContext() {},
        draftModeSecret: "test-draft-secret",
        isDevelopment: options.isProduction === false,
        isProduction: options.isProduction ?? true,
        async isrGet() {
          return options.cached ? buildISRCacheEntry(buildCachedRouteValue("cached")) : null;
        },
        isrRouteKey: (pathname) => pathname,
        async isrSet() {},
        middlewareContext: { headers: null, status: null },
        params: options.params,
        renderNotFound,
        request: new Request(`https://example.com${options.pathname}`, {
          method: options.method,
        }),
        route: {
          pattern: options.pattern,
          routeHandler: {
            ...options.handlerConfig,
            dynamicParams: false,
            generateStaticParams: options.generateStaticParams,
            async GET(_request: Request, context: { params: Promise<unknown> }) {
              handlerCalls.push(await context.params);
              return new Response("handler");
            },
          },
          routeSegments: options.pattern.split("/").filter(Boolean),
        },
        scheduleBackgroundRegeneration() {},
        searchParams: new URLSearchParams(),
        skipStaticParamsValidation: options.skipStaticParamsValidation,
      });
      return { handlerCalls, renderNotFound, response };
    }

    // Verified against next@16.2.7 `next build` / `next start`: a POST export
    // bails out only while a generated path prerenders.
    it("404s every param of a mixed-method route whose generator returns none", async () => {
      const POST = () => new Response("post");
      const emptyGenerator = vi.fn(() => []);
      const empty = dispatchClosedRoute({
        generateStaticParams: emptyGenerator,
        handlerConfig: { POST },
        params: { slug: "any" },
        pathname: "/posts/any",
        pattern: "/posts/:slug",
      });
      expect((await empty.response).status).toBe(404);
      expect(empty.handlerCalls).toEqual([]);
      expect(emptyGenerator).toHaveBeenCalledTimes(1);

      const generator = vi.fn(() => [{ slug: "listed" }]);
      const generated = dispatchClosedRoute({
        generateStaticParams: generator,
        handlerConfig: { POST },
        params: { slug: "unlisted" },
        pathname: "/posts/unlisted",
        pattern: "/posts/:slug",
      });
      expect((await generated.response).status).toBe(200);
      expect(generated.handlerCalls).toEqual([{ slug: "unlisted" }]);
      expect(generator).toHaveBeenCalledTimes(1);

      // Next.js skips a row with an empty required segment, so it lists no
      // path either.
      const emptySegment = dispatchClosedRoute({
        generateStaticParams: () => [{ slug: "" }],
        handlerConfig: { POST },
        params: { slug: "any" },
        pathname: "/posts/any",
        pattern: "/posts/:slug",
      });
      expect((await emptySegment.response).status).toBe(404);
      expect(emptySegment.handlerCalls).toEqual([]);
    });

    it("admits a listed param named __proto__", async () => {
      const ownProto = (value: string) =>
        JSON.parse(`{"__proto__":${JSON.stringify(value)}}`) as Record<string, string>;
      const generateStaticParams = () => [ownProto("listed")];
      const listed = dispatchClosedRoute({
        generateStaticParams,
        params: ownProto("listed"),
        pathname: "/x/listed",
        pattern: "/x/:__proto__",
      });
      expect((await listed.response).status).toBe(200);

      const unlisted = dispatchClosedRoute({
        generateStaticParams,
        params: ownProto("unlisted"),
        pathname: "/x/unlisted",
        pattern: "/x/:__proto__",
      });
      expect((await unlisted.response).status).toBe(404);
    });

    it("does not run generateStaticParams again for params routing admitted", async () => {
      const generateStaticParams = vi.fn(() => [{ slug: "listed" }]);
      const admitted = dispatchClosedRoute({
        generateStaticParams,
        params: { slug: "listed" },
        pathname: "/posts/listed",
        pattern: "/posts/:slug",
        skipStaticParamsValidation: true,
      });
      expect((await admitted.response).status).toBe(200);
      expect(admitted.handlerCalls).toEqual([{ slug: "listed" }]);
      expect(generateStaticParams).not.toHaveBeenCalled();
    });

    it("runs generateStaticParams with the route's fetchCache before an auto-OPTIONS response", async () => {
      let fetchStateAtGenerateTime: unknown = "unset";
      const result = await runWithRequestContext(createRequestContext(), async () => {
        const closed = dispatchClosedRoute({
          generateStaticParams() {
            const ctx = getRequestContext();
            fetchStateAtGenerateTime = {
              mode: ctx.currentFetchCacheMode,
              revalidate: ctx.currentFetchRevalidate,
            };
            return [{ slug: "listed" }];
          },
          // Next.js applies only the segment's fetchCache to the generator.
          handlerConfig: { fetchCache: "only-cache", revalidate: 60 },
          method: "OPTIONS",
          params: { slug: "listed" },
          pathname: "/posts/listed",
          pattern: "/posts/:slug",
        });
        return (await closed.response).status;
      });
      expect(result).toBe(204);
      expect(fetchStateAtGenerateTime).toEqual({
        mode: "only-cache",
        revalidate: null,
      });
    });

    it.each([
      { name: "a GET-only route", handlerConfig: {} },
      { name: "a mixed-method route", handlerConfig: { POST: () => new Response("post") } },
    ])(
      "runs generateStaticParams without the request's root params on $name",
      async ({ handlerConfig }) => {
        const result = await runWithRequestContext(
          createRequestContext({ rootParams: { lang: "fr" } }),
          async () => {
            const closed = dispatchClosedRoute({
              async generateStaticParams() {
                const lang = await getRootParam("lang");
                return lang ? [{ lang }] : [];
              },
              handlerConfig,
              params: { lang: "fr" },
              pathname: "/fr/data",
              pattern: "/:lang/data",
            });
            return { status: (await closed.response).status, handlerCalls: closed.handlerCalls };
          },
        );
        expect(result).toEqual({ status: 404, handlerCalls: [] });
      },
    );

    it("keeps generateStaticParams' fetch state out of the request", async () => {
      const ctx = createRequestContext();
      await runWithRequestContext(ctx, async () => {
        const result = dispatchClosedRoute({
          generateStaticParams() {
            // What a tagged no-store fetch records.
            getRequestContext().currentRequestTags.push("generator-tag");
            getRequestContext().dynamicFetchUrls.add("https://example.com/generator");
            return [{ slug: "listed" }];
          },
          params: { slug: "listed" },
          pathname: "/posts/listed",
          pattern: "/posts/:slug",
        });
        expect((await result.response).status).toBe(200);
      });
      expect(ctx.currentRequestTags).not.toContain("generator-tag");
      expect([...ctx.dynamicFetchUrls]).toEqual([]);
    });

    it("keeps generateStaticParams' dynamic usage out of the request", async () => {
      const ctx = createRequestContext();
      await runWithRequestContext(ctx, async () => {
        const result = dispatchClosedRoute({
          generateStaticParams() {
            // What a no-store fetch records.
            markDynamicUsage();
            return [{ slug: "listed" }];
          },
          params: { slug: "listed" },
          pathname: "/posts/listed",
          pattern: "/posts/:slug",
        });
        expect((await result.response).status).toBe(200);
      });
      expect(ctx.dynamicUsageDetected).toBe(false);
      expect(ctx.renderDynamicLatch?.dynamic).toBe(false);
    });

    it("rejects request APIs in generateStaticParams, as Next.js does", async () => {
      const errors: string[] = [];
      const ctx = createRequestContext({
        headersContext: {
          headers: new Headers({ "x-listed-slug": "unlisted" }),
          cookies: new Map([["slug", "unlisted"]]),
        },
      });
      const result = await runWithRequestContext(ctx, async () => {
        const closed = dispatchClosedRoute({
          async generateStaticParams() {
            // A generator must not list the requested param from the request.
            const fromHeader = await headers().then(
              (requestHeaders) => requestHeaders.get("x-listed-slug"),
              (error: Error) => (errors.push(error.message), null),
            );
            const fromCookie = await cookies().then(
              (requestCookies) => requestCookies.get("slug")?.value,
              (error: Error) => (errors.push(error.message), null),
            );
            const fromConnection = await connection().then(
              () => "unlisted",
              (error: Error) => (errors.push(error.message), null),
            );
            const fromDraftMode = await draftMode().then(
              (draft) => (draft.isEnabled ? "listed" : "unlisted"),
              (error: Error) => (errors.push(error.message), null),
            );
            return [
              { slug: fromHeader ?? fromCookie ?? fromConnection ?? fromDraftMode ?? "listed" },
            ];
          },
          params: { slug: "unlisted" },
          pathname: "/posts/unlisted",
          pattern: "/posts/:slug",
        });
        return { status: (await closed.response).status, handlerCalls: closed.handlerCalls };
      });
      expect(result).toEqual({ status: 404, handlerCalls: [] });
      expect(errors).toHaveLength(4);
      for (const message of errors) {
        expect(message).toContain("inside `generateStaticParams`");
      }
    });

    it("resolves io() and rejects revalidation in generateStaticParams, as Next.js does", async () => {
      const errors: string[] = [];
      const renderSignal = new AbortController().signal;
      // A Cache Components prerender would otherwise hang the generator's io().
      const result = await workUnitAsyncStorage.run(
        { type: "prerender", renderSignal },
        async () => {
          const closed = dispatchClosedRoute({
            async generateStaticParams() {
              await io();
              for (const revalidate of [
                () => revalidateTag("posts"),
                () => revalidatePath("/posts"),
              ]) {
                try {
                  revalidate();
                } catch (error) {
                  errors.push((error as Error).message);
                }
              }
              return [{ slug: "listed" }];
            },
            params: { slug: "unlisted" },
            pathname: "/posts/unlisted",
            pattern: "/posts/:slug",
          });
          return (await closed.response).status;
        },
      );
      expect(result).toBe(404);
      expect(errors).toEqual([
        expect.stringContaining('used "revalidateTag posts" inside `generateStaticParams`'),
        expect.stringContaining('used "revalidatePath /posts" inside `generateStaticParams`'),
      ]);
    });

    it("keeps middleware's draft-mode disable on a rejected param's rendered 404", async () => {
      const ctx = createRequestContext({
        headersContext: {
          headers: new Headers(),
          cookies: new Map([["__prerender_bypass", "test-draft-secret"]]),
          draftModeSecret: "test-draft-secret",
        },
      });
      const response = await runWithRequestContext(ctx, async () => {
        (await draftMode()).disable();
        return dispatchClosedRoute({
          generateStaticParams: () => [{ slug: "listed" }],
          params: { slug: "unlisted" },
          pathname: "/posts/unlisted",
          pattern: "/posts/:slug",
        }).response;
      });
      expect(response.status).toBe(404);
      expect(await response.text()).toBe("not found page");
      expect(response.headers.get("set-cookie")).toContain("__prerender_bypass=;");
    });

    it("compares decoded params as Next.js does", async () => {
      const generateStaticParams = () => [{ slug: "public post" }];
      const listed = dispatchClosedRoute({
        generateStaticParams,
        params: { slug: "public post" },
        pathname: "/posts/public%20post",
        pattern: "/posts/:slug",
      });
      expect((await listed.response).status).toBe(200);
      expect(listed.handlerCalls).toEqual([{ slug: "public post" }]);

      // `/posts/public%2520post` decodes to an unlisted value.
      const unlisted = dispatchClosedRoute({
        generateStaticParams,
        params: { slug: "public%20post" },
        pathname: "/posts/public%2520post",
        pattern: "/posts/:slug",
      });
      const unlistedResponse = await unlisted.response;
      expect(unlistedResponse.status).toBe(404);
      expect(await unlistedResponse.text()).toBe("not found page");
      expect(unlistedResponse.headers.get("cache-control")).toBe(
        "private, no-cache, no-store, max-age=0, must-revalidate",
      );
      expect(unlisted.handlerCalls).toEqual([]);
    });

    it("rejects a missing optional catch-all the generated params do not list", async () => {
      const generateStaticParams = () => [{ slug: ["a"] }];
      const missing = dispatchClosedRoute({
        generateStaticParams,
        params: {},
        pathname: "/docs",
        pattern: "/docs/:slug*",
      });
      expect((await missing.response).status).toBe(404);
      expect(missing.handlerCalls).toEqual([]);

      const listed = dispatchClosedRoute({
        generateStaticParams,
        params: { slug: ["a"] },
        pathname: "/docs/a",
        pattern: "/docs/:slug*",
      });
      expect((await listed.response).status).toBe(200);
    });

    it("serves a cached response without calling generateStaticParams", async () => {
      const generateStaticParams = vi.fn(() => [{ slug: "listed" }]);
      const cached = dispatchClosedRoute({
        cached: true,
        generateStaticParams,
        params: { slug: "listed" },
        pathname: "/posts/listed",
        pattern: "/posts/:slug",
      });
      const response = await cached.response;
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("cached");
      expect(generateStaticParams).not.toHaveBeenCalled();
    });

    it("admits any param without generateStaticParams in dev, as Next.js does", async () => {
      const result = dispatchClosedRoute({
        isProduction: false,
        params: { slug: "anything" },
        pathname: "/posts/anything",
        pattern: "/posts/:slug",
      });
      expect((await result.response).status).toBe(200);
      expect(result.renderNotFound).not.toHaveBeenCalled();
    });

    it("drops a route-miss marker from a stored route response", async () => {
      const stored = buildCachedRouteValue("cached");
      stored.headers[VINEXT_ROUTE_MISS_HEADER] = "1";
      const response = await dispatchAppRouteHandler({
        cleanPathname: "/api/stored",
        clearRequestContext() {},
        draftModeSecret: "test-secret",
        isDevelopment: false,
        isProduction: true,
        isrGet: async () => buildISRCacheEntry(stored),
        isrRouteKey: (path) => path,
        isrSet: async () => {},
        middlewareContext: { headers: null, status: null },
        params: null,
        request: new Request("https://example.com/api/stored"),
        route: {
          pattern: "/api/stored",
          routeSegments: ["api", "stored"],
          routeHandler: { revalidate: 60, GET: () => new Response("live") },
        },
        scheduleBackgroundRegeneration() {},
        searchParams: new URLSearchParams(),
      });
      await expect(response.text()).resolves.toBe("cached");
      expect(response.headers.has(VINEXT_ROUTE_MISS_HEADER)).toBe(false);
    });

    it.each([
      {
        name: "mutable headers",
        GET: () => new Response("ok", { headers: { [VINEXT_ROUTE_MISS_HEADER]: "1" } }),
      },
      {
        // As on a proxied fetch() response.
        name: "immutable headers",
        GET: () => {
          const response = new Response("ok", { headers: { [VINEXT_ROUTE_MISS_HEADER]: "1" } });
          response.headers.delete = () => {
            throw new TypeError("immutable");
          };
          return response;
        },
      },
      {
        name: "headers its body's producer sets",
        GET: () => {
          let response: Response;
          const body = new ReadableStream(
            {
              pull(controller) {
                response.headers.set(VINEXT_ROUTE_MISS_HEADER, "1");
                controller.enqueue(new TextEncoder().encode("ok"));
                controller.close();
              },
            },
            // Pull only once the body is read.
            { highWaterMark: 0 },
          );
          response = new Response(body);
          return response;
        },
      },
    ])("drops a route-miss marker a handler sets on $name", async ({ GET }) => {
      const response = await dispatchAppRouteHandler({
        cleanPathname: "/api/forged",
        clearRequestContext() {},
        draftModeSecret: "test-secret",
        isDevelopment: false,
        isProduction: true,
        isrGet: async () => null,
        isrRouteKey: (path) => path,
        isrSet: async () => {},
        middlewareContext: { headers: null, status: null },
        params: null,
        request: new Request("https://example.com/api/forged"),
        route: {
          pattern: "/api/forged",
          routeSegments: ["api", "forged"],
          // Cacheable, so the response is completed before it's returned.
          routeHandler: { revalidate: 60, GET },
        },
        scheduleBackgroundRegeneration() {},
        searchParams: new URLSearchParams(),
      });
      await expect(response.text()).resolves.toBe("ok");
      expect(response.headers.has(VINEXT_ROUTE_MISS_HEADER)).toBe(false);
    });

    it("stores a regenerated response without a route-miss marker the handler set", async () => {
      let scheduledRender: (() => Promise<void>) | undefined;
      const write = vi.fn();
      await dispatchAppRouteHandler({
        cleanPathname: "/api/forged-stale",
        clearRequestContext() {},
        draftModeSecret: "test-secret",
        isDevelopment: false,
        isProduction: true,
        isrGet: async () => buildISRCacheEntry(buildCachedRouteValue("stale"), true),
        isrRouteKey: (path) => path,
        isrSet: write,
        middlewareContext: { headers: null, status: null },
        params: null,
        request: new Request("https://example.com/api/forged-stale"),
        route: {
          pattern: "/api/forged-stale",
          routeSegments: ["api", "forged-stale"],
          routeHandler: {
            revalidate: 60,
            GET: () => {
              let response: Response;
              const body = new ReadableStream(
                {
                  pull(controller) {
                    response.headers.set(VINEXT_ROUTE_MISS_HEADER, "1");
                    controller.enqueue(new TextEncoder().encode("regenerated"));
                    controller.close();
                  },
                },
                { highWaterMark: 0 },
              );
              response = new Response(body, { headers: { [VINEXT_ROUTE_MISS_HEADER]: "1" } });
              return response;
            },
          },
        },
        scheduleBackgroundRegeneration(_key, renderFn) {
          scheduledRender = renderFn;
        },
        searchParams: new URLSearchParams(),
      });
      await scheduledRender?.();
      expect(write).toHaveBeenCalledTimes(1);
      expect(write.mock.calls[0][1].headers).not.toHaveProperty(VINEXT_ROUTE_MISS_HEADER);
    });

    it("renders the 404 without the route's fetch defaults or tags", async () => {
      let fetchState: unknown = null;
      await runWithRequestContext(createRequestContext(), async () => {
        setCurrentFetchSoftTags(["_N_T_/posts/unlisted"]);
        const rejected = dispatchClosedRoute({
          generateStaticParams: () => [{ slug: "listed" }],
          handlerConfig: { fetchCache: "force-cache", revalidate: 60 },
          params: { slug: "unlisted" },
          pathname: "/posts/unlisted",
          pattern: "/posts/:slug",
          async renderNotFound() {
            const context = getRequestContext();
            fetchState = {
              cacheMode: context.currentFetchCacheMode,
              forceDynamic: context.currentForceDynamicFetchDefault,
              revalidate: context.currentFetchRevalidate,
              softTags: context.currentFetchSoftTags,
            };
            return new Response("not found page", { status: 404 });
          },
        });
        expect((await rejected.response).status).toBe(404);
      });

      // As for an unmatched URL.
      expect(fetchState).toEqual({
        cacheMode: null,
        forceDynamic: false,
        revalidate: null,
        softTags: [],
      });
    });

    it("keeps the 404 out of a split stage's shared cache under a public config policy", async () => {
      setCdnCacheAdapter(new CloudflareCdnCacheAdapter());
      try {
        let rejected: ReturnType<typeof dispatchClosedRoute> | undefined;
        const response = await withResponseStageCacheability(
          {
            buildId: "build-a",
            cache: "shared",
            context: { waitUntil() {} },
            policyHeaders: [["Cloudflare-CDN-Cache-Control", "public, s-maxage=3600"]],
            rawManifest: null,
            registerCacheAdapters() {},
            request: new Request("https://example.com/posts/unlisted"),
            resolvedRoutePathname: "/posts/unlisted",
          },
          (context) =>
            runWithExecutionContext(context, () => {
              rejected = dispatchClosedRoute({
                generateStaticParams: () => [{ slug: "listed" }],
                params: { slug: "unlisted" },
                pathname: "/posts/unlisted",
                pattern: "/posts/:slug",
              });
              return rejected.response;
            }),
        );

        expect(response.status).toBe(404);
        expect(rejected?.handlerCalls).toEqual([]);
        expect(response.headers.get("cloudflare-cdn-cache-control")).toBeNull();
        expect(response.headers.get("cache-control")).toBe("no-store, must-revalidate");
        // The request stage reads the marker to reassert the never-cache policy.
        expect(response.headers.get(VINEXT_ROUTE_MISS_HEADER)).toBe("1");
      } finally {
        setCdnCacheAdapter(new DefaultCdnCacheAdapter());
      }
    });
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

  // Next.js's ResponseCache doesn't resolve the previous entry for an
  // on-demand revalidation, so the handler runs in the foreground and is stored.
  it.each([
    { isStale: false, name: "fresh" },
    { isStale: true, name: "stale" },
  ])(
    "regenerates a $name entry in the foreground for an on-demand revalidation",
    async ({ isStale }) => {
      const readPolicy: boolean[] = [];
      const isrGet = vi.fn(async () =>
        buildISRCacheEntry(buildCachedRouteValue("stored"), isStale),
      );
      let releaseWrite!: () => void;
      const writeReleased = new Promise<void>((resolve) => {
        releaseWrite = resolve;
      });
      const isrSet = vi.fn((_key: string, ..._rest: unknown[]) => writeReleased);
      const scheduleBackgroundRegeneration = vi.fn();

      await runWithRequestContext(
        createRequestContext({ isOnDemandRevalidate: true }),
        async () => {
          let dispatched = false;
          const pending = dispatchAppRouteHandler({
            cleanPathname: "/api/on-demand",
            clearRequestContext() {},
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
            params: {},
            request: new Request("https://example.com/api/on-demand", {
              headers: { [PRERENDER_REVALIDATE_HEADER]: getRevalidateSecret() },
            }),
            route: {
              pattern: "/api/on-demand",
              routeHandler: {
                revalidate: 60,
                GET() {
                  readPolicy.push(_isOnDemandRevalidate());
                  return new Response("regenerated");
                },
              },
              routeSegments: ["api", "on-demand"],
            },
            scheduleBackgroundRegeneration,
            searchParams: new URLSearchParams(),
          }).then((response) => {
            dispatched = true;
            return response;
          });
          // Like Next.js, it answers only once the regenerated entry is stored.
          await vi.waitFor(() => expect(isrSet).toHaveBeenCalled());
          await new Promise((resolve) => setTimeout(resolve, 0));
          expect(dispatched).toBe(false);
          releaseWrite();
          const response = await pending;
          expect(await response.text()).toBe("regenerated");
        },
      );

      expect(isrGet).not.toHaveBeenCalled();
      expect(scheduleBackgroundRegeneration).not.toHaveBeenCalled();
      expect(readPolicy).toEqual([true]);
      expect(isrSet).toHaveBeenCalledTimes(1);
      expect(isrSet.mock.calls[0]?.[0]).toBe("route:/api/on-demand");
    },
  );

  // Next.js stores an ISR route's regenerated response whatever its status.
  it.each([400, 500])("stores a %s response from an on-demand revalidation", async (status) => {
    const isrSet = vi.fn(async (_key: string, ..._rest: unknown[]) => {});
    const response = await runWithRequestContext(
      createRequestContext({ isOnDemandRevalidate: true }),
      () =>
        dispatchAppRouteHandler({
          cleanPathname: "/api/on-demand",
          clearRequestContext() {},
          draftModeSecret: "test-draft-secret",
          i18n: null,
          isDevelopment: false,
          isProduction: true,
          isrGet: async () => null,
          isrRouteKey(pathname) {
            return "route:" + pathname;
          },
          isrSet,
          middlewareContext: { headers: null, status: null },
          middlewareRequestHeaders: null,
          params: {},
          request: new Request("https://example.com/api/on-demand", {
            headers: { [PRERENDER_REVALIDATE_HEADER]: getRevalidateSecret() },
          }),
          route: {
            pattern: "/api/on-demand",
            routeHandler: {
              revalidate: 60,
              GET: () => new Response("regenerated error", { status }),
            },
            routeSegments: ["api", "on-demand"],
          },
          scheduleBackgroundRegeneration: vi.fn(),
          searchParams: new URLSearchParams(),
        }),
    );

    expect(response.status).toBe(status);
    await expect.poll(() => isrSet.mock.calls.length).toBe(1);
    expect((isrSet.mock.calls[0]?.[1] as { status?: number } | undefined)?.status).toBe(status);
  });

  // Next.js batches ResponseCache work by its key and isOnDemandRevalidate, so
  // concurrent on-demand revalidations of one route share a run and a write.
  it("shares one handler run between concurrent on-demand revalidations", async () => {
    let runs = 0;
    let releaseRun!: () => void;
    const runReleased = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    const isrSet = vi.fn(async (_key: string, ..._rest: unknown[]) => {});
    const revalidate = () =>
      runWithRequestContext(createRequestContext({ isOnDemandRevalidate: true }), () =>
        dispatchAppRouteHandler({
          cleanPathname: "/api/on-demand",
          clearRequestContext() {},
          draftModeSecret: "test-draft-secret",
          i18n: null,
          isDevelopment: false,
          isProduction: true,
          isrGet: async () => null,
          isrRouteKey(pathname) {
            return "route:" + pathname;
          },
          isrSet,
          middlewareContext: { headers: null, status: null },
          middlewareRequestHeaders: null,
          params: {},
          request: new Request("https://example.com/api/on-demand", {
            headers: { [PRERENDER_REVALIDATE_HEADER]: getRevalidateSecret() },
          }),
          route: {
            pattern: "/api/on-demand",
            routeHandler: {
              revalidate: 60,
              async GET() {
                runs++;
                await runReleased;
                return new Response("regenerated");
              },
            },
            routeSegments: ["api", "on-demand"],
          },
          scheduleBackgroundRegeneration: vi.fn(),
          searchParams: new URLSearchParams(),
        }),
      );

    const pending = [revalidate(), revalidate()];
    await vi.waitFor(() => expect(runs).toBe(1));
    releaseRun();
    const responses = await Promise.all(pending);

    expect(runs).toBe(1);
    expect(isrSet).toHaveBeenCalledTimes(1);
    expect(await Promise.all(responses.map((response) => response.text()))).toEqual([
      "regenerated",
      "regenerated",
    ]);
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
      expect(routeCacheWritten).toBe(true);
    } finally {
      releaseInvalidation();
      setDataCacheHandler(previousHandler);
    }
  });

  it("batches CDN purges queued during stale route background regeneration", async () => {
    const previousAdapter = getCdnCacheAdapter();
    const cdnCalls: string[][] = [];
    setCdnCacheAdapter(
      Object.assign(new DefaultCdnCacheAdapter(), {
        async revalidateTag(tags: string | string[]) {
          cdnCalls.push(Array.isArray(tags) ? tags : [tags]);
        },
      }),
    );
    let scheduledRender: (() => Promise<void>) | undefined;

    try {
      await dispatchAppRouteHandler({
        cleanPathname: "/api/stale-batch",
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
        request: new Request("https://example.com/api/stale-batch"),
        route: {
          pattern: "/api/stale-batch",
          routeHandler: {
            revalidate: 60,
            GET() {
              revalidateTag("posts");
              revalidateTag("feed");
              return new Response("regenerated");
            },
          },
          routeSegments: ["api", "stale-batch"],
        },
        scheduleBackgroundRegeneration(_key, renderFn) {
          scheduledRender = renderFn;
        },
        searchParams: new URLSearchParams(),
      });

      if (!scheduledRender) {
        throw new Error("expected stale route handler cache to schedule regeneration");
      }
      await scheduledRender();
      expect(cdnCalls).toEqual([["posts", "feed"]]);
    } finally {
      setCdnCacheAdapter(previousAdapter);
    }
  });

  it("purges CDN tags revalidated by after() callbacks during stale route regeneration", async () => {
    const previousAdapter = getCdnCacheAdapter();
    const cdnCalls: string[][] = [];
    setCdnCacheAdapter(
      Object.assign(new DefaultCdnCacheAdapter(), {
        async revalidateTag(tags: string | string[]) {
          cdnCalls.push(Array.isArray(tags) ? tags : [tags]);
        },
      }),
    );
    let scheduledRender: (() => Promise<void>) | undefined;

    try {
      await dispatchAppRouteHandler({
        cleanPathname: "/api/stale-after",
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
        request: new Request("https://example.com/api/stale-after"),
        route: {
          pattern: "/api/stale-after",
          routeHandler: {
            revalidate: 60,
            GET() {
              after(() => revalidateTag("late"));
              return new Response("regenerated");
            },
          },
          routeSegments: ["api", "stale-after"],
        },
        scheduleBackgroundRegeneration(_key, renderFn) {
          scheduledRender = renderFn;
        },
        searchParams: new URLSearchParams(),
      });

      if (!scheduledRender) {
        throw new Error("expected stale route handler cache to schedule regeneration");
      }
      await scheduledRender();
      await expect.poll(() => cdnCalls).toEqual([["late"]]);
    } finally {
      setCdnCacheAdapter(previousAdapter);
    }
  });
});
