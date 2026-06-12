import React from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  APP_ROOT_LAYOUT_KEY,
  APP_ROUTE_KEY,
  AppElementsWire,
} from "../packages/vinext/src/server/app-elements.js";
import { dispatchAppPage } from "../packages/vinext/src/server/app-page-dispatch.js";
import { createClientReuseManifestHeaderFromVisibleAppState } from "../packages/vinext/src/server/app-browser-client-reuse-manifest.js";
import type { AppLayoutParamAccessTracker } from "../packages/vinext/src/server/app-layout-param-observation.js";
import {
  buildPageElements,
  type AppPageBuildRoute,
} from "../packages/vinext/src/server/app-page-element-builder.js";
import {
  resolveAppPageSegmentParamScopeKeys,
  resolveAppPageSegmentParams,
} from "../packages/vinext/src/server/app-page-params.js";
import { createAppPageTreePath } from "../packages/vinext/src/server/app-page-route-wiring.js";
import {
  createArtifactCompatibilityEnvelope,
  createArtifactCompatibilityGraphVersion,
} from "../packages/vinext/src/server/artifact-compatibility.js";
import {
  parseClientReuseManifestHeader,
  type ClientReuseManifestParseResult,
} from "../packages/vinext/src/server/client-reuse-manifest.js";
import {
  buildRenderObservation,
  buildRenderRequestApiObservations,
  type RenderObservation,
} from "../packages/vinext/src/server/cache-proof.js";
import { makeThenableParams } from "../packages/vinext/src/shims/thenable-params.js";
import { connection } from "../packages/vinext/src/shims/server.js";
import type { AppPageMiddlewareContext } from "../packages/vinext/src/server/app-page-response.js";
import type { ISRCacheEntry } from "../packages/vinext/src/server/isr-cache.js";
import type { CachedAppPageValue } from "../packages/vinext/src/shims/cache.js";
import {
  runWithExecutionContext,
  type ExecutionContextLike,
} from "../packages/vinext/src/shims/request-context.js";
import {
  consumeDynamicUsage,
  consumeRenderRequestApiUsage,
  markDynamicUsage,
  markRenderRequestApiUsage,
} from "../packages/vinext/src/shims/headers.js";
import { isPromiseLike } from "../packages/vinext/src/utils/promise.js";
import { isUnknownRecord } from "../packages/vinext/src/utils/record.js";

type TestRoute = {
  __buildTimeClassifications?: ReadonlyMap<number, "static" | "dynamic"> | null;
  error?: { default?: unknown } | null;
  errors?: readonly ({ default?: unknown } | null | undefined)[];
  forbiddens?: readonly ({ default?: unknown } | null | undefined)[];
  isDynamic: boolean;
  layouts: readonly { default?: unknown; dynamic?: unknown; revalidate?: unknown }[];
  layoutTreePositions?: readonly number[];
  loading?: { default?: unknown } | null;
  notFounds?: readonly ({ default?: unknown } | null | undefined)[];
  params: readonly string[];
  pattern: string;
  routeSegments: readonly string[];
  slots?: Readonly<
    Record<
      string,
      {
        default?: { default?: unknown } | null;
        page?: { default?: unknown } | null;
        slotParamNames?: readonly string[] | null;
        slotPatternParts?: readonly string[] | null;
      }
    >
  >;
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

function captureRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !React.isValidElement(value) && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new Error("Expected AppElements record payload");
}

function isCachedAppPageValue(value: unknown): value is CachedAppPageValue {
  return isUnknownRecord(value) && value.kind === "APP_PAGE";
}

function isQueryRecord(value: unknown): value is Record<string, string | string[] | undefined> {
  return isUnknownRecord(value);
}

function isDispatchReactNode(value: unknown): value is React.ReactNode {
  if (
    value === null ||
    value === undefined ||
    typeof value === "boolean" ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "bigint"
  ) {
    return true;
  }
  if (React.isValidElement(value)) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every(isDispatchReactNode);
  }
  return false;
}

function toDispatchElementRecord(
  elements: Readonly<Record<string, unknown>>,
): Readonly<Record<string, React.ReactNode>> {
  const dispatchElements: Record<string, React.ReactNode> = {};
  for (const [key, value] of Object.entries(elements)) {
    if (isDispatchReactNode(value)) {
      dispatchElements[key] = value;
    }
  }
  return dispatchElements;
}

function findPageElement(payload: unknown): React.ReactElement | null {
  const record = captureRecord(payload);
  for (const [key, value] of Object.entries(record)) {
    if (key.startsWith("page:") && React.isValidElement(value)) {
      return value;
    }
  }
  return null;
}

async function renderReactNodeText(node: unknown): Promise<string> {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number" || typeof node === "bigint") {
    return String(node);
  }
  if (isPromiseLike(node)) {
    return renderReactNodeText(await node);
  }
  if (Array.isArray(node)) {
    const rendered = await Promise.all(node.map((child) => renderReactNodeText(child)));
    return rendered.join("");
  }
  if (!React.isValidElement<{ children?: unknown }>(node)) return "";

  if (node.type === React.Fragment || typeof node.type === "string") {
    return renderReactNodeText(node.props.children);
  }
  if (typeof node.type === "function") {
    return renderReactNodeText(Reflect.apply(node.type, undefined, [node.props]));
  }
  return "";
}

