import { describe, expect, it, vi } from "vite-plus/test";
import { createAppRscHandler } from "../packages/vinext/src/server/app-rsc-handler.js";
import { makeThenableParams } from "../packages/vinext/src/shims/thenable-params.js";

type TestRoute = {
  page?: { default?: unknown } | null;
  pattern: string;
  rootParamNames?: readonly string[];
  routeHandler?: { GET?: () => Response } | null;
  routeSegments: readonly string[];
};

type HandlerOptions = Parameters<typeof createAppRscHandler<TestRoute>>[0];

function createPageRoute(overrides: Partial<TestRoute> = {}): TestRoute {
  return {
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
    expect(await response.text()).toBe("Not Found");
    expect(clearRequestContext).toHaveBeenCalledTimes(1);
  });
});
