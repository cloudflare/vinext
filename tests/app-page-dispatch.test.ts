import React from "react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";
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
import { APP_RSC_RENDER_MODE_PREFETCH_DYNAMIC_SHELL } from "../packages/vinext/src/server/app-rsc-render-mode.js";
import { makeThenableParams } from "../packages/vinext/src/shims/thenable-params.js";
import { after } from "../packages/vinext/src/shims/server.js";
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
import { VINEXT_INTERCEPTION_ID_HEADER } from "../packages/vinext/src/server/headers.js";
import { markFrameworkLinkHeaders } from "../packages/vinext/src/server/app-response-header-provenance.js";
import {
  createWorkerCacheabilityAdmissionContext,
  finalizeWorkerCacheabilityResponse,
} from "../packages/vinext/src/server/cacheability-request.js";
import {
  usePathname,
  useSearchParams,
  type NavigationContext,
} from "../packages/vinext/src/shims/navigation.js";
import { notFound } from "../packages/vinext/src/shims/navigation-errors.js";
import { cacheLife } from "../packages/vinext/src/shims/cache.js";
import {
  DefaultCdnCacheAdapter,
  setCdnCacheAdapter,
} from "../packages/vinext/src/shims/cdn-cache.js";
import { CloudflareCdnCacheAdapter } from "../packages/cloudflare/src/cache/cdn-adapter.runtime.js";

// handleSsr's build-time modules. The stand-in Flight client hands SSR the
// payload the stand-in Flight render last serialized, once it has read the
// stream's first chunk, and keeps draining the rest.
const ssrFlight = vi.hoisted(() => ({ payload: undefined as unknown }));
vi.mock("virtual:vite-rsc/client-references", () => ({ default: {} }));
vi.mock("virtual:vinext-pages-client-assets", () => ({ default: {} }));
vi.mock("@vitejs/plugin-rsc/ssr", () => ({
  async createFromReadableStream(stream: ReadableStream<Uint8Array>) {
    const payload = ssrFlight.payload;
    const reader = stream.getReader();
    await reader.read();
    void (async () => {
      while (!(await reader.read()).done) {
        // drain
      }
    })();
    return payload;
  },
}));

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
        page?: { default?: unknown; generateMetadata?: unknown } | null;
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