function renderPagePayloadToStream(payload: unknown): ReadableStream<Uint8Array> {
  let didRender = false;
  return new ReadableStream({
    async pull(controller) {
      if (didRender) {
        controller.close();
        return;
      }
      didRender = true;
      const pageElement = findPageElement(payload);
      const text = pageElement ? await renderReactNodeText(pageElement) : "";
      controller.enqueue(new TextEncoder().encode(text));
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
  renderObservation?: RenderObservation,
): CachedAppPageValue {
  const value: CachedAppPageValue = {
    kind: "APP_PAGE",
    html,
    rscData,
    headers: undefined,
    postponed: undefined,
    status,
  };
  if (renderObservation) {
    value.renderObservation = renderObservation;
  }
  return value;
}

function expectCachedAppPageSearchParamsObservation(value: unknown, html: string): void {
  expect(isCachedAppPageValue(value)).toBe(true);
  if (!isCachedAppPageValue(value)) {
    throw new Error("Expected an APP_PAGE cache value");
  }
  expect(value.html).toBe(html);
  expect(
    value.renderObservation?.requestApis.find((requestApi) => requestApi.kind === "searchParams")
      ?.status,
  ).toBe("observed");
}

function buildQueryInvariantRenderObservation(): RenderObservation {
  return buildRenderObservation({
    boundaryOutcome: { kind: "success" },
    cacheability: "public",
    cacheTags: [],
    completeness: "complete",
    dynamicFetches: [],
    output: {
      kind: "app-html",
      renderEpoch: null,
      rootBoundaryId: null,
      routeId: "route:/posts/[slug]",
    },
    pathTags: [],
    requestApis: buildRenderRequestApiObservations({
      completeness: "complete",
      observed: [],
    }),
  });
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
    cleanPathname?: string;
    clearRequestContext?: DispatchOptions["clearRequestContext"];
    dynamicConfig?: DispatchOptions["dynamicConfig"];
    findIntercept?: DispatchOptions["findIntercept"];
    generateStaticParams?: DispatchOptions["generateStaticParams"];
    formState?: DispatchOptions["formState"];
    getSourceRoute?: DispatchOptions["getSourceRoute"];
    actionError?: DispatchOptions["actionError"];
    actionFailed?: DispatchOptions["actionFailed"];
    interceptionContext?: string | null;
    isProgressiveActionRender?: DispatchOptions["isProgressiveActionRender"];
    isProduction?: boolean;
    isRscRequest?: boolean;
    isrRscKey?: DispatchOptions["isrRscKey"];
    isrGet?: DispatchOptions["isrGet"];
    isrSet?: DispatchOptions["isrSet"];
    clientReuseManifest?: ClientReuseManifestParseResult;
    loadSsrHandler?: DispatchOptions["loadSsrHandler"];
    middlewareContext?: AppPageMiddlewareContext;
    mountedSlotsHeader?: string | null;
    params?: Record<string, string | string[]>;
    probeLayoutAt?: DispatchOptions["probeLayoutAt"];
    probePage?: DispatchOptions["probePage"];
    renderToReadableStream?: DispatchOptions["renderToReadableStream"];
    request?: Request;
    revalidateSeconds?: number | null;
    resolveRouteFetchCacheMode?: DispatchOptions["resolveRouteFetchCacheMode"];
    resolveRouteDynamicConfig?: DispatchOptions["resolveRouteDynamicConfig"];
    route?: TestRoute;
    scheduleBackgroundRegeneration?: DispatchOptions["scheduleBackgroundRegeneration"];
    searchParams?: URLSearchParams;
    setNavigationContext?: DispatchOptions["setNavigationContext"];
  } = {},
) {
  const route = overrides.route ?? createRoute();
  const buildPageElement =
    overrides.buildPageElement ?? (async () => React.createElement("main", null, "page"));
  const clearRequestContext = overrides.clearRequestContext ?? (() => {});
  const isrGet = overrides.isrGet ?? (async () => null);
  const params = overrides.params ?? { slug: "hello" };
  const setNavigationContext = overrides.setNavigationContext ?? (() => {});
  const renderToReadableStream: DispatchOptions["renderToReadableStream"] =
    overrides.renderToReadableStream ?? (() => createStream(["flight"]));
  const loadSsrHandler: DispatchOptions["loadSsrHandler"] =
    overrides.loadSsrHandler ??
    (async () => ({
      async handleSsr() {
        return createStream(["<html>page</html>"]);
      },
    }));
  const options: DispatchOptions = {
    buildPageElement,
    cleanPathname: overrides.cleanPathname ?? "/posts/hello",
    clearRequestContext,
    createRscOnErrorHandler() {
      return () => null;
    },
    draftModeSecret: "draft-secret",
    dynamicConfig: overrides.dynamicConfig,
    findIntercept: overrides.findIntercept ?? (() => null),
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
      return {
        pathname: "/posts/hello",
        searchParams: new URLSearchParams(),
        params: { slug: "hello" },
      };
    },
    getSourceRoute: overrides.getSourceRoute ?? (() => undefined),
    hasGenerateStaticParams: typeof overrides.generateStaticParams === "function",
    hasPageDefaultExport: true,
    hasPageModule: true,
    handlerStart: 10,
    formState: overrides.formState,
    actionError: overrides.actionError,
    actionFailed: overrides.actionFailed,
    interceptionContext: overrides.interceptionContext ?? null,
    isProgressiveActionRender: overrides.isProgressiveActionRender,
    isProduction: overrides.isProduction ?? false,
    isRscRequest: overrides.isRscRequest ?? false,
    isrGet,
    isrHtmlKey(pathname: string) {
      return `html:${pathname}`;
    },
    isrRscKey:
      overrides.isrRscKey ??
      ((pathname: string, mountedSlotsHeader?: string | null) =>
        mountedSlotsHeader ? `rsc:${pathname}:${mountedSlotsHeader}` : `rsc:${pathname}`),
    isrSet: overrides.isrSet ?? vi.fn(async () => {}),
    loadSsrHandler,
    clientReuseManifest: overrides.clientReuseManifest ?? { kind: "absent" },
    middlewareContext: overrides.middlewareContext ?? {
      headers: null,
      status: null,
    },
    mountedSlotsHeader: overrides.mountedSlotsHeader,
    params,
    probeLayoutAt: overrides.probeLayoutAt ?? createLayoutParamProbe(route, params, []),
    probePage: overrides.probePage ?? (() => null),
    renderErrorBoundaryPage: vi.fn(async () => null),
    renderHttpAccessFallbackPage: vi.fn(async () => null),
    renderToReadableStream,
    request: overrides.request ?? new Request("https://example.test/posts/hello"),
    revalidateSeconds: overrides.revalidateSeconds ?? null,
    resolveRouteFetchCacheMode: overrides.resolveRouteFetchCacheMode,
    resolveRouteDynamicConfig: overrides.resolveRouteDynamicConfig,
    route,
    runWithSuppressedHookWarning<T>(probe: () => Promise<T>) {
      return probe();
    },
    scheduleBackgroundRegeneration: overrides.scheduleBackgroundRegeneration ?? vi.fn(),
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

function createVerifiedStaticLayoutManifest(input: {
  deploymentVersion: string;
  layoutId?: string;
  layoutIds?: readonly string[];
  rootBoundaryId: string;
  routeId: string;
  routePattern: string;
}): ClientReuseManifestParseResult {
  const layoutIds = input.layoutIds ?? (input.layoutId ? [input.layoutId] : []);
  if (layoutIds.length === 0) {
    throw new Error("Expected at least one static layout manifest entry");
  }
  const artifactCompatibility = createArtifactCompatibilityEnvelope({
    deploymentVersion: input.deploymentVersion,
    graphVersion: createArtifactCompatibilityGraphVersion({
      routePattern: input.routePattern,
      rootBoundaryId: input.rootBoundaryId,
    }),
    rootBoundaryId: input.rootBoundaryId,
  });
  const retainedLayouts = Object.fromEntries(
    layoutIds.map((layoutId) => [layoutId, `retained-${layoutId}`]),
  );
  const layoutFlags: Record<string, "s"> = {};
  for (const layoutId of layoutIds) {
    layoutFlags[layoutId] = "s";
  }
  const header = createClientReuseManifestHeaderFromVisibleAppState({
    elements: {
      ...AppElementsWire.createMetadataEntries({
        interceptionContext: null,
        layoutIds,
        rootLayoutTreePath: input.rootBoundaryId,
        routeId: input.routeId,
      }),
      [AppElementsWire.keys.artifactCompatibility]: artifactCompatibility,
      [AppElementsWire.keys.layoutFlags]: layoutFlags,
      ...retainedLayouts,
    },
    visibleCommitVersion: 1,
  });
  if (header === null) {
    throw new Error("Expected retained static layout manifest");
  }
  return parseClientReuseManifestHeader(header);
}

type LayoutParamProbeReader = (params: unknown) => unknown;

function createLayoutParamProbe(
  route: TestRoute,
  matchedParams: Record<string, string | string[]>,
  readers: readonly (LayoutParamProbeReader | null | undefined)[],
): DispatchOptions["probeLayoutAt"] {
  return (layoutIndex, layoutParamAccess) => {
    const treePath = createAppPageTreePath(
      route.routeSegments,
      route.layoutTreePositions?.[layoutIndex] ?? 0,
    );
    const layoutId = AppElementsWire.encodeLayoutId(treePath);
    const runProbe = (tracker: AppLayoutParamAccessTracker | undefined) => {
      const segmentParams = resolveAppPageSegmentParams(
        route.routeSegments,
        route.layoutTreePositions?.[layoutIndex] ?? 0,
        matchedParams,
      );
      tracker?.recordLayoutParamScope(
        layoutId,
        resolveAppPageSegmentParamScopeKeys(
          route.routeSegments,
          route.layoutTreePositions?.[layoutIndex] ?? 0,
        ),
      );
      const revalidate = route.layouts[layoutIndex]?.revalidate;
      if (typeof revalidate === "number" && Number.isFinite(revalidate) && revalidate > 0) {
        tracker?.recordLayoutFiniteRevalidate(layoutId, revalidate);
      }
      const params = makeThenableParams(
        segmentParams,
        tracker?.createThenableParamsObserver(layoutId),
      );
      return readers[layoutIndex]?.(params) ?? null;
    };

    return layoutParamAccess
      ? layoutParamAccess.runLayoutProbe(layoutId, () => runProbe(layoutParamAccess))
      : runProbe(undefined);
  };
}

describe("app page dispatch", () => {
  it("does not reuse a speculative connection() page probe", async () => {
    const probePage = vi.fn(async () => {
      await connection();
    });
    const { options } = createDispatchOptions({ probePage });

    const response = await Promise.race([
      dispatchAppPage(options),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("dispatch timed out")), 250);
      }),
    ]);

    expect(response.status).toBe(200);
    expect(probePage).toHaveBeenCalledTimes(1);
    await expect(response.text()).resolves.toBe("<html>page</html>");
  });

  afterEach(() => {
    consumeDynamicUsage();
    consumeRenderRequestApiUsage();
    vi.unstubAllEnvs();
  });

  it("serves cached production HTML instead of revalidating params or rendering", async () => {
    const probePage = vi.fn(() => {
      throw new Error("cache hit must not execute page code");
    });
    const { options } = createDispatchOptions({
      async buildPageElement() {
        throw new Error("cache hit should not render the page");
      },
      async generateStaticParams() {
        throw new Error("cache hit should not validate static params");
      },
      isProduction: true,
      isrGet: vi.fn(async () => buildISRCacheEntry(buildCachedAppPageValue("<html>cached</html>"))),
      probePage,
      revalidateSeconds: 60,
      route: createRoute({ isDynamic: true, params: ["slug"] }),
    });

    const response = await dispatchAppPage(options);

    expect(response.status).toBe(200);
    expect(probePage).not.toHaveBeenCalled();
    expect(response.headers.get("x-vinext-cache")).toBe("HIT");
    await expect(response.text()).resolves.toBe("<html>cached</html>");
  });

  it("treats unproofed cached production HTML as a miss for query-bearing requests", async () => {
    const isrGet = vi.fn(async () =>
      buildISRCacheEntry(buildCachedAppPageValue("<html>cached empty query</html>")),
    );
    const { options } = createDispatchOptions({
      isProduction: true,
      isrGet,
      probePage() {
        markDynamicUsage();
        markRenderRequestApiUsage("searchParams");
        return null;
      },
      revalidateSeconds: 60,
      searchParams: new URLSearchParams("search=hello"),
    });

    const response = await dispatchAppPage(options);

    expect(isrGet).toHaveBeenCalled();
    expect(response.headers.get("x-vinext-cache")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store, must-revalidate");
    await expect(response.text()).resolves.toBe("<html>page</html>");
  });

  it("serves cached production HTML when searchParams is only mentioned but not accessed", async () => {
    const isrGet = vi.fn(async () =>
      buildISRCacheEntry(
        buildCachedAppPageValue(
          "<html>cached static page</html>",
          undefined,
          undefined,
          buildQueryInvariantRenderObservation(),
        ),
      ),
    );
    const probePage = vi.fn(() => {
      const unusedCommentOnlySearchParams = "searchParams";
      expect(unusedCommentOnlySearchParams).toBe("searchParams");
      return null;
    });
    const { options } = createDispatchOptions({
      isProduction: true,
      isrGet,
      probePage,
      revalidateSeconds: 60,
      searchParams: new URLSearchParams("search=hello"),
    });

    const response = await dispatchAppPage(options);

    expect(isrGet).toHaveBeenCalled();
    expect(probePage).not.toHaveBeenCalled();
    expect(response.headers.get("x-vinext-cache")).toBe("HIT");
    await expect(response.text()).resolves.toBe("<html>cached static page</html>");
  });

  it("lets force-static override observed searchParams access", async () => {
    const isrGet = vi.fn(async () =>
      buildISRCacheEntry(buildCachedAppPageValue("<html>cached force static</html>")),
    );
    const { options } = createDispatchOptions({
      dynamicConfig: "force-static",
      isProduction: true,
      isrGet,
      probePage() {
        markDynamicUsage();
        markRenderRequestApiUsage("searchParams");
        return null;
      },
      revalidateSeconds: 60,
      searchParams: new URLSearchParams("search=hello"),
    });

    const response = await dispatchAppPage(options);

    expect(isrGet).toHaveBeenCalled();
    expect(response.headers.get("x-vinext-cache")).toBe("HIT");
    await expect(response.text()).resolves.toBe("<html>cached force static</html>");
  });

  it("does not write query-invariant cache entries when loading-boundary render awaits searchParams", async () => {
    async function Page(props: Record<string, unknown>): Promise<React.ReactNode> {
      const query = isPromiseLike(props.searchParams) ? await props.searchParams : {};
      if (!isQueryRecord(query)) {
        throw new Error("Expected searchParams to resolve to a query record");
      }
      return React.createElement("h1", null, query.q ?? "");
    }

    const route = createRoute({
      loading: { default: () => null },
      pattern: "/loading-search",
      routeSegments: ["loading-search"],
    });
    const cache = new Map<string, ISRCacheEntry>();
    const isrGet = vi.fn(async (key: string) => cache.get(key) ?? null);
    const isrSet = vi.fn<DispatchOptions["isrSet"]>(async (key, data) => {
      cache.set(key, {
        isStale: false,
        value: {
          lastModified: Date.now(),
          value: data,
        },
      });
    });
    const waitUntilPromises: Promise<unknown>[] = [];
    const executionContext = {
      waitUntil(promise) {
        waitUntilPromises.push(promise);
      },
    } satisfies ExecutionContextLike;
    const buildPageElement: DispatchOptions["buildPageElement"] = (
      _route,
      params,
      _opts,
      searchParams,
      layoutParamAccess?: AppLayoutParamAccessTracker,
    ) => {
      const buildRoute: AppPageBuildRoute = {
        layouts: [],
        loading: { default: () => null },
        page: { default: Page },
        pattern: "/loading-search",
        routeSegments: ["loading-search"],
      };
      return buildPageElements({
        layoutParamAccess,
        metadataRoutes: [],
        params,
        pageRequest: {
          isRscRequest: false,
          mountedSlotsHeader: null,
          opts: undefined,
          request: new Request(`https://example.test/loading-search?${searchParams}`),
          searchParams,
        },
        route: buildRoute,
        routePath: "/loading-search",
      }).then(toDispatchElementRecord);
    };
    const loadSsrHandler: DispatchOptions["loadSsrHandler"] = async () => ({
      async handleSsr(rscStream, _navigationContext, _fontData, captureOptions) {
        void captureOptions?.sideStream?.cancel().catch(() => {});
        const renderedText = await new Response(rscStream).text();
        return createStream([`<html>${renderedText}</html>`]);
      },
    });

    async function requestWithQuery(q: string): Promise<Response> {
      waitUntilPromises.length = 0;
      const { options } = createDispatchOptions({
        buildPageElement,
        cleanPathname: "/loading-search",
        isProduction: true,
        isrGet,
        isrSet,
        loadSsrHandler,
        probePage() {
          throw new Error("loading.tsx should skip the eager page probe");
        },
        renderToReadableStream: renderPagePayloadToStream,
        revalidateSeconds: 60,
        route,
        searchParams: new URLSearchParams({ q }),
      });

      const response = await runWithExecutionContext(executionContext, () =>
        dispatchAppPage(options),
      );
      await Promise.all(waitUntilPromises.splice(0));
      return response;
    }

    const firstResponse = await requestWithQuery("first");
    expect(firstResponse.headers.get("x-vinext-cache")).not.toBe("HIT");
    expect(firstResponse.headers.get("cache-control")).toContain("no-store");
    await expect(firstResponse.text()).resolves.toBe("<html>first</html>");
    const firstCachedValue = cache.get("html:/loading-search")?.value.value;
    if (firstCachedValue) {
      expectCachedAppPageSearchParamsObservation(firstCachedValue, "<html>first</html>");
    } else {
      expect(isrSet).not.toHaveBeenCalled();
    }

    const secondResponse = await requestWithQuery("second");
    expect(secondResponse.headers.get("x-vinext-cache")).not.toBe("HIT");
    await expect(secondResponse.text()).resolves.toBe("<html>second</html>");
    expect(isrGet).toHaveBeenCalledTimes(2);
    const secondCachedValue = cache.get("html:/loading-search")?.value.value;
    if (secondCachedValue) {
      expectCachedAppPageSearchParamsObservation(secondCachedValue, "<html>second</html>");
    }
  });

  it("bypasses cached production HTML when draft mode is enabled", async () => {
    const isrGet = vi.fn(async () =>
      buildISRCacheEntry(buildCachedAppPageValue("<html>stale</html>")),
    );
    const { options } = createDispatchOptions({
      buildPageElement: vi.fn(async () => React.createElement("main", null, "draft page")),
      isProduction: true,
      isrGet,
      request: new Request("https://example.test/posts/hello", {
        headers: { Cookie: "__prerender_bypass=draft-secret" },
      }),
      revalidateSeconds: 60,
      renderToReadableStream() {
        return createStream(["flight"]);
      },
    });

    const response = await dispatchAppPage(options);

    expect(isrGet).not.toHaveBeenCalled();
    expect(response.headers.get("x-vinext-cache")).toBeNull();
    await expect(response.text()).resolves.toBe("<html>page</html>");
  });

  it("bypasses cached production HTML when rendering action form state", async () => {
    const formState = ["action-result", "key-path", "reference-id", 1] as never;
    const isrGet = vi.fn(async () =>
      buildISRCacheEntry(buildCachedAppPageValue("<html>cached initial state</html>")),
    );
    const { options } = createDispatchOptions({
      formState,
      isProgressiveActionRender: true,
      isProduction: true,
      isrGet,
      revalidateSeconds: 60,
    });

    const response = await dispatchAppPage(options);

    expect(isrGet).not.toHaveBeenCalled();
    expect(response.headers.get("x-vinext-cache")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store, must-revalidate");
    await expect(response.text()).resolves.toBe("<html>page</html>");
  });

  it("bypasses cached production HTML when a progressive action returns no form state", async () => {
    const isrGet = vi.fn(async () =>
      buildISRCacheEntry(buildCachedAppPageValue("<html>cached initial state</html>")),
    );
    const { options } = createDispatchOptions({
      isProgressiveActionRender: true,
      isProduction: true,
      isrGet,
      revalidateSeconds: 60,
    });

    const response = await dispatchAppPage(options);

    expect(isrGet).not.toHaveBeenCalled();
    expect(options.isrSet).not.toHaveBeenCalled();
    expect(response.headers.get("x-vinext-cache")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store, must-revalidate");
    await expect(response.text()).resolves.toBe("<html>page</html>");
  });

  it("renders not-found HTML when a progressive action calls notFound()", async () => {
    const buildPageElement = vi.fn(async () => React.createElement("main", null, "page"));
    const renderHttpAccessFallbackPage = vi.fn(
      async () => new Response("<html>not found</html>", { status: 404 }),
    );
    const { options } = createDispatchOptions({
      actionError: { digest: "NEXT_HTTP_ERROR_FALLBACK;404" },
      actionFailed: true,
      buildPageElement,
      isProgressiveActionRender: true,
    });
    options.renderHttpAccessFallbackPage = renderHttpAccessFallbackPage;

    const response = await dispatchAppPage(options);

    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toBe("<html>not found</html>");
    expect(buildPageElement).not.toHaveBeenCalled();
    expect(renderHttpAccessFallbackPage).toHaveBeenCalledWith(
      404,
      { matchedParams: { slug: "hello" } },
      null,
    );
  });

  it("does not bypass cached production HTML for arbitrary draft cookie values", async () => {
    const isrGet = vi.fn(async () =>
      buildISRCacheEntry(buildCachedAppPageValue("<html>cached</html>")),
    );
    const { options } = createDispatchOptions({
      async buildPageElement() {
        throw new Error("invalid draft cookie should still use the page cache");
      },
      isProduction: true,
      isrGet,
      request: new Request("https://example.test/posts/hello", {
        headers: { Cookie: "__prerender_bypass=wrong-secret" },
      }),
      revalidateSeconds: 60,
    });

    const response = await dispatchAppPage(options);

    expect(isrGet).toHaveBeenCalledOnce();
    expect(response.headers.get("x-vinext-cache")).toBe("HIT");
    await expect(response.text()).resolves.toBe("<html>cached</html>");
  });

  it("serves cached production HTML for indefinite revalidate=false pages", async () => {
    const { options } = createDispatchOptions({
      async buildPageElement() {
        throw new Error("revalidate=false cache hit should not render the page");
      },
      isProduction: true,
      isrGet: vi.fn(async () =>
        buildISRCacheEntry(buildCachedAppPageValue("<html>static cached</html>")),
      ),
      revalidateSeconds: Infinity,
    });

    const response = await dispatchAppPage(options);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("s-maxage=31536000, stale-while-revalidate");
    expect(response.headers.get("x-vinext-cache")).toBe("HIT");
    await expect(response.text()).resolves.toBe("<html>static cached</html>");
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

  it("uses a verified client reuse manifest to omit static layouts only from RSC transport", async () => {
    const originalBuildId = process.env.__VINEXT_BUILD_ID;
    process.env.__VINEXT_BUILD_ID = "deploy-test";
    const sourceRouteId = "route:/dashboard/settings";
    const sourceRoutePattern = "/dashboard/settings";
    const targetRouteId = "route:/dashboard/profile";
    const targetRoutePattern = "/dashboard/profile";
    const rootBoundaryId = "/";
    const layoutId = AppElementsWire.encodeLayoutId("/");
    const pageId = AppElementsWire.encodePageId("/dashboard/profile", null);
    const element = {
      [APP_ROUTE_KEY]: targetRouteId,
      [APP_ROOT_LAYOUT_KEY]: rootBoundaryId,
      [layoutId]: "root-layout",
      [pageId]: "profile-page",
    };
    const route = createRoute({
      __buildTimeClassifications: new Map([[0, "static"]]),
      layoutTreePositions: [0],
      layouts: [{ default() {} }],
      pattern: targetRoutePattern,
    });
    const clientReuseManifest = createVerifiedStaticLayoutManifest({
      deploymentVersion: "deploy-test",
      layoutId,
      rootBoundaryId,
      routeId: sourceRouteId,
      routePattern: sourceRoutePattern,
    });
    const capturedRscPayloads: Record<string, unknown>[] = [];
    const capturedHtmlPayloads: Record<string, unknown>[] = [];
    const waitUntilPromises: Promise<unknown>[] = [];
    const executionContext = {
      waitUntil(promise) {
        waitUntilPromises.push(promise);
      },
    } satisfies ExecutionContextLike;

    try {
      const { options: rscOptions } = createDispatchOptions({
        buildPageElement: async () => element,
        clientReuseManifest,
        isProduction: true,
        isRscRequest: true,
        revalidateSeconds: 60,
        renderToReadableStream(payload) {
          capturedRscPayloads.push(captureRecord(payload));
          return createStream(["flight"]);
        },
        route,
      });

      const rscResponse = await runWithExecutionContext(executionContext, () =>
        dispatchAppPage(rscOptions),
      );

      expect(rscResponse.status).toBe(200);
      expect(rscResponse.headers.get("cache-control")).toBe("no-store, must-revalidate");
      expect(rscResponse.headers.get("x-vinext-cache")).toBeNull();
      expect(waitUntilPromises).toHaveLength(0);
      expect(capturedRscPayloads).toHaveLength(1);
      expect(Object.hasOwn(capturedRscPayloads[0], layoutId)).toBe(false);
      expect(capturedRscPayloads[0][pageId]).toBe("profile-page");

      const capturedDynamicPayloads: Record<string, unknown>[] = [];
      const { options: dynamicOptions } = createDispatchOptions({
        buildPageElement: async () => element,
        clientReuseManifest,
        isProduction: true,
        isRscRequest: true,
        renderToReadableStream(payload) {
          capturedDynamicPayloads.push(captureRecord(payload));
          return createStream(["flight"]);
        },
        route: createRoute({
          __buildTimeClassifications: new Map([[0, "dynamic"]]),
          layoutTreePositions: [0],
          layouts: [{ default() {} }],
          pattern: targetRoutePattern,
        }),
      });

      const dynamicResponse = await dispatchAppPage(dynamicOptions);

      expect(dynamicResponse.status).toBe(200);
      expect(capturedDynamicPayloads).toHaveLength(1);
      expect(capturedDynamicPayloads[0][layoutId]).toBe("root-layout");
      expect(capturedDynamicPayloads[0][pageId]).toBe("profile-page");

      const { options: htmlOptions } = createDispatchOptions({
        buildPageElement: async () => element,
        clientReuseManifest,
        isProduction: true,
        isRscRequest: false,
        renderToReadableStream(payload) {
          capturedHtmlPayloads.push(captureRecord(payload));
          return createStream(["flight"]);
        },
        route,
      });

      const htmlResponse = await dispatchAppPage(htmlOptions);

      expect(htmlResponse.status).toBe(200);
      expect(capturedHtmlPayloads).toHaveLength(1);
      expect(capturedHtmlPayloads[0][layoutId]).toBe("root-layout");
      expect(capturedHtmlPayloads[0][pageId]).toBe("profile-page");
    } finally {
      if (originalBuildId === undefined) {
        delete process.env.__VINEXT_BUILD_ID;
      } else {
        process.env.__VINEXT_BUILD_ID = originalBuildId;
      }
    }
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
    await expect(response.text()).resolves.toBe("This page could not be found");
  });

  it("serves intercepted RSC source-route payloads with middleware response state", async () => {
    const sourceRoute = createRoute({
      params: [],
      pattern: "/feed",
      routeSegments: ["feed"],
      slots: {
        "modal@app/feed/@modal": {
          page: { default: "modal-page" },
          slotParamNames: ["id"],
          slotPatternParts: ["photos", ":id"],
        },
        "sidebar@app/feed/@sidebar": {
          page: { default: "sidebar-page" },
          slotParamNames: ["catchAll"],
          slotPatternParts: [":catchAll+"],
        },
      },
    });
    const currentRoute = createRoute({ params: ["id"], pattern: "/photos/[id]" });
    const middlewareHeaders = new Headers({ "x-from-middleware": "yes" });
    const setNavigationContext = vi.fn();
    const { options } = createDispatchOptions({
      cleanPathname: "/photos/123",
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
      setNavigationContext,
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
    expect(response.headers.get("content-type")).toBe("text/x-component");
    expect(response.headers.get("x-from-middleware")).toBe("yes");
    await expect(response.text()).resolves.toBe("/feed:{}:modal@app/feed/@modal");
    expect(setNavigationContext).toHaveBeenLastCalledWith({
      params: { id: "123", catchAll: ["photos", "123"] },
      pathname: "/photos/123",
      searchParams: new URLSearchParams("from=feed"),
    });
  });

  it("regenerates stale intercepted RSC cache entries from the source route", async () => {
    const sourceRoute = createRoute({ params: [], pattern: "/feed", routeSegments: ["feed"] });
    const currentRoute = createRoute({
      params: ["id"],
      pattern: "/photos/[id]",
      routeSegments: ["photos", "[id]"],
    });
    const staleRscData = new TextEncoder().encode("stale-flight").buffer;
    const buildPageElement = vi.fn(
      async (
        route: TestRoute,
        params: Record<string, string | string[]>,
        opts: Parameters<DispatchOptions["buildPageElement"]>[2],
        searchParams: URLSearchParams,
      ) =>
        JSON.stringify({
          params,
          route: route.pattern,
          search: searchParams.toString(),
          slot: opts?.interceptSlotKey ?? "direct",
        }),
    );
    let scheduledRender: unknown = null;
    const scheduleBackgroundRegeneration: DispatchOptions["scheduleBackgroundRegeneration"] = (
      _key,
      renderFn,
    ) => {
      scheduledRender = renderFn;
    };
    const resolveRouteFetchCacheMode = vi.fn((route: TestRoute) =>
      route === sourceRoute ? "force-cache" : null,
    );
    const { options } = createDispatchOptions({
      buildPageElement,
      cleanPathname: "/photos/123",
      findIntercept: () => ({
        matchedParams: { id: "123" },
        page: { default: "modal-page" },
        slotId: "slot:modal:/feed",
        slotKey: "modal@app/feed/@modal",
        sourceRouteIndex: 1,
      }),
      getSourceRoute(sourceRouteIndex) {
        return sourceRouteIndex === 1 ? sourceRoute : undefined;
      },
      interceptionContext: "/feed",
      isProduction: true,
      isRscRequest: true,
      isrGet: vi.fn(async () =>
        buildISRCacheEntry(
          buildCachedAppPageValue(
            "",
            staleRscData,
            undefined,
            buildQueryInvariantRenderObservation(),
          ),
          true,
        ),
      ),
      isrRscKey(pathname, mountedSlotsHeader, _renderMode, interceptionContext) {
        return `rsc:${pathname}:${mountedSlotsHeader ?? "none"}:${interceptionContext ?? "none"}`;
      },
      loadSsrHandler: async () => ({
        async handleSsr(_rscStream, _navigationContext, _fontData, captureOptions) {
          if (captureOptions?.capturedRscDataRef) {
            captureOptions.capturedRscDataRef.value = Promise.resolve(
              new TextEncoder().encode("fresh-intercepted-flight").buffer,
            );
          }
          void captureOptions?.sideStream?.cancel().catch(() => {});
          return createStream(["<html>fresh</html>"]);
        },
      }),
      mountedSlotsHeader: "slot:modal:/feed",
      revalidateSeconds: 60,
      resolveRouteFetchCacheMode,
      route: currentRoute,
      scheduleBackgroundRegeneration,
      searchParams: new URLSearchParams("tab=popular"),
    });

    const response = await dispatchAppPage(options);

    expect(response.headers.get("x-vinext-cache")).toBe("STALE");
    await expect(response.text()).resolves.toBe("stale-flight");
    expect(typeof scheduledRender).toBe("function");
    if (typeof scheduledRender !== "function") {
      throw new Error("expected stale intercepted RSC response to schedule regeneration");
    }

    await scheduledRender();

    const [routeArg, paramsArg, optsArg, searchParamsArg] = buildPageElement.mock.calls[0];
    expect(resolveRouteFetchCacheMode).toHaveBeenCalledWith(sourceRoute);
    expect(routeArg).toBe(sourceRoute);
    expect(paramsArg).toEqual({});
    expect(searchParamsArg.toString()).toBe("");
    expect(optsArg).toMatchObject({
      interceptionContext: "/feed",
      interceptParams: { id: "123" },
      interceptSlotId: "slot:modal:/feed",
      interceptSlotKey: "modal@app/feed/@modal",
      interceptSourceMatchedUrl: "/feed",
    });
    expect(options.isrSet).toHaveBeenCalledWith(
      "rsc:/photos/123:slot:modal:/feed:/feed",
      expect.objectContaining({ kind: "APP_PAGE" }),
      60,
      expect.arrayContaining(["/photos/123", "_N_T_/feed/page"]),
      undefined,
    );
  });

  it("resolves the intercept source route's dynamic config for force-dynamic fetch defaults", async () => {
    // When the current route is not force-dynamic but the intercepted source route is,
    // the dispatch must resolve the source route's dynamic config so that fetch
    // defaults come from the source route, not the current route.
    const sourceRoute = createRoute({
      params: [],
      pattern: "/feed",
      routeSegments: ["feed"],
      layouts: [{ default: () => null, dynamic: "force-dynamic" }],
    });
    const currentRoute = createRoute({
      params: ["id"],
      pattern: "/photos/[id]",
      routeSegments: ["photos", "[id]"],
    });

    const resolveRouteDynamicConfig = vi.fn((route: TestRoute) =>
      route === sourceRoute ? "force-dynamic" : undefined,
    );

    const { options } = createDispatchOptions({
      async buildPageElement(route, params, opts) {
        return `${route.pattern}:${JSON.stringify(params)}:${opts?.interceptSlotKey ?? "direct"}`;
      },
      isRscRequest: true,
      route: currentRoute,
      resolveRouteDynamicConfig,
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

    expect(response.status).toBe(200);
    expect(resolveRouteDynamicConfig).toHaveBeenCalledWith(sourceRoute);
  });

  it("does not leak the current route's force-dynamic config into the intercept source route", async () => {
    // When the current route is force-dynamic but the intercepted source route is not,
    // the dispatch must resolve the source route's dynamic config so that fetch
    // defaults do NOT leak from the current route into the source route.
    const sourceRoute = createRoute({
      params: [],
      pattern: "/feed",
      routeSegments: ["feed"],
    });
    const currentRoute = createRoute({
      params: ["id"],
      pattern: "/photos/[id]",
      routeSegments: ["photos", "[id]"],
      layouts: [{ default: () => null, dynamic: "force-dynamic" }],
    });

    const resolveRouteDynamicConfig = vi.fn((route: TestRoute) =>
      route === currentRoute ? "force-dynamic" : undefined,
    );

    const { options } = createDispatchOptions({
      async buildPageElement(route, params, opts) {
        return `${route.pattern}:${JSON.stringify(params)}:${opts?.interceptSlotKey ?? "direct"}`;
      },
      dynamicConfig: "force-dynamic",
      isRscRequest: true,
      route: currentRoute,
      resolveRouteDynamicConfig,
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

    expect(response.status).toBe(200);
    expect(resolveRouteDynamicConfig).toHaveBeenCalledWith(sourceRoute);
  });

  it("regenerates stale HTML cache entries with waitForAllReady so suspense fallbacks never leak into the cache", async () => {
    // Stale-while-revalidate regeneration must await React's `allReady` before
    // transforming/buffering the HTML stream — same guarantee as the prerender
    // path. Without `waitForAllReady: true`, Suspense fallback content could be
    // written to the regenerated cache entry instead of the resolved content.
    const route = createRoute({ pattern: "/posts/[slug]", routeSegments: ["posts", "[slug]"] });
    let scheduledRender: unknown = null;
    const scheduleBackgroundRegeneration: DispatchOptions["scheduleBackgroundRegeneration"] = (
      _key,
      renderFn,
    ) => {
      scheduledRender = renderFn;
    };
    let capturedWaitForAllReady: boolean | undefined;
    const isrSet = vi.fn(async () => {});
    const { options } = createDispatchOptions({
      buildPageElement: async () => React.createElement("main", null, "fresh"),
      cleanPathname: "/posts/hello",
      isProduction: true,
      isrGet: vi.fn(async () =>
        buildISRCacheEntry(buildCachedAppPageValue("<html>stale</html>"), true),
      ),
      isrSet,
      loadSsrHandler: async () => ({
        async handleSsr(_rscStream, _navigationContext, _fontData, captureOptions) {
          capturedWaitForAllReady = captureOptions?.waitForAllReady;
          if (captureOptions?.capturedRscDataRef) {
            captureOptions.capturedRscDataRef.value = Promise.resolve(
              new TextEncoder().encode("fresh-flight").buffer,
            );
          }
          void captureOptions?.sideStream?.cancel().catch(() => {});
          return createStream(["<html>fresh</html>"]);
        },
      }),
      renderToReadableStream() {
        return createStream(["flight"]);
      },
      revalidateSeconds: 60,
      route,
      scheduleBackgroundRegeneration,
    });

    const response = await dispatchAppPage(options);

    expect(response.headers.get("x-vinext-cache")).toBe("STALE");
    await expect(response.text()).resolves.toBe("<html>stale</html>");
    expect(typeof scheduledRender).toBe("function");
    if (typeof scheduledRender !== "function") {
      throw new Error("expected stale HTML response to schedule regeneration");
    }

    await scheduledRender();

    expect(capturedWaitForAllReady).toBe(true);
    expect(isrSet).toHaveBeenCalled();
  });

  it("resolves the revalidation target route's dynamic config for force-dynamic fetch defaults", async () => {
    // When regenerating a stale cache entry for a target route that is force-dynamic,
    // the dispatch must resolve the target route's dynamic config so that fetch
    // defaults come from the target route, not the current route.
    const targetRoute = createRoute({
      pattern: "/feed",
      routeSegments: ["feed"],
      layouts: [{ default: () => null, dynamic: "force-dynamic" }],
    });
    const currentRoute = createRoute({
      params: ["id"],
      pattern: "/photos/[id]",
      routeSegments: ["photos", "[id]"],
    });

    let scheduledRender: unknown = null;
    const scheduleBackgroundRegeneration: DispatchOptions["scheduleBackgroundRegeneration"] = (
      _key,
      renderFn,
    ) => {
      scheduledRender = renderFn;
    };

    const resolveRouteDynamicConfig = vi.fn((route: TestRoute) =>
      route === targetRoute ? "force-dynamic" : undefined,
    );

    const buildPageElement = vi.fn(
      async (
        route: TestRoute,
        params: Record<string, string | string[]>,
        opts: Parameters<DispatchOptions["buildPageElement"]>[2],
        searchParams: URLSearchParams,
      ) =>
        JSON.stringify({
          params,
          route: route.pattern,
          search: searchParams.toString(),
          slot: opts?.interceptSlotKey ?? "direct",
        }),
    );

    const { options } = createDispatchOptions({
      buildPageElement,
      cleanPathname: "/photos/123",
      findIntercept() {
        return {
          matchedParams: { id: "123" },
          page: { default: "modal-page" },
          slotKey: "modal@app/feed/@modal",
          sourceRouteIndex: 1,
        };
      },
      getSourceRoute(sourceRouteIndex) {
        return sourceRouteIndex === 1 ? targetRoute : undefined;
      },
      interceptionContext: "/feed",
      isProduction: true,
      isRscRequest: true,
      isrGet: vi.fn(async () =>
        buildISRCacheEntry(
          buildCachedAppPageValue(
            "",
            new TextEncoder().encode("stale-flight").buffer,
            undefined,
            buildQueryInvariantRenderObservation(),
          ),
          true,
        ),
      ),
      isrRscKey(pathname, mountedSlotsHeader, _renderMode, interceptionContext) {
        return `rsc:${pathname}:${mountedSlotsHeader ?? "none"}:${interceptionContext ?? "none"}`;
      },
      loadSsrHandler: async () => ({
        async handleSsr(_rscStream, _navigationContext, _fontData, captureOptions) {
          if (captureOptions?.capturedRscDataRef) {
            captureOptions.capturedRscDataRef.value = Promise.resolve(
              new TextEncoder().encode("fresh-flight").buffer,
            );
          }
          void captureOptions?.sideStream?.cancel().catch(() => {});
          return createStream(["<html>fresh</html>"]);
        },
      }),
      mountedSlotsHeader: "slot:modal:/feed",
      revalidateSeconds: 60,
      resolveRouteDynamicConfig,
      route: currentRoute,
      scheduleBackgroundRegeneration,
      searchParams: new URLSearchParams("tab=popular"),
    });

    const response = await dispatchAppPage(options);

    expect(response.headers.get("x-vinext-cache")).toBe("STALE");
    expect(typeof scheduledRender).toBe("function");
    if (typeof scheduledRender !== "function") {
      throw new Error("expected stale response to schedule regeneration");
    }

    await scheduledRender();

    expect(resolveRouteDynamicConfig).toHaveBeenCalledWith(targetRoute);
    const [routeArg] = buildPageElement.mock.calls[0];
    expect(routeArg).toBe(targetRoute);
  });

  it("does not leak the current route's force-dynamic config into the revalidation target route", async () => {
    // When regenerating a stale cache entry for a target route that is NOT force-dynamic,
    // the dispatch must resolve the target route's dynamic config so that fetch
    // defaults do NOT leak from the current route into the target route.
    const targetRoute = createRoute({
      pattern: "/feed",
      routeSegments: ["feed"],
    });
    const currentRoute = createRoute({
      params: ["id"],
      pattern: "/photos/[id]",
      routeSegments: ["photos", "[id]"],
      layouts: [{ default: () => null, dynamic: "force-dynamic" }],
    });

    const resolveRouteDynamicConfig = vi.fn((route: TestRoute) =>
      route === currentRoute ? "force-dynamic" : undefined,
    );

    const buildPageElement = vi.fn(
      async (
        route: TestRoute,
        params: Record<string, string | string[]>,
        opts: Parameters<DispatchOptions["buildPageElement"]>[2],
        searchParams: URLSearchParams,
      ) =>
        JSON.stringify({
          params,
          route: route.pattern,
          search: searchParams.toString(),
          slot: opts?.interceptSlotKey ?? "direct",
        }),
    );

    const { options } = createDispatchOptions({
      buildPageElement,
      cleanPathname: "/photos/123",
      dynamicConfig: "force-dynamic",
      findIntercept() {
        return {
          matchedParams: { id: "123" },
          page: { default: "modal-page" },
          slotKey: "modal@app/feed/@modal",
          sourceRouteIndex: 1,
        };
      },
      getSourceRoute(sourceRouteIndex) {
        return sourceRouteIndex === 1 ? targetRoute : undefined;
      },
      interceptionContext: "/feed",
      isProduction: true,
      isRscRequest: true,
      isrGet: vi.fn(async () =>
        buildISRCacheEntry(
          buildCachedAppPageValue(
            "",
            new TextEncoder().encode("stale-flight").buffer,
            undefined,
            buildQueryInvariantRenderObservation(),
          ),
          true,
        ),
      ),
      isrRscKey(pathname, mountedSlotsHeader, _renderMode, interceptionContext) {
        return `rsc:${pathname}:${mountedSlotsHeader ?? "none"}:${interceptionContext ?? "none"}`;
      },
      loadSsrHandler: async () => ({
        async handleSsr(_rscStream, _navigationContext, _fontData, captureOptions) {
          if (captureOptions?.capturedRscDataRef) {
            captureOptions.capturedRscDataRef.value = Promise.resolve(
              new TextEncoder().encode("fresh-flight").buffer,
            );
          }
          void captureOptions?.sideStream?.cancel().catch(() => {});
          return createStream(["<html>fresh</html>"]);
        },
      }),
      mountedSlotsHeader: "slot:modal:/feed",
      revalidateSeconds: 60,
      resolveRouteDynamicConfig,
      route: currentRoute,
      searchParams: new URLSearchParams("tab=popular"),
    });

    // A force-dynamic current route skips the cache read entirely, so there is no
    // revalidation path. The intercept path is still exercised, and it must resolve
    // the target route's dynamic config instead of inheriting the current route's.
    const response = await dispatchAppPage(options);
    expect(response.status).toBe(200);
    expect(resolveRouteDynamicConfig).toHaveBeenCalledWith(targetRoute);
  });
});
