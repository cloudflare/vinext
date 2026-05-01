import { describe, expect, it, vi } from "vite-plus/test";
import { createAppRscHandler } from "../packages/vinext/src/server/app-rsc-handler.js";
import { makeThenableParams } from "../packages/vinext/src/shims/thenable-params.js";

type TestRoute = {
  page?: { default?: unknown } | null;
  params: readonly string[];
  pattern: string;
  rootParamNames?: readonly string[];
  routeHandler?: { GET?: () => Response } | null;
  routeSegments: readonly string[];
};

type TestMatch = {
  params: Record<string, string | string[]>;
  route: TestRoute;
};

type HandlerOptions = Parameters<typeof createAppRscHandler<TestRoute>>[0];

function createPageRoute(): TestRoute {
  return {
    page: { default() {} },
    params: [],
    pattern: "/about",
    routeSegments: ["about"],
  };
}

function createHandler(overrides: Partial<HandlerOptions> = {}) {
  const route = createPageRoute();

  return createAppRscHandler<TestRoute>({
    basePath: "/docs",
    clearRequestContext: overrides.clearRequestContext ?? (() => {}),
    configHeaders: [
      {
        source: "/about",
        headers: [{ key: "x-test-header", value: "applied" }],
      },
    ],
    configRedirects: [],
    configRewrites: {
      afterFiles: [],
      beforeFiles: [],
      fallback: [],
    },
    dispatchMatchedPage:
      overrides.dispatchMatchedPage ??
      (async () => new Response("page", { status: 200, headers: { "x-from-dispatch": "page" } })),
    dispatchMatchedRouteHandler:
      overrides.dispatchMatchedRouteHandler ?? (async () => new Response("route", { status: 200 })),
    ensureInstrumentation: overrides.ensureInstrumentation ?? (async () => {}),
    handleProgressiveActionRequest: overrides.handleProgressiveActionRequest ?? (async () => null),
    handleServerActionRequest: overrides.handleServerActionRequest ?? (async () => null),
    i18nConfig: overrides.i18nConfig ?? null,
    matchRoute:
      overrides.matchRoute ??
      ((pathname: string): TestMatch | null =>
        pathname === "/about"
          ? {
              params: {},
              route,
            }
          : null),
    makeThenableParams,
    metadataRoutes: overrides.metadataRoutes ?? [],
    middlewareModule: overrides.middlewareModule ?? null,
    publicFiles: overrides.publicFiles ?? new Set<string>(),
    renderNotFoundPage: overrides.renderNotFoundPage ?? (async () => null),
    renderPagesFallback: overrides.renderPagesFallback ?? (async () => null),
    staticParamsMap: {},
    setNavigationContext: overrides.setNavigationContext ?? (() => {}),
    trailingSlash: overrides.trailingSlash ?? false,
    validateDevRequestOrigin: overrides.validateDevRequestOrigin ?? (() => null),
  });
}

describe("app rsc handler", () => {
  it("applies config headers to non-redirect responses after page dispatch", async () => {
    const dispatchMatchedPage = vi.fn(async () => new Response("page", { status: 200 }));
    const handler = createHandler({ dispatchMatchedPage });

    const response = await handler(new Request("https://example.test/docs/about"), null);

    expect(dispatchMatchedPage).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-test-header")).toBe("applied");
  });

  it("skips config headers for redirect responses", async () => {
    const handler = createHandler({
      async dispatchMatchedPage() {
        return Response.redirect("https://example.test/docs/next", 307);
      },
    });

    const response = await handler(new Request("https://example.test/docs/about"), null);

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("https://example.test/docs/next");
    expect(response.headers.get("x-test-header")).toBeNull();
  });
});
