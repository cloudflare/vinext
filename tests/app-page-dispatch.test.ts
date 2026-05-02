import React from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { dispatchAppPage } from "../packages/vinext/src/server/app-page-dispatch.js";
import type { AppPageMiddlewareContext } from "../packages/vinext/src/server/app-page-response.js";
import type { ISRCacheEntry } from "../packages/vinext/src/server/isr-cache.js";
import type { CachedAppPageValue } from "../packages/vinext/src/shims/cache.js";

type TestRoute = {
  error?: { default?: unknown } | null;
  errors?: readonly ({ default?: unknown } | null | undefined)[];
  forbiddens?: readonly ({ default?: unknown } | null | undefined)[];
  isDynamic: boolean;
  layouts: readonly { default?: unknown }[];
  layoutTreePositions?: readonly number[];
  loading?: { default?: unknown } | null;
  notFounds?: readonly ({ default?: unknown } | null | undefined)[];
  params: readonly string[];
  pattern: string;
  routeSegments: readonly string[];
  unauthorizeds?: readonly ({ default?: unknown } | null | undefined)[];
};
type DispatchOptions = Parameters<typeof dispatchAppPage<TestRoute>>[0];

function createStream(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(new TextEncoder().encode(chunk));
      }
      controller.close();
    },
  });
}

function buildISRCacheEntry(value: CachedAppPageValue, isStale = false): ISRCacheEntry {
  return {
    isStale,
    value: {
      lastModified: Date.now(),
      value,
    },
  };
}

function buildCachedAppPageValue(
  html: string,
  rscData?: ArrayBuffer,
  status?: number,
): CachedAppPageValue {
  return {
    kind: "APP_PAGE",
    html,
    rscData,
    headers: undefined,
    postponed: undefined,
    status,
  };
}

function createRoute(overrides: Partial<TestRoute> = {}): TestRoute {
  return {
    isDynamic: false,
    layouts: [],
    params: [],
    pattern: "/posts/[slug]",
    routeSegments: ["posts", "[slug]"],
    ...overrides,
  };
}

function createDispatchOptions(
  overrides: {
    buildPageElement?: DispatchOptions["buildPageElement"];
    clearRequestContext?: DispatchOptions["clearRequestContext"];
    generateStaticParams?: DispatchOptions["generateStaticParams"];
    isProduction?: boolean;
    isRscRequest?: boolean;
    isrGet?: DispatchOptions["isrGet"];
    middlewareContext?: AppPageMiddlewareContext;
    renderToReadableStream?: DispatchOptions["renderToReadableStream"];
    request?: Request;
    revalidateSeconds?: number | null;
    route?: TestRoute;
    searchParams?: URLSearchParams;
    setNavigationContext?: DispatchOptions["setNavigationContext"];
  } = {},
) {
  const route = overrides.route ?? createRoute();
  const buildPageElement =
    overrides.buildPageElement ?? (async () => React.createElement("main", null, "page"));
  const clearRequestContext = overrides.clearRequestContext ?? (() => {});
  const isrGet = overrides.isrGet ?? (async () => null);
  const setNavigationContext = overrides.setNavigationContext ?? (() => {});
  const renderToReadableStream: DispatchOptions["renderToReadableStream"] =
    overrides.renderToReadableStream ?? (() => createStream(["flight"]));
  const options: DispatchOptions = {
    buildPageElement,
    cleanPathname: "/posts/hello",
    clearRequestContext,
    createRscOnErrorHandler() {
      return () => null;
    },
    findIntercept() {
      return null;
    },
    generateStaticParams: overrides.generateStaticParams ?? null,
    getFontLinks() {
      return [];
    },
    getFontPreloads() {
      return [];
    },
    getFontStyles() {
      return [];
    },
    getNavigationContext() {
      return { pathname: "/posts/hello" };
    },
    getSourceRoute() {
      return undefined;
    },
    hasGenerateStaticParams: typeof overrides.generateStaticParams === "function",
    hasPageDefaultExport: true,
    hasPageModule: true,
    handlerStart: 10,
    interceptionContext: null,
    isProduction: overrides.isProduction ?? false,
    isRscRequest: overrides.isRscRequest ?? false,
    isrGet,
    isrHtmlKey(pathname: string) {
      return `html:${pathname}`;
    },
    isrRscKey(pathname: string, mountedSlotsHeader?: string | null) {
      return mountedSlotsHeader ? `rsc:${pathname}:${mountedSlotsHeader}` : `rsc:${pathname}`;
    },
    isrSet: vi.fn(async () => {}),
    async loadSsrHandler() {
      return {
        async handleSsr() {
          return createStream(["<html>page</html>"]);
        },
      };
    },
    middlewareContext: overrides.middlewareContext ?? {
      headers: null,
      status: null,
    },
    params: { slug: "hello" },
    probeLayoutAt() {
      return null;
    },
    probePage() {
      return null;
    },
    renderErrorBoundaryPage: vi.fn(async () => null),
    renderHttpAccessFallbackPage: vi.fn(async () => null),
    renderToReadableStream,
    request: overrides.request ?? new Request("https://example.test/posts/hello"),
    revalidateSeconds: overrides.revalidateSeconds ?? null,
    route,
    runWithSuppressedHookWarning<T>(probe: () => Promise<T>) {
      return probe();
    },
    scheduleBackgroundRegeneration: vi.fn(),
    searchParams: overrides.searchParams ?? new URLSearchParams(),
    setNavigationContext,
  };

  return {
    buildPageElement,
    clearRequestContext,
    isrGet,
    route,
    setNavigationContext,
    options,
  };
}

