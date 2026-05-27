import { describe, expect, it, vi } from "vite-plus/test";
import {
  computeRscCacheBustingSearchParam,
  createRscRequestHeaders,
  createRscRequestUrl,
  VINEXT_RSC_VARY_HEADER,
} from "../packages/vinext/src/server/app-rsc-cache-busting.js";
import { createAppRscHandler } from "../packages/vinext/src/server/app-rsc-handler.js";
import { makeThenableParams } from "../packages/vinext/src/shims/thenable-params.js";

type TestRoute = {
  isDynamic: boolean;
  page?: { default?: unknown } | null;
  pattern: string;
  rootParamNames?: readonly string[];
  routeHandler?: { GET?: () => Response } | null;
  routeSegments: readonly string[];
};

type HandlerOptions = Parameters<typeof createAppRscHandler<TestRoute>>[0];

function createPageRoute(overrides: Partial<TestRoute> = {}): TestRoute {
  return {
    isDynamic: false,
    page: { default() {} },
    pattern: "/about",
    routeSegments: ["about"],
    ...overrides,
  };
}

function createHandler(overrides: Partial<HandlerOptions> = {}) {
  const route = createPageRoute();

  return createAppRscHandler<TestRoute>({
    basePath: "/docs",
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
    handleProgressiveActionRequest: overrides.handleProgressiveActionRequest ?? (async () => null),
    handleServerActionRequest: overrides.handleServerActionRequest ?? (async () => null),
    i18nConfig: overrides.i18nConfig ?? null,
    isMiddlewareProxy: overrides.isMiddlewareProxy ?? false,
    makeThenableParams,
    matchRoute:
      overrides.matchRoute ??
      ((pathname: string) =>
        pathname === "/about"
          ? {
              params: {},
              route,
            }
          : null),
    metadataRoutes: overrides.metadataRoutes ?? [],
    middlewareModule: overrides.middlewareModule ?? null,
    publicFiles: overrides.publicFiles ?? new Set<string>(),
    renderNotFound: overrides.renderNotFound ?? (async () => null),
    renderPagesFallback: overrides.renderPagesFallback,
    rootParamNamesByPattern: overrides.rootParamNamesByPattern,
    setNavigationContext: overrides.setNavigationContext ?? (() => {}),
    staticParamsMap: overrides.staticParamsMap ?? {},
    trailingSlash: overrides.trailingSlash ?? false,
    validateDevRequestOrigin: overrides.validateDevRequestOrigin ?? (() => null),
  });
}

describe("createAppRscHandler", () => {
  it("wraps dispatch responses with request-scoped finalization", async () => {
    const dispatchMatchedPage = vi.fn(async () => new Response("page", { status: 200 }));
    const handler = createHandler({ dispatchMatchedPage });

    const response = await handler(new Request("https://example.test/docs/about"), null);

    expect(dispatchMatchedPage).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-test-header")).toBe("applied");
    expect(response.headers.get("vary")).toBe(VINEXT_RSC_VARY_HEADER);
  });

  it("marks progressive action page renders even when decoded form state is null", async () => {
    const dispatchMatchedPage = vi.fn(async () => new Response("page", { status: 200 }));
    const handler = createHandler({
      configHeaders: [],
      dispatchMatchedPage,
      async handleProgressiveActionRequest() {
        return { kind: "form-state", formState: null };
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
      `https://example.test/docs/about.rsc?from=old&_rsc=${expectedHash}`,
    );
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

  it("does not render RSC payloads at HTML URLs marked only by RSC headers", async () => {
    const dispatchMatchedPage = vi.fn(async () => new Response("page", { status: 200 }));
    const handler = createHandler({
      configHeaders: [],
      dispatchMatchedPage,
    });

    const response = await handler(
      new Request("https://example.test/docs/about", {
        headers: createRscRequestHeaders(),
      }),
      null,
    );

    expect(response.status).toBe(200);
    expect(dispatchMatchedPage).toHaveBeenCalledWith(
      expect.objectContaining({
        cleanPathname: "/about",
        isRscRequest: false,
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

  it("runs beforeFiles rewrites before route matching", async () => {
    const matchRoute = vi.fn((pathname: string) =>
      pathname === "/about"
        ? {
            params: {},
            route: createPageRoute(),
          }
        : null,
    );
    const dispatchMatchedPage = vi.fn(async () => new Response("rewritten", { status: 200 }));
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
    expect(response.headers.get("x-vinext-static-file")).toBe("%2Flogo.svg");
    expect(response.headers.get("vary")).toBeNull();
    expect(clearRequestContext).toHaveBeenCalledTimes(1);
    expect(matchRoute).not.toHaveBeenCalled();
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
});
