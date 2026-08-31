import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  computeRscCacheBustingSearchParam,
  createRscRequestHeaders,
  createRscRequestUrl,
  VINEXT_RSC_CACHE_BUSTING_SEARCH_PARAM,
  VINEXT_RSC_VARY_HEADER,
} from "../packages/vinext/src/server/app-rsc-cache-busting.js";
import { createAppRscHandler } from "../packages/vinext/src/server/app-rsc-handler.js";
import { createAppRscRouteMatcher } from "../packages/vinext/src/server/app-rsc-route-matching.js";
import type { AppRouteTreePrefetchRoute } from "../packages/vinext/src/server/app-route-tree-prefetch.js";
import { createArtifactCompatibilityEnvelope } from "../packages/vinext/src/server/artifact-compatibility.js";
import {
  createClientReuseManifest,
  createClientReusePayloadHash,
} from "../packages/vinext/src/server/client-reuse-manifest.js";
import {
  NEXT_ROUTER_PREFETCH_HEADER,
  NEXT_ROUTER_SEGMENT_PREFETCH_HEADER,
  RSC_HEADER,
  VINEXT_CLIENT_REUSE_MANIFEST_HEADER,
  VINEXT_INTERCEPTION_ID_HEADER,
  VINEXT_MW_CTX_HEADER,
} from "../packages/vinext/src/server/headers.js";
import { applyAppMiddleware } from "../packages/vinext/src/server/app-middleware.js";
import type { NextRequest } from "../packages/vinext/src/shims/server.js";
import {
  handleMetadataRouteRequest,
  isMetadataRouteRequestPath,
  type MetadataRuntimeRoute,
} from "../packages/vinext/src/server/metadata-route-response.js";
import type { MiddlewareModule } from "../packages/vinext/src/server/middleware-runtime.js";
import { makeThenableParams } from "../packages/vinext/src/shims/thenable-params.js";
import {
  getHeadersContext,
  headers as requestHeaders,
} from "../packages/vinext/src/shims/headers.js";
import { readStaticFileSignal } from "../packages/vinext/src/server/static-file-signal.js";

type TestRoute = {
  __loadPage?: unknown;
  __loadRouteHandler?: unknown;
  isDynamic: boolean;
  layouts?: readonly unknown[];
  layoutTreePositions?: readonly number[];
  params?: readonly string[];
  page?: { default?: unknown } | null;
  pattern: string;
  rootParamNames?: readonly string[];
  routeHandler?: { GET?: () => Response; runtime?: string } | null;
  routeSegments: readonly string[];
  slots?: AppRouteTreePrefetchRoute["slots"];
};

type HandlerOptions = Parameters<typeof createAppRscHandler<TestRoute>>[0];
type TestHandlerOptions = HandlerOptions & {
  metadataRoutes?: readonly MetadataRuntimeRoute[];
  middlewareFilePath?: string | null;
  isMiddlewareProxy?: boolean;
  middlewareModule?: MiddlewareModule | null;
};
type DispatchMatchedRouteHandler = HandlerOptions["dispatchMatchedRouteHandler"];

function createPageRoute(overrides: Partial<TestRoute> = {}): TestRoute {
  return {
    __loadPage() {},
    isDynamic: false,
    page: { default() {} },
    pattern: "/about",
    routeSegments: ["about"],
    ...overrides,
  };
}

function createHandler(overrides: Partial<TestHandlerOptions> = {}) {
  const route = createPageRoute();

  return createAppRscHandler<TestRoute>({
    basePath: "/docs",
    buildId: overrides.buildId ?? "build-id",
    clearRequestContext: overrides.clearRequestContext ?? (() => {}),
    configHeaders: overrides.configHeaders ?? [
      {
        source: "/about",
        headers: [{ key: "x-test-header", value: "applied" }],
      },
    ],
    configRedirects: overrides.configRedirects ?? [],
    configRewrites: overrides.configRewrites ?? {
      afterFiles: [],
      beforeFiles: [],
      fallback: [],
    },
    draftModeSecret: overrides.draftModeSecret ?? "test-draft-secret",
    dispatchMatchedPage:
      overrides.dispatchMatchedPage ??
      (async () => new Response("page", { status: 200, headers: { "x-from-dispatch": "page" } })),
    dispatchMatchedRouteHandler:
      overrides.dispatchMatchedRouteHandler ?? (async () => new Response("route", { status: 200 })),
    ensureInstrumentation: overrides.ensureInstrumentation,
    handleProgressiveActionRequest:
      "handleProgressiveActionRequest" in overrides
        ? overrides.handleProgressiveActionRequest
        : async () => null,
    handleMetadataRouteRequest:
      overrides.handleMetadataRouteRequest ??
      (overrides.metadataRoutes
        ? (cleanPathname) =>
            handleMetadataRouteRequest({
              metadataRoutes: overrides.metadataRoutes!,
              cleanPathname,
              makeThenableParams,
            })
        : undefined),
    handleServerActionRequest:
      "handleServerActionRequest" in overrides
        ? overrides.handleServerActionRequest
        : async () => null,
    isMetadataRoutePath:
      overrides.isMetadataRoutePath ??
      (overrides.metadataRoutes
        ? (cleanPathname) => isMetadataRouteRequestPath(overrides.metadataRoutes!, cleanPathname)
        : undefined),
    i18nConfig: overrides.i18nConfig ?? null,
    imageConfig: overrides.imageConfig,
    isDev: overrides.isDev ?? true,
    hasInterceptionId: overrides.hasInterceptionId ?? (() => false),
    matchInterceptRoute: overrides.matchInterceptRoute,
    matchRoute:
      overrides.matchRoute ??
      ((pathname: string) =>
        pathname === "/about"
          ? {
              params: {},
              route,
            }
          : null),
    matchRequestRoute: overrides.matchRequestRoute,
    runMiddleware:
      overrides.runMiddleware ??
      (overrides.middlewareModule
        ? (options) =>
            applyAppMiddleware({
              basePath: "/docs",
              ...options,
              filePath: overrides.middlewareFilePath ?? undefined,
              i18nConfig: overrides.i18nConfig ?? null,
              isProxy: overrides.isMiddlewareProxy ?? false,
              module: overrides.middlewareModule!,
              trailingSlash: overrides.trailingSlash ?? false,
            })
        : undefined),
    publicFiles: overrides.publicFiles ?? new Set<string>(),
    registerCacheAdapters: () => {},
    renderNotFound: overrides.renderNotFound ?? (async () => null),
    renderPagesFallback: overrides.renderPagesFallback,
    rootParamNamesByPattern: overrides.rootParamNamesByPattern,
    setNavigationContext: overrides.setNavigationContext ?? (() => {}),
    staticParamsMap: overrides.staticParamsMap ?? {},
    trailingSlash: overrides.trailingSlash ?? false,
    validateDevRequestOrigin: overrides.validateDevRequestOrigin ?? (() => null),
  });
}

function prerenderRouteParamsHeader(payload: unknown): string {
  return encodeURIComponent(JSON.stringify(payload));
}