describe("app page dispatch", () => {
  it("serves cached production HTML instead of revalidating params or rendering", async () => {
    const { options } = createDispatchOptions({
      async buildPageElement() {
        throw new Error("cache hit should not render the page");
      },
      async generateStaticParams() {
        throw new Error("cache hit should not validate static params");
      },
      isProduction: true,
      isrGet: vi.fn(async () => buildISRCacheEntry(buildCachedAppPageValue("<html>cached</html>"))),
      revalidateSeconds: 60,
      route: createRoute({ isDynamic: true, params: ["slug"] }),
    });

    const response = await dispatchAppPage(options);

    expect(response.status).toBe(200);
    expect(response.headers.get("x-vinext-cache")).toBe("HIT");
    await expect(response.text()).resolves.toBe("<html>cached</html>");
  });

  it("returns method policy responses instead of rendering unsupported methods", async () => {
    const { options } = createDispatchOptions({
      async buildPageElement() {
        throw new Error("unsupported methods should not render the page");
      },
      request: new Request("https://example.test/posts/hello", { method: "POST" }),
    });

    const response = await dispatchAppPage(options);

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
  });

  it("returns not found for dynamicParams=false paths outside generated params", async () => {
    const { options } = createDispatchOptions({
      async buildPageElement() {
        throw new Error("unknown static params should not render the page");
      },
      async generateStaticParams() {
        return [{ slug: "known" }];
      },
      route: createRoute({ isDynamic: true, params: ["slug"] }),
    });

    const response = await dispatchAppPage({
      ...options,
      dynamicParamsConfig: false,
    });

    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toBe("Not Found");
  });

  it("serves intercepted RSC source-route payloads with middleware response state", async () => {
    const sourceRoute = createRoute({ params: [], pattern: "/feed", routeSegments: ["feed"] });
    const currentRoute = createRoute({ params: ["id"], pattern: "/photos/[id]" });
    const middlewareHeaders = new Headers({ "x-from-middleware": "yes" });
    const { options } = createDispatchOptions({
      async buildPageElement(route, params, opts) {
        return `${route.pattern}:${JSON.stringify(params)}:${opts?.interceptSlotKey ?? "direct"}`;
      },
      isRscRequest: true,
      middlewareContext: {
        headers: middlewareHeaders,
        status: 202,
      },
      renderToReadableStream(element) {
        if (typeof element !== "string") {
          throw new Error("expected intercepted payload to be rendered from a string element");
        }
        return createStream([element]);
      },
      route: currentRoute,
      searchParams: new URLSearchParams("from=feed"),
    });

    const response = await dispatchAppPage({
      ...options,
      findIntercept() {
        return {
          matchedParams: { id: "123" },
          page: { default: "modal-page" },
          slotKey: "modal@app/feed/@modal",
          sourceRouteIndex: 1,
        };
      },
      getSourceRoute(sourceRouteIndex) {
        return sourceRouteIndex === 1 ? sourceRoute : undefined;
      },
    });

    expect(response.status).toBe(202);
    expect(response.headers.get("content-type")).toBe("text/x-component; charset=utf-8");
    expect(response.headers.get("x-from-middleware")).toBe("yes");
    await expect(response.text()).resolves.toBe("/feed:{}:modal@app/feed/@modal");
  });
});
