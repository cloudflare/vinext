import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import React from "react";
import {
  APP_INTERCEPTION_KEY,
  APP_INTERCEPTION_CONTEXT_KEY,
  APP_LAYOUT_IDS_KEY,
  APP_ROOT_LAYOUT_KEY,
  APP_ROUTE_KEY,
  APP_SOURCE_PAGE_KEY,
  APP_SLOT_BINDINGS_KEY,
} from "../packages/vinext/src/server/app-elements.js";
import type { AppPageModule } from "../packages/vinext/src/server/app-page-route-wiring.js";
import type { AppPageParams } from "../packages/vinext/src/server/app-page-boundary.js";
import { makeThenableParams } from "../packages/vinext/src/shims/thenable-params.js";
import { readStreamAsText } from "../packages/vinext/src/utils/text-stream.js";

// Import the function under test AFTER mocking dependencies.
// eslint-disable-next-line import/first
import {
  buildPageElements,
  resolveAppPageNavigationParams,
  type AppPageBuildRoute,
} from "../packages/vinext/src/server/app-page-element-builder.js";
import { probeAppPage } from "../packages/vinext/src/server/app-page-probe.js";
import { SIBLING_PAGE_INTERCEPT_SLOT_KEY } from "../packages/vinext/src/server/app-rsc-route-matching.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const { markDynamicUsageMock, markRenderRequestApiUsageMock } = vi.hoisted(() => ({
  markDynamicUsageMock: vi.fn(),
  markRenderRequestApiUsageMock: vi.fn(),
}));