describe("createAppRscHandler", () => {
  // Ported from Next.js: test/e2e/app-dir/app-basepath/index.test.ts
  // https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-dir/app-basepath/index.test.ts
  it("applies basePath: false rewrites outside the App Router basePath", async () => {
    const handler = createHandler({
      configHeaders: [],
      configRewrites: {
        beforeFiles: [{ source: "/outside", destination: "/about", basePath: false }],
        afterFiles: [],
        fallback: [],
      },
    });

    const response = await handler(new Request("https://example.test/outside"), null);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("page");
  });

  it("allows identity basePath: false rewrites to claim App routes", async () => {
    const handler = createHandler({
      configHeaders: [],
      configRewrites: {
        beforeFiles: [{ source: "/about", destination: "/about", basePath: false }],
        afterFiles: [],
        fallback: [],
      },
    });

    const response = await handler(new Request("https://example.test/about"), null);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("page");
  });

  it.each(["afterFiles", "fallback"] as const)(
    "allows out-of-basePath %s rewrites to reach Pages routes",
    async (phase) => {
      const renderPagesFallback = vi.fn(async () => new Response("pages", { status: 200 }));
      const handler = createHandler({
        configHeaders: [],
        configRewrites: {
          beforeFiles: [],
          afterFiles:
            phase === "afterFiles"
              ? [{ source: "/outside", destination: "/pages", basePath: false }]
              : [],
          fallback:
            phase === "fallback"
              ? [{ source: "/outside", destination: "/pages", basePath: false }]
              : [],
        },
        matchRoute: () => null,
        renderPagesFallback,
      });

      const response = await handler(new Request("https://example.test/outside"), null);

      expect(response.status).toBe(200);
      expect(await response.text()).toBe("pages");
      expect(renderPagesFallback).toHaveBeenCalledWith(
        expect.objectContaining({ pathname: "/pages" }),
      );
    },
  );

  it("passes source config headers into Server Action execution", async () => {
    let sourceConfigHeader: string | null | undefined;
    const handleServerActionRequest: NonNullable<
      HandlerOptions["handleServerActionRequest"]
    > = async (options) => {
      sourceConfigHeader = options.sourceConfigHeaders?.get("x-test-header");
      return new Response("action");
    };
    const handler = createHandler({ handleServerActionRequest });

    await handler(
      new Request("https://example.test/docs/about", {
        method: "POST",
        headers: { "next-action": "action-id", "content-type": "text/plain" },
      }),
      null,
    );

    expect(sourceConfigHeader).toBe("applied");
  });

  it.each(["afterFiles", "fallback"] as const)(
    "allows out-of-basePath POST requests through %s rewrites to App route handlers",
    async (phase) => {
      const route = createPageRoute({
        __loadPage: undefined,
        __loadRouteHandler() {},
        page: null,
        pattern: "/api",
        routeHandler: { GET: () => new Response("route") },
        routeSegments: ["api"],
      });
      const dispatchMatchedRouteHandler = vi.fn(async () => new Response("route", { status: 200 }));
      const handler = createHandler({
        configHeaders: [],
        configRewrites: {
          beforeFiles: [],
          afterFiles:
            phase === "afterFiles"
              ? [{ source: "/outside", destination: "/api", basePath: false }]
              : [],
          fallback:
            phase === "fallback"
              ? [{ source: "/outside", destination: "/api", basePath: false }]
              : [],
        },
        dispatchMatchedRouteHandler,
        matchRoute: (pathname) => (pathname === "/api" ? { params: {}, route } : null),
      });

      const response = await handler(
        new Request("https://example.test/outside", { method: "POST" }),
        null,
      );

      expect(response.status).toBe(200);
      expect(await response.text()).toBe("route");
      expect(dispatchMatchedRouteHandler).toHaveBeenCalledOnce();
    },
  );

  it.each(["afterFiles", "fallback"] as const)(
    "allows out-of-basePath Server Actions through %s rewrites",
    async (phase) => {
      const handleServerActionRequest = vi.fn(async () => new Response("action"));
      const handler = createHandler({
        configHeaders: [],
        configRewrites: {
          beforeFiles: [],
          afterFiles:
            phase === "afterFiles"
              ? [{ source: "/outside", destination: "/about", basePath: false }]
              : [],
          fallback:
            phase === "fallback"
              ? [{ source: "/outside", destination: "/about", basePath: false }]
              : [],
        },
        handleServerActionRequest,
      });

      const response = await handler(
        new Request("https://example.test/outside", {
          method: "POST",
          headers: { "next-action": "action-id", "content-type": "text/plain" },
        }),
        null,
      );

      expect(response.status).toBe(200);
      expect(await response.text()).toBe("action");
      expect(handleServerActionRequest).toHaveBeenCalledWith(
        expect.objectContaining({ cleanPathname: "/about" }),
      );
    },
  );

  it.each(["afterFiles", "fallback"] as const)(
    "allows out-of-basePath progressive Server Actions through %s rewrites",
    async (phase) => {
      const handleProgressiveActionRequest = vi.fn(async () => new Response("progressive-action"));
      const handler = createHandler({
        configHeaders: [],
        configRewrites: {
          beforeFiles: [],
          afterFiles:
            phase === "afterFiles"
              ? [{ source: "/outside", destination: "/about", basePath: false }]
              : [],
          fallback:
            phase === "fallback"
              ? [{ source: "/outside", destination: "/about", basePath: false }]
              : [],
        },
        handleProgressiveActionRequest,
      });

      const response = await handler(
        new Request("https://example.test/outside", {
          method: "POST",
          headers: { "content-type": "multipart/form-data; boundary=vinext" },
        }),
        null,
      );

      expect(response.status).toBe(200);
      expect(await response.text()).toBe("progressive-action");
      expect(handleProgressiveActionRequest).toHaveBeenCalledWith(
        expect.objectContaining({ cleanPathname: "/about" }),
      );
    },
  );

  it.each(["afterFiles", "fallback"] as const)(
    "validates out-of-basePath RSC requests claimed by %s rewrites",
    async (phase) => {
      const headers = createRscRequestHeaders({ mountedSlotsHeader: "slot:modal:/" });
      const expectedHash = await computeRscCacheBustingSearchParam(headers);
      const handler = createHandler({
        configHeaders: [],
        configRewrites: {
          beforeFiles: [],
          afterFiles:
            phase === "afterFiles"
              ? [{ source: "/outside", destination: "/about", basePath: false }]
              : [],
          fallback:
            phase === "fallback"
              ? [{ source: "/outside", destination: "/about", basePath: false }]
              : [],
        },
      });

      const response = await handler(
        new Request("https://example.test/outside.rsc?tab=latest", { headers }),
        null,
      );

      expect(response.status).toBe(307);
      expect(response.headers.get("location")).toBe(`/outside.rsc?tab=latest&_rsc=${expectedHash}`);
    },
  );

  it("does not expose App routes directly outside basePath", async () => {
    const renderNotFound = vi.fn(async () => new Response("rendered not found", { status: 404 }));
    const handler = createHandler({ configHeaders: [], renderNotFound });

    const response = await handler(new Request("https://example.test/about"), null);

    expect(response.status).toBe(404);
    expect(renderNotFound).not.toHaveBeenCalled();
  });

  it("does not redirect invalid RSC requests that remain outside basePath", async () => {
    const headers = createRscRequestHeaders({ mountedSlotsHeader: "slot:modal:/" });
    const handler = createHandler({ configHeaders: [] });

    const response = await handler(
      new Request("https://example.test/about.rsc?tab=latest", { headers }),
      null,
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("location")).toBeNull();
  });

  it("preserves middleware response headers on unclaimed out-of-basePath 404s", async () => {
    const middleware = vi.fn(
      () =>
        new Response(null, {
          headers: {
            "x-middleware-next": "1",
            "x-response-header": "preserved",
          },
        }),
    );
    const handler = createHandler({
      configHeaders: [],
      middlewareModule: { default: middleware },
    });

    const response = await handler(new Request("https://example.test/outside"), null);

    expect(response.status).toBe(404);
    expect(response.headers.get("x-response-header")).toBe("preserved");
  });

  it("preserves middleware response headers on route-tree prefetches", async () => {
    const middleware = vi.fn(
      () =>
        new Response(null, {
          headers: {
            "x-middleware-next": "1",
            "x-response-header": "preserved",
          },
        }),
    );
    const clearRequestContext = vi.fn();
    const handler = createHandler({
      clearRequestContext,
      configHeaders: [],
      middlewareModule: { default: middleware },
    });

    const headers = createRscRequestHeaders();
    headers.set(NEXT_ROUTER_PREFETCH_HEADER, "1");
    headers.set(NEXT_ROUTER_SEGMENT_PREFETCH_HEADER, "/_tree");
    const rscUrl = await createRscRequestUrl("/docs/about", headers);

    const response = await handler(
      new Request(`https://example.test${rscUrl}`, {
        headers,
      }),
      null,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-nextjs-postponed")).toBe("2");
    expect(response.headers.get("x-response-header")).toBe("preserved");
    expect(clearRequestContext).toHaveBeenCalledOnce();
  });

  it("returns route-tree prefetches for layout-only App Router matches", async () => {
    const layoutOnlyRoute = createPageRoute({
      layouts: [{ default() {} }],
      layoutTreePositions: [0],
      page: null,
      pattern: "/parallel-only",
      routeHandler: null,
      routeSegments: ["parallel-only"],
      slots: {
        sidebar: {
          name: "sidebar",
          default: { default() {} },
          page: null,
          routeSegments: null,
        },
      },
    });
    const dispatchMatchedPage = vi.fn(async () => new Response("page"));
    const handler = createHandler({
      configHeaders: [],
      dispatchMatchedPage,
      matchRoute: (pathname: string) =>
        pathname === "/parallel-only"
          ? {
              params: {},
              route: layoutOnlyRoute,
            }
          : null,
    });

    const headers = createRscRequestHeaders();
    headers.set(NEXT_ROUTER_PREFETCH_HEADER, "1");
    headers.set(NEXT_ROUTER_SEGMENT_PREFETCH_HEADER, "/_tree");
    const rscUrl = await createRscRequestUrl("/docs/parallel-only", headers);

    const response = await handler(
      new Request(`https://example.test${rscUrl}`, {
        headers,
      }),
      null,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-nextjs-postponed")).toBe("2");
    expect(await response.text()).toContain('"tree"');
    expect(dispatchMatchedPage).not.toHaveBeenCalled();
  });

  it("does not dispatch server actions directly outside basePath", async () => {
    const handleServerActionRequest = vi.fn(async () => new Response("action"));
    const handler = createHandler({ configHeaders: [], handleServerActionRequest });

    const response = await handler(
      new Request("https://example.test/about", {
        method: "POST",
        headers: { "next-action": "action-id", "content-type": "text/plain" },
      }),
      null,
    );

    expect(response.status).toBe(404);
    expect(handleServerActionRequest).not.toHaveBeenCalled();
  });

  it("passes out-of-basePath state to App middleware", async () => {
    let capturedMiddlewareRequest: NextRequest | null = null;
    const middleware = vi.fn((request: NextRequest) => {
      capturedMiddlewareRequest = request;
      return new Response(null, { headers: { "x-middleware-next": "1" } });
    });
    const handler = createHandler({ configHeaders: [], middlewareModule: { default: middleware } });

    await handler(new Request("https://example.test/outside"), null);

    expect(middleware).toHaveBeenCalledOnce();
    const middlewareRequest = capturedMiddlewareRequest as NextRequest | null;
    expect(middlewareRequest).not.toBeNull();
    expect(middlewareRequest!.nextUrl.basePath).toBe("");
    expect(middlewareRequest!.nextUrl.pathname).toBe("/outside");
  });

  it("dispatches Server Action redirect targets through the complete App pipeline", async () => {
    const seenPathnames: string[] = [];
    const middleware = vi.fn((request: NextRequest) => {
      const { pathname } = new URL(request.url);
      seenPathnames.push(pathname);
      return pathname === "/docs/protected"
        ? new Response("unauthorized", { status: 401 })
        : new Response(null, { headers: { "x-middleware-next": "1" } });
    });
    let dispatchRedirectTargetRequest: ((request: Request) => Promise<Response>) | undefined;
    const handler = createHandler({
      configHeaders: [],
      handleServerActionRequest: async (options) => {
        dispatchRedirectTargetRequest = options.dispatchRedirectTargetRequest;
        return new Response("action");
      },
      middlewareModule: { default: middleware },
    });

    const response = await handler(
      new Request("https://example.test/docs/about", {
        method: "POST",
        headers: { "next-action": "action-id", "content-type": "text/plain" },
      }),
      null,
    );

    expect(response.status).toBe(200);
    expect(seenPathnames).toEqual(["/docs/about"]);

    expect(dispatchRedirectTargetRequest).toBeDefined();
    const targetResponse = await dispatchRedirectTargetRequest!(
      new Request("https://example.test/docs/protected"),
    );
    expect(targetResponse.status).toBe(401);
    expect(await targetResponse.text()).toBe("unauthorized");
    expect(seenPathnames).toEqual(["/docs/about", "/docs/protected"]);
  });

  it.each([
    "url=%2Fimg.jpg&w=640junk&q=75",
    "url=%2Fimg.jpg&w=640&q=75&extra=1",
    "url=%2Fimg.jpg&w=640&w=640&q=75",
  ])("rejects malformed pure App Router dev image parameters: %s", async (query) => {
    const handler = createHandler();
    const response = await handler(
      new Request(`https://example.test/docs/_next/image?${query}`),
      null,
    );
    expect(response.status).toBe(400);
  });

  it("uses configured image widths and qualities in pure App Router dev", async () => {
    const handler = createHandler({
      imageConfig: { deviceSizes: [320], imageSizes: [16], qualities: [60] },
    });
    const allowed = await handler(
      new Request("https://example.test/docs/_next/image?url=%2Fimg.jpg&w=320&q=60"),
      null,
    );
    expect(allowed.status).toBe(302);
    expect(allowed.headers.get("location")).toBe("https://example.test/img.jpg");

    const defaultOnly = await handler(
      new Request("https://example.test/docs/_next/image?url=%2Fimg.jpg&w=640&q=75"),
      null,
    );
    expect(defaultOnly.status).toBe(400);
  });

  it("dispatches an RSC interception target with all dynamic descendant source params", async () => {
    const sourceRoute = createPageRoute({
      isDynamic: true,
      params: ["locale", "tab"],
      pattern: "/:locale/example/:tab",
      rootParamNames: ["locale"],
      routeSegments: ["[locale]", "example", "[tab]"],
    });
    const dispatchMatchedPage = vi.fn(async () => new Response("intercepted", { status: 200 }));
    const renderPagesFallback = vi.fn(async () => new Response("pages", { status: 200 }));
    const handler = createHandler({
      configHeaders: [],
      dispatchMatchedPage,
      matchInterceptRoute(pathname, sourcePathname) {
        if (pathname !== "/en/intercepted" || sourcePathname !== "/en/example/recent") {
          return null;
        }
        return { route: sourceRoute, params: { locale: "en", tab: "recent" } };
      },
      matchRoute: () => null,
      renderPagesFallback,
    });

    const headers = createRscRequestHeaders({ interceptionContext: "/en/example/recent" });
    const rscUrl = await createRscRequestUrl("/docs/en/intercepted", headers);
    const response = await handler(new Request(`https://example.test${rscUrl}`, { headers }), null);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("intercepted");
    expect(renderPagesFallback).not.toHaveBeenCalled();
    expect(dispatchMatchedPage).toHaveBeenCalledWith(
      expect.objectContaining({
        cleanPathname: "/en/intercepted",
        interceptionContext: "/en/example/recent",
        params: { locale: "en", tab: "recent" },
        route: sourceRoute,
      }),
    );
  });

  // Interception renders the source route's tree, so that route must clear the
  // same middleware boundary a direct request to it would. Next.js never renders
  // the source for this request (its rewrite targets the intercepting route and
  // the client keeps its own segments), so there is no upstream behaviour to
  // mirror here; the boundary exists because vinext renders the extra route.
  it("denies an interception source route that middleware rejects", async () => {
    const targetRoute = createPageRoute({ pattern: "/photos/1", routeSegments: ["photos", "1"] });
    const sourceRoute = createPageRoute({ pattern: "/feed/secret" });
    const dispatchMatchedPage = vi.fn(async () => new Response("secret"));
    const middlewarePaths: string[] = [];
    const handler = createHandler({
      configHeaders: [],
      dispatchMatchedPage,
      matchInterceptRoute: (_pathname, sourcePathname) =>
        sourcePathname === "/feed/secret" ? { route: sourceRoute, params: {} } : null,
      matchRoute: (pathname: string) => {
        if (pathname === "/photos/1") return { params: {}, route: targetRoute };
        if (pathname === "/feed/secret") return { params: {}, route: sourceRoute };
        return null;
      },
      async runMiddleware({ cleanPathname }) {
        middlewarePaths.push(cleanPathname);
        return cleanPathname.startsWith("/feed/secret")
          ? { kind: "response", response: new Response("denied", { status: 401 }) }
          : { kind: "continue", cleanPathname, rewritten: false, search: null };
      },
    });

    const headers = createRscRequestHeaders({ interceptionContext: "/feed/secret" });
    const rscUrl = await createRscRequestUrl("/docs/photos/1", headers);
    const response = await handler(new Request(`https://example.test${rscUrl}`, { headers }), null);

    expect(response.status).toBe(401);
    await expect(response.text()).resolves.toBe("denied");
    expect(middlewarePaths).toEqual(["/photos/1", "/feed/secret"]);
    expect(dispatchMatchedPage).not.toHaveBeenCalled();
  });

  // Next.js exercises interception routes and middleware together here:
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/interception-dynamic-segment-middleware/interception-dynamic-segment-middleware.test.ts
  // Vinext's additional source-authorization pass must preserve the same
  // normalized pathname identity used by ordinary middleware matching.
  it("normalizes encoded interception sources before middleware matching", async () => {
    const targetRoute = createPageRoute({ pattern: "/photos/1", routeSegments: ["photos", "1"] });
    const sourceRoute = createPageRoute({ pattern: "/feed/secret" });
    const dispatchMatchedPage = vi.fn(async () => new Response("secret"));
    const middlewarePaths: string[] = [];
    const handler = createHandler({
      configHeaders: [],
      dispatchMatchedPage,
      matchInterceptRoute: (_pathname, sourcePathname) =>
        sourcePathname === "/%66eed/secret" ? { route: sourceRoute, params: {} } : null,
      matchRoute: (pathname: string) => {
        if (pathname === "/photos/1") return { params: {}, route: targetRoute };
        if (pathname === "/feed/secret") return { params: {}, route: sourceRoute };
        return null;
      },
      middlewareModule: {
        config: { matcher: "/feed/:path*" },
        default(request: NextRequest) {
          middlewarePaths.push(request.nextUrl.pathname);
          return new Response("denied", { status: 401 });
        },
      },
    });

    const headers = createRscRequestHeaders({ interceptionContext: "/%66eed/secret" });
    const rscUrl = await createRscRequestUrl("/docs/photos/1", headers);
    const response = await handler(new Request(`https://example.test${rscUrl}`, { headers }), null);

    expect(response.status).toBe(401);
    expect(middlewarePaths).toEqual(["/feed/secret"]);
    expect(dispatchMatchedPage).not.toHaveBeenCalled();
  });

  it.each([
    "/feed/..",
    "/feed/%2e%2e",
    "/feed/./secret",
    "/feed//secret",
    "/feed/secret/../../../x",
    "/feed/..\\secret",
    "/feed\\..\\secret",
    "/feed\\secret",
    "/feed/%09../secret",
    "/feed/%0a../secret",
    "/feed/%0d../secret",
    "/feed/%252e%252e/secret",
  ])("rejects non-canonical interception source %s before route matching", async (source) => {
    const targetRoute = createPageRoute({ pattern: "/photos/1", routeSegments: ["photos", "1"] });
    const sourceRoute = createPageRoute({
      isDynamic: true,
      params: ["path"],
      pattern: "/feed/:path*",
      routeSegments: ["feed", "[[...path]]"],
    });
    const matcher = createAppRscRouteMatcher([
      {
        params: ["path"],
        pattern: "/feed/:path*",
        patternParts: ["feed", ":path*"],
        slots: {
          modal: {
            intercepts: [
              {
                sourceMatchPattern: "/feed",
                targetPattern: "/photos/:id",
                interceptLayouts: [],
                page: { default() {} },
                params: ["id"],
              },
            ],
          },
        },
      },
    ]);
    const matchInterceptRoute = vi.fn((pathname: string, sourcePathname: string) => {
      const intercept = matcher.findIntercept(pathname, sourcePathname);
      return intercept ? { route: sourceRoute, params: intercept.sourceMatchedParams } : null;
    });
    const runMiddleware = vi.fn(async ({ cleanPathname }: { cleanPathname: string }) => ({
      kind: "continue" as const,
      cleanPathname,
      rewritten: false,
      search: null,
    }));
    const dispatchMatchedPage = vi.fn(async () => new Response("secret"));
    const handler = createHandler({
      configHeaders: [
        {
          source: "/photos/:path*",
          headers: [{ key: "Cache-Control", value: "public, max-age=3600" }],
        },
      ],
      dispatchMatchedPage,
      matchInterceptRoute,
      matchRoute: (pathname: string) =>
        pathname === "/photos/1" ? { params: {}, route: targetRoute } : null,
      runMiddleware,
    });

    const headers = createRscRequestHeaders({ interceptionContext: source });
    const rscUrl = await createRscRequestUrl("/docs/photos/1", headers);
    const response = await handler(new Request(`https://example.test${rscUrl}`, { headers }), null);

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe(
      "private, no-cache, no-store, max-age=0, must-revalidate",
    );
    expect(runMiddleware).not.toHaveBeenCalled();
    expect(matchInterceptRoute).not.toHaveBeenCalled();
    expect(dispatchMatchedPage).not.toHaveBeenCalled();
  });

  it("rejects non-canonical interception sources before config redirects", async () => {
    const handler = createHandler({
      configHeaders: [],
      configRedirects: [{ source: "/photos/:id", destination: "/viewer/:id", permanent: false }],
    });
    const headers = createRscRequestHeaders({ interceptionContext: "/feed/.." });
    const rscUrl = await createRscRequestUrl("/docs/photos/1", headers);

    const response = await handler(new Request(`https://example.test${rscUrl}`, { headers }), null);

    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("cache-control")).toBe(
      "private, no-cache, no-store, max-age=0, must-revalidate",
    );
  });

  it("rejects interception sources containing a raw query delimiter", async () => {
    const targetRoute = createPageRoute({ pattern: "/photos/1", routeSegments: ["photos", "1"] });
    const matchInterceptRoute = vi.fn(() => ({ route: createPageRoute(), params: {} }));
    const dispatchMatchedPage = vi.fn(async () => new Response("secret"));
    const handler = createHandler({
      configHeaders: [],
      dispatchMatchedPage,
      matchInterceptRoute,
      matchRoute: (pathname: string) =>
        pathname === "/photos/1" ? { params: {}, route: targetRoute } : null,
    });

    const headers = createRscRequestHeaders({ interceptionContext: "/admin?bypass" });
    const rscUrl = await createRscRequestUrl("/docs/photos/1", headers);
    const response = await handler(new Request(`https://example.test${rscUrl}`, { headers }), null);

    expect(response.status).toBe(400);
    expect(matchInterceptRoute).not.toHaveBeenCalled();
    expect(dispatchMatchedPage).not.toHaveBeenCalled();
  });

  it("rejects malformed encoded interception sources before middleware", async () => {
    const targetRoute = createPageRoute({ pattern: "/photos/1", routeSegments: ["photos", "1"] });
    const sourceRoute = createPageRoute({ pattern: "/feed/secret" });
    const dispatchMatchedPage = vi.fn(async () => new Response("secret"));
    const middlewarePaths: string[] = [];
    const handler = createHandler({
      configHeaders: [],
      dispatchMatchedPage,
      matchInterceptRoute: (_pathname, sourcePathname) =>
        sourcePathname === "/feed/%" ? { route: sourceRoute, params: {} } : null,
      matchRoute: (pathname: string) =>
        pathname === "/photos/1" ? { params: {}, route: targetRoute } : null,
      middlewareModule: {
        default(request: NextRequest) {
          middlewarePaths.push(request.nextUrl.pathname);
          return new Response(null, { headers: { "x-middleware-next": "1" } });
        },
      },
    });

    const headers = createRscRequestHeaders({ interceptionContext: "/feed/%" });
    const rscUrl = await createRscRequestUrl("/docs/photos/1", headers);
    const response = await handler(new Request(`https://example.test${rscUrl}`, { headers }), null);

    expect(response.status).toBe(400);
    expect(middlewarePaths).toEqual([]);
    expect(dispatchMatchedPage).not.toHaveBeenCalled();
  });

  it("passes the raw interception source to the one-decode route matcher", async () => {
    const targetRoute = createPageRoute({ pattern: "/photos/1", routeSegments: ["photos", "1"] });
    const matchInterceptRoute = vi.fn(() => null);
    const dispatchMatchedPage = vi.fn(async () => new Response("page"));
    const handler = createHandler({
      configHeaders: [],
      dispatchMatchedPage,
      matchInterceptRoute,
      matchRoute: (pathname: string) =>
        pathname === "/photos/1" ? { params: {}, route: targetRoute } : null,
    });

    const headers = createRscRequestHeaders({ interceptionContext: "/%2561dmin" });
    const rscUrl = await createRscRequestUrl("/docs/photos/1", headers);
    const response = await handler(new Request(`https://example.test${rscUrl}`, { headers }), null);

    expect(response.status).toBe(200);
    expect(matchInterceptRoute).toHaveBeenCalledWith("/photos/1", "/%2561dmin", null);
    expect(dispatchMatchedPage).toHaveBeenCalledWith(
      expect.objectContaining({ interceptionContext: "/%2561dmin" }),
    );
  });

  it("bypasses shared caches for an unverified canonical interception context", async () => {
    const targetRoute = createPageRoute({ pattern: "/photos/1", routeSegments: ["photos", "1"] });
    const matchInterceptRoute = vi.fn(() => null);
    const dispatchMatchedPage = vi.fn(
      async () =>
        new Response("page", {
          headers: { "Cache-Control": "public, max-age=3600" },
        }),
    );
    const handler = createHandler({
      configHeaders: [],
      dispatchMatchedPage,
      matchInterceptRoute,
      matchRoute: (pathname: string) =>
        pathname === "/photos/1" ? { params: {}, route: targetRoute } : null,
    });
    const headers = createRscRequestHeaders({ interceptionContext: "/attacker-selected" });
    const rscUrl = await createRscRequestUrl("/docs/photos/1", headers);

    const response = await handler(new Request(`https://example.test${rscUrl}`, { headers }), null);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe(
      "private, no-cache, no-store, max-age=0, must-revalidate",
    );
    expect(dispatchMatchedPage).toHaveBeenCalledWith(
      expect.objectContaining({ bypassInterceptionContextCache: true }),
    );
  });

  it("marks early redirects for unverified canonical interception contexts no-store", async () => {
    const handler = createHandler({
      configHeaders: [
        {
          source: "/photos/:path*",
          headers: [{ key: "Cache-Control", value: "public, max-age=3600" }],
        },
      ],
      configRedirects: [{ source: "/photos/:id", destination: "/viewer/:id", permanent: false }],
    });
    const headers = createRscRequestHeaders({ interceptionContext: "/attacker-selected" });
    const rscUrl = await createRscRequestUrl("/docs/photos/1", headers);

    const response = await handler(new Request(`https://example.test${rscUrl}`, { headers }), null);

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toContain("/docs/viewer/1");
    expect(response.headers.get("cache-control")).toBe(
      "private, no-cache, no-store, max-age=0, must-revalidate",
    );
  });

  it("bypasses shared caches when interception-context normalization drops a raw value", async () => {
    const targetRoute = createPageRoute({ pattern: "/photos/1", routeSegments: ["photos", "1"] });
    const dispatchMatchedPage = vi.fn(
      async () =>
        new Response("page", {
          headers: { "Cache-Control": "public, max-age=3600" },
        }),
    );
    const handler = createHandler({
      configHeaders: [],
      dispatchMatchedPage,
      matchRoute: (pathname: string) =>
        pathname === "/photos/1" ? { params: {}, route: targetRoute } : null,
    });
    const headers = createRscRequestHeaders({ interceptionContext: "not-a-path" });
    const rscUrl = await createRscRequestUrl("/docs/photos/1", headers);

    const response = await handler(new Request(`https://example.test${rscUrl}`, { headers }), null);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe(
      "private, no-cache, no-store, max-age=0, must-revalidate",
    );
    expect(dispatchMatchedPage).toHaveBeenCalledWith(
      expect.objectContaining({
        bypassInterceptionContextCache: true,
        interceptionContext: null,
      }),
    );
  });

  it("keeps verified canonical interception contexts cacheable", async () => {
    const targetRoute = createPageRoute({ pattern: "/photos/1", routeSegments: ["photos", "1"] });
    const sourceRoute = createPageRoute({ pattern: "/feed", routeSegments: ["feed"] });
    const dispatchMatchedPage = vi.fn(
      async () =>
        new Response("page", {
          headers: { "Cache-Control": "public, max-age=3600" },
        }),
    );
    const handler = createHandler({
      configHeaders: [],
      dispatchMatchedPage,
      matchInterceptRoute: (_pathname, sourcePathname) =>
        sourcePathname === "/feed" ? { route: sourceRoute, params: {} } : null,
      matchRoute: (pathname: string) => {
        if (pathname === "/photos/1") return { params: {}, route: targetRoute };
        if (pathname === "/feed") return { params: {}, route: sourceRoute };
        return null;
      },
    });
    const headers = createRscRequestHeaders({ interceptionContext: "/feed" });
    const rscUrl = await createRscRequestUrl("/docs/photos/1", headers);

    const response = await handler(new Request(`https://example.test${rscUrl}`, { headers }), null);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(dispatchMatchedPage).toHaveBeenCalledWith(
      expect.objectContaining({ bypassInterceptionContextCache: false }),
    );
  });

  it("keeps nonexistent interception descendants out of shared caches", async () => {
    const targetRoute = createPageRoute({ pattern: "/photos/1", routeSegments: ["photos", "1"] });
    const sourceRoute = createPageRoute({ pattern: "/feed", routeSegments: ["feed"] });
    const matcher = createAppRscRouteMatcher([
      {
        params: [],
        pattern: "/feed",
        patternParts: ["feed"],
        slots: {
          modal: {
            intercepts: [
              {
                sourceMatchPattern: "/feed",
                targetPattern: "/photos/:id",
                interceptLayouts: [],
                page: { default() {} },
                params: ["id"],
              },
            ],
          },
        },
      },
    ]);
    const dispatchMatchedPage = vi.fn(
      async () =>
        new Response("page", {
          headers: { "Cache-Control": "public, max-age=3600" },
        }),
    );
    const handler = createHandler({
      configHeaders: [],
      dispatchMatchedPage,
      matchInterceptRoute(pathname, sourcePathname) {
        const intercept = matcher.findIntercept(pathname, sourcePathname);
        return intercept
          ? {
              interceptionSourceIsConcrete: intercept.sourceRouteIsConcrete,
              route: sourceRoute,
              params: intercept.sourceMatchedParams,
            }
          : null;
      },
      matchRoute(pathname) {
        if (pathname === "/photos/1") return { params: {}, route: targetRoute };
        if (pathname === "/feed") return { params: {}, route: sourceRoute };
        return null;
      },
    });
    const headers = createRscRequestHeaders({ interceptionContext: "/feed/attacker-selected" });
    const rscUrl = await createRscRequestUrl("/docs/photos/1", headers);

    const response = await handler(new Request(`https://example.test${rscUrl}`, { headers }), null);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe(
      "private, no-cache, no-store, max-age=0, must-revalidate",
    );
    expect(dispatchMatchedPage).toHaveBeenCalledWith(
      expect.objectContaining({
        bypassInterceptionContextCache: true,
        interceptionContext: "/feed/attacker-selected",
      }),
    );
  });

  it("rejects unverified interception ids before page dispatch or shared caching", async () => {
    const targetRoute = createPageRoute({ pattern: "/photos/1", routeSegments: ["photos", "1"] });
    const matchInterceptRoute = vi.fn(() => null);
    const dispatchMatchedPage = vi.fn(async () => new Response("page"));
    const handler = createHandler({
      configHeaders: [
        {
          source: "/photos/:path*",
          headers: [
            { key: "Cache-Control", value: "public, max-age=3600" },
            { key: "X-Security-Test", value: "preserved" },
          ],
        },
      ],
      dispatchMatchedPage,
      hasInterceptionId: () => false,
      matchInterceptRoute,
      matchRoute: (pathname: string) =>
        pathname === "/photos/1" ? { params: {}, route: targetRoute } : null,
    });

    const headers = createRscRequestHeaders({
      interceptionContext: "/feed",
      interceptionId: "interception:attacker-selected",
    });
    const rscUrl = await createRscRequestUrl("/docs/photos/1", headers);
    const response = await handler(new Request(`https://example.test${rscUrl}`, { headers }), null);

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe(
      "private, no-cache, no-store, max-age=0, must-revalidate",
    );
    expect(response.headers.get("x-security-test")).toBe("preserved");
    expect(matchInterceptRoute).not.toHaveBeenCalled();
    expect(dispatchMatchedPage).not.toHaveBeenCalled();
  });

  it("canonicalizes selector hashes before permanent config redirects", async () => {
    const interceptionId = "interception:slot:modal:/feed:/feed->/photos/:id";
    const handler = createHandler({
      configHeaders: [],
      configRedirects: [
        {
          source: "/photos/:id",
          destination: "/viewer/:id",
          permanent: true,
        },
      ],
      hasInterceptionId: (requestedId) => requestedId === interceptionId,
    });
    const headers = createRscRequestHeaders({
      interceptionContext: "/feed",
      interceptionId,
    });
    const currentHash = await computeRscCacheBustingSearchParam(headers);
    // Hash produced before X-Vinext-Interception-Id became a positional input.
    const previousHash = "xut9sI3k0WVES6tW";

    const response = await handler(
      new Request(`https://example.test/docs/photos/1?_rsc=${previousHash}`, { headers }),
      null,
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(`/docs/photos/1?_rsc=${currentHash}`);
  });

  it("rejects unknown interception ids before middleware can respond", async () => {
    const dispatchMatchedPage = vi.fn(async () => new Response("page"));
    const matchInterceptRoute = vi.fn(() => null);
    const handler = createHandler({
      configHeaders: [
        {
          source: "/photos/:path*",
          headers: [{ key: "Cache-Control", value: "public, max-age=3600" }],
        },
      ],
      dispatchMatchedPage,
      hasInterceptionId: () => false,
      matchInterceptRoute,
      async runMiddleware() {
        return {
          kind: "response",
          response: new Response("middleware", {
            headers: { "Cache-Control": "public, max-age=3600" },
          }),
        };
      },
    });

    const headers = createRscRequestHeaders({
      interceptionContext: "/feed",
      interceptionId: "interception:attacker-selected",
    });
    const rscUrl = await createRscRequestUrl("/docs/photos/1", headers);
    const response = await handler(new Request(`https://example.test${rscUrl}`, { headers }), null);

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe(
      "private, no-cache, no-store, max-age=0, must-revalidate",
    );
    expect(matchInterceptRoute).not.toHaveBeenCalled();
    expect(dispatchMatchedPage).not.toHaveBeenCalled();
  });

  it("does not cache middleware responses when graph ownership is not target-specific", async () => {
    const interceptionId = "interception:slot:modal:/feed:/feed->/photos/:id";
    const dispatchMatchedPage = vi.fn(async () => new Response("page"));
    const handler = createHandler({
      configHeaders: [],
      dispatchMatchedPage,
      hasInterceptionId: (requestedId) => requestedId === interceptionId,
      async runMiddleware() {
        return {
          kind: "response",
          response: new Response("middleware", {
            status: 400,
            headers: { "Cache-Control": "public, max-age=3600" },
          }),
        };
      },
    });

    const headers = createRscRequestHeaders({
      interceptionContext: "/feed",
      interceptionId,
    });
    const rscUrl = await createRscRequestUrl("/docs/photos/1", headers);
    const response = await handler(new Request(`https://example.test${rscUrl}`, { headers }), null);

    expect(response.status).toBe(400);
    expect(await response.text()).toBe("middleware");
    expect(response.headers.get("cache-control")).toBe(
      "private, no-cache, no-store, max-age=0, must-revalidate",
    );
    expect(dispatchMatchedPage).not.toHaveBeenCalled();
  });

  it("preserves cacheable middleware responses after exact interception proof", async () => {
    const interceptionId = "interception:slot:modal:/feed:/feed->/photos/:id";
    const sourceRoute = createPageRoute({ pattern: "/feed", routeSegments: ["feed"] });
    const dispatchMatchedPage = vi.fn(async () => new Response("page"));
    const handler = createHandler({
      configHeaders: [],
      dispatchMatchedPage,
      hasInterceptionId: (requestedId) => requestedId === interceptionId,
      matchInterceptRoute: (_pathname, sourcePathname, requestedId) =>
        sourcePathname === "/feed" && requestedId === interceptionId
          ? { interceptionSourceIsConcrete: true, route: sourceRoute, params: {} }
          : null,
      async runMiddleware() {
        return {
          kind: "response",
          response: new Response("middleware", {
            status: 400,
            headers: { "Cache-Control": "public, max-age=3600" },
          }),
        };
      },
    });

    const headers = createRscRequestHeaders({
      interceptionContext: "/feed",
      interceptionId,
    });
    const rscUrl = await createRscRequestUrl("/docs/photos/1", headers);
    const response = await handler(new Request(`https://example.test${rscUrl}`, { headers }), null);

    expect(response.status).toBe(400);
    expect(await response.text()).toBe("middleware");
    expect(response.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(dispatchMatchedPage).not.toHaveBeenCalled();
  });

  it("forces malformed interception contexts paired with an id to no-store", async () => {
    const dispatchMatchedPage = vi.fn(async () => new Response("page"));
    const handler = createHandler({
      configHeaders: [],
      dispatchMatchedPage,
      hasInterceptionId: () => true,
      matchRoute: (pathname: string) =>
        pathname === "/photos/1"
          ? {
              params: {},
              route: createPageRoute({
                pattern: "/photos/1",
                routeSegments: ["photos", "1"],
              }),
            }
          : null,
    });
    const headers = createRscRequestHeaders({
      interceptionContext: "/feed/%GG",
      interceptionId: "interception:slot:modal:/feed:/feed->/photos/:id",
    });
    const rscUrl = await createRscRequestUrl("/docs/photos/1", headers);
    const response = await handler(new Request(`https://example.test${rscUrl}`, { headers }), null);

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(dispatchMatchedPage).not.toHaveBeenCalled();
  });

  it("rejects interception ids without a source context", async () => {
    const dispatchMatchedPage = vi.fn(async () => new Response("page"));
    const matchInterceptRoute = vi.fn(() => null);
    const handler = createHandler({
      dispatchMatchedPage,
      hasInterceptionId: () => true,
      matchInterceptRoute,
    });
    const headers = createRscRequestHeaders({
      interceptionId: "interception:slot:modal:/feed:/feed->/photos/:id",
    });
    const rscUrl = await createRscRequestUrl("/docs/about", headers);
    const response = await handler(new Request(`https://example.test${rscUrl}`, { headers }), null);

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(matchInterceptRoute).not.toHaveBeenCalled();
    expect(dispatchMatchedPage).not.toHaveBeenCalled();
  });

  it.each(["POST", "PUT"])(
    "rejects interception ids on %s requests before action or route dispatch",
    async (method) => {
      const interceptionId = "interception:slot:modal:/feed:/feed->/photos/:id";
      const dispatchMatchedPage = vi.fn(async () => new Response("page"));
      const dispatchMatchedRouteHandler = vi.fn(async () => new Response("route"));
      const handleServerActionRequest = vi.fn(async () => new Response("action"));
      const handler = createHandler({
        configHeaders: [],
        dispatchMatchedPage,
        dispatchMatchedRouteHandler,
        handleServerActionRequest,
        hasInterceptionId: (requestedId) => requestedId === interceptionId,
      });
      const headers = createRscRequestHeaders({
        interceptionContext: "/feed",
        interceptionId,
      });
      const rscUrl = await createRscRequestUrl("/docs/photos/1", headers);

      const response = await handler(
        new Request(`https://example.test${rscUrl}`, { headers, method }),
        null,
      );

      expect(response.status).toBe(400);
      expect(response.headers.get("cache-control")).toBe(
        "private, no-cache, no-store, max-age=0, must-revalidate",
      );
      expect(handleServerActionRequest).not.toHaveBeenCalled();
      expect(dispatchMatchedRouteHandler).not.toHaveBeenCalled();
      expect(dispatchMatchedPage).not.toHaveBeenCalled();
    },
  );

  it("allows an exact graph-owned interception id", async () => {
    const sourceRoute = createPageRoute({ pattern: "/feed", routeSegments: ["feed"] });
    const interceptionId = "interception:slot:modal:/feed:/feed->/photos/:id";
    const dispatchMatchedPage = vi.fn(async () => new Response("intercepted"));
    const matchInterceptRoute = vi.fn(
      (_pathname: string, _sourcePathname: string, requestedId?: string | null) =>
        requestedId === interceptionId
          ? { interceptionSourceIsConcrete: true, route: sourceRoute, params: {} }
          : null,
    );
    const handler = createHandler({
      configHeaders: [
        {
          source: "/photos/:path*",
          headers: [{ key: "Cache-Control", value: "public, max-age=3600" }],
        },
      ],
      dispatchMatchedPage,
      hasInterceptionId: (requestedId) => requestedId === interceptionId,
      matchInterceptRoute,
      matchRoute: () => null,
    });
    const headers = createRscRequestHeaders({
      interceptionContext: "/feed",
      interceptionId,
    });
    const rscUrl = await createRscRequestUrl("/docs/photos/1", headers);
    const response = await handler(new Request(`https://example.test${rscUrl}`, { headers }), null);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("intercepted");
    expect(response.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(dispatchMatchedPage).toHaveBeenCalledWith(
      expect.objectContaining({ interceptionContext: "/feed", interceptionId }),
    );
  });

  it("preserves one-decode dynamic source params in concrete interception proof", async () => {
    const targetRoute = createPageRoute({ pattern: "/photos/1", routeSegments: ["photos", "1"] });
    const sourceRoute = createPageRoute({
      isDynamic: true,
      params: ["slug"],
      pattern: "/feed/:slug",
      routeSegments: ["feed", "[slug]"],
    });
    const matcher = createAppRscRouteMatcher([
      {
        params: ["slug"],
        pattern: "/feed/:slug",
        patternParts: ["feed", ":slug"],
        slots: {
          modal: {
            id: "slot:modal:/feed/:slug",
            intercepts: [
              {
                sourceMatchPattern: "/feed/:slug",
                targetPattern: "/photos/:id",
                interceptLayouts: [],
                page: { default() {} },
                params: ["id"],
              },
            ],
          },
        },
      },
    ]);
    const sourceContext = "/feed/%2561";
    const initialIntercept = matcher.findIntercept("/photos/1", sourceContext);
    expect(initialIntercept).toMatchObject({
      sourceMatchedParams: { slug: "%61" },
      sourceRouteIsConcrete: true,
    });
    const interceptionId = initialIntercept!.interceptionId;
    expect(interceptionId).not.toBeNull();
    const dispatchMatchedPage = vi.fn(
      async () =>
        new Response("page", {
          headers: { "Cache-Control": "public, max-age=3600" },
        }),
    );
    const handler = createHandler({
      configHeaders: [],
      dispatchMatchedPage,
      hasInterceptionId: (requestedId) => matcher.hasInterceptionId(requestedId),
      matchInterceptRoute(pathname, sourcePathname, requestedId) {
        const intercept = matcher.findIntercept(pathname, sourcePathname, requestedId);
        return intercept
          ? {
              interceptionSourceIsConcrete: intercept.sourceRouteIsConcrete,
              route: sourceRoute,
              params: intercept.sourceMatchedParams,
            }
          : null;
      },
      matchRoute: (pathname) =>
        pathname === "/photos/1" ? { params: {}, route: targetRoute } : null,
    });
    const headers = createRscRequestHeaders({
      interceptionContext: sourceContext,
      interceptionId,
    });
    const rscUrl = await createRscRequestUrl("/docs/photos/1", headers);

    const response = await handler(new Request(`https://example.test${rscUrl}`, { headers }), null);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(dispatchMatchedPage).toHaveBeenCalledWith(
      expect.objectContaining({
        bypassInterceptionContextCache: false,
        interceptionId,
      }),
    );
  });

  it("marks malformed interception ids non-cacheable", async () => {
    const dispatchMatchedPage = vi.fn(async () => new Response("page"));
    const handler = createHandler({ dispatchMatchedPage });
    const headers = createRscRequestHeaders();
    headers.set(VINEXT_INTERCEPTION_ID_HEADER, "attacker-selected");
    const response = await handler(
      new Request("https://example.test/docs/about?_rsc=invalid", { headers }),
      null,
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(dispatchMatchedPage).not.toHaveBeenCalled();
  });

  it("passes the raw interception source to Server Action dispatch", async () => {
    const targetRoute = createPageRoute({ pattern: "/photos/1", routeSegments: ["photos", "1"] });
    const handleServerActionRequest = vi.fn(async () => new Response("action"));
    const handler = createHandler({
      configHeaders: [],
      handleServerActionRequest,
      matchInterceptRoute: () => null,
      matchRoute: (pathname: string) =>
        pathname === "/photos/1" ? { params: {}, route: targetRoute } : null,
    });

    const headers = createRscRequestHeaders({ interceptionContext: "/%2561dmin" });
    headers.set("content-type", "text/plain");
    headers.set("next-action", "interception-action");
    const response = await handler(
      new Request("https://example.test/docs/photos/1", {
        body: "action-body",
        headers,
        method: "POST",
      }),
      null,
    );

    expect(response.status).toBe(200);
    expect(handleServerActionRequest).toHaveBeenCalledWith(
      expect.objectContaining({ interceptionContext: "/%2561dmin" }),
    );
  });

  it("authorizes the interception source with the target's resolved query", async () => {
    const targetRoute = createPageRoute({ pattern: "/photos/1", routeSegments: ["photos", "1"] });
    const sourceRoute = createPageRoute({ pattern: "/feed" });
    const middlewareRequests: Array<[string, string]> = [];
    const dispatchMatchedPage = vi.fn(
      async ({ searchParams }: { searchParams: URLSearchParams }) =>
        new Response(searchParams.get("view") ?? "missing"),
    );
    const handler = createHandler({
      configHeaders: [],
      dispatchMatchedPage,
      matchInterceptRoute: (_pathname, sourcePathname) =>
        sourcePathname === "/feed" ? { route: sourceRoute, params: {} } : null,
      matchRoute: (pathname: string) =>
        pathname === "/photos/1" ? { params: {}, route: targetRoute } : null,
      async runMiddleware({ cleanPathname, request }) {
        middlewareRequests.push([cleanPathname, new URL(request.url).search]);
        return {
          kind: "continue",
          cleanPathname,
          rewritten: cleanPathname === "/photos/1",
          search: cleanPathname === "/photos/1" ? "?view=private" : null,
        };
      },
    });

    const headers = createRscRequestHeaders({ interceptionContext: "/feed" });
    const rscUrl = await createRscRequestUrl("/docs/photos/1?view=public", headers);
    const response = await handler(new Request(`https://example.test${rscUrl}`, { headers }), null);

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("private");
    expect(middlewareRequests).toEqual([
      ["/photos/1", "?view=public"],
      ["/feed", "?view=private"],
    ]);
  });

  it("authorizes an intercepted Server Action source with the resolved query", async () => {
    const targetRoute = createPageRoute({ pattern: "/photos/1", routeSegments: ["photos", "1"] });
    const sourceRoute = createPageRoute({ pattern: "/feed" });
    const middlewareRequests: Array<[string, string]> = [];
    const handleServerActionRequest = vi.fn(
      async ({ searchParams }: { searchParams: URLSearchParams }) =>
        new Response(searchParams.get("view") ?? "missing"),
    );
    const handler = createHandler({
      configHeaders: [],
      handleServerActionRequest,
      matchInterceptRoute: (_pathname, sourcePathname) =>
        sourcePathname === "/feed" ? { route: sourceRoute, params: {} } : null,
      matchRoute: (pathname: string) =>
        pathname === "/photos/1" ? { params: {}, route: targetRoute } : null,
      async runMiddleware({ cleanPathname, request }) {
        middlewareRequests.push([cleanPathname, new URL(request.url).search]);
        return {
          kind: "continue",
          cleanPathname,
          rewritten: cleanPathname === "/photos/1",
          search: cleanPathname === "/photos/1" ? "?view=private" : null,
        };
      },
    });

    const headers = createRscRequestHeaders({ interceptionContext: "/feed" });
    headers.set("content-type", "text/plain");
    headers.set("next-action", "interception-action");
    const response = await handler(
      new Request("https://example.test/docs/photos/1?view=public", {
        body: "action-body",
        headers,
        method: "POST",
      }),
      null,
    );

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("private");
    expect(middlewareRequests).toEqual([
      ["/photos/1", "?view=public"],
      ["/feed", "?view=private"],
    ]);
  });

  it("does not replay a forwarded target middleware result for the interception source", async () => {
    const targetRoute = createPageRoute({ pattern: "/photos/1", routeSegments: ["photos", "1"] });
    const sourceRoute = createPageRoute({ pattern: "/feed/secret" });
    const dispatchMatchedPage = vi.fn(async () => new Response("secret"));
    const middlewarePaths: string[] = [];
    const handler = createHandler({
      configHeaders: [],
      dispatchMatchedPage,
      matchInterceptRoute: (_pathname, sourcePathname) =>
        sourcePathname === "/feed/secret" ? { route: sourceRoute, params: {} } : null,
      matchRoute: (pathname: string) =>
        pathname === "/photos/1" ? { params: {}, route: targetRoute } : null,
      middlewareModule: {
        default(request: NextRequest) {
          middlewarePaths.push(request.nextUrl.pathname);
          return new Response("denied", { status: 401 });
        },
      },
    });

    const headers = createRscRequestHeaders({ interceptionContext: "/feed/secret" });
    headers.set(VINEXT_MW_CTX_HEADER, JSON.stringify({ h: [["x-mw-target", "1"]] }));
    const rscUrl = await createRscRequestUrl("/docs/photos/1", headers);
    const response = await handler(new Request(`https://example.test${rscUrl}`, { headers }), null);

    expect(response.status).toBe(401);
    expect(middlewarePaths).toEqual(["/feed/secret"]);
    expect(dispatchMatchedPage).not.toHaveBeenCalled();
  });

  // Next.js implements interception as a generated rewrite whose destination is
  // the intercepting route, so middleware rewriting the source away never
  // renders the source tree. Vinext renders that tree directly and must fail
  // closed when its authorization pass changes the source route.
  // Ref: Next.js test/e2e/app-dir/interception-middleware-rewrite/
  // https://github.com/vercel/next.js/tree/canary/test/e2e/app-dir/interception-middleware-rewrite
  it("does not render an interception source that middleware rewrites away", async () => {
    const targetRoute = createPageRoute({ pattern: "/photos/1", routeSegments: ["photos", "1"] });
    const sourceRoute = createPageRoute({ pattern: "/feed/secret" });
    const dispatchMatchedPage = vi.fn(async () => new Response("secret"));
    const handler = createHandler({
      configHeaders: [],
      dispatchMatchedPage,
      matchInterceptRoute: (_pathname, sourcePathname) =>
        sourcePathname === "/feed/secret" ? { route: sourceRoute, params: {} } : null,
      matchRoute: (pathname: string) =>
        pathname === "/photos/1" ? { params: {}, route: targetRoute } : null,
      middlewareModule: {
        default(request: NextRequest) {
          return request.nextUrl.pathname === "/feed/secret"
            ? new Response(null, {
                headers: {
                  "x-middleware-rewrite": "https://example.test/docs/login",
                },
              })
            : new Response(null, { headers: { "x-middleware-next": "1" } });
        },
      },
    });

    const headers = createRscRequestHeaders({ interceptionContext: "/feed/secret" });
    const rscUrl = await createRscRequestUrl("/docs/photos/1", headers);
    const response = await handler(new Request(`https://example.test${rscUrl}`, { headers }), null);

    expect(response.status).toBe(404);
    expect(dispatchMatchedPage).not.toHaveBeenCalled();
  });

  it("forwards RSC cache-busting params when source middleware rewrites externally", async () => {
    // Combines the Next.js interception + middleware and middleware RSC
    // external-rewrite contracts for vinext's additional source authorization pass:
    // https://github.com/vercel/next.js/tree/canary/test/e2e/app-dir/interception-middleware-rewrite
    // https://github.com/vercel/next.js/tree/canary/test/e2e/app-dir/middleware-rsc-external-rewrite
    const receivedUrls: string[] = [];
    const server = createServer((req, res) => {
      receivedUrls.push(req.url ?? "");
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("upstream");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    const upstreamUrl = `http://127.0.0.1:${address.port}/proxy`;

    try {
      const targetRoute = createPageRoute({ pattern: "/photos/1", routeSegments: ["photos", "1"] });
      const sourceRoute = createPageRoute({ pattern: "/feed" });
      const headers = createRscRequestHeaders({ interceptionContext: "/feed" });
      const rscUrl = await createRscRequestUrl("/docs/photos/1?tab=latest", headers);
      const handler = createHandler({
        configHeaders: [],
        matchInterceptRoute: (_pathname, sourcePathname) =>
          sourcePathname === "/feed" ? { route: sourceRoute, params: {} } : null,
        matchRoute: (pathname: string) =>
          pathname === "/photos/1" ? { params: {}, route: targetRoute } : null,
        middlewareModule: {
          default(request: NextRequest) {
            return request.nextUrl.pathname === "/feed"
              ? new Response(null, { headers: { "x-middleware-rewrite": upstreamUrl } })
              : new Response(null, { headers: { "x-middleware-next": "1" } });
          },
        },
      });

      const response = await handler(
        new Request(`https://example.test${rscUrl}`, { headers }),
        null,
      );

      expect(response.status).toBe(200);
      expect(receivedUrls).toHaveLength(1);
      const forwardedUrl = new URL(`http://vinext.local${receivedUrls[0]}`);
      expect(forwardedUrl.searchParams.has(VINEXT_RSC_CACHE_BUSTING_SEARCH_PARAM)).toBe(true);
      expect(forwardedUrl.searchParams.get("tab")).toBe("latest");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("does not promote an interception-only source that middleware rewrites away", async () => {
    const sourceRoute = createPageRoute({ pattern: "/feed/secret" });
    const dispatchMatchedPage = vi.fn(async () => new Response("secret"));
    const handler = createHandler({
      configHeaders: [],
      dispatchMatchedPage,
      matchInterceptRoute: (_pathname, sourcePathname) =>
        sourcePathname === "/feed/secret" ? { route: sourceRoute, params: {} } : null,
      matchRoute: () => null,
      middlewareModule: {
        default(request: NextRequest) {
          return request.nextUrl.pathname === "/feed/secret"
            ? new Response(null, {
                headers: {
                  "x-middleware-rewrite": "https://example.test/docs/login",
                },
              })
            : new Response(null, { headers: { "x-middleware-next": "1" } });
        },
      },
    });

    const headers = createRscRequestHeaders({ interceptionContext: "/feed/secret" });
    const rscUrl = await createRscRequestUrl("/docs/photos/1", headers);
    const response = await handler(new Request(`https://example.test${rscUrl}`, { headers }), null);

    expect(response.status).toBe(404);
    expect(dispatchMatchedPage).not.toHaveBeenCalled();
  });

  it("does not render an interception source when middleware rewrites only its query", async () => {
    const targetRoute = createPageRoute({ pattern: "/photos/1", routeSegments: ["photos", "1"] });
    const sourceRoute = createPageRoute({ pattern: "/feed" });
    const dispatchMatchedPage = vi.fn(async () => new Response("secret"));
    const handler = createHandler({
      configHeaders: [],
      dispatchMatchedPage,
      matchInterceptRoute: (_pathname, sourcePathname) =>
        sourcePathname === "/feed" ? { route: sourceRoute, params: {} } : null,
      matchRoute(pathname: string) {
        if (pathname === "/photos/1") return { params: {}, route: targetRoute };
        if (pathname === "/feed") return { params: {}, route: sourceRoute };
        return null;
      },
      middlewareModule: {
        default(request: NextRequest) {
          return request.nextUrl.pathname === "/feed"
            ? new Response(null, {
                headers: {
                  "x-middleware-rewrite": "https://example.test/docs/feed?view=login",
                },
              })
            : new Response(null, { headers: { "x-middleware-next": "1" } });
        },
      },
    });

    const headers = createRscRequestHeaders({ interceptionContext: "/feed" });
    const rscUrl = await createRscRequestUrl("/docs/photos/1?view=secret", headers);
    const response = await handler(new Request(`https://example.test${rscUrl}`, { headers }), null);

    expect(response.status).toBe(404);
    expect(dispatchMatchedPage).not.toHaveBeenCalled();
  });

  it("allows an identity rewrite that keeps the authorized source request unchanged", async () => {
    const targetRoute = createPageRoute({ pattern: "/photos/1", routeSegments: ["photos", "1"] });
    const sourceRoute = createPageRoute({ pattern: "/feed" });
    const dispatchMatchedPage = vi.fn(async () => new Response("page"));
    const handler = createHandler({
      configHeaders: [],
      dispatchMatchedPage,
      matchInterceptRoute: (_pathname, sourcePathname) =>
        sourcePathname === "/feed" ? { route: sourceRoute, params: {} } : null,
      matchRoute(pathname: string) {
        if (pathname === "/photos/1") return { params: {}, route: targetRoute };
        if (pathname === "/feed") return { params: {}, route: sourceRoute };
        return null;
      },
      middlewareModule: {
        default(request: NextRequest) {
          return request.nextUrl.pathname === "/feed"
            ? new Response(null, {
                headers: {
                  "x-middleware-rewrite": "https://example.test/docs/feed?tab=comments",
                },
              })
            : new Response(null, { headers: { "x-middleware-next": "1" } });
        },
      },
    });

    const headers = createRscRequestHeaders({ interceptionContext: "/feed" });
    const rscUrl = await createRscRequestUrl("/docs/photos/1?tab=comments", headers);
    const response = await handler(new Request(`https://example.test${rscUrl}`, { headers }), null);

    expect(response.status).toBe(200);
    expect(dispatchMatchedPage).toHaveBeenCalledOnce();
  });

  it("allows a source rewrite that resolves to the selected route and params", async () => {
    const targetRoute = createPageRoute({ pattern: "/photos/1", routeSegments: ["photos", "1"] });
    const sourceRoute = createPageRoute({
      pattern: "/:locale/feed",
      routeSegments: ["[locale]", "feed"],
    });
    const dispatchMatchedPage = vi.fn(async () => new Response("page"));
    const handler = createHandler({
      configHeaders: [],
      dispatchMatchedPage,
      matchInterceptRoute: (_pathname, sourcePathname) =>
        sourcePathname === "/feed" ? { route: sourceRoute, params: { locale: "en" } } : null,
      matchRoute(pathname: string) {
        if (pathname === "/photos/1") {
          return { params: {} as Record<string, string | string[]>, route: targetRoute };
        }
        if (pathname === "/en/feed") {
          return {
            params: { locale: "en" } as Record<string, string | string[]>,
            route: sourceRoute,
          };
        }
        return null;
      },
      middlewareModule: {
        default(request: NextRequest) {
          return request.nextUrl.pathname === "/feed"
            ? new Response(null, {
                headers: { "x-middleware-rewrite": "https://example.test/docs/en/feed" },
              })
            : new Response(null, { headers: { "x-middleware-next": "1" } });
        },
      },
    });

    const headers = createRscRequestHeaders({ interceptionContext: "/feed" });
    const rscUrl = await createRscRequestUrl("/docs/photos/1", headers);
    const response = await handler(new Request(`https://example.test${rscUrl}`, { headers }), null);

    expect(response.status).toBe(200);
    expect(dispatchMatchedPage).toHaveBeenCalledOnce();
  });

  it.each([
    {
      kind: "request headers",
      sourceResponseHeaders: new Headers({
        "x-middleware-next": "1",
        "x-middleware-override-headers": "x-source-only",
        "x-middleware-request-x-source-only": "source",
      }),
    },
    {
      kind: "cookies set by middleware",
      sourceResponseHeaders: new Headers({
        "x-middleware-next": "1",
        "x-middleware-set-cookie": "source-session=1; Path=/",
      }),
    },
  ])("fails closed when source authorization changes $kind", async ({ sourceResponseHeaders }) => {
    const targetRoute = createPageRoute({ pattern: "/photos/1", routeSegments: ["photos", "1"] });
    const sourceRoute = createPageRoute({ pattern: "/feed" });
    const dispatchMatchedPage = vi.fn(async () => new Response("secret"));
    const handler = createHandler({
      configHeaders: [],
      dispatchMatchedPage,
      matchInterceptRoute: (_pathname, sourcePathname) =>
        sourcePathname === "/feed" ? { route: sourceRoute, params: {} } : null,
      matchRoute: (pathname: string) =>
        pathname === "/photos/1" ? { params: {}, route: targetRoute } : null,
      middlewareModule: {
        default(request: NextRequest) {
          if (request.nextUrl.pathname !== "/feed") {
            return new Response(null, { headers: { "x-middleware-next": "1" } });
          }
          return new Response(null, { headers: sourceResponseHeaders });
        },
      },
    });

    const headers = createRscRequestHeaders({ interceptionContext: "/feed" });
    const rscUrl = await createRscRequestUrl("/docs/photos/1", headers);
    const response = await handler(new Request(`https://example.test${rscUrl}`, { headers }), null);

    expect(response.status).toBe(404);
    expect(dispatchMatchedPage).not.toHaveBeenCalled();
  });

  it("invalidates a primed headers snapshot when source middleware adds a header", async () => {
    const targetRoute = createPageRoute({ pattern: "/photos/1", routeSegments: ["photos", "1"] });
    const sourceRoute = createPageRoute({ pattern: "/feed" });
    const dispatchMatchedPage = vi.fn(async () => {
      const currentHeaders = await requestHeaders();
      return new Response(currentHeaders.get("x-source") ?? "missing");
    });
    const handler = createHandler({
      configHeaders: [],
      dispatchMatchedPage,
      matchInterceptRoute: (_pathname, sourcePathname) =>
        sourcePathname === "/feed" ? { route: sourceRoute, params: {} } : null,
      matchRoute: (pathname: string) =>
        pathname === "/photos/1" ? { params: {}, route: targetRoute } : null,
      async runMiddleware({ cleanPathname }) {
        if (cleanPathname === "/photos/1") {
          await requestHeaders();
        } else {
          getHeadersContext()?.headers.set("x-source", "added");
        }
        return { kind: "continue", cleanPathname, rewritten: false, search: null };
      },
    });

    const headers = createRscRequestHeaders({ interceptionContext: "/feed" });
    const rscUrl = await createRscRequestUrl("/docs/photos/1", headers);
    const response = await handler(new Request(`https://example.test${rscUrl}`, { headers }), null);

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("added");
  });

  it("preserves the Server Action body after authorizing an interception source", async () => {
    const targetRoute = createPageRoute({ pattern: "/photos/1", routeSegments: ["photos", "1"] });
    const sourceRoute = createPageRoute({ pattern: "/feed" });
    const middlewarePaths: string[] = [];
    const handleServerActionRequest = vi.fn(
      async ({ request }: { request: Request }) => new Response(await request.text()),
    );
    const handler = createHandler({
      configHeaders: [],
      handleServerActionRequest,
      matchInterceptRoute: (_pathname, sourcePathname) =>
        sourcePathname === "/feed" ? { route: sourceRoute, params: {} } : null,
      matchRoute: (pathname: string) =>
        pathname === "/photos/1" ? { params: {}, route: targetRoute } : null,
      middlewareModule: {
        async default(request: NextRequest) {
          middlewarePaths.push(request.nextUrl.pathname);
          if (request.nextUrl.pathname === "/feed") {
            expect(await request.text()).toBe("action-body");
          }
          return new Response(null, { headers: { "x-middleware-next": "1" } });
        },
      },
    });

    const headers = createRscRequestHeaders({ interceptionContext: "/feed" });
    headers.set("content-type", "text/plain");
    headers.set("next-action", "interception-action");
    const response = await handler(
      new Request("https://example.test/docs/photos/1", {
        body: "action-body",
        headers,
        method: "POST",
      }),
      null,
    );

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("action-body");
    expect(middlewarePaths).toEqual(["/photos/1", "/feed"]);
    expect(handleServerActionRequest).toHaveBeenCalledOnce();
  });

  it("does not await cancellation of a streaming Server Action body branch", async () => {
    const targetRoute = createPageRoute({ pattern: "/photos/1", routeSegments: ["photos", "1"] });
    const sourceRoute = createPageRoute({ pattern: "/feed" });
    let resolveBodyCancelled!: () => void;
    const bodyCancelled = new Promise<void>((resolve) => {
      resolveBodyCancelled = resolve;
    });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("action-body"));
      },
      cancel() {
        resolveBodyCancelled();
      },
    });
    const handler = createHandler({
      configHeaders: [],
      handleServerActionRequest: async ({ request }: { request: Request }) => {
        void request.body?.cancel().catch(() => {});
        return new Response("dispatched");
      },
      matchInterceptRoute: (_pathname, sourcePathname) =>
        sourcePathname === "/feed" ? { route: sourceRoute, params: {} } : null,
      matchRoute: (pathname: string) =>
        pathname === "/photos/1" ? { params: {}, route: targetRoute } : null,
      middlewareModule: {
        default: () => new Response(null, { headers: { "x-middleware-next": "1" } }),
      },
    });

    const headers = createRscRequestHeaders({ interceptionContext: "/feed" });
    headers.set("content-type", "text/plain");
    headers.set("next-action", "interception-action");
    const requestInit: RequestInit = { body, headers, method: "POST" };
    Object.defineProperty(requestInit, "duplex", { value: "half" });
    const responsePromise = handler(
      new Request("https://example.test/docs/photos/1", requestInit),
      null,
    );
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const responseBeforeBodyClose = await Promise.race([
      responsePromise,
      new Promise<null>((resolve) => {
        timeout = setTimeout(() => resolve(null), 500);
      }),
    ]);
    if (timeout) clearTimeout(timeout);
    const response = responseBeforeBodyClose ?? (await responsePromise);

    expect(responseBeforeBodyClose).not.toBeNull();
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("dispatched");
    await expect(
      Promise.race([
        bodyCancelled.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 500)),
      ]),
    ).resolves.toBe(true);
  });

  it("does not re-run middleware when no interception context is supplied", async () => {
    const targetRoute = createPageRoute({ pattern: "/photos/1", routeSegments: ["photos", "1"] });
    const middlewarePaths: string[] = [];
    const handler = createHandler({
      configHeaders: [],
      matchInterceptRoute: () => null,
      matchRoute: (pathname: string) =>
        pathname === "/photos/1" ? { params: {}, route: targetRoute } : null,
      async runMiddleware({ cleanPathname }) {
        middlewarePaths.push(cleanPathname);
        return { kind: "continue", cleanPathname, rewritten: false, search: null };
      },
    });

    const headers = createRscRequestHeaders({});
    const rscUrl = await createRscRequestUrl("/docs/photos/1", headers);
    await handler(new Request(`https://example.test${rscUrl}`, { headers }), null);

    expect(middlewarePaths).toEqual(["/photos/1"]);
  });

  it("does not promote a Route Handler slot owner for interception-only RSC targets", async () => {
    // A `route.ts` record can retain parallel slots discovered beside it. A
    // client-controlled interception context may gate the modal rewrite, but
    // Next.js never dispatches the owning handler as its source route.
    // https://github.com/vercel/next.js/blob/canary/packages/next/src/lib/generate-interception-routes-rewrites.ts
    const matcher = createAppRscRouteMatcher([
      {
        pattern: "/feed",
        patternParts: ["feed"],
        __loadRouteHandler: async () => ({}),
        slots: {
          modal: {
            intercepts: [
              {
                sourceMatchPattern: "/feed",
                targetPattern: "/feed/hidden",
                interceptLayouts: ["layout"],
                page: "modal-page",
                params: [],
              },
            ],
          },
        },
      },
    ]);
    const handlerOwner = createPageRoute({
      __loadPage: undefined,
      __loadRouteHandler() {},
      page: null,
      pattern: "/feed",
      routeHandler: { GET: () => new Response("secret handler") },
      routeSegments: ["feed"],
    });
    const dispatchMatchedPage = vi.fn(async () => new Response("page"));
    const dispatchMatchedRouteHandler = vi.fn(async () => new Response("secret handler"));
    const handler = createHandler({
      configHeaders: [],
      dispatchMatchedPage,
      dispatchMatchedRouteHandler,
      matchInterceptRoute(pathname, sourcePathname) {
        const intercept = matcher.findIntercept(pathname, sourcePathname);
        return intercept ? { route: handlerOwner, params: {} } : null;
      },
      matchRoute: (pathname) => (pathname === "/feed" ? { route: handlerOwner, params: {} } : null),
    });

    // Direct requests still reach the Route Handler.
    const directResponse = await handler(new Request("https://example.test/docs/feed"), null);
    expect(await directResponse.text()).toBe("secret handler");
    expect(dispatchMatchedRouteHandler).toHaveBeenCalledOnce();
    dispatchMatchedRouteHandler.mockClear();

    // The same handler must not be promoted for a forged interception-only
    // target whose middleware/routing path was `/feed/hidden`.
    const headers = createRscRequestHeaders({ interceptionContext: "/feed" });
    const rscUrl = await createRscRequestUrl("/docs/feed/hidden", headers);
    const response = await handler(new Request(`https://example.test${rscUrl}`, { headers }), null);

    expect(response.status).toBe(404);
    expect(dispatchMatchedRouteHandler).not.toHaveBeenCalled();
    expect(dispatchMatchedPage).not.toHaveBeenCalled();
  });

  it("uses the request pathname consistently for encoded interception targets", async () => {
    const sourceRoute = createPageRoute({
      isDynamic: true,
      params: ["slug"],
      pattern: "/feed/:slug",
      routeSegments: ["feed", "[slug]"],
    });
    const dispatchMatchedPage = vi.fn(async () => new Response("intercepted", { status: 200 }));
    const matchInterceptRoute = vi.fn((pathname: string, sourcePathname: string) => {
      if (pathname !== "/photos/%5Fhidden" || sourcePathname !== "/feed/a%252Fb") return null;
      return { route: sourceRoute, params: { slug: "a%2Fb" } };
    });
    const handler = createHandler({
      configHeaders: [],
      dispatchMatchedPage,
      matchInterceptRoute,
      matchRoute: () => null,
    });

    const headers = createRscRequestHeaders({ interceptionContext: "/feed/a%252Fb" });
    const rscUrl = await createRscRequestUrl("/docs/photos/%5Fhidden", headers);
    const response = await handler(new Request(`https://example.test${rscUrl}`, { headers }), null);

    expect(response.status).toBe(200);
    expect(matchInterceptRoute).toHaveBeenCalledWith("/photos/%5Fhidden", "/feed/a%252Fb", null);
    expect(dispatchMatchedPage).toHaveBeenCalledWith(
      expect.objectContaining({
        interceptionPathname: "/photos/%5Fhidden",
        params: { slug: "a%2Fb" },
        route: sourceRoute,
      }),
    );
  });

  it("promotes an interception-only target before server-action dispatch", async () => {
    const sourceRoute = createPageRoute({
      isDynamic: true,
      params: ["locale", "tab"],
      pattern: "/:locale/example/:tab",
      rootParamNames: ["locale"],
      routeSegments: ["[locale]", "example", "[tab]"],
    });
    const promotedMatch = {
      route: sourceRoute,
      params: { locale: "en", tab: "recent" },
    };
    const handleServerActionRequest = vi.fn(
      async () => new Response("intercepted-action", { status: 200 }),
    );
    const handler = createHandler({
      configHeaders: [],
      handleServerActionRequest,
      matchInterceptRoute(pathname, sourcePathname) {
        if (pathname !== "/en/intercepted" || sourcePathname !== "/en/example/recent") {
          return null;
        }
        return promotedMatch;
      },
      matchRoute: () => null,
    });

    const headers = createRscRequestHeaders({ interceptionContext: "/en/example/recent" });
    headers.set("next-action", "interception-action");
    const rscUrl = await createRscRequestUrl("/docs/en/intercepted", headers);
    const response = await handler(
      new Request(`https://example.test${rscUrl}`, {
        headers,
        method: "POST",
      }),
      null,
    );

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("intercepted-action");
    expect(handleServerActionRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        actionId: "interception-action",
        cleanPathname: "/en/intercepted",
        interceptionContext: "/en/example/recent",
        routeMatch: promotedMatch,
      }),
    );
  });

  it("keeps interception-only targets unavailable to direct document requests", async () => {
    const matchInterceptRoute = vi.fn(() => ({ route: createPageRoute(), params: {} }));
    const dispatchMatchedPage = vi.fn(async () => new Response("intercepted", { status: 200 }));
    const handler = createHandler({
      configHeaders: [],
      dispatchMatchedPage,
      matchInterceptRoute,
      matchRoute: () => null,
    });

    const response = await handler(
      new Request("https://example.test/docs/en/intercepted", {
        headers: { "x-vinext-interception-context": "/en/example" },
      }),
      null,
    );

    expect(response.status).toBe(404);
    expect(matchInterceptRoute).not.toHaveBeenCalled();
    expect(dispatchMatchedPage).not.toHaveBeenCalled();
  });

  it("allows independent Next.js blur width and quality exceptions in pure App Router dev", async () => {
    // The blur quality exception (q=70) is only observable when `qualities` is
    // configured — with an unset allowlist any quality 1-100 is permitted, so
    // pin it to [75] to exercise the dev-only exception itself.
    const handler = createHandler({ imageConfig: { qualities: [75] } });
    for (const query of ["url=%2Fimg.jpg&w=8&q=75", "url=%2Fimg.jpg&w=640&q=70"]) {
      const response = await handler(
        new Request(`https://example.test/docs/_next/image?${query}`),
        null,
      );
      expect(response.status).toBe(302);
    }
  });

  it("rejects Next.js blur width and quality exceptions in production", async () => {
    const handler = createHandler({ isDev: false, imageConfig: { qualities: [75] } });
    for (const query of ["url=%2Fimg.jpg&w=8&q=75", "url=%2Fimg.jpg&w=640&q=70"]) {
      const response = await handler(
        new Request(`https://example.test/docs/_next/image?${query}`),
        null,
      );
      expect(response.status).toBe(400);
    }
  });

  it("allows any quality 1-100 in production when images.qualities is unset", async () => {
    // Matches Next.js: an unset `qualities` is not restricted to a single value,
    // so q=70 (and any 1-100) is a normal quality even in production.
    const handler = createHandler({ isDev: false });
    const response = await handler(
      new Request("https://example.test/docs/_next/image?url=%2Fimg.jpg&w=640&q=70"),
      null,
    );
    expect(response.status).toBe(302);
  });

  it("wraps dispatch responses with request-scoped finalization", async () => {
    const dispatchMatchedPage = vi.fn(async () => new Response("page", { status: 200 }));
    const handler = createHandler({ dispatchMatchedPage });

    const response = await handler(new Request("https://example.test/docs/about"), null);

    expect(dispatchMatchedPage).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-test-header")).toBe("applied");
    expect(response.headers.get("vary")).toBe(VINEXT_RSC_VARY_HEADER);
  });

  it("does not trailing-slash redirect RSC requests built from already-canonical trailingSlash paths", async () => {
    const headers = createRscRequestHeaders();
    const requestPath = await createRscRequestUrl("/about/", headers);
    const dispatchMatchedPage = vi.fn(async () => new Response("page", { status: 200 }));
    const route = createPageRoute({ pattern: "/about/", routeSegments: ["about"] });
    const handler = createHandler({
      configHeaders: [],
      dispatchMatchedPage,
      matchRoute(pathname: string) {
        return pathname === "/about/" ? { params: {}, route } : null;
      },
      trailingSlash: true,
    });

    const response = await handler(
      new Request(`https://example.test/docs${requestPath}`, { headers }),
      null,
    );

    expect(response.status).toBe(200);
    expect(response.headers.has("location")).toBe(false);
    expect(dispatchMatchedPage).toHaveBeenCalledTimes(1);
  });

  it("does not trailing-slash redirect extensionless metadata image routes", async () => {
    const handler = createHandler({
      configHeaders: [],
      metadataRoutes: [
        {
          type: "icon",
          isDynamic: true,
          filePath: "/tmp/app/icon.tsx",
          routePrefix: "",
          routeSegments: [],
          servedUrl: "/icon",
          contentType: "image/png",
          module: {
            default: async () =>
              new Response("icon bytes", { headers: { "content-type": "image/png" } }),
          },
        },
      ],
      trailingSlash: true,
    });

    const response = await handler(new Request("https://example.test/docs/icon"), null);

    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    expect(await response.text()).toBe("icon bytes");
  });

  it("marks progressive action page renders even when decoded form state is null", async () => {
    const dispatchMatchedPage = vi.fn(async () => new Response("page", { status: 200 }));
    const handler = createHandler({
      configHeaders: [],
      dispatchMatchedPage,
      async handleProgressiveActionRequest() {
        return {
          kind: "form-state",
          formState: null,
          pendingCookies: [],
          draftCookie: null,
          revalidationKind: 0,
        };
      },
    });

    const response = await handler(
      new Request("https://example.test/docs/about", {
        method: "POST",
        headers: { "content-type": "multipart/form-data; boundary=vinext" },
      }),
      null,
    );

    expect(response.status).toBe(200);
    expect(dispatchMatchedPage).toHaveBeenCalledWith(
      expect.objectContaining({
        formState: null,
        isProgressiveActionRender: true,
      }),
    );
  });

  it("returns HTTP 500 for progressive action execution failures", async () => {
    const dispatchMatchedPage = vi.fn(async ({ middlewareContext }) =>
      Promise.resolve(new Response("error page", { status: middlewareContext.status ?? 200 })),
    );
    const handler = createHandler({
      configHeaders: [],
      dispatchMatchedPage,
      async handleProgressiveActionRequest() {
        return {
          kind: "form-state",
          formState: null,
          actionError: new Error("boom"),
          actionFailed: true,
          pendingCookies: [],
          draftCookie: null,
          revalidationKind: 0,
        };
      },
    });

    const response = await handler(
      new Request("https://example.test/docs/about", {
        method: "POST",
        headers: { "content-type": "multipart/form-data; boundary=vinext" },
      }),
      null,
    );

    expect(response.status).toBe(500);
    expect(dispatchMatchedPage).toHaveBeenCalledWith(
      expect.objectContaining({
        actionFailed: true,
        middlewareContext: expect.objectContaining({ status: 500 }),
      }),
    );
  });

  it("preserves progressive action HTTP fallback status handling", async () => {
    const dispatchMatchedPage = vi.fn(async ({ middlewareContext }) =>
      Promise.resolve(new Response("not found", { status: middlewareContext.status ?? 404 })),
    );
    const handler = createHandler({
      configHeaders: [],
      dispatchMatchedPage,
      async handleProgressiveActionRequest() {
        return {
          kind: "form-state",
          formState: null,
          actionError: { digest: "NEXT_NOT_FOUND" },
          actionFailed: true,
          pendingCookies: [],
          draftCookie: null,
          revalidationKind: 0,
        };
      },
    });

    const response = await handler(
      new Request("https://example.test/docs/about", {
        method: "POST",
        headers: { "content-type": "multipart/form-data; boundary=vinext" },
      }),
      null,
    );

    expect(response.status).toBe(404);
    expect(dispatchMatchedPage).toHaveBeenCalledWith(
      expect.objectContaining({
        middlewareContext: expect.objectContaining({ status: null }),
      }),
    );
  });

  it("normalizes progressive forbidden fallbacks to Next.js not-found rendering", async () => {
    const dispatchMatchedPage = vi.fn(async ({ actionError, middlewareContext }) =>
      Promise.resolve(
        new Response(JSON.stringify(actionError), { status: middlewareContext.status ?? 404 }),
      ),
    );
    const handler = createHandler({
      configHeaders: [],
      dispatchMatchedPage,
      async handleProgressiveActionRequest() {
        return {
          kind: "form-state",
          formState: null,
          actionError: { digest: "NEXT_HTTP_ERROR_FALLBACK;403" },
          actionFailed: true,
          pendingCookies: [],
          draftCookie: null,
          revalidationKind: 0,
        };
      },
    });

    const response = await handler(
      new Request("https://example.test/docs/about", {
        method: "POST",
        headers: { "content-type": "multipart/form-data; boundary=vinext" },
      }),
      null,
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ digest: "NEXT_NOT_FOUND" });
    expect(dispatchMatchedPage).toHaveBeenCalledWith(
      expect.objectContaining({
        actionError: { digest: "NEXT_NOT_FOUND" },
        middlewareContext: expect.objectContaining({ status: null }),
      }),
    );
  });

  // Regression for issue #1483 — `cookies().set(...)` / `cookies().delete(...)`
  // and `draftMode().enable()` invoked inside a no-JS server action must flow
  // through to the page rerender response. Before the fix, those Set-Cookie
  // headers (plus the x-action-revalidated marker) were dropped on the floor
  // because the handler returned the dispatcher's response untouched.
  it("propagates cookies, draft cookie, and revalidation marker from a progressive action to the page response (#1483)", async () => {
    const dispatchMatchedPage = vi.fn(
      async () =>
        new Response("page", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    );
    const handler = createHandler({
      configHeaders: [],
      dispatchMatchedPage,
      async handleProgressiveActionRequest() {
        return {
          kind: "form-state",
          formState: null,
          pendingCookies: ["session=abc; Path=/", "theme=dark; Path=/"],
          draftCookie: "__prerender_bypass=secret; Path=/",
          revalidationKind: 1,
        };
      },
    });

    const response = await handler(
      new Request("https://example.test/docs/about", {
        method: "POST",
        headers: { "content-type": "multipart/form-data; boundary=vinext" },
      }),
      null,
    );

    expect(response.status).toBe(200);
    expect(response.headers.getSetCookie()).toEqual([
      "session=abc; Path=/",
      "theme=dark; Path=/",
      "__prerender_bypass=secret; Path=/",
    ]);
    expect(response.headers.get("x-action-revalidated")).toBe("1");
  });

  // When an action did not mutate cookies and did not request a revalidation,
  // the page response should NOT carry an x-action-revalidated marker — that
  // header tells the client router cache to invalidate, and emitting it
  // spuriously would force unnecessary refetches.
  it("does not add x-action-revalidated when a progressive action made no mutations (#1483)", async () => {
    const dispatchMatchedPage = vi.fn(
      async () =>
        new Response("page", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    );
    const handler = createHandler({
      configHeaders: [],
      dispatchMatchedPage,
      async handleProgressiveActionRequest() {
        return {
          kind: "form-state",
          formState: null,
          pendingCookies: [],
          draftCookie: null,
          revalidationKind: 0,
        };
      },
    });

    const response = await handler(
      new Request("https://example.test/docs/about", {
        method: "POST",
        headers: { "content-type": "multipart/form-data; boundary=vinext" },
      }),
      null,
    );

    expect(response.status).toBe(200);
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(response.headers.has("x-action-revalidated")).toBe(false);
  });

  it("uses encoded prerender route params for rendering while retaining decoded params for static validation", async () => {
    const previousPrerender = process.env.VINEXT_PRERENDER;
    process.env.VINEXT_PRERENDER = "1";
    const dispatchMatchedPage = vi.fn(async () => new Response("page", { status: 200 }));
    const prerenderRoute = createPageRoute({
      isDynamic: true,
      pattern: "/prerender-encoding/:id",
      routeSegments: ["prerender-encoding", "[id]"],
    });
    const handler = createHandler({
      configHeaders: [],
      dispatchMatchedPage,
      matchRoute(pathname: string) {
        return pathname === "/prerender-encoding/sticks & stones"
          ? {
              params: { id: "sticks & stones" },
              route: prerenderRoute,
            }
          : null;
      },
    });

    try {
      const response = await handler(
        new Request("https://example.test/docs/prerender-encoding/sticks%20%26%20stones", {
          headers: {
            "x-vinext-prerender-secret": "test-secret",
            "x-vinext-prerender-route-params": prerenderRouteParamsHeader({
              routePattern: "/prerender-encoding/:id",
              params: { id: "sticks%20%26%20stones" },
            }),
          },
        }),
        null,
      );

      expect(response.status).toBe(200);
      expect(dispatchMatchedPage).toHaveBeenCalledWith(
        expect.objectContaining({
          params: { id: "sticks%20%26%20stones" },
          staticParamsValidationParams: { id: "sticks & stones" },
        }),
      );
    } finally {
      if (previousPrerender === undefined) {
        delete process.env.VINEXT_PRERENDER;
      } else {
        process.env.VINEXT_PRERENDER = previousPrerender;
      }
    }
  });

  it("ignores encoded prerender route params from a different rewritten route pattern", async () => {
    const previousPrerender = process.env.VINEXT_PRERENDER;
    process.env.VINEXT_PRERENDER = "1";
    const dispatchMatchedPage = vi.fn(async () => new Response("page", { status: 200 }));
    const productRoute = createPageRoute({
      isDynamic: true,
      pattern: "/product/:id",
      routeSegments: ["product", "[id]"],
    });
    const handler = createHandler({
      configHeaders: [],
      configRewrites: {
        beforeFiles: [{ source: "/source/:slug", destination: "/product/:slug" }],
        afterFiles: [],
        fallback: [],
      },
      dispatchMatchedPage,
      matchRoute(pathname: string) {
        return pathname === "/product/sticks%20%26%20stones"
          ? {
              params: { id: "sticks%20%26%20stones" },
              route: productRoute,
            }
          : null;
      },
    });

    try {
      const response = await handler(
        new Request("https://example.test/docs/source/sticks%20%26%20stones", {
          headers: {
            "x-vinext-prerender-secret": "test-secret",
            "x-vinext-prerender-route-params": prerenderRouteParamsHeader({
              routePattern: "/source/:slug",
              params: { slug: "sticks%20%26%20stones" },
            }),
          },
        }),
        null,
      );

      expect(response.status).toBe(200);
      expect(dispatchMatchedPage).toHaveBeenCalledWith(
        expect.objectContaining({
          cleanPathname: "/product/sticks%20%26%20stones",
          params: { id: "sticks%20%26%20stones" },
          staticParamsValidationParams: undefined,
        }),
      );
    } finally {
      if (previousPrerender === undefined) {
        delete process.env.VINEXT_PRERENDER;
      } else {
        process.env.VINEXT_PRERENDER = previousPrerender;
      }
    }
  });

  it("ignores encoded prerender route params when a same-pattern rewrite changes the matched params", async () => {
    const previousPrerender = process.env.VINEXT_PRERENDER;
    process.env.VINEXT_PRERENDER = "1";
    const dispatchMatchedPage = vi.fn(async () => new Response("page", { status: 200 }));
    const productRoute = createPageRoute({
      isDynamic: true,
      pattern: "/product/:id",
      routeSegments: ["product", "[id]"],
    });
    const handler = createHandler({
      configHeaders: [],
      configRewrites: {
        beforeFiles: [{ source: "/product/:id", destination: "/product/sticks-and-stones" }],
        afterFiles: [],
        fallback: [],
      },
      dispatchMatchedPage,
      matchRoute(pathname: string) {
        return pathname === "/product/sticks-and-stones"
          ? {
              params: { id: "sticks-and-stones" },
              route: productRoute,
            }
          : null;
      },
    });

    try {
      const response = await handler(
        new Request("https://example.test/docs/product/sticks%20%26%20stones", {
          headers: {
            "x-vinext-prerender-secret": "test-secret",
            "x-vinext-prerender-route-params": prerenderRouteParamsHeader({
              routePattern: "/product/:id",
              params: { id: "sticks%20%26%20stones" },
            }),
          },
        }),
        null,
      );

      expect(response.status).toBe(200);
      expect(dispatchMatchedPage).toHaveBeenCalledWith(
        expect.objectContaining({
          cleanPathname: "/product/sticks-and-stones",
          params: { id: "sticks-and-stones" },
          staticParamsValidationParams: undefined,
        }),
      );
    } finally {
      if (previousPrerender === undefined) {
        delete process.env.VINEXT_PRERENDER;
      } else {
        process.env.VINEXT_PRERENDER = previousPrerender;
      }
    }
  });

  it("ignores forged prerender route params outside trusted prerender requests", async () => {
    const previousPrerender = process.env.VINEXT_PRERENDER;
    delete process.env.VINEXT_PRERENDER;
    const dispatchMatchedPage = vi.fn(async () => new Response("page", { status: 200 }));
    const prerenderRoute = createPageRoute({
      isDynamic: true,
      pattern: "/prerender-encoding/:id",
      routeSegments: ["prerender-encoding", "[id]"],
    });
    const handler = createHandler({
      configHeaders: [],
      dispatchMatchedPage,
      matchRoute(pathname: string) {
        return pathname === "/prerender-encoding/sticks & stones"
          ? {
              params: { id: "sticks & stones" },
              route: prerenderRoute,
            }
          : null;
      },
    });

    try {
      const response = await handler(
        new Request("https://example.test/docs/prerender-encoding/sticks%20%26%20stones", {
          headers: {
            "x-vinext-prerender-secret": "test-secret",
            "x-vinext-prerender-route-params": prerenderRouteParamsHeader({
              routePattern: "/prerender-encoding/:id",
              params: { id: "forged" },
            }),
          },
        }),
        null,
      );

      expect(response.status).toBe(200);
      expect(dispatchMatchedPage).toHaveBeenCalledWith(
        expect.objectContaining({
          params: { id: "sticks & stones" },
        }),
      );
      expect(dispatchMatchedPage).not.toHaveBeenCalledWith(
        expect.objectContaining({
          staticParamsValidationParams: expect.anything(),
        }),
      );
    } finally {
      if (previousPrerender === undefined) {
        delete process.env.VINEXT_PRERENDER;
      } else {
        process.env.VINEXT_PRERENDER = previousPrerender;
      }
    }
  });

  it("returns config redirects before route dispatch and skips finalization", async () => {
    const dispatchMatchedPage = vi.fn(async () => new Response("page", { status: 200 }));
    const handler = createHandler({
      configRedirects: [{ source: "/old-about", destination: "/about", permanent: true }],
      dispatchMatchedPage,
    });

    const response = await handler(new Request("https://example.test/docs/old-about"), null);

    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe("/docs/about");
    expect(response.headers.get("x-test-header")).toBeNull();
    expect(dispatchMatchedPage).not.toHaveBeenCalled();
  });

  it("does not match config redirects through percent-encoded literal aliases", async () => {
    const dispatchMatchedPage = vi.fn(async () => new Response("page", { status: 200 }));
    const handler = createHandler({
      configHeaders: [],
      configRedirects: [{ source: "/old-about", destination: "/about", permanent: false }],
      dispatchMatchedPage,
    });

    const response = await handler(new Request("https://example.test/docs/%6Fld-about"), null);

    expect(response.status).toBe(404);
    expect(response.headers.get("location")).toBeNull();
    expect(dispatchMatchedPage).not.toHaveBeenCalled();
  });

  it("preserves raw encoding when substituting repeated config redirect captures", async () => {
    const handler = createHandler({
      configHeaders: [],
      configRedirects: [
        {
          source: "/legacy/:id",
          destination: "/target/:id/:id",
          permanent: false,
        },
      ],
    });

    const response = await handler(new Request("https://example.test/docs/legacy/a%252Fb"), null);

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("/docs/target/a%252Fb/a%252Fb");
  });

  it("does not prepend basePath to opt-out redirects outside basePath", async () => {
    const handler = createHandler({
      configHeaders: [],
      configRedirects: [
        { source: "/outside", destination: "/landing", permanent: false, basePath: false },
      ],
    });

    const response = await handler(new Request("https://example.test/outside"), null);

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("/landing");
  });

  it("does not prepend basePath when normalizing trailing slashes outside basePath", async () => {
    const handler = createHandler({
      configHeaders: [],
      configRewrites: {
        beforeFiles: [{ source: "/outside", destination: "/about", basePath: false }],
        afterFiles: [],
        fallback: [],
      },
      trailingSlash: true,
    });

    const response = await handler(new Request("https://example.test/outside"), null);

    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe("/outside/");
  });

  it("preserves raw encoded spelling when normalizing trailing slashes", async () => {
    const handler = createHandler({ configHeaders: [], trailingSlash: true });

    const response = await handler(new Request("https://example.test/docs/%61bout"), null);

    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe("/docs/%61bout/");
  });

  it("keeps the real status for config redirects on Pages data requests", async () => {
    // Ported from Next.js: test/e2e/middleware-general/test/index.test.ts
    // https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/middleware-general/test/index.test.ts
    const handler = createHandler({
      configRedirects: [{ source: "/old-about", destination: "/about", permanent: true }],
      matchRoute: () => null,
      renderPagesFallback: async () => new Response("pages-data"),
    });

    const response = await handler(
      new Request("https://example.test/docs/_next/data/build-id/old-about.json"),
      null,
    );

    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe("/docs/about");
    expect(response.headers.get("x-nextjs-redirect")).toBeNull();
  });

  it("ignores forged data headers for App Router config redirects", async () => {
    const handler = createHandler({
      configRedirects: [{ source: "/old-about", destination: "/about", permanent: true }],
    });

    const response = await handler(
      new Request("https://example.test/docs/old-about", {
        headers: { "x-nextjs-data": "1" },
      }),
      null,
    );

    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe("/docs/about");
    expect(response.headers.get("x-nextjs-redirect")).toBeNull();
  });

  it("lets middleware redirect headers override earlier matching config headers", async () => {
    // Next.js route order reference:
    // https://github.com/vercel/next.js/blob/canary/packages/next/src/server/lib/router-utils/resolve-routes.ts
    const dispatchMatchedPage = vi.fn(async () => new Response("page", { status: 200 }));
    const handler = createHandler({
      dispatchMatchedPage,
      middlewareModule: {
        default: () =>
          new Response(null, {
            status: 307,
            headers: {
              Location: "/login",
              "x-test-header": "middleware",
            },
          }),
      },
    });

    const response = await handler(new Request("https://example.test/docs/about"), null);

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("/login");
    expect(response.headers.get("x-test-header")).toBe("middleware");
    expect(dispatchMatchedPage).not.toHaveBeenCalled();
  });

  it("carries config headers on middleware redirects when middleware does not override them", async () => {
    // Next.js route order reference:
    // https://github.com/vercel/next.js/blob/canary/packages/next/src/server/lib/router-utils/resolve-routes.ts
    const dispatchMatchedPage = vi.fn(async () => new Response("page", { status: 200 }));
    const handler = createHandler({
      dispatchMatchedPage,
      middlewareModule: {
        default: () =>
          new Response(null, {
            status: 307,
            headers: { Location: "/login" },
          }),
      },
    });

    const response = await handler(new Request("https://example.test/docs/about"), null);

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("/login");
    expect(response.headers.get("x-test-header")).toBe("applied");
    expect(dispatchMatchedPage).not.toHaveBeenCalled();
  });

  it("propagates middleware rewrite query parameters to App pages", async () => {
    let pageOptions: Parameters<HandlerOptions["dispatchMatchedPage"]>[0] | undefined;
    const handler = createHandler({
      configHeaders: [],
      dispatchMatchedPage: async (options) => {
        pageOptions = options;
        return new Response("page");
      },
      middlewareModule: {
        default: () =>
          new Response(null, {
            headers: {
              "x-middleware-rewrite": "https://example.test/docs/about?destination=2&same=new",
            },
          }),
      },
    });

    await handler(new Request("https://example.test/docs/source?original=1&same=old"), null);

    expect(Object.fromEntries(pageOptions!.searchParams)).toEqual({
      destination: "2",
      same: "new",
    });
  });

  it("preserves the encoded request pathname for direct interception matching", async () => {
    let pageOptions: Parameters<HandlerOptions["dispatchMatchedPage"]>[0] | undefined;
    const handler = createHandler({
      configHeaders: [],
      dispatchMatchedPage: async (options) => {
        pageOptions = options;
        return new Response("page");
      },
      matchRequestRoute(pathname: string) {
        return pathname === "/about/%2561"
          ? {
              params: {},
              route: createPageRoute({ pattern: "/about/:id", isDynamic: true }),
            }
          : null;
      },
    });

    await handler(new Request("https://example.test/docs/about/%2561"), null);

    expect(pageOptions?.interceptionPathname).toBe("/about/%2561");
  });

  it("uses the normalized rewrite destination for interception matching", async () => {
    let pageOptions: Parameters<HandlerOptions["dispatchMatchedPage"]>[0] | undefined;
    const handler = createHandler({
      configHeaders: [],
      dispatchMatchedPage: async (options) => {
        pageOptions = options;
        return new Response("page");
      },
      middlewareModule: {
        default: () =>
          new Response(null, {
            headers: {
              "x-middleware-rewrite": "https://example.test/docs/about/%2561",
            },
          }),
      },
      matchRoute(pathname: string) {
        return pathname === "/about/%2561"
          ? {
              params: {},
              route: createPageRoute({ pattern: "/about/:id", isDynamic: true }),
            }
          : null;
      },
    });

    await handler(new Request("https://example.test/docs/source"), null);

    expect(pageOptions?.interceptionPathname).toBe("/about/%2561");
  });

  it("treats an explicit middleware rewrite as authoritative after normalization", async () => {
    const dispatchMatchedPage = vi.fn(async () => new Response("admin"));
    const requestRouteMatch = vi.fn(() => null);
    const rewrittenRoute = createPageRoute({ pattern: "/admin", routeSegments: ["admin"] });
    const handler = createHandler({
      configHeaders: [],
      dispatchMatchedPage,
      matchRequestRoute: requestRouteMatch,
      matchRoute(pathname: string) {
        return pathname === "/admin" ? { params: {}, route: rewrittenRoute } : null;
      },
      middlewareModule: {
        default: (request: NextRequest) =>
          new Response(null, {
            headers: {
              "x-middleware-rewrite": new URL("/docs/admin", request.url).toString(),
            },
          }),
      },
    });

    const response = await handler(new Request("https://example.test/docs/%61dmin"), null);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("admin");
    expect(requestRouteMatch).not.toHaveBeenCalled();
    expect(dispatchMatchedPage).toHaveBeenCalledWith(
      expect.objectContaining({ cleanPathname: "/admin", route: rewrittenRoute }),
    );
  });

  it("evaluates config rewrite conditions against middleware rewrite queries", async () => {
    let pageOptions: Parameters<HandlerOptions["dispatchMatchedPage"]>[0] | undefined;
    const handler = createHandler({
      configHeaders: [],
      configRewrites: {
        beforeFiles: [
          {
            source: "/intermediate",
            destination: "/about?destination=2",
            has: [{ type: "query", key: "stage", value: "1" }],
          },
        ],
        afterFiles: [],
        fallback: [],
      },
      dispatchMatchedPage: async (options) => {
        pageOptions = options;
        return new Response("page");
      },
      middlewareModule: {
        default: () =>
          new Response(null, {
            headers: {
              "x-middleware-rewrite": "https://example.test/docs/intermediate?stage=1",
            },
          }),
      },
    });

    await handler(new Request("https://example.test/docs/source"), null);

    expect(Object.fromEntries(pageOptions!.searchParams)).toEqual({
      destination: "2",
      stage: "1",
    });
  });

  it("allows middleware-rewritten RSC requests to hand off to Pages HTML", async () => {
    const headers = createRscRequestHeaders();
    const rscUrl = await createRscRequestUrl("/docs/source", headers);
    const renderPagesFallback = vi.fn(async ({ allowRscDocumentFallback, pathname }) =>
      allowRscDocumentFallback && pathname === "/pages"
        ? new Response("pages", { headers: { "content-type": "text/html" } })
        : null,
    );
    const handler = createHandler({
      configHeaders: [],
      matchRoute: () => null,
      middlewareModule: {
        default: () =>
          new Response(null, {
            headers: { "x-middleware-rewrite": "https://example.test/docs/pages" },
          }),
      },
      renderPagesFallback,
    });

    const response = await handler(new Request(`https://example.test${rscUrl}`, { headers }), null);

    expect(response.headers.get("content-type")).toBe("text/html");
    expect(await response.text()).toBe("pages");
  });

  it("does not hand query-only middleware-rewritten RSC requests to Pages HTML", async () => {
    const headers = createRscRequestHeaders();
    const rscUrl = await createRscRequestUrl("/docs/source", headers);
    const renderPagesFallback = vi.fn(async ({ allowRscDocumentFallback }) =>
      allowRscDocumentFallback
        ? new Response("pages", { headers: { "content-type": "text/html" } })
        : null,
    );
    const handler = createHandler({
      configHeaders: [],
      matchRoute: () => null,
      middlewareModule: {
        default: () =>
          new Response(null, {
            headers: { "x-middleware-rewrite": "https://example.test/docs/source?query=updated" },
          }),
      },
      renderPagesFallback,
    });

    const response = await handler(new Request(`https://example.test${rscUrl}`, { headers }), null);

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).not.toBe("text/html");
    expect(renderPagesFallback).toHaveBeenCalledWith(
      expect.objectContaining({ allowRscDocumentFallback: false }),
    );
  });

  it("does not duplicate additive config headers on non-redirect middleware responses", async () => {
    const handler = createHandler({
      configHeaders: [
        {
          source: "/about",
          headers: [{ key: "Vary", value: "X-Config" }],
        },
      ],
      middlewareModule: {
        default: () =>
          new Response("blocked", {
            status: 401,
            headers: { Vary: "User-Agent" },
          }),
      },
    });

    const response = await handler(new Request("https://example.test/docs/about"), null);
    const varyTokens = (response.headers.get("vary") ?? "").split(",").map((token) => token.trim());

    expect(response.status).toBe(401);
    expect(varyTokens).toContain("User-Agent");
    expect(varyTokens).toContain("X-Config");
    expect(varyTokens.filter((token) => token === "X-Config")).toHaveLength(1);
  });

  it("canonicalizes config redirect locations for RSC requests", async () => {
    const headers = createRscRequestHeaders({ mountedSlotsHeader: "slot:modal:/" });
    const expectedHash = await computeRscCacheBustingSearchParam(headers);
    const handler = createHandler({
      configHeaders: [],
      configRedirects: [{ source: "/old-about", destination: "/about?from=old", permanent: false }],
    });

    const response = await handler(
      new Request("https://example.test/docs/old-about.rsc", { headers }),
      null,
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      `https://example.test/docs/about?from=old&_rsc=${expectedHash}`,
    );
  });

  it("preserves the _rsc query on config redirects for .rsc requests without the RSC header (#1529)", async () => {
    // A `.rsc`-suffixed request is an RSC request even when the `RSC: 1`
    // header is absent (e.g. a CDN-style or auto-followed fetch). Without the
    // header the handler can't recompute the cache-busting hash, so the
    // non-header branch carries the original request query onto the Location
    // verbatim (mirroring Next.js resolve-routes.ts) rather than dropping it.
    // (Note: the `.rsc` suffix is not re-applied to the destination, so the
    // followed request isn't re-detected as RSC purely from `_rsc` — the
    // guarantee here is query preservation, not RSC re-detection.)
    const handler = createHandler({
      configHeaders: [],
      configRedirects: [{ source: "/old-about", destination: "/about", permanent: true }],
    });

    const response = await handler(
      new Request("https://example.test/docs/old-about.rsc?_rsc=abc123", {
        headers: { Accept: "text/x-component" },
      }),
      null,
    );

    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe("/docs/about?_rsc=abc123");
  });

  it("preserves the original request query on config redirects for document requests (#1529)", async () => {
    // A plain (non-RSC) document request that hits a config redirect must
    // carry its original query onto the Location, matching Next.js
    // resolve-routes.ts. The destination's own query wins on key conflicts.
    const handler = createHandler({
      configHeaders: [],
      configRedirects: [{ source: "/old-about", destination: "/about?from=old", permanent: true }],
    });

    const response = await handler(
      new Request("https://example.test/docs/old-about?foo=bar&from=req"),
      null,
    );

    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe("/docs/about?from=old&foo=bar");
  });

  it("redirects invalid RSC cache-busting requests before middleware", async () => {
    const middleware = vi.fn(() => new Response("middleware"));
    const dispatchMatchedPage = vi.fn(async () => new Response("page", { status: 200 }));
    const headers = createRscRequestHeaders({ mountedSlotsHeader: "slot:modal:/" });
    const expectedHash = await computeRscCacheBustingSearchParam(headers);
    const handler = createHandler({
      configHeaders: [],
      dispatchMatchedPage,
      middlewareModule: { default: middleware },
    });

    const response = await handler(
      new Request("https://example.test/docs/about.rsc?tab=latest", { headers }),
      null,
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      `/docs/about.rsc?tab=latest&_rsc=${expectedHash}`,
    );
    expect(middleware).not.toHaveBeenCalled();
    expect(dispatchMatchedPage).not.toHaveBeenCalled();
  });

  it("hides internal RSC cache-busting params from middleware nextUrl", async () => {
    // Ported from Next.js:
    // test/e2e/app-dir/navigation/middleware.js
    // https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-dir/navigation/middleware.js
    const middleware = vi.fn(
      (_: { nextUrl: URL }) => new Response(null, { headers: { "x-middleware-next": "1" } }),
    );
    const dispatchMatchedPage = vi.fn(async () => new Response("page", { status: 200 }));
    const headers = createRscRequestHeaders({ mountedSlotsHeader: "slot:modal:/" });
    const rscUrl = await createRscRequestUrl("/docs/about?tab=latest", headers);
    const handler = createHandler({
      configHeaders: [],
      dispatchMatchedPage,
      middlewareModule: { default: middleware },
    });

    const response = await handler(new Request(`https://example.test${rscUrl}`, { headers }), null);

    expect(response.status).toBe(200);
    expect(middleware).toHaveBeenCalledTimes(1);
    const middlewareRequest = middleware.mock.calls[0]?.[0];
    expect(middlewareRequest?.nextUrl.searchParams.has(VINEXT_RSC_CACHE_BUSTING_SEARCH_PARAM)).toBe(
      false,
    );
    expect(middlewareRequest?.nextUrl.search).toBe("?tab=latest");
    expect(dispatchMatchedPage).toHaveBeenCalledTimes(1);
  });

  it("forwards validated RSC cache-busting params to external rewrite proxies", async () => {
    // Matches Next.js middleware-rsc-external-rewrite: the destination server
    // needs `_rsc` because it cannot validate against the original request URL.
    // The fetch-cache instrumentation captures the real `fetch` at module load
    // and reinstalls a patched copy during request handling, so a global
    // `fetch` mock can't intercept the proxied request. Use a real loopback
    // server as the external rewrite destination and record the URL it
    // receives — that exercises the full handler -> applyRewrite ->
    // proxyExternalRequest path without fighting the instrumentation.
    const receivedUrls: string[] = [];
    const server = createServer((req, res) => {
      receivedUrls.push(req.url ?? "");
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("upstream");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    const upstreamBase = `http://127.0.0.1:${address.port}`;

    try {
      const headers = createRscRequestHeaders({ mountedSlotsHeader: "slot:modal:/" });
      const rscUrl = await createRscRequestUrl("/docs/proxy?tab=latest", headers);
      const handler = createHandler({
        configHeaders: [],
        configRewrites: {
          beforeFiles: [{ source: "/proxy", destination: `${upstreamBase}/proxy` }],
          afterFiles: [],
          fallback: [],
        },
        matchRoute: () => null,
      });

      const response = await handler(
        new Request(`https://example.test${rscUrl}`, { headers }),
        null,
      );

      expect(response.status).toBe(200);
      expect(receivedUrls).toHaveLength(1);
      const forwardedUrl = new URL(`${upstreamBase}${receivedUrls[0]}`);
      expect(forwardedUrl.searchParams.has(VINEXT_RSC_CACHE_BUSTING_SEARCH_PARAM)).toBe(true);
      expect(forwardedUrl.searchParams.get("tab")).toBe("latest");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it.each(["beforeFiles", "afterFiles", "fallback"] as const)(
    "validates out-of-basePath RSC requests before %s external rewrite proxies",
    async (phase) => {
      const receivedUrls: string[] = [];
      const server = createServer((req, res) => {
        receivedUrls.push(req.url ?? "");
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("upstream");
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address() as AddressInfo;
      const upstreamBase = `http://127.0.0.1:${address.port}`;

      try {
        const headers = createRscRequestHeaders({ mountedSlotsHeader: "slot:modal:/" });
        const expectedHash = await computeRscCacheBustingSearchParam(headers);
        const rewrite = {
          source: "/outside",
          destination: `${upstreamBase}/proxy`,
          basePath: false as const,
        };
        const handler = createHandler({
          configHeaders: [],
          configRewrites: {
            beforeFiles: phase === "beforeFiles" ? [rewrite] : [],
            afterFiles: phase === "afterFiles" ? [rewrite] : [],
            fallback: phase === "fallback" ? [rewrite] : [],
          },
          matchRoute: () => null,
        });

        for (const method of ["GET", "HEAD"] as const) {
          const response = await handler(
            new Request("https://example.test/outside.rsc?tab=latest", { headers, method }),
            null,
          );

          expect(response.status).toBe(307);
          expect(response.headers.get("location")).toBe(
            `/outside.rsc?tab=latest&_rsc=${expectedHash}`,
          );
        }
        expect(receivedUrls).toEqual([]);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );

  it.each(["middleware", "forwarded"] as const)(
    "validates out-of-basePath RSC requests before %s external rewrite proxies",
    async (mode) => {
      const receivedUrls: string[] = [];
      const server = createServer((req, res) => {
        receivedUrls.push(req.url ?? "");
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("upstream");
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address() as AddressInfo;
      const upstreamUrl = `http://127.0.0.1:${address.port}/proxy`;

      try {
        const headers = createRscRequestHeaders({ mountedSlotsHeader: "slot:modal:/" });
        const expectedHash = await computeRscCacheBustingSearchParam(headers);
        if (mode === "forwarded") {
          headers.set(
            VINEXT_MW_CTX_HEADER,
            JSON.stringify({
              h: [
                ["location", "/middleware-location"],
                ["set-cookie", "session=forwarded"],
              ],
              r: upstreamUrl,
            }),
          );
        }
        const handler = createHandler({
          configHeaders: [],
          middlewareModule: {
            default: () =>
              new Response(null, {
                headers: {
                  location: "/middleware-location",
                  "set-cookie": "session=middleware",
                  "x-middleware-rewrite": upstreamUrl,
                },
              }),
          },
          matchRoute: () => null,
        });

        for (const method of ["GET", "HEAD"] as const) {
          const response = await handler(
            new Request("https://example.test/outside.rsc?tab=latest", { headers, method }),
            null,
          );

          expect(response.status).toBe(307);
          expect(response.headers.get("location")).toBe(
            `/outside.rsc?tab=latest&_rsc=${expectedHash}`,
          );
          expect(response.headers.get("set-cookie")).toBe(`session=${mode}`);
        }
        expect(receivedUrls).toEqual([]);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );

  it.each(["middleware", "forwarded"] as const)(
    "forwards valid RSC cache-busting params to %s external rewrite proxies",
    async (mode) => {
      const receivedRequests: Array<{
        headers: import("node:http").IncomingHttpHeaders;
        url: string;
      }> = [];
      const server = createServer((req, res) => {
        receivedRequests.push({ headers: req.headers, url: req.url ?? "" });
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("upstream");
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address() as AddressInfo;
      const upstreamUrl = `http://127.0.0.1:${address.port}/proxy`;

      try {
        const headers = createRscRequestHeaders({
          mountedSlotsHeader: "slot:modal:/",
          prefetchRouterState: { pathAndSearch: "/outside?tab=latest", routeId: "/outside" },
        });
        const routerState = headers.get("next-router-state-tree");
        expect(routerState).not.toBeNull();
        if (mode === "forwarded") {
          headers.set(
            VINEXT_MW_CTX_HEADER,
            JSON.stringify({
              h: [
                [
                  "x-middleware-override-headers",
                  "rsc,next-router-prefetch,next-router-state-tree",
                ],
                ["x-middleware-request-next-router-prefetch", "0"],
                ["x-middleware-request-next-router-state-tree", "tampered"],
                ["x-middleware-request-rsc", "0"],
              ],
              r: upstreamUrl,
            }),
          );
        }
        const requestUrl = await createRscRequestUrl("/outside?tab=latest", headers);
        const handler = createHandler({
          configHeaders: [],
          middlewareModule: {
            default: () =>
              new Response(null, {
                headers: {
                  "x-middleware-override-headers":
                    "rsc,next-router-prefetch,next-router-state-tree",
                  "x-middleware-request-next-router-prefetch": "0",
                  "x-middleware-request-next-router-state-tree": "tampered",
                  "x-middleware-request-rsc": "0",
                  "x-middleware-rewrite": upstreamUrl,
                },
              }),
          },
          matchRoute: () => null,
        });

        const response = await handler(
          new Request(`https://example.test${requestUrl}`, { headers }),
          null,
        );

        expect(response.status).toBe(200);
        expect(receivedRequests).toHaveLength(1);
        const [received] = receivedRequests;
        const forwardedUrl = new URL(`http://vinext.local${received.url}`);
        expect(forwardedUrl.searchParams.has(VINEXT_RSC_CACHE_BUSTING_SEARCH_PARAM)).toBe(true);
        expect(received.headers[RSC_HEADER.toLowerCase()]).toBe("1");
        expect(received.headers[NEXT_ROUTER_PREFETCH_HEADER.toLowerCase()]).toBe("1");
        expect(received.headers["next-router-state-tree"]).toBe(routerState);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );

  it("applies basePath false rewrites before rejecting outside-basePath requests", async () => {
    // Ported from Next.js: test/e2e/app-dir/app-basepath/index.test.ts
    // https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-dir/app-basepath/index.test.ts
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("outside-base-path upstream");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;

    try {
      const handler = createHandler({
        configHeaders: [],
        configRewrites: {
          beforeFiles: [
            {
              source: "/outsideBasePath",
              destination: `http://127.0.0.1:${address.port}/`,
              basePath: false,
            },
          ],
          afterFiles: [],
          fallback: [],
        },
        matchRoute: () => null,
      });

      const response = await handler(new Request("https://example.test/outsideBasePath"), null);

      expect(response.status).toBe(200);
      expect(await response.text()).toBe("outside-base-path upstream");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("does not expose direct App routes outside basePath when an opt-out rule exists", async () => {
    const dispatchMatchedPage = vi.fn(async () => new Response("page"));
    const handler = createHandler({
      configHeaders: [],
      configRewrites: {
        beforeFiles: [{ source: "/only-this-path", destination: "/about", basePath: false }],
        afterFiles: [],
        fallback: [],
      },
      dispatchMatchedPage,
    });

    const response = await handler(new Request("https://example.test/about"), null);

    expect(response.status).toBe(404);
    expect(dispatchMatchedPage).not.toHaveBeenCalled();
  });

  it("does not dispatch server actions outside basePath when an opt-out rule exists", async () => {
    const handleServerActionRequest = vi.fn(async () => new Response("action"));
    const handler = createHandler({
      configHeaders: [{ source: "/outside", headers: [], basePath: false }],
      handleServerActionRequest,
    });

    const response = await handler(
      new Request("https://example.test/about", {
        method: "POST",
        headers: { "next-action": "abc123" },
      }),
      null,
    );

    expect(response.status).toBe(404);
    expect(handleServerActionRequest).not.toHaveBeenCalled();
  });

  it("passes outside-basePath state to middleware", async () => {
    let pathname: string | undefined;
    let basePath: string | undefined;
    const handler = createHandler({
      configHeaders: [{ source: "/outside", headers: [], basePath: false }],
      middlewareModule: {
        default: (request: Request & { nextUrl: URL & { basePath: string } }) => {
          pathname = request.nextUrl.pathname;
          basePath = request.nextUrl.basePath;
          return new Response(null, { headers: { "x-middleware-next": "1" } });
        },
      },
    });

    await handler(new Request("https://example.test/outside"), null);

    expect(pathname).toBe("/outside");
    expect(basePath).toBe("");
  });

  it("allows middleware-only apps to handle requests outside basePath", async () => {
    const handler = createHandler({
      configHeaders: [],
      middlewareModule: {
        default: (request: Request) =>
          Response.redirect(new URL("/docs/about", request.url).toString(), 307),
      },
    });

    const response = await handler(new Request("https://example.test/outside"), null);

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("/docs/about");
  });

  it("returns a plain 404 when middleware leaves an outside-basePath request unchanged", async () => {
    const renderNotFound = vi.fn(async () => new Response("rendered not found", { status: 404 }));
    const handler = createHandler({
      configHeaders: [],
      middlewareModule: {
        default: () => new Response(null, { headers: { "x-middleware-next": "1" } }),
      },
      renderNotFound,
    });

    const response = await handler(new Request("https://example.test/outside"), null);

    expect(response.status).toBe(404);
    expect(await response.text()).not.toBe("rendered not found");
    expect(renderNotFound).not.toHaveBeenCalled();
  });

  it("allows query-only middleware rewrites to make outside-basePath routes eligible", async () => {
    const dispatchMatchedPage = vi.fn(async () => new Response("page"));
    const handler = createHandler({
      configHeaders: [{ source: "/about", headers: [], basePath: false }],
      dispatchMatchedPage,
      middlewareModule: {
        default: (request: Request) =>
          new Response(null, {
            headers: {
              "x-middleware-rewrite": new URL("/about?from=middleware", request.url).toString(),
            },
          }),
      },
    });

    const response = await handler(new Request("https://example.test/about"), null);

    expect(response.status).toBe(200);
    expect(dispatchMatchedPage).toHaveBeenCalled();
  });

  it("preserves Node route handler RSC URLs while hiding internal parsed params", async () => {
    // Ported from Next.js:
    // test/e2e/app-dir/front-redirect-issue/front-redirect-issue.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/front-redirect-issue/front-redirect-issue.test.ts
    //
    // The upstream fixture fallback-rewrites a front URL to an App route
    // handler. Next strips `_rsc` from the parsed query in base-server.ts, but
    // its Node request adapter rebuilds request.url from initURL and preserves
    // the original search string.
    const route = createPageRoute({
      isDynamic: true,
      page: null,
      pattern: "/api/app-redirect/:path",
      routeHandler: { GET: () => new Response("route") },
      routeSegments: ["api", "app-redirect", "[path]"],
    });
    const dispatchMatchedRouteHandler = vi.fn<DispatchMatchedRouteHandler>(
      async () => new Response("route", { status: 200 }),
    );
    const headers = createRscRequestHeaders({ mountedSlotsHeader: "slot:modal:/" });
    const rscUrl = await createRscRequestUrl("/docs/vercel-user?tab=latest", headers);
    const handler = createHandler({
      configHeaders: [],
      configRewrites: {
        beforeFiles: [],
        afterFiles: [],
        fallback: [{ source: "/:path*", destination: "/api/app-redirect/:path*" }],
      },
      dispatchMatchedRouteHandler,
      matchRoute: (pathname: string) =>
        pathname === "/api/app-redirect/vercel-user"
          ? {
              params: { path: "vercel-user" },
              route,
            }
          : null,
    });

    const response = await handler(new Request(`https://example.test${rscUrl}`, { headers }), null);

    expect(response.status).toBe(200);
    expect(dispatchMatchedRouteHandler).toHaveBeenCalledTimes(1);
    const dispatched = dispatchMatchedRouteHandler.mock.calls[0]?.[0];
    expect(dispatched).toEqual(
      expect.objectContaining({
        cleanPathname: "/api/app-redirect/vercel-user",
        params: { path: "vercel-user" },
        route,
      }),
    );
    const dispatchedUrl = new URL(dispatched?.request.url ?? "");
    expect(dispatchedUrl.pathname).toBe("/docs/vercel-user");
    expect(dispatchedUrl.searchParams.has("_rsc")).toBe(true);
    expect(dispatchedUrl.searchParams.get("tab")).toBe("latest");
    expect(dispatched?.searchParams.has("_rsc")).toBe(false);
  });

  it("normalizes edge route handler RSC URLs and hides internal params", async () => {
    // Next.js normalizes `.rsc` in web/adapter.ts before stripping internal
    // search params from the Edge NextRequest.
    const route = createPageRoute({
      page: null,
      pattern: "/api/inspect",
      routeHandler: { GET: () => new Response("route"), runtime: "edge" },
      routeSegments: ["api", "inspect"],
    });
    const dispatchMatchedRouteHandler = vi.fn<DispatchMatchedRouteHandler>(
      async () => new Response("route", { status: 200 }),
    );
    const headers = createRscRequestHeaders({ mountedSlotsHeader: "slot:modal:/" });
    const rscUrl = await createRscRequestUrl("/docs/api/inspect?tab=latest", headers);
    const handler = createHandler({
      configHeaders: [],
      dispatchMatchedRouteHandler,
      matchRoute: (pathname: string) =>
        pathname === "/api/inspect" ? { params: {}, route } : null,
    });

    const response = await handler(new Request(`https://example.test${rscUrl}`, { headers }), null);

    expect(response.status).toBe(200);
    const dispatched = dispatchMatchedRouteHandler.mock.calls[0]?.[0];
    const dispatchedUrl = new URL(dispatched?.request.url ?? "");
    expect(dispatchedUrl.pathname).toBe("/docs/api/inspect");
    expect(dispatchedUrl.search).toBe("?tab=latest");
    expect(dispatched?.searchParams.toString()).toBe("tab=latest");
  });

  it("preserves non-RSC route handler request URLs while hiding internal parsed params", async () => {
    const route = createPageRoute({
      page: null,
      pattern: "/api/inspect",
      routeHandler: { GET: () => new Response("route") },
      routeSegments: ["api", "inspect"],
    });
    const dispatchMatchedRouteHandler = vi.fn<DispatchMatchedRouteHandler>(
      async () => new Response("route", { status: 200 }),
    );
    const handler = createHandler({
      configHeaders: [],
      dispatchMatchedRouteHandler,
      matchRoute: (pathname: string) =>
        pathname === "/api/inspect" ? { params: {}, route } : null,
    });

    const response = await handler(
      new Request("https://example.test/docs/api/inspect?tab=latest&_rsc=user-value"),
      null,
    );

    expect(response.status).toBe(200);
    const dispatched = dispatchMatchedRouteHandler.mock.calls[0]?.[0];
    expect(new URL(dispatched?.request.url ?? "").search).toBe("?tab=latest&_rsc=user-value");
    expect(dispatched?.searchParams.toString()).toBe("tab=latest");
  });

  it("hides internal RSC params from non-RSC edge route handler request URLs", async () => {
    const route = createPageRoute({
      page: null,
      pattern: "/api/inspect",
      routeHandler: { GET: () => new Response("route"), runtime: "edge" },
      routeSegments: ["api", "inspect"],
    });
    const dispatchMatchedRouteHandler = vi.fn<DispatchMatchedRouteHandler>(
      async () => new Response("route", { status: 200 }),
    );
    const handler = createHandler({
      configHeaders: [],
      dispatchMatchedRouteHandler,
      matchRoute: (pathname: string) =>
        pathname === "/api/inspect" ? { params: {}, route } : null,
    });

    const response = await handler(
      new Request("https://example.test/docs/api/inspect?tab=latest&_rsc=user-value"),
      null,
    );

    expect(response.status).toBe(200);
    const dispatched = dispatchMatchedRouteHandler.mock.calls[0]?.[0];
    expect(new URL(dispatched?.request.url ?? "").search).toBe("?tab=latest");
    expect(dispatched?.searchParams.toString()).toBe("tab=latest");
  });

  it.each([
    { name: "Node", runtime: undefined },
    { name: "Edge", runtime: "edge" },
  ])("preserves Workers cf metadata for $name route handlers", async ({ runtime }) => {
    const route = createPageRoute({
      page: null,
      pattern: "/api/inspect",
      routeHandler: { GET: () => new Response("route"), runtime },
      routeSegments: ["api", "inspect"],
    });
    const dispatchMatchedRouteHandler = vi.fn<DispatchMatchedRouteHandler>(
      async () => new Response("route", { status: 200 }),
    );
    const handler = createHandler({
      configHeaders: [],
      dispatchMatchedRouteHandler,
      matchRoute: (pathname: string) =>
        pathname === "/api/inspect" ? { params: {}, route } : null,
    });
    const request = new Request("https://example.test/docs/api/inspect");
    const cf = { country: "AU" };
    Object.defineProperty(request, "cf", { value: cf, enumerable: true });

    const response = await handler(request, null);

    expect(response.status).toBe(200);
    const dispatched = dispatchMatchedRouteHandler.mock.calls[0]?.[0];
    expect(Reflect.get(dispatched!.request, "cf")).toBe(cf);
  });

  it("serves full-route RSC payloads at HTML URLs marked by RSC header alone", async () => {
    // Ported from Next.js:
    // test/e2e/app-dir/ppr-root-param-rsc-fallback/ppr-root-param-rsc-fallback.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/ppr-root-param-rsc-fallback/ppr-root-param-rsc-fallback.test.ts
    const dispatchMatchedPage = vi.fn(async ({ isRscRequest }) =>
      isRscRequest
        ? new Response("flight", { status: 200, headers: { "content-type": "text/x-component" } })
        : new Response("<!DOCTYPE html><html>document</html>", {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" },
          }),
    );
    const handler = createHandler({
      configHeaders: [],
      dispatchMatchedPage,
    });

    const response = await handler(
      new Request("https://example.test/docs/about", {
        headers: { [RSC_HEADER]: "1" },
      }),
      null,
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("/docs/about?_rsc");
    expect(dispatchMatchedPage).not.toHaveBeenCalled();

    const followedResponse = await handler(
      new Request(`https://example.test${response.headers.get("location")}`, {
        headers: { [RSC_HEADER]: "1" },
      }),
      null,
    );

    expect(followedResponse.status).toBe(200);
    expect(followedResponse.headers.get("content-type")).toContain("text/x-component");
    await expect(followedResponse.text()).resolves.not.toContain("<!DOCTYPE html>");
    expect(dispatchMatchedPage).toHaveBeenCalledWith(
      expect.objectContaining({
        cleanPathname: "/about",
        isRscRequest: true,
      }),
    );
  });

  it("serves full-route RSC payloads at cache-separated HTML URLs marked by RSC header", async () => {
    const dispatchMatchedPage = vi.fn(async ({ isRscRequest }) =>
      isRscRequest
        ? new Response("flight", { status: 200, headers: { "content-type": "text/x-component" } })
        : new Response("<!DOCTYPE html><html>document</html>", {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" },
          }),
    );
    const handler = createHandler({
      configHeaders: [],
      dispatchMatchedPage,
    });

    const response = await handler(
      new Request("https://example.test/docs/about?_rsc", {
        headers: { [RSC_HEADER]: "1" },
      }),
      null,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/x-component");
    await expect(response.text()).resolves.not.toContain("<!DOCTYPE html>");
    expect(dispatchMatchedPage).toHaveBeenCalledWith(
      expect.objectContaining({
        cleanPathname: "/about",
        isRscRequest: true,
      }),
    );
  });

  it("passes parsed ClientReuseManifest hints from canonical RSC requests to page dispatch", async () => {
    const dispatchMatchedPage = vi.fn(async () => new Response("page", { status: 200 }));
    const manifest = createClientReuseManifest({
      entries: [
        {
          artifactCompatibility: createArtifactCompatibilityEnvelope(),
          id: "layout:/",
          payloadHash: createClientReusePayloadHash("root-layout"),
          privacy: "public",
          variantCacheKey: "cp1:root",
        },
      ],
      visibleCommitVersion: 1,
    });
    const handler = createHandler({
      configHeaders: [],
      dispatchMatchedPage,
    });

    const response = await handler(
      new Request("https://example.test/docs/about.rsc", {
        headers: {
          [VINEXT_CLIENT_REUSE_MANIFEST_HEADER]: JSON.stringify(manifest),
        },
      }),
      null,
    );

    expect(response.status).toBe(200);
    expect(dispatchMatchedPage).toHaveBeenCalledWith(
      expect.objectContaining({
        clientReuseManifest: expect.objectContaining({
          kind: "parsed",
        }),
        isRscRequest: true,
      }),
    );
  });

  it("strips internal RSC cache-busting params before setting navigation context", async () => {
    const setNavigationContext = vi.fn();
    const headers = createRscRequestHeaders();
    const rscUrl = await createRscRequestUrl("/docs/about?tab=latest", headers);
    const handler = createHandler({
      configHeaders: [],
      setNavigationContext,
    });

    const response = await handler(new Request(`https://example.test${rscUrl}`, { headers }), null);

    expect(response.status).toBe(200);
    expect(setNavigationContext).toHaveBeenLastCalledWith(
      expect.objectContaining({
        pathname: "/about",
        params: {},
      }),
    );
    const context = setNavigationContext.mock.lastCall?.[0];
    expect(context?.searchParams.get("tab")).toBe("latest");
    expect(context?.searchParams.has("_rsc")).toBe(false);
  });

  it("preserves beforeFiles destination query while stripping the RSC cache key", async () => {
    const headers = createRscRequestHeaders();
    const rscUrl = await createRscRequestUrl("/docs/legacy?original=1", headers);
    let pageOptions: Parameters<HandlerOptions["dispatchMatchedPage"]>[0] | undefined;
    const handler = createHandler({
      configHeaders: [],
      configRewrites: {
        beforeFiles: [{ source: "/legacy", destination: "/about?destination=2" }],
        afterFiles: [],
        fallback: [],
      },
      dispatchMatchedPage: async (options) => {
        pageOptions = options;
        return new Response("page");
      },
    });

    await handler(new Request(`https://example.test${rscUrl}`, { headers }), null);

    expect(Object.fromEntries(pageOptions!.searchParams)).toEqual({
      destination: "2",
      original: "1",
    });
  });

  it("runs beforeFiles rewrites before route matching", async () => {
    const matchRoute = vi.fn((pathname: string) =>
      pathname === "/about"
        ? {
            params: {},
            route: createPageRoute(),
          }
        : null,
    );
    const dispatchMatchedPage = vi.fn(
      async (_options: Parameters<HandlerOptions["dispatchMatchedPage"]>[0]) =>
        new Response("rewritten", { status: 200 }),
    );
    const handler = createHandler({
      configHeaders: [],
      configRewrites: {
        beforeFiles: [{ source: "/alias", destination: "/about" }],
        afterFiles: [],
        fallback: [],
      },
      dispatchMatchedPage,
      matchRoute,
    });

    const response = await handler(new Request("https://example.test/docs/alias"), null);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("rewritten");
    expect(matchRoute).toHaveBeenLastCalledWith("/about");
    expect(dispatchMatchedPage).toHaveBeenCalledWith(
      expect.objectContaining({ cleanPathname: "/about" }),
    );
  });

  it("does not match config rewrites through percent-encoded literal aliases", async () => {
    const dispatchMatchedPage = vi.fn(async () => new Response("page", { status: 200 }));
    const handler = createHandler({
      configHeaders: [],
      configRewrites: {
        beforeFiles: [{ source: "/alias", destination: "/about" }],
        afterFiles: [],
        fallback: [],
      },
      dispatchMatchedPage,
    });

    const response = await handler(new Request("https://example.test/docs/%61lias"), null);

    expect(response.status).toBe(404);
    expect(dispatchMatchedPage).not.toHaveBeenCalled();
  });

  it("propagates rewritten query parameters to App pages", async () => {
    const setNavigationContext = vi.fn();
    let pageOptions: Parameters<HandlerOptions["dispatchMatchedPage"]>[0] | undefined;
    const dispatchMatchedPage = vi.fn(
      async (options: Parameters<HandlerOptions["dispatchMatchedPage"]>[0]) => {
        pageOptions = options;
        return new Response("rewritten", { status: 200 });
      },
    );
    const handler = createHandler({
      configHeaders: [],
      configRewrites: {
        beforeFiles: [{ source: "/legacy", destination: "/about?destination=2&same=new" }],
        afterFiles: [],
        fallback: [],
      },
      dispatchMatchedPage,
      setNavigationContext,
    });

    await handler(new Request("https://example.test/docs/legacy?original=1&same=old"), null);

    expect(Object.fromEntries(pageOptions!.searchParams)).toEqual({
      destination: "2",
      original: "1",
      same: "new",
    });
    expect(Object.fromEntries(setNavigationContext.mock.lastCall![0].searchParams)).toEqual({
      destination: "2",
      original: "1",
      same: "new",
    });
  });

  it("applies sequential beforeFiles rewrites with accumulated query conditions", async () => {
    let pageOptions: Parameters<HandlerOptions["dispatchMatchedPage"]>[0] | undefined;
    const handler = createHandler({
      configHeaders: [],
      configRewrites: {
        beforeFiles: [
          { source: "/source", destination: "/intermediate?preview=1" },
          {
            source: "/intermediate",
            destination: "/about?destination=2",
            has: [{ type: "query", key: "preview", value: "1" }],
          },
        ],
        afterFiles: [],
        fallback: [],
      },
      dispatchMatchedPage: async (options) => {
        pageOptions = options;
        return new Response("page");
      },
    });

    await handler(new Request("https://example.test/docs/source?original=1"), null);

    expect(Object.fromEntries(pageOptions!.searchParams)).toEqual({
      destination: "2",
      original: "1",
      preview: "1",
    });
  });

  it("exposes unused rewrite source params through App searchParams", async () => {
    let pageOptions: Parameters<HandlerOptions["dispatchMatchedPage"]>[0] | undefined;
    const handler = createHandler({
      configHeaders: [],
      configRewrites: {
        beforeFiles: [
          {
            source: "/source/:section/:name",
            destination: "/about?first=:section&second=:name",
          },
        ],
        afterFiles: [],
        fallback: [],
      },
      dispatchMatchedPage: async (options) => {
        pageOptions = options;
        return new Response("page");
      },
    });

    await handler(new Request("https://example.test/docs/source/hello/world"), null);

    expect(Object.fromEntries(pageOptions!.searchParams)).toEqual({
      first: "hello",
      name: "world",
      second: "world",
      section: "hello",
    });
  });

  it.each(["afterFiles", "fallback"] as const)(
    "continues through unmatched %s rewrite destinations",
    async (rewritePhase) => {
      const handler = createHandler({
        configHeaders: [],
        configRewrites: {
          beforeFiles: [],
          afterFiles:
            rewritePhase === "afterFiles"
              ? [
                  { source: "/source", destination: "/intermediate" },
                  { source: "/intermediate", destination: "/about" },
                ]
              : [],
          fallback:
            rewritePhase === "fallback"
              ? [
                  { source: "/source", destination: "/intermediate" },
                  { source: "/intermediate", destination: "/about" },
                ]
              : [],
        },
        matchRoute: (pathname) =>
          pathname === "/about" ? { params: {}, route: createPageRoute() } : null,
      });

      const response = await handler(new Request("https://example.test/docs/source"), null);

      expect(response.status).toBe(200);
    },
  );

  it.each(["beforeFiles", "fallback"] as const)(
    "propagates %s rewrite query parameters to App route handlers",
    async (rewritePhase) => {
      const route = createPageRoute({
        page: null,
        pattern: "/api/static",
        routeHandler: { GET: () => new Response("route") },
        routeSegments: ["api", "static"],
      });
      const dispatchMatchedRouteHandler = vi.fn(
        async (_options: Parameters<HandlerOptions["dispatchMatchedRouteHandler"]>[0]) =>
          new Response("route"),
      );
      const rewrite = { source: "/legacy", destination: "/api/static?destination=2&same=new" };
      const handler = createHandler({
        configHeaders: [],
        configRewrites: {
          beforeFiles: rewritePhase === "beforeFiles" ? [rewrite] : [],
          afterFiles: [],
          fallback: rewritePhase === "fallback" ? [rewrite] : [],
        },
        dispatchMatchedRouteHandler,
        matchRoute: (pathname) => (pathname === "/api/static" ? { params: {}, route } : null),
      });

      await handler(new Request("https://example.test/docs/legacy?original=1&same=old"), null);

      const routeHandlerOptions = dispatchMatchedRouteHandler.mock.lastCall?.[0];
      expect(Object.fromEntries(routeHandlerOptions!.searchParams)).toEqual({
        destination: "2",
        original: "1",
        same: "new",
      });
      expect(new URL(routeHandlerOptions!.request.url).pathname).toBe("/docs/legacy");
      expect(Object.fromEntries(new URL(routeHandlerOptions!.request.url).searchParams)).toEqual({
        destination: "2",
        original: "1",
        same: "new",
      });
    },
  );

  it("does not let afterFiles rewrites override non-dynamic app routes", async () => {
    const routes = {
      "/about": createPageRoute({ pattern: "/about", routeSegments: ["about"] }),
      "/nav": createPageRoute({ pattern: "/nav", routeSegments: ["nav"] }),
    };
    const dispatchMatchedPage = vi.fn(
      async ({ route }) => new Response(`page:${route.pattern}`, { status: 200 }),
    );
    const handler = createHandler({
      configHeaders: [],
      configRewrites: {
        beforeFiles: [],
        afterFiles: [{ source: "/nav", destination: "/about" }],
        fallback: [],
      },
      dispatchMatchedPage,
      matchRoute: (pathname: string) => {
        if (pathname === "/about") return { params: {}, route: routes["/about"] };
        if (pathname === "/nav") return { params: {}, route: routes["/nav"] };
        return null;
      },
    });

    const response = await handler(new Request("https://example.test/docs/nav"), null);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("page:/nav");
    expect(dispatchMatchedPage).toHaveBeenCalledWith(
      expect.objectContaining({ cleanPathname: "/nav", route: routes["/nav"] }),
    );
  });

  it("runs afterFiles rewrites before dynamic app route matching", async () => {
    const routes = {
      "/about": createPageRoute({ pattern: "/about", routeSegments: ["about"] }),
      dynamicBlog: createPageRoute({
        isDynamic: true,
        pattern: "/blog/:slug",
        routeSegments: ["blog", "[slug]"],
      }),
    };
    const dispatchMatchedPage = vi.fn(
      async ({ route }) => new Response(`page:${route.pattern}`, { status: 200 }),
    );
    const emptyParams: Record<string, string | string[]> = {};
    const legacyParams: Record<string, string | string[]> = { slug: "legacy" };
    const matchRoute: HandlerOptions["matchRoute"] = (pathname) => {
      if (pathname === "/about") return { params: emptyParams, route: routes["/about"] };
      if (pathname === "/blog/legacy") {
        return { params: legacyParams, route: routes.dynamicBlog };
      }
      return null;
    };
    const handler = createHandler({
      configHeaders: [],
      configRewrites: {
        beforeFiles: [],
        afterFiles: [{ source: "/blog/legacy", destination: "/about" }],
        fallback: [],
      },
      dispatchMatchedPage,
      matchRoute,
    });

    const response = await handler(new Request("https://example.test/docs/blog/legacy"), null);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("page:/about");
    expect(dispatchMatchedPage).toHaveBeenCalledWith(
      expect.objectContaining({ cleanPathname: "/about", route: routes["/about"] }),
    );
  });

  it.each([
    { label: "context-only requests", interceptionId: null, expectedStatus: 200 },
    {
      label: "selector-bearing requests",
      interceptionId: "interception:slot:modal:/feed:/feed->/blog/:slug",
      expectedStatus: 400,
    },
  ])(
    "revalidates interception proof after afterFiles rewrites for $label",
    async ({ expectedStatus, interceptionId }) => {
      const routes = {
        about: createPageRoute({ pattern: "/about", routeSegments: ["about"] }),
        blog: createPageRoute({
          isDynamic: true,
          pattern: "/blog/:slug",
          routeSegments: ["blog", "[slug]"],
        }),
        feed: createPageRoute({ pattern: "/feed", routeSegments: ["feed"] }),
      };
      const matchInterceptRoute = vi.fn(
        (pathname: string, sourcePathname: string, requestedId?: string | null) =>
          pathname === "/blog/legacy" &&
          sourcePathname === "/feed" &&
          requestedId === interceptionId
            ? { interceptionSourceIsConcrete: true, params: {}, route: routes.feed }
            : null,
      );
      const dispatchMatchedPage = vi.fn(
        async () =>
          new Response("page", {
            headers: { "Cache-Control": "public, max-age=3600" },
          }),
      );
      const emptyParams: Record<string, string | string[]> = {};
      const blogParams: Record<string, string | string[]> = { slug: "legacy" };
      const matchRoute: HandlerOptions["matchRoute"] = (pathname) => {
        if (pathname === "/about") return { params: emptyParams, route: routes.about };
        if (pathname === "/blog/legacy") {
          return { params: blogParams, route: routes.blog };
        }
        return null;
      };
      const handler = createHandler({
        configHeaders: [],
        configRewrites: {
          beforeFiles: [],
          afterFiles: [{ source: "/blog/legacy", destination: "/about" }],
          fallback: [],
        },
        dispatchMatchedPage,
        hasInterceptionId: (requestedId) => requestedId === interceptionId,
        matchInterceptRoute,
        matchRoute,
      });
      const headers = createRscRequestHeaders({
        interceptionContext: "/feed",
        interceptionId,
      });
      const rscUrl = await createRscRequestUrl("/docs/blog/legacy", headers);

      const response = await handler(
        new Request(`https://example.test${rscUrl}`, { headers }),
        null,
      );

      expect(response.status).toBe(expectedStatus);
      expect(response.headers.get("cache-control")).toBe(
        "private, no-cache, no-store, max-age=0, must-revalidate",
      );
      expect(matchInterceptRoute).toHaveBeenCalledWith("/about", "/feed", interceptionId);
      if (interceptionId === null) {
        expect(dispatchMatchedPage).toHaveBeenCalledWith(
          expect.objectContaining({
            bypassInterceptionContextCache: true,
            cleanPathname: "/about",
          }),
        );
      } else {
        expect(dispatchMatchedPage).not.toHaveBeenCalled();
      }
    },
  );

  it.each([
    {
      expectedBypass: true,
      expectedCacheControl: "private, no-cache, no-store, max-age=0, must-revalidate",
      expectedMiddlewarePaths: ["/blog/legacy"],
      initialSourceMatch: false,
      label: "newly discovered sources",
    },
    {
      expectedBypass: false,
      expectedCacheControl: "public, max-age=3600",
      expectedMiddlewarePaths: ["/blog/legacy", "/feed"],
      initialSourceMatch: true,
      label: "previously authorized sources",
    },
  ])(
    "restores cacheability after late rewrites only for $label",
    async ({
      expectedBypass,
      expectedCacheControl,
      expectedMiddlewarePaths,
      initialSourceMatch,
    }) => {
      const routes = {
        about: createPageRoute({ pattern: "/about", routeSegments: ["about"] }),
        blog: createPageRoute({
          isDynamic: true,
          pattern: "/blog/:slug",
          routeSegments: ["blog", "[slug]"],
        }),
        feed: createPageRoute({ pattern: "/feed", routeSegments: ["feed"] }),
      };
      const matchInterceptRoute = vi.fn((pathname: string, sourcePathname: string) =>
        sourcePathname === "/feed" && (pathname === "/about" || initialSourceMatch)
          ? { interceptionSourceIsConcrete: true, params: {}, route: routes.feed }
          : null,
      );
      const middlewarePaths: string[] = [];
      const dispatchMatchedPage = vi.fn(
        async () =>
          new Response("page", {
            headers: { "Cache-Control": "public, max-age=3600" },
          }),
      );
      const emptyParams: Record<string, string | string[]> = {};
      const blogParams: Record<string, string | string[]> = { slug: "legacy" };
      const matchRoute: HandlerOptions["matchRoute"] = (pathname) => {
        if (pathname === "/about") return { params: emptyParams, route: routes.about };
        if (pathname === "/blog/legacy") {
          return { params: blogParams, route: routes.blog };
        }
        return null;
      };
      const handler = createHandler({
        configHeaders: [],
        configRewrites: {
          beforeFiles: [],
          afterFiles: [{ source: "/blog/legacy", destination: "/about" }],
          fallback: [],
        },
        dispatchMatchedPage,
        matchInterceptRoute,
        matchRoute,
        async runMiddleware({ cleanPathname }) {
          middlewarePaths.push(cleanPathname);
          return { kind: "continue", cleanPathname, rewritten: false, search: null };
        },
      });
      const headers = createRscRequestHeaders({ interceptionContext: "/feed" });
      const rscUrl = await createRscRequestUrl("/docs/blog/legacy", headers);

      const response = await handler(
        new Request(`https://example.test${rscUrl}`, { headers }),
        null,
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe(expectedCacheControl);
      expect(middlewarePaths).toEqual(expectedMiddlewarePaths);
      expect(dispatchMatchedPage).toHaveBeenCalledWith(
        expect.objectContaining({
          bypassInterceptionContextCache: expectedBypass,
          cleanPathname: "/about",
        }),
      );
    },
  );

  it("lets a static Pages route win before afterFiles rewrites", async () => {
    const dynamicRoute = createPageRoute({
      isDynamic: true,
      pattern: "/:path+",
      routeSegments: ["[...path]"],
    });
    const renderPagesFallback = vi.fn(async () => new Response("pages:/about", { status: 200 }));
    const handler = createHandler({
      configHeaders: [],
      configRewrites: {
        beforeFiles: [],
        afterFiles: [{ source: "/about", destination: "/rewritten" }],
        fallback: [],
      },
      matchRoute: () => ({ params: { path: ["about"] }, route: dynamicRoute }),
      renderPagesFallback,
    });

    const response = await handler(new Request("https://example.test/docs/about"), null);

    expect(await response.text()).toBe("pages:/about");
    expect(renderPagesFallback).toHaveBeenCalledWith(
      expect.objectContaining({
        matchKind: "static",
        pathname: "/about",
        appRouteMatch: expect.objectContaining({ route: dynamicRoute }),
      }),
    );
  });

  it("normalizes hybrid Pages data requests before middleware", async () => {
    let middlewarePathname: string | null = null;
    let middlewareIsData: boolean | undefined;
    let middlewareCf: unknown;
    let pagesDataCf: unknown;
    let pagesDataUrl: string | null = null;
    const renderPagesFallback = vi.fn(async (_options: unknown) => new Response("pages-data"));
    const handler = createHandler({
      configHeaders: [],
      matchRoute: () => null,
      middlewareModule: {
        default: (request: Request) => {
          middlewarePathname = new URL(request.url).pathname;
          middlewareIsData = (request as Request & { __isData?: boolean }).__isData;
          middlewareCf = (request as Request & { cf?: unknown }).cf;
          return new Response(null, { headers: { "x-middleware-next": "1" } });
        },
      },
      renderPagesFallback: async (options) => {
        pagesDataCf = (options.pagesDataRequest as (Request & { cf?: unknown }) | null)?.cf;
        pagesDataUrl = options.pagesDataRequest?.url ?? null;
        return renderPagesFallback(options);
      },
    });

    const request = new Request(
      "https://example.test/docs/_next/data/build-id/form-search.json?query=basic",
    );
    const cf = { colo: "LHR" };
    Object.defineProperty(request, "cf", { value: cf, enumerable: true });
    const response = await handler(request, null);

    expect(await response.text()).toBe("pages-data");
    expect(middlewarePathname).toBe("/docs/form-search");
    expect(middlewareIsData).toBe(true);
    expect(middlewareCf).toBe(cf);
    expect(pagesDataCf).toBe(cf);
    expect(pagesDataUrl).toBe(
      "https://example.test/_next/data/build-id/form-search.json?query=basic",
    );
    expect(renderPagesFallback).toHaveBeenCalledWith(
      expect.objectContaining({
        pathname: "/form-search?query=basic",
        pagesDataRequest: expect.any(Request),
      }),
    );
  });

  it("does not expose forged data headers to App Router middleware", async () => {
    let middlewareIsData: boolean | undefined;
    const handler = createHandler({
      middlewareModule: {
        default: (request: Request) => {
          middlewareIsData = (request as Request & { __isData?: boolean }).__isData;
          return new Response(null, { headers: { "x-middleware-next": "1" } });
        },
      },
    });

    const response = await handler(
      new Request("https://example.test/docs/about", {
        headers: { "x-nextjs-data": "1" },
      }),
      null,
    );

    expect(response.status).toBe(200);
    expect(middlewareIsData).toBeUndefined();
  });

  it("exposes the rewritten route on hybrid Pages data responses", async () => {
    const renderPagesFallback = vi.fn(
      async () =>
        new Response('{"pageProps":{"query":"basic"}}', {
          headers: { "content-type": "application/json" },
        }),
    );
    const handler = createHandler({
      configHeaders: [],
      configRewrites: {
        beforeFiles: [{ source: "/form-search", destination: "/rewritten-search" }],
        afterFiles: [],
        fallback: [],
      },
      matchRoute: () => null,
      renderPagesFallback,
    });

    const response = await handler(
      new Request("https://example.test/docs/_next/data/build-id/form-search.json?query=basic"),
      null,
    );

    expect(response.headers.get("x-nextjs-rewrite")).toBe("/rewritten-search?query=basic");
    expect(renderPagesFallback).toHaveBeenCalledWith(
      expect.objectContaining({
        pathname: "/rewritten-search?query=basic",
        pagesDataRequest: expect.any(Request),
      }),
    );
  });

  it("exposes middleware rewrites from Pages data requests to App routes", async () => {
    // Ported from Next.js: test/e2e/app-dir/app/index.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/app/index.test.ts
    // "rewrites should support rewrites on client-side navigation from pages to app with existing pages path"
    const clearRequestContext = vi.fn();
    const dispatchMatchedPage = vi.fn(async () => new Response("app"));
    const renderPagesFallback = vi.fn(async () => new Response("pages"));
    const handler = createHandler({
      clearRequestContext,
      configHeaders: [],
      dispatchMatchedPage,
      matchRoute: (pathname: string) =>
        pathname === "/about"
          ? {
              params: {},
              route: createPageRoute({ pattern: "/about", routeSegments: ["about"] }),
            }
          : null,
      middlewareModule: {
        default: (request: NextRequest) => {
          if (request.nextUrl.pathname === "/exists-but-not-routed") {
            return new Response(null, {
              headers: {
                "set-cookie": "probe=1; Path=/",
                "x-test-header": "middleware",
                "x-middleware-rewrite": new URL("/about", request.url).toString(),
              },
            });
          }
          return undefined;
        },
      },
      renderPagesFallback,
    });

    const response = await handler(
      new Request("https://example.test/docs/_next/data/build-id/exists-but-not-routed.json", {
        headers: { "x-nextjs-data": "1" },
      }),
      null,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("x-nextjs-rewrite")).toBe("/about");
    expect(response.headers.get("x-test-header")).toBe("middleware");
    expect(response.headers.get("set-cookie")).toBe("probe=1; Path=/");
    expect(response.headers.get("x-middleware-rewrite")).toBeNull();
    expect(await response.text()).toBe("{}");
    expect(dispatchMatchedPage).not.toHaveBeenCalled();
    expect(renderPagesFallback).not.toHaveBeenCalled();
    expect(clearRequestContext).toHaveBeenCalled();
  });

  it("lets a concrete Pages route win a middleware rewrite over a dynamic App match", async () => {
    // A dynamic App match does not own the rewrite target: the Pages route is
    // more specific, so its data (here a getServerSideProps redirect) must be
    // rendered rather than short-circuited into an empty rewrite response.
    const renderPagesFallback = vi.fn(
      async () =>
        new Response(JSON.stringify({ pageProps: { __N_REDIRECT: "/login" } }), {
          headers: { "content-type": "application/json" },
        }),
    );
    const handler = createHandler({
      configHeaders: [],
      matchRoute: (pathname: string) =>
        pathname === "/protected"
          ? {
              params: { slug: ["protected"] },
              route: createPageRoute({
                isDynamic: true,
                pattern: "/[...slug]",
                routeSegments: ["[...slug]"],
              }),
            }
          : null,
      middlewareModule: {
        default: (request: NextRequest) =>
          request.nextUrl.pathname === "/source"
            ? new Response(null, {
                headers: { "x-middleware-rewrite": new URL("/protected", request.url).toString() },
              })
            : undefined,
      },
      renderPagesFallback,
    });

    const response = await handler(
      new Request("https://example.test/docs/_next/data/build-id/source.json", {
        headers: { "x-nextjs-data": "1" },
      }),
      null,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-nextjs-rewrite")).toBe("/protected");
    expect(await response.json()).toEqual({ pageProps: { __N_REDIRECT: "/login" } });
    expect(renderPagesFallback).toHaveBeenCalled();
  });

  it("keeps middleware response headers when a rewrite lands on a dynamic App route", async () => {
    // No Pages route claims the target, so the App match legitimately owns it.
    // The response still has to carry cookies the middleware set on the way.
    const handler = createHandler({
      configHeaders: [],
      matchRoute: (pathname: string) =>
        pathname === "/app-only"
          ? {
              params: { slug: ["app-only"] },
              route: createPageRoute({
                isDynamic: true,
                pattern: "/[...slug]",
                routeSegments: ["[...slug]"],
              }),
            }
          : null,
      middlewareModule: {
        default: (request: NextRequest) =>
          request.nextUrl.pathname === "/source"
            ? new Response(null, {
                headers: {
                  "set-cookie": "probe=1; Path=/",
                  "x-test-header": "middleware",
                  "x-middleware-rewrite": new URL("/app-only", request.url).toString(),
                },
              })
            : undefined,
      },
      renderPagesFallback: vi.fn(async () => null),
    });

    const response = await handler(
      new Request("https://example.test/docs/_next/data/build-id/source.json", {
        headers: { "x-nextjs-data": "1" },
      }),
      null,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-nextjs-rewrite")).toBe("/app-only");
    expect(response.headers.get("set-cookie")).toBe("probe=1; Path=/");
    expect(response.headers.get("x-test-header")).toBe("middleware");
    expect(response.headers.get("x-middleware-rewrite")).toBeNull();
    expect(await response.text()).toBe("{}");
  });

  it.each([
    { convention: "middleware", isProxy: false },
    { convention: "proxy", isProxy: true },
  ])(
    "exposes $convention rewrites to App routes on hybrid Pages data responses",
    async ({ isProxy }) => {
      const dispatchMatchedPage = vi.fn(async () => new Response("page"));
      const renderPagesFallback = vi.fn(async () => new Response("pages-data"));
      const handler = createHandler({
        configHeaders: [],
        dispatchMatchedPage,
        isMiddlewareProxy: isProxy,
        middlewareModule: {
          default: (request: Request) =>
            new Response(null, {
              headers: {
                "x-middleware-rewrite": new URL("/docs/about", request.url).toString(),
              },
            }),
        },
        renderPagesFallback,
      });

      const response = await handler(
        new Request("https://example.test/docs/_next/data/build-id/rewrite-to-app.json"),
        null,
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(response.headers.get("x-nextjs-rewrite")).toBe("/about");
      expect(await response.text()).toBe("{}");
      expect(dispatchMatchedPage).not.toHaveBeenCalled();
      expect(renderPagesFallback).not.toHaveBeenCalled();
    },
  );

  it("uses the soft redirect protocol for URL-recognized Pages data requests", async () => {
    const handler = createHandler({
      configHeaders: [],
      matchRoute: () => null,
      middlewareModule: {
        default: () => new Response(null, { status: 307, headers: { Location: "/login" } }),
      },
      renderPagesFallback: async () => new Response("pages-data"),
    });

    const response = await handler(
      new Request("https://example.test/docs/_next/data/build-id/form-search.json"),
      null,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("x-nextjs-redirect")).toBe("/login");
  });

  it("returns JSON 404 for stale hybrid Pages data requests before middleware", async () => {
    const middleware = vi.fn(() => new Response(null, { headers: { "x-middleware-next": "1" } }));
    const renderPagesFallback = vi.fn(async () => new Response("pages-data"));
    const handler = createHandler({
      configHeaders: [],
      matchRoute: () => null,
      middlewareModule: { default: middleware },
      renderPagesFallback,
    });

    const response = await handler(
      new Request("https://example.test/docs/_next/data/stale/form-search.json?query=basic"),
      null,
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.text()).toBe("{}");
    expect(middleware).not.toHaveBeenCalled();
    expect(renderPagesFallback).not.toHaveBeenCalled();
  });

  it("returns middleware-enabled Pages data misses with the requested matched path", async () => {
    const handler = createHandler({
      configHeaders: [],
      matchRoute: () => null,
      middlewareModule: {
        default: () => new Response(null, { headers: { "x-middleware-next": "1" } }),
      },
      renderPagesFallback: async () => null,
    });

    const response = await handler(
      new Request("https://example.test/docs/_next/data/build-id/missing.json"),
      null,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("x-nextjs-matched-path")).toBe("/missing");
    expect(await response.text()).toBe("{}");
  });

  it("does not normalize hybrid Pages data requests outside basePath", async () => {
    const renderPagesFallback = vi.fn(async () => new Response("pages-data"));
    const handler = createHandler({
      configHeaders: [],
      matchRoute: () => null,
      renderPagesFallback,
    });

    const response = await handler(
      new Request("https://example.test/_next/data/build-id/form-search.json?query=basic"),
      null,
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).not.toContain("application/json");
    expect(renderPagesFallback).not.toHaveBeenCalled();
  });

  it("returns JSON 404 when an App route owns a Pages data URL", async () => {
    const appRoute = createPageRoute({ pattern: "/app-only" });
    const dispatchMatchedPage = vi.fn(async () => new Response("app-html"));
    const renderPagesFallback = vi.fn(async () => null);
    const handler = createHandler({
      configHeaders: [],
      dispatchMatchedPage,
      matchRoute: (pathname) => (pathname === "/app-only" ? { route: appRoute, params: {} } : null),
      renderPagesFallback,
    });

    const response = await handler(
      new Request("https://example.test/docs/_next/data/build-id/app-only.json"),
      null,
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.text()).toBe("{}");
    expect(renderPagesFallback).not.toHaveBeenCalled();
    expect(dispatchMatchedPage).not.toHaveBeenCalled();
  });

  it("runs afterFiles rewrites before dynamic Pages route ownership", async () => {
    const appDynamicRoute = createPageRoute({
      isDynamic: true,
      pattern: "/:slug",
      routeSegments: ["[slug]"],
    });
    const appDestinationRoute = createPageRoute({
      pattern: "/destination",
      routeSegments: ["destination"],
    });
    const renderPagesFallback = vi.fn(async ({ matchKind }) =>
      matchKind === "dynamic" ? new Response("pages-dynamic", { status: 200 }) : null,
    );
    const dispatchMatchedPage = vi.fn(
      async ({ route }) => new Response(`app:${route.pattern}`, { status: 200 }),
    );
    const handler = createHandler({
      configHeaders: [],
      configRewrites: {
        beforeFiles: [],
        afterFiles: [{ source: "/legacy", destination: "/destination" }],
        fallback: [],
      },
      dispatchMatchedPage,
      matchRoute: (pathname): ReturnType<HandlerOptions["matchRoute"]> => {
        if (pathname === "/legacy") {
          return { params: { slug: "legacy" }, route: appDynamicRoute };
        }
        if (pathname === "/destination") return { params: {}, route: appDestinationRoute };
        return null;
      },
      renderPagesFallback,
    });

    const response = await handler(new Request("https://example.test/docs/legacy"), null);

    expect(await response.text()).toBe("app:/destination");
    expect(renderPagesFallback).toHaveBeenCalledWith(
      expect.objectContaining({ matchKind: "static", pathname: "/legacy" }),
    );
    expect(renderPagesFallback).not.toHaveBeenCalledWith(
      expect.objectContaining({ matchKind: "dynamic", pathname: "/legacy" }),
    );
  });

  it("rechecks static Pages routes after an afterFiles rewrite", async () => {
    const renderPagesFallback = vi.fn(async ({ matchKind, pathname }) =>
      matchKind === "static" && pathname === "/pages-static"
        ? new Response("pages-static", { status: 200 })
        : null,
    );
    const handler = createHandler({
      configHeaders: [],
      configRewrites: {
        beforeFiles: [],
        afterFiles: [{ source: "/legacy", destination: "/pages-static" }],
        fallback: [],
      },
      matchRoute: () => null,
      renderPagesFallback,
    });

    const response = await handler(new Request("https://example.test/docs/legacy"), null);

    expect(await response.text()).toBe("pages-static");
  });

  it("rechecks static and dynamic Pages routes after a fallback rewrite", async () => {
    const renderPagesFallback = vi.fn(async ({ matchKind, pathname }) =>
      pathname === "/pages-dynamic" && matchKind === "dynamic"
        ? new Response("pages-dynamic", { status: 200 })
        : null,
    );
    const handler = createHandler({
      configHeaders: [],
      configRewrites: {
        beforeFiles: [],
        afterFiles: [],
        fallback: [{ source: "/legacy", destination: "/pages-dynamic" }],
      },
      matchRoute: () => null,
      renderPagesFallback,
    });

    const response = await handler(new Request("https://example.test/docs/legacy"), null);

    expect(await response.text()).toBe("pages-dynamic");
    expect(renderPagesFallback).toHaveBeenCalledWith(
      expect.objectContaining({ matchKind: "static", pathname: "/pages-dynamic" }),
    );
    expect(renderPagesFallback).toHaveBeenCalledWith(
      expect.objectContaining({ matchKind: "dynamic", pathname: "/pages-dynamic" }),
    );
  });

  it.each(["beforeFiles", "afterFiles", "fallback"] as const)(
    "preserves and overrides query parameters for %s rewrites to Pages routes",
    async (rewritePhase) => {
      const renderPagesFallback = vi.fn(async ({ pathname }) =>
        pathname.startsWith("/pages?") ? new Response("pages", { status: 200 }) : null,
      );
      const handler = createHandler({
        configHeaders: [],
        configRewrites: {
          beforeFiles:
            rewritePhase === "beforeFiles"
              ? [{ source: "/legacy", destination: "/pages?dest=2&same=new" }]
              : [],
          afterFiles:
            rewritePhase === "afterFiles"
              ? [{ source: "/legacy", destination: "/pages?dest=2&same=new" }]
              : [],
          fallback:
            rewritePhase === "fallback"
              ? [{ source: "/legacy", destination: "/pages?dest=2&same=new" }]
              : [],
        },
        matchRoute: () => null,
        renderPagesFallback,
      });

      const response = await handler(
        new Request("https://example.test/docs/legacy?keep=1&same=old"),
        null,
      );

      expect(await response.text()).toBe("pages");
      const rewrittenCall = renderPagesFallback.mock.calls.find(([options]) =>
        options.pathname.startsWith("/pages?"),
      );
      expect(rewrittenCall).toBeDefined();
      const rewrittenUrl = new URL(rewrittenCall![0].pathname, "https://example.test");
      expect(rewrittenUrl.pathname).toBe("/pages");
      expect(Object.fromEntries(rewrittenUrl.searchParams)).toEqual({
        dest: "2",
        keep: "1",
        same: "new",
      });
    },
  );

  it.each(["beforeFiles", "afterFiles", "fallback"] as const)(
    "excludes rewrite fragments from %s route matching",
    async (rewritePhase) => {
      const matchRoute = vi.fn((pathname: string) =>
        pathname === "/about"
          ? {
              params: {},
              route: createPageRoute(),
            }
          : null,
      );
      const handler = createHandler({
        configHeaders: [],
        configRewrites: {
          beforeFiles:
            rewritePhase === "beforeFiles"
              ? [{ source: "/legacy/:code", destination: "/about#:code" }]
              : [],
          afterFiles:
            rewritePhase === "afterFiles"
              ? [{ source: "/legacy/:code", destination: "/about#:code" }]
              : [],
          fallback:
            rewritePhase === "fallback"
              ? [{ source: "/legacy/:code", destination: "/about#:code" }]
              : [],
        },
        matchRoute,
      });

      const response = await handler(new Request("https://example.test/docs/legacy/500"), null);

      expect(response.status).toBe(200);
      expect(matchRoute).toHaveBeenCalledWith("/about");
      expect(matchRoute).not.toHaveBeenCalledWith("/about#500");
    },
  );

  it("serves public files before route matching and clears request context", async () => {
    const clearRequestContext = vi.fn();
    const matchRoute = vi.fn(() => null);
    const handler = createHandler({
      clearRequestContext,
      configHeaders: [],
      matchRoute,
      publicFiles: new Set(["/logo.svg"]),
    });

    const response = await handler(new Request("https://example.test/docs/logo.svg"), null);

    expect(response.status).toBe(200);
    expect(readStaticFileSignal(response)).toBe("%2Flogo.svg");
    expect(response.headers.get("x-vinext-static-file")).toBeNull();
    expect(response.headers.get("vary")).toBeNull();
    expect(clearRequestContext).toHaveBeenCalledTimes(1);
    expect(matchRoute).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "public files",
      path: "/logo.svg",
      overrides: { publicFiles: new Set(["/logo.svg"]) },
    },
    {
      name: "image optimization",
      path: "/_next/image?url=%2Fimg.jpg&w=640&q=75",
      overrides: {},
    },
    {
      name: "metadata routes",
      path: "/favicon.ico",
      overrides: {
        metadataRoutes: [
          {
            type: "favicon" as const,
            isDynamic: false,
            filePath: "/tmp/app/favicon.ico",
            routePrefix: "",
            routeSegments: [],
            servedUrl: "/favicon.ico",
            contentType: "image/x-icon",
            fileDataBase64: btoa("icon-bytes"),
          },
        ],
      },
    },
  ])("does not expose $name directly outside basePath", async ({ path, overrides }) => {
    const handler = createHandler({ configHeaders: [], matchRoute: () => null, ...overrides });

    const response = await handler(new Request(`https://example.test${path}`), null);

    expect(response.status).toBe(404);
  });

  it("lets middleware Cache-Control override static metadata route defaults", async () => {
    // Ported from Next.js: test/e2e/app-dir/no-duplicate-headers-middleware/no-duplicate-headers-middleware.test.ts
    // https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-dir/no-duplicate-headers-middleware/no-duplicate-headers-middleware.test.ts
    const handler = createHandler({
      configHeaders: [],
      matchRoute: () => null,
      metadataRoutes: [
        {
          type: "favicon",
          isDynamic: false,
          filePath: "/tmp/app/favicon.ico",
          routePrefix: "",
          routeSegments: [],
          servedUrl: "/favicon.ico",
          contentType: "image/x-icon",
          fileDataBase64: btoa("icon-bytes"),
        },
      ],
      middlewareModule: {
        middleware() {
          return new Response(null, {
            headers: {
              "Cache-Control": "max-age=1234",
              "x-middleware-next": "1",
            },
          });
        },
      },
    });

    const response = await handler(new Request("https://example.test/docs/favicon.ico"), null);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("max-age=1234");
    expect(response.headers.get("content-type")).toBe("image/x-icon");
    await expect(response.text()).resolves.toBe("icon-bytes");
  });

  it("lets next.config headers override static metadata route defaults", async () => {
    // Ported from Next.js: test/e2e/app-dir/no-duplicate-headers-next-config/no-duplicate-headers-next-config.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/no-duplicate-headers-next-config/no-duplicate-headers-next-config.test.ts
    const handler = createHandler({
      configHeaders: [
        {
          source: "/favicon.ico",
          headers: [
            { key: "cache-control", value: "max-age=1234" },
            { key: "content-type", value: "text/plain" },
          ],
        },
      ],
      matchRoute: () => null,
      metadataRoutes: [
        {
          type: "favicon",
          isDynamic: false,
          filePath: "/tmp/app/favicon.ico",
          routePrefix: "",
          routeSegments: [],
          servedUrl: "/favicon.ico",
          contentType: "image/x-icon",
          fileDataBase64: btoa("icon-bytes"),
        },
      ],
    });

    const response = await handler(new Request("https://example.test/docs/favicon.ico"), null);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("max-age=1234");
    expect(response.headers.get("content-type")).toBe("image/x-icon");
    await expect(response.text()).resolves.toBe("icon-bytes");
  });

  it("keeps middleware Cache-Control above matching config headers for metadata routes", async () => {
    const handler = createHandler({
      configHeaders: [
        {
          source: "/favicon.ico",
          headers: [{ key: "cache-control", value: "max-age=1234" }],
        },
      ],
      matchRoute: () => null,
      metadataRoutes: [
        {
          type: "favicon",
          isDynamic: false,
          filePath: "/tmp/app/favicon.ico",
          routePrefix: "",
          routeSegments: [],
          servedUrl: "/favicon.ico",
          contentType: "image/x-icon",
          fileDataBase64: btoa("icon-bytes"),
        },
      ],
      middlewareModule: {
        middleware() {
          return new Response(null, {
            headers: {
              "Cache-Control": "max-age=5678",
              "x-middleware-next": "1",
            },
          });
        },
      },
    });

    const response = await handler(new Request("https://example.test/docs/favicon.ico"), null);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("max-age=5678");
    expect(response.headers.get("content-type")).toBe("image/x-icon");
    await expect(response.text()).resolves.toBe("icon-bytes");
  });

  it("lets server actions short-circuit routing while still applying final headers", async () => {
    const dispatchMatchedPage = vi.fn(async () => new Response("page", { status: 200 }));
    const handleServerActionRequest = vi.fn(
      async () => new Response("action", { status: 200, headers: { "x-action": "done" } }),
    );
    const handler = createHandler({
      configRewrites: {
        beforeFiles: [],
        afterFiles: [{ source: "/about", destination: "/rewritten-action" }],
        fallback: [],
      },
      dispatchMatchedPage,
      handleServerActionRequest,
    });

    const response = await handler(
      new Request("https://example.test/docs/about", {
        method: "POST",
        headers: { "next-action": "abc123" },
      }),
      null,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("action");
    expect(response.headers.get("x-action")).toBe("done");
    expect(response.headers.get("x-test-header")).toBe("applied");
    expect(handleServerActionRequest).toHaveBeenCalledWith(
      expect.objectContaining({ actionId: "abc123", cleanPathname: "/about" }),
    );
    expect(dispatchMatchedPage).not.toHaveBeenCalled();
  });

  it("uses one isolated middleware branch for body-bearing RSC actions", async () => {
    const rscHeaders = createRscRequestHeaders();
    rscHeaders.set("content-type", "text/plain");
    rscHeaders.set("next-action", "abc123");
    const rscHash = await computeRscCacheBustingSearchParam(rscHeaders);
    const cloneSpy = vi.spyOn(Request.prototype, "clone");
    const handleServerActionRequest = vi.fn(async ({ request }: { request: Request }) => {
      await expect(request.text()).resolves.toBe("streamed-action-body");
      return new Response("action");
    });
    const middleware = vi.fn(async (request: Request) => {
      await expect(request.text()).resolves.toBe("streamed-action-body");
      return new Response(null, {
        headers: { "x-middleware-next": "1" },
      });
    });
    const handler = createHandler({
      configHeaders: [],
      handleServerActionRequest,
      middlewareModule: {
        default: middleware,
      },
    });

    try {
      const response = await handler(
        new Request(`https://example.test/docs/about.rsc?_rsc=${rscHash}`, {
          body: "streamed-action-body",
          headers: rscHeaders,
          method: "POST",
        }),
        null,
      );

      expect(response.status).toBe(200);
      expect(await response.text()).toBe("action");
      expect(middleware).toHaveBeenCalledOnce();
      expect(handleServerActionRequest).toHaveBeenCalledOnce();
      // URL/query/header normalization shares the downstream body owner. The
      // only tee is the real middleware/downstream boundary, and middleware's
      // branch is transferred into NextRequest rather than abandoned.
      expect(cloneSpy).toHaveBeenCalledTimes(1);
      expect((cloneSpy.mock.results[0]!.value as Request).bodyUsed).toBe(true);
    } finally {
      cloneSpy.mockRestore();
    }
  });

  it("does not tee body-bearing RSC actions when middleware is absent", async () => {
    const rscHeaders = createRscRequestHeaders();
    rscHeaders.set("content-type", "text/plain");
    rscHeaders.set("next-action", "abc123");
    const rscHash = await computeRscCacheBustingSearchParam(rscHeaders);
    const cloneSpy = vi.spyOn(Request.prototype, "clone");
    const handleServerActionRequest = vi.fn(async ({ request }: { request: Request }) => {
      await expect(request.text()).resolves.toBe("streamed-action-body");
      return new Response("action");
    });
    const handler = createHandler({ configHeaders: [], handleServerActionRequest });

    try {
      const response = await handler(
        new Request(`https://example.test/docs/about.rsc?_rsc=${rscHash}`, {
          body: "streamed-action-body",
          headers: rscHeaders,
          method: "POST",
        }),
        null,
      );

      expect(response.status).toBe(200);
      expect(await response.text()).toBe("action");
      expect(cloneSpy).not.toHaveBeenCalled();
    } finally {
      cloneSpy.mockRestore();
    }
  });

  it("cancels the isolated RSC body branch when middleware does not match", async () => {
    const rscHeaders = createRscRequestHeaders();
    rscHeaders.set("content-type", "text/plain");
    rscHeaders.set("next-action", "abc123");
    const rscHash = await computeRscCacheBustingSearchParam(rscHeaders);
    const cloneSpy = vi.spyOn(Request.prototype, "clone");
    const middleware = vi.fn(() => new Response("unexpected"));
    const handleServerActionRequest = vi.fn(async ({ request }: { request: Request }) => {
      await expect(request.text()).resolves.toBe("streamed-action-body");
      return new Response("action");
    });
    const handler = createHandler({
      configHeaders: [],
      handleServerActionRequest,
      middlewareModule: {
        config: { matcher: "/middleware-only" },
        default: middleware,
      },
    });

    try {
      const response = await handler(
        new Request(`https://example.test/docs/about.rsc?_rsc=${rscHash}`, {
          body: "streamed-action-body",
          headers: rscHeaders,
          method: "POST",
        }),
        null,
      );

      expect(response.status).toBe(200);
      expect(await response.text()).toBe("action");
      expect(middleware).not.toHaveBeenCalled();
      expect(cloneSpy).toHaveBeenCalledTimes(1);
      expect((cloneSpy.mock.results[0]!.value as Request).bodyUsed).toBe(true);
    } finally {
      cloneSpy.mockRestore();
    }
  });

  it("accepts the vinext action header name for server actions", async () => {
    const handleServerActionRequest = vi.fn(async () => new Response("action", { status: 200 }));
    const handler = createHandler({ handleServerActionRequest });

    await handler(
      new Request("https://example.test/docs/about", {
        method: "POST",
        headers: { "x-rsc-action": "vinext-action" },
      }),
      null,
    );

    expect(handleServerActionRequest).toHaveBeenCalledWith(
      expect.objectContaining({ actionId: "vinext-action" }),
    );
  });

  it("rejects stale action requests without retaining the action runtime", async () => {
    const clearRequestContext = vi.fn();
    const handler = createHandler({
      clearRequestContext,
      handleProgressiveActionRequest: undefined,
      handleServerActionRequest: undefined,
    });

    const response = await handler(
      new Request("https://example.test/docs/about", {
        method: "POST",
        headers: { "next-action": "stale-action" },
      }),
      null,
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("x-nextjs-action-not-found")).toBe("1");
    expect(await response.text()).toBe("Server action not found.");
    expect(clearRequestContext).toHaveBeenCalledTimes(1);
  });

  it("skips action dispatchers for ordinary page requests", async () => {
    const handleProgressiveActionRequest = vi.fn(async () => null);
    const handleServerActionRequest = vi.fn(async () => null);
    const handler = createHandler({
      handleProgressiveActionRequest,
      handleServerActionRequest,
    });

    const response = await handler(new Request("https://example.test/docs/about"), null);

    expect(response.status).toBe(200);
    expect(handleProgressiveActionRequest).not.toHaveBeenCalled();
    expect(handleServerActionRequest).not.toHaveBeenCalled();
  });

  it("dispatches route handlers with matched params", async () => {
    const route = createPageRoute({
      isDynamic: true,
      page: null,
      pattern: "/api/:id",
      routeHandler: { GET: () => new Response("route") },
      routeSegments: ["api", "[id]"],
    });
    const dispatchMatchedRouteHandler = vi.fn(async () => new Response("route", { status: 200 }));
    const handler = createHandler({
      configHeaders: [],
      dispatchMatchedRouteHandler,
      matchRoute: (pathname: string) =>
        pathname === "/api/123"
          ? {
              params: { id: "123" },
              route,
            }
          : null,
    });

    const response = await handler(new Request("https://example.test/docs/api/123"), null);

    expect(response.status).toBe(200);
    expect(dispatchMatchedRouteHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        cleanPathname: "/api/123",
        params: { id: "123" },
        route,
      }),
    );
  });

  // Matches Next.js behavior: non-dynamic route handlers receive params=null.
  // See test/e2e/app-dir/app-routes/app-custom-routes.test.ts in next.js.
  it("dispatches non-dynamic route handlers with params: null", async () => {
    const route = createPageRoute({
      isDynamic: false,
      page: null,
      pattern: "/api/static",
      routeHandler: { GET: () => new Response("route") },
      routeSegments: ["api", "static"],
    });
    const dispatchMatchedRouteHandler = vi.fn(async () => new Response("route", { status: 200 }));
    const handler = createHandler({
      configHeaders: [],
      dispatchMatchedRouteHandler,
      matchRoute: (pathname: string) =>
        pathname === "/api/static"
          ? {
              params: {},
              route,
            }
          : null,
    });

    const response = await handler(new Request("https://example.test/docs/api/static"), null);

    expect(response.status).toBe(200);
    expect(dispatchMatchedRouteHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        cleanPathname: "/api/static",
        params: null,
        route,
      }),
    );
  });

  it("appends App Router RSC vary values to route handler responses", async () => {
    const route = createPageRoute({
      isDynamic: true,
      page: null,
      pattern: "/api/:id",
      routeHandler: { GET: () => new Response("route") },
      routeSegments: ["api", "[id]"],
    });
    const dispatchMatchedRouteHandler = vi.fn(
      async () => new Response("route", { status: 200, headers: { Vary: "User-Agent" } }),
    );
    const handler = createHandler({
      configHeaders: [],
      dispatchMatchedRouteHandler,
      matchRoute: (pathname: string) =>
        pathname === "/api/123"
          ? {
              params: { id: "123" },
              route,
            }
          : null,
    });

    const response = await handler(new Request("https://example.test/docs/api/123"), null);

    expect(response.status).toBe(200);
    expect(response.headers.get("vary")).toBe(`User-Agent, ${VINEXT_RSC_VARY_HEADER}`);
  });

  it("clears request context before returning the plain 404 fallback", async () => {
    const clearRequestContext = vi.fn();
    const handler = createHandler({
      clearRequestContext,
      configHeaders: [],
      matchRoute: () => null,
      renderNotFound: async () => null,
    });

    const response = await handler(new Request("https://example.test/docs/missing"), null);

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("This page could not be found");
    expect(clearRequestContext).toHaveBeenCalledTimes(1);
  });

  // Issue #1452 — root params must be visible to actions/route handlers/use cache,
  // not only to the page render. The handler used to call setRootParams only
  // after the post-action route match, leaving rootParams null during action
  // dispatch and route-handler dispatch. See app-rsc-handler.ts pre-action
  // seeding block.
  describe("root params propagation (issue #1452)", () => {
    it("populates root params before route-handler dispatch", async () => {
      const route = createPageRoute({
        isDynamic: true,
        page: null,
        pattern: "/:lang/:locale/api",
        rootParamNames: ["lang", "locale"],
        routeHandler: { GET: () => new Response("route") },
        routeSegments: ["[lang]", "[locale]", "api"],
      });
      let observedRootParams: Record<string, string | string[] | undefined> | null = null;
      const dispatchMatchedRouteHandler = vi.fn(async () => {
        // Read from the unified request context active at dispatch time.
        const { getRootParam } = await import("../packages/vinext/src/shims/root-params.js");
        observedRootParams = {
          lang: await getRootParam("lang"),
          locale: await getRootParam("locale"),
        };
        return new Response("route", { status: 200 });
      });
      const handler = createHandler({
        configHeaders: [],
        dispatchMatchedRouteHandler,
        matchRoute: (pathname: string) =>
          pathname === "/en/us/api"
            ? {
                params: { lang: "en", locale: "us" },
                route,
              }
            : null,
      });

      const response = await handler(new Request("https://example.test/docs/en/us/api"), null);
      expect(response.status).toBe(200);
      expect(observedRootParams).toEqual({ lang: "en", locale: "us" });
    });

    it("populates root params before server-action dispatch", async () => {
      const route = createPageRoute({
        isDynamic: true,
        pattern: "/:lang/:locale/server-action",
        rootParamNames: ["lang", "locale"],
        routeSegments: ["[lang]", "[locale]", "server-action"],
      });
      let observedRootParams: Record<string, string | string[] | undefined> | null = null;
      const handleServerActionRequest = vi.fn(async () => {
        const { getRootParam } = await import("../packages/vinext/src/shims/root-params.js");
        observedRootParams = {
          lang: await getRootParam("lang"),
          locale: await getRootParam("locale"),
        };
        return new Response("action", { status: 200 });
      });
      const handler = createHandler({
        configHeaders: [],
        handleServerActionRequest,
        matchRoute: (pathname: string) =>
          pathname === "/en/us/server-action"
            ? {
                params: { lang: "en", locale: "us" },
                route,
              }
            : null,
      });

      const response = await handler(
        new Request("https://example.test/docs/en/us/server-action", {
          method: "POST",
          headers: { "next-action": "abc123" },
        }),
        null,
      );
      expect(response.status).toBe(200);
      expect(observedRootParams).toEqual({ lang: "en", locale: "us" });
    });

    it("populates root params before progressive (form) action dispatch", async () => {
      const route = createPageRoute({
        isDynamic: true,
        pattern: "/:lang/:locale/server-action",
        rootParamNames: ["lang", "locale"],
        routeSegments: ["[lang]", "[locale]", "server-action"],
      });
      let observedRootParams: Record<string, string | string[] | undefined> | null = null;
      const handleProgressiveActionRequest = vi.fn(async () => {
        const { getRootParam } = await import("../packages/vinext/src/shims/root-params.js");
        observedRootParams = {
          lang: await getRootParam("lang"),
          locale: await getRootParam("locale"),
        };
        return new Response("progressive-action", { status: 200 });
      });
      const handler = createHandler({
        configHeaders: [],
        handleProgressiveActionRequest,
        matchRoute: (pathname: string) =>
          pathname === "/en/us/server-action"
            ? {
                params: { lang: "en", locale: "us" },
                route,
              }
            : null,
      });

      const response = await handler(
        new Request("https://example.test/docs/en/us/server-action", {
          method: "POST",
          headers: { "content-type": "multipart/form-data; boundary=vinext" },
        }),
        null,
      );
      expect(response.status).toBe(200);
      expect(observedRootParams).toEqual({ lang: "en", locale: "us" });
    });

    it("only picks root params declared on the matched route", async () => {
      // The route has a dynamic [slug] segment but only [lang] is a root param.
      // setRootParams must surface only `lang`, not `slug`.
      const route = createPageRoute({
        isDynamic: true,
        page: null,
        pattern: "/:lang/blog/:slug",
        rootParamNames: ["lang"],
        routeHandler: { GET: () => new Response("route") },
        routeSegments: ["[lang]", "blog", "[slug]"],
      });
      let observedLang: string | string[] | undefined = "<unset>";
      let observedSlug: string | string[] | undefined = "<unset>";
      const dispatchMatchedRouteHandler = vi.fn(async () => {
        const { getRootParam } = await import("../packages/vinext/src/shims/root-params.js");
        observedLang = await getRootParam("lang");
        observedSlug = await getRootParam("slug");
        return new Response("route", { status: 200 });
      });
      const handler = createHandler({
        configHeaders: [],
        dispatchMatchedRouteHandler,
        matchRoute: (pathname: string) =>
          pathname === "/en/blog/hello"
            ? {
                params: { lang: "en", slug: "hello" },
                route,
              }
            : null,
      });

      const response = await handler(new Request("https://example.test/docs/en/blog/hello"), null);
      expect(response.status).toBe(200);
      expect(observedLang).toBe("en");
      expect(observedSlug).toBeUndefined();
    });
  });
});
