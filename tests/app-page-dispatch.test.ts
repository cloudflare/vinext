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
  buildAppPageInterceptSourceProbes,
  probeAppPage,
} from "../packages/vinext/src/server/app-page-probe.js";
import {
  createAppPageTreePath,
  resolveAppPageSegmentParamScopeKeys,
  resolveAppPageSegmentParams,
} from "../packages/vinext/src/server/app-page-params.js";
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
import {
  APP_RSC_RENDER_MODE_PREFETCH_DYNAMIC_SHELL,
  APP_RSC_RENDER_MODE_PREFETCH_EMPTY,
  APP_RSC_RENDER_MODE_PREFETCH_LOADING_SHELL,
  type AppRscRenderMode,
} from "../packages/vinext/src/server/app-rsc-render-mode.js";
import { makeThenableParams } from "../packages/vinext/src/shims/thenable-params.js";
import {
  resolveAppPageInterceptSegmentConfig,
  resolveAppPageInterceptTree,
} from "../packages/vinext/src/server/app-segment-config.js";
import { after, connection } from "../packages/vinext/src/shims/server.js";
import type { AppPageMiddlewareContext } from "../packages/vinext/src/server/app-page-response.js";
import type { ISRCacheEntry } from "../packages/vinext/src/server/isr-cache.js";
import type { CachedAppPageValue } from "../packages/vinext/src/shims/cache.js";
import { markAppPprDynamicFallbackShellHtml } from "../packages/vinext/src/server/app-ppr-fallback-shell.js";
import { appPagePprRuntime } from "../packages/vinext/src/server/app-page-ppr-runtime.js";
import {
  runWithExecutionContext,
  type ExecutionContextLike,
} from "../packages/vinext/src/shims/request-context.js";
import {
  CACHEABILITY_REQUEST_STATE,
  type RouteCacheabilityState,
} from "../packages/vinext/src/shims/cacheability-classification.js";
import {
  cacheabilityManifestRouteKey,
  parseCacheabilityManifest,
} from "../packages/vinext/src/server/cacheability-manifest.js";
import {
  createRequestContext,
  getRequestContext,
  runWithRequestContext,
} from "../packages/vinext/src/shims/unified-request-context.js";
import {
  consumeDynamicUsage,
  consumeRenderRequestApiUsage,
  draftMode,
  getHeadersContext,
  headers,
  headersContextFromRequest,
  markDynamicUsage,
  markRenderRequestApiUsage,
  setHeadersContext,
} from "../packages/vinext/src/shims/headers.js";
import { isPromiseLike } from "../packages/vinext/src/utils/promise.js";
import { isUnknownRecord } from "../packages/vinext/src/utils/record.js";
import { extractRscCompletionMetadata } from "../packages/vinext/src/server/rsc-completion-metadata.js";
import {
  VINEXT_DYNAMIC_STALE_TIME_HEADER,
  VINEXT_INTERCEPTION_ID_HEADER,
} from "../packages/vinext/src/server/headers.js";