vi.mock("../packages/vinext/src/shims/headers.js", () => ({
  markDynamicUsage: markDynamicUsageMock,
  markRenderRequestApiUsage: markRenderRequestApiUsageMock,
  throwIfInsideCacheScope: vi.fn(),
  throwIfStaticGenerationAccessError: vi.fn(),
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

async function buildSearchPageSearchParams(options?: {
  loadingBoundary?: boolean;
}): Promise<{ searchParams: Promise<Record<string, unknown>> }> {
  let capturedSearchParams: Promise<Record<string, unknown>> | undefined;
  function SearchPage(props: { searchParams: Promise<Record<string, unknown>> }): React.ReactNode {
    capturedSearchParams = props.searchParams;
    return React.createElement("div", null, "Search");
  }

  const route = createSyntheticRoute({
    page: createSyntheticPageModule(SearchPage),
    loading: options?.loadingBoundary ? { default: () => null } : undefined,
    layouts: [],
    routeSegments: ["search"],
    pattern: "/search",
  });

  const result = await buildPageElements(
    createBaseOptions({
      route,
      routePath: "/search",
      searchParams: new URLSearchParams("q=test"),
    }),
  );
  const record = result as Record<string, unknown>;
  const pageElement = record["page:/search"];
  if (!React.isValidElement(pageElement)) {
    throw new Error("Expected page element");
  }
  await renderNode(pageElement);
  if (!capturedSearchParams) {
    throw new Error("Expected searchParams prop");
  }

  return { searchParams: capturedSearchParams };
}

async function resetUseCacheRuntime(): Promise<void> {
  const { MemoryCacheHandler, setCacheHandler } =
    await import("../packages/vinext/src/shims/cache.js");
  setCacheHandler(new MemoryCacheHandler());
}

async function renderNode(node: React.ReactNode): Promise<string> {
  const { renderToReadableStream } = await import("react-dom/server.edge");
  const stream = await renderToReadableStream(node, {
    onError(error: unknown) {
      throw error instanceof Error ? error : new Error(String(error));
    },
  });
  return readStreamAsText(stream);
}

async function buildAndRenderElement(
  route: AppPageBuildRoute,
  elementId: string,
  query: string,
): Promise<string> {
  const result = await buildPageElements(
    createBaseOptions({
      route,
      params: { slug: "same" },
      routePath: "/cached",
      searchParams: new URLSearchParams({ q: query }),
    }),
  );
  const record = result as Record<string, unknown>;
  const element = record[elementId];
  if (!React.isValidElement(element)) {
    throw new Error(`Expected React element for ${elementId}`);
  }

  markDynamicUsageMock.mockClear();
  markRenderRequestApiUsageMock.mockClear();
  return renderNode(element);
}

function expectNoSearchParamsObservation(): void {
  expect(markDynamicUsageMock).not.toHaveBeenCalled();
  expect(markRenderRequestApiUsageMock).not.toHaveBeenCalled();
}

async function expectCachedRenderIgnoresQuery(options: {
  expectedText: string;
  getCallCount: () => number;
  render: (query: string) => Promise<string>;
}): Promise<void> {
  await expect(options.render("first")).resolves.toContain(options.expectedText);
  expect(options.getCallCount()).toBe(1);
  expectNoSearchParamsObservation();

  await expect(options.render("second")).resolves.toContain(options.expectedText);
  expect(options.getCallCount()).toBe(1);
  expectNoSearchParamsObservation();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("buildPageElements", () => {
  beforeEach(() => {
    markDynamicUsageMock.mockClear();
    markRenderRequestApiUsageMock.mockClear();
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
    // The error payload uses the AppElementsWire route-id encoder for both
    // the entry key and the __route metadata.
    expect(record[APP_ROUTE_KEY]).toBe("route:/test");
    expect(record[APP_INTERCEPTION_CONTEXT_KEY]).toBe(null);
    expect(Object.prototype.hasOwnProperty.call(record, APP_ROOT_LAYOUT_KEY)).toBe(true);
    // The element itself is stored under the route ID key.
    expect(record["route:/test"]).toBeDefined();
  });

  it("includes active parallel slot params in navigation params", () => {
    // Ported from Next.js:
    // test/e2e/app-dir/parallel-route-navigations/parallel-route-navigations.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/parallel-route-navigations/parallel-route-navigations.test.ts
    //
    // Next.js derives useParams() from the active FlightRouterState, walking all
    // parallel route branches via getSelectedParams(). A slot catch-all branch
    // must therefore contribute params even when the primary children route is
    // static below the parent dynamic segment.
    const route = createSyntheticRoute({
      page: createSyntheticPageModule(() => null),
      layouts: [createSyntheticPageModule(() => null)],
      params: ["teamID"],
      pattern: "/:teamID/sub/folder",
      routeSegments: ["[teamID]", "sub", "folder"],
      slots: {
        "slot@app/[teamID]/@slot": {
          name: "slot",
          page: createSyntheticPageModule(() => null),
          default: createSyntheticPageModule(() => null),
          layoutIndex: 0,
          routeSegments: ["[...catchAll]"],
          slotPatternParts: [":teamID", ":catchAll+"],
          slotParamNames: ["teamID", "catchAll"],
        },
      },
    });

    expect(
      resolveAppPageNavigationParams(route, { teamID: "vercel" }, "/vercel/sub/folder", null),
    ).toEqual({
      teamID: "vercel",
      catchAll: ["sub", "folder"],
    });
  });

  it("resolves navigation params with duplicate/colliding slot and route param keys", () => {
    const route = createSyntheticRoute({
      page: createSyntheticPageModule(() => null),
      layouts: [createSyntheticPageModule(() => null)],
      params: ["id"],
      pattern: "/:id",
      routeSegments: ["[id]"],
      slots: {
        "slot@app/[id]/@slot": {
          name: "slot",
          page: createSyntheticPageModule(() => null),
          default: createSyntheticPageModule(() => null),
          layoutIndex: 0,
          routeSegments: ["[id]"],
          slotPatternParts: [":id", ":catchAll+"],
          slotParamNames: ["id", "catchAll"],
        },
      },
    });

    expect(
      resolveAppPageNavigationParams(route, { id: "primary" }, "/slot-override/sub/folder", null),
    ).toEqual({
      id: "slot-override",
      catchAll: ["sub", "folder"],
    });
  });

  it("merges non-intercepted active slot params alongside intercepted slot params", () => {
    // Both slots have catch-all patterns that match the same URL; only @slot
    // is intercepted, so @other should still contribute its catch-all.
    const route = createSyntheticRoute({
      page: createSyntheticPageModule(() => null),
      layouts: [createSyntheticPageModule(() => null)],
      params: ["teamID"],
      pattern: "/:teamID/sub/folder",
      routeSegments: ["[teamID]", "sub", "folder"],
      slots: {
        "slot@app/[teamID]/@slot": {
          name: "slot",
          page: createSyntheticPageModule(() => null),
          default: createSyntheticPageModule(() => null),
          layoutIndex: 0,
          routeSegments: ["[...catchAll]"],
          slotPatternParts: [":teamID", ":catchAll+"],
          slotParamNames: ["teamID", "catchAll"],
        },
        "slot@app/[teamID]/@other": {
          name: "other",
          page: createSyntheticPageModule(() => null),
          default: createSyntheticPageModule(() => null),
          layoutIndex: 0,
          routeSegments: ["[...otherCatchAll]"],
          slotPatternParts: [":teamID", ":otherCatchAll+"],
          slotParamNames: ["teamID", "otherCatchAll"],
        },
      },
    });

    expect(
      resolveAppPageNavigationParams(route, { teamID: "vercel" }, "/vercel/sub/folder", {
        interceptSlotKey: "slot@app/[teamID]/@slot",
        interceptPage: { default: vi.fn() },
        interceptParams: { teamID: "vercel", catchAll: ["intercepted-override"] },
      }),
    ).toEqual({
      teamID: "vercel",
      catchAll: ["intercepted-override"],
      otherCatchAll: ["sub", "folder"],
    });
  });

  it("uses interceptParams for an intercepted slot instead of slotParamOverrides", () => {
    const route = createSyntheticRoute({
      page: createSyntheticPageModule(() => null),
      layouts: [createSyntheticPageModule(() => null)],
      params: ["teamID"],
      pattern: "/:teamID/sub/folder",
      routeSegments: ["[teamID]", "sub", "folder"],
      slots: {
        "slot@app/[teamID]/@slot": {
          name: "slot",
          page: createSyntheticPageModule(() => null),
          default: createSyntheticPageModule(() => null),
          layoutIndex: 0,
          routeSegments: ["[...catchAll]"],
          slotPatternParts: [":teamID", ":catchAll+"],
          slotParamNames: ["teamID", "catchAll"],
        },
      },
    });

    expect(
      resolveAppPageNavigationParams(route, { teamID: "vercel" }, "/vercel/sub/folder", {
        interceptSlotKey: "slot@app/[teamID]/@slot",
        interceptPage: { default: vi.fn() },
        interceptParams: { teamID: "vercel", catchAll: ["intercepted", "override"] },
      }),
    ).toEqual({
      teamID: "vercel",
      catchAll: ["intercepted", "override"],
    });
  });

  it("surfaces a no-default-export error for a sibling intercept page instead of rendering the source page", async () => {
    function SourcePage(): React.ReactNode {
      return React.createElement("div", null, "Source page content");
    }

    const route = createSyntheticRoute({
      // The source route has a valid default export, so the dispatch-level
      // no-export guard passes and the request reaches buildPageElements.
      page: createSyntheticPageModule(SourcePage),
      layouts: [],
      routeSegments: ["photo", "[id]"],
      pattern: "/photo/[id]",
    });

    const result = await buildPageElements(
      createBaseOptions({
        route,
        routePath: "/photo/42",
        opts: {
          interceptSlotKey: SIBLING_PAGE_INTERCEPT_SLOT_KEY,
          // The intercepting page module is missing its `default` export.
          interceptPage: createSyntheticPageModuleWithoutDefault(),
          interceptParams: { id: "42" },
        } as Record<string, unknown>,
      }),
    );

    const record = result as Record<string, unknown>;
    const routeKey = record[APP_ROUTE_KEY] as string;
    const errorElement = record[routeKey];
    expect(React.isValidElement(errorElement)).toBe(true);

    const html = await renderNode(errorElement as React.ReactNode);
    // The error is surfaced explicitly rather than silently falling back to
    // the source route's page component.
    expect(html).toContain("Page has no default export");
    expect(html).not.toContain("Source page content");
  });

  it("publishes the intercepting page path for sibling interception", async () => {
    function InterceptPage(): React.ReactNode {
      return React.createElement("div", null, "Intercepted");
    }

    const route = createSyntheticRoute({
      page: createSyntheticPageModule(() => React.createElement("div", null, "Source")),
      layouts: [],
      routeSegments: ["foo", "bar"],
      pattern: "/foo/bar",
    });

    const result = await buildPageElements(
      createBaseOptions({
        route,
        routePath: "/hoge",
        opts: {
          interceptSlotKey: SIBLING_PAGE_INTERCEPT_SLOT_KEY,
          interceptPage: createSyntheticPageModule(InterceptPage),
          interceptParams: {},
          interceptSourcePageSegments: ["foo", "bar", "(..)(..)hoge"],
        },
      }),
    );

    expect((result as Record<string, unknown>)[APP_SOURCE_PAGE_KEY]).toBe(
      "/foo/bar/(..)(..)hoge/page",
    );
  });

  it("keeps interception context out of the error payload route ID", async () => {
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
    expect(record[APP_ROUTE_KEY]).toBe("route:/intercepted");
    expect(record[APP_INTERCEPTION_CONTEXT_KEY]).toBe("ctx-abc");
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
    expect(record[APP_LAYOUT_IDS_KEY]).toEqual(["layout:/", "layout:/dashboard"]);
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

  it.each([
    ["memo", React.memo(() => React.createElement("div", null, "memo page"))],
    [
      "forwardRef",
      React.forwardRef(function ForwardRefPage() {
        return React.createElement("div", null, "forwardRef page");
      }),
    ],
    [
      "lazy",
      React.lazy(async () => ({
        default: () => React.createElement("div", null, "lazy page"),
      })),
    ],
  ] as const)("renders a %s page export through React", async (_kind, PageComponent) => {
    const route = createSyntheticRoute({
      page: createSyntheticPageModule(PageComponent),
      layouts: [],
      routeSegments: ["exotic"],
      pattern: "/exotic",
    });

    const result = await buildPageElements(
      createBaseOptions({ route, routePath: "/exotic", searchParams: new URLSearchParams("q=ok") }),
    );

    await expect(
      renderNode((result as Record<string, React.ReactNode>)["page:/exotic"]),
    ).resolves.toContain("page");
  });

  it("renders memo page exports in parallel slots", async () => {
    const route = createSyntheticRoute({
      page: createSyntheticPageModule(() => null),
      layouts: [],
      routeSegments: ["exotic-slot"],
      pattern: "/exotic-slot",
      slots: {
        modal: {
          layoutIndex: -1,
          name: "modal",
          page: createSyntheticPageModule(
            React.memo(() => React.createElement("div", null, "memo slot")),
          ),
          routeSegments: [],
        },
      },
    });

    const result = await buildPageElements(createBaseOptions({ route, routePath: "/exotic-slot" }));

    await expect(
      renderNode((result as Record<string, React.ReactNode>)["slot:modal:/"]),
    ).resolves.toContain("memo slot");
  });

  it("records serialized queryless searchParams without marking client pages dynamic", async () => {
    const ClientPage = Object.assign(() => null, {
      $$typeof: Symbol.for("react.client.reference"),
    });
    const route = createSyntheticRoute({
      page: createSyntheticPageModule(ClientPage),
      layouts: [],
      routeSegments: ["client-isr"],
      pattern: "/client-isr",
    });

    const result = await buildPageElements({
      ...createBaseOptions({
        route,
        routePath: "/client-isr",
        searchParams: new URLSearchParams(),
      }),
      pageRequest: {
        ...createBaseOptions().pageRequest,
        isRscRequest: true,
        observePageSearchParamsAccess: true,
        searchParams: new URLSearchParams(),
      },
    });
    const pageElement = (result as Record<string, React.ReactNode>)["page:/client-isr"];
    if (!React.isValidElement<{ searchParams: Promise<Record<string, unknown>> }>(pageElement)) {
      throw new Error("Expected client page element");
    }

    await pageElement.props.searchParams;

    expect(markDynamicUsageMock).not.toHaveBeenCalled();
    expect(markRenderRequestApiUsageMock).toHaveBeenCalledWith("searchParams");
  });

  it("attaches route-state slot bindings for active, default, and unmatched slots", async () => {
    function TestPage(): React.ReactNode {
      return React.createElement("div", null, "Hello");
    }
    function TestLayout({ children }: { children?: React.ReactNode }): React.ReactNode {
      return children;
    }

    const route = createSyntheticRoute({
      page: createSyntheticPageModule(TestPage),
      layouts: [createSyntheticPageModule(TestLayout)],
      layoutTreePositions: [0],
      routeSegments: ["dashboard"],
      pattern: "/dashboard",
      slots: {
        "team@dashboard/@team": {
          id: "slot:team:/",
          name: "team",
          page: createSyntheticPageModule(() => React.createElement("div", null, "team")),
          layoutIndex: 0,
          routeSegments: [],
        },
        "analytics@dashboard/@analytics": {
          id: "slot:analytics:/",
          name: "analytics",
          default: createSyntheticPageModule(() => React.createElement("div", null, "analytics")),
          layoutIndex: 0,
          routeSegments: null,
        },
        "reports@dashboard/@reports": {
          id: "slot:reports:/",
          name: "reports",
          layoutIndex: 0,
          routeSegments: null,
        },
      },
    });

    const result = await buildPageElements(createBaseOptions({ route, routePath: "/dashboard" }));
    const record = result as Record<string, unknown>;

    expect(record[APP_SLOT_BINDINGS_KEY]).toEqual([
      {
        ownerLayoutId: "layout:/",
        slotId: "slot:analytics:/",
        state: "default",
      },
      {
        ownerLayoutId: "layout:/",
        slotId: "slot:reports:/",
        state: "unmatched",
      },
      {
        activeRouteId: "route:/dashboard",
        ownerLayoutId: "layout:/",
        slotId: "slot:team:/",
        state: "active",
      },
    ]);
  });

  it("marks intercepted slot override bindings as active", async () => {
    function TestPage(): React.ReactNode {
      return React.createElement("div", null, "Hello");
    }
    function TestLayout({ children }: { children?: React.ReactNode }): React.ReactNode {
      return children;
    }

    const route = createSyntheticRoute({
      page: createSyntheticPageModule(TestPage),
      layouts: [createSyntheticPageModule(TestLayout), createSyntheticPageModule(TestLayout)],
      layoutTreePositions: [0, 1],
      routeSegments: ["feed"],
      pattern: "/feed",
      slots: {
        "modal@feed/@modal": {
          id: "slot:modal:/feed",
          name: "modal",
          default: createSyntheticPageModule(() => null),
          layoutIndex: 1,
          routeSegments: null,
        },
      },
    });

    const result = await buildPageElements(
      createBaseOptions({
        route,
        routePath: "/photos/42",
        opts: {
          interceptionContext: "/feed",
          interceptSlotKey: "modal@feed/@modal",
          interceptPage: createSyntheticPageModule(() =>
            React.createElement("div", null, "Intercepted"),
          ),
          interceptParams: { id: "42" },
        } as Record<string, unknown>,
      }),
    );
    const record = result as Record<string, unknown>;

    expect(record[APP_SLOT_BINDINGS_KEY]).toEqual([
      {
        activeRouteId: "route:/photos/42",
        ownerLayoutId: "layout:/feed",
        slotId: "slot:modal:/feed",
        state: "active",
      },
    ]);
  });

  it("uses the source route identity for intercepted source-route payload keys", async () => {
    function TestPage(): React.ReactNode {
      return React.createElement("div", null, "Feed");
    }
    function TestLayout({ children }: { children?: React.ReactNode }): React.ReactNode {
      return children;
    }

    const route = createSyntheticRoute({
      page: createSyntheticPageModule(TestPage),
      layouts: [createSyntheticPageModule(TestLayout), createSyntheticPageModule(TestLayout)],
      layoutTreePositions: [0, 1],
      routeSegments: ["feed"],
      pattern: "/feed",
      slots: {
        "modal@feed/@modal": {
          id: "slot:modal:/feed",
          name: "modal",
          default: createSyntheticPageModule(() => null),
          layoutIndex: 1,
          routeSegments: null,
        },
      },
    });

    const result = await buildPageElements(
      createBaseOptions({
        route,
        routePath: "/photos/42",
        opts: {
          interceptionContext: "/feed",
          interceptSourceMatchedUrl: "/feed",
          interceptSlotId: "slot:modal:/feed",
          interceptSlotKey: "modal@feed/@modal",
          interceptPage: createSyntheticPageModule(() =>
            React.createElement("div", null, "Intercepted"),
          ),
          interceptParams: { id: "42" },
        } as Record<string, unknown>,
      }),
    );
    const record = result as Record<string, unknown>;

    expect(record[APP_ROUTE_KEY]).toBe("route:/feed");
    expect(Object.prototype.hasOwnProperty.call(record, "route:/feed")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(record, "page:/feed")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(record, "route:/photos/42\0/feed")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(record, "page:/photos/42\0/feed")).toBe(false);
    expect(record[APP_INTERCEPTION_KEY]).toEqual({
      sourceMatchedUrl: "/feed",
      sourceRouteId: "route:/feed",
      slotId: "slot:modal:/feed",
      targetMatchedUrl: "/photos/42",
      targetRouteId: "route:/photos/42",
    });
  });

  it("normalizes encoded interception proof paths before encoding route IDs", async () => {
    function TestPage(): React.ReactNode {
      return React.createElement("div", null, "Hello");
    }
    function TestLayout({ children }: { children?: React.ReactNode }): React.ReactNode {
      return children;
    }

    const route = createSyntheticRoute({
      page: createSyntheticPageModule(TestPage),
      layouts: [createSyntheticPageModule(TestLayout), createSyntheticPageModule(TestLayout)],
      layoutTreePositions: [0, 1],
      routeSegments: ["café"],
      pattern: "/café",
      slots: {
        "modal@café/@modal": {
          id: "slot:modal:/café",
          name: "modal",
          default: createSyntheticPageModule(() => null),
          layoutIndex: 1,
          routeSegments: null,
        },
      },
    });

    const result = await buildPageElements(
      createBaseOptions({
        route,
        routePath: "/photos/caf%C3%A9",
        opts: {
          interceptionContext: "/caf%C3%A9",
          interceptSourceMatchedUrl: "/caf%C3%A9",
          interceptSlotId: "slot:modal:/café",
          interceptSlotKey: "modal@café/@modal",
          interceptPage: createSyntheticPageModule(() =>
            React.createElement("div", null, "Intercepted"),
          ),
          interceptParams: { id: "café" },
        } as Record<string, unknown>,
      }),
    );
    const record = result as Record<string, unknown>;

    expect(record[APP_INTERCEPTION_KEY]).toEqual({
      sourceMatchedUrl: "/café",
      sourceRouteId: "route:/café",
      slotId: "slot:modal:/café",
      targetMatchedUrl: "/photos/café",
      targetRouteId: "route:/photos/café",
    });
  });

  it("rejects graph slot ids that diverge from the wire slot id", async () => {
    function TestPage(): React.ReactNode {
      return React.createElement("div", null, "Hello");
    }
    function TestLayout({ children }: { children?: React.ReactNode }): React.ReactNode {
      return children;
    }

    const route = createSyntheticRoute({
      page: createSyntheticPageModule(TestPage),
      layouts: [createSyntheticPageModule(TestLayout), createSyntheticPageModule(TestLayout)],
      layoutTreePositions: [0, 1],
      routeSegments: ["feed"],
      pattern: "/feed",
      slots: {
        "modal@feed/@modal": {
          id: "slot:modal:/wrong",
          name: "modal",
          default: createSyntheticPageModule(() => null),
          layoutIndex: 1,
          routeSegments: null,
        },
      },
    });

    await expect(
      buildPageElements(createBaseOptions({ route, routePath: "/feed" })),
    ).rejects.toThrow("App Router slot id mismatch");
  });

  it("does NOT call markDynamicUsage while wiring searchParams into the render tree", async () => {
    function SearchPage(): React.ReactNode {
      return React.createElement("div", null, "Search");
    }

    const route = createSyntheticRoute({
      page: createSyntheticPageModule(SearchPage),
      layouts: [],
      routeSegments: ["search"],
      pattern: "/search",
    });

    const result = await buildPageElements(
      createBaseOptions({
        route,
        routePath: "/search",
        searchParams: new URLSearchParams(""),
      }),
    );
    const record = result as Record<string, unknown>;
    const pageElement = record["page:/search"];
    expect(
      React.isValidElement<{ searchParams?: Promise<Record<string, unknown>> }>(pageElement),
    ).toBe(true);

    if (!React.isValidElement<{ searchParams?: Promise<Record<string, unknown>> }>(pageElement)) {
      throw new Error("Expected page element");
    }

    expect(markDynamicUsageMock).not.toHaveBeenCalled();
    expect(markRenderRequestApiUsageMock).not.toHaveBeenCalled();
  });

  it("keeps loading-boundary render-tree searchParams status inspection inert", async () => {
    const { searchParams } = await buildSearchPageSearchParams({ loadingBoundary: true });

    Reflect.get(searchParams, "status");

    expect(markDynamicUsageMock).not.toHaveBeenCalled();
    expect(markRenderRequestApiUsageMock).not.toHaveBeenCalled();
  });

  it("keeps non-loading render-tree searchParams await inert", async () => {
    const { searchParams } = await buildSearchPageSearchParams();

    await searchParams;

    expect(markDynamicUsageMock).not.toHaveBeenCalled();
    expect(markRenderRequestApiUsageMock).not.toHaveBeenCalled();
  });

  it("keeps loading-boundary render-tree searchParams await inert without explicit observation", async () => {
    const { searchParams } = await buildSearchPageSearchParams({ loadingBoundary: true });

    await searchParams;

    expect(markDynamicUsageMock).not.toHaveBeenCalled();
    expect(markRenderRequestApiUsageMock).not.toHaveBeenCalled();
  });

  it("keeps a cached primary page query-inert through the React render path", async () => {
    await resetUseCacheRuntime();
    const { registerCachedFunction } =
      await import("../packages/vinext/src/shims/cache-runtime.js");

    let pageCalls = 0;
    const CachedPage = registerCachedFunction(
      async ({ params }: { params: Promise<{ slug: string }> }): Promise<string> => {
        pageCalls++;
        const resolvedParams = await params;
        return `primary:${resolvedParams.slug}`;
      },
      "/fixture/app/cached/page.tsx:default",
      "",
      { appPageDefaultExport: true },
    );
    const route = createSyntheticRoute({
      page: createSyntheticPageModule(CachedPage),
      loading: { default: () => null },
      layouts: [],
      routeSegments: ["cached"],
      pattern: "/cached",
    });

    await expectCachedRenderIgnoresQuery({
      expectedText: "primary:same",
      getCallCount: () => pageCalls,
      render: (query) => buildAndRenderElement(route, "page:/cached", query),
    });
  });

  it("keeps a cached active slot page query-inert through the React render path", async () => {
    await resetUseCacheRuntime();
    const { registerCachedFunction } =
      await import("../packages/vinext/src/shims/cache-runtime.js");

    function MainPage(): React.ReactNode {
      return React.createElement("div", null, "main");
    }

    let slotCalls = 0;
    const CachedSlotPage = registerCachedFunction(
      async ({ params }: { params: Promise<Record<string, unknown>> }): Promise<string> => {
        slotCalls++;
        await params;
        return "slot:cached";
      },
      "/fixture/app/cached/@modal/page.tsx:default",
      "",
      { appPageDefaultExport: true },
    );
    const route = createSyntheticRoute({
      page: createSyntheticPageModule(MainPage),
      loading: { default: () => null },
      layouts: [],
      routeSegments: ["cached"],
      pattern: "/cached",
      slots: {
        "@modal": {
          name: "modal",
          page: createSyntheticPageModule(CachedSlotPage),
          layoutIndex: -1,
          routeSegments: [],
        },
      },
    });

    await expectCachedRenderIgnoresQuery({
      expectedText: "slot:cached",
      getCallCount: () => slotCalls,
      render: (query) => buildAndRenderElement(route, "slot:modal:/", query),
    });
  });

  it("keeps a cached intercepting slot page query-inert through the React render path", async () => {
    await resetUseCacheRuntime();
    const { registerCachedFunction } =
      await import("../packages/vinext/src/shims/cache-runtime.js");

    function MainPage(): React.ReactNode {
      return React.createElement("div", null, "main");
    }

    let interceptCalls = 0;
    const CachedInterceptPage = registerCachedFunction(
      async ({ params }: { params: Promise<Record<string, unknown>> }): Promise<string> => {
        interceptCalls++;
        await params;
        return "intercept:cached";
      },
      "/fixture/app/cached/@modal/(.)photo/page.tsx:default",
      "",
      { appPageDefaultExport: true },
    );
    const route = createSyntheticRoute({
      page: createSyntheticPageModule(MainPage),
      loading: { default: () => null },
      layouts: [],
      routeSegments: ["cached"],
      pattern: "/cached",
      slots: {
        "@modal": {
          name: "modal",
          default: createSyntheticPageModule(() => null),
          layoutIndex: -1,
          routeSegments: [],
        },
      },
    });
    const renderIntercept = async (query: string): Promise<string> => {
      const result = await buildPageElements(
        createBaseOptions({
          route,
          routePath: "/cached",
          searchParams: new URLSearchParams({ q: query }),
          opts: {
            interceptSlotKey: "@modal",
            interceptPage: createSyntheticPageModule(CachedInterceptPage),
          },
        }),
      );
      const record = result as Record<string, unknown>;
      const element = record["slot:modal:/"];
      if (!React.isValidElement(element)) {
        throw new Error("Expected intercepting slot element");
      }

      markDynamicUsageMock.mockClear();
      markRenderRequestApiUsageMock.mockClear();
      return renderNode(element);
    };

    await expectCachedRenderIgnoresQuery({
      expectedText: "intercept:cached",
      getCallCount: () => interceptCalls,
      render: renderIntercept,
    });
  });

  it("does NOT call markDynamicUsage just because the request query has content", async () => {
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
        searchParams: new URLSearchParams("q=test"),
      }),
    );

    expect(markDynamicUsageMock).not.toHaveBeenCalled();
    expect(markRenderRequestApiUsageMock).not.toHaveBeenCalled();
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

  it("passes page searchParams to active slot pages", async () => {
    function MainPage(): React.ReactNode {
      return React.createElement("div", null, "main");
    }
    let capturedSearchParams: PromiseLike<Record<string, unknown>> | undefined;
    function SlotPage(props: {
      searchParams: PromiseLike<Record<string, unknown>>;
    }): React.ReactNode {
      capturedSearchParams = props.searchParams;
      return React.createElement("span", null, "slot");
    }

    const route = createSyntheticRoute({
      page: createSyntheticPageModule(MainPage),
      layouts: [],
      routeSegments: ["feed"],
      pattern: "/feed",
      slots: {
        "@modal": {
          name: "modal",
          page: createSyntheticPageModule(SlotPage),
          layoutIndex: -1,
          routeSegments: [],
        },
      },
    });

    const result = await buildPageElements(
      createBaseOptions({
        route,
        routePath: "/feed",
        searchParams: new URLSearchParams("search=hello"),
      }),
    );

    const record = result as Record<string, unknown>;
    const slotElement = record["slot:modal:/"] as React.ReactNode;
    expect(slotElement).toBeDefined();
    await renderNode(slotElement);
    await expect(capturedSearchParams).resolves.toEqual({ search: "hello" });
  });

  it("passes page searchParams to intercepting slot pages", async () => {
    function MainPage(): React.ReactNode {
      return React.createElement("div", null, "main");
    }
    let capturedSearchParams: PromiseLike<Record<string, unknown>> | undefined;
    function InterceptPage(props: {
      searchParams: PromiseLike<Record<string, unknown>>;
    }): React.ReactNode {
      capturedSearchParams = props.searchParams;
      return React.createElement("span", null, "intercept");
    }

    const route = createSyntheticRoute({
      page: createSyntheticPageModule(MainPage),
      layouts: [],
      routeSegments: ["feed"],
      pattern: "/feed",
      slots: {
        "@modal": {
          name: "modal",
          default: createSyntheticPageModule(() => null),
          layoutIndex: -1,
          routeSegments: [],
        },
      },
    });

    const result = await buildPageElements(
      createBaseOptions({
        route,
        routePath: "/feed",
        searchParams: new URLSearchParams("search=hello"),
        opts: {
          interceptSlotKey: "@modal",
          interceptPage: createSyntheticPageModule(InterceptPage),
        },
      }),
    );

    const record = result as Record<string, unknown>;
    const slotElement = record["slot:modal:/"] as React.ReactNode;
    expect(slotElement).toBeDefined();
    await renderNode(slotElement);
    await expect(capturedSearchParams).resolves.toEqual({ search: "hello" });
  });

  it("extracts slot params from routePath, not request.url, so basePath does not break the match", async () => {
    function MainPage(): React.ReactNode {
      return React.createElement("div", null, "main");
    }
    let capturedParams: PromiseLike<AppPageParams> | undefined;
    function SlotPage(props: { params: PromiseLike<AppPageParams> }): React.ReactNode {
      capturedParams = props.params;
      return React.createElement("span", null, "slot");
    }

    // Inherited slot whose mirrored sub-page has a dynamic marker (`:name`)
    // with a different name than the route's (`:id`). The slotPatternParts
    // are app-relative — basePath was already stripped during graph build.
    const route = createSyntheticRoute({
      page: createSyntheticPageModule(MainPage),
      layouts: [],
      routeSegments: ["distinct", "[id]"],
      pattern: "/distinct/[id]",
      params: ["id"],
      slots: {
        "@bc": {
          name: "bc",
          page: createSyntheticPageModule(SlotPage),
          layoutIndex: -1,
          routeSegments: ["distinct", "[id]"],
          slotPatternParts: ["distinct", ":name"],
          slotParamNames: ["name"],
        },
      },
    });

    // Simulate a basePath-configured app: request URL still carries `/base`,
    // but the entry passes the cleaned pathname as routePath. The fix must
    // match against routePath, not against `new URL(request.url).pathname`.
    const result = await buildPageElements({
      ...createBaseOptions({
        route,
        params: { id: "alice" },
        routePath: "/distinct/alice",
      }),
      pageRequest: {
        opts: null,
        searchParams: null,
        isRscRequest: false,
        request: new Request("http://localhost/base/distinct/alice"),
        mountedSlotsHeader: null,
      },
    });

    const record = result as Record<string, unknown>;
    const slotElement = record["slot:bc:/"] as React.ReactNode;
    expect(slotElement).toBeDefined();
    await renderNode(slotElement);
    const slotParams = await capturedParams;
    // Without the fix, urlParts would be ["base","distinct","alice"], the
    // pattern match would fail, and slotParams would silently fall back to
    // the route's matched params ({ id: "alice" }) — leaving the slot
    // page's `name` undefined. With the fix, the slot gets its own params.
    expect(slotParams).toEqual({ name: "alice" });
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

describe("probeAppPage", () => {
  beforeEach(() => {
    markDynamicUsageMock.mockClear();
    markRenderRequestApiUsageMock.mockClear();
  });

  it("calls markDynamicUsage when the page awaits searchParams, even when the query is empty", async () => {
    async function SearchPage({
      searchParams,
    }: {
      searchParams: Promise<Record<string, unknown>>;
    }): Promise<React.ReactNode> {
      await searchParams;
      return React.createElement("div", null, "Search");
    }

    await Promise.resolve(
      probeAppPage({
        asyncRouteParams: makeThenableParams({}),
        pageComponent: SearchPage,
        searchParams: new URLSearchParams(""),
      }),
    );

    expect(markDynamicUsageMock).toHaveBeenCalled();
    expect(markRenderRequestApiUsageMock).toHaveBeenCalledWith("searchParams");
  });

  it("calls markDynamicUsage when a returned server component consumes spread searchParams", async () => {
    async function Child({
      searchParams,
    }: {
      searchParams: Promise<Record<string, unknown>>;
    }): Promise<React.ReactNode> {
      await searchParams;
      return React.createElement("div", null, "Child");
    }

    function SearchPage(props: {
      searchParams: Promise<Record<string, unknown>>;
    }): React.ReactNode {
      return React.createElement(Child, props);
    }

    await Promise.resolve(
      probeAppPage({
        asyncRouteParams: makeThenableParams({}),
        pageComponent: SearchPage,
        searchParams: new URLSearchParams("q=test"),
      }),
    );

    expect(markDynamicUsageMock).toHaveBeenCalled();
    expect(markRenderRequestApiUsageMock).toHaveBeenCalledWith("searchParams");
  });

  it("does NOT call markDynamicUsage just because the request query has content", () => {
    function NoSearchPage(): React.ReactNode {
      return React.createElement("div", null, "No Search");
    }

    probeAppPage({
      asyncRouteParams: makeThenableParams({}),
      pageComponent: NoSearchPage,
      searchParams: new URLSearchParams("q=test"),
    });

    expect(markDynamicUsageMock).not.toHaveBeenCalled();
    expect(markRenderRequestApiUsageMock).not.toHaveBeenCalled();
  });
});