function findMetadataOutletElements(payload: unknown): React.ReactElement[] {
  return Object.entries(captureRecord(payload)).flatMap(([key, value]) =>
    key.startsWith("__vinext_streaming_metadata_outlet:") && React.isValidElement(value)
      ? [value]
      : [],
  );
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
      // Flight renders every entry, so the head resolves during the render.
      // Its outlet awaits generateMetadata() and generateViewport(). None of
      // these tests expects a head error, so a rejection fails the render.
      const [text] = await Promise.all([
        pageElement ? renderReactNodeText(pageElement) : "",
        ...findMetadataOutletElements(payload).map((outlet) => renderReactNodeText(outlet)),
      ]);
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

// Lists `/posts/listed` as static; every other `/posts/[slug]` path has no state.
function createPostsCacheabilityManifest() {
  return parseCacheabilityManifest(
    JSON.stringify({
      buildId: "build-a",
      routes: {
        [cacheabilityManifestRouteKey("app-page", "/posts/[slug]")]: {
          kind: "app-page",
          pattern: "/posts/[slug]",
          state: "runtime-check",
          staticPaths: { html: ["/posts/listed"], "rsc-full": ["/posts/listed"] },
        },
      },
      version: 1,
    }),
    "build-a",
  );
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
  dynamicConfig?: DispatchOptions["dynamicConfig"];
  dynamicParamsConfig?: DispatchOptions["dynamicParamsConfig"];
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
  renderedConcreteUrlPaths?: DispatchOptions["renderedConcreteUrlPaths"];
  renderMode?: DispatchOptions["renderMode"];
  renderToReadableStream?: DispatchOptions["renderToReadableStream"];
  request?: Request;
  revalidateSeconds?: number | null;
  resolveRouteFetchCacheMode?: DispatchOptions["resolveRouteFetchCacheMode"];
  resolveRouteRevalidateSeconds?: DispatchOptions["resolveRouteRevalidateSeconds"];
  resolveRouteDynamicConfig?: DispatchOptions["resolveRouteDynamicConfig"];
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
    createRscOnErrorHandler: overrides.createRscOnErrorHandler ?? (() => () => undefined),
    draftModeSecret: "draft-secret",
    dynamicConfig: overrides.dynamicConfig,
    dynamicParamsConfig: overrides.dynamicParamsConfig,
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
    const route = createRoute({
      layouts: [{}, {}, {}],
      layoutTreePositions: [0, 1, 2],
      loading: null,
      loadings: [{ default: () => null }],
      loadingTreePositions: [1],
      routeSegments: ["parent", "slow"],
    });
    const { options } = createDispatchOptions({ probeLayoutAt, route });

    const response = await dispatchAppPage(options);
    await response.text();

    // The loading at position 1 catches descendants, but not a layout at the
    // same position. Probe the root and co-located layout only.
    expect(probeLayoutAt.mock.calls.map(([layoutIndex]) => layoutIndex)).toEqual([1, 0]);
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
      revalidateSeconds: 60,
      searchParams: new URLSearchParams("search=hello"),
    });

    const response = await dispatchAppPage(options);

    expect(isrGet).toHaveBeenCalled();
    expect(response.headers.get("x-vinext-cache")).toBeNull();
    expect(response.headers.get("cache-control")).toBe(
      "private, no-cache, no-store, max-age=0, must-revalidate",
    );
    await expect(response.text()).resolves.toBe("<html>page</html>");
  });

  it("renders query-bearing HTML as a cache candidate and stores it when searchParams is unread", async () => {
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
      revalidateSeconds: 60,
      searchParams: new URLSearchParams("utm_source=google"),
    });

    const response = await runWithExecutionContext(executionContext, () =>
      dispatchAppPage(options),
    );

    // SSR keeps the query out of the output unless the render turns dynamic,
    // so a candidate miss reports MISS with or without a query.
    expect(ssrOptions).toEqual([{ isCacheCandidate: true }]);
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

  // Next.js never stores a path its build didn't certify, so a Workers Cache
  // path its manifest gives no state never reads, serves or regenerates a core
  // ISR entry. A certified path, and every path without a manifest, keeps the
  // core cache.
  it("skips the core ISR cache for a path its Workers Cache manifest gives no state", async () => {
    const manifest = createPostsCacheabilityManifest();
    const cases: [RouteCacheabilityState["admission"], string, boolean][] = [
      [{ manifest, policy: "manifest", routePathname: "/posts/hello" }, "/posts/hello", false],
      [{ manifest, policy: "manifest", routePathname: "/posts/listed" }, "/posts/listed", true],
      [{ policy: "runtime", routePathname: "/posts/hello" }, "/posts/hello", true],
    ];
    for (const [admission, cleanPathname, readsCore] of cases) {
      for (const isRscRequest of [false, true]) {
        const label = JSON.stringify({ admission, isRscRequest });
        const isrGet = vi.fn<DispatchOptions["isrGet"]>(async () =>
          buildISRCacheEntry(
            buildCachedAppPageValue(
              isRscRequest ? "" : "<html>stale</html>",
              new TextEncoder().encode("stale-flight").buffer,
            ),
            true,
          ),
        );
        const isrSet = vi.fn<DispatchOptions["isrSet"]>(async () => {});
        const scheduleBackgroundRegeneration = vi.fn();
        const context: ExecutionContextLike = { waitUntil() {} };
        const state: RouteCacheabilityState = {
          admission: admission && {
            ...admission,
            representation: isRscRequest ? "rsc-full" : "html",
          },
          captureDeadlineAt: Date.now() + 10_000,
          mode: "admit",
        };
        Reflect.set(context, CACHEABILITY_REQUEST_STATE, state);
        const { options } = createDispatchOptions({
          cleanPathname,
          isProduction: true,
          isRscRequest,
          isrGet,
          isrSet,
          revalidateSeconds: 60,
          scheduleBackgroundRegeneration,
        });

        const response = await runWithExecutionContext(context, () => dispatchAppPage(options));
        await response.text();

        if (readsCore) {
          expect(response.headers.get("x-vinext-cache"), label).toBe("STALE");
          expect(isrGet, label).toHaveBeenCalled();
          expect(scheduleBackgroundRegeneration, label).toHaveBeenCalledTimes(1);
        } else {
          expect(response.headers.get("x-vinext-cache"), label).not.toBe("STALE");
          expect(isrGet, label).not.toHaveBeenCalled();
          expect(scheduleBackgroundRegeneration, label).not.toHaveBeenCalled();
          expect(isrSet, label).not.toHaveBeenCalled();
        }
      }
    }
  });

  // A core entry another request stored under the query-free key must not
  // reach a path Next.js serves per request: each request renders with its
  // own query, and none stores its render.
  it("renders a path its Workers Cache manifest gives no state with each request's query", async () => {
    const manifest = createPostsCacheabilityManifest();
    const sharedFlight = new TextEncoder().encode("shared-flight").buffer;
    const cache = new Map<string, ISRCacheEntry>([
      [
        "html:/posts/hello",
        buildISRCacheEntry(
          buildCachedAppPageValue(
            "<html>shared</html>",
            sharedFlight,
            undefined,
            buildQueryInvariantRenderObservation(),
          ),
        ),
      ],
      [
        "rsc:/posts/hello",
        buildISRCacheEntry(
          buildCachedAppPageValue(
            "",
            sharedFlight,
            undefined,
            buildQueryInvariantRenderObservation(),
          ),
        ),
      ],
    ]);
    const isrGet = vi.fn<DispatchOptions["isrGet"]>(async (key) => cache.get(key) ?? null);
    const isrSet = vi.fn<DispatchOptions["isrSet"]>(async (key, data) => {
      cache.set(key, { isStale: false, value: { lastModified: Date.now(), value: data } });
    });
    for (const isRscRequest of [false, true]) {
      const renders: { isCacheCandidate?: boolean; q: string | null | undefined }[] = [];
      const pageQueries: (string | null)[] = [];
      for (const q of ["1", "2"]) {
        let navigationContext: ReturnType<DispatchOptions["getNavigationContext"]> = null;
        const waitUntilPromises: Promise<unknown>[] = [];
        const context: ExecutionContextLike = {
          waitUntil(promise) {
            waitUntilPromises.push(promise);
          },
        };
        const state: RouteCacheabilityState = {
          admission: {
            manifest,
            policy: "manifest",
            representation: isRscRequest ? "rsc-full" : "html",
            routePathname: "/posts/hello",
          },
          captureDeadlineAt: Date.now() + 10_000,
          mode: "admit",
        };
        Reflect.set(context, CACHEABILITY_REQUEST_STATE, state);
        const { options } = createDispatchOptions({
          async buildPageElement(_route, _params, _opts, searchParams) {
            pageQueries.push(searchParams.get("q"));
            return React.createElement("main", null, "page");
          },
          cleanPathname: "/posts/hello",
          getNavigationContext: () => navigationContext,
          isProduction: true,
          isRscRequest,
          isrGet,
          isrSet,
          loadSsrHandler: async () => ({
            async handleSsr(_rscStream, ssrNavigationContext, _fontData, handleSsrOptions) {
              renders.push({
                isCacheCandidate: handleSsrOptions?.isCacheCandidate,
                q: ssrNavigationContext?.searchParams.get("q"),
              });
              void handleSsrOptions?.sideStream?.cancel().catch(() => {});
              return createStream(["<html>page</html>"]);
            },
          }),
          revalidateSeconds: 60,
          searchParams: new URLSearchParams({ q }),
          setNavigationContext(nextNavigationContext) {
            navigationContext = nextNavigationContext;
          },
        });

        const response = await runWithExecutionContext(context, () => dispatchAppPage(options));
        expect(response.headers.get("x-vinext-cache")).not.toBe("HIT");
        await response.text();
        await Promise.all(waitUntilPromises);
      }

      expect(pageQueries, `isRscRequest: ${isRscRequest}`).toEqual(["1", "2"]);
      expect(renders).toEqual(
        isRscRequest
          ? []
          : [
              { isCacheCandidate: false, q: "1" },
              { isCacheCandidate: false, q: "2" },
            ],
      );
    }
    expect(isrGet).not.toHaveBeenCalled();
    expect(isrSet).not.toHaveBeenCalled();
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
    expect(pageExecutions).toBe(1);

    const withQuery = await request(new URLSearchParams({ q: "hello" }));
    expect(withQuery.response.headers.get("x-vinext-cache")).not.toBe("HIT");
    expect(withQuery.text).toBe("<html>hello</html>");
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

      async function request(searchParams: URLSearchParams): Promise<Response> {
        const { options } = createDispatchOptions({
          buildPageElement,
          cleanPathname: "/head-proof",
          isProduction: true,
          isrGet,
          isrSet,
          loadSsrHandler,
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

  it("keeps metadata dynamic usage from the render after a layout probe", async () => {
    // generateMetadata() runs inside the render, after the layout probe's
    // isolated dynamic scope has closed, so its searchParams read reaches the
    // render's own dynamic usage.
    let metadataStarted = false;
    let metadataStartedDuringProbe: boolean | undefined;
    const layoutModule = {
      default: ({ children }: { children?: React.ReactNode }) => children ?? null,
    };
    const pageModule = {
      default: () => React.createElement("h1", null, "metadata body"),
      async generateMetadata(props: { searchParams: Promise<Record<string, unknown>> }) {
        metadataStarted = true;
        await props.searchParams;
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
        metadataStartedDuringProbe = metadataStarted;
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

    expect(metadataStartedDuringProbe).toBe(false);
    expect(metadataStarted).toBe(true);
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
    const { options } = createDispatchOptions({
      isProduction: true,
      isrGet,
      revalidateSeconds: 60,
      searchParams: new URLSearchParams("search=hello"),
    });

    const response = await dispatchAppPage(options);

    expect(isrGet).toHaveBeenCalled();
    expect(response.headers.get("x-vinext-cache")).toBe("HIT");
    await expect(response.text()).resolves.toBe("<html>cached static page</html>");
  });

  it("serves force-static pages from the cache when the request has a query", async () => {
    const isrGet = vi.fn(async () =>
      buildISRCacheEntry(buildCachedAppPageValue("<html>cached force static</html>")),
    );
    const { options } = createDispatchOptions({
      dynamicConfig: "force-static",
      isProduction: true,
      isrGet,
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
    expect(resolveRouteStaticEligible).toHaveBeenCalledWith(sourceRoute);
    expect(response.headers.get("cache-control")).toBe(
      "private, no-cache, no-store, max-age=0, must-revalidate",
    );
    // Dev keeps its no-store header.
    const devResponse = await dispatchAppPage({ ...options, isProduction: false });
    expect(devResponse.headers.get("cache-control")).toBe("no-store, must-revalidate");
    await devResponse.text();
  });

  // The intercepted response renders the source route, so the source's own
  // config decides whether it may be stored, and so where its metadata goes.
  it.each<{
    name: string;
    dynamicConfig?: "force-dynamic";
    revalidate: number | null;
    staticEligible: boolean;
    placeStreamedMetadataInHead: boolean;
  }>([
    {
      name: "a static source",
      revalidate: null,
      staticEligible: true,
      placeStreamedMetadataInHead: true,
    },
    {
      name: "a force-dynamic source",
      dynamicConfig: "force-dynamic",
      revalidate: null,
      staticEligible: true,
      placeStreamedMetadataInHead: false,
    },
    {
      name: "a revalidate = 0 source",
      revalidate: 0,
      staticEligible: true,
      placeStreamedMetadataInHead: false,
    },
    {
      name: "a source that can't be static",
      revalidate: null,
      staticEligible: false,
      placeStreamedMetadataInHead: false,
    },
  ])(
    "builds the intercepted RSC of $name with placeStreamedMetadataInHead $placeStreamedMetadataInHead",
    async ({ dynamicConfig, revalidate, staticEligible, placeStreamedMetadataInHead }) => {
      const sourceRoute = createRoute({ params: [], pattern: "/feed", routeSegments: ["feed"] });
      const currentRoute = createRoute({
        params: ["id"],
        pattern: "/photos/[id]",
        routeSegments: ["photos", "[id]"],
      });
      const buildPageElement = vi.fn<DispatchOptions["buildPageElement"]>(
        async (route) => route.pattern,
      );
      const { options } = createDispatchOptions({
        buildPageElement,
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
        resolveRouteDynamicConfig: (route) => (route === sourceRoute ? dynamicConfig : undefined),
        resolveRouteRevalidateSeconds: (route) => (route === sourceRoute ? revalidate : null),
        resolveRouteStaticEligible: (route) => route !== sourceRoute || staticEligible,
        route: currentRoute,
      });

      const response = await dispatchAppPage(options);

      await expect(response.text()).resolves.toBe("/feed");
      expect(buildPageElement.mock.calls[0]?.[5]).toMatchObject({ placeStreamedMetadataInHead });
    },
  );

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
    expect(resolveRouteFetchCacheMode).toHaveBeenCalledWith(sourceRoute);
    expect(resolveRouteRevalidateSeconds).toHaveBeenCalledWith(sourceRoute);
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
    expect(resolveRouteDynamicConfig).toHaveBeenCalledWith(sourceRoute);
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
        placeStreamedMetadataInHead: false,
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
    // A request without a user agent streams metadata.
    expect(capturedServeStreamingMetadata).toBe(true);
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

  it.each([
    {
      digest: "NEXT_HTTP_ERROR_FALLBACK;404",
      headers: undefined,
      htmlHeaders: { link: "</font.woff2>; rel=preload" },
      html: "<html>not found</html>",
      status: 404,
    },
    {
      digest: "NEXT_REDIRECT;replace;/target;307;",
      headers: { location: "/target" },
      htmlHeaders: { location: "/target" },
      html: "",
      status: 307,
    },
  ])(
    "stores a stale regeneration whose shell ended in a $status",
    async ({ digest, headers, htmlHeaders, html, status }) => {
      let scheduledRender: unknown = null;
      const isrSet = vi.fn<DispatchOptions["isrSet"]>(async () => {});
      const { options } = createDispatchOptions({
        isProduction: true,
        isrGet: vi.fn(async () =>
          buildISRCacheEntry(buildCachedAppPageValue("<html>stale</html>"), true),
        ),
        isrSet,
        loadSsrHandler: async () => ({
          async handleSsr(_rscStream, _navigationContext, _fontData, captureOptions) {
            if (captureOptions?.capturedRscDataRef && captureOptions.sideStream) {
              captureOptions.capturedRscDataRef.value = new Response(
                captureOptions.sideStream,
              ).arrayBuffer();
            }
            throw Object.assign(new Error(digest), { digest });
          },
        }),
        renderToReadableStream: () => createStream(["page-flight-with-digest"]),
        revalidateSeconds: 60,
        scheduleBackgroundRegeneration(_key, renderFn) {
          scheduledRender = renderFn;
        },
      });
      options.renderHttpAccessFallbackPage = vi.fn(async (statusCode: number) => {
        const link = "</font.woff2>; rel=preload";
        const fallback = new Response("<html>not found</html>", {
          headers: { link },
          status: statusCode,
        });
        markFrameworkLinkHeaders(fallback.headers, link);
        return fallback;
      });

      const response = await dispatchAppPage(options);
      await expect(response.text()).resolves.toBe("<html>stale</html>");
      if (typeof scheduledRender !== "function") {
        throw new Error("expected stale HTML response to schedule regeneration");
      }
      await scheduledRender();

      expect(
        isrSet.mock.calls.map(([key, value]) => ({
          headers: value.headers,
          html: value.html,
          key,
          rsc: value.rscData ? new TextDecoder().decode(value.rscData) : undefined,
          status: value.status,
        })),
      ).toEqual([
        { headers, html: "", key: "rsc:/posts/hello", rsc: "page-flight-with-digest", status },
        { headers: htmlHeaders, html, key: "html:/posts/hello", rsc: undefined, status },
      ]);
      if (status === 404) {
        // The stored document must not carry the request's query.
        expect(options.renderHttpAccessFallbackPage).toHaveBeenCalledWith(
          404,
          expect.objectContaining({ isCacheCandidate: true }),
          null,
        );
      }
    },
  );

  it("stores only the renderer's Link from a stale 404 regeneration when middleware also sets one", async () => {
    let scheduledRender: unknown = null;
    const isrSet = vi.fn<DispatchOptions["isrSet"]>(async () => {});
    const frameworkLink = "</font.woff2>; rel=preload";
    const { options } = createDispatchOptions({
      isProduction: true,
      isrGet: vi.fn(async () =>
        buildISRCacheEntry(buildCachedAppPageValue("<html>stale</html>"), true),
      ),
      isrSet,
      loadSsrHandler: async () => ({
        async handleSsr(_rscStream, _navigationContext, _fontData, captureOptions) {
          if (captureOptions?.capturedRscDataRef && captureOptions.sideStream) {
            captureOptions.capturedRscDataRef.value = new Response(
              captureOptions.sideStream,
            ).arrayBuffer();
          }
          const digest = "NEXT_HTTP_ERROR_FALLBACK;404";
          throw Object.assign(new Error(digest), { digest });
        },
      }),
      middlewareContext: { headers: new Headers({ link: "</mw.css>; rel=preload" }), status: null },
      renderToReadableStream: () => createStream(["page-flight-with-digest"]),
      revalidateSeconds: 60,
      scheduleBackgroundRegeneration(_key, renderFn) {
        scheduledRender = renderFn;
      },
    });
    options.renderHttpAccessFallbackPage = vi.fn(async (statusCode: number) => {
      const fallback = new Response("<html>not found</html>", {
        headers: { link: frameworkLink },
        status: statusCode,
      });
      markFrameworkLinkHeaders(fallback.headers, frameworkLink);
      return fallback;
    });

    const response = await dispatchAppPage(options);
    await response.text();
    if (typeof scheduledRender !== "function") {
      throw new Error("expected stale HTML response to schedule regeneration");
    }
    await scheduledRender();

    expect(isrSet.mock.calls.map(([key, value]) => [key, value.headers])).toEqual([
      ["rsc:/posts/hello", undefined],
      ["html:/posts/hello", { link: frameworkLink }],
    ]);
  });

  it("does not store a regeneration whose page reads a dynamic API after its shell rejected", async () => {
    // A root layout's `<Suspense><Session /></Suspense>` reads cookies() after
    // the page's redirect() rejected the shell.
    let scheduledRender: unknown = null;
    let requestContextCleared = false;
    const isrSet = vi.fn<DispatchOptions["isrSet"]>(async () => {});
    const { options } = createDispatchOptions({
      clearRequestContext() {
        requestContextCleared = true;
      },
      isProduction: true,
      isrGet: vi.fn(async () =>
        buildISRCacheEntry(buildCachedAppPageValue("<html>stale</html>"), true),
      ),
      isrSet,
      loadSsrHandler: async () => ({
        async handleSsr(_rscStream, _navigationContext, _fontData, captureOptions) {
          if (captureOptions?.capturedRscDataRef && captureOptions.sideStream) {
            captureOptions.capturedRscDataRef.value = new Response(
              captureOptions.sideStream,
            ).arrayBuffer();
          }
          const digest = "NEXT_REDIRECT;replace;/target;307;";
          throw Object.assign(new Error(digest), { digest });
        },
      }),
      renderToReadableStream: () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("page-flight-with-digest"));
            setTimeout(() => {
              // Without a request context, cookies() rejects instead.
              if (!requestContextCleared) markDynamicUsage();
              controller.close();
            }, 5);
          },
        }),
      revalidateSeconds: 60,
      scheduleBackgroundRegeneration(_key, renderFn) {
        scheduledRender = renderFn;
      },
    });

    const response = await dispatchAppPage(options);
    await response.text();
    requestContextCleared = false;
    if (typeof scheduledRender !== "function") {
      throw new Error("expected stale HTML response to schedule regeneration");
    }

    await expect(scheduledRender()).rejects.toThrow(
      "Page changed from static to dynamic at runtime /posts/hello",
    );
    expect(isrSet.mock.calls.map(([, value]) => value.status)).not.toContain(307);
  });

  it("stores generateMetadata()'s special error that rejects a regeneration's shell with its status", async () => {
    // As in Next.js, a regeneration that an html-limited bot triggers blocks
    // on metadata, so the error rejects its shell, and it stores the 404.
    const metadataNotFoundDigest = "NEXT_HTTP_ERROR_FALLBACK;404";
    let scheduledRender: unknown = null;
    const isrSet = vi.fn<DispatchOptions["isrSet"]>(async () => {});
    const { options } = createDispatchOptions({
      isProduction: true,
      request: new Request("https://example.test/posts/hello", {
        headers: { "user-agent": "Mozilla/5.0 (compatible; Twitterbot/1.0)" },
      }),
      isrGet: vi.fn(async () =>
        buildISRCacheEntry(buildCachedAppPageValue("<html>stale</html>"), true),
      ),
      isrSet,
      loadSsrHandler: async () => ({
        async handleSsr(_rscStream, _navigationContext, _fontData, captureOptions) {
          if (captureOptions?.capturedRscDataRef && captureOptions.sideStream) {
            captureOptions.capturedRscDataRef.value = new Response(
              captureOptions.sideStream,
            ).arrayBuffer();
          }
          // SSR's copy of the error is decoded from its Flight digest,
          // without the server-side metadata marker.
          throw Object.assign(new Error(metadataNotFoundDigest), {
            digest: metadataNotFoundDigest,
          });
        },
      }),
      renderToReadableStream(_element, { onError }) {
        onError(
          Object.assign(new Error(metadataNotFoundDigest), {
            digest: metadataNotFoundDigest,
            [Symbol.for("vinext.appPage.metadataError")]: true,
          }),
          undefined,
          undefined,
        );
        return createStream(["page-flight-with-digest"]);
      },
      revalidateSeconds: 60,
      scheduleBackgroundRegeneration(_key, renderFn) {
        scheduledRender = renderFn;
      },
    });

    const response = await dispatchAppPage(options);
    await response.text();
    if (typeof scheduledRender !== "function") {
      throw new Error("expected stale HTML response to schedule regeneration");
    }

    await scheduledRender();
    expect(isrSet.mock.calls.map(([key, value]) => [key, value.status])).toContainEqual([
      expect.stringContaining("html:"),
      404,
    ]);
  });

  // An RSC regeneration writes only the RSC entry. Storing the bot's 404 there
  // would leave it beside the previous document, so it keeps the entry.
  it("keeps the entry when generateMetadata()'s special error rejects an RSC regeneration's shell", async () => {
    const metadataNotFoundDigest = "NEXT_HTTP_ERROR_FALLBACK;404";
    let scheduledRender: unknown = null;
    const isrSet = vi.fn<DispatchOptions["isrSet"]>(async () => {});
    const { options } = createDispatchOptions({
      isProduction: true,
      isRscRequest: true,
      request: new Request("https://example.test/posts/hello", {
        headers: { "user-agent": "Mozilla/5.0 (compatible; Twitterbot/1.0)" },
      }),
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
      isrSet,
      loadSsrHandler: async () => ({
        async handleSsr(_rscStream, _navigationContext, _fontData, captureOptions) {
          if (captureOptions?.capturedRscDataRef && captureOptions.sideStream) {
            captureOptions.capturedRscDataRef.value = new Response(
              captureOptions.sideStream,
            ).arrayBuffer();
          }
          throw Object.assign(new Error(metadataNotFoundDigest), {
            digest: metadataNotFoundDigest,
          });
        },
      }),
      renderToReadableStream(_element, { onError }) {
        onError(
          Object.assign(new Error(metadataNotFoundDigest), {
            digest: metadataNotFoundDigest,
            [Symbol.for("vinext.appPage.metadataError")]: true,
          }),
          undefined,
          undefined,
        );
        return createStream(["page-flight-with-digest"]);
      },
      revalidateSeconds: 60,
      scheduleBackgroundRegeneration(_key, renderFn) {
        scheduledRender = renderFn;
      },
    });

    const response = await dispatchAppPage(options);
    await response.text();
    if (typeof scheduledRender !== "function") {
      throw new Error("expected the stale entry to schedule regeneration");
    }
    // The regeneration fails, as one whose shell another error rejected does.
    await expect(scheduledRender()).rejects.toMatchObject({ digest: metadataNotFoundDigest });
    expect(isrSet).not.toHaveBeenCalled();
  });

  // As in Next.js, a regeneration streams metadata as the request that
  // triggered it does, so generateMetadata()'s special error rejects its
  // shell only for an html-limited bot.
  it.each([
    { serveStreamingMetadata: true, userAgent: "Mozilla/5.0" },
    { serveStreamingMetadata: false, userAgent: "Mozilla/5.0 (compatible; Twitterbot/1.0)" },
  ])(
    "builds a regeneration that $userAgent triggers with serveStreamingMetadata $serveStreamingMetadata",
    async ({ serveStreamingMetadata, userAgent }) => {
      let scheduledRender: unknown = null;
      const buildPageElement = vi.fn<DispatchOptions["buildPageElement"]>(async () =>
        React.createElement("main", null, "page"),
      );
      const { options } = createDispatchOptions({
        buildPageElement,
        isProduction: true,
        isrGet: vi.fn(async () =>
          buildISRCacheEntry(buildCachedAppPageValue("<html>stale</html>"), true),
        ),
        loadSsrHandler: async () => ({
          async handleSsr(_rscStream, _navigationContext, _fontData, captureOptions) {
            if (captureOptions?.capturedRscDataRef && captureOptions.sideStream) {
              captureOptions.capturedRscDataRef.value = new Response(
                captureOptions.sideStream,
              ).arrayBuffer();
            }
            return createStream(["<html>fresh</html>"]);
          },
        }),
        request: new Request("https://example.test/posts/hello", {
          headers: { "user-agent": userAgent },
        }),
        revalidateSeconds: 60,
        scheduleBackgroundRegeneration(_key, renderFn) {
          scheduledRender = renderFn;
        },
      });

      const response = await dispatchAppPage(options);
      await response.text();
      if (typeof scheduledRender !== "function") {
        throw new Error("expected stale HTML response to schedule regeneration");
      }
      buildPageElement.mockClear();
      await scheduledRender();

      // Its document is rendered whole, so the metadata waits in <head>.
      expect(buildPageElement.mock.calls[0]?.[5]).toMatchObject({
        placeStreamedMetadataInHead: true,
        serveStreamingMetadata,
      });
    },
  );

  // Next.js renders a page it may store whole before serving it, so the page's
  // streamed metadata is ready for <head>. Other pages stream it into <body>.
  it.each([
    { name: "a cache candidate", overrides: {}, placeStreamedMetadataInHead: true },
    {
      name: "a force-dynamic page",
      overrides: { dynamicConfig: "force-dynamic" },
      placeStreamedMetadataInHead: false,
    },
    {
      name: "a dev render",
      overrides: { isProduction: false },
      placeStreamedMetadataInHead: false,
    },
    {
      // Never read from or written to the cache.
      name: "a mounted-slot RSC request",
      overrides: { isRscRequest: true, mountedSlotsHeader: "slot:modal:/" },
      placeStreamedMetadataInHead: false,
    },
  ] as const)(
    "builds $name with placeStreamedMetadataInHead $placeStreamedMetadataInHead",
    async ({ overrides, placeStreamedMetadataInHead }) => {
      const buildPageElement = vi.fn<DispatchOptions["buildPageElement"]>(async () =>
        React.createElement("main", null, "page"),
      );
      const { options } = createDispatchOptions({
        buildPageElement,
        isProduction: true,
        loadSsrHandler: async () => ({
          async handleSsr(_rscStream, _navigationContext, _fontData, captureOptions) {
            if (captureOptions?.capturedRscDataRef && captureOptions.sideStream) {
              captureOptions.capturedRscDataRef.value = new Response(
                captureOptions.sideStream,
              ).arrayBuffer();
            }
            return createStream(["<html>page</html>"]);
          },
        }),
        revalidateSeconds: 60,
        ...overrides,
      });

      const response = await dispatchAppPage(options);
      await response.text();

      expect(buildPageElement.mock.calls[0]?.[5]).toMatchObject({
        placeStreamedMetadataInHead,
        serveStreamingMetadata: true,
      });
    },
  );

  it("stores an intercepted RSC regeneration whose shell ended in a 404", async () => {
    const sourceRoute = createRoute({ params: [], pattern: "/feed", routeSegments: ["feed"] });
    const currentRoute = createRoute({
      params: ["id"],
      pattern: "/photos/[id]",
      routeSegments: ["photos", "[id]"],
    });
    let scheduledRender: unknown = null;
    const isrSet = vi.fn<DispatchOptions["isrSet"]>(async () => {});
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
      isrSet,
      loadSsrHandler: async () => ({
        async handleSsr(_rscStream, _navigationContext, _fontData, captureOptions) {
          if (captureOptions?.capturedRscDataRef && captureOptions.sideStream) {
            captureOptions.capturedRscDataRef.value = new Response(
              captureOptions.sideStream,
            ).arrayBuffer();
          }
          const digest = "NEXT_HTTP_ERROR_FALLBACK;404";
          throw Object.assign(new Error(digest), { digest });
        },
      }),
      renderToReadableStream: () => createStream(["modal-flight-with-digest"]),
      resolveRouteRevalidateSeconds: (route) => (route === sourceRoute ? 60 : null),
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
    await scheduledRender();

    expect(
      isrSet.mock.calls.map(([, value]) => ({
        rsc: value.rscData ? new TextDecoder().decode(value.rscData) : undefined,
        status: value.status,
      })),
    ).toEqual([{ rsc: "modal-flight-with-digest", status: 404 }]);
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

// The plan's canary and classification tests at the dispatch level. SSR runs
// through the production handleSsr, candidate useSearchParams() gate included.
// A stand-in Flight render serializes the whole page payload, awaiting every
// thenable as Flight does, so a query that reached either output shows in the
// stored bytes. The stand-in Flight client hands SSR the payload it rendered.
describe("query-free App page ISR entries", () => {
  const ROUTE_ID = "route:/posts/[slug]";
  let productionHandleSsr: typeof import("../packages/vinext/src/server/app-ssr-entry.js").handleSsr;

  beforeAll(async () => {
    // handleSsr reads plugin-rsc's build-time `import.meta.viteRsc`, which
    // only the RSC plugin's transform provides. Vitest's import.meta is a
    // plain object, so give it an empty bootstrap for this block.
    Object.defineProperty(Object.prototype, "viteRsc", {
      configurable: true,
      value: { loadBootstrapScriptContent: async () => "" },
    });
    ({ handleSsr: productionHandleSsr } =
      await import("../packages/vinext/src/server/app-ssr-entry.js"));
  });

  afterAll(() => {
    Reflect.deleteProperty(Object.prototype, "viteRsc");
  });

  function SearchValue(): React.ReactNode {
    return React.createElement("p", null, `search:${useSearchParams().toString()}`);
  }

  // A static page whose client component reads useSearchParams() inside Suspense.
  function suspenseSearchPage(): React.ReactElement {
    return React.createElement(
      "main",
      null,
      React.createElement(
        React.Suspense,
        { fallback: React.createElement("p", null, "search-fallback") },
        React.createElement(SearchValue),
      ),
    );
  }

  function suspenseSearchPayload(): Readonly<Record<string, React.ReactNode>> {
    return toDispatchElementRecord({
      ...AppElementsWire.createMetadataEntries({
        interceptionContext: null,
        layoutIds: [],
        rootLayoutTreePath: null,
        routeId: ROUTE_ID,
      }),
      [ROUTE_ID]: suspenseSearchPage(),
    });
  }

  // Flight awaits a promise and sends its value, so a thenable's resolved
  // value and its own enumerable properties are both serialized.
  async function serializeFlightValue(value: unknown, seen: WeakSet<object>): Promise<unknown> {
    if (typeof value === "function") return `fn:${value.name}`;
    if (typeof value === "symbol" || typeof value === "bigint") return String(value);
    if (value === null || typeof value !== "object") return value;
    if (seen.has(value)) return "[seen]";
    seen.add(value);
    if (React.isValidElement(value)) {
      return {
        props: await serializeFlightValue(value.props, seen),
        type: await serializeFlightValue(value.type, seen),
      };
    }
    if (Array.isArray(value)) {
      return Promise.all(value.map((item) => serializeFlightValue(item, seen)));
    }
    const record = Object.fromEntries(
      await Promise.all(
        Object.keys(value).map(async (key) => [
          key,
          await serializeFlightValue(Reflect.get(value, key), seen),
        ]),
      ),
    );
    if (isPromiseLike(value)) {
      return { resolved: await serializeFlightValue(await value, seen), thenable: record };
    }
    return record;
  }

  function serializePayloadToStream(payload: unknown): ReadableStream<Uint8Array> {
    ssrFlight.payload = payload;
    return new ReadableStream({
      async start(controller) {
        const json = JSON.stringify(await serializeFlightValue(payload, new WeakSet()));
        controller.enqueue(new TextEncoder().encode(json));
        controller.close();
      },
    });
  }

  function createProductionSsrHandler(
    renders: (boolean | undefined)[],
  ): DispatchOptions["loadSsrHandler"] {
    return async () => ({
      handleSsr(rscStream, navigationContext, fontData, ssrOptions) {
        renders.push(ssrOptions?.isCacheCandidate);
        return productionHandleSsr(
          rscStream,
          navigationContext as NavigationContext,
          { ...fontData, preloads: [...fontData.preloads] },
          ssrOptions,
        );
      },
    });
  }

  function createCache() {
    const cache = new Map<string, ISRCacheEntry>();
    const isrGet = vi.fn<DispatchOptions["isrGet"]>(async (key) => cache.get(key) ?? null);
    const isrSet = vi.fn<DispatchOptions["isrSet"]>(async (key, data, policy) => {
      cache.set(key, {
        isStale: false,
        value: { cacheControl: policy.cacheControl, lastModified: Date.now(), value: data },
      });
    });
    return { cache, isrGet, isrSet };
  }

  // Dispatches one production request and waits for its cache writes.
  async function dispatchQuery(
    search: string,
    overrides: CreateDispatchOptionsOverrides,
    executionContext: ExecutionContextLike = { waitUntil() {} },
    onResponse?: () => void,
  ) {
    const waitUntilPromises: Promise<unknown>[] = [];
    Reflect.set(executionContext, "waitUntil", (promise: Promise<unknown>) => {
      waitUntilPromises.push(promise);
    });
    let navigationContext: ReturnType<DispatchOptions["getNavigationContext"]> = null;
    const { options } = createDispatchOptions({
      buildPageElement: async () => suspenseSearchPayload(),
      // A scanned /posts/[slug] route is dynamic, so it's a cache candidate
      // only through generateStaticParams.
      generateStaticParams: async () => [{ slug: "hello" }],
      getNavigationContext: () => navigationContext,
      isProduction: true,
      renderToReadableStream: serializePayloadToStream,
      // The request targets the pathname being dispatched, so a literal-route
      // override gets a matching request.
      request: new Request(
        `https://example.test${overrides.cleanPathname ?? "/posts/hello"}${search}`,
      ),
      route: createRoute({ isDynamic: true, params: ["slug"] }),
      searchParams: new URLSearchParams(search),
      setNavigationContext(next) {
        navigationContext = next;
      },
      ...overrides,
    });
    const response = await runWithRequestContext(
      createRequestContext({
        executionContext,
        headersContext: headersContextFromRequest(options.request),
      }),
      () => runWithExecutionContext(executionContext, () => dispatchAppPage(options)),
    );
    onResponse?.();
    const body = await response.text();
    await Promise.all(waitUntilPromises.splice(0));
    return { body, response };
  }

  function expectEntryFreeOf(entry: ISRCacheEntry | undefined, canary: string): void {
    const value = entry?.value.value;
    if (!isCachedAppPageValue(value)) throw new Error("Expected an APP_PAGE cache entry");
    const rscText = value.rscData ? new TextDecoder().decode(value.rscData) : "";
    expect(value.html + rscText).not.toBe("");
    expect(value.html).not.toContain(canary);
    expect(rscText).not.toContain(canary);
    expect(JSON.stringify(value.headers ?? {})).not.toContain(canary);
  }

  // A client component's notFound() rejects the shell during SSR itself.
  // generateMetadata() threw the same digest in the RSC render, but runs only
  // there, so the shell's 404 is the page's and is stored, as in Next.js.
  it("stores a client component's SSR notFound() when generateMetadata() also threw a 404", async () => {
    const { cache, isrGet, isrSet } = createCache();
    const digest = "NEXT_HTTP_ERROR_FALLBACK;404";
    function ClientNotFound(): React.ReactNode {
      notFound();
    }

    const { response } = await dispatchQuery("", {
      buildPageElement: async () =>
        toDispatchElementRecord({
          ...AppElementsWire.createMetadataEntries({
            interceptionContext: null,
            layoutIds: [],
            rootLayoutTreePath: null,
            routeId: ROUTE_ID,
          }),
          [ROUTE_ID]: React.createElement("main", null, React.createElement(ClientNotFound)),
        }),
      isrGet,
      isrSet,
      loadSsrHandler: createProductionSsrHandler([]),
      renderToReadableStream(payload, { onError }) {
        onError(
          Object.assign(new Error(digest), {
            digest,
            [Symbol.for("vinext.appPage.metadataError")]: true,
          }),
          undefined,
          undefined,
        );
        return serializePayloadToStream(payload);
      },
    });

    expect(response.status).toBe(404);
    const stored = cache.get("html:/posts/hello")?.value.value as CachedAppPageValue | undefined;
    expect(stored?.status).toBe(404);
  });

  // Ported from Next.js app-static.test.ts:4622-4700 and the plan's canary
  // test: useSearchParams() inside Suspense keeps the page cached with the
  // fallback, and the stored entry never carries the query.
  it("keeps a canary query out of a static Suspense useSearchParams() page's HTML and RSC entries", async () => {
    const canary = crypto.randomUUID();
    const { cache, isrGet, isrSet } = createCache();
    const renders: (boolean | undefined)[] = [];
    const overrides = { isrGet, isrSet, loadSsrHandler: createProductionSsrHandler(renders) };

    const miss = await dispatchQuery(`?canary=${canary}`, overrides);

    expect(renders).toEqual([true]);
    expect(miss.response.headers.get("x-vinext-cache")).toBe("MISS");
    expect(miss.body).toContain("<p>search-fallback</p>");
    expect(miss.body).not.toContain(canary);
    expect([...cache.keys()].sort()).toEqual(["html:/posts/hello", "rsc:/posts/hello"]);
    expectEntryFreeOf(cache.get("html:/posts/hello"), canary);
    expectEntryFreeOf(cache.get("rsc:/posts/hello"), canary);

    const stored = cache.get("html:/posts/hello")!.value.value as CachedAppPageValue;
    const storedRsc = new TextDecoder().decode(
      (cache.get("rsc:/posts/hello")!.value.value as CachedAppPageValue).rscData,
    );
    for (const search of ["", "?other=1"]) {
      const html = await dispatchQuery(search, overrides);
      expect(html.response.headers.get("x-vinext-cache"), search).toBe("HIT");
      expect(html.body, search).toBe(stored.html);
      const rsc = await dispatchQuery(search, { ...overrides, isRscRequest: true });
      expect(rsc.response.headers.get("x-vinext-cache"), search).toBe("HIT");
      expect(rsc.body, search).toBe(storedRsc);
    }
    expect(renders).toEqual([true]);
    expect(isrSet).toHaveBeenCalledTimes(2);
  });

  // A client page that reads searchParams, built by the production element
  // builder from the query the dispatcher hands it. An RSC-only render never
  // runs SSR, so the builder is the only route for the query into the payload.
  const ClientSearchPage = Object.assign(
    function ClientSearchPage(props: Record<string, unknown>) {
      const searchParams = props.searchParams as Promise<Record<string, string>>;
      return React.createElement("p", null, `search:${JSON.stringify(React.use(searchParams))}`);
    },
    { $$typeof: Symbol.for("react.client.reference") },
  );

  const clientSearchPageOverrides = {
    buildPageElement: ((_route, params, _opts, searchParams, layoutParamAccess, buildOptions) =>
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
          request: new Request(`https://example.test/client?${searchParams}`),
          searchParams,
        },
        route: {
          layouts: [],
          page: { default: ClientSearchPage },
          pattern: "/client",
          routeSegments: ["client"],
        },
        routePath: "/client",
      }).then(toDispatchElementRecord)) satisfies DispatchOptions["buildPageElement"],
    cleanPathname: "/client",
    // A literal page without generateStaticParams, as the fixture exports none.
    generateStaticParams: null,
    // A literal route has no params.
    params: {},
    route: createRoute({ pattern: "/client", routeSegments: ["client"] }),
  };

  it("keeps a canary query out of an RSC-only miss's entry and serves it to every query", async () => {
    const canary = crypto.randomUUID();
    const { cache, isrGet, isrSet } = createCache();
    const overrides = { ...clientSearchPageOverrides, isRscRequest: true, isrGet, isrSet };

    const miss = await dispatchQuery(`?canary=${canary}`, overrides);

    // A query-bearing RSC miss keeps its cache state provisional.
    expect(miss.response.headers.get("x-vinext-cache")).toBeNull();
    expect(miss.body).toContain("ClientPageRoot");
    expect(miss.body).not.toContain(canary);
    expect([...cache.keys()]).toEqual(["rsc:/client"]);
    expectEntryFreeOf(cache.get("rsc:/client"), canary);
    for (const search of ["", "?other=1"]) {
      const hit = await dispatchQuery(search, overrides);
      expect(hit.response.headers.get("x-vinext-cache"), search).toBe("HIT");
      expect(hit.body, search).toBe(miss.body);
    }
    expect(isrSet).toHaveBeenCalledTimes(1);
  });

  // An RSC-only miss resolves its status by rendering the document's shell
  // from the completed payload. The payload can complete after the response
  // has left and the request's context is cleared, so the shell pass must
  // carry its own navigation context.
  it.each([
    { name: "a notFound() that rejects the shell with its status", status: 404, suspense: false },
    { name: "a notFound() inside Suspense as a 200", status: 200, suspense: true },
  ])("stores $name after the request context is cleared", async ({ status, suspense }) => {
    const { cache, isrGet, isrSet } = createCache();
    let navigation: NavigationContext | null = null;
    let cleared = false;
    const shellRenders: { cleared: boolean; pathname: string }[] = [];
    function NotFoundPage(): React.ReactNode {
      shellRenders.push({ cleared, pathname: usePathname() });
      notFound();
    }
    const page = React.createElement(NotFoundPage);
    let releasePayload!: () => void;
    const payloadReleased = new Promise<void>((resolve) => {
      releasePayload = resolve;
    });

    const { body, response } = await dispatchQuery(
      "",
      {
        buildPageElement: async () =>
          toDispatchElementRecord({
            ...AppElementsWire.createMetadataEntries({
              interceptionContext: null,
              layoutIds: [],
              rootLayoutTreePath: null,
              routeId: ROUTE_ID,
            }),
            [ROUTE_ID]: suspense
              ? React.createElement(
                  React.Suspense,
                  { fallback: React.createElement("p", null, "loading") },
                  page,
                )
              : page,
          }),
        clearRequestContext() {
          setHeadersContext(null);
          navigation = null;
        },
        getNavigationContext: () => navigation,
        isRscRequest: true,
        isrGet,
        isrSet,
        loadSsrHandler: createProductionSsrHandler([]),
        renderToReadableStream(payload, { onError }) {
          // The stand-in Flight render doesn't run components, so report the
          // page's notFound() as Flight would.
          try {
            notFound();
          } catch (error) {
            onError(error, undefined, undefined);
          }
          return serializePayloadToStream(payload).pipeThrough(
            new TransformStream<Uint8Array, Uint8Array>({ flush: () => payloadReleased }),
          );
        },
        setNavigationContext(next) {
          navigation = next;
        },
      },
      undefined,
      () => {
        // The response has left: clear the request's context before the
        // payload completes.
        setHeadersContext(null);
        navigation = null;
        cleared = true;
        releasePayload();
      },
    );

    expect(response.status).toBe(200);
    expect(body).not.toBe("");
    // React renders a Suspense boundary's failed content again before
    // falling back to the client.
    expect(shellRenders.length).toBeGreaterThan(0);
    expect(shellRenders).toEqual(
      shellRenders.map(() => ({ cleared: true, pathname: "/posts/hello" })),
    );
    expect([...cache.keys()]).toEqual(["rsc:/posts/hello"]);
    const stored = cache.get("rsc:/posts/hello")!.value.value as CachedAppPageValue;
    expect(stored.status).toBe(status);
    expect(new TextDecoder().decode(stored.rscData)).toBe(body);
  });

  // A dynamic-segment route without generateStaticParams is ƒ: it renders
  // per request, so useSearchParams() inside Suspense server-renders the real
  // query, and nothing is stored.
  it("renders real useSearchParams() values inside Suspense on a route that isn't static", async () => {
    const { isrGet, isrSet } = createCache();
    const renders: (boolean | undefined)[] = [];
    for (const revalidateSeconds of [null, 60]) {
      // A dynamic route without generateStaticParams isn't static or SSG.
      const { body, response } = await dispatchQuery("?q=secret", {
        generateStaticParams: null,
        isrGet,
        isrSet,
        loadSsrHandler: createProductionSsrHandler(renders),
        revalidateSeconds,
      });

      expect(body).toContain("search:q=secret");
      expect(body).not.toContain("<p>search-fallback</p>");
      expect(response.headers.get("cache-control")).toBe(
        "private, no-cache, no-store, max-age=0, must-revalidate",
      );
    }
    expect(renders).toEqual([false, false]);
    expect(isrGet).not.toHaveBeenCalled();
    expect(isrSet).not.toHaveBeenCalled();
  });

  // Row 7a residual: an RSC-only render never runs SSR, so a client page's
  // use(searchParams) never runs and the render stays static. Core stores the
  // RSC entry, which carries no query. Next.js prerenders the HTML first and
  // marks such a page dynamic.
  it("stores a query-free RSC entry for an RSC-only request to a client page that reads searchParams (row 7a residual)", async () => {
    const { cache, isrGet, isrSet } = createCache();

    const { body } = await dispatchQuery("?q=secret", {
      ...clientSearchPageOverrides,
      isRscRequest: true,
      isrGet,
      isrSet,
    });

    expect(body).toContain("ClientPageRoot");
    expect(body).not.toContain("secret");
    expect([...cache.keys()]).toEqual(["rsc:/client"]);
    expectEntryFreeOf(cache.get("rsc:/client"), "secret");
  });

  // A Workers Cache runtime-check path keeps candidate mode, and its dispatch
  // keeps the query, so each render sees the request's own query.
  it("renders a runtime-check Workers Cache path in candidate mode with the request's query", async () => {
    const manifest = parseCacheabilityManifest(
      JSON.stringify({
        buildId: "build-a",
        routes: {
          [cacheabilityManifestRouteKey("app-page", "/posts/[slug]")]: {
            kind: "app-page",
            pattern: "/posts/[slug]",
            runtimePaths: ["/posts/hello"],
            state: "runtime-check",
          },
        },
        version: 1,
      }),
      "build-a",
    );
    const renders: (boolean | undefined)[] = [];
    const pageQueries: (string | null)[] = [];
    for (const q of ["1", "2"]) {
      const context: ExecutionContextLike = { waitUntil() {} };
      const state: RouteCacheabilityState = {
        admission: {
          manifest,
          policy: "manifest",
          representation: "html",
          routePathname: "/posts/hello",
        },
        captureDeadlineAt: Date.now() + 10_000,
        mode: "admit",
      };
      Reflect.set(context, CACHEABILITY_REQUEST_STATE, state);
      await dispatchQuery(
        `?q=${q}`,
        {
          async buildPageElement(_route, _params, _opts, searchParams) {
            pageQueries.push(searchParams.get("q"));
            return suspenseSearchPayload();
          },
          loadSsrHandler: createProductionSsrHandler(renders),
          revalidateSeconds: 60,
        },
        context,
      );
    }

    expect(renders).toEqual([true, true]);
    expect(pageQueries).toEqual(["1", "2"]);
  });

  // A `[]` generateStaticParams route is SSG with the revalidate = false
  // default, so one HTML miss stores both representations, as Next.js does.
  it("writes rsc: alongside html: on an HTML miss of an empty generateStaticParams route", async () => {
    const { cache, isrGet, isrSet } = createCache();

    const { response } = await dispatchQuery("", {
      generateStaticParams: async () => [],
      isrGet,
      isrSet,
      loadSsrHandler: createProductionSsrHandler([]),
      route: createRoute({ isDynamic: true, params: ["slug"] }),
    });

    expect(response.headers.get("x-vinext-cache")).toBe("MISS");
    expect(
      Object.fromEntries(
        isrSet.mock.calls.map(([key, , policy]) => [key, policy.cacheControl.revalidate]),
      ),
    ).toEqual({ "html:/posts/hello": Infinity, "rsc:/posts/hello": Infinity });
    expect(cache.size).toBe(2);
  });

  // Next.js stores and sends min(route revalidate, cacheLife). A page with a
  // cacheLife of 60 s under the revalidate = false default, on a literal route
  // and on a `[]` generateStaticParams route (Next.js /uc-gsp).
  describe("with cacheLife({ revalidate: 60 })", () => {
    const routes = [
      [
        "a literal route",
        "/about",
        {
          cleanPathname: "/about",
          generateStaticParams: null,
          params: {},
          route: createRoute({ pattern: "/about", routeSegments: ["about"] }),
        },
      ],
      [
        "an empty generateStaticParams route",
        "/posts/hello",
        {
          generateStaticParams: async () => [],
          route: createRoute({ isDynamic: true, params: ["slug"] }),
        },
      ],
    ] as const;

    // Page code runs while Flight renders, so this stand-in calls cacheLife()
    // after the RSC stream's first chunk, once dispatch has returned the
    // response's headers, in the render's request context.
    function createDeferredCacheLifeRender() {
      const events: string[] = [];
      let resolveHeaders!: () => void;
      const headersSent = new Promise<void>((resolve) => {
        resolveHeaders = resolve;
      });
      const renderToReadableStream: DispatchOptions["renderToReadableStream"] = (payload) => {
        ssrFlight.payload = payload;
        events.push("stream");
        return new ReadableStream({
          async start(controller) {
            const json = JSON.stringify(await serializeFlightValue(payload, new WeakSet()));
            controller.enqueue(new TextEncoder().encode(json));
            await headersSent;
            cacheLife({ revalidate: 60 });
            events.push("cacheLife");
            controller.close();
          },
        });
      };
      return {
        events,
        onResponse: () => {
          events.push("headers");
          resolveHeaders();
        },
        overrides: {
          buildPageElement: async () => suspenseSearchPayload(),
          renderToReadableStream,
        },
      };
    }

    for (const [label, pathname, routeOverrides] of routes) {
      it(`sends s-maxage=60 on a core HIT (${label})`, async () => {
        const { isrGet, isrSet } = createCache();
        const render = createDeferredCacheLifeRender();
        const overrides = {
          ...routeOverrides,
          ...render.overrides,
          isrGet,
          isrSet,
          loadSsrHandler: createProductionSsrHandler([]),
        };
        const request = () => new Request(`https://example.test${pathname}`);

        await dispatchQuery("", { ...overrides, request: request() }, undefined, render.onResponse);
        expect(render.events).toEqual(["stream", "headers", "cacheLife"]);
        expect(
          Object.fromEntries(
            isrSet.mock.calls.map(([key, , policy]) => [key, policy.cacheControl.revalidate]),
          ),
        ).toEqual({ [`html:${pathname}`]: 60, [`rsc:${pathname}`]: 60 });

        for (const isRscRequest of [false, true]) {
          const hit = await dispatchQuery("", { ...overrides, isRscRequest, request: request() });
          expect(hit.response.headers.get("x-vinext-cache")).toBe("HIT");
          expect(hit.response.headers.get("cache-control")).toMatch(/^s-maxage=60(,|$)/);
        }
      });

      it(`sends Cloudflare-CDN-Cache-Control max-age=60 with browser max-age=0 from Workers Cache (${label})`, async () => {
        setCdnCacheAdapter(new CloudflareCdnCacheAdapter());
        try {
          for (const isRscRequest of [false, true]) {
            const request = new Request(`https://example.test${pathname}`, {
              headers: isRscRequest
                ? { Accept: "text/x-component", RSC: "1" }
                : { Accept: "text/html" },
            });
            const context = createWorkerCacheabilityAdmissionContext(
              { waitUntil() {} },
              request,
              null,
              "build-a",
              true,
              undefined,
              undefined,
              undefined,
              { applyCompletedResponsePolicy: true },
            );
            const render = createDeferredCacheLifeRender();
            let navigationContext: ReturnType<DispatchOptions["getNavigationContext"]> = null;
            const { options } = createDispatchOptions({
              ...routeOverrides,
              ...render.overrides,
              getNavigationContext: () => navigationContext,
              isProduction: true,
              isRscRequest,
              loadSsrHandler: createProductionSsrHandler([]),
              request,
              setNavigationContext(next) {
                navigationContext = next;
              },
            });
            const response = await runWithRequestContext(
              createRequestContext({
                executionContext: context,
                headersContext: headersContextFromRequest(request),
              }),
              async () => {
                const dispatched = await runWithExecutionContext(context, () =>
                  dispatchAppPage(options),
                );
                render.onResponse();
                return finalizeWorkerCacheabilityResponse(dispatched, context);
              },
            );
            await response.text();

            const representation = isRscRequest ? "RSC" : "HTML";
            expect(render.events, representation).toEqual(["stream", "headers", "cacheLife"]);
            expect(response.headers.get("cache-control"), representation).toBe(
              "private, max-age=0, must-revalidate",
            );
            expect(response.headers.get("cloudflare-cdn-cache-control"), representation).toMatch(
              /^public, max-age=60(,|$)/,
            );
          }
        } finally {
          setCdnCacheAdapter(new DefaultCdnCacheAdapter());
        }
      });
    }
  });
});
