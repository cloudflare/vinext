import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import React from "react";
import {
  APP_INTERCEPTION_CONTEXT_KEY,
  APP_ROOT_LAYOUT_KEY,
  APP_ROUTE_KEY,
} from "../packages/vinext/src/server/app-elements.js";
import type { AppPageModule } from "../packages/vinext/src/server/app-page-route-wiring.js";
import type { AppPageParams } from "../packages/vinext/src/server/app-page-boundary.js";
import { makeThenableParams } from "../packages/vinext/src/shims/thenable-params.js";

// Import the function under test AFTER mocking dependencies.
// eslint-disable-next-line import/first
import { buildPageElements } from "../packages/vinext/src/server/app-page-element-builder.js";
import type { AppPageBuildRoute } from "../packages/vinext/src/server/app-page-element-builder.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const { markDynamicUsageMock } = vi.hoisted(() => ({
  markDynamicUsageMock: vi.fn(),
}));

vi.mock("../packages/vinext/src/shims/headers.js", () => ({
  markDynamicUsage: markDynamicUsageMock,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createSyntheticRoute(overrides?: Partial<AppPageBuildRoute>): AppPageBuildRoute {
  return {
    layouts: [],
    pattern: "/test",
    routeSegments: [] as readonly string[],
    ...overrides,
  };
}

function createSyntheticPageModule(defaultExport?: unknown): AppPageModule {
  if (defaultExport !== undefined) {
    return { default: defaultExport } as AppPageModule;
  }
  return {} as AppPageModule;
}

function createSyntheticPageModuleWithoutDefault(): AppPageModule {
  return { generateMetadata: vi.fn() } as AppPageModule;
}

function createBaseOptions(overrides?: {
  route?: AppPageBuildRoute;
  params?: AppPageParams;
  routePath?: string;
  opts?: Record<string, unknown> | null;
  searchParams?: URLSearchParams | null;
  mountedSlotsHeader?: string | null;
}) {
  return {
    route:
      overrides?.route ?? createSyntheticRoute({ page: createSyntheticPageModule(() => null) }),
    params: overrides?.params ?? {},
    routePath: overrides?.routePath ?? "/test",
    pageRequest: {
      opts: overrides?.opts ?? null,
      searchParams: overrides?.searchParams ?? null,
      isRscRequest: false,
      request: new Request("http://localhost/test"),
      mountedSlotsHeader: overrides?.mountedSlotsHeader ?? null,
    },
    globalErrorModule: null,
    rootNotFoundModule: null,
    rootForbiddenModule: null,
    rootUnauthorizedModule: null,
    metadataRoutes: [],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("buildPageElements", () => {
  beforeEach(() => {
    markDynamicUsageMock.mockClear();
  });

  it("returns an error element record when a page module has no default export", async () => {
    const route = createSyntheticRoute({
      page: createSyntheticPageModuleWithoutDefault(),
      layouts: [],
      routeSegments: ["test"],
      pattern: "/test",
    });

    const result = await buildPageElements(createBaseOptions({ route }));

    const record = result as Record<string, unknown>;
    // The error payload uses createAppPayloadRouteId which prefixes "route:"
    // to build the key and the __route metadata.
    expect(record[APP_ROUTE_KEY]).toBe("route:/test");
    expect(record[APP_INTERCEPTION_CONTEXT_KEY]).toBe(null);
    expect(Object.prototype.hasOwnProperty.call(record, APP_ROOT_LAYOUT_KEY)).toBe(true);
    // The element itself is stored under the route ID key.
    expect(record["route:/test"]).toBeDefined();
  });

  it("includes interception context in the error payload route ID", async () => {
    const route = createSyntheticRoute({
      page: createSyntheticPageModuleWithoutDefault(),
      layouts: [],
      routeSegments: ["intercepted"],
      pattern: "/intercepted",
    });

    const result = await buildPageElements(
      createBaseOptions({
        route,
        routePath: "/intercepted",
        opts: { interceptionContext: "ctx-abc" } as Record<string, unknown>,
      }),
    );

    const record = result as Record<string, unknown>;
    expect(record[APP_ROUTE_KEY]).toBe("route:/intercepted\u0000ctx-abc");
  });

  it("computes root layout tree path for error payload when layouts exist", async () => {
    const route = createSyntheticRoute({
      page: createSyntheticPageModuleWithoutDefault(),
      layouts: [createSyntheticPageModule(() => null), createSyntheticPageModule(() => null)],
      layoutTreePositions: [0, 1],
      routeSegments: ["dashboard", "settings"],
      pattern: "/dashboard/settings",
    });

    const result = await buildPageElements(createBaseOptions({ route }));

    const record = result as Record<string, unknown>;
    expect(record[APP_ROOT_LAYOUT_KEY]).toBe("/");
  });

  it("constructs a full element tree for a page with a default export", async () => {
    function TestPage(): React.ReactNode {
      return React.createElement("div", null, "Hello");
    }

    const route = createSyntheticRoute({
      page: createSyntheticPageModule(TestPage),
      layouts: [],
      routeSegments: ["hello"],
      pattern: "/hello",
    });

    const result = await buildPageElements(createBaseOptions({ route, routePath: "/hello" }));

    const record = result as Record<string, unknown>;
    // Normal flow: the element tree has both route and page payload IDs.
    expect(record[APP_ROUTE_KEY]).toBe("route:/hello");
    expect(Object.prototype.hasOwnProperty.call(record, "page:/hello")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(record, "route:/hello")).toBe(true);
  });

  it("calls markDynamicUsage when search params have content", async () => {
    function SearchPage(): React.ReactNode {
      return React.createElement("div", null, "Search");
    }

    const route = createSyntheticRoute({
      page: createSyntheticPageModule(SearchPage),
      layouts: [],
      routeSegments: ["search"],
      pattern: "/search",
    });

    await buildPageElements(
      createBaseOptions({
        route,
        routePath: "/search",
        searchParams: new URLSearchParams("q=test"),
      }),
    );

    expect(markDynamicUsageMock).toHaveBeenCalled();
  });

  it("does NOT call markDynamicUsage when search params are empty", async () => {
    function NoSearchPage(): React.ReactNode {
      return React.createElement("div", null, "No Search");
    }

    const route = createSyntheticRoute({
      page: createSyntheticPageModule(NoSearchPage),
      layouts: [],
      routeSegments: ["no-search"],
      pattern: "/no-search",
    });

    await buildPageElements(
      createBaseOptions({
        route,
        routePath: "/no-search",
        searchParams: new URLSearchParams(""),
      }),
    );

    expect(markDynamicUsageMock).not.toHaveBeenCalled();
  });

  it("passes slot overrides when interception opts have a slot key and page", async () => {
    function InterceptPage(): React.ReactNode {
      return React.createElement("div", null, "Intercepted");
    }

    const route = createSyntheticRoute({
      page: createSyntheticPageModule(() => React.createElement("div", null, "Main")),
      layouts: [],
      routeSegments: ["feed"],
      pattern: "/feed",
    });

    const result = await buildPageElements(
      createBaseOptions({
        route,
        routePath: "/feed",
        opts: {
          interceptSlotKey: "modal",
          interceptPage: createSyntheticPageModule(InterceptPage),
          interceptLayouts: [
            createSyntheticPageModule(() => React.createElement("div", null, "Layout")),
          ],
          interceptParams: { id: "123" },
        } as Record<string, unknown>,
      }),
    );

    const record = result as Record<string, unknown>;
    expect(record[APP_ROUTE_KEY]).toBe("route:/feed");
    expect(Object.prototype.hasOwnProperty.call(record, "page:/feed")).toBe(true);
  });

  it("builds elements for a page that receives search params", async () => {
    function ParamPage(): React.ReactNode {
      return React.createElement("div", null, "Params");
    }

    const route = createSyntheticRoute({
      page: createSyntheticPageModule(ParamPage),
      layouts: [],
      routeSegments: ["user", "[id]"],
      pattern: "/user/[id]",
    });

    const params: AppPageParams = { id: "42" };

    const result = await buildPageElements(
      createBaseOptions({
        route,
        routePath: "/user/[id]",
        params,
        searchParams: new URLSearchParams("ref=source"),
      }),
    );

    const record = result as Record<string, unknown>;
    expect(record[APP_ROUTE_KEY]).toBe("route:/user/[id]");
    expect(Object.prototype.hasOwnProperty.call(record, "page:/user/[id]")).toBe(true);
  });

  it("makeThenableParams wraps params as a proxy supporting both Promise and property access", () => {
    const plainParams: AppPageParams = { id: "99" };
    const thenable = makeThenableParams(plainParams);

    expect(typeof thenable.then).toBe("function");
    expect(Reflect.get(thenable as object, "id")).toBe("99");

    return thenable.then((resolved: AppPageParams) => {
      expect(resolved).toEqual(plainParams);
    });
  });
});