type TestRoute = {
  __buildTimeClassifications?: ReadonlyMap<number, "static" | "dynamic"> | null;
  error?: { default?: unknown } | null;
  errors?: readonly ({ default?: unknown } | null | undefined)[];
  forbiddens?: readonly ({ default?: unknown } | null | undefined)[];
  isDynamic: boolean;
  layouts: readonly { default?: unknown; dynamic?: unknown; revalidate?: unknown }[];
  layoutTreePositions?: readonly number[];
  loading?: { default?: unknown } | null;
  loadings?: readonly ({ default?: unknown } | null | undefined)[];
  loadingTreePositions?: readonly number[];
  notFounds?: readonly ({ default?: unknown } | null | undefined)[];
  params: readonly string[];
  pattern: string;
  routeSegments: readonly string[];
  slots?: Readonly<
    Record<
      string,
      {
        default?: { default?: unknown } | null;
        loading?: { default?: unknown } | null;
        loadings?: readonly ({ default?: unknown } | null | undefined)[] | null;
        loadingTreePositions?: readonly number[] | null;
        layout?: { default?: unknown } | null;
        name?: string;
        page?: { default?: unknown; generateMetadata?: unknown } | null;
        slotParamNames?: readonly string[] | null;
        slotPatternParts?: readonly string[] | null;
      }
    >
  >;
  templates?: readonly ({ default?: unknown } | null | undefined)[];
  templateTreePositions?: readonly number[];
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

  if (
    node.type === React.Fragment ||
    node.type === React.Suspense ||
    typeof node.type === "string"
  ) {
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

type CreateDispatchOptionsOverrides = {
  buildPageElement?: DispatchOptions["buildPageElement"];
  bypassInterceptionContextCache?: DispatchOptions["bypassInterceptionContextCache"];
  cleanPathname?: string;
  clearRequestContext?: DispatchOptions["clearRequestContext"];
  createRscOnErrorHandler?: DispatchOptions["createRscOnErrorHandler"];
  probeInterceptSource?: DispatchOptions["probeInterceptSource"];
  dynamicConfig?: DispatchOptions["dynamicConfig"];
  dynamicParamsConfig?: DispatchOptions["dynamicParamsConfig"];
  dynamicStaleTimeSeconds?: DispatchOptions["dynamicStaleTimeSeconds"];
  findIntercept?: DispatchOptions["findIntercept"];
  ensureRouteLoaded?: DispatchOptions["ensureRouteLoaded"];
  generateStaticParams?: DispatchOptions["generateStaticParams"];
  hasCustomGlobalError?: DispatchOptions["hasCustomGlobalError"];
  hasAnyGenerateStaticParams?: DispatchOptions["hasAnyGenerateStaticParams"];
  hasGenerateStaticParams?: DispatchOptions["hasGenerateStaticParams"];
  isStaticGenerationEdgeRuntime?: DispatchOptions["isStaticGenerationEdgeRuntime"];
  formState?: DispatchOptions["formState"];
  getSourceRoute?: DispatchOptions["getSourceRoute"];
  getNavigationContext?: DispatchOptions["getNavigationContext"];
  actionError?: DispatchOptions["actionError"];
  actionFailed?: boolean;
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
  pprFallbackCacheShells?: DispatchOptions["pprFallbackCacheShells"];
  pprFallbackShell?: DispatchOptions["pprFallbackShell"];
  pprRuntime?: DispatchOptions["pprRuntime"];
  probeLayoutAt?: DispatchOptions["probeLayoutAt"];
  probePage?: DispatchOptions["probePage"];
  renderedConcreteUrlPaths?: DispatchOptions["renderedConcreteUrlPaths"];
  renderMode?: DispatchOptions["renderMode"];
  renderToReadableStream?: DispatchOptions["renderToReadableStream"];
  request?: Request;
  revalidateSeconds?: number | null;
  resolveRouteFetchCacheMode?: DispatchOptions["resolveRouteFetchCacheMode"];
  resolveRouteRevalidateSeconds?: DispatchOptions["resolveRouteRevalidateSeconds"];
  resolveRouteDynamicConfig?: DispatchOptions["resolveRouteDynamicConfig"];
  resolveRouteDynamicStaleTimeSeconds?: DispatchOptions["resolveRouteDynamicStaleTimeSeconds"];
  resolveRouteDynamicParamsConfig?: DispatchOptions["resolveRouteDynamicParamsConfig"];
  resolveRouteInterceptTreeDynamicConfig?: DispatchOptions["resolveRouteInterceptTreeDynamicConfig"];
  resolveRouteGenerateStaticParams?: DispatchOptions["resolveRouteGenerateStaticParams"];
  resolveRouteHasAnyGenerateStaticParams?: DispatchOptions["resolveRouteHasAnyGenerateStaticParams"];
  resolveRouteStaticEligible?: DispatchOptions["resolveRouteStaticEligible"];
  route?: TestRoute;
  scheduleBackgroundRegeneration?: DispatchOptions["scheduleBackgroundRegeneration"];
  searchParams?: URLSearchParams;
  setNavigationContext?: DispatchOptions["setNavigationContext"];
};

function createDispatchOptions(overrides: CreateDispatchOptionsOverrides = {}) {
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
    bypassInterceptionContextCache: overrides.bypassInterceptionContextCache,
    cleanPathname: overrides.cleanPathname ?? "/posts/hello",
    clearRequestContext,
    probeInterceptSource: overrides.probeInterceptSource,
    createRscOnErrorHandler: overrides.createRscOnErrorHandler ?? (() => () => undefined),
    draftModeSecret: "draft-secret",
    dynamicConfig: overrides.dynamicConfig,
    dynamicParamsConfig: overrides.dynamicParamsConfig,
    dynamicStaleTimeSeconds: overrides.dynamicStaleTimeSeconds,
    ensureRouteLoaded: overrides.ensureRouteLoaded,
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
    getNavigationContext:
      overrides.getNavigationContext ??
      (() => ({
        pathname: "/posts/hello",
        searchParams: new URLSearchParams(),
        params: { slug: "hello" },
      })),
    getSourceRoute: overrides.getSourceRoute ?? (() => undefined),
    hasAnyGenerateStaticParams:
      overrides.hasAnyGenerateStaticParams ??
      overrides.hasGenerateStaticParams ??
      typeof overrides.generateStaticParams === "function",
    hasGenerateStaticParams:
      overrides.hasGenerateStaticParams ?? typeof overrides.generateStaticParams === "function",
    hasCustomGlobalError: overrides.hasCustomGlobalError,
    hasPageDefaultExport: true,
    hasPageModule: true,
    handlerStart: 10,
    formState: overrides.formState,
    actionError: overrides.actionError,
    actionFailed: overrides.actionFailed,
    interceptionContext: overrides.interceptionContext ?? null,
    isProgressiveActionRender: overrides.isProgressiveActionRender,
    isStaticGenerationEdgeRuntime: overrides.isStaticGenerationEdgeRuntime,
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
    pprFallbackCacheShells: overrides.pprFallbackCacheShells,
    pprFallbackShell: overrides.pprFallbackShell,
    pprRuntime: overrides.pprRuntime,
    probeLayoutAt: overrides.probeLayoutAt ?? createLayoutParamProbe(route, params, []),
    probePage: overrides.probePage ?? (() => null),
    renderedConcreteUrlPaths: overrides.renderedConcreteUrlPaths,
    renderMode: overrides.renderMode,
    renderErrorBoundaryPage: vi.fn(async () => null),
    renderHttpAccessFallbackPage: vi.fn(async () => null),
    renderToReadableStream,
    request: overrides.request ?? new Request("https://example.test/posts/hello"),
    revalidateSeconds: overrides.revalidateSeconds ?? null,
    resolveRouteFetchCacheMode: overrides.resolveRouteFetchCacheMode,
    resolveRouteRevalidateSeconds: overrides.resolveRouteRevalidateSeconds,
    resolveRouteDynamicConfig: overrides.resolveRouteDynamicConfig,
    resolveRouteDynamicStaleTimeSeconds: overrides.resolveRouteDynamicStaleTimeSeconds,
    resolveRouteDynamicParamsConfig: overrides.resolveRouteDynamicParamsConfig,
    resolveRouteInterceptTreeDynamicConfig: overrides.resolveRouteInterceptTreeDynamicConfig,
    resolveRouteGenerateStaticParams: overrides.resolveRouteGenerateStaticParams,
    resolveRouteHasAnyGenerateStaticParams: overrides.resolveRouteHasAnyGenerateStaticParams,
    resolveRouteStaticEligible:
      overrides.resolveRouteStaticEligible ?? ((candidate) => !candidate.isDynamic),
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

const pprBlogFallbackShells = [
  {
    fallbackParamNames: ["slug"],
    params: { locale: "en", slug: "[slug]" },
    pathname: "/en/blog/[slug]",
  },
] satisfies NonNullable<DispatchOptions["pprFallbackCacheShells"]>;

function createPprBlogRoute(): TestRoute {
  return createRoute({
    isDynamic: true,
    params: ["locale", "slug"],
    pattern: "/:locale/blog/:slug",
    routeSegments: ["[locale]", "blog", "[slug]"],
  });
}

function createParamTextPageElement(prefix = "element") {
  return vi.fn(
    async (
      _route: TestRoute,
      params: Record<string, string | string[]>,
      _opts: Parameters<DispatchOptions["buildPageElement"]>[2],
      searchParams: URLSearchParams,
    ) => `${prefix}:${JSON.stringify(params)}${searchParams.size > 0 ? `?${searchParams}` : ""}`,
  );
}

function createPprBlogDispatchOptions(overrides: CreateDispatchOptionsOverrides = {}) {
  return createDispatchOptions({
    cleanPathname: "/en/blog/new-post",
    isProduction: true,
    params: { locale: "en", slug: "new-post" },
    pprFallbackCacheShells: pprBlogFallbackShells,
    pprRuntime: appPagePprRuntime,
    revalidateSeconds: 60,
    route: createPprBlogRoute(),
    ...overrides,
  });
}

function createPprBlogFallbackShellGetter(stale: boolean) {
  return vi.fn(async (key: string) => {
    if (key === "html:/en/blog/[slug]") {
      return buildISRCacheEntry(
        buildCachedAppPageValue("<html><head></head><body>Locale: en</body></html>"),
        stale,
      );
    }
    return null;
  });
}

function createFreshBodySsrHandler(body: string): DispatchOptions["loadSsrHandler"] {
  return async () => ({
    async handleSsr() {
      return createStream([`<html><head></head><body>${body}</body></html>`]);
    },
  });
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
  it("does not probe layouts below an active ancestor loading boundary", async () => {
    const probeLayoutAt = vi.fn((_layoutIndex: number) => null);
    const probePage = vi.fn(() => null);
    const route = createRoute({
      layouts: [{}, {}, {}],
      layoutTreePositions: [0, 1, 2],
      loading: null,
      loadings: [{ default: () => null }],
      loadingTreePositions: [1],
      routeSegments: ["parent", "slow"],
    });
    const { options } = createDispatchOptions({ probeLayoutAt, probePage, route });

    const response = await dispatchAppPage(options);
    await response.text();

    // The loading at position 1 catches descendants, but not a layout at the
    // same position. Probe the root and co-located layout only.
    expect(probeLayoutAt.mock.calls.map(([layoutIndex]) => layoutIndex)).toEqual([1, 0]);
    expect(probePage).not.toHaveBeenCalled();
  });

  it("disables streaming metadata while producing prerendered HTML", async () => {
    vi.stubEnv("VINEXT_PRERENDER", "1");
    const buildPageElement = vi.fn<DispatchOptions["buildPageElement"]>(async () =>
      React.createElement("main", null, "page"),
    );
    const { options } = createDispatchOptions({ buildPageElement });

    const response = await dispatchAppPage(options);

    expect(response.status).toBe(200);
    expect(buildPageElement.mock.calls[0]?.[5]).toMatchObject({
      serveStreamingMetadata: false,
    });
  });

  it("preserves request-time metadata placement for PPR fallback-shell prerenders", async () => {
    vi.stubEnv("VINEXT_PRERENDER", "1");
    const buildPageElement = vi.fn<DispatchOptions["buildPageElement"]>(async () =>
      React.createElement("main", null, "page"),
    );
    const { options } = createDispatchOptions({
      buildPageElement,
      pprFallbackShell: {
        fallbackParamNames: ["slug"],
        routePattern: "/posts/[slug]",
      },
    });

    const response = await dispatchAppPage(options);

    expect(response.status).toBe(200);
    expect(buildPageElement.mock.calls[0]?.[5]).toMatchObject({
      serveStreamingMetadata: true,
    });
  });

  it("does not run a speculative connection() page probe for HTML renders", async () => {
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
    expect(probePage).not.toHaveBeenCalled();
    await expect(response.text()).resolves.toBe("<html>page</html>");
  });

  it.each([
    ["force-dynamic", { dynamicConfig: "force-dynamic" as const }],
    [
      "draft mode",
      {
        request: new Request("https://example.test/posts/hello", {
          headers: { Cookie: "__prerender_bypass=draft-secret" },
        }),
      },
    ],
    ["progressive actions", { isProgressiveActionRender: true }],
    ["revalidate zero", { revalidateSeconds: 0 }],
  ])("does not probe queryless production HTML for %s", async (_name, overrides) => {
    const probePage = vi.fn(() => null);
    const { options } = createDispatchOptions({
      isProduction: true,
      probePage,
      revalidateSeconds: 60,
      ...overrides,
    });

    const response = await dispatchAppPage(options);

    expect(probePage).not.toHaveBeenCalled();
    await expect(response.text()).resolves.toBe("<html>page</html>");
  });

  afterEach(() => {
    consumeDynamicUsage();
    consumeRenderRequestApiUsage();
    // Tests that run outside a request share the fallback state, whose dynamic
    // latch is otherwise only reset by a new headers context.
    setHeadersContext(headersContextFromRequest(new Request("https://example.test/")));
    setHeadersContext(null);
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

  it("sends the request's navigation params and path on a cached RSC hit", async () => {
    const { options } = createDispatchOptions({
      async buildPageElement() {
        throw new Error("cache hit should not render the page");
      },
      cleanPathname: "/posts/first",
      isProduction: true,
      isRscRequest: true,
      isrGet: vi.fn(async () =>
        buildISRCacheEntry(buildCachedAppPageValue("", new TextEncoder().encode("flight").buffer)),
      ),
      hasGenerateStaticParams: true,
      params: { slug: "first" },
      revalidateSeconds: 60,
      route: createRoute({
        isDynamic: true,
        params: ["slug"],
        // An active slot's params are part of what a fresh render sends.
        slots: {
          "sidebar@app/posts/@sidebar": {
            page: { default: "sidebar-page" },
            slotParamNames: ["section"],
            slotPatternParts: [":section", ":slug"],
          },
        },
      }),
    });
    options.renderedPathAndSearch = "/posts/first";

    const response = await dispatchAppPage(options);

    expect(response.headers.get("x-vinext-cache")).toBe("HIT");
    expect(response.headers.get("x-vinext-params")).toBe(
      encodeURIComponent(JSON.stringify({ slug: "first", section: "posts" })),
    );
    expect(response.headers.get("x-vinext-rendered-path-and-search")).toBe(
      encodeURIComponent("/posts/first"),
    );
  });

  it("hydrates an intercepting source route before resolving a cached RSC hit's params", async () => {
    // The source route's slots are lazy until ensureRouteLoaded runs.
    const sidebarSlot: {
      page?: { default?: unknown } | null;
      slotParamNames: readonly string[];
      slotPatternParts: readonly string[];
    } = { slotParamNames: ["catchAll"], slotPatternParts: [":catchAll+"] };
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
        "sidebar@app/feed/@sidebar": sidebarSlot,
      },
    });
    const { options } = createDispatchOptions({
      async buildPageElement() {
        throw new Error("cache hit should not render the page");
      },
      cleanPathname: "/photos/123",
      async ensureRouteLoaded(loadedRoute) {
        if (loadedRoute === sourceRoute) sidebarSlot.page = { default: "sidebar-page" };
      },
      hasGenerateStaticParams: true,
      isProduction: true,
      isRscRequest: true,
      isrGet: vi.fn(async () =>
        buildISRCacheEntry(buildCachedAppPageValue("", new TextEncoder().encode("flight").buffer)),
      ),
      params: { id: "123" },
      revalidateSeconds: 60,
      route: createRoute({ isDynamic: true, params: ["id"], pattern: "/photos/[id]" }),
    });

    const response = await dispatchAppPage({
      ...options,
      findIntercept() {
        return {
          interceptBranchSegments: ["(.)photos", "[id]"],
          interceptionGraphId: "graph-interception:/feed->/photos/:id",
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

    expect(response.headers.get("x-vinext-cache")).toBe("HIT");
    expect(response.headers.get("x-vinext-params")).toBe(
      encodeURIComponent(JSON.stringify({ id: "123", catchAll: ["photos", "123"] })),
    );
  });

  it("validates generated params before hydrating a route for cached RSC hit params", async () => {
    const ensureRouteLoaded = vi.fn(async () => {
      throw new Error("route modules should not load for a generated-param miss");
    });
    const renderHttpAccessFallbackPage = vi.fn(
      async () => new Response("not found", { status: 404 }),
    );
    const { options } = createDispatchOptions({
      async buildPageElement() {
        throw new Error("unknown static params should not render the page");
      },
      ensureRouteLoaded,
      async generateStaticParams() {
        return [{ slug: "known" }];
      },
      isProduction: true,
      isRscRequest: true,
      isrGet: vi.fn(async () => null),
      revalidateSeconds: 60,
      route: createRoute({ isDynamic: true, params: ["slug"] }),
    });
    options.renderHttpAccessFallbackPage = renderHttpAccessFallbackPage;

    const response = await dispatchAppPage({ ...options, dynamicParamsConfig: false });

    expect(response.status).toBe(404);
    expect(ensureRouteLoaded).not.toHaveBeenCalled();
  });

  it("treats unproofed cached production HTML as a miss for query-bearing requests", async () => {
    const isrGet = vi.fn(async () =>
      buildISRCacheEntry(buildCachedAppPageValue("<html>cached empty query</html>")),
    );
    const probePage = vi.fn(() => null);
    const { options } = createDispatchOptions({
      isProduction: true,
      isrGet,
      loadSsrHandler: async () => ({
        async handleSsr() {
          return new ReadableStream<Uint8Array>({
            start(controller) {
              markDynamicUsage();
              markRenderRequestApiUsage("searchParams");
              controller.enqueue(new TextEncoder().encode("<html>page</html>"));
              controller.close();
            },
          });
        },
      }),
      probePage,
      revalidateSeconds: 60,
      searchParams: new URLSearchParams("search=hello"),
    });

    const response = await dispatchAppPage(options);

    expect(isrGet).toHaveBeenCalled();
    expect(probePage).not.toHaveBeenCalled();
    expect(response.headers.get("x-vinext-cache")).toBeNull();
    expect(response.headers.get("cache-control")).toBe(
      "private, no-cache, no-store, max-age=0, must-revalidate",
    );
    await expect(response.text()).resolves.toBe("<html>page</html>");
  });

  it("renders query-bearing HTML as a cache candidate and stores it when searchParams is unread", async () => {
    const probePage = vi.fn(() => null);
    const isrSet = vi.fn<DispatchOptions["isrSet"]>(async () => {});
    const ssrOptions: { isCacheCandidate?: boolean }[] = [];
    const waitUntilPromises: Promise<unknown>[] = [];
    const executionContext = {
      waitUntil(promise) {
        waitUntilPromises.push(promise);
      },
    } satisfies ExecutionContextLike;
    const { options } = createDispatchOptions({
      isProduction: true,
      isrSet,
      loadSsrHandler: async () => ({
        async handleSsr(_rscStream, _navigationContext, _fontData, handleSsrOptions) {
          ssrOptions.push({ isCacheCandidate: handleSsrOptions?.isCacheCandidate });
          return createStream(["<html>page</html>"]);
        },
      }),
      probePage,
      revalidateSeconds: 60,
      searchParams: new URLSearchParams("utm_source=google"),
    });

    const response = await runWithExecutionContext(executionContext, () =>
      dispatchAppPage(options),
    );

    // SSR keeps the query out of the output unless the render turns dynamic,
    // so a candidate miss reports MISS with or without a query.
    expect(ssrOptions).toEqual([{ isCacheCandidate: true }]);
    expect(probePage).not.toHaveBeenCalled();
    expect(response.headers.get("x-vinext-cache")).toBe("MISS");
    expect(response.headers.get("cache-control")).toBe("no-store, must-revalidate");
    await expect(response.text()).resolves.toBe("<html>page</html>");
    await Promise.all(waitUntilPromises.splice(0));
    expect(isrSet).toHaveBeenCalledTimes(1);
    const [cacheKey, cacheValue, cachePolicy] = isrSet.mock.calls[0]!;
    expect(cacheKey).toBe("html:/posts/hello");
    expect(cacheValue).toMatchObject({
      kind: "APP_PAGE",
      renderObservation: {
        requestApis: expect.arrayContaining([{ kind: "searchParams", status: "notObserved" }]),
      },
    });
    expect(cachePolicy.cacheControl.revalidate).toBe(60);
    expect(cachePolicy.tags).toEqual(expect.arrayContaining(["_N_T_/posts/hello"]));
    expect(cachePolicy.cacheControl.expire).toBeUndefined();
  });

  it("renders draft-mode and dev HTML outside cache-candidate mode", async () => {
    for (const overrides of [
      {
        isProduction: true,
        request: new Request("https://example.com/posts/hello?q=1", {
          headers: { cookie: "__prerender_bypass=draft-secret" },
        }),
      },
      { isProduction: false },
    ]) {
      const ssrOptions: { isCacheCandidate?: boolean }[] = [];
      const { options } = createDispatchOptions({
        ...overrides,
        loadSsrHandler: async () => ({
          async handleSsr(_rscStream, _navigationContext, _fontData, handleSsrOptions) {
            ssrOptions.push({ isCacheCandidate: handleSsrOptions?.isCacheCandidate });
            return createStream(["<html>page</html>"]);
          },
        }),
        revalidateSeconds: 60,
        searchParams: new URLSearchParams("q=1"),
      });

      const response = await dispatchAppPage(options);
      await response.text();
      expect(ssrOptions).toEqual([{ isCacheCandidate: false }]);
    }
  });

  // The deploy probe must render the way the runtime does, or the manifest it
  // produces would certify a render the runtime never serves.
  it("renders the Workers Cache deploy probe in cache-candidate mode without reading the cache", async () => {
    const isrGet = vi.fn<DispatchOptions["isrGet"]>(async () => null);
    const ssrOptions: { isCacheCandidate?: boolean }[] = [];
    const context: ExecutionContextLike = { waitUntil() {} };
    const state: RouteCacheabilityState = {
      captureDeadlineAt: Date.now() + 10_000,
      mode: "probe",
    };
    Reflect.set(context, CACHEABILITY_REQUEST_STATE, state);
    const { options } = createDispatchOptions({
      isProduction: true,
      isrGet,
      loadSsrHandler: async () => ({
        async handleSsr(_rscStream, _navigationContext, _fontData, handleSsrOptions) {
          ssrOptions.push({ isCacheCandidate: handleSsrOptions?.isCacheCandidate });
          return createStream(["<html>page</html>"]);
        },
      }),
      revalidateSeconds: 60,
    });

    const response = await runWithExecutionContext(context, () => dispatchAppPage(options));
    await response.text();

    expect(ssrOptions).toEqual([{ isCacheCandidate: true }]);
    expect(isrGet).not.toHaveBeenCalled();
  });

  // Discovery can list paths of a route Next.js classifies as dynamic, such as
  // one whose only generateStaticParams sits above its last dynamic segment.
  // The probe must report the whole pattern dynamic so it gets no entry.
  it("reports a route that isn't statically generated as pattern-dynamic to the deploy probe", async () => {
    const cases: [Partial<Parameters<typeof createDispatchOptions>[0]>, string | undefined][] = [
      [
        {
          hasAnyGenerateStaticParams: true,
          hasGenerateStaticParams: false,
          route: createRoute({ isDynamic: true, params: ["slug"] }),
        },
        "route is not statically generated",
      ],
      [{ isStaticGenerationEdgeRuntime: true }, "route is not statically generated"],
      [
        {
          hasGenerateStaticParams: true,
          route: createRoute({ isDynamic: true, params: ["slug"] }),
        },
        undefined,
      ],
      [{}, undefined],
    ];
    for (const [overrides, expected] of cases) {
      const context: ExecutionContextLike = { waitUntil() {} };
      const state: RouteCacheabilityState = {
        captureDeadlineAt: Date.now() + 10_000,
        mode: "probe",
      };
      Reflect.set(context, CACHEABILITY_REQUEST_STATE, state);
      const { options } = createDispatchOptions({ isProduction: true, ...overrides });

      const response = await runWithExecutionContext(context, () => dispatchAppPage(options));
      await response.text();

      expect(state.patternDynamicReason).toBe(expected);
    }
  });

  // Next.js serves a path its build never certified per request, so a Workers
  // Cache path its manifest gives no state renders with real values from the
  // start. A certified path, and every path without a manifest, keeps
  // candidate mode.
  it("renders a path its Workers Cache manifest gives no state outside cache-candidate mode", async () => {
    const manifest = parseCacheabilityManifest(
      JSON.stringify({
        buildId: "build-a",
        routes: {
          [cacheabilityManifestRouteKey("app-page", "/posts/[slug]")]: {
            kind: "app-page",
            pattern: "/posts/[slug]",
            state: "runtime-check",
            staticPaths: { html: ["/posts/listed"] },
          },
        },
        version: 1,
      }),
      "build-a",
    );
    const cases: [RouteCacheabilityState["admission"], string, boolean][] = [
      [
        { manifest, policy: "manifest", representation: "html", routePathname: "/posts/hello" },
        "/posts/hello",
        false,
      ],
      [
        { manifest, policy: "manifest", representation: "html", routePathname: "/posts/listed" },
        "/posts/listed",
        true,
      ],
      [
        // A curl-style request maps to html at admission, as it does here.
        {
          manifest,
          policy: "manifest",
          representation: "app-route",
          routePathname: "/posts/listed",
        },
        "/posts/listed",
        true,
      ],
      [
        { policy: "runtime", representation: "html", routePathname: "/posts/hello" },
        "/posts/hello",
        true,
      ],
    ];
    for (const [admission, cleanPathname, expected] of cases) {
      const ssrOptions: { isCacheCandidate?: boolean }[] = [];
      const context: ExecutionContextLike = { waitUntil() {} };
      const state: RouteCacheabilityState = {
        admission,
        captureDeadlineAt: Date.now() + 10_000,
        mode: "admit",
      };
      Reflect.set(context, CACHEABILITY_REQUEST_STATE, state);
      const { options } = createDispatchOptions({
        cleanPathname,
        isProduction: true,
        loadSsrHandler: async () => ({
          async handleSsr(_rscStream, _navigationContext, _fontData, handleSsrOptions) {
            ssrOptions.push({ isCacheCandidate: handleSsrOptions?.isCacheCandidate });
            return createStream(["<html>page</html>"]);
          },
        }),
        revalidateSeconds: 60,
        searchParams: new URLSearchParams("q=1"),
      });

      const response = await runWithExecutionContext(context, () => dispatchAppPage(options));
      await response.text();
      expect(ssrOptions, JSON.stringify(admission)).toEqual([{ isCacheCandidate: expected }]);
    }
  });

  it("writes HTML-captured RSC data under the plain key when interception context is absent", async () => {
    const isrSet = vi.fn<DispatchOptions["isrSet"]>(async () => {});
    const waitUntilPromises: Promise<unknown>[] = [];
    const executionContext = {
      waitUntil(promise) {
        waitUntilPromises.push(promise);
      },
    } satisfies ExecutionContextLike;
    const { options } = createDispatchOptions({
      cleanPathname: "/photos/123",
      interceptionContext: null,
      isProduction: true,
      isrRscKey(pathname, mountedSlotsHeader, _renderMode, interceptionContext) {
        return `rsc:${pathname}:${mountedSlotsHeader ?? "none"}:${interceptionContext ?? "none"}`;
      },
      isrSet,
      loadSsrHandler: async () => ({
        async handleSsr(_rscStream, _navigationContext, _fontData, captureOptions) {
          if (captureOptions?.capturedRscDataRef) {
            captureOptions.capturedRscDataRef.value = Promise.resolve(
              new TextEncoder().encode("direct-flight").buffer,
            );
          }
          void captureOptions?.sideStream?.cancel().catch(() => {});
          return createStream(["<html>direct</html>"]);
        },
      }),
      revalidateSeconds: 60,
    });

    const response = await runWithExecutionContext(executionContext, () =>
      dispatchAppPage(options),
    );
    await response.text();
    await Promise.all(waitUntilPromises.splice(0));

    const writtenKeys = isrSet.mock.calls.map(([key]) => key);
    expect(writtenKeys).toHaveLength(2);
    expect(writtenKeys).toEqual(
      expect.arrayContaining(["html:/photos/123", "rsc:/photos/123:none:none"]),
    );
  });

  it("does not reuse queryless HTML when the page reads searchParams", async () => {
    let pageExecutions = 0;
    async function Page(props: Record<string, unknown>): Promise<React.ReactNode> {
      pageExecutions += 1;
      const query = isPromiseLike(props.searchParams) ? await props.searchParams : {};
      if (!isQueryRecord(query)) {
        throw new Error("Expected searchParams to resolve to a query record");
      }
      return React.createElement("h1", null, query.q ?? "empty");
    }

    const route = createRoute({ pattern: "/query-proof", routeSegments: ["query-proof"] });
    const cache = new Map<string, ISRCacheEntry>();
    const isrGet = vi.fn(async (key: string) => cache.get(key) ?? null);
    const isrSet = vi.fn<DispatchOptions["isrSet"]>(async (key, data) => {
      cache.set(key, {
        isStale: false,
        value: { lastModified: Date.now(), value: data },
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
      layoutParamAccess,
      buildOptions,
    ) =>
      buildPageElements({
        layoutParamAccess,
        metadataRoutes: [],
        params,
        pageRequest: {
          isRscRequest: false,
          mountedSlotsHeader: null,
          observeMetadataSearchParamsAccess:
            buildOptions?.observeMetadataSearchParamsAccess === true,
          observePageSearchParamsAccess: buildOptions?.observePageSearchParamsAccess === true,
          opts: undefined,
          request: new Request(`https://example.test/query-proof?${searchParams}`),
          searchParams,
        },
        route: {
          layouts: [],
          page: { default: Page },
          pattern: "/query-proof",
          routeSegments: ["query-proof"],
        },
        routePath: "/query-proof",
      }).then(toDispatchElementRecord);
    const loadSsrHandler: DispatchOptions["loadSsrHandler"] = async () => ({
      async handleSsr(rscStream, _navigationContext, _fontData, captureOptions) {
        void captureOptions?.sideStream?.cancel().catch(() => {});
        const renderedText = await new Response(rscStream).text();
        return createStream([`<html>${renderedText}</html>`]);
      },
    });
    const probePage = vi.fn((searchParams: URLSearchParams) =>
      probeAppPage({
        asyncRouteParams: makeThenableParams({}),
        pageComponent: Page,
        searchParams,
      }),
    );

    async function request(searchParams: URLSearchParams): Promise<{
      response: Response;
      text: string;
    }> {
      const { options } = createDispatchOptions({
        buildPageElement,
        cleanPathname: "/query-proof",
        isProduction: true,
        isrGet,
        isrSet,
        loadSsrHandler,
        probePage: () => probePage(searchParams),
        renderToReadableStream: renderPagePayloadToStream,
        revalidateSeconds: 60,
        route,
        searchParams,
      });
      const response = await runWithExecutionContext(executionContext, () =>
        dispatchAppPage(options),
      );
      const text = await response.text();
      await Promise.all(waitUntilPromises.splice(0));
      return { response, text };
    }

    const queryless = await request(new URLSearchParams());
    expect(queryless.response.headers.get("x-vinext-cache")).not.toBe("HIT");
    expect(queryless.text).toBe("<html>empty</html>");
    expect(cache.has("html:/query-proof")).toBe(false);
    expect(probePage).not.toHaveBeenCalled();
    expect(pageExecutions).toBe(1);

    const withQuery = await request(new URLSearchParams({ q: "hello" }));
    expect(withQuery.response.headers.get("x-vinext-cache")).not.toBe("HIT");
    expect(withQuery.text).toBe("<html>hello</html>");
    expect(probePage).not.toHaveBeenCalled();
    expect(pageExecutions).toBe(2);
  });

  it.each(["generateMetadata", "generateViewport"] as const)(
    "does not reuse queryless HTML when %s reads searchParams",
    async (headGenerator) => {
      const readSearchParams = async (props: {
        searchParams: Promise<Record<string, unknown>>;
      }) => {
        const query = await props.searchParams;
        return typeof query.q === "string" ? query.q : "empty";
      };
      const pageModule = {
        default: () => React.createElement("h1", null, "static body"),
        ...(headGenerator === "generateMetadata"
          ? {
              async generateMetadata(props: { searchParams: Promise<Record<string, unknown>> }) {
                return { title: await readSearchParams(props) };
              },
            }
          : {
              async generateViewport(props: { searchParams: Promise<Record<string, unknown>> }) {
                return { themeColor: await readSearchParams(props) };
              },
            }),
      };
      const route = createRoute({ pattern: "/head-proof", routeSegments: ["head-proof"] });
      const cache = new Map<string, ISRCacheEntry>();
      const isrGet = vi.fn(async (key: string) => cache.get(key) ?? null);
      const isrSet = vi.fn<DispatchOptions["isrSet"]>(async (key, data) => {
        cache.set(key, {
          isStale: false,
          value: { lastModified: Date.now(), value: data },
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
        layoutParamAccess,
        buildOptions,
      ) =>
        buildPageElements({
          layoutParamAccess,
          metadataRoutes: [],
          params,
          pageRequest: {
            isRscRequest: false,
            mountedSlotsHeader: null,
            observeMetadataSearchParamsAccess:
              buildOptions?.observeMetadataSearchParamsAccess === true,
            observePageSearchParamsAccess: buildOptions?.observePageSearchParamsAccess === true,
            opts: undefined,
            request: new Request(`https://example.test/head-proof?${searchParams}`),
            searchParams,
          },
          route: {
            layouts: [],
            page: pageModule,
            pattern: "/head-proof",
            routeSegments: ["head-proof"],
          },
          routePath: "/head-proof",
        }).then(toDispatchElementRecord);
      const loadSsrHandler: DispatchOptions["loadSsrHandler"] = async () => ({
        async handleSsr(rscStream, _navigationContext, _fontData, captureOptions) {
          void captureOptions?.sideStream?.cancel().catch(() => {});
          const renderedText = await new Response(rscStream).text();
          return createStream([`<html>${renderedText}</html>`]);
        },
      });
      const probePage = vi.fn(() => null);

      async function request(searchParams: URLSearchParams): Promise<Response> {
        const { options } = createDispatchOptions({
          buildPageElement,
          cleanPathname: "/head-proof",
          isProduction: true,
          isrGet,
          isrSet,
          loadSsrHandler,
          probePage,
          renderToReadableStream: renderPagePayloadToStream,
          revalidateSeconds: 60,
          route,
          searchParams,
        });
        const response = await runWithExecutionContext(executionContext, () =>
          dispatchAppPage(options),
        );
        await response.text();
        await Promise.all(waitUntilPromises.splice(0));
        return response;
      }

      const queryless = await request(new URLSearchParams());
      expect(queryless.headers.get("x-vinext-cache")).not.toBe("HIT");
      expect(cache.has("html:/head-proof")).toBe(false);
      expect(probePage).not.toHaveBeenCalled();

      const withQuery = await request(new URLSearchParams({ q: "hello" }));
      expect(withQuery.headers.get("x-vinext-cache")).not.toBe("HIT");
    },
  );

  it.each(["primary", "parallel"] as const)(
    "does not reuse queryless RSC when %s generateMetadata reads searchParams",
    async (metadataOwner) => {
      const metadataPage = {
        default: () => React.createElement("h1", null, `${metadataOwner} body`),
        async generateMetadata(props: { searchParams: Promise<Record<string, unknown>> }) {
          const query = await props.searchParams;
          return { title: typeof query.q === "string" ? query.q : "empty" };
        },
      };
      const route = createRoute({
        pattern: "/rsc-metadata-proof",
        routeSegments: ["rsc-metadata-proof"],
        ...(metadataOwner === "parallel"
          ? {
              slots: {
                sidebar: {
                  page: metadataPage,
                },
              },
            }
          : {}),
      });
      const cache = new Map<string, ISRCacheEntry>();
      const isrGet = vi.fn(async (key: string) => cache.get(key) ?? null);
      const isrSet = vi.fn<DispatchOptions["isrSet"]>(async (key, data) => {
        cache.set(key, {
          isStale: false,
          value: { lastModified: Date.now(), value: data },
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
        layoutParamAccess,
        buildOptions,
      ) => {
        const buildRoute: AppPageBuildRoute = {
          layouts: [],
          page:
            metadataOwner === "primary"
              ? metadataPage
              : { default: () => React.createElement("h1", null, "primary body") },
          pattern: "/rsc-metadata-proof",
          routeSegments: ["rsc-metadata-proof"],
          ...(metadataOwner === "parallel"
            ? {
                slots: {
                  sidebar: {
                    layoutIndex: -1,
                    name: "sidebar",
                    page: metadataPage,
                  },
                },
              }
            : {}),
        };
        return buildPageElements({
          layoutParamAccess,
          metadataRoutes: [],
          params,
          pageRequest: {
            isRscRequest: true,
            mountedSlotsHeader: null,
            observeMetadataSearchParamsAccess:
              buildOptions?.observeMetadataSearchParamsAccess === true,
            observePageSearchParamsAccess: buildOptions?.observePageSearchParamsAccess === true,
            opts: undefined,
            request: new Request(`https://example.test/rsc-metadata-proof?${searchParams}`),
            searchParams,
          },
          route: buildRoute,
          routePath: "/rsc-metadata-proof",
        }).then(toDispatchElementRecord);
      };

      async function request(searchParams: URLSearchParams): Promise<Response> {
        const { options } = createDispatchOptions({
          buildPageElement,
          cleanPathname: "/rsc-metadata-proof",
          isProduction: true,
          isRscRequest: true,
          isrGet,
          isrSet,
          probePage() {
            return null;
          },
          renderToReadableStream: renderPagePayloadToStream,
          revalidateSeconds: 60,
          route,
          searchParams,
        });
        const response = await runWithExecutionContext(executionContext, () =>
          dispatchAppPage(options),
        );
        await response.text();
        await Promise.all(waitUntilPromises.splice(0));
        return response;
      }

      const queryless = await request(new URLSearchParams());
      expect(queryless.headers.get("x-vinext-cache")).not.toBe("HIT");
      expect(cache.has("rsc:/rsc-metadata-proof")).toBe(false);

      const withQuery = await request(new URLSearchParams({ q: "hello" }));
      expect(withQuery.headers.get("x-vinext-cache")).not.toBe("HIT");
    },
  );

  it("preserves deferred metadata dynamic usage across a concurrent layout probe", async () => {
    let releaseMetadata!: () => void;
    const metadataGate = new Promise<void>((resolve) => {
      releaseMetadata = resolve;
    });
    let metadataObserved!: () => void;
    const metadataObservedPromise = new Promise<void>((resolve) => {
      metadataObserved = resolve;
    });
    const layoutModule = {
      default: ({ children }: { children?: React.ReactNode }) => children ?? null,
    };
    const pageModule = {
      default: () => React.createElement("h1", null, "metadata body"),
      async generateMetadata(props: { searchParams: Promise<Record<string, unknown>> }) {
        await metadataGate;
        await props.searchParams;
        metadataObserved();
        return { title: "deferred metadata" };
      },
    };
    const route = createRoute({
      layouts: [layoutModule],
      layoutTreePositions: [0],
      pattern: "/deferred-metadata-proof",
      routeSegments: ["deferred-metadata-proof"],
    });
    const cache = new Map<string, ISRCacheEntry>();
    const isrGet = vi.fn(async (key: string) => cache.get(key) ?? null);
    const isrSet = vi.fn<DispatchOptions["isrSet"]>(async (key, data) => {
      cache.set(key, {
        isStale: false,
        value: { lastModified: Date.now(), value: data },
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
      layoutParamAccess,
      buildOptions,
    ) =>
      buildPageElements({
        layoutParamAccess,
        metadataRoutes: [],
        params,
        pageRequest: {
          isRscRequest: true,
          mountedSlotsHeader: null,
          observeMetadataSearchParamsAccess:
            buildOptions?.observeMetadataSearchParamsAccess === true,
          observePageSearchParamsAccess: buildOptions?.observePageSearchParamsAccess === true,
          opts: undefined,
          request: new Request("https://example.test/deferred-metadata-proof"),
          searchParams,
          serveStreamingMetadata: buildOptions?.serveStreamingMetadata,
        },
        route: {
          // The lightweight renderer below consumes only the page slot. Keep
          // the layout on the dispatch route, where it drives the real probe,
          // without adding an unconsumed layout dependency to the wire payload.
          layouts: [],
          page: pageModule,
          pattern: "/deferred-metadata-proof",
          routeSegments: ["deferred-metadata-proof"],
        },
        routePath: "/deferred-metadata-proof",
      }).then(toDispatchElementRecord);
    const { options } = createDispatchOptions({
      buildPageElement,
      cleanPathname: "/deferred-metadata-proof",
      isProduction: true,
      isRscRequest: true,
      isrGet,
      isrSet,
      async probeLayoutAt() {
        releaseMetadata();
        await metadataObservedPromise;
        return null;
      },
      probePage() {
        return null;
      },
      renderToReadableStream: renderPagePayloadToStream,
      revalidateSeconds: 60,
      route,
    });

    const response = await runWithExecutionContext(executionContext, () =>
      runWithRequestContext(createRequestContext(), () => dispatchAppPage(options)),
    );
    await response.text();
    await Promise.all(waitUntilPromises);

    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(cache.has("rsc:/deferred-metadata-proof")).toBe(false);
  });

  it("does not reuse loading-boundary RSC when the page reads searchParams", async () => {
    async function Page(props: Record<string, unknown>): Promise<React.ReactNode> {
      const query = isPromiseLike(props.searchParams) ? await props.searchParams : {};
      return React.createElement(
        "h1",
        null,
        isQueryRecord(query) && typeof query.q === "string" ? query.q : "empty",
      );
    }
    const route = createRoute({
      loading: { default: () => null },
      pattern: "/rsc-loading-proof",
      routeSegments: ["rsc-loading-proof"],
    });
    const cache = new Map<string, ISRCacheEntry>();
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
      layoutParamAccess,
      buildOptions,
    ) =>
      buildPageElements({
        layoutParamAccess,
        metadataRoutes: [],
        params,
        pageRequest: {
          isRscRequest: true,
          mountedSlotsHeader: null,
          observeMetadataSearchParamsAccess:
            buildOptions?.observeMetadataSearchParamsAccess === true,
          observePageSearchParamsAccess: buildOptions?.observePageSearchParamsAccess === true,
          opts: undefined,
          request: new Request(`https://example.test/rsc-loading-proof?${searchParams}`),
          searchParams,
        },
        route: {
          layouts: [],
          loading: { default: () => null },
          page: { default: Page },
          pattern: "/rsc-loading-proof",
          routeSegments: ["rsc-loading-proof"],
        },
        routePath: "/rsc-loading-proof",
      }).then(toDispatchElementRecord);

    async function request(q: string): Promise<string> {
      const { options } = createDispatchOptions({
        buildPageElement,
        cleanPathname: "/rsc-loading-proof",
        isProduction: true,
        isRscRequest: true,
        isrGet: async (key) => cache.get(key) ?? null,
        isrSet: async (key, value) => {
          cache.set(key, {
            isStale: false,
            value: { lastModified: Date.now(), value },
          });
        },
        params: {},
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
      const completed = extractRscCompletionMetadata(await response.arrayBuffer());
      await Promise.all(waitUntilPromises.splice(0));
      // A query-bearing RSC render may still read searchParams after its
      // headers are built, so it sends no provisional cache state.
      expect(response.headers.get("x-vinext-cache")).toBeNull();
      expect(response.headers.get("x-vinext-rsc-completion-metadata")).toBe("1");
      expect(completed.metadata).toEqual({
        dynamicStaleTimeSeconds: 0,
        serverStaleTimeSeconds: null,
      });
      return new TextDecoder().decode(completed.buffer);
    }

    await expect(request("first")).resolves.toBe("first");
    await expect(request("second")).resolves.toBe("second");
    expect(cache.has("rsc:/rsc-loading-proof")).toBe(false);
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

  it("renders prefetch dynamic shells with empty page searchParams", async () => {
    // Ported from Next.js:
    // test/e2e/app-dir/segment-cache/search-params/segment-cache-search-params.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/segment-cache/search-params/segment-cache-search-params.test.ts
    const buildQueries: string[] = [];
    const probeQueries: string[] = [];
    const setNavigationContext = vi.fn<DispatchOptions["setNavigationContext"]>();
    const buildPageElement = vi.fn<DispatchOptions["buildPageElement"]>(
      async (_route, _params, _opts, searchParams) => {
        buildQueries.push(searchParams.toString());
        return searchParams.get("searchParam") ?? "empty";
      },
    );
    const { options } = createDispatchOptions({
      buildPageElement,
      isRscRequest: true,
      probePage(searchParams) {
        probeQueries.push(searchParams?.get("searchParam") ?? "empty");
        return null;
      },
      renderMode: APP_RSC_RENDER_MODE_PREFETCH_DYNAMIC_SHELL,
      renderToReadableStream(element) {
        if (typeof element !== "string") {
          throw new Error("Expected string dynamic shell test element");
        }
        return createStream([element]);
      },
      searchParams: new URLSearchParams("searchParam=a_PPR"),
      setNavigationContext,
    });

    const response = await dispatchAppPage(options);

    await expect(response.text()).resolves.toBe("empty");
    expect(buildQueries).toEqual([""]);
    expect(probeQueries).toEqual(["empty"]);
    const navigationContext = setNavigationContext.mock.calls.at(-1)?.[0];
    expect(navigationContext?.searchParams.toString()).toBe("");
  });

  it.each([
    { isDraftMode: false, isRscRequest: false },
    { isDraftMode: false, isRscRequest: true },
    { isDraftMode: true, isRscRequest: false },
    { isDraftMode: true, isRscRequest: true },
  ])(
    "passes empty request APIs to force-static page and head execution (RSC: $isRscRequest, draft: $isDraftMode)",
    async ({ isDraftMode, isRscRequest }) => {
      // Matches Next.js's force-static searchParams behavior:
      // packages/next/src/server/request/search-params.ts
      const metadataQueries: string[] = [];
      const viewportQueries: string[] = [];
      const pageHeaders: Array<string | null> = [];
      const pageDraftModes: boolean[] = [];
      async function readUser(searchParams: PromiseLike<Record<string, unknown>>): Promise<string> {
        const query = await searchParams;
        return typeof query.user === "string" ? query.user : "empty";
      }
      async function Page(props: Record<string, unknown>): Promise<React.ReactNode> {
        pageHeaders.push(getHeadersContext()?.headers.get("x-request-value") ?? null);
        pageDraftModes.push((await draftMode()).isEnabled);
        const searchParams = props.searchParams;
        if (!isPromiseLike(searchParams)) {
          throw new Error("Expected page searchParams to be thenable");
        }
        return React.createElement(
          "h1",
          null,
          await readUser(searchParams as PromiseLike<Record<string, unknown>>),
        );
      }
      const pageModule = {
        default: Page,
        async generateMetadata(props: { searchParams: Promise<Record<string, unknown>> }) {
          metadataQueries.push(await readUser(props.searchParams));
          return null;
        },
        async generateViewport(props: { searchParams: Promise<Record<string, unknown>> }) {
          viewportQueries.push(await readUser(props.searchParams));
          return null;
        },
      };
      const route = createRoute({
        pattern: "/force-static-query",
        routeSegments: ["force-static-query"],
      });
      const buildPageElement: DispatchOptions["buildPageElement"] = (
        _route,
        params,
        _opts,
        searchParams,
        layoutParamAccess,
        buildOptions,
      ) =>
        buildPageElements({
          layoutParamAccess,
          metadataRoutes: [],
          params,
          pageRequest: {
            isRscRequest,
            mountedSlotsHeader: null,
            observeMetadataSearchParamsAccess:
              buildOptions?.observeMetadataSearchParamsAccess === true,
            observePageSearchParamsAccess: buildOptions?.observePageSearchParamsAccess === true,
            opts: undefined,
            request: new Request("https://example.test/force-static-query?user=alice"),
            searchParams,
          },
          route: {
            layouts: [],
            page: pageModule,
            pattern: "/force-static-query",
            routeSegments: ["force-static-query"],
          },
          routePath: "/force-static-query",
        }).then(toDispatchElementRecord);
      const probeQueries: string[] = [];
      const setNavigationContext = vi.fn<DispatchOptions["setNavigationContext"]>();
      const request = new Request("https://example.test/force-static-query?user=alice", {
        headers: {
          ...(isDraftMode ? { cookie: "__prerender_bypass=draft-secret" } : {}),
          "x-request-value": "present",
        },
      });
      const { options } = createDispatchOptions({
        buildPageElement,
        cleanPathname: "/force-static-query",
        dynamicConfig: "force-static",
        isRscRequest,
        loadSsrHandler: async () => ({
          async handleSsr(rscStream, _navigationContext, _fontData, captureOptions) {
            void captureOptions?.sideStream?.cancel().catch(() => {});
            return createStream([`<html>${await new Response(rscStream).text()}</html>`]);
          },
        }),
        probePage(searchParams) {
          probeQueries.push(searchParams?.get("user") ?? "empty");
          return null;
        },
        request,
        renderToReadableStream: renderPagePayloadToStream,
        route,
        searchParams: new URLSearchParams("user=alice"),
        setNavigationContext,
      });

      const response = await dispatchAppPage(options);

      await expect(response.text()).resolves.toBe(isRscRequest ? "empty" : "<html>empty</html>");
      expect(metadataQueries).toEqual(["empty"]);
      expect(viewportQueries).toEqual(["empty"]);
      expect(probeQueries).toEqual(isRscRequest ? ["empty"] : []);
      expect(pageHeaders).toEqual([null]);
      expect(pageDraftModes).toEqual([isDraftMode]);
      const navigationContext = setNavigationContext.mock.calls.at(-1)?.[0];
      expect(navigationContext?.searchParams.toString()).toBe("");
    },
  );

  it("preserves dynamic-error searchParams values but throws when they are accessed", async () => {
    // Ported from Next.js: test/e2e/app-dir/dynamic-data/dynamic-data.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/dynamic-data/dynamic-data.test.ts
    const receivedQueries: string[] = [];
    async function Page(props: Record<string, unknown>): Promise<React.ReactNode> {
      const searchParams = props.searchParams;
      if (!isPromiseLike(searchParams)) {
        throw new Error("Expected page searchParams to be thenable");
      }
      const query = await searchParams;
      if (!isQueryRecord(query)) {
        throw new Error("Expected searchParams to resolve to a query record");
      }
      receivedQueries.push(typeof query.user === "string" ? query.user : "empty");
      return React.createElement("h1", null, "unexpected");
    }
    const route = createRoute({ pattern: "/dynamic-error", routeSegments: ["dynamic-error"] });
    const buildPageElement: DispatchOptions["buildPageElement"] = (
      _route,
      params,
      _opts,
      searchParams,
      layoutParamAccess,
      buildOptions,
    ) =>
      buildPageElements({
        layoutParamAccess,
        metadataRoutes: [],
        params,
        pageRequest: {
          isRscRequest: true,
          mountedSlotsHeader: null,
          observeMetadataSearchParamsAccess:
            buildOptions?.observeMetadataSearchParamsAccess === true,
          observePageSearchParamsAccess: buildOptions?.observePageSearchParamsAccess === true,
          opts: undefined,
          request: new Request("https://example.test/dynamic-error?user=alice"),
          searchParams,
        },
        route: {
          layouts: [],
          page: { default: Page },
          pattern: "/dynamic-error",
          routeSegments: ["dynamic-error"],
        },
        routePath: "/dynamic-error",
      }).then(toDispatchElementRecord);
    const { options } = createDispatchOptions({
      buildPageElement,
      cleanPathname: "/dynamic-error",
      dynamicConfig: "error",
      isRscRequest: true,
      renderToReadableStream: renderPagePayloadToStream,
      route,
      searchParams: new URLSearchParams("user=alice"),
    });

    try {
      const response = await dispatchAppPage(options);

      await expect(response.text()).rejects.toThrow('Page with `dynamic = "error"`');
      expect(receivedQueries).toEqual([]);
    } finally {
      setHeadersContext(null);
    }
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
      buildOptions?: Parameters<DispatchOptions["buildPageElement"]>[5],
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
          observeMetadataSearchParamsAccess: buildOptions?.observeMetadataSearchParamsAccess,
          observePageSearchParamsAccess: buildOptions?.observePageSearchParamsAccess,
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

  it("caches queryless loading-boundary HTML with a complete searchParams proof", async () => {
    const route = createRoute({
      loading: { default: () => null },
      pattern: "/loading-static",
      routeSegments: ["loading-static"],
    });
    const cache = new Map<string, ISRCacheEntry>();
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
      layoutParamAccess,
    ) =>
      buildPageElements({
        layoutParamAccess,
        metadataRoutes: [],
        params,
        pageRequest: {
          isRscRequest: false,
          mountedSlotsHeader: null,
          opts: undefined,
          request: new Request(`https://example.test/loading-static?${searchParams}`),
          searchParams,
        },
        route: {
          layouts: [],
          loading: { default: () => null },
          page: { default: () => React.createElement("h1", null, "static") },
          pattern: "/loading-static",
          routeSegments: ["loading-static"],
        },
        routePath: "/loading-static",
      }).then(toDispatchElementRecord);

    async function request(searchParams: URLSearchParams): Promise<Response> {
      const { options } = createDispatchOptions({
        buildPageElement,
        cleanPathname: "/loading-static",
        isProduction: true,
        isrGet: async (key) => cache.get(key) ?? null,
        isrSet: async (key, value) => {
          cache.set(key, {
            isStale: false,
            value: { lastModified: Date.now(), value },
          });
        },
        loadSsrHandler: async () => ({
          async handleSsr(rscStream, _navigationContext, _fontData, captureOptions) {
            void captureOptions?.sideStream?.cancel().catch(() => {});
            return createStream([`<html>${await new Response(rscStream).text()}</html>`]);
          },
        }),
        probePage() {
          throw new Error("loading.tsx should skip the eager page probe");
        },
        params: {},
        renderToReadableStream: renderPagePayloadToStream,
        revalidateSeconds: 60,
        route,
        searchParams,
      });
      const response = await runWithExecutionContext(executionContext, () =>
        dispatchAppPage(options),
      );
      await response.text();
      await Promise.all(waitUntilPromises.splice(0));
      return response;
    }

    const queryless = await request(new URLSearchParams());
    expect(queryless.headers.get("cache-control")).toContain("no-store");
    const cached = cache.get("html:/loading-static")?.value.value;
    expect(isCachedAppPageValue(cached)).toBe(true);
    if (!isCachedAppPageValue(cached)) throw new Error("expected cached loading page");
    expect(cached.renderObservation?.completeness).toBe("complete");
    expect(
      cached.renderObservation?.requestApis.find((api) => api.kind === "searchParams")?.status,
    ).toBe("notObserved");

    const queried = await request(new URLSearchParams({ q: "hello" }));
    expect(queried.headers.get("x-vinext-cache")).toBe("HIT");
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

  it("treats an empty generateStaticParams route as an on-demand static page", async () => {
    // Ported from Next.js build behavior: a defined empty prerenderedRoutes
    // array still marks the route as SSG with the default revalidate=false.
    // https://github.com/vercel/next.js/blob/canary/packages/next/src/build/index.ts
    const { options } = createDispatchOptions({
      generateStaticParams: async () => [],
      isProduction: true,
      route: createRoute({ isDynamic: true }),
    });

    const response = await dispatchAppPage(options);

    expect(response.status).toBe(200);
    // Ordinary streaming misses remain private until the response completes;
    // the CDN-admission E2E covers the manifest-backed public header.
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("x-vinext-cache")).toBe("MISS");
    await expect(response.text()).resolves.toBe("<html>page</html>");
    expect(options.isrSet).toHaveBeenCalled();
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
    const renderHttpAccessFallbackPage = vi.fn(
      async () => new Response('<html><h1 class="next-error-h1">404</h1></html>', { status: 404 }),
    );
    const { options } = createDispatchOptions({
      async buildPageElement() {
        throw new Error("unknown static params should not render the page");
      },
      async generateStaticParams() {
        return [{ slug: "known" }];
      },
      route: createRoute({ isDynamic: true, params: ["slug"] }),
    });
    options.renderHttpAccessFallbackPage = renderHttpAccessFallbackPage;

    const response = await dispatchAppPage({
      ...options,
      dynamicParamsConfig: false,
    });

    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toContain('class="next-error-h1"');
    expect(renderHttpAccessFallbackPage).toHaveBeenCalledWith(
      404,
      { matchedParams: { slug: "hello" } },
      options.middlewareContext,
    );
  });

  it("keeps request context alive while rendering a generated-param not-found response", async () => {
    const observedHeaderValues: Array<string | null> = [];
    let releaseStream!: () => void;
    const streamGate = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });
    const clearRequestContext = vi.fn(() => setHeadersContext(null));
    const renderHttpAccessFallbackPage = vi.fn(async () => {
      observedHeaderValues.push(getHeadersContext()?.headers.get("x-static-miss") ?? null);
      return new Response(
        new ReadableStream({
          async pull(controller) {
            await streamGate;
            observedHeaderValues.push(getHeadersContext()?.headers.get("x-static-miss") ?? null);
            controller.enqueue(new TextEncoder().encode("not found"));
            controller.close();
          },
        }),
        { status: 404 },
      );
    });
    const { options } = createDispatchOptions({
      clearRequestContext,
      async generateStaticParams() {
        return [{ slug: "known" }];
      },
      isRscRequest: true,
      route: createRoute({ isDynamic: true, params: ["slug"] }),
    });
    options.renderHttpAccessFallbackPage = renderHttpAccessFallbackPage;
    const requestContext = createRequestContext({
      headersContext: {
        cookies: new Map(),
        headers: new Headers({ "x-static-miss": "available" }),
      },
    });

    const response = await runWithRequestContext(requestContext, () =>
      dispatchAppPage({
        ...options,
        dynamicParamsConfig: false,
      }),
    );

    expect(response.status).toBe(404);
    expect(observedHeaderValues).toEqual(["available"]);
    releaseStream();
    await expect(response.text()).resolves.toBe("not found");
    expect(observedHeaderValues).toEqual(["available", "available"]);
    expect(clearRequestContext).not.toHaveBeenCalled();
  });

  it("rejects generated scalar params with different casing", async () => {
    const clearRequestContext = vi.fn();
    const { options } = createDispatchOptions({
      async buildPageElement() {
        throw new Error("case-mismatched static params should not render the page");
      },
      clearRequestContext,
      async generateStaticParams() {
        return [{ region: "SE" }, { region: "DE" }];
      },
      params: { region: "se" },
      route: createRoute({ isDynamic: true, params: ["region"] }),
    });

    const response = await dispatchAppPage({
      ...options,
      dynamicParamsConfig: false,
    });

    expect(response.status).toBe(404);
    expect(clearRequestContext).toHaveBeenCalledTimes(1);
  });

  it("rejects generated catch-all params with different casing", async () => {
    const { options } = createDispatchOptions({
      async buildPageElement() {
        throw new Error("case-mismatched static params should not render the page");
      },
      async generateStaticParams() {
        return [{ slug: ["Docs", "Getting-Started"] }];
      },
      params: { slug: ["docs", "getting-started"] },
      route: createRoute({ isDynamic: true, params: ["slug"] }),
    });

    const response = await dispatchAppPage({
      ...options,
      dynamicParamsConfig: false,
    });

    expect(response.status).toBe(404);
  });

  it('skips generated-param enforcement for production dynamic = "force-dynamic" routes', async () => {
    const buildPageElement = vi.fn(async () => React.createElement("main", null, "page"));
    const { options } = createDispatchOptions({
      buildPageElement,
      dynamicConfig: "force-dynamic",
      dynamicParamsConfig: false,
      async generateStaticParams() {
        return [{ region: "SE" }, { region: "DE" }];
      },
      isProduction: true,
      params: { region: "FR" },
      route: createRoute({ isDynamic: true, params: ["region"] }),
    });

    const response = await dispatchAppPage(options);

    expect(response.status).toBe(200);
    expect(buildPageElement).toHaveBeenCalled();
  });

  it('renders dynamic = "error" routes without generateStaticParams', async () => {
    const buildPageElement = vi.fn(async () => React.createElement("main", null, "page"));
    const { options } = createDispatchOptions({
      buildPageElement,
      dynamicConfig: "error",
      route: createRoute({ isDynamic: true, params: ["slug"] }),
    });

    const response = await dispatchAppPage(options);

    expect(response.status).toBe(200);
    expect(buildPageElement).toHaveBeenCalled();
  });

  for (const dynamicParamsConfig of [undefined, true] as const) {
    it(`renders unknown generated params under dynamic = "error" when dynamicParams is ${
      dynamicParamsConfig === undefined ? "implicit" : "true"
    }`, async () => {
      const buildPageElement = vi.fn(async () => React.createElement("main", null, "page"));
      const { options } = createDispatchOptions({
        buildPageElement,
        dynamicConfig: "error",
        dynamicParamsConfig,
        async generateStaticParams() {
          return [{ slug: "known" }];
        },
        route: createRoute({ isDynamic: true, params: ["slug"] }),
      });

      const response = await dispatchAppPage(options);

      expect(response.status).toBe(200);
      expect(buildPageElement).toHaveBeenCalled();
    });
  }

  it('returns not found for unknown generated params under dynamic = "error" when dynamicParams is false', async () => {
    const { options } = createDispatchOptions({
      async buildPageElement() {
        throw new Error("unknown static params should not render the page");
      },
      dynamicConfig: "error",
      dynamicParamsConfig: false,
      async generateStaticParams() {
        return [{ slug: "known" }];
      },
      route: createRoute({ isDynamic: true, params: ["slug"] }),
    });

    const response = await dispatchAppPage(options);

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
    const currentRoute = createRoute({
      isDynamic: true,
      params: ["id"],
      pattern: "/photos/[id]",
    });
    const middlewareHeaders = new Headers({ "x-from-middleware": "yes" });
    const setNavigationContext = vi.fn();
    let capturedInterceptOpts: Parameters<DispatchOptions["buildPageElement"]>[2];
    const { options } = createDispatchOptions({
      cleanPathname: "/photos/123",
      isProduction: true,
      async buildPageElement(route, params, opts) {
        capturedInterceptOpts = opts;
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
          interceptBranchSegments: ["(.)photos", "[id]"],
          interceptionGraphId: "graph-interception:/feed->/photos/:id",
          matchedParams: { id: "123" },
          notFound: { default: "modal-not-found" },
          notFoundTreePosition: 2,
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
    // The response renders the static /feed source, so the dynamic target's
    // classification doesn't make it uncacheable.
    expect(response.headers.get("cache-control")).toBeNull();
    await expect(response.text()).resolves.toBe("/feed:{}:modal@app/feed/@modal");
    expect(capturedInterceptOpts).toMatchObject({
      interceptGraphId: "graph-interception:/feed->/photos/:id",
      interceptBranchSegments: ["(.)photos", "[id]"],
      interceptNotFound: { default: "modal-not-found" },
      interceptNotFoundTreePosition: 2,
    });
    expect(setNavigationContext).toHaveBeenLastCalledWith({
      params: { id: "123", catchAll: ["photos", "123"] },
      pathname: "/photos/123",
      searchParams: new URLSearchParams("from=feed"),
    });
  });

  it("sends the never-cache header on intercepted RSC of a source route that can't be static", async () => {
    // app/photos/[id]/page.tsx generates its params, so the target is static,
    // but app/feed/page.tsx sets dynamic = "force-dynamic".
    const sourceRoute = createRoute({ params: [], pattern: "/feed", routeSegments: ["feed"] });
    const currentRoute = createRoute({
      isDynamic: true,
      params: ["id"],
      pattern: "/photos/[id]",
      routeSegments: ["photos", "[id]"],
    });
    const resolveRouteStaticEligible = vi.fn((route: TestRoute) => route !== sourceRoute);
    const { options } = createDispatchOptions({
      async buildPageElement(route) {
        return route.pattern;
      },
      cleanPathname: "/photos/123",
      findIntercept: () => ({
        matchedParams: { id: "123" },
        page: { default: "modal-page" },
        slotKey: "modal@app/feed/@modal",
        sourceRouteIndex: 1,
      }),
      generateStaticParams: async () => [{ id: "123" }],
      getSourceRoute(sourceRouteIndex) {
        return sourceRouteIndex === 1 ? sourceRoute : undefined;
      },
      isProduction: true,
      isRscRequest: true,
      renderToReadableStream(element) {
        return createStream([typeof element === "string" ? element : "unexpected-element"]);
      },
      resolveRouteDynamicConfig: (route) => (route === sourceRoute ? "force-dynamic" : undefined),
      resolveRouteStaticEligible,
      route: currentRoute,
    });

    const response = await dispatchAppPage(options);

    await expect(response.text()).resolves.toBe("/feed");
    expect(resolveRouteStaticEligible).toHaveBeenCalledWith(
      sourceRoute,
      expect.objectContaining({ interceptSlotKey: "modal@app/feed/@modal" }),
    );
    expect(response.headers.get("cache-control")).toBe(
      "private, no-cache, no-store, max-age=0, must-revalidate",
    );
  });

  it("classifies intercepted RSC with the intercepting branch in the source's slot", async () => {
    // app/feed/page.tsx is static, but app/feed/@modal/(.)photos/[id]/page.tsx
    // sets dynamic = "force-dynamic". Next.js serves the response from the
    // intercepting route, whose tree includes that page.
    const sourceRoute = createRoute({ params: [], pattern: "/feed", routeSegments: ["feed"] });
    const currentRoute = createRoute({
      params: ["id"],
      pattern: "/photos/[id]",
      routeSegments: ["photos", "[id]"],
    });
    const interceptLayouts = [{ default: "modal-layout" }];
    const interceptPage = { default: "modal-page", dynamic: "force-dynamic" };
    const resolveRouteStaticEligible = vi.fn<DispatchOptions["resolveRouteStaticEligible"]>(
      (_route, intercept) =>
        (intercept?.interceptPage as { dynamic?: string } | undefined)?.dynamic !== "force-dynamic",
    );
    const { options } = createDispatchOptions({
      async buildPageElement(route) {
        return route.pattern;
      },
      cleanPathname: "/photos/123",
      findIntercept: () => ({
        interceptBranchSegments: ["(.)photos", "[id]"],
        interceptLayouts,
        interceptLayoutSegments: [["(.)photos"]],
        matchedParams: { id: "123" },
        page: interceptPage,
        slotKey: "modal@app/feed/@modal",
        sourceRouteIndex: 1,
        targetPatternParts: ["feed", "photos", ":id"],
      }),
      getSourceRoute(sourceRouteIndex) {
        return sourceRouteIndex === 1 ? sourceRoute : undefined;
      },
      isProduction: true,
      isRscRequest: true,
      renderToReadableStream(element) {
        return createStream([typeof element === "string" ? element : "unexpected-element"]);
      },
      resolveRouteStaticEligible,
      route: currentRoute,
    });

    const response = await dispatchAppPage(options);

    await expect(response.text()).resolves.toBe("/feed");
    expect(resolveRouteStaticEligible).toHaveBeenCalledWith(sourceRoute, {
      interceptBranchSegments: ["(.)photos", "[id]"],
      interceptLayoutSegments: [["(.)photos"]],
      interceptLayouts,
      interceptPage,
      interceptSlotKey: "modal@app/feed/@modal",
      interceptTargetPatternParts: ["feed", "photos", ":id"],
    });
    expect(response.headers.get("cache-control")).toBe(
      "private, no-cache, no-store, max-age=0, must-revalidate",
    );
    // Dev keeps its no-store header.
    const devResponse = await dispatchAppPage({ ...options, isProduction: false });
    expect(devResponse.headers.get("cache-control")).toBe("no-store, must-revalidate");
    await devResponse.text();
  });

  it("classifies intercepted RSC with the owner's default the matched intercept loads", async () => {
    // app/feed/default.tsx sets dynamic = "force-static" and takes app/feed's
    // children in the intercepting route's tree. Only the matched intercept
    // loads it, so classification must see it hydrated.
    const sourceRoute = createRoute({
      params: [],
      pattern: "/feed",
      routeSegments: ["feed"],
      slots: { "modal@app/feed/@modal": { default: { default: "modal-default" } } },
    });
    const currentRoute = createRoute({
      params: ["id"],
      pattern: "/photos/[id]",
      routeSegments: ["photos", "[id]"],
    });
    const feedDefault = { default: "feed-default", dynamic: "force-static" };
    const intercept = {
      matchedParams: { id: "123" },
      ownerDefault: null,
      __loadOwnerDefault: vi.fn(async () => feedDefault),
      page: { default: "modal-page" },
      slotKey: "modal@app/feed/@modal",
      sourceRouteIndex: 1,
    };
    const resolveRouteStaticEligible = vi.fn<DispatchOptions["resolveRouteStaticEligible"]>(
      (_route, matched) =>
        (matched?.interceptOwnerDefault as { dynamic?: string } | undefined)?.dynamic ===
        "force-static",
    );
    const { options } = createDispatchOptions({
      async buildPageElement(route) {
        return route.pattern;
      },
      cleanPathname: "/photos/123",
      findIntercept: () => ({ ...intercept }),
      getSourceRoute(sourceRouteIndex) {
        return sourceRouteIndex === 1 ? sourceRoute : undefined;
      },
      isProduction: true,
      isRscRequest: true,
      renderToReadableStream(element) {
        return createStream([typeof element === "string" ? element : "unexpected-element"]);
      },
      resolveRouteStaticEligible,
      route: currentRoute,
    });

    const response = await dispatchAppPage(options);

    await expect(response.text()).resolves.toBe("/feed");
    expect(intercept.__loadOwnerDefault).toHaveBeenCalledTimes(1);
    expect(resolveRouteStaticEligible).toHaveBeenCalledWith(
      sourceRoute,
      expect.objectContaining({ interceptOwnerDefault: feedDefault }),
    );
    expect(response.headers.get("cache-control")).toBeNull();
  });

  it("renders intercepted RSC without the owner's default when the source lacks the slot", async () => {
    // A route-group variant of app/feed matched as the source has no @modal,
    // so its own page renders and app/feed/default.tsx, which throws at the
    // top level here, must not be evaluated.
    const sourceRoute = createRoute({ params: [], pattern: "/feed", routeSegments: ["feed"] });
    const currentRoute = createRoute({
      params: ["id"],
      pattern: "/photos/[id]",
      routeSegments: ["photos", "[id]"],
    });
    const intercept = {
      matchedParams: { id: "123" },
      ownerDefault: null,
      __loadOwnerDefault: vi.fn(async () => {
        throw new Error("app/feed/default.tsx must not be evaluated");
      }),
      page: { default: "modal-page" },
      slotKey: "modal@app/feed/@modal",
      sourceRouteIndex: 1,
    };
    const resolveRouteStaticEligible = vi.fn<DispatchOptions["resolveRouteStaticEligible"]>(
      () => true,
    );
    const { options } = createDispatchOptions({
      async buildPageElement(route) {
        return route.pattern;
      },
      cleanPathname: "/photos/123",
      findIntercept: () => ({ ...intercept }),
      getSourceRoute(sourceRouteIndex) {
        return sourceRouteIndex === 1 ? sourceRoute : undefined;
      },
      isProduction: true,
      isRscRequest: true,
      renderToReadableStream(element) {
        return createStream([typeof element === "string" ? element : "unexpected-element"]);
      },
      resolveRouteStaticEligible,
      route: currentRoute,
    });

    const response = await dispatchAppPage(options);

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("/feed");
    expect(intercept.__loadOwnerDefault).not.toHaveBeenCalled();
    expect(resolveRouteStaticEligible).toHaveBeenCalledWith(
      sourceRoute,
      expect.objectContaining({ interceptOwnerDefault: null }),
    );
  });

  describe("current-route interception cacheability", () => {
    // app/feed/page.tsx is static and owns app/feed/@modal, whose
    // (.)feed/[id] interception the /feed route renders itself. Next.js
    // classifies that intercepting route's own tree.
    const neverCache = "private, no-cache, no-store, max-age=0, must-revalidate";

    function createCurrentRouteDispatch(
      interceptPage: Record<string, unknown>,
      overrides: CreateDispatchOptionsOverrides = {},
    ) {
      const route = createRoute({
        params: [],
        pattern: "/feed",
        routeSegments: ["feed"],
        slots: { "modal@app/feed/@modal": { default: { default: "modal-default" } } },
      });
      const cachedEntry = buildISRCacheEntry(
        buildCachedAppPageValue(
          "",
          new TextEncoder().encode("cached-flight").buffer,
          undefined,
          buildQueryInvariantRenderObservation(),
        ),
      );
      const isrGet = vi.fn(async () => cachedEntry);
      const isrSet = vi.fn<DispatchOptions["isrSet"]>(async () => {});
      const resolveRouteStaticEligible = vi.fn<DispatchOptions["resolveRouteStaticEligible"]>(
        (_route, intercept) =>
          (intercept?.interceptPage as { dynamic?: string } | undefined)?.dynamic !==
          "force-dynamic",
      );
      // The intercepting tree's config is its page's, as generated.
      const interceptConfig = (
        intercept: Parameters<NonNullable<DispatchOptions["resolveRouteDynamicConfig"]>>[1],
      ) =>
        intercept?.interceptPage as
          | { dynamic?: string; revalidate?: number; unstable_dynamicStaleTime?: number }
          | undefined;
      const buildPageElement = vi.fn<DispatchOptions["buildPageElement"]>(
        async (_route, _params, opts) => opts?.interceptSlotKey ?? "direct",
      );
      const { options } = createDispatchOptions({
        buildPageElement,
        cleanPathname: "/feed",
        findIntercept: () => ({
          matchedParams: {},
          page: interceptPage,
          slotKey: "modal@app/feed/@modal",
          sourceRouteIndex: 0,
        }),
        getSourceRoute: (sourceRouteIndex) => (sourceRouteIndex === 0 ? route : undefined),
        interceptionContext: "/feed",
        isProduction: true,
        isRscRequest: true,
        isrGet,
        isrSet,
        params: {},
        renderToReadableStream: () => createStream(["fresh-flight"]),
        resolveRouteDynamicConfig: (_route, intercept) => interceptConfig(intercept)?.dynamic,
        resolveRouteRevalidateSeconds: (_route, intercept) =>
          interceptConfig(intercept)?.revalidate ?? null,
        resolveRouteDynamicStaleTimeSeconds: (_route, intercept) =>
          interceptConfig(intercept)?.unstable_dynamicStaleTime,
        resolveRouteStaticEligible,
        revalidateSeconds: 60,
        route,
        ...overrides,
      });
      return { buildPageElement, isrGet, isrSet, options, resolveRouteStaticEligible, route };
    }

    // Renders a cache miss and waits for its background write.
    async function dispatchMiss(overrides: CreateDispatchOptionsOverrides & { page: object }) {
      const { page, ...dispatchOverrides } = overrides;
      const isrGet = vi.fn(async () => null);
      const dispatch = createCurrentRouteDispatch(page as Record<string, unknown>, {
        isrGet,
        ...dispatchOverrides,
      });
      const waitUntilPromises: Promise<unknown>[] = [];
      const response = await runWithExecutionContext(
        { waitUntil: (promise) => waitUntilPromises.push(promise) },
        () => dispatchAppPage(dispatch.options),
      );
      await expect(response.text()).resolves.toBe("fresh-flight");
      await Promise.all(waitUntilPromises);
      return { ...dispatch, isrGet, response };
    }

    it.each([
      ["force-dynamic", { dynamicConfig: "force-dynamic" }],
      ["revalidate = 0", { revalidateSeconds: 0 }],
    ])(
      "admits and stores a static sibling-page intercept over a %s page",
      async (_name, baseConfig) => {
        // The intercepting branch replaces app/feed/page.tsx, and its tree
        // keeps none of that page's config.
        const page = { default: "photo-page", revalidate: 30 };
        const { isrGet, isrSet, response } = await dispatchMiss({
          ...baseConfig,
          findIntercept: () => ({
            matchedParams: {},
            page,
            slotKey: "__vinext_page_intercept",
            sourceRouteIndex: 0,
          }),
          page,
        });

        expect(response.headers.get("x-vinext-cache")).toBe("MISS");
        expect(isrGet).toHaveBeenCalledTimes(1);
        expect(isrSet).toHaveBeenCalledTimes(1);
        expect(isrSet.mock.calls[0]![2].cacheControl.revalidate).toBe(30);
      },
    );

    it("reads, advertises and stores its variant with the intercepting tree's revalidate", async () => {
      const page = { default: "modal-page", revalidate: 10 };
      const hit = createCurrentRouteDispatch(page, { revalidateSeconds: 3600 });
      const hitResponse = await dispatchAppPage(hit.options);

      expect(hitResponse.headers.get("x-vinext-cache")).toBe("HIT");
      expect(hitResponse.headers.get("cache-control")).toBe("s-maxage=10, stale-while-revalidate");

      const { isrSet, response } = await dispatchMiss({ page, revalidateSeconds: 3600 });

      expect(response.headers.get("x-vinext-cache")).toBe("MISS");
      expect(isrSet).toHaveBeenCalledTimes(1);
      expect(isrSet.mock.calls[0]![2].cacheControl.revalidate).toBe(10);
    });

    it("stores a force-static intercepting tree over a route without a revalidate", async () => {
      // app/feed is edge, so it has no static revalidate default of its own.
      const { isrSet, response } = await dispatchMiss({
        isStaticGenerationEdgeRuntime: true,
        page: { default: "modal-page", dynamic: "force-static" },
        revalidateSeconds: null,
      });

      expect(response.headers.get("x-vinext-cache")).toBe("STATIC");
      expect(isrSet).toHaveBeenCalledTimes(1);
      expect(isrSet.mock.calls[0]![2].cacheControl.revalidate).toBe(Infinity);
    });

    // In a cacheComponents build only generateStaticParams sets the
    // `revalidate = false` default of a tree without a revalidate.
    async function dispatchPprMiss(
      interceptExports: { generateStaticParams?: () => unknown[] },
      routeHasGenerator: boolean,
    ) {
      const page = { default: "modal-page", ...interceptExports };
      // The intercepting tree's generators are its page's, as generated.
      const resolveRouteHasAnyGenerateStaticParams = vi.fn<
        NonNullable<DispatchOptions["resolveRouteHasAnyGenerateStaticParams"]>
      >(
        (_route, intercept) =>
          intercept.interceptPage === page && typeof page.generateStaticParams === "function",
      );
      const result = await dispatchMiss({
        hasAnyGenerateStaticParams: routeHasGenerator,
        page,
        pprRuntime: appPagePprRuntime,
        resolveRouteHasAnyGenerateStaticParams,
        revalidateSeconds: null,
      });
      return { ...result, page, resolveRouteHasAnyGenerateStaticParams };
    }

    it("keeps the revalidate = false default from the intercepting tree's generateStaticParams in a cacheComponents build", async () => {
      const { isrSet, page, resolveRouteHasAnyGenerateStaticParams, response, route } =
        await dispatchPprMiss({ generateStaticParams: () => [] }, false);

      expect(response.headers.get("x-vinext-cache")).toBe("MISS");
      expect(resolveRouteHasAnyGenerateStaticParams).toHaveBeenCalledWith(
        route,
        expect.objectContaining({ interceptPage: page }),
      );
      expect(isrSet).toHaveBeenCalledTimes(1);
      expect(isrSet.mock.calls[0]![2].cacheControl.revalidate).toBe(Infinity);
    });

    it("drops the revalidate = false default from the replaced branch's generateStaticParams in a cacheComponents build", async () => {
      // app/feed/@modal/page.tsx exports generateStaticParams, but the
      // intercepting page that replaces it doesn't.
      const { isrSet, response } = await dispatchPprMiss({}, true);

      expect(response.headers.get("x-vinext-cache")).toBeNull();
      expect(isrSet).not.toHaveBeenCalled();
    });

    it("neither reads nor stores its variant when the intercepting tree can't be static", async () => {
      const interceptPage = { default: "modal-page", dynamic: "force-dynamic" };
      const { buildPageElement, isrGet, isrSet, options, resolveRouteStaticEligible, route } =
        createCurrentRouteDispatch(interceptPage);

      const response = await dispatchAppPage(options);

      await expect(response.text()).resolves.toBe("fresh-flight");
      expect(response.headers.get("x-vinext-cache")).toBeNull();
      expect(response.headers.get("cache-control")).toBe(neverCache);
      expect(isrGet).not.toHaveBeenCalled();
      expect(isrSet).not.toHaveBeenCalled();
      expect(resolveRouteStaticEligible).toHaveBeenCalledWith(
        route,
        expect.objectContaining({ interceptPage }),
      );
      expect(buildPageElement).toHaveBeenCalledWith(
        route,
        {},
        expect.objectContaining({ interceptSlotKey: "modal@app/feed/@modal" }),
        expect.any(URLSearchParams),
        expect.anything(),
        expect.anything(),
      );
    });

    it("reads its variant when the intercepting tree is static but the route's own isn't", async () => {
      // app/feed/@modal/page.tsx is edge, but the intercepting branch takes
      // its place in the intercepting route's tree.
      const { isrGet, options } = createCurrentRouteDispatch(
        { default: "modal-page" },
        { isStaticGenerationEdgeRuntime: true },
      );

      const response = await dispatchAppPage(options);

      await expect(response.text()).resolves.toBe("cached-flight");
      expect(response.headers.get("x-vinext-cache")).toBe("HIT");
      expect(isrGet).toHaveBeenCalledTimes(1);
    });

    it("sends the uncacheable header on an uncached render of a dynamic intercepting tree", async () => {
      // Outside production the cache is never read, so only the render
      // policy classifies the intercepting tree. Dev keeps its no-store header.
      const { isrGet, isrSet, options } = createCurrentRouteDispatch(
        { default: "modal-page", dynamic: "force-dynamic" },
        { isProduction: false },
      );

      const response = await dispatchAppPage(options);

      await expect(response.text()).resolves.toBe("fresh-flight");
      expect(response.headers.get("cache-control")).toBe("no-store, must-revalidate");
      expect(isrGet).not.toHaveBeenCalled();
      expect(isrSet).not.toHaveBeenCalled();
    });

    // Renders a sibling-page intercept whose dynamic config is the inverse of
    // the page it replaces, and records the render policy its element is
    // built under.
    async function renderInverseConfigIntercept(
      interceptDynamic: string,
      overrides: CreateDispatchOptionsOverrides,
    ) {
      const renders: Record<string, unknown>[] = [];
      const page = { default: "photo-page", dynamic: interceptDynamic };
      const { options } = createCurrentRouteDispatch(page, {
        async buildPageElement(_route, _params, opts, searchParams, _paramAccess, buildOptions) {
          renders.push({
            forceDynamicFetchDefault: getRequestContext().currentForceDynamicFetchDefault,
            observePageSearchParamsAccess: buildOptions?.observePageSearchParamsAccess,
            requestHeader: getHeadersContext()?.headers.get("x-request-value") ?? null,
            search: searchParams.toString(),
          });
          return opts?.interceptSlotKey ?? "direct";
        },
        findIntercept: () => ({
          matchedParams: {},
          page,
          slotKey: "__vinext_page_intercept",
          sourceRouteIndex: 0,
        }),
        isrGet: vi.fn(async () => null),
        searchParams: new URLSearchParams("q=1"),
        ...overrides,
      });
      const requestContext = createRequestContext({
        headersContext: {
          cookies: new Map(),
          headers: new Headers({ "x-request-value": "request" }),
        },
      });
      const response = await runWithRequestContext(requestContext, () => dispatchAppPage(options));
      await expect(response.text()).resolves.toBe("fresh-flight");
      return renders;
    }

    const staticRender = {
      forceDynamicFetchDefault: false,
      observePageSearchParamsAccess: false,
      requestHeader: null,
      search: "",
    };
    const dynamicRender = {
      forceDynamicFetchDefault: true,
      observePageSearchParamsAccess: true,
      requestHeader: "request",
      search: "q=1",
    };

    it.each([
      ["in dev", { isProduction: false }],
      ["in a cacheComponents build", { pprRuntime: appPagePprRuntime }],
      ["for an unverified interception context", { bypassInterceptionContextCache: true }],
    ])(
      "renders a force-static intercepting tree over a force-dynamic page as static %s",
      async (_name, overrides) => {
        const renders = await renderInverseConfigIntercept("force-static", {
          dynamicConfig: "force-dynamic",
          revalidateSeconds: 0,
          ...overrides,
        });

        expect(renders).toEqual([staticRender]);
      },
    );

    it.each([
      ["in dev", { isProduction: false }],
      ["in a cacheComponents build", { pprRuntime: appPagePprRuntime }],
      ["for an unverified interception context", { bypassInterceptionContextCache: true }],
    ])(
      "renders a force-dynamic intercepting tree over a force-static page as dynamic %s",
      async (_name, overrides) => {
        const renders = await renderInverseConfigIntercept("force-dynamic", {
          dynamicConfig: "force-static",
          revalidateSeconds: null,
          ...overrides,
        });

        expect(renders).toEqual([dynamicRender]);
      },
    );

    it.each([
      ["force-dynamic", undefined, undefined],
      ["force-static", "force-dynamic", 'dynamic = "force-dynamic"'],
    ])(
      "marks a cacheability probe's pattern from the route's own config, not a %s intercepting tree's",
      async (interceptDynamic, routeDynamic, patternDynamicReason) => {
        // The pattern covers every request to the route, while the
        // intercepting tree renders only this one.
        const context: ExecutionContextLike = { waitUntil() {} };
        const state: RouteCacheabilityState = {
          captureDeadlineAt: Date.now() + 10_000,
          mode: "probe",
        };
        Reflect.set(context, CACHEABILITY_REQUEST_STATE, state);
        const forceDynamicFetchDefaults: boolean[] = [];
        const page = { default: "photo-page", dynamic: interceptDynamic };
        const { options } = createCurrentRouteDispatch(page, {
          async buildPageElement(_route, _params, opts) {
            forceDynamicFetchDefaults.push(getRequestContext().currentForceDynamicFetchDefault);
            return opts?.interceptSlotKey ?? "direct";
          },
          dynamicConfig: routeDynamic,
          findIntercept: () => ({
            matchedParams: {},
            page,
            slotKey: "__vinext_page_intercept",
            sourceRouteIndex: 0,
          }),
          revalidateSeconds: routeDynamic === "force-dynamic" ? 0 : null,
        });

        const response = await runWithExecutionContext(context, () =>
          runWithRequestContext(createRequestContext(), () => dispatchAppPage(options)),
        );
        await response.text();

        expect(state.patternDynamicReason).toBe(patternDynamicReason);
        expect(forceDynamicFetchDefaults).toEqual([interceptDynamic === "force-dynamic"]);
      },
    );

    it.each([
      ["its own", 5, "5"],
      // Without one, the configured staleTimes.dynamic applies.
      ["the configured", undefined, "0"],
    ])(
      "advertises %s dynamic stale time for a sibling-page intercept, not the replaced page's",
      async (_name, interceptStaleTime, header) => {
        // app/feed/page.tsx sets unstable_dynamicStaleTime = 300, but the
        // intercepting page replaces it.
        const page = {
          default: "photo-page",
          dynamic: "force-dynamic",
          unstable_dynamicStaleTime: interceptStaleTime,
        };
        const { options } = createCurrentRouteDispatch(page, {
          dynamicConfig: "force-dynamic",
          dynamicStaleTimeSeconds: 300,
          findIntercept: () => ({
            matchedParams: {},
            page,
            slotKey: "__vinext_page_intercept",
            sourceRouteIndex: 0,
          }),
        });

        const response = await dispatchAppPage(options);

        await expect(response.text()).resolves.toBe("fresh-flight");
        expect(response.headers.get(VINEXT_DYNAMIC_STALE_TIME_HEADER)).toBe(header);
      },
    );

    it("classifies the intercepting tree with the owner's default it loads", async () => {
      const feedDefault = { default: "feed-default", dynamic: "force-static" };
      const __loadOwnerDefault = vi.fn(async () => feedDefault);
      // The manifest's intercept is one object, which keeps what it loads.
      const intercept = {
        __loadOwnerDefault,
        matchedParams: {},
        ownerDefault: null,
        page: { default: "modal-page" },
        slotKey: "modal@app/feed/@modal",
        sourceRouteIndex: 0,
      };
      const { options, resolveRouteStaticEligible, route } = createCurrentRouteDispatch(
        { default: "modal-page" },
        { findIntercept: () => intercept },
      );

      const response = await dispatchAppPage(options);

      await expect(response.text()).resolves.toBe("cached-flight");
      expect(__loadOwnerDefault).toHaveBeenCalledTimes(1);
      expect(resolveRouteStaticEligible).toHaveBeenCalledWith(
        route,
        expect.objectContaining({ interceptOwnerDefault: feedDefault }),
      );
    });

    function createUnattachedInterceptDispatch(overrides: CreateDispatchOptionsOverrides = {}) {
      // A route-group variant of app/feed without @modal is the source, so it
      // renders unchanged and the unused intercepting tree, whose modules
      // throw at the top level here, must not be evaluated.
      const route = createRoute({ params: [], pattern: "/feed", routeSegments: ["feed"] });
      const loaders = {
        __loadInterceptLayouts: [
          vi.fn(async () => {
            throw new Error("the intercepting layout must not be evaluated");
          }),
        ],
        __loadNotFound: vi.fn(async () => {
          throw new Error("the intercepting not-found must not be evaluated");
        }),
        __loadOwnerDefault: vi.fn(async () => {
          throw new Error("app/feed/default.tsx must not be evaluated");
        }),
        __pageLoader: vi.fn(async () => {
          throw new Error("the intercepting page must not be evaluated");
        }),
      };
      const dispatch = createCurrentRouteDispatch(
        { default: "modal-page" },
        {
          findIntercept: () => ({
            ...loaders,
            interceptLayouts: [null],
            matchedParams: {},
            notFound: null,
            ownerDefault: null,
            page: null,
            slotKey: "modal@app/feed/@modal",
            sourceRouteIndex: 0,
          }),
          getSourceRoute: () => route,
          route,
          ...overrides,
        },
      );
      return { ...dispatch, loaders, route };
    }

    function expectNoInterceptLoads(
      loaders: ReturnType<typeof createUnattachedInterceptDispatch>["loaders"],
    ) {
      expect(loaders.__pageLoader).not.toHaveBeenCalled();
      expect(loaders.__loadNotFound).not.toHaveBeenCalled();
      expect(loaders.__loadOwnerDefault).not.toHaveBeenCalled();
      expect(loaders.__loadInterceptLayouts[0]).not.toHaveBeenCalled();
    }

    it("serves a cached variant without loading a slot intercept the route has no slot for", async () => {
      const { isrGet, loaders, options, resolveRouteStaticEligible, route } =
        createUnattachedInterceptDispatch();

      const response = await dispatchAppPage(options);

      await expect(response.text()).resolves.toBe("cached-flight");
      expect(response.headers.get("x-vinext-cache")).toBe("HIT");
      expect(isrGet).toHaveBeenCalledTimes(1);
      expectNoInterceptLoads(loaders);
      expect(resolveRouteStaticEligible).toHaveBeenCalledWith(
        route,
        expect.objectContaining({ interceptPage: null, interceptSlotKey: "modal@app/feed/@modal" }),
      );
    });

    it("regenerates a stale variant without loading a slot intercept the route has no slot for", async () => {
      const staleEntry = buildISRCacheEntry(
        buildCachedAppPageValue(
          "",
          new TextEncoder().encode("cached-flight").buffer,
          undefined,
          buildQueryInvariantRenderObservation(),
        ),
        true,
      );
      let regeneration: Promise<void> | undefined;
      const { buildPageElement, loaders, options } = createUnattachedInterceptDispatch({
        isrGet: vi.fn(async () => staleEntry),
        scheduleBackgroundRegeneration: vi.fn((_key, renderFn) => {
          regeneration = renderFn();
        }),
      });

      const response = await dispatchAppPage(options);

      await expect(response.text()).resolves.toBe("cached-flight");
      expect(response.headers.get("x-vinext-cache")).toBe("STALE");
      // Only the rerender target's module loading matters here, not the write.
      await regeneration?.catch(() => {});
      expect(buildPageElement).toHaveBeenCalledTimes(1);
      expectNoInterceptLoads(loaders);
    });

    it("renders a cache miss without loading a slot intercept the route has no slot for", async () => {
      const isrGet = vi.fn(async () => null);
      const { buildPageElement, loaders, options } = createUnattachedInterceptDispatch({ isrGet });

      const response = await dispatchAppPage(options);

      await expect(response.text()).resolves.toBe("fresh-flight");
      expect(isrGet).toHaveBeenCalledTimes(1);
      expect(buildPageElement).toHaveBeenCalledTimes(1);
      expectNoInterceptLoads(loaders);
    });

    function createGeneratedParamsDispatch(overrides: CreateDispatchOptionsOverrides = {}) {
      // /feed/[slug] renders the (.)feed/[slug]/[id] interception in its own
      // @modal slot. app/feed/[slug]/layout.tsx exports dynamicParams = false
      // and generateStaticParams, so the intercepting tree keeps both.
      const generateStaticParams = vi.fn(async () => [{ slug: "known" }]);
      const route = createRoute({
        isDynamic: true,
        params: ["slug"],
        pattern: "/feed/:slug",
        routeSegments: ["feed", "[slug]"],
        slots: { "modal@app/feed/[slug]/@modal": {} },
      });
      const dispatch = createCurrentRouteDispatch(
        { default: "modal-page" },
        {
          cleanPathname: "/feed/unknown",
          dynamicParamsConfig: false,
          findIntercept: () => ({
            matchedParams: { slug: "unknown" },
            page: { default: "modal-page" },
            slotKey: "modal@app/feed/[slug]/@modal",
            sourceRouteIndex: 0,
          }),
          generateStaticParams,
          getSourceRoute: () => route,
          params: { slug: "unknown" },
          resolveRouteDynamicParamsConfig: () => false,
          resolveRouteGenerateStaticParams: () => generateStaticParams,
          route,
          ...overrides,
        },
      );
      return { ...dispatch, generateStaticParams, route };
    }

    it("serves a cached variant without generating the route's static params", async () => {
      // Like any other request, generated params are checked only on a miss.
      const { generateStaticParams, isrGet, options } = createGeneratedParamsDispatch();

      const response = await dispatchAppPage(options);

      await expect(response.text()).resolves.toBe("cached-flight");
      expect(response.headers.get("x-vinext-cache")).toBe("HIT");
      expect(isrGet).toHaveBeenCalledTimes(1);
      expect(generateStaticParams).not.toHaveBeenCalled();
    });

    it("404s a generated-params miss once the cache misses", async () => {
      const isrGet = vi.fn(async () => null);
      const { buildPageElement, generateStaticParams, isrSet, options } =
        createGeneratedParamsDispatch({ isrGet });

      const response = await dispatchAppPage(options);

      expect(response.status).toBe(404);
      expect(isrGet).toHaveBeenCalledTimes(1);
      expect(generateStaticParams).toHaveBeenCalledTimes(1);
      expect(buildPageElement).not.toHaveBeenCalled();
      expect(isrSet).not.toHaveBeenCalled();
    });

    it.each([
      ["rendered", true],
      ["plain", false],
    ])(
      "sends the never-cache header on a %s generated-params miss of a dynamic intercepting tree",
      async (_kind, rendersNotFound) => {
        // The intercepting tree skipped the cache, so its 404 is never-cache
        // like its normal render, even though the route's own tree is static.
        // Its revalidate = 0 keeps the params gate, which a force-dynamic tree
        // skips in production.
        const interceptPage = { default: "modal-page", revalidate: 0 };
        const { buildPageElement, generateStaticParams, isrGet, isrSet, options } =
          createGeneratedParamsDispatch({
            findIntercept: () => ({
              matchedParams: { slug: "unknown" },
              page: interceptPage,
              slotKey: "modal@app/feed/[slug]/@modal",
              sourceRouteIndex: 0,
            }),
            resolveRouteStaticEligible: (_route, intercept) => intercept === undefined,
          });
        if (rendersNotFound) {
          options.renderHttpAccessFallbackPage = vi.fn(
            async () => new Response("not-found", { status: 404 }),
          );
        }

        const response = await dispatchAppPage(options);

        expect(response.status).toBe(404);
        expect(response.headers.get("cache-control")).toBe(neverCache);
        expect(isrGet).not.toHaveBeenCalled();
        expect(generateStaticParams).toHaveBeenCalledTimes(1);
        expect(buildPageElement).not.toHaveBeenCalled();
        expect(isrSet).not.toHaveBeenCalled();
      },
    );

    it.each([
      ["in dev", { isProduction: false }, "no-store, must-revalidate"],
      [
        "when the interception cache is bypassed",
        { bypassInterceptionContextCache: true },
        neverCache,
      ],
    ])(
      "sends the never-cache header on a generated-params miss of a dynamic intercepting tree %s",
      async (_kind, readSkippingOverrides, cacheControl) => {
        // No cache read classifies the intercepting tree here, so the miss must
        // load and classify it before responding, like its normal render. Its
        // revalidate = 0 keeps the params gate, which a force-dynamic tree
        // skips in production.
        const interceptPage = { default: "modal-page", revalidate: 0 };
        const __pageLoader = vi.fn(async () => interceptPage);
        const { buildPageElement, generateStaticParams, isrGet, isrSet, options } =
          createGeneratedParamsDispatch({
            findIntercept: () => ({
              __pageLoader,
              matchedParams: { slug: "unknown" },
              page: null,
              slotKey: "modal@app/feed/[slug]/@modal",
              sourceRouteIndex: 0,
            }),
            resolveRouteStaticEligible: (_route, intercept) => intercept === undefined,
            ...readSkippingOverrides,
          });

        const response = await dispatchAppPage(options);

        expect(response.status).toBe(404);
        expect(response.headers.get("cache-control")).toBe(cacheControl);
        expect(__pageLoader).toHaveBeenCalledTimes(1);
        expect(isrGet).not.toHaveBeenCalled();
        expect(generateStaticParams).toHaveBeenCalledTimes(1);
        expect(buildPageElement).not.toHaveBeenCalled();
        expect(isrSet).not.toHaveBeenCalled();
      },
    );

    it("404s a generated-params miss in dev without loading a slot intercept the route has no slot for", async () => {
      const generateStaticParams = vi.fn(async () => [{ slug: "known" }]);
      const { buildPageElement, isrGet, loaders, options, route } =
        createUnattachedInterceptDispatch({
          cleanPathname: "/feed/unknown",
          dynamicParamsConfig: false,
          generateStaticParams,
          isProduction: false,
          params: { slug: "unknown" },
          // An unattached intercept leaves the route's own tree, as generated.
          resolveRouteDynamicParamsConfig: () => false,
          resolveRouteGenerateStaticParams: () => generateStaticParams,
        });
      // The route-group variant is dynamic too: app/(group)/feed/[slug].
      route.isDynamic = true;

      const response = await dispatchAppPage(options);

      expect(response.status).toBe(404);
      expect(isrGet).not.toHaveBeenCalled();
      expect(generateStaticParams).toHaveBeenCalledTimes(1);
      expect(buildPageElement).not.toHaveBeenCalled();
      expectNoInterceptLoads(loaders);
    });

    // app/feed/[slug]/@modal/(.)[slug]/page.tsx intercepts /feed/[slug] from
    // itself, in place of app/feed/[slug]/@modal/default.tsx, and the
    // intercepting tree drops app/feed/[slug]/page.tsx. Only the intercepting
    // tree's own segments set its dynamicParams and generators, as generated.
    type InterceptPage = {
      default: string;
      dynamicParams?: boolean;
      generateStaticParams?: () => Promise<Record<string, string>[]>;
    };
    function dispatchInterceptedGeneratedParams(
      interceptPage: InterceptPage,
      slug: string,
      overrides: CreateDispatchOptionsOverrides = {},
    ) {
      const isrGet = vi.fn(async () => null);
      const resolveRouteDynamicParamsConfig = vi.fn<
        NonNullable<DispatchOptions["resolveRouteDynamicParamsConfig"]>
      >((_route, intercept) => (intercept.interceptPage as InterceptPage).dynamicParams);
      const resolveRouteGenerateStaticParams = vi.fn<
        NonNullable<DispatchOptions["resolveRouteGenerateStaticParams"]>
      >((_route, intercept) => {
        const generator = (intercept.interceptPage as InterceptPage).generateStaticParams;
        return generator ? [generator] : [];
      });
      const dispatch = createGeneratedParamsDispatch({
        cleanPathname: `/feed/${slug}`,
        findIntercept: () => ({
          matchedParams: { slug },
          page: interceptPage,
          slotKey: "modal@app/feed/[slug]/@modal",
          sourceRouteIndex: 0,
        }),
        isrGet,
        params: { slug },
        resolveRouteDynamicParamsConfig,
        resolveRouteGenerateStaticParams,
        ...overrides,
      });
      return {
        ...dispatch,
        isrGet,
        resolveRouteDynamicParamsConfig,
        resolveRouteGenerateStaticParams,
        response: dispatchAppPage(dispatch.options),
      };
    }

    it("404s a param the intercepting tree's dynamicParams = false doesn't generate over a route that allows it", async () => {
      const interceptGenerator = vi.fn(async () => [{ slug: "known" }]);
      const interceptPage = {
        default: "modal-page",
        dynamicParams: false,
        generateStaticParams: interceptGenerator,
      };
      // app/feed/[slug]/page.tsx allows any slug and has no generator.
      const routeConfig = { dynamicParamsConfig: undefined, generateStaticParams: undefined };
      const miss = dispatchInterceptedGeneratedParams(interceptPage, "unknown", routeConfig);
      const response = await miss.response;

      expect(response.status).toBe(404);
      expect(miss.isrGet).toHaveBeenCalledTimes(1);
      expect(miss.resolveRouteDynamicParamsConfig).toHaveBeenCalledWith(
        miss.route,
        expect.objectContaining({ interceptPage }),
      );
      expect(miss.resolveRouteGenerateStaticParams).toHaveBeenCalledWith(
        miss.route,
        expect.objectContaining({ interceptPage }),
      );
      expect(interceptGenerator).toHaveBeenCalledTimes(1);
      expect(miss.buildPageElement).not.toHaveBeenCalled();

      const known = dispatchInterceptedGeneratedParams(interceptPage, "known", routeConfig);
      const knownResponse = await known.response;

      expect(knownResponse.status).toBe(200);
      await expect(knownResponse.text()).resolves.toBe("fresh-flight");
    });

    it("renders any param under an intercepting tree that allows it over a dynamicParams = false route", async () => {
      // app/feed/[slug]/page.tsx exports dynamicParams = false and generates
      // only "known", but the intercepting tree drops it.
      const { buildPageElement, generateStaticParams, response } =
        dispatchInterceptedGeneratedParams({ default: "modal-page" }, "other");

      const rendered = await response;
      expect(rendered.status).toBe(200);
      await expect(rendered.text()).resolves.toBe("fresh-flight");
      expect(generateStaticParams).not.toHaveBeenCalled();
      expect(buildPageElement).toHaveBeenCalledTimes(1);
    });

    it("checks the intercepting tree's generators, not the replaced branch's, over a dynamicParams = false route", async () => {
      const interceptGenerator = vi.fn(async () => [{ slug: "other" }]);
      const interceptPage = {
        default: "modal-page",
        dynamicParams: false,
        generateStaticParams: interceptGenerator,
      };
      // The route's generators allow only "known"; the intercepting tree's
      // allow only "other".
      const other = dispatchInterceptedGeneratedParams(interceptPage, "other");
      const otherResponse = await other.response;

      expect(otherResponse.status).toBe(200);
      await expect(otherResponse.text()).resolves.toBe("fresh-flight");
      expect(interceptGenerator).toHaveBeenCalledTimes(1);
      expect(other.generateStaticParams).not.toHaveBeenCalled();

      const known = dispatchInterceptedGeneratedParams(interceptPage, "known");
      const knownResponse = await known.response;

      expect(knownResponse.status).toBe(404);
      expect(known.generateStaticParams).not.toHaveBeenCalled();
      expect(known.buildPageElement).not.toHaveBeenCalled();
    });

    it("checks the params the intercepting tree renders with", async () => {
      // app/feed/[slug]/@modal/(.)[photo]/page.tsx names the param photo.
      const interceptGenerator = vi.fn(async () => [{ photo: "known" }]);
      const interceptPage = {
        default: "modal-page",
        dynamicParams: false,
        generateStaticParams: interceptGenerator,
      };
      const { options } = createGeneratedParamsDispatch({
        cleanPathname: "/feed/unknown",
        findIntercept: () => ({
          matchedParams: { photo: "unknown", slug: "unknown" },
          page: interceptPage,
          slotKey: "modal@app/feed/[slug]/@modal",
          sourceRouteIndex: 0,
        }),
        isrGet: vi.fn(async () => null),
        resolveRouteDynamicParamsConfig: () => false,
        resolveRouteGenerateStaticParams: () => [interceptGenerator],
      });

      const response = await dispatchAppPage(options);

      expect(response.status).toBe(404);
      expect(interceptGenerator).toHaveBeenCalledTimes(1);
    });

    // A cache miss of the static /feed rendering its @modal intercept with the
    // given branch, params and generators, under dynamicParams = false.
    async function dispatchStaticSourceIntercept(
      interceptBranchSegments: string[],
      matchedParams: Record<string, string | string[]>,
      generateStaticParams: () => Promise<Record<string, unknown>[]>,
    ) {
      const interceptPage = { default: "modal-page", dynamicParams: false, generateStaticParams };
      const { buildPageElement, options } = createCurrentRouteDispatch(interceptPage, {
        findIntercept: () => ({
          interceptBranchSegments,
          matchedParams,
          page: interceptPage,
          slotKey: "modal@app/feed/@modal",
          sourceRouteIndex: 0,
        }),
        isrGet: vi.fn(async () => null),
        resolveRouteDynamicParamsConfig: () => false,
        resolveRouteGenerateStaticParams: () => [generateStaticParams],
      });
      const response = await dispatchAppPage(options);
      return { buildPageElement, response };
    }

    it("gates the params of an intercepting tree's own dynamic segments under a static route", async () => {
      // app/feed/page.tsx is static, but app/feed/@modal/(.)photo/[id] adds
      // [id] to the intercepting route's tree.
      const generator = vi.fn(async () => [{ id: "known" }]);
      const unknown = await dispatchStaticSourceIntercept(
        ["photo", "[id]"],
        { id: "unknown" },
        generator,
      );

      expect(unknown.response.status).toBe(404);
      expect(generator).toHaveBeenCalledTimes(1);
      expect(unknown.buildPageElement).not.toHaveBeenCalled();

      const known = await dispatchStaticSourceIntercept(
        ["photo", "[id]"],
        { id: "known" },
        generator,
      );

      expect(known.response.status).toBe(200);
      await expect(known.response.text()).resolves.toBe("fresh-flight");
    });

    it("gates an intercepting tree's omitted optional catch-all by an explicit empty value", async () => {
      // app/feed/@modal/(.)[[...photo]] matches without a photo param, a path
      // Next.js generates only from an explicit empty value.
      const known = await dispatchStaticSourceIntercept(["[[...photo]]"], {}, async () => [
        { photo: ["known"] },
      ]);

      expect(known.response.status).toBe(404);
      expect(known.buildPageElement).not.toHaveBeenCalled();

      const empty = await dispatchStaticSourceIntercept(["[[...photo]]"], {}, async () => [
        { photo: [] },
      ]);

      expect(empty.response.status).toBe(200);
      await expect(empty.response.text()).resolves.toBe("fresh-flight");
    });

    it("renders a generated-params miss of an intercepting tree through that tree's not-found", async () => {
      // app/feed/[slug]/@modal/(..)[slug]/not-found.tsx is the intercepting
      // tree's own not-found boundary.
      const interceptNotFound = { default: "modal-not-found" };
      const interceptPage = {
        default: "modal-page",
        dynamicParams: false,
        generateStaticParams: vi.fn(async () => [{ slug: "known" }]),
      };
      const renderHttpAccessFallbackPage = vi.fn<DispatchOptions["renderHttpAccessFallbackPage"]>(
        async () => new Response("modal-not-found", { status: 404 }),
      );
      const { buildPageElement, options } = createGeneratedParamsDispatch({
        findIntercept: () => ({
          interceptBranchSegments: ["(..)[slug]"],
          matchedParams: { slug: "unknown" },
          notFound: interceptNotFound,
          notFoundTreePosition: 1,
          page: interceptPage,
          slotKey: "modal@app/feed/[slug]/@modal",
          sourceRouteIndex: 0,
        }),
        isrGet: vi.fn(async () => null),
        resolveRouteDynamicParamsConfig: () => false,
        resolveRouteGenerateStaticParams: () => [interceptPage.generateStaticParams],
      });
      options.renderHttpAccessFallbackPage = renderHttpAccessFallbackPage;

      const response = await dispatchAppPage(options);

      expect(response.status).toBe(404);
      await expect(response.text()).resolves.toBe("modal-not-found");
      expect(renderHttpAccessFallbackPage).toHaveBeenCalledTimes(1);
      expect(renderHttpAccessFallbackPage).toHaveBeenCalledWith(
        404,
        {
          intercept: expect.objectContaining({
            interceptBranchSegments: ["(..)[slug]"],
            interceptNotFound,
            interceptNotFoundTreePosition: 1,
            interceptPage,
            interceptParams: { slug: "unknown" },
            interceptSlotKey: "modal@app/feed/[slug]/@modal",
          }),
          matchedParams: { slug: "unknown" },
        },
        options.middlewareContext,
      );
      expect(buildPageElement).not.toHaveBeenCalled();
    });

    it("keeps a static intercepting tree's params gate under a force-dynamic active sibling in production", async () => {
      // app/feed/[slug]/page.tsx, which vinext renders beside the intercept
      // where Next.js's intercepting route has the owner's default, exports
      // dynamic = "force-dynamic". That makes the render dynamic, but the
      // intercepting route's own tree is not force-dynamic, so its prerender
      // manifest entry still has the NOT_FOUND fallback.
      const interceptGenerator = vi.fn(async () => [{ slug: "known" }]);
      const interceptPage = {
        default: "modal-page",
        dynamicParams: false,
        generateStaticParams: interceptGenerator,
      };
      const resolveRouteInterceptTreeDynamicConfig = vi.fn<
        NonNullable<DispatchOptions["resolveRouteInterceptTreeDynamicConfig"]>
      >(() => null);
      const miss = dispatchInterceptedGeneratedParams(interceptPage, "unknown", {
        resolveRouteDynamicConfig: () => "force-dynamic",
        resolveRouteInterceptTreeDynamicConfig,
      });
      const response = await miss.response;

      expect(response.status).toBe(404);
      expect(miss.isrGet).not.toHaveBeenCalled();
      expect(resolveRouteInterceptTreeDynamicConfig).toHaveBeenCalledWith(
        miss.route,
        expect.objectContaining({ interceptPage }),
      );
      expect(interceptGenerator).toHaveBeenCalledTimes(1);
      expect(miss.buildPageElement).not.toHaveBeenCalled();
    });

    it("skips the params gate of a force-dynamic intercepting tree in production", async () => {
      // Next.js's production build leaves the intercepting route out of its
      // prerender manifest when its own tree is force-dynamic.
      const interceptGenerator = vi.fn(async () => [{ slug: "known" }]);
      const interceptPage = {
        default: "modal-page",
        dynamicParams: false,
        generateStaticParams: interceptGenerator,
      };
      const miss = dispatchInterceptedGeneratedParams(interceptPage, "unknown", {
        resolveRouteDynamicConfig: () => "force-dynamic",
        resolveRouteInterceptTreeDynamicConfig: () => "force-dynamic",
      });
      const response = await miss.response;

      expect(response.status).toBe(200);
      await expect(response.text()).resolves.toBe("fresh-flight");
      expect(interceptGenerator).not.toHaveBeenCalled();
    });
  });

  it("fresh-renders mounted-slot intercepted RSC requests without persistent cache reuse", async () => {
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
    const resolveRouteRevalidateSeconds = vi.fn((route: TestRoute) =>
      route === sourceRoute ? 30 : null,
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
      resolveRouteRevalidateSeconds,
      route: currentRoute,
      scheduleBackgroundRegeneration,
      searchParams: new URLSearchParams("tab=popular"),
    });

    const response = await dispatchAppPage(options);

    expect(response.headers.get("x-vinext-cache")).toBeNull();
    await expect(response.text()).resolves.toBe("flight");
    expect(scheduledRender).toBeNull();

    const [routeArg, paramsArg, optsArg, searchParamsArg] = buildPageElement.mock.calls[0];
    expect(resolveRouteFetchCacheMode).toHaveBeenCalledWith(
      sourceRoute,
      expect.objectContaining({ interceptSlotKey: "modal@app/feed/@modal" }),
    );
    expect(resolveRouteRevalidateSeconds).toHaveBeenCalledWith(
      sourceRoute,
      expect.objectContaining({ interceptSlotKey: "modal@app/feed/@modal" }),
    );
    expect(routeArg).toBe(sourceRoute);
    expect(paramsArg).toEqual({});
    expect(searchParamsArg.toString()).toBe("tab=popular");
    expect(optsArg).toMatchObject({
      interceptionContext: "/feed",
      interceptParams: { id: "123" },
      interceptSlotId: "slot:modal:/feed",
      interceptSlotKey: "modal@app/feed/@modal",
      interceptSourceMatchedUrl: "/feed",
    });
    expect(options.isrGet).not.toHaveBeenCalled();
    expect(options.isrSet).not.toHaveBeenCalled();
  });

  it("fails regenerating a stale intercepted entry whose source route turned revalidate = 0", async () => {
    // app/feed/page.tsx now sets dynamic = "force-dynamic" (revalidate 0),
    // while the matched /photos/[id] route keeps revalidate = 60.
    const sourceRoute = createRoute({ params: [], pattern: "/feed", routeSegments: ["feed"] });
    const currentRoute = createRoute({
      params: ["id"],
      pattern: "/photos/[id]",
      routeSegments: ["photos", "[id]"],
    });
    let scheduledRender: unknown = null;
    const { options } = createDispatchOptions({
      async buildPageElement(route) {
        return route.pattern;
      },
      cleanPathname: "/photos/123",
      findIntercept: () => ({
        matchedParams: { id: "123" },
        page: { default: "modal-page" },
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
            new TextEncoder().encode("stale-flight").buffer,
            undefined,
            buildQueryInvariantRenderObservation(),
          ),
          true,
        ),
      ),
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
      renderToReadableStream: () => createStream(["fresh-flight"]),
      resolveRouteRevalidateSeconds: (route) => (route === sourceRoute ? 0 : null),
      revalidateSeconds: 60,
      route: currentRoute,
      scheduleBackgroundRegeneration(_key, renderFn) {
        scheduledRender = renderFn;
      },
    });

    const response = await dispatchAppPage(options);
    await response.text();
    if (typeof scheduledRender !== "function") {
      throw new Error("expected the stale entry to schedule regeneration");
    }

    await expect(scheduledRender()).rejects.toThrow(
      "Page changed from static to dynamic at runtime /photos/123",
    );
    expect(options.isrSet).not.toHaveBeenCalled();
  });

  it("bypasses shared caches for an unverified interception context", async () => {
    const isrGet = vi.fn(async () =>
      buildISRCacheEntry(
        buildCachedAppPageValue(
          "",
          new TextEncoder().encode("cached-flight").buffer,
          undefined,
          buildQueryInvariantRenderObservation(),
        ),
      ),
    );
    const isrSet = vi.fn<DispatchOptions["isrSet"]>(async () => {});
    const waitUntilPromises: Promise<unknown>[] = [];
    const executionContext = {
      waitUntil(promise) {
        waitUntilPromises.push(promise);
      },
    } satisfies ExecutionContextLike;
    const { options } = createDispatchOptions({
      bypassInterceptionContextCache: true,
      interceptionContext: "/attacker-selected",
      isProduction: true,
      isRscRequest: true,
      isrGet,
      isrSet,
      renderToReadableStream: () => createStream(["fresh-flight"]),
      revalidateSeconds: 60,
    });

    const response = await runWithExecutionContext(executionContext, () =>
      dispatchAppPage(options),
    );

    expect(response.headers.get("cache-control")).toBe("no-store, must-revalidate");
    expect(response.headers.get("x-vinext-cache")).toBeNull();
    await expect(response.text()).resolves.toBe("fresh-flight");
    await Promise.all(waitUntilPromises.splice(0));
    expect(isrGet).not.toHaveBeenCalled();
    expect(isrSet).not.toHaveBeenCalled();
  });

  it("uses a verified interception id in the persistent RSC cache key", async () => {
    const interceptionId = "interception:slot:modal:/feed:/feed->/photos/:id";
    const isrRscKey = vi.fn(
      (
        pathname: string,
        _mountedSlotsHeader?: string | null,
        _renderMode?: DispatchOptions["renderMode"],
        _interceptionContext?: string | null,
        selector?: string | null,
      ) => `rsc:${pathname}:${selector ?? "none"}`,
    );
    const isrGet = vi.fn(async () =>
      buildISRCacheEntry(
        buildCachedAppPageValue(
          "",
          new TextEncoder().encode("stale-flight").buffer,
          undefined,
          buildQueryInvariantRenderObservation(),
        ),
      ),
    );
    const isrSet = vi.fn<DispatchOptions["isrSet"]>(async () => {});
    const request = new Request("https://example.test/photos/123", {
      headers: {
        [VINEXT_INTERCEPTION_ID_HEADER]: interceptionId,
      },
    });
    const { options } = createDispatchOptions({
      cleanPathname: "/photos/123",
      isProduction: true,
      isRscRequest: true,
      isrGet,
      isrRscKey,
      isrSet,
      request,
      revalidateSeconds: 60,
    });

    const response = await dispatchAppPage(options);
    await expect(response.text()).resolves.toBe("stale-flight");

    expect(response.headers.get("cache-control")).not.toContain("no-store");
    expect(response.headers.get("x-vinext-cache")).toBe("HIT");
    expect(isrRscKey).toHaveBeenCalledWith("/photos/123", null, undefined, null, interceptionId);
    expect(isrGet).toHaveBeenCalledWith(`rsc:/photos/123:${interceptionId}`);
    expect(isrSet).not.toHaveBeenCalled();
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
    expect(resolveRouteDynamicConfig).toHaveBeenCalledWith(
      sourceRoute,
      expect.objectContaining({ interceptSlotKey: "modal@app/feed/@modal" }),
    );
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
    expect(resolveRouteDynamicConfig).toHaveBeenCalledWith(
      sourceRoute,
      expect.objectContaining({ interceptSlotKey: "modal@app/feed/@modal" }),
    );
  });

  describe("intercepted RSC of a known-dynamic source or current route", () => {
    const sourceRoute = createRoute({ params: [], pattern: "/feed", routeSegments: ["feed"] });
    const currentRoute = createRoute({
      params: ["id"],
      pattern: "/photos/[id]",
      routeSegments: ["photos", "[id]"],
    });
    const knownDynamicConfigs = [
      { dynamicConfig: "force-dynamic", revalidateSeconds: 0 },
      { dynamicConfig: undefined, revalidateSeconds: 0 },
    ];

    function dispatchIntercept(overrides: CreateDispatchOptionsOverrides) {
      // Start from a request headers context, not one an earlier test left.
      setHeadersContext(null);
      const { options } = createDispatchOptions({
        async buildPageElement(route) {
          return route.pattern;
        },
        cleanPathname: "/photos/123",
        findIntercept: () => ({
          matchedParams: { id: "123" },
          page: { default: "modal-page" },
          slotKey: "modal@app/feed/@modal",
          sourceRouteIndex: 1,
        }),
        getSourceRoute(sourceRouteIndex) {
          return sourceRouteIndex === 1 ? sourceRoute : undefined;
        },
        isProduction: true,
        isRscRequest: true,
        renderToReadableStream(element) {
          return createStream([typeof element === "string" ? element : "unexpected-element"]);
        },
        route: currentRoute,
        ...overrides,
      });
      return dispatchAppPage(options);
    }

    it("sends the never-cache header for a source that reads a dynamic API while probed", async () => {
      // app/feed has no dynamic config, but a component its intercepted
      // render includes calls headers().
      const probedSourceRoute = createRoute({
        layouts: [{ default: () => null }],
        params: [],
        pattern: "/feed",
        routeSegments: ["feed"],
      });
      const probeInterceptSource = vi.fn<NonNullable<DispatchOptions["probeInterceptSource"]>>(
        () => {
          markDynamicUsage();
        },
      );
      const response = await dispatchIntercept({
        probeInterceptSource,
        getSourceRoute: (index) => (index === 1 ? probedSourceRoute : undefined),
      });

      await expect(response.text()).resolves.toBe("/feed");
      expect(probeInterceptSource).toHaveBeenCalledWith(
        probedSourceRoute,
        {},
        expect.any(URLSearchParams),
      );
      expect(response.headers.get("cache-control")).toBe(
        "private, no-cache, no-store, max-age=0, must-revalidate",
      );
    });

    it("waits for the source probes before choosing its headers", async () => {
      const response = await dispatchIntercept({
        async probeInterceptSource() {
          await new Promise((resolve) => setTimeout(resolve, 0));
          markDynamicUsage();
        },
      });

      await expect(response.text()).resolves.toBe("/feed");
      expect(response.headers.get("cache-control")).toBe(
        "private, no-cache, no-store, max-age=0, must-revalidate",
      );
    });

    // The source's own tree includes app/feed/@modal/page.tsx, which the
    // intercepting page replaces in the rendered tree.
    const staticInterceptPage = { default: "modal-page" };
    const interceptStaticPage = () => ({
      matchedParams: { id: "123" },
      page: staticInterceptPage,
      slotKey: "modal@app/feed/@modal",
      sourceRouteIndex: 1,
    });

    it("reads revalidate from the tree with the intercepting page in the replaced slot", async () => {
      // app/feed/@modal/page.tsx sets revalidate = 0, but the static
      // intercepting page replaces it.
      const resolveRouteRevalidateSeconds = vi.fn<
        NonNullable<DispatchOptions["resolveRouteRevalidateSeconds"]>
      >((route, intercept) =>
        route === sourceRoute && intercept?.interceptPage !== staticInterceptPage ? 0 : null,
      );
      const response = await dispatchIntercept({
        findIntercept: interceptStaticPage,
        pprRuntime: appPagePprRuntime,
        resolveRouteRevalidateSeconds,
      });

      await expect(response.text()).resolves.toBe("/feed");
      expect(resolveRouteRevalidateSeconds).toHaveBeenCalledWith(
        sourceRoute,
        expect.objectContaining({
          interceptPage: staticInterceptPage,
          interceptSlotKey: "modal@app/feed/@modal",
        }),
      );
      expect(response.headers.get("cache-control")).toBeNull();
    });

    it("reads fetchCache from the tree with the intercepting page in the replaced slot", async () => {
      // app/feed/@modal/page.tsx sets fetchCache = "force-no-store", but the
      // intercepting page replaces it and sets "force-cache".
      const fetchCacheModes: unknown[] = [];
      const response = await runWithRequestContext(createRequestContext(), () =>
        dispatchIntercept({
          async buildPageElement(route) {
            fetchCacheModes.push(getRequestContext().currentFetchCacheMode);
            return route.pattern;
          },
          findIntercept: interceptStaticPage,
          resolveRouteFetchCacheMode: (route, intercept) =>
            route === sourceRoute && intercept?.interceptPage === staticInterceptPage
              ? "force-cache"
              : "force-no-store",
        }),
      );

      await expect(response.text()).resolves.toBe("/feed");
      expect(fetchCacheModes).toEqual(["force-cache"]);
    });

    it("counts an intercepting page's dynamic API read when a replaced slot page is force-static", async () => {
      // app/feed/@modal/page.tsx sets dynamic = "force-static", but the
      // intercepting page replaces it and calls headers().
      const response = await dispatchIntercept({
        probeInterceptSource() {
          markDynamicUsage();
        },
        findIntercept: interceptStaticPage,
        resolveRouteDynamicConfig: (route, intercept) =>
          route === sourceRoute && intercept?.interceptPage !== staticInterceptPage
            ? "force-static"
            : undefined,
      });

      await expect(response.text()).resolves.toBe("/feed");
      expect(response.headers.get("cache-control")).toBe(
        "private, no-cache, no-store, max-age=0, must-revalidate",
      );
    });

    it("counts a dynamic API read while the source element is built", async () => {
      // app/feed/page.tsx's generateMetadata (or generateViewport) calls
      // headers(), which runs while the element tree is built, not in the
      // layout and page probes.
      const response = await dispatchIntercept({
        async buildPageElement(route) {
          if (route === sourceRoute) markDynamicUsage();
          return route.pattern;
        },
        probeInterceptSource() {},
      });

      await expect(response.text()).resolves.toBe("/feed");
      expect(response.headers.get("cache-control")).toBe(
        "private, no-cache, no-store, max-age=0, must-revalidate",
      );
    });

    it("doesn't count dynamic API reads from before the source is probed", async () => {
      const response = await dispatchIntercept({
        probeInterceptSource() {},
        findIntercept() {
          // Stands in for anything the matched target read earlier.
          markDynamicUsage();
          return {
            matchedParams: { id: "123" },
            page: { default: "modal-page" },
            slotKey: "modal@app/feed/@modal",
            sourceRouteIndex: 1,
          };
        },
      });

      await expect(response.text()).resolves.toBe("/feed");
      expect(response.headers.get("cache-control")).toBeNull();
    });

    describe("with the source probes the generated entry composes", () => {
      // Like probeInterceptSource in app-rsc-entry.ts.
      const probeSourceLikeEntry =
        (renderMode?: AppRscRenderMode): NonNullable<DispatchOptions["probeInterceptSource"]> =>
        (route, params, searchParams) =>
          Promise.all(
            buildAppPageInterceptSourceProbes({
              route,
              pageComponent: undefined,
              intercept: { page: { default: "modal-page" }, slotKey: "modal@app/feed/@modal" },
              sourceParams: params,
              searchParams,
              mountedSlotsHeader: null,
              renderMode,
              makeThenableParams: (value) => makeThenableParams(value as Record<string, unknown>),
            }),
          );
      // Stands in for a component that calls headers() or cookies().
      function DynamicComponent(props: { children?: React.ReactNode }) {
        markDynamicUsage();
        return props.children ?? null;
      }
      // A dynamic component that never settles.
      function PendingDynamicComponent(): Promise<React.ReactNode> {
        markDynamicUsage();
        return new Promise(() => {});
      }
      const dispatchSource = (source: Partial<TestRoute>, renderMode?: AppRscRenderMode) =>
        Promise.race([
          dispatchIntercept({
            getSourceRoute: (index) =>
              index === 1
                ? createRoute({ params: [], pattern: "/feed", routeSegments: ["feed"], ...source })
                : undefined,
            probeInterceptSource: probeSourceLikeEntry(renderMode),
          }),
          new Promise<"stalled">((resolve) => setTimeout(() => resolve("stalled"), 100)),
        ]);
      const neverCache = "private, no-cache, no-store, max-age=0, must-revalidate";

      it("sends the never-cache header for a source template that reads a dynamic API", async () => {
        // app/feed/template.tsx
        const response = await dispatchSource({
          templates: [{ default: DynamicComponent }],
          templateTreePositions: [1],
        });

        expect(response).not.toBe("stalled");
        expect((response as Response).headers.get("cache-control")).toBe(neverCache);
      });

      it("sends the never-cache header for an ordinary slot layout that reads a dynamic API", async () => {
        // app/feed/@sidebar/layout.tsx around app/feed/@sidebar/page.tsx
        const response = await dispatchSource({
          slots: {
            "modal@app/feed/@modal": { name: "modal" },
            "sidebar@app/feed/@sidebar": {
              layout: { default: DynamicComponent },
              name: "sidebar",
              page: { default: () => null },
            },
          },
        });

        expect(response).not.toBe("stalled");
        expect((response as Response).headers.get("cache-control")).toBe(neverCache);
      });

      // app/feed/@sidebar/default.tsx, which the prefetch doesn't render
      const slotsWithDefault = (DefaultComponent: unknown) => ({
        "modal@app/feed/@modal": { name: "modal" },
        "sidebar@app/feed/@sidebar": { default: { default: DefaultComponent }, name: "sidebar" },
        // app/feed/@team/loading.tsx gives a loading-shell prefetch its shell.
        "team@app/feed/@team": {
          loading: { default: () => null },
          name: "team",
          page: { default: () => null },
        },
      });

      it("sends the never-cache header for a loading-shell route loading UI that reads a dynamic API", async () => {
        // app/feed/loading.tsx, which the shell renders in place of the page
        const response = await dispatchSource(
          { loadings: [{ default: DynamicComponent }], loadingTreePositions: [1] },
          APP_RSC_RENDER_MODE_PREFETCH_LOADING_SHELL,
        );

        expect(response).not.toBe("stalled");
        expect((response as Response).headers.get("cache-control")).toBe(neverCache);
      });

      it("sends the never-cache header for a loading-shell slot loading UI that reads a dynamic API", async () => {
        // app/feed/@team/loading.tsx, which the shell renders in place of the
        // slot's page
        const response = await dispatchSource(
          {
            slots: {
              "modal@app/feed/@modal": { name: "modal" },
              "team@app/feed/@team": {
                loading: { default: DynamicComponent },
                name: "team",
                page: { default: PendingDynamicComponent },
              },
            },
          },
          APP_RSC_RENDER_MODE_PREFETCH_LOADING_SHELL,
        );

        expect(response).not.toBe("stalled");
        expect((response as Response).headers.get("cache-control")).toBe(neverCache);
      });

      for (const renderMode of [
        APP_RSC_RENDER_MODE_PREFETCH_EMPTY,
        APP_RSC_RENDER_MODE_PREFETCH_LOADING_SHELL,
      ] as const) {
        for (const [label, DefaultComponent] of [
          ["dynamic", DynamicComponent],
          ["pending dynamic", PendingDynamicComponent],
        ] as const) {
          it(`doesn't probe a ${label} slot default a ${renderMode} render leaves out`, async () => {
            const response = await dispatchSource(
              { slots: slotsWithDefault(DefaultComponent) },
              renderMode,
            );

            expect(response).not.toBe("stalled");
            expect((response as Response).headers.get("cache-control")).toBeNull();
          });
        }
      }
    });

    for (const config of knownDynamicConfigs) {
      const label = config.dynamicConfig ?? "revalidate = 0";

      // A standard build already classifies such a source as non-static. A
      // cacheComponents build keeps every route static-eligible, so only the
      // source's own dynamic config marks the response.
      it(`sends the never-cache header for a ${label} source in a cacheComponents build`, async () => {
        const response = await dispatchIntercept({
          pprRuntime: appPagePprRuntime,
          resolveRouteDynamicConfig: (route) =>
            route === sourceRoute ? config.dynamicConfig : undefined,
          resolveRouteRevalidateSeconds: (route) =>
            route === sourceRoute ? config.revalidateSeconds : null,
        });

        await expect(response.text()).resolves.toBe("/feed");
        expect(response.headers.get("cache-control")).toBe(
          "private, no-cache, no-store, max-age=0, must-revalidate",
        );
      });

      it(`sends the never-cache header for a ${label} intercepting page in a cacheComponents build`, async () => {
        // app/feed/@modal/(.)photos/[id]/page.tsx sets the config, so the
        // intercepting route's tree is known dynamic.
        const interceptPage = {
          default: "modal-page",
          dynamic: config.dynamicConfig,
          revalidate: config.revalidateSeconds,
        };
        const response = await dispatchIntercept({
          findIntercept: () => ({
            matchedParams: { id: "123" },
            page: interceptPage,
            slotKey: "modal@app/feed/@modal",
            sourceRouteIndex: 1,
          }),
          pprRuntime: appPagePprRuntime,
          resolveRouteDynamicConfig: (route, intercept) =>
            route === sourceRoute && intercept?.interceptPage === interceptPage
              ? config.dynamicConfig
              : undefined,
          resolveRouteRevalidateSeconds: (route, intercept) =>
            route === sourceRoute && intercept?.interceptPage === interceptPage
              ? config.revalidateSeconds
              : null,
        });

        await expect(response.text()).resolves.toBe("/feed");
        expect(response.headers.get("cache-control")).toBe(
          "private, no-cache, no-store, max-age=0, must-revalidate",
        );
      });

      for (const pprRuntime of [undefined, appPagePprRuntime]) {
        const build = pprRuntime ? "a cacheComponents build" : "a standard build";

        it(`keeps a ${label} current route's header off a static source in ${build}`, async () => {
          const response = await dispatchIntercept({
            dynamicConfig: config.dynamicConfig,
            pprRuntime,
            resolveRouteDynamicConfig: (route) =>
              route === currentRoute ? config.dynamicConfig : undefined,
            resolveRouteRevalidateSeconds: (route) =>
              route === currentRoute ? config.revalidateSeconds : null,
            resolveRouteStaticEligible: (route) => route !== currentRoute,
            revalidateSeconds: config.revalidateSeconds,
          });

          await expect(response.text()).resolves.toBe("/feed");
          expect(response.headers.get("cache-control")).toBeNull();
        });
      }
    }
  });

  it("passes empty searchParams to a force-static intercept source route", async () => {
    const sourceRoute = createRoute({
      params: [],
      pattern: "/feed",
      routeSegments: ["feed"],
    });
    const currentRoute = createRoute({
      params: ["id"],
      pattern: "/photos/[id]",
      routeSegments: ["photos", "[id]"],
    });
    const buildPageElement = vi.fn<DispatchOptions["buildPageElement"]>(
      async (_route, _params, _opts, searchParams) => searchParams.get("tab") ?? "empty",
    );
    const setNavigationContext = vi.fn<DispatchOptions["setNavigationContext"]>();
    const resolveRouteDynamicConfig = vi.fn((route: TestRoute) =>
      route === sourceRoute && route.layouts.length > 0 ? "force-static" : undefined,
    );
    const { options } = createDispatchOptions({
      buildPageElement,
      cleanPathname: "/photos/123",
      ensureRouteLoaded(route) {
        if (route === sourceRoute) {
          sourceRoute.layouts = [{ default: () => null, dynamic: "force-static" }];
        }
      },
      interceptionContext: "/feed",
      isRscRequest: true,
      renderToReadableStream(element) {
        return createStream([typeof element === "string" ? element : "unexpected-element"]);
      },
      resolveRouteDynamicConfig,
      route: currentRoute,
      searchParams: new URLSearchParams("tab=popular"),
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

    await expect(response.text()).resolves.toBe("empty");
    expect(buildPageElement.mock.calls[0]?.[3].toString()).toBe("");
    // Client pages read an empty query in the browser too.
    expect(buildPageElement.mock.calls[0]?.[5]?.isForceStatic).toBe(true);
    expect(setNavigationContext).toHaveBeenLastCalledWith(
      expect.objectContaining({ searchParams: expect.any(URLSearchParams) }),
    );
    const navigationContext = setNavigationContext.mock.calls.at(-1)?.[0];
    expect(navigationContext?.searchParams.toString()).toBe("");
    expect(resolveRouteDynamicConfig).toHaveBeenCalledTimes(1);
    expect(resolveRouteDynamicConfig).toHaveBeenCalledWith(
      sourceRoute,
      expect.objectContaining({ interceptSlotKey: "modal@app/feed/@modal" }),
    );
  });

  it("observes searchParams access for a dynamic-error intercept source route", async () => {
    const sourceRoute = createRoute({ params: [], pattern: "/feed", routeSegments: ["feed"] });
    const currentRoute = createRoute({
      params: ["id"],
      pattern: "/photos/[id]",
      routeSegments: ["photos", "[id]"],
    });
    const buildOptions: Array<{
      observeMetadataSearchParamsAccess?: boolean;
      observePageSearchParamsAccess?: boolean;
    }> = [];
    const buildPageElement = vi.fn<DispatchOptions["buildPageElement"]>(
      async (_route, _params, _opts, searchParams, _layoutParamAccess, options) => {
        buildOptions.push(options ?? {});
        return searchParams.get("tab") ?? "empty";
      },
    );
    const resolveRouteDynamicConfig = vi.fn((route: TestRoute) =>
      route === sourceRoute && route.layouts.length > 0 ? "error" : undefined,
    );
    const { options } = createDispatchOptions({
      buildPageElement,
      cleanPathname: "/photos/123",
      ensureRouteLoaded(route) {
        if (route === sourceRoute) {
          sourceRoute.layouts = [{ default: () => null, dynamic: "error" }];
        }
      },
      interceptionContext: "/feed",
      isRscRequest: true,
      renderToReadableStream(element) {
        return createStream([typeof element === "string" ? element : "unexpected-element"]);
      },
      resolveRouteDynamicConfig,
      route: currentRoute,
      searchParams: new URLSearchParams("tab=popular"),
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

    await expect(response.text()).resolves.toBe("popular");
    expect(buildOptions).toEqual([
      {
        isForceStatic: false,
        observeMetadataSearchParamsAccess: true,
        observePageSearchParamsAccess: true,
        serveStreamingMetadata: true,
      },
    ]);
  });

  it.each([
    { dynamicConfig: "force-static", isForceStatic: true },
    { dynamicConfig: undefined, isForceStatic: false },
  ])(
    "tells the page builder whether the route is force-static ($dynamicConfig)",
    async ({ dynamicConfig, isForceStatic }) => {
      // Client pages carry it to the browser, which keeps force-static
      // searchParams empty as SSR renders them.
      const buildPageElement = vi.fn<DispatchOptions["buildPageElement"]>(async () => "page");
      const { options } = createDispatchOptions({
        buildPageElement,
        dynamicConfig,
        isRscRequest: true,
        renderToReadableStream(element) {
          return createStream([typeof element === "string" ? element : "unexpected-element"]);
        },
        searchParams: new URLSearchParams("tab=popular"),
      });

      await expect((await dispatchAppPage(options)).text()).resolves.toBe("page");
      expect(buildPageElement.mock.calls.map((call) => call[5]?.isForceStatic)).toEqual([
        isForceStatic,
      ]);
    },
  );

  it("preserves request headers for an ordinary intercept source route", async () => {
    const sourceRoute = createRoute({ params: [], pattern: "/feed", routeSegments: ["feed"] });
    const currentRoute = createRoute({
      params: ["id"],
      pattern: "/photos/[id]",
      routeSegments: ["photos", "[id]"],
    });
    const requestHeadersContext = {
      headers: new Headers({ "x-request-value": "preserved" }),
      cookies: new Map(),
    };
    setHeadersContext(requestHeadersContext);
    try {
      const { options } = createDispatchOptions({
        async buildPageElement() {
          return getHeadersContext()?.headers.get("x-request-value") ?? "missing";
        },
        cleanPathname: "/photos/123",
        interceptionContext: "/feed",
        isRscRequest: true,
        renderToReadableStream(element) {
          return createStream([typeof element === "string" ? element : "unexpected-element"]);
        },
        route: currentRoute,
        searchParams: new URLSearchParams("tab=popular"),
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

      await expect(response.text()).resolves.toBe("preserved");
    } finally {
      setHeadersContext(null);
    }
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
    let capturedFallbackToErrorDocument: boolean | undefined;
    let capturedServeStreamingMetadata: boolean | undefined;
    let afterRan = false;
    const isrSet = vi.fn(async () => {});
    const createRscOnErrorHandler = vi.fn(() => () => null);
    const { options } = createDispatchOptions({
      buildPageElement: async (_route, _params, _opts, _searchParams, _layout, buildOptions) => {
        capturedServeStreamingMetadata = buildOptions?.serveStreamingMetadata;
        after(() => {
          afterRan = true;
        });
        return React.createElement("main", null, "fresh");
      },
      cleanPathname: "/posts/hello",
      createRscOnErrorHandler,
      isProduction: true,
      isrGet: vi.fn(async () =>
        buildISRCacheEntry(buildCachedAppPageValue("<html>stale</html>"), true),
      ),
      isrSet,
      hasCustomGlobalError: false,
      loadSsrHandler: async () => ({
        async handleSsr(_rscStream, _navigationContext, _fontData, captureOptions) {
          capturedWaitForAllReady = captureOptions?.waitForAllReady;
          capturedFallbackToErrorDocument = captureOptions?.fallbackToErrorDocumentOnShellError;
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
    expect(capturedServeStreamingMetadata).toBe(false);
    expect(capturedFallbackToErrorDocument).toBeUndefined();
    expect(createRscOnErrorHandler).toHaveBeenCalledWith("/posts/hello", "/posts/[slug]", {
      revalidateReason: "stale",
    });
    expect(createRscOnErrorHandler).toHaveBeenCalledWith("/posts/hello", "/posts/[slug]", {
      renderSource: "server-rendering",
      revalidateReason: "stale",
    });
    expect(isrSet).toHaveBeenCalled();
    expect(afterRan).toBe(true);
  });

  it("regenerates stale HTML-captured RSC data under the plain key without interception context", async () => {
    let scheduledRender: unknown = null;
    const isrSet = vi.fn<DispatchOptions["isrSet"]>(async () => {});
    const { options } = createDispatchOptions({
      cleanPathname: "/photos/123",
      interceptionContext: null,
      isProduction: true,
      isrGet: vi.fn(async () =>
        buildISRCacheEntry(buildCachedAppPageValue("<html>stale direct</html>"), true),
      ),
      isrRscKey(pathname, mountedSlotsHeader, _renderMode, interceptionContext) {
        return `rsc:${pathname}:${mountedSlotsHeader ?? "none"}:${interceptionContext ?? "none"}`;
      },
      isrSet,
      loadSsrHandler: async () => ({
        async handleSsr(_rscStream, _navigationContext, _fontData, captureOptions) {
          if (captureOptions?.capturedRscDataRef) {
            captureOptions.capturedRscDataRef.value = Promise.resolve(
              new TextEncoder().encode("regenerated-direct-flight").buffer,
            );
          }
          void captureOptions?.sideStream?.cancel().catch(() => {});
          return createStream(["<html>regenerated direct</html>"]);
        },
      }),
      revalidateSeconds: 60,
      scheduleBackgroundRegeneration(_key, renderFn) {
        scheduledRender = renderFn;
      },
    });

    const response = await dispatchAppPage(options);
    await expect(response.text()).resolves.toBe("<html>stale direct</html>");
    expect(typeof scheduledRender).toBe("function");
    if (typeof scheduledRender !== "function") {
      throw new Error("expected stale HTML response to schedule regeneration");
    }

    await scheduledRender();

    const writtenKeys = isrSet.mock.calls.map(([key]) => key);
    expect(writtenKeys).toHaveLength(2);
    expect(writtenKeys).toEqual(
      expect.arrayContaining(["html:/photos/123", "rsc:/photos/123:none:none"]),
    );
  });

  it.each(["page", "metadata"] as const)(
    "keeps the previous entry when a stale regeneration reads searchParams in %s",
    async (reader) => {
      async function Page(props: Record<string, unknown>): Promise<React.ReactNode> {
        if (reader !== "page") return React.createElement("main", null, "static body");
        const query = isPromiseLike(props.searchParams) ? await props.searchParams : {};
        return React.createElement(
          "main",
          null,
          isQueryRecord(query) ? (query.q ?? "empty") : "invalid",
        );
      }
      const pageModule = {
        default: Page,
        ...(reader === "metadata"
          ? {
              async generateMetadata(props: {
                searchParams: Promise<Record<string, string | string[]>>;
              }) {
                const query = await props.searchParams;
                return { title: typeof query.q === "string" ? query.q : "empty" };
              },
            }
          : {}),
      };
      const route = createRoute({ pattern: "/regen-proof", routeSegments: ["regen-proof"] });
      let scheduledRender: unknown = null;
      const written: CachedAppPageValue[] = [];
      const staleValue = buildCachedAppPageValue(
        "<html>stale</html>",
        undefined,
        undefined,
        buildQueryInvariantRenderObservation(),
      );
      const staleEntry = buildISRCacheEntry(staleValue, true);
      staleEntry.value.cacheControl = { revalidate: 60 };
      const buildPageElement = vi.fn<DispatchOptions["buildPageElement"]>(
        (_route, params, _opts, searchParams, layoutParamAccess, buildOptions) =>
          buildPageElements({
            layoutParamAccess,
            metadataRoutes: [],
            params,
            pageRequest: {
              isRscRequest: false,
              mountedSlotsHeader: null,
              opts: undefined,
              request: new Request("https://example.test/regen-proof"),
              searchParams,
              observeMetadataSearchParamsAccess: buildOptions?.observeMetadataSearchParamsAccess,
              observePageSearchParamsAccess: buildOptions?.observePageSearchParamsAccess,
            },
            route: {
              layouts: [],
              page: pageModule,
              pattern: "/regen-proof",
              routeSegments: ["regen-proof"],
            },
            routePath: "/regen-proof",
          }).then(toDispatchElementRecord),
      );
      const { options } = createDispatchOptions({
        buildPageElement,
        cleanPathname: "/regen-proof",
        isProduction: true,
        isrGet: vi.fn(async () => staleEntry),
        isrSet: vi.fn(async (_key, value) => {
          written.push(value);
        }),
        loadSsrHandler: async () => ({
          async handleSsr(rscStream, _navigationContext, _fontData, captureOptions) {
            if (captureOptions?.capturedRscDataRef) {
              captureOptions.capturedRscDataRef.value = Promise.resolve(
                new TextEncoder().encode("fresh-flight").buffer,
              );
            }
            void captureOptions?.sideStream?.cancel().catch(() => {});
            return createStream([`<html>${await new Response(rscStream).text()}</html>`]);
          },
        }),
        renderToReadableStream: renderPagePayloadToStream,
        revalidateSeconds: 60,
        route,
        scheduleBackgroundRegeneration(_key, renderFn) {
          scheduledRender = renderFn;
        },
      });

      const response = await dispatchAppPage(options);
      await response.text();
      expect(typeof scheduledRender).toBe("function");
      if (typeof scheduledRender !== "function") {
        throw new Error("expected stale response to schedule regeneration");
      }

      // Reading searchParams makes the regeneration dynamic, so it fails and
      // core re-stores only the previous entry.
      await expect(scheduledRender()).rejects.toThrow(
        "Page changed from static to dynamic at runtime /regen-proof",
      );
      expect(written).toEqual([staleValue]);
    },
  );

  it("doesn't fail a PPR regeneration that reads headers()", async () => {
    async function Page(): Promise<React.ReactNode> {
      const requestHeaders = await headers();
      return React.createElement("main", null, requestHeaders.get("x-test") ?? "none");
    }
    const route = createRoute({ pattern: "/regen-ppr", routeSegments: ["regen-ppr"] });
    let scheduledRender: unknown = null;
    const staleValue = buildCachedAppPageValue(
      "<html>stale</html>",
      undefined,
      undefined,
      buildQueryInvariantRenderObservation(),
    );
    const buildPageElement = vi.fn<DispatchOptions["buildPageElement"]>(
      (_route, params, _opts, searchParams, layoutParamAccess) =>
        buildPageElements({
          layoutParamAccess,
          metadataRoutes: [],
          params,
          pageRequest: {
            isRscRequest: false,
            mountedSlotsHeader: null,
            opts: undefined,
            request: new Request("https://example.test/regen-ppr"),
            searchParams,
          },
          route: {
            layouts: [],
            page: { default: Page },
            pattern: "/regen-ppr",
            routeSegments: ["regen-ppr"],
          },
          routePath: "/regen-ppr",
        }).then(toDispatchElementRecord),
    );
    const { options } = createDispatchOptions({
      buildPageElement,
      cleanPathname: "/regen-ppr",
      isProduction: true,
      isrGet: vi.fn(async () => {
        const entry = buildISRCacheEntry(staleValue, true);
        entry.value.cacheControl = { revalidate: 60 };
        return entry;
      }),
      loadSsrHandler: async () => ({
        async handleSsr(rscStream, _navigationContext, _fontData, captureOptions) {
          if (captureOptions?.capturedRscDataRef) {
            captureOptions.capturedRscDataRef.value = Promise.resolve(
              new TextEncoder().encode("fresh-flight").buffer,
            );
          }
          void captureOptions?.sideStream?.cancel().catch(() => {});
          return createStream([`<html>${await new Response(rscStream).text()}</html>`]);
        },
      }),
      pprRuntime: appPagePprRuntime,
      renderToReadableStream: renderPagePayloadToStream,
      revalidateSeconds: 60,
      route,
      scheduleBackgroundRegeneration(_key, renderFn) {
        scheduledRender = renderFn;
      },
    });

    const response = await dispatchAppPage(options);
    await response.text();
    if (typeof scheduledRender !== "function") {
      throw new Error("expected stale response to schedule regeneration");
    }
    await expect(scheduledRender()).resolves.toBeUndefined();
  });

  it("stores a force-static regeneration that reads headers() and searchParams", async () => {
    async function Page(props: Record<string, unknown>): Promise<React.ReactNode> {
      const requestHeaders = await headers();
      const query = isPromiseLike(props.searchParams) ? await props.searchParams : {};
      return React.createElement(
        "main",
        null,
        `${requestHeaders.get("x-test") ?? "none"}:${isQueryRecord(query) ? String(query.q ?? "empty") : "invalid"}`,
      );
    }
    const route = createRoute({ pattern: "/regen-static", routeSegments: ["regen-static"] });
    let scheduledRender: unknown = null;
    const writtenKeys: string[] = [];
    const { options } = createDispatchOptions({
      buildPageElement: (_route, params, _opts, searchParams, layoutParamAccess, buildOptions) =>
        buildPageElements({
          layoutParamAccess,
          metadataRoutes: [],
          params,
          pageRequest: {
            isRscRequest: false,
            mountedSlotsHeader: null,
            opts: undefined,
            request: new Request("https://example.test/regen-static"),
            searchParams,
            observeMetadataSearchParamsAccess: buildOptions?.observeMetadataSearchParamsAccess,
            observePageSearchParamsAccess: buildOptions?.observePageSearchParamsAccess,
          },
          route: {
            layouts: [],
            page: { default: Page },
            pattern: "/regen-static",
            routeSegments: ["regen-static"],
          },
          routePath: "/regen-static",
        }).then(toDispatchElementRecord),
      cleanPathname: "/regen-static",
      dynamicConfig: "force-static",
      isProduction: true,
      isrGet: vi.fn(async () => {
        const entry = buildISRCacheEntry(
          buildCachedAppPageValue(
            "<html>stale</html>",
            undefined,
            undefined,
            buildQueryInvariantRenderObservation(),
          ),
          true,
        );
        entry.value.cacheControl = { revalidate: 60 };
        return entry;
      }),
      isrSet: vi.fn(async (key) => {
        writtenKeys.push(key);
      }),
      loadSsrHandler: async () => ({
        async handleSsr(rscStream, _navigationContext, _fontData, captureOptions) {
          if (captureOptions?.capturedRscDataRef) {
            captureOptions.capturedRscDataRef.value = Promise.resolve(
              new TextEncoder().encode("fresh-flight").buffer,
            );
          }
          void captureOptions?.sideStream?.cancel().catch(() => {});
          return createStream([`<html>${await new Response(rscStream).text()}</html>`]);
        },
      }),
      renderToReadableStream: renderPagePayloadToStream,
      revalidateSeconds: 60,
      route,
      scheduleBackgroundRegeneration(_key, renderFn) {
        scheduledRender = renderFn;
      },
    });

    const response = await dispatchAppPage(options);
    await response.text();
    if (typeof scheduledRender !== "function") {
      throw new Error("expected stale response to schedule regeneration");
    }

    // force-static makes those reads static, so they are no dynamic signal.
    await scheduledRender();
    expect(writtenKeys.sort()).toEqual(["html:/regen-static", "rsc:/regen-static"]);
  });

  it("does not report a stale RSC failure again after Flight recreates the error", async () => {
    const route = createRoute({ pattern: "/posts/[slug]", routeSegments: ["posts", "[slug]"] });
    let scheduledRender: unknown = null;
    let scheduledErrorContext:
      | Parameters<DispatchOptions["scheduleBackgroundRegeneration"]>[2]
      | undefined;
    const scheduleBackgroundRegeneration: DispatchOptions["scheduleBackgroundRegeneration"] = (
      _key,
      renderFn,
      errorContext,
    ) => {
      scheduledRender = renderFn;
      scheduledErrorContext = errorContext;
    };
    const isrSet = vi.fn(async () => {});
    const originalRscError = new Error("RSC regeneration failed");
    const decodedRscError = Object.assign(new Error("decoded RSC regeneration failure"), {
      digest: "rsc-regeneration-digest",
    });
    const reportRscError = vi.fn(() => "rsc-regeneration-digest");
    const reportSsrError = vi.fn(() => "ssr-digest");
    const createRscOnErrorHandler = vi.fn((_pathname, _routePath, overrides) =>
      overrides?.renderSource === "server-rendering" ? reportSsrError : reportRscError,
    );
    const { options } = createDispatchOptions({
      buildPageElement: async () => React.createElement("main", null, "fresh"),
      cleanPathname: "/posts/hello",
      createRscOnErrorHandler,
      isProduction: true,
      isrGet: vi.fn(async () =>
        buildISRCacheEntry(buildCachedAppPageValue("<html>stale</html>"), true),
      ),
      isrSet,
      loadSsrHandler: async () => ({
        async handleSsr(_rscStream, _navigationContext, _fontData, captureOptions) {
          captureOptions?.onSsrError?.(decodedRscError);
          throw decodedRscError;
        },
      }),
      renderToReadableStream(_element, { onError }) {
        onError(originalRscError, undefined, undefined);
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

    await expect(scheduledRender()).rejects.toBe(decodedRscError);
    expect(isrSet).not.toHaveBeenCalled();
    expect(reportRscError).toHaveBeenCalledOnce();
    expect(reportRscError).toHaveBeenCalledWith(originalRscError, undefined, undefined);
    expect(reportSsrError).not.toHaveBeenCalled();
    expect(scheduledErrorContext?.shouldReport?.(decodedRscError)).toBe(false);
    expect(scheduledErrorContext?.shouldReport?.(new Error("different failure"))).toBe(true);
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

    expect(response.headers.get("x-vinext-cache")).toBeNull();
    await expect(response.text()).resolves.toBe("flight");
    expect(scheduledRender).toBeNull();
    expect(resolveRouteDynamicConfig).toHaveBeenCalledWith(
      targetRoute,
      expect.objectContaining({ interceptSlotKey: "modal@app/feed/@modal" }),
    );
    const [routeArg] = buildPageElement.mock.calls[0];
    expect(routeArg).toBe(targetRoute);
  });

  async function regenerateStaleInterceptedRscEntry(overrides: {
    currentRoute: TestRoute;
    dynamicConfig?: string;
    fetchCache?: DispatchOptions["fetchCache"];
    interceptPage: unknown;
    pprRuntime?: DispatchOptions["pprRuntime"];
    readsHeaders?: boolean;
    resolveRouteDynamicConfig: DispatchOptions["resolveRouteDynamicConfig"];
    resolveRouteFetchCacheMode: DispatchOptions["resolveRouteFetchCacheMode"];
    resolveRouteHasAnyGenerateStaticParams?: DispatchOptions["resolveRouteHasAnyGenerateStaticParams"];
    resolveRouteRevalidateSeconds: DispatchOptions["resolveRouteRevalidateSeconds"];
    revalidateSeconds: number;
    sourceRoute: TestRoute;
  }) {
    let scheduledRender: unknown = null;
    const isrSet = vi.fn<DispatchOptions["isrSet"]>(async () => {});
    const renders: Record<string, unknown>[] = [];
    const staleValue = buildCachedAppPageValue(
      "",
      new TextEncoder().encode("stale-flight").buffer,
      undefined,
      buildQueryInvariantRenderObservation(),
    );
    const staleEntry = buildISRCacheEntry(staleValue, true);
    staleEntry.value.cacheControl = { revalidate: 60 };
    const { options } = createDispatchOptions({
      async buildPageElement(route, _params, _opts, _searchParams, _paramAccess, buildOptions) {
        // Stands in for headers(), which force-static answers without
        // marking the render dynamic.
        if (overrides.readsHeaders !== false) markDynamicUsage();
        const context = getRequestContext();
        renders.push({
          dynamicUsage: consumeDynamicUsage(),
          fetchCacheMode: context.currentFetchCacheMode,
          fetchRevalidate: context.currentFetchRevalidate,
          observePageSearchParamsAccess: buildOptions?.observePageSearchParamsAccess,
        });
        return route.pattern;
      },
      cleanPathname: "/photos/123",
      dynamicConfig: overrides.dynamicConfig,
      findIntercept: () => ({
        matchedParams: { id: "123" },
        page: overrides.interceptPage,
        slotKey: "modal@app/feed/@modal",
        sourceRouteIndex: 1,
      }),
      getSourceRoute: (index) => (index === 1 ? overrides.sourceRoute : undefined),
      interceptionContext: "/feed",
      isProduction: true,
      isRscRequest: true,
      isrGet: vi.fn(async () => staleEntry),
      isrRscKey(pathname, _mountedSlotsHeader, _renderMode, interceptionContext) {
        return `rsc:${pathname}:${interceptionContext ?? "none"}`;
      },
      isrSet,
      loadSsrHandler: async () => ({
        async handleSsr(_rscStream, _navigationContext, _fontData, captureOptions) {
          if (captureOptions?.capturedRscDataRef) {
            captureOptions.capturedRscDataRef.value = Promise.resolve(
              new TextEncoder().encode("regenerated-flight").buffer,
            );
          }
          void captureOptions?.sideStream?.cancel().catch(() => {});
          return createStream(["<html>regenerated</html>"]);
        },
      }),
      pprRuntime: overrides.pprRuntime,
      resolveRouteDynamicConfig: overrides.resolveRouteDynamicConfig,
      resolveRouteFetchCacheMode: overrides.resolveRouteFetchCacheMode,
      resolveRouteHasAnyGenerateStaticParams: overrides.resolveRouteHasAnyGenerateStaticParams,
      resolveRouteRevalidateSeconds: overrides.resolveRouteRevalidateSeconds,
      revalidateSeconds: overrides.revalidateSeconds,
      route: overrides.currentRoute,
      scheduleBackgroundRegeneration(_key, renderFn) {
        scheduledRender = renderFn;
      },
    });
    options.fetchCache = overrides.fetchCache;

    const response = await dispatchAppPage(options);
    await expect(response.text()).resolves.toBe("stale-flight");
    if (typeof scheduledRender !== "function") {
      throw new Error("expected the stale intercepted entry to schedule regeneration");
    }
    const regeneration: Promise<unknown> = scheduledRender();
    return { isrSet, regeneration, renders, staleValue };
  }

  it("regenerates a stale intercepted RSC entry with its intercepted tree's config", async () => {
    // app/feed/@modal/(.)photos/[id]/page.tsx sets dynamic = "force-static",
    // fetchCache = "force-cache" and revalidate = 30; app/feed's own tree
    // doesn't, and app/photos/[id] sets revalidate = 60.
    const sourceRoute = createRoute({ pattern: "/feed", routeSegments: ["feed"] });
    const currentRoute = createRoute({
      params: ["id"],
      pattern: "/photos/[id]",
      routeSegments: ["photos", "[id]"],
    });
    const interceptPage = { default: "modal-page" };
    const isInterceptTree = (
      route: TestRoute,
      intercept?: Parameters<NonNullable<DispatchOptions["resolveRouteDynamicConfig"]>>[1],
    ) => route === sourceRoute && intercept?.interceptPage === interceptPage;
    const { isrSet, regeneration, renders } = await regenerateStaleInterceptedRscEntry({
      currentRoute,
      interceptPage,
      resolveRouteDynamicConfig: (route, intercept) =>
        isInterceptTree(route, intercept) ? "force-static" : undefined,
      resolveRouteFetchCacheMode: (route, intercept) =>
        isInterceptTree(route, intercept) ? "force-cache" : "force-no-store",
      resolveRouteRevalidateSeconds: (route, intercept) =>
        isInterceptTree(route, intercept) ? 30 : null,
      revalidateSeconds: 60,
      sourceRoute,
    });
    await regeneration;

    expect(renders).toEqual([
      {
        dynamicUsage: false,
        fetchCacheMode: "force-cache",
        fetchRevalidate: 30,
        observePageSearchParamsAccess: false,
      },
    ]);
    // The render collected no revalidate of its own, so the entry keeps the
    // intercepted tree's, not the matched route's 60 seconds.
    expect(isrSet).toHaveBeenCalledTimes(1);
    expect(isrSet).toHaveBeenCalledWith("rsc:/photos/123:/feed", expect.anything(), {
      cacheControl: { revalidate: 30 },
      tags: expect.any(Array),
    });
  });

  // Resolves app/feed's intercepted tree like the generated entry: Next.js's
  // tree for the intercepting route, merged with app/feed/@sidebar's active
  // page, which vinext renders where Next.js renders its default.
  function regenerateStaleInterceptWithActiveSidebar(
    interceptPage: Record<string, unknown>,
    sidebarPage: Record<string, unknown>,
  ) {
    const sourceRoute = createRoute({ pattern: "/feed", routeSegments: ["feed"] });
    const resolveConfig = (
      route: TestRoute,
      intercept?: Parameters<NonNullable<DispatchOptions["resolveRouteDynamicConfig"]>>[1],
    ) => {
      if (route !== sourceRoute || !intercept) return null;
      const [interceptTree, renderedTree] = [false, true].map((keepActiveSiblings) =>
        resolveAppPageInterceptTree({
          interceptBranchSegments: ["(.)photos", "[id]"],
          interceptPage: intercept.interceptPage as Record<string, unknown>,
          isSiblingPageIntercept: false,
          keepActiveSiblings,
          layouts: [{}, {}],
          layoutTreePositions: [0, 1],
          page: {},
          parallelBranches: [
            { isDefault: true, layout: null, name: "modal", ownerTreePosition: 1, page: {} },
            {
              default: {},
              isDefault: false,
              layout: null,
              name: "sidebar",
              ownerTreePosition: 1,
              page: sidebarPage,
              routeSegments: [],
            },
          ],
          routeSegments: ["feed"],
          slotIndex: 0,
        }),
      );
      return resolveAppPageInterceptSegmentConfig(interceptTree, renderedTree);
    };
    return regenerateStaleInterceptedRscEntry({
      currentRoute: createRoute({
        params: ["id"],
        pattern: "/photos/[id]",
        routeSegments: ["photos", "[id]"],
      }),
      interceptPage,
      resolveRouteDynamicConfig: (route, intercept) =>
        resolveConfig(route, intercept)?.dynamicConfig ?? null,
      resolveRouteFetchCacheMode: (route, intercept) =>
        resolveConfig(route, intercept)?.fetchCache ?? null,
      resolveRouteRevalidateSeconds: (route, intercept) =>
        resolveConfig(route, intercept)?.revalidateSeconds ?? null,
      revalidateSeconds: 60,
      sourceRoute,
    });
  }

  it("regenerates a stale intercepted RSC entry under an active sibling's shorter revalidate", async () => {
    // app/feed/@modal/(.)photos/[id]/page.tsx sets dynamic = "force-static"
    // and revalidate = 30; app/feed/@sidebar/page.tsx, which renders beside
    // it, sets revalidate = 10.
    const { isrSet, regeneration, renders } = await regenerateStaleInterceptWithActiveSidebar(
      { default: "modal-page", dynamic: "force-static", revalidate: 30 },
      { default: "sidebar-page", revalidate: 10 },
    );
    await expect(regeneration).resolves.toBeUndefined();

    expect(renders).toEqual([
      {
        dynamicUsage: false,
        fetchCacheMode: null,
        fetchRevalidate: 10,
        observePageSearchParamsAccess: false,
      },
    ]);
    expect(isrSet).toHaveBeenCalledTimes(1);
    expect(isrSet).toHaveBeenCalledWith("rsc:/photos/123:/feed", expect.anything(), {
      cacheControl: { revalidate: 10 },
      tags: expect.any(Array),
    });
  });

  it("regenerates a stale intercepted RSC entry with an active sibling's dynamic and fetchCache", async () => {
    // app/feed/@sidebar/page.tsx sets dynamic = "force-static" and
    // fetchCache = "force-no-store"; the intercepting page sets neither.
    const { isrSet, regeneration, renders } = await regenerateStaleInterceptWithActiveSidebar(
      { default: "modal-page" },
      { default: "sidebar-page", dynamic: "force-static", fetchCache: "force-no-store" },
    );
    await expect(regeneration).resolves.toBeUndefined();

    expect(renders).toEqual([
      {
        dynamicUsage: false,
        fetchCacheMode: "force-no-store",
        fetchRevalidate: null,
        observePageSearchParamsAccess: false,
      },
    ]);
    // A force-static tree without a revalidate keeps `revalidate = false`.
    expect(isrSet).toHaveBeenCalledTimes(1);
    expect(isrSet).toHaveBeenCalledWith("rsc:/photos/123:/feed", expect.anything(), {
      cacheControl: { revalidate: Infinity },
      tags: expect.any(Array),
    });
  });

  it("regenerates an intercept on the matched route without the replaced branch's config", async () => {
    // app/photos/[id]/@modal/page.tsx sets dynamic = "force-static",
    // fetchCache = "force-cache" and revalidate = 60, which the matched
    // route's tree takes. The intercepting page that replaces it on the same
    // route sets none of them.
    const currentRoute = createRoute({
      params: ["id"],
      pattern: "/photos/[id]",
      routeSegments: ["photos", "[id]"],
    });
    const interceptPage = { default: "modal-page" };
    const { isrSet, regeneration, renders, staleValue } = await regenerateStaleInterceptedRscEntry({
      currentRoute,
      dynamicConfig: "force-static",
      fetchCache: "force-cache",
      interceptPage,
      resolveRouteDynamicConfig: (_route, intercept) => (intercept ? null : "force-static"),
      resolveRouteFetchCacheMode: (_route, intercept) => (intercept ? null : "force-cache"),
      resolveRouteRevalidateSeconds: (_route, intercept) => (intercept ? null : 60),
      revalidateSeconds: 60,
      sourceRoute: currentRoute,
    });
    // Without the replaced branch's force-static, the render's headers() read
    // is dynamic usage, which fails the regeneration as in Next.js.
    await expect(regeneration).rejects.toThrow(
      "Page changed from static to dynamic at runtime /photos/123",
    );

    expect(renders).toEqual([
      {
        dynamicUsage: true,
        fetchCacheMode: null,
        fetchRevalidate: null,
        observePageSearchParamsAccess: true,
      },
    ]);
    expect(isrSet).toHaveBeenCalledTimes(1);
    expect(isrSet).toHaveBeenCalledWith("rsc:/photos/123:/feed", staleValue, {
      cacheControl: { revalidate: 30 },
      tags: expect.any(Array),
    });
  });

  it("regenerates a stale intercepted RSC entry with its tree's generateStaticParams default in a cacheComponents build", async () => {
    // app/feed/@modal/(.)photos/[id]/page.tsx exports generateStaticParams
    // and no revalidate, so the intercepting tree keeps `revalidate = false`.
    const sourceRoute = createRoute({ pattern: "/feed", routeSegments: ["feed"] });
    const currentRoute = createRoute({
      params: ["id"],
      pattern: "/photos/[id]",
      routeSegments: ["photos", "[id]"],
    });
    const interceptPage = { default: "modal-page", generateStaticParams: () => [] };
    const resolveRouteHasAnyGenerateStaticParams = vi.fn<
      NonNullable<DispatchOptions["resolveRouteHasAnyGenerateStaticParams"]>
    >((route, intercept) => route === sourceRoute && intercept.interceptPage === interceptPage);
    const { isrSet, regeneration } = await regenerateStaleInterceptedRscEntry({
      currentRoute,
      interceptPage,
      pprRuntime: appPagePprRuntime,
      resolveRouteDynamicConfig: () => null,
      resolveRouteFetchCacheMode: () => null,
      resolveRouteHasAnyGenerateStaticParams,
      resolveRouteRevalidateSeconds: (route, intercept) => (intercept ? null : 60),
      revalidateSeconds: 60,
      sourceRoute,
    });
    await regeneration;

    expect(resolveRouteHasAnyGenerateStaticParams).toHaveBeenCalledWith(
      sourceRoute,
      expect.objectContaining({ interceptPage }),
    );
    expect(isrSet).toHaveBeenCalledTimes(1);
    expect(isrSet).toHaveBeenCalledWith("rsc:/photos/123:/feed", expect.anything(), {
      cacheControl: { revalidate: Infinity },
      tags: expect.any(Array),
    });
  });

  describe("a stale intercepted entry whose intercepted tree turned dynamic", () => {
    // app/feed/@modal/(.)photos/[id]/page.tsx now sets revalidate = 0 or
    // dynamic = "force-dynamic" (which resolves revalidate = 0), and its
    // render reads no request API. app/photos/[id] sets revalidate = 60.
    const sourceRoute = createRoute({ pattern: "/feed", routeSegments: ["feed"] });
    const currentRoute = createRoute({
      params: ["id"],
      pattern: "/photos/[id]",
      routeSegments: ["photos", "[id]"],
    });
    const interceptPage = { default: "modal-page" };
    const isInterceptTree = (
      route: TestRoute,
      intercept?: Parameters<NonNullable<DispatchOptions["resolveRouteDynamicConfig"]>>[1],
    ) => route === sourceRoute && intercept?.interceptPage === interceptPage;
    const regenerate = (
      dynamicConfig: string | undefined,
      pprRuntime?: DispatchOptions["pprRuntime"],
    ) =>
      regenerateStaleInterceptedRscEntry({
        currentRoute,
        interceptPage,
        pprRuntime,
        readsHeaders: false,
        resolveRouteDynamicConfig: (route, intercept) =>
          isInterceptTree(route, intercept) ? dynamicConfig : undefined,
        resolveRouteFetchCacheMode: () => null,
        resolveRouteRevalidateSeconds: (route, intercept) =>
          isInterceptTree(route, intercept) ? 0 : null,
        revalidateSeconds: 60,
        sourceRoute,
      });

    it.each([
      ["revalidate = 0", undefined],
      ['dynamic = "force-dynamic"', "force-dynamic"],
    ])("fails its regeneration at %s and keeps the previous entry", async (_label, config) => {
      const { isrSet, regeneration, renders, staleValue } = await regenerate(config);

      // Like Next.js, an effective revalidate of 0 fails a regeneration
      // without PPR even when the render used no dynamic API.
      await expect(regeneration).rejects.toThrow(
        "Page changed from static to dynamic at runtime /photos/123",
      );
      expect(renders).toEqual([expect.objectContaining({ dynamicUsage: false })]);
      expect(isrSet).toHaveBeenCalledTimes(1);
      expect(isrSet).toHaveBeenCalledWith("rsc:/photos/123:/feed", staleValue, {
        cacheControl: { revalidate: 30 },
        tags: expect.any(Array),
      });
    });

    it("stores its PPR regeneration", async () => {
      const { isrSet, regeneration } = await regenerate(undefined, appPagePprRuntime);

      await expect(regeneration).resolves.toBeUndefined();
      expect(isrSet).toHaveBeenCalledTimes(1);
      expect(isrSet).toHaveBeenCalledWith(
        "rsc:/photos/123:/feed",
        expect.objectContaining({
          rscData: new TextEncoder().encode("regenerated-flight").buffer,
        }),
        { cacheControl: { revalidate: 0 }, tags: expect.any(Array) },
      );
    });
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
    expect(resolveRouteDynamicConfig).toHaveBeenCalledWith(
      targetRoute,
      expect.objectContaining({ interceptSlotKey: "modal@app/feed/@modal" }),
    );
  });

  it("serves exact cache HIT instead of fallback shell", async () => {
    const buildPageElement = createParamTextPageElement();
    const isrGet = vi.fn(async (key: string) => {
      if (key === "html:/en/blog/known-post") {
        return buildISRCacheEntry(
          buildCachedAppPageValue("<html><head></head><body>exact HIT</body></html>"),
          false,
        );
      }
      return null;
    });
    const { options } = createPprBlogDispatchOptions({
      buildPageElement,
      cleanPathname: "/en/blog/known-post",
      isrGet,
      params: { locale: "en", slug: "known-post" },
    });

    const response = await dispatchAppPage(options);

    expect(response.headers.get("x-vinext-cache")).toBe("HIT");
    await expect(response.text()).resolves.toBe("<html><head></head><body>exact HIT</body></html>");
    expect(buildPageElement).not.toHaveBeenCalled();
  });

  it("static params validation rejects unknown params before shell probing", async () => {
    const generateStaticParams = vi.fn(async () => [{ locale: "en", slug: "hello-world" }]);
    const buildPageElement = createParamTextPageElement();
    const isrGet = vi.fn(async () => null);
    const { options } = createPprBlogDispatchOptions({
      buildPageElement,
      cleanPathname: "/en/blog/unknown-post",
      generateStaticParams,
      isrGet,
      params: { locale: "en", slug: "unknown-post" },
    });

    const response = await dispatchAppPage({
      ...options,
      dynamicParamsConfig: false,
    });

    expect(response.status).toBe(404);
    expect(isrGet).not.toHaveBeenCalledWith("html:/en/blog/[slug]");
    expect(buildPageElement).not.toHaveBeenCalled();
  });

  it("serves fallback shell HTML for an unknown child param after the exact cache misses", async () => {
    const buildPageElement = createParamTextPageElement();
    const isrGet = createPprBlogFallbackShellGetter(false);
    const { options } = createPprBlogDispatchOptions({
      buildPageElement,
      isrGet,
    });

    const response = await dispatchAppPage(options);

    expect(isrGet.mock.calls.map(([key]) => key)).toEqual([
      "html:/en/blog/new-post",
      "html:/en/blog/[slug]",
    ]);
    expect(response.headers.get("x-vinext-cache")).toBe("HIT");
    await expect(response.text()).resolves.toContain("Locale: en");
    expect(buildPageElement).not.toHaveBeenCalled();
  });

  it("does not serve fallback shell HTML for an unknown child param when the request has search params", async () => {
    const buildPageElement = createParamTextPageElement("fresh");
    const isrGet = createPprBlogFallbackShellGetter(false);
    const { options } = createPprBlogDispatchOptions({
      buildPageElement,
      isrGet,
      loadSsrHandler: createFreshBodySsrHandler("fresh render"),
      request: new Request("https://example.test/en/blog/new-post?preview=1"),
      searchParams: new URLSearchParams("preview=1"),
    });

    const response = await dispatchAppPage(options);

    expect(isrGet.mock.calls.map(([key]) => key)).toEqual(["html:/en/blog/new-post"]);
    expect(isrGet).not.toHaveBeenCalledWith("html:/en/blog/[slug]");
    expect(response.headers.get("x-vinext-cache")).toBeNull();
    await expect(response.text()).resolves.toContain("fresh render");
    expect(buildPageElement).toHaveBeenCalled();
  });

  it("serves stale static PPR fallback-shell HTML without regenerating the shell key", async () => {
    const buildPageElement = createParamTextPageElement();
    const isrGet = createPprBlogFallbackShellGetter(true);
    const { options } = createPprBlogDispatchOptions({
      buildPageElement,
      isrGet,
    });

    const response = await dispatchAppPage(options);

    expect(isrGet.mock.calls.map(([key]) => key)).toEqual([
      "html:/en/blog/new-post",
      "html:/en/blog/[slug]",
    ]);
    expect(response.headers.get("x-vinext-cache")).toBe("STALE");
    await expect(response.text()).resolves.toContain("Locale: en");
    expect(buildPageElement).not.toHaveBeenCalled();
    expect(options.scheduleBackgroundRegeneration).not.toHaveBeenCalled();
  });

  it("falls through to a fresh render when the cached fallback shell requires resume", async () => {
    const buildPageElement = createParamTextPageElement("fresh");
    const isrGet = vi.fn(async (key: string) => {
      if (key === "html:/en/blog/[slug]") {
        return buildISRCacheEntry(
          buildCachedAppPageValue(
            markAppPprDynamicFallbackShellHtml(
              "<html><head></head><body>fallback only</body></html>",
            ),
          ),
        );
      }
      return null;
    });
    const { options } = createPprBlogDispatchOptions({
      buildPageElement,
      isrGet,
      loadSsrHandler: createFreshBodySsrHandler("fresh new-post content"),
    });

    const response = await dispatchAppPage(options);

    expect(response.headers.get("x-vinext-cache")).toBe("MISS");
    await expect(response.text()).resolves.toContain("fresh new-post content");
    expect(buildPageElement).toHaveBeenCalled();
  });

  it("does not serve the fallback shell for a known pregenerated route whose exact cache is absent", async () => {
    const buildPageElement = createParamTextPageElement("fresh");
    const isrGet = createPprBlogFallbackShellGetter(false);
    const { options } = createPprBlogDispatchOptions({
      buildPageElement,
      cleanPathname: "/en/blog/known-post",
      isrGet,
      loadSsrHandler: createFreshBodySsrHandler(
        `fresh:${JSON.stringify({ locale: "en", slug: "known-post" })}`,
      ),
      params: { locale: "en", slug: "known-post" },
      renderedConcreteUrlPaths: new Set(["/en/blog/known-post"]),
    });

    const response = await dispatchAppPage(options);

    expect(isrGet.mock.calls.map(([key]) => key)).toEqual(["html:/en/blog/known-post"]);
    expect(isrGet).not.toHaveBeenCalledWith("html:/en/blog/[slug]");
    expect(buildPageElement).toHaveBeenCalled();
    expect(response.headers.get("x-vinext-cache")).toBe("MISS");
  });

  it("does not serve the fallback shell for an encoded known pregenerated route whose exact cache is absent", async () => {
    const buildPageElement = createParamTextPageElement("fresh");
    const isrGet = createPprBlogFallbackShellGetter(false);
    const { options } = createPprBlogDispatchOptions({
      buildPageElement,
      cleanPathname: "/en/blog/hello world",
      isrGet,
      loadSsrHandler: createFreshBodySsrHandler(
        `fresh:${JSON.stringify({ locale: "en", slug: "hello world" })}`,
      ),
      params: { locale: "en", slug: "hello world" },
      renderedConcreteUrlPaths: new Set(["/en/blog/hello world"]),
    });

    const response = await dispatchAppPage(options);

    expect(isrGet.mock.calls.map(([key]) => key)).toEqual(["html:/en/blog/hello world"]);
    expect(isrGet).not.toHaveBeenCalledWith("html:/en/blog/[slug]");
    expect(buildPageElement).toHaveBeenCalled();
    expect(response.headers.get("x-vinext-cache")).toBe("MISS");
  });

  it("does not serve the fallback shell when concrete paths come from the Worker global registry", async () => {
    const { getRenderedConcreteUrlPathsForRoute, initPregeneratedPathsFromGlobals } =
      await import("../packages/vinext/src/server/pregenerated-concrete-paths.js");

    globalThis.__VINEXT_PREGENERATED_CONCRETE_PATHS = [
      ["/:locale/blog/:slug", ["/en/blog/worker-known"]],
    ];
    initPregeneratedPathsFromGlobals();
    delete globalThis.__VINEXT_PREGENERATED_CONCRETE_PATHS;
    const concretePaths = getRenderedConcreteUrlPathsForRoute("/:locale/blog/:slug");

    const buildPageElement = createParamTextPageElement("fresh");
    const isrGet = createPprBlogFallbackShellGetter(false);
    const { options } = createPprBlogDispatchOptions({
      buildPageElement,
      cleanPathname: "/en/blog/worker-known",
      isrGet,
      loadSsrHandler: createFreshBodySsrHandler(
        `fresh:${JSON.stringify({ locale: "en", slug: "worker-known" })}`,
      ),
      params: { locale: "en", slug: "worker-known" },
      renderedConcreteUrlPaths: concretePaths,
    });

    const response = await dispatchAppPage(options);

    expect(isrGet.mock.calls.map(([key]) => key)).toEqual(["html:/en/blog/worker-known"]);
    expect(isrGet).not.toHaveBeenCalledWith("html:/en/blog/[slug]");
    expect(buildPageElement).toHaveBeenCalled();
    expect(response.headers.get("x-vinext-cache")).toBe("MISS");
  });

  describe("static eligibility (Next.js route classification)", () => {
    const NEVER_CACHE_CONTROL = "private, no-cache, no-store, max-age=0, must-revalidate";

    function createDynamicSegmentRoute(): TestRoute {
      return createRoute({ isDynamic: true, params: ["slug"] });
    }

    async function dispatchAndDrain(options: DispatchOptions) {
      const waitUntilPromises: Promise<unknown>[] = [];
      const response = await runWithExecutionContext(
        {
          waitUntil(promise) {
            waitUntilPromises.push(promise);
          },
        },
        () => dispatchAppPage(options),
      );
      const body = await response.text();
      await Promise.all(waitUntilPromises.splice(0));
      return { body, response };
    }

    // Next.js classifies a dynamic-segment route without generateStaticParams
    // as dynamic (ƒ): it renders per request and is never full-page cached,
    // even with a revalidate export.
    // https://github.com/vercel/next.js/blob/v16.2.6/packages/next/src/build/index.ts#L2358-L2408
    for (const isRscRequest of [false, true]) {
      it(`never caches a dynamic-segment route without generateStaticParams (${isRscRequest ? "RSC" : "HTML"})`, async () => {
        const isrGet = vi.fn<DispatchOptions["isrGet"]>(async () => null);
        const isrSet = vi.fn<DispatchOptions["isrSet"]>(async () => {});
        const { options } = createDispatchOptions({
          isProduction: true,
          isRscRequest,
          isrGet,
          isrSet,
          revalidateSeconds: 60,
          route: createDynamicSegmentRoute(),
        });

        const { response } = await dispatchAndDrain(options);

        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe(NEVER_CACHE_CONTROL);
        expect(response.headers.get("x-vinext-cache")).toBeNull();
        expect(isrGet).not.toHaveBeenCalled();
        expect(isrSet).not.toHaveBeenCalled();
      });
    }

    it("caches a dynamic-segment route whose generateStaticParams sits at its last dynamic segment", async () => {
      const isrGet = vi.fn<DispatchOptions["isrGet"]>(async () => null);
      const isrSet = vi.fn<DispatchOptions["isrSet"]>(async () => {});
      const { options } = createDispatchOptions({
        hasGenerateStaticParams: true,
        isProduction: true,
        isrGet,
        isrSet,
        revalidateSeconds: 60,
        route: createDynamicSegmentRoute(),
      });

      const { response } = await dispatchAndDrain(options);

      expect(response.headers.get("x-vinext-cache")).toBe("MISS");
      expect(isrGet).toHaveBeenCalledWith("html:/posts/hello");
      expect(isrSet.mock.calls.map(([key]) => key)).toContain("html:/posts/hello");
      expect(isrSet.mock.calls[0]![2].cacheControl.revalidate).toBe(60);
    });

    it("keeps the revalidate = false default from a parent generateStaticParams in a cacheComponents build", async () => {
      const isrSet = vi.fn<DispatchOptions["isrSet"]>(async () => {});
      const { options } = createDispatchOptions({
        hasAnyGenerateStaticParams: true,
        hasGenerateStaticParams: false,
        isProduction: true,
        isrSet,
        pprRuntime: appPagePprRuntime,
        route: createDynamicSegmentRoute(),
      });

      await dispatchAndDrain(options);

      const htmlWrite = isrSet.mock.calls.find(([key]) => key === "html:/posts/hello");
      expect(htmlWrite?.[2].cacheControl.revalidate).toBe(Infinity);
    });

    for (const dynamicConfig of ["force-static", "error"]) {
      it(`caches a dynamic-segment route with dynamic = "${dynamicConfig}"`, async () => {
        const isrSet = vi.fn<DispatchOptions["isrSet"]>(async () => {});
        const { options } = createDispatchOptions({
          dynamicConfig,
          isProduction: true,
          isrSet,
          route: createDynamicSegmentRoute(),
        });

        await dispatchAndDrain(options);

        expect(isrSet.mock.calls.map(([key]) => key)).toContain("html:/posts/hello");
      });
    }

    // Next.js disables static generation for edge-runtime pages whatever their
    // segments or config.
    // https://github.com/vercel/next.js/blob/v16.2.6/packages/next/src/build/index.ts#L2333-L2340
    for (const [name, overrides] of [
      ["without dynamic segments", {}],
      ["with revalidate = 60", { revalidateSeconds: 60 }],
      [
        "with generateStaticParams",
        { hasGenerateStaticParams: true, route: createDynamicSegmentRoute() },
      ],
      ["with force-static", { dynamicConfig: "force-static" }],
    ] satisfies [string, CreateDispatchOptionsOverrides][]) {
      it(`never caches an edge-runtime page ${name}`, async () => {
        const isrGet = vi.fn<DispatchOptions["isrGet"]>(async () => null);
        const isrSet = vi.fn<DispatchOptions["isrSet"]>(async () => {});
        const { options } = createDispatchOptions({
          isProduction: true,
          isStaticGenerationEdgeRuntime: true,
          isrGet,
          isrSet,
          ...overrides,
        });

        const { response } = await dispatchAndDrain(options);

        expect(response.headers.get("cache-control")).toBe(NEVER_CACHE_CONTROL);
        expect(isrGet).not.toHaveBeenCalled();
        expect(isrSet).not.toHaveBeenCalled();
      });
    }

    for (const fallback of ["rendered", "plain"] as const) {
      it(`never caches a ${fallback} generated-param miss of an edge-runtime page`, async () => {
        const middlewareCacheControl = "public, max-age=5";
        const dispatch = async (middlewareHeaders?: Headers) => {
          const { options } = createDispatchOptions({
            async generateStaticParams() {
              return [{ slug: "known" }];
            },
            hasGenerateStaticParams: true,
            isProduction: true,
            isStaticGenerationEdgeRuntime: true,
            route: createDynamicSegmentRoute(),
          });
          options.renderHttpAccessFallbackPage = async () =>
            fallback === "rendered"
              ? new Response("not found", {
                  headers: middlewareHeaders ?? undefined,
                  status: 404,
                })
              : null;
          if (middlewareHeaders) options.middlewareContext.headers = middlewareHeaders;
          return dispatchAppPage({ ...options, dynamicParamsConfig: false });
        };

        const response = await dispatch();
        expect(response.status).toBe(404);
        expect(response.headers.get("cache-control")).toBe(NEVER_CACHE_CONTROL);

        // Middleware's own cache policy still wins.
        if (fallback === "rendered") {
          const withMiddlewarePolicy = await dispatch(
            new Headers({ "cache-control": middlewareCacheControl }),
          );
          expect(withMiddlewarePolicy.headers.get("cache-control")).toBe(middlewareCacheControl);
        }
      });
    }

    it("never caches the missing default export response of a non-static page", async () => {
      const dispatch = async (overrides: CreateDispatchOptionsOverrides) => {
        const { options: dispatchOptions } = createDispatchOptions({
          isProduction: true,
          ...overrides,
        });
        return dispatchAppPage({ ...dispatchOptions, hasPageDefaultExport: false });
      };

      for (const response of [
        await dispatch({ isStaticGenerationEdgeRuntime: true }),
        await dispatch({ route: createDynamicSegmentRoute() }),
      ]) {
        expect(response.status).toBe(500);
        expect(response.headers.get("cache-control")).toBe(NEVER_CACHE_CONTROL);
      }

      // A static page's response keeps no policy of its own.
      const staticResponse = await dispatch({});
      expect(staticResponse.status).toBe(500);
      expect(staticResponse.headers.get("cache-control")).toBeNull();
    });

    it("renders non-GET requests to a dynamic-segment route without generateStaticParams", async () => {
      const buildPageElement = vi.fn(async () => React.createElement("main", null, "page"));
      const { options } = createDispatchOptions({
        buildPageElement,
        request: new Request("https://example.test/posts/hello", { method: "POST" }),
        route: createDynamicSegmentRoute(),
      });

      const response = await dispatchAppPage(options);

      expect(response.status).toBe(200);
      expect(buildPageElement).toHaveBeenCalled();
    });

    it("renders non-GET requests to a dynamic-segment route in a cacheComponents build", async () => {
      const buildPageElement = vi.fn(async () => React.createElement("main", null, "page"));
      const { options } = createDispatchOptions({
        buildPageElement,
        pprRuntime: appPagePprRuntime,
        request: new Request("https://example.test/posts/hello", { method: "POST" }),
        route: createDynamicSegmentRoute(),
      });

      const response = await dispatchAppPage(options);

      expect(response.status).toBe(200);
      expect(buildPageElement).toHaveBeenCalled();
    });

    it("reports a dynamic-segment route without generateStaticParams as uncacheable to adapter admission", async () => {
      const context: ExecutionContextLike = { waitUntil() {} };
      const state: RouteCacheabilityState = {
        captureDeadlineAt: Date.now() + 10_000,
        mode: "admit",
      };
      Reflect.set(context, CACHEABILITY_REQUEST_STATE, state);
      const { options } = createDispatchOptions({
        isProduction: true,
        revalidateSeconds: 60,
        route: createDynamicSegmentRoute(),
      });

      const response = await runWithExecutionContext(context, () => dispatchAppPage(options));
      await response.text();

      await expect(state.completion).resolves.toEqual({
        cacheable: false,
        reason: "route is not statically generated",
      });
    });

    // Next.js defaults every static or SSG route to `revalidate = false`, so a
    // static page with no revalidate source is served until it's revalidated.
    // https://github.com/vercel/next.js/blob/v16.2.6/packages/next/src/build/index.ts
    for (const isRscRequest of [false, true]) {
      it(`stores a static route with no revalidate source indefinitely (${isRscRequest ? "RSC" : "HTML"})`, async () => {
        const isrSet = vi.fn<DispatchOptions["isrSet"]>(async () => {});
        const { options } = createDispatchOptions({
          isProduction: true,
          isRscRequest,
          isrSet,
          route: createRoute({ pattern: "/about", routeSegments: ["about"] }),
          cleanPathname: "/about",
        });

        const { response } = await dispatchAndDrain(options);

        expect(response.headers.get("x-vinext-cache")).toBe("MISS");
        const key = isRscRequest ? "rsc:/about" : "html:/about";
        const write = isrSet.mock.calls.find(([writtenKey]) => writtenKey === key);
        expect(write?.[2].cacheControl.revalidate).toBe(Infinity);
      });
    }

    it("reports a static route with no revalidate source as cacheable to adapter admission", async () => {
      const context: ExecutionContextLike = { waitUntil() {} };
      const state: RouteCacheabilityState = {
        captureDeadlineAt: Date.now() + 10_000,
        mode: "admit",
      };
      Reflect.set(context, CACHEABILITY_REQUEST_STATE, state);
      const { options } = createDispatchOptions({ isProduction: true });

      const response = await runWithExecutionContext(context, () => dispatchAppPage(options));
      await response.text();

      await expect(state.completion).resolves.toMatchObject({
        cacheable: true,
        cacheControl: "s-maxage=31536000, stale-while-revalidate",
      });
    });
  });
});
