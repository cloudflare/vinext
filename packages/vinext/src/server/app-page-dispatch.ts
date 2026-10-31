import { type ReactNode } from "react";
import type { ReactFormState } from "react-dom/client";
import type { NavigationContext } from "vinext/shims/navigation";
import { runInWorkStoreScope } from "vinext/shims/internal/work-store-scope";
import {
  _captureRequestScopedCacheLifeAccessors,
  _isOnDemandRevalidate,
} from "vinext/shims/cache-request-state";
import type { RootParams } from "vinext/shims/root-params";
import type { PprFallbackShellState } from "vinext/shims/ppr-fallback-shell";
import {
  consumeDynamicUsage,
  consumeInvalidDynamicUsageError,
  getAndClearPendingCookies,
  getDraftModeCookieHeader,
  getHeadersContext,
  isDraftModeRequest,
  peekDynamicUsage,
  peekRenderRequestApiUsage,
  runWithConnectionProbe,
  runWithDetachedDynamicUsage,
  setHeadersContext,
} from "vinext/shims/headers";
import { getRequestExecutionContext } from "vinext/shims/request-context";
import {
  closeAfterResponse,
  createRequestContext,
  runWithRequestContext,
} from "vinext/shims/unified-request-context";
import {
  ensureFetchPatch,
  type FetchCacheMode,
  getCollectedFetchTags,
  peekDynamicFetchObservations,
  runWithFetchDedupe,
  setCurrentFetchCacheMode,
  setCurrentFetchRevalidate,
  setCurrentForceDynamicFetchDefault,
  setCurrentFetchSoftTags,
  setRefreshStaleFetchesInForeground,
} from "vinext/shims/fetch-cache";
import type { AppOutgoingElements } from "./app-elements.js";
import type { AppPagePprFallbackCacheShell } from "./app-ppr-fallback-shell.js";
import type { WarmPprFallbackShellCachesOptions } from "./app-ppr-fallback-shell-render.js";
import {
  resolveAppPageLayoutHttpAccessBoundary,
  resolveAppPageRootHttpAccessBoundaryTreePosition,
  resolveAppPageParentHttpAccessBoundary,
} from "./app-page-boundary.js";
import { getDefaultHttpAccessFallbackModule } from "./default-http-access-fallback-modules.js";
import { isAppClientReference } from "./app-render-dependency.js";
import {
  resolveAppPageSpecialErrorStoredHeaders,
  buildAppPageSpecialErrorResponse,
  resolveAppPageCaughtNotFoundBoundaries,
  resolveAppPageShellSpecialError,
  resolveAppPageSpecialError,
  type AppPageFontPreload,
  type AppPageSpecialError,
} from "./app-page-execution.js";
import { buildRscRedirectFlightStream } from "./app-rsc-redirect-flight.js";
import { resolveAppPageMethodResponse } from "./app-page-method.js";
import { isAppPageStaticEligible } from "./app-segment-config.js";
import { resolveAppPageNavigationParams } from "./app-page-element-builder.js";
import type { AppPageFallbackRouteHead, AppPagePreparedRouteHead } from "./app-page-head.js";
import {
  buildAppPageElement,
  resolveAppPageInterceptionRerenderTarget,
  resolveAppPageIntercept,
  validateAppPageDynamicParams,
  type ValidateAppPageDynamicParamsOptions,
} from "./app-page-request.js";
import { applyIneligibleRouteCachePolicy, renderAppPageLifecycle } from "./app-page-render.js";
import {
  consumeAppPageRenderObservationState,
  discardAppPageRenderState,
} from "./app-page-render-observation.js";
import {
  mergeMiddlewareResponseHeaders,
  resolveUncacheableCacheControl,
  type AppPageMiddlewareContext,
} from "./app-page-response.js";
import {
  VINEXT_RSC_CONTENT_TYPE,
  VINEXT_RSC_VARY_HEADER,
  applyRscCompatibilityIdHeader,
  applyRscDeploymentIdHeader,
} from "./app-rsc-cache-busting.js";
import {
  APP_RSC_RENDER_MODE_PREFETCH_DYNAMIC_SHELL,
  APP_RSC_RENDER_MODE_NAVIGATION,
  type AppRscRenderMode,
} from "./app-rsc-render-mode.js";
import { shouldServeStreamingMetadata } from "./streaming-metadata.js";
import { createAppPageRscErrorTracker, type AppPageSsrHandler } from "./app-page-stream.js";
import {
  NEXT_ROUTER_PREFETCH_HEADER,
  VINEXT_INTERCEPTION_ID_HEADER,
  VINEXT_MOUNTED_LAYOUTS_HEADER,
  VINEXT_PRERENDER_SPECULATIVE_HEADER,
} from "./headers.js";
import { parseMountedLayoutsHeader } from "./app-mounted-layouts.js";
import { buildAppPageTags } from "./implicit-tags.js";
import { resolveAppPageTraceOperation } from "./app-page-tracing.js";
import {
  coalesceOnDemandResponse,
  type AppPageCacheSetter,
  type ISRCacheEntry,
} from "./isr-cache.js";
import {
  beginRouteCacheability,
  isRouteCacheabilityIdentityProbe,
  isRouteCacheabilityProbe,
  markRouteCacheabilityPatternDynamic,
  readRouteCacheabilityState,
} from "vinext/shims/cacheability-classification";
import {
  cacheabilityManifestPageState,
  type CacheabilityManifest,
  type CacheabilityRepresentation,
} from "./cacheability-manifest.js";
import type { AppRenderErrorContextOverrides } from "./app-rsc-error-handler.js";
import { traceResponseStart } from "./response-start-tracing.js";
import { getFrameworkLinkHeader } from "./app-response-header-provenance.js";

type AppPageParams = Record<string, string | string[]>;
type AppPageElement = ReactNode | Readonly<Record<string, ReactNode>>;
export type AppPageRenderableElement = ReactNode | AppOutgoingElements;
export type AppPageBoundaryOnError = (
  error: unknown,
  requestInfo: unknown,
  errorContext: unknown,
) => unknown;
type AppPageDebugLogger = (event: string, detail: string) => void;
type AppPageCacheGetter = (key: string) => Promise<ISRCacheEntry | null>;
type AppPageBackgroundRegenerationErrorContext = {
  routerKind: "App Router";
  routePath: string;
  routeType: "render";
  shouldReport?: (error: unknown) => boolean;
};
type AppPageBackgroundRegenerator = (
  key: string,
  renderFn: () => Promise<void>,
  errorContext?: AppPageBackgroundRegenerationErrorContext,
) => void;

type AppPageDispatchIntercept<TPage = unknown> = {
  interceptionId?: string | null;
  interceptionGraphId?: string | null;
  // Lazy-loaded layout modules: typed `unknown` because they arrive as
  // dynamically-imported modules (read sites cast to AppPageModule). Matches the
  // transport-level `interceptLayouts` on the route-matching/request types so an
  // intercept match flows through `toInterceptOptions` in both directions.
  interceptLayouts?: readonly unknown[] | null;
  interceptLayoutSegments?: readonly (readonly string[])[] | null;
  interceptBranchSegments?: readonly string[] | null;
  interceptLoadings?: readonly unknown[] | null;
  interceptLoadingTreePositions?: readonly number[] | null;
  interceptNotFoundBranchSegments?: readonly string[] | null;
  interceptNotFounds?: readonly unknown[] | null;
  interceptNotFoundTreePositions?: readonly number[] | null;
  notFound?: unknown;
  notFoundTreePosition?: number | null;
  interceptForbiddens?: readonly unknown[] | null;
  interceptForbiddenTreePositions?: readonly number[] | null;
  interceptUnauthorizeds?: readonly unknown[] | null;
  interceptUnauthorizedTreePositions?: readonly number[] | null;
  interceptErrors?: readonly unknown[] | null;
  interceptErrorTreePositions?: readonly number[] | null;
  matchedParams: AppPageParams;
  sourceMatchedParams?: AppPageParams;
  page: TPage;
  slotId?: string | null;
  slotKey: string;
  sourceRouteIndex: number;
  sourcePageSegments?: readonly string[] | null;
  targetPatternParts?: readonly string[];
  targetRouteGraphId?: string | null;
};

type AppPageDispatchInterceptOptions<TPage = unknown> = {
  interceptionId?: string | null;
  interceptGraphId?: string | null;
  interceptionContext: string | null;
  interceptLayouts?: readonly unknown[] | null;
  interceptLayoutSegments?: readonly (readonly string[])[] | null;
  interceptBranchSegments?: readonly string[] | null;
  interceptLoadings?: readonly unknown[] | null;
  interceptLoadingTreePositions?: readonly number[] | null;
  interceptNotFoundBranchSegments?: readonly string[] | null;
  interceptNotFound?: unknown;
  interceptNotFoundTreePosition?: number | null;
  interceptForbiddens?: readonly unknown[] | null;
  interceptForbiddenTreePositions?: readonly number[] | null;
  interceptUnauthorizeds?: readonly unknown[] | null;
  interceptUnauthorizedTreePositions?: readonly number[] | null;
  interceptErrors?: readonly unknown[] | null;
  interceptErrorTreePositions?: readonly number[] | null;
  interceptNotFounds?: readonly unknown[] | null;
  interceptNotFoundTreePositions?: readonly number[] | null;
  interceptPage: TPage;
  interceptParams: AppPageParams;
  interceptSlotId?: string | null;
  interceptSlotKey: string;
  interceptSourceMatchedUrl?: string | null;
  interceptSourcePageSegments?: readonly string[] | null;
  interceptTargetPatternParts?: readonly string[] | null;
  interceptTargetRouteGraphId?: string | null;
};

type AppPageModule = {
  default?: unknown;
  dynamic?: unknown;
  revalidate?: unknown;
};

type AppPageDispatchSlot = {
  default?: AppPageModule | null;
  loading?: AppPageModule | null;
  loadings?: readonly (AppPageModule | null | undefined)[] | null;
  page?: AppPageModule | null;
  slotPatternParts?: readonly string[] | null;
  slotParamNames?: readonly string[] | null;
};

export type AppPageDispatchRoute = {
  error?: AppPageModule | null;
  errors?: readonly (AppPageModule | null | undefined)[];
  forbidden?: AppPageModule | null;
  forbiddenTreePosition?: number | null;
  forbiddens?: readonly (AppPageModule | null | undefined)[];
  isDynamic: boolean;
  layouts: readonly AppPageModule[];
  layoutTreePositions?: readonly number[];
  loading?: AppPageModule | null;
  loadings?: readonly (AppPageModule | null | undefined)[];
  loadingTreePositions?: readonly number[];
  notFound?: AppPageModule | null;
  notFounds?: readonly (AppPageModule | null | undefined)[];
  params: readonly string[];
  pattern: string;
  routeSegments: readonly string[];
  segmentForbiddens?: readonly (AppPageModule | null | undefined)[];
  segmentForbiddenTreePositions?: readonly number[];
  segmentNotFounds?: readonly (AppPageModule | null | undefined)[];
  segmentNotFoundTreePositions?: readonly number[];
  segmentUnauthorizeds?: readonly (AppPageModule | null | undefined)[];
  segmentUnauthorizedTreePositions?: readonly number[];
  slots?: Readonly<Record<string, AppPageDispatchSlot>>;
  unauthorized?: AppPageModule | null;
  unauthorizedTreePosition?: number | null;
  unauthorizeds?: readonly (AppPageModule | null | undefined)[];
};

function getActiveLoadingTreePositions(route: AppPageDispatchRoute): number[] {
  const positions: number[] = [];
  for (const [index, loadingModule] of (route.loadings ?? []).entries()) {
    if (!loadingModule?.default) continue;
    const treePosition = route.loadingTreePositions?.[index];
    if (treePosition !== undefined) positions.push(treePosition);
  }

  // Older/eager route fixtures may only expose the leaf field. Keep that
  // representation working while the generated manifest carries both forms.
  if (positions.length === 0 && route.loading?.default) {
    positions.push(route.routeSegments.length);
  }
  return positions;
}

function getAppPageLayoutProbeCount(
  route: AppPageDispatchRoute,
  loadingTreePositions: readonly number[],
): number {
  const firstLoadingTreePosition = loadingTreePositions.reduce<number | null>(
    (first, position) => (first === null || position < first ? position : first),
    null,
  );
  if (firstLoadingTreePosition === null) return route.layouts.length;

  const firstSuspendedLayoutIndex = (route.layoutTreePositions ?? []).findIndex(
    (position) => position > firstLoadingTreePosition,
  );
  return firstSuspendedLayoutIndex === -1 ? route.layouts.length : firstSuspendedLayoutIndex;
}

function resolveAppPageRouteBoundaryModule(
  route: AppPageDispatchRoute,
  statusCode: number,
): AppPageModule | null {
  if (statusCode === 403) return route.forbidden ?? null;
  if (statusCode === 401) return route.unauthorized ?? null;
  if (statusCode === 404) return route.notFound ?? null;
  return null;
}

export type AppPagePprRuntime<TRoute extends AppPageDispatchRoute> = {
  beginFinalRender(state: AppPagePprState): void;
  getState(): AppPagePprState | null;
  run<T>(shell: NonNullable<DispatchAppPageOptions<TRoute>["pprFallbackShell"]>, fn: () => T): T;
  tryServe(
    options: DispatchAppPageOptions<TRoute>,
    currentRevalidateSeconds: number | null,
    isDraftMode: boolean,
    isForceStatic: boolean,
    isForceDynamic: boolean,
  ): Promise<Response | null>;
  warm(options: WarmPprFallbackShellCachesOptions): Promise<void>;
};

export type AppPagePprState = PprFallbackShellState;

export type DispatchAppPageOptions<TRoute extends AppPageDispatchRoute> = {
  /** Configured basePath (e.g. "/blog"). Used to prefix redirect Locations. */
  basePath?: string;
  /** Bypass shared RSC caches when the client-supplied interception context was not verified. */
  bypassInterceptionContextCache?: boolean;
  /**
   * Allow-list of OpenTelemetry propagation keys (from
   * `experimental.clientTraceMetadata`) to surface as `<meta>` tags in the
   * SSR head. Undefined or empty disables emission entirely.
   */
  clientTraceMetadata?: readonly string[];
  /**
   * Maximum total length (in characters) of the preload `Link` header emitted
   * during SSR. `0` disables emission. From `reactMaxHeadersLength` in
   * `next.config`. Undefined falls back to the React default downstream.
   */
  reactMaxHeadersLength?: number;
  buildPageElement: (
    route: TRoute,
    params: AppPageParams,
    opts: AppPageDispatchInterceptOptions | undefined,
    searchParams: URLSearchParams,
    options?: {
      isForceStatic?: boolean;
      isUncacheableRender?: boolean;
      /** Layouts the navigating client holds, which the render may leave out. */
      mountedLayouts?: ReadonlySet<string> | null;
      observeMetadataSearchParamsAccess?: boolean;
      observePageSearchParamsAccess?: boolean;
      serveStreamingMetadata?: boolean;
      placeStreamedMetadataInHead?: boolean;
      /** Receives the route's head once the render starts resolving it. */
      onHeadPrepared?: (head: AppPagePreparedRouteHead) => void;
    },
  ) => Promise<AppPageElement>;
  cleanPathname: string;
  displayPathname?: string;
  clearRequestContext: () => void;
  createRscOnErrorHandler: (
    pathname: string,
    routePath: string,
    overrides?: AppRenderErrorContextOverrides,
  ) => AppPageBoundaryOnError;
  draftModeSecret: string;
  dynamicConfig?: string;
  dynamicStaleTimeSeconds?: number;
  dynamicParamsConfig?: boolean;
  /**
   * Hydrate a source route's lazy page/route-handler modules before reading
   * `route.page` (e.g. for fetch-cache-mode resolution) on intercept and ISR
   * revalidation targets obtained via `getSourceRoute`. Idempotent.
   */
  ensureRouteLoaded?: (route: TRoute) => unknown;
  fetchCache?: FetchCacheMode | null;
  findIntercept: (pathname: string) => AppPageDispatchIntercept | null;
  formState?: ReactFormState | null;
  actionError?: unknown;
  actionFailed?: boolean;
  generateStaticParams?: ValidateAppPageDynamicParamsOptions["generateStaticParams"];
  getFontLinks: () => string[];
  getFontPreloads: () => AppPageFontPreload[];
  getFontStyles: () => string[];
  getNavigationContext: () => NavigationContext | null;
  getSourceRoute: (sourceRouteIndex: number) => TRoute | undefined;
  /**
   * Whether `generateStaticParams` is exported at or below the route's last
   * dynamic segment (`hasAppPageGenerateStaticParamsAtLastDynamicSegment`).
   */
  hasGenerateStaticParams: boolean;
  /** Whether any segment of the route exports `generateStaticParams`. */
  hasAnyGenerateStaticParams: boolean;
  hasCustomGlobalError?: boolean;
  hasPageDefaultExport: boolean;
  hasPageModule: boolean;
  handlerStart: number;
  htmlLimitedBots?: string;
  interceptionContext: string | null;
  isEdgeRuntime?: boolean;
  /**
   * Whether the route's loader tree resolves `runtime = "edge"` (or
   * `"experimental-edge"`), which disables static generation outside
   * `cacheComponents`. Every parallel branch merges at each node, as
   * in Next.js's Turbopack build (`collectAppPageStaticGenerationRuntimes`).
   */
  isStaticGenerationEdgeRuntime?: boolean;
  isProgressiveActionRender?: boolean;
  isProduction: boolean;
  isRscRequest: boolean;
  isrDebug?: AppPageDebugLogger;
  isrGet: AppPageCacheGetter;
  isrFallbackShellHtmlKey: (pathname: string) => string;
  isrHtmlKey: (pathname: string) => string;
  isrRscKey: (
    pathname: string,
    mountedSlotsHeader?: string | null,
    renderMode?: AppRscRenderMode,
    interceptionContext?: string | null,
    interceptionId?: string | null,
  ) => string;
  isrSet: AppPageCacheSetter;
  loadSsrHandler: () => Promise<AppPageSsrHandler>;
  middlewareContext: AppPageMiddlewareContext;
  mountedSlotsHeader?: string | null;
  params: AppPageParams;
  pprFallbackCacheShells?: readonly AppPagePprFallbackCacheShell[] | null;
  pprFallbackShell?: {
    fallbackParamNames: readonly string[];
    routePattern: string;
  };
  pprRuntime?: AppPagePprRuntime<TRoute>;
  /**
   * Set of concrete URL paths that were pre-rendered at build time for this
   * route. When the exact cache entry for a known pregenerated path is absent
   * (evicted, stale-empty, cold start, read error), the fallback shell must
   * NOT be served — the route is a valid generated route whose cache merely
   * has a transient gap. Falls through to a fresh render instead.
   */
  renderedConcreteUrlPaths?: ReadonlySet<string>;
  skipStaticParamsValidation?: boolean;
  staticParamsValidationParams?: AppPageParams;
  rootParams?: RootParams;
  probeLayoutAt: (layoutIndex: number) => unknown;
  expireSeconds?: number;
  renderErrorBoundaryPage: (
    error: unknown,
    errorOrigin?: "rsc" | "ssr",
    throwingLayoutIndex?: number,
  ) => Promise<Response | null>;
  renderHttpAccessFallbackPage: (
    statusCode: number,
    opts: {
      boundaryComponent?: unknown;
      boundaryModule?: AppPageModule | null;
      /** Boundary whose metadata the head uses, when not `boundaryModule`. */
      headBoundaryModule?: AppPageModule | null;
      /** Layouts whose metadata the head uses, when more than `layouts`. */
      headLayouts?: readonly AppPageModule[];
      intercept?: AppPageDispatchInterceptOptions | null;
      /** The document may be stored, so it must not carry the request's query. */
      isCacheCandidate?: boolean;
      layouts?: readonly AppPageModule[];
      matchedParams: AppPageParams;
      /** The route's render threw the signal, so the document keeps the route's head. */
      routeHead?: AppPageFallbackRouteHead;
    },
    middlewareContext: AppPageMiddlewareContext | null,
  ) => Promise<Response | null>;
  renderToReadableStream: (
    element: AppPageRenderableElement,
    options: { onError: AppPageBoundaryOnError; signal?: AbortSignal },
  ) => ReadableStream<Uint8Array>;
  prerenderToReadableStream?: (
    element: AppPageRenderableElement,
    options: { onError: AppPageBoundaryOnError; signal?: AbortSignal },
  ) => Promise<{ prelude: ReadableStream<Uint8Array> }>;
  request: Request;
  revalidateSeconds: number | null;
  renderedPathAndSearch?: string | null;
  resolveRouteFetchCacheMode?: (route: TRoute) => FetchCacheMode | null;
  resolveRouteRevalidateSeconds?: (route: TRoute) => number | null;
  resolveRouteDynamicConfig?: (route: TRoute) => string | null | undefined;
  /**
   * `isAppPageStaticEligible` for another route, from that route's own segment
   * config, `generateStaticParams`, dynamism and runtime. A direct intercepted
   * RSC response renders its source route, so it takes the source's
   * cacheability.
   */
  resolveRouteStaticEligible: (route: TRoute) => boolean;
  rootForbiddenModule?: AppPageModule | null;
  rootNotFoundModule?: AppPageModule | null;
  rootUnauthorizedModule?: AppPageModule | null;
  route: TRoute;
  runWithSuppressedHookWarning<T>(probe: () => Promise<T>): Promise<T>;
  scheduleBackgroundRegeneration: AppPageBackgroundRegenerator;
  scriptNonce?: string;
  searchParams: URLSearchParams;
  setNavigationContext: (context: {
    params: AppPageParams;
    pathname: string;
    searchParams: URLSearchParams;
  }) => void;
  renderMode?: AppRscRenderMode;
  /**
   * Render the document whole before its first byte, with streamed metadata in
   * `<head>`, as a background regeneration does. The adapter sets this for a
   * render no client is waiting on, such as its regeneration or a warm-up.
   */
  renderWholeDocument?: boolean;
};

export function shouldReadAppPageCache(options: {
  isProgressiveActionRender: boolean;
  isDraftMode: boolean;
  isForceDynamic: boolean;
  isProduction: boolean;
  isRscRequest: boolean;
  revalidateSeconds: number | null;
  scriptNonce?: string;
}): boolean {
  return (
    options.isProduction &&
    !options.isProgressiveActionRender &&
    !options.isDraftMode &&
    !options.isForceDynamic &&
    (options.isRscRequest || !options.scriptNonce) &&
    (options.revalidateSeconds === null || options.revalidateSeconds > 0)
  );
}

function resolveAppPageCacheReadRevalidateSeconds(options: {
  isDynamicError: boolean;
  isForceStatic: boolean;
  revalidateSeconds: number | null;
}): number {
  if (options.revalidateSeconds === null && (options.isForceStatic || options.isDynamicError)) {
    return Infinity;
  }

  // cacheLife-only routes discover their actual revalidate during the fresh
  // render; this seed only gets them into the cache read path.
  return options.revalidateSeconds ?? 0;
}

export function hasSearchParams(searchParams: URLSearchParams | null | undefined): boolean {
  return searchParams !== null && searchParams !== undefined && searchParams.size > 0;
}

async function runAppPageRevalidationContext<
  TResult extends {
    html: string;
    tags: string[];
  },
>(
  options: {
    cleanPathname: string;
    displayPathname?: string;
    currentFetchCacheMode?: FetchCacheMode | null;
    currentFetchRevalidate?: number | null;
    draftModeSecret: string;
    dynamicConfig?: string;
    params: AppPageParams;
    rootParams?: RootParams;
    routePattern: string;
    routeSegments: readonly string[];
    setNavigationContext: DispatchAppPageOptions<AppPageDispatchRoute>["setNavigationContext"];
  },
  renderFn: () => Promise<TResult>,
): Promise<TResult> {
  const { createStaticGenerationHeadersContext } = await import("./app-static-generation.js");
  const headersContext = createStaticGenerationHeadersContext({
    draftModeEnabled: false,
    draftModeSecret: options.draftModeSecret,
    dynamicConfig: options.dynamicConfig,
    routeKind: "page",
    routePattern: options.routePattern,
  });
  const requestContext = createRequestContext({
    headersContext,
    currentFetchCacheMode: options.currentFetchCacheMode ?? null,
    currentFetchRevalidate: options.currentFetchRevalidate ?? null,
    currentForceDynamicFetchDefault: options.dynamicConfig === "force-dynamic",
    executionContext: getRequestExecutionContext(),
    rootParams: options.rootParams ?? null,
    unstableCacheRevalidation: "foreground",
  });

  const revalidation = runWithRequestContext(requestContext, () =>
    runInWorkStoreScope(async () => {
      ensureFetchPatch();
      setRefreshStaleFetchesInForeground(process.env.VINEXT_PRERENDER === "1");
      setCurrentFetchSoftTags(buildAppPageTags(options.cleanPathname, [], options.routeSegments));
      options.setNavigationContext({
        pathname: options.displayPathname ?? options.cleanPathname,
        searchParams: new URLSearchParams(),
        params: options.params,
      });
      return await runWithFetchDedupe(renderFn);
    }),
  );
  try {
    return await revalidation;
  } finally {
    await closeAfterResponse(requestContext);
  }
}

function toInterceptOptions(
  interceptionContext: string | null,
  intercept: AppPageDispatchIntercept,
): AppPageDispatchInterceptOptions {
  return {
    interceptionId: intercept.interceptionId ?? null,
    interceptGraphId: intercept.interceptionGraphId ?? null,
    interceptionContext,
    interceptLayouts: intercept.interceptLayouts,
    interceptLayoutSegments: intercept.interceptLayoutSegments,
    interceptBranchSegments: intercept.interceptBranchSegments,
    interceptLoadings: intercept.interceptLoadings,
    interceptLoadingTreePositions: intercept.interceptLoadingTreePositions,
    interceptNotFoundBranchSegments: intercept.interceptNotFoundBranchSegments,
    interceptNotFound: intercept.notFound,
    interceptNotFoundTreePosition: intercept.notFoundTreePosition,
    interceptForbiddens: intercept.interceptForbiddens,
    interceptForbiddenTreePositions: intercept.interceptForbiddenTreePositions,
    interceptUnauthorizeds: intercept.interceptUnauthorizeds,
    interceptUnauthorizedTreePositions: intercept.interceptUnauthorizedTreePositions,
    interceptErrors: intercept.interceptErrors,
    interceptErrorTreePositions: intercept.interceptErrorTreePositions,
    interceptNotFounds: intercept.interceptNotFounds,
    interceptNotFoundTreePositions: intercept.interceptNotFoundTreePositions,
    interceptPage: intercept.page,
    interceptParams: intercept.matchedParams,
    interceptSlotId: intercept.slotId ?? null,
    interceptSlotKey: intercept.slotKey,
    interceptSourceMatchedUrl: interceptionContext,
    interceptSourcePageSegments: intercept.sourcePageSegments ?? null,
    interceptTargetPatternParts: intercept.targetPatternParts ?? null,
    interceptTargetRouteGraphId: intercept.targetRouteGraphId ?? null,
  };
}

/**
 * Workers Cache never admits a path its deploy manifest gives no state: a
 * listed path that used a dynamic API, or an unlisted path of a route without
 * on-demand ISR. Next.js serves those per request, so they render normally,
 * with real values. Without a manifest, admission uses the `runtime` policy
 * and every path keeps candidate mode, as on core.
 */
function hasNoManifestAdmissionState(routePattern: string): boolean {
  const admission = readRouteCacheabilityState()?.admission;
  return (
    admission?.policy === "manifest" &&
    admission.representation !== undefined &&
    admission.routePathname !== undefined &&
    cacheabilityManifestPageState(
      admission.manifest as CacheabilityManifest,
      { kind: "app-page", pattern: routePattern },
      admission.representation as CacheabilityRepresentation,
      admission.routePathname,
    ) === null
  );
}

export async function dispatchAppPage<TRoute extends AppPageDispatchRoute>(
  options: DispatchAppPageOptions<TRoute>,
): Promise<Response> {
  const dispatch = () => runWithFetchDedupe(() => dispatchAppPageInner(options));
  let response: Response;
  if (!options.pprFallbackShell || !options.pprRuntime) {
    response = await dispatch();
  } else {
    response = await options.pprRuntime.run(options.pprFallbackShell, dispatch);
  }

  return options.isRscRequest ? response : traceResponseStart(response);
}

async function dispatchAppPageInner<TRoute extends AppPageDispatchRoute>(
  options: DispatchAppPageOptions<TRoute>,
): Promise<Response> {
  const route = options.route;
  beginRouteCacheability("app-page", route.pattern);
  if (isRouteCacheabilityIdentityProbe()) {
    options.clearRequestContext();
    return new Response(null, { status: 204 });
  }
  const dynamicConfig = options.dynamicConfig;
  const interceptionId = options.isRscRequest
    ? options.request.headers.get(VINEXT_INTERCEPTION_ID_HEADER)
    : null;
  const isForceStatic = dynamicConfig === "force-static";
  const isDynamicError = dynamicConfig === "error";
  const isForceDynamic = dynamicConfig === "force-dynamic";
  // Only routes Next.js classifies as static or SSG from their config are
  // full-page cache candidates. Every other route renders per request and is
  // never stored, whatever its revalidate or cacheLife. cacheComponents builds
  // (PPR fallback shells) follow a different model and keep their own rules.
  const isNextStaticEligible = isAppPageStaticEligible({
    dynamicConfig,
    hasGenerateStaticParams: options.hasGenerateStaticParams,
    isDynamicRoute: route.isDynamic,
    isStaticGenerationEdgeRuntime: options.isStaticGenerationEdgeRuntime === true,
    revalidateSeconds: options.revalidateSeconds,
  });
  const isStaticEligible = options.pprRuntime !== undefined || isNextStaticEligible;
  // Next.js defaults every static or SSG route to `revalidate = false`, so a
  // render that uses no dynamic API is stored until it is revalidated. This
  // includes a generateStaticParams route whose generator returns no concrete
  // paths, on the first on-demand render of an unknown path. Dev has no ISR.
  // https://github.com/vercel/next.js/blob/canary/packages/next/src/build/index.ts
  // Any segment's generator still sets this default, which the fetch shim and
  // cacheComponents fallback shells read.
  const hasStaticRevalidateDefault =
    options.isProduction && options.pprRuntime === undefined && isNextStaticEligible;
  const currentRevalidateSeconds =
    options.revalidateSeconds ??
    (hasStaticRevalidateDefault || options.hasAnyGenerateStaticParams ? Infinity : null);
  if (isRouteCacheabilityProbe()) {
    // A route that isn't static or SSG is never stored, so its probe reports
    // the whole pattern dynamic, whichever of its paths discovery listed.
    const isRouteStaticEligible =
      options.pprRuntime !== undefined ||
      isAppPageStaticEligible({
        dynamicConfig: options.dynamicConfig,
        hasGenerateStaticParams: options.hasGenerateStaticParams,
        isDynamicRoute: route.isDynamic,
        isStaticGenerationEdgeRuntime: options.isStaticGenerationEdgeRuntime === true,
        revalidateSeconds: options.revalidateSeconds ?? null,
      });
    const patternDynamicReason = isForceDynamic
      ? 'dynamic = "force-dynamic"'
      : currentRevalidateSeconds === 0
        ? "revalidate = 0"
        : !isRouteStaticEligible
          ? "route is not statically generated"
          : null;
    if (patternDynamicReason) markRouteCacheabilityPatternDynamic(patternDynamicReason);
  }
  const isPrerender = process.env.VINEXT_PRERENDER === "1";
  let traceOperation: "prerender" | "render" = isPrerender ? "prerender" : "render";
  const serveStreamingMetadata = shouldServeStreamingMetadata(
    options.request.headers.get("user-agent") ?? "",
    options.htmlLimitedBots,
  );
  // Full static artifacts resolve generated metadata into <head>. PPR fallback
  // shells keep request-time placement until metadata staticness can be tracked
  // independently from the route's staticness.
  const placeGeneratedMetadataInBody =
    (!isPrerender || options.pprFallbackShell !== undefined) && serveStreamingMetadata;
  const isPrefetchDynamicShell = options.renderMode === APP_RSC_RENDER_MODE_PREFETCH_DYNAMIC_SHELL;
  const isDraftMode = isDraftModeRequest(options.request, options.draftModeSecret);
  const requestHeadersContext = getHeadersContext();
  const shouldUseEmptySearchParams = isForceStatic || isPrefetchDynamicShell;
  const hasRequestSearchParams =
    !shouldUseEmptySearchParams && hasSearchParams(options.searchParams);
  const pageSearchParams = shouldUseEmptySearchParams
    ? new URLSearchParams()
    : options.searchParams;

  setCurrentFetchSoftTags(buildAppPageTags(options.cleanPathname, [], route.routeSegments));
  setCurrentFetchCacheMode(options.fetchCache ?? null);
  setCurrentFetchRevalidate(currentRevalidateSeconds);
  setCurrentForceDynamicFetchDefault(isForceDynamic);

  if (options.hasPageModule && !options.hasPageDefaultExport) {
    options.clearRequestContext();
    return applyIneligibleRouteCachePolicy(
      new Response("Page has no default export", { status: 500 }),
      {
        isDraftMode,
        isDynamicError,
        isForceDynamic,
        isForceStatic,
        isProduction: options.isProduction,
        isProgressiveActionRender: options.isProgressiveActionRender === true,
        isRscRequest: options.isRscRequest,
        isStaticEligible,
        middlewareContext: options.middlewareContext,
        peekDynamicUsage,
        revalidateSeconds: currentRevalidateSeconds,
        scriptNonce: options.scriptNonce,
      },
    );
  }

  // The cacheComponents exemption only covers caching. Methods follow the
  // route's own Next.js classification.
  const methodResponse = resolveAppPageMethodResponse({
    isStaticEligible: isNextStaticEligible,
    middlewareHeaders: options.middlewareContext.headers,
    request: options.request,
  });
  if (methodResponse) {
    options.clearRequestContext();
    return methodResponse;
  }

  if (isForceStatic || isDynamicError) {
    const { createStaticGenerationHeadersContext } = await import("./app-static-generation.js");
    setHeadersContext(
      createStaticGenerationHeadersContext({
        draftModeEnabled: isDraftMode,
        draftModeSecret: options.draftModeSecret,
        dynamicConfig,
        routeKind: "page",
        routePattern: route.pattern,
      }),
    );
    const staticNavigationParams = resolveAppPageNavigationParams(
      route,
      options.params,
      options.cleanPathname,
      null,
    );
    options.setNavigationContext({
      pathname: options.displayPathname ?? options.cleanPathname,
      searchParams: new URLSearchParams(),
      params: staticNavigationParams,
    });
  }

  const isCacheEligibleRender =
    options.bypassInterceptionContextCache !== true &&
    shouldReadAppPageCache({
      isDraftMode,
      isForceDynamic,
      isProgressiveActionRender: options.isProgressiveActionRender === true,
      isProduction: options.isProduction,
      isRscRequest: options.isRscRequest,
      revalidateSeconds: currentRevalidateSeconds,
      scriptNonce: options.scriptNonce,
    });
  // Next.js never stores a path the Workers Cache manifest gives no state, so
  // its render neither reads, serves nor regenerates a core ISR entry. Its
  // completed response already skips core writes under admission. PPR
  // fallback shells follow cacheComponents' model instead.
  const isNeverStoredPath =
    options.pprRuntime === undefined && hasNoManifestAdmissionState(route.pattern);
  const isStoredRender = !isRouteCacheabilityProbe() && isCacheEligibleRender && !isNeverStoredPath;
  // Like Next.js's ResponseCache, an authorized on-demand revalidation never
  // serves the stored entry: it renders in the foreground and stores that.
  const isOnDemandRevalidate = _isOnDemandRevalidate();
  const shouldReadCache = isStoredRender && !isOnDemandRevalidate;
  // A render that may be stored, and so must not let the request's query reach
  // its output unless it turns out dynamic. The Workers Cache deploy probe
  // renders this way too, so its manifest matches the runtime. A
  // cacheComponents page is stored under the same key, so it's gated too. Only
  // the build's PPR fallback shell renders follow their own model.
  const isCacheCandidate =
    isCacheEligibleRender &&
    isStaticEligible &&
    options.pprFallbackShell === undefined &&
    !isNeverStoredPath;
  // A render that can never be stored and, in production, is never sent with
  // static cache headers. Only it may skip layouts that would otherwise decide
  // whether the response is cacheable. With Cache Components, Next.js renders
  // layouts for every production prefetch (isRoutePPREnabled), so only dev
  // skips them.
  const isUncacheableRender =
    !(isCacheEligibleRender && isStaticEligible) &&
    options.pprFallbackShell === undefined &&
    (options.pprRuntime === undefined || !options.isProduction);
  // A navigation names the layouts it holds, so a render that's never stored
  // can leave them out, as Next.js renders only below where a navigation
  // diverges. A stored payload stays whole for every client that reads it.
  const mountedLayouts =
    isUncacheableRender &&
    options.isRscRequest &&
    (options.renderMode ?? APP_RSC_RENDER_MODE_NAVIGATION) === APP_RSC_RENDER_MODE_NAVIGATION &&
    options.interceptionContext === null &&
    options.isProgressiveActionRender !== true
      ? parseMountedLayoutsHeader(options.request.headers.get(VINEXT_MOUNTED_LAYOUTS_HEADER))
      : null;
  if (shouldReadCache && isStaticEligible) {
    traceOperation = resolveAppPageTraceOperation({
      hasRequestSearchParams,
      isDynamicError,
      isForceStatic,
      isKnownPrerenderedRoute: options.renderedConcreteUrlPaths !== undefined,
      isPrerender,
    });
    const { readAppPageCacheResponse } = await import("./app-page-cache.js");
    const reportedSsrRevalidationErrors = new Set<unknown>();
    let revalidationRscErrorTracker: ReturnType<typeof createAppPageRscErrorTracker> | null = null;
    // The route, params and intercept a render for this request's cache entry
    // uses. A hit sends the same navigation params a fresh render would.
    const resolveCacheRenderTarget = async () => {
      const revalidationTarget = await resolveAppPageInterceptionRerenderTarget({
        cleanPathname: options.cleanPathname,
        currentParams: options.params,
        currentRoute: route,
        findIntercept: options.findIntercept,
        getRouteParamNames(sourceRoute) {
          return sourceRoute.params;
        },
        getSourceRoute(sourceRouteIndex) {
          return options.getSourceRoute(sourceRouteIndex);
        },
        isRscRequest: options.isRscRequest,
        toInterceptOpts(intercept) {
          return toInterceptOptions(options.interceptionContext, intercept);
        },
      });
      // Hydrate the (possibly different) source route before reading its
      // slots for navigation params and its page module for fetch-cache-mode
      // resolution.
      await options.ensureRouteLoaded?.(revalidationTarget.route);
      // Use the full navigationParams (not narrowed params) as the base so
      // interception-specific extras from a source-route intercept survive
      // the slot param merge.  resolveAppPageNavigationParams preserves all
      // base keys and overlays active slot params on top; when narrowed
      // params were used here, non-slot extras were silently dropped.
      const mergedNavigationParams = resolveAppPageNavigationParams(
        revalidationTarget.route,
        revalidationTarget.navigationParams,
        options.cleanPathname,
        revalidationTarget.interceptOpts,
      );
      revalidationTarget.navigationParams = mergedNavigationParams;
      return revalidationTarget;
    };
    const cachedPageResponse = await readAppPageCacheResponse({
      cleanPathname: options.cleanPathname,
      clearRequestContext: options.clearRequestContext,
      hasRequestSearchParams,
      isEdgeRuntime: options.isEdgeRuntime,
      isRoutePPREnabled: options.pprRuntime !== undefined,
      isRscRequest: options.isRscRequest,
      isrDebug: options.isrDebug,
      isrGet: options.isrGet,
      isrHtmlKey: options.isrHtmlKey,
      isrRscKey: options.isrRscKey,
      isrSet: options.isrSet,
      interceptionContext: options.interceptionContext,
      interceptionId,
      middlewareHeaders: options.middlewareContext.headers,
      middlewareStatus: options.middlewareContext.status,
      mountedSlotsHeader: options.mountedSlotsHeader,
      async resolveParams() {
        return (await resolveCacheRenderTarget()).navigationParams;
      },
      renderedPathAndSearch: options.renderedPathAndSearch,
      renderMode: options.renderMode,
      expireSeconds: options.expireSeconds,
      revalidateSeconds: resolveAppPageCacheReadRevalidateSeconds({
        isDynamicError,
        isForceStatic,
        revalidateSeconds: currentRevalidateSeconds,
      }),
      // As in Next.js, a path generated at build time answers its RSC requests
      // from the cache, and its regeneration renders the document.
      isDynamicRscRequest:
        options.pprRuntime !== undefined &&
        options.isRscRequest &&
        options.request.headers.get(NEXT_ROUTER_PREFETCH_HEADER) !== "1" &&
        options.renderedConcreteUrlPaths?.has(options.cleanPathname) !== true,
      renderFreshPageForCache: async ({ renderDocument }) => {
        const revalidationTarget = await resolveCacheRenderTarget();

        const revalidationDynamicConfig =
          options.resolveRouteDynamicConfig?.(revalidationTarget.route) ??
          (revalidationTarget.route === route ? dynamicConfig : undefined);
        const revalidationConfigRevalidateSeconds =
          options.resolveRouteRevalidateSeconds?.(revalidationTarget.route) ??
          (revalidationTarget.route === route ? currentRevalidateSeconds : null);
        // A stale intercepted entry regenerates its source route, so the entry
        // takes that route's revalidate, not the matched route's read seed. A
        // static route without one keeps `revalidate = false`.
        const revalidationRouteRevalidateSeconds =
          revalidationTarget.route === route
            ? undefined
            : (revalidationConfigRevalidateSeconds ??
              (revalidationDynamicConfig === "force-static" ||
              revalidationDynamicConfig === "error" ||
              (options.isProduction &&
                options.pprRuntime === undefined &&
                options.resolveRouteStaticEligible(revalidationTarget.route))
                ? Infinity
                : null));
        const revalidationRouteHead: RouteHeadRef = {
          observeSearchParams: revalidationDynamicConfig !== "force-static",
          searchParams: new URLSearchParams(),
          streamMetadata: false,
          value: null,
        };
        return runAppPageRevalidationContext(
          {
            cleanPathname: options.cleanPathname,
            displayPathname: options.displayPathname,
            currentFetchCacheMode:
              options.resolveRouteFetchCacheMode?.(revalidationTarget.route) ??
              (revalidationTarget.route === route ? (options.fetchCache ?? null) : null),
            currentFetchRevalidate: revalidationConfigRevalidateSeconds,
            draftModeSecret: options.draftModeSecret,
            dynamicConfig: revalidationDynamicConfig,
            params: revalidationTarget.navigationParams,
            rootParams: options.rootParams,
            routePattern: revalidationTarget.route.pattern,
            routeSegments: revalidationTarget.route.routeSegments,
            setNavigationContext: options.setNavigationContext,
          },
          async () => {
            const { renderAppPageCacheArtifacts } = await import("./app-page-cache-render.js");
            const revalidatedElement = await options.buildPageElement(
              revalidationTarget.route,
              revalidationTarget.params,
              revalidationTarget.interceptOpts,
              new URLSearchParams(),
              {
                isForceStatic: revalidationDynamicConfig === "force-static",
                observeMetadataSearchParamsAccess: revalidationDynamicConfig !== "force-static",
                observePageSearchParamsAccess: revalidationDynamicConfig !== "force-static",
                // As in Next.js, a regeneration streams metadata as the
                // request that triggered it does, into the <head> of a
                // document it renders whole.
                serveStreamingMetadata: placeGeneratedMetadataInBody,
                placeStreamedMetadataInHead: true,
                onHeadPrepared(head) {
                  revalidationRouteHead.value = head;
                },
              },
            );
            const baseRevalidatedOnError = options.createRscOnErrorHandler(
              options.cleanPathname,
              revalidationTarget.route.pattern,
              { revalidateReason: "stale" },
            );
            const baseRevalidatedOnSsrError = options.createRscOnErrorHandler(
              options.cleanPathname,
              revalidationTarget.route.pattern,
              { renderSource: "server-rendering", revalidateReason: "stale" },
            );
            const rscErrorTracker = createAppPageRscErrorTracker(baseRevalidatedOnError);
            revalidationRscErrorTracker = rscErrorTracker;
            // No inner runWithFetchDedupe here: this renderFn is already
            // wrapped in runWithFetchDedupe by runAppPageRevalidationContext.
            const rendered = await renderAppPageCacheArtifacts({
              basePath: options.basePath,
              captureRscData: true,
              cleanPathname: options.cleanPathname,
              clientTraceMetadata: options.clientTraceMetadata,
              element: revalidatedElement,
              getFontLinks: options.getFontLinks,
              getFontPreloads: options.getFontPreloads,
              getFontStyles: options.getFontStyles,
              getNavigationContext: options.getNavigationContext,
              loadSsrHandler: options.loadSsrHandler,
              mountedSlotsHeader: options.mountedSlotsHeader,
              // As in a request render, a stored document that streams a
              // special error a boundary caught carries `self.__next_f`.
              mirrorNextFlight: () => rscErrorTracker.getCapturedSpecialError() !== null,
              navigationParams: revalidationTarget.navigationParams,
              isCapturedRscError: rscErrorTracker.isCapturedError,
              onError: rscErrorTracker.onRenderError,
              onSsrError(error) {
                reportedSsrRevalidationErrors.add(error);
                return baseRevalidatedOnSsrError(error, undefined, undefined);
              },
              reactMaxHeadersLength: options.reactMaxHeadersLength,
              // A regeneration of an RSC variant's entry alone needs no
              // document for its shell's special error.
              resolveCaughtNotFoundBoundaries: renderDocument
                ? (error) =>
                    resolveAppPageCaughtNotFoundBoundaries(
                      error,
                      rscErrorTracker.getCapturedSpecialErrors(error),
                    )
                : undefined,
              async renderShellSpecialError(error, caughtDocument) {
                const specialError = resolveAppPageShellSpecialError(
                  error,
                  rscErrorTracker.getCapturedSpecialErrors(error),
                );
                // generateMetadata()'s special error rejects the shell only
                // when the triggering request blocks on metadata, as an
                // html-limited bot does, and is then stored like the page's.
                if (!specialError) return null;
                // An RSC request's generateMetadata() special error would leave
                // its status beside a document that the request's user agent
                // didn't decide, so the previous entry is kept.
                if (options.isRscRequest && specialError.fromMetadata === true) return null;
                if (renderDocument && caughtDocument) {
                  return {
                    headers: resolveAppPageSpecialErrorStoredHeaders(
                      specialError,
                      options.basePath,
                    ),
                    html: caughtDocument.html,
                    linkHeader: caughtDocument.linkHeader,
                    status: specialError.statusCode,
                  };
                }
                // A regeneration of an RSC variant's entry alone needs no
                // document. The special error's own document renders as the
                // triggering request does, so an RSC request stores its RSC
                // entry alone and leaves the document to an HTML request.
                if (!renderDocument || options.isRscRequest) {
                  return {
                    headers: resolveAppPageSpecialErrorStoredHeaders(
                      specialError,
                      options.basePath,
                    ),
                    html: "",
                    status: specialError.statusCode,
                  };
                }
                // The fallback boundaries are resolved for the matched route.
                if (revalidationTarget.route !== route) return null;
                const document = await renderPageSpecialError(
                  options,
                  specialError,
                  false,
                  revalidationTarget.interceptOpts,
                  true,
                  undefined,
                  revalidationRouteHead,
                );
                // As on a miss, only the special error's own document is stored.
                if (document.status !== specialError.statusCode) return null;
                return {
                  headers: resolveAppPageSpecialErrorStoredHeaders(specialError, options.basePath),
                  html: await document.text(),
                  // Only the renderer's own Link, as on a miss: middleware's is
                  // merged again on replay.
                  linkHeader: getFrameworkLinkHeader(document.headers) ?? undefined,
                  status: specialError.statusCode,
                };
              },
              renderToReadableStream: options.renderToReadableStream,
              rootParams: options.rootParams,
              route: revalidationTarget.route,
              waitForAllReady: true,
              isForceStatic: revalidationDynamicConfig === "force-static",
            });
            options.clearRequestContext();
            return {
              headers: rendered.headers,
              html: rendered.html,
              htmlRenderObservation: rendered.htmlRenderObservation,
              linkHeader: rendered.linkHeader,
              rscData: rendered.rscData!,
              rscRenderObservation: rendered.rscRenderObservation!,
              tags: rendered.tags,
              cacheControl: rendered.cacheControl,
              revalidateSeconds: revalidationRouteRevalidateSeconds,
              status: rendered.status,
              usedDynamicApi: rendered.usedDynamicApi,
            };
          },
        );
      },
      scheduleBackgroundRegeneration(key, renderFn) {
        options.scheduleBackgroundRegeneration(key, renderFn, {
          routerKind: "App Router",
          routePath: route.pattern,
          routeType: "render",
          shouldReport: (error) =>
            !reportedSsrRevalidationErrors.has(error) &&
            !revalidationRscErrorTracker?.isCapturedError(error),
        });
      },
    });
    if (cachedPageResponse) {
      return cachedPageResponse;
    }
  }

  // Next.js' production force-dynamic routes are absent from the prerender
  // manifest, so they never enter its generated-path fallback gate. Dev still
  // resolves and exact-matches generateStaticParams for the same route.
  if (options.skipStaticParamsValidation !== true && !(options.isProduction && isForceDynamic)) {
    const dynamicParamsResponse = await validateAppPageDynamicParams({
      enforceStaticParamsOnly: options.dynamicParamsConfig === false,
      generateStaticParams: options.generateStaticParams,
      isDynamicRoute: route.isDynamic,
      params: options.staticParamsValidationParams ?? options.params,
    });
    if (dynamicParamsResponse) {
      // A generated-param miss belongs to a matched App route, so render the
      // route's not-found boundary just like a page-level notFound() signal.
      // The plain response remains a defensive fallback if boundary rendering
      // is unavailable, but the normal path must include Next.js's canonical
      // not-found markup (and custom not-found.tsx when present). The route's
      // own not-found is the nearest one in its tree; the manifest's root
      // not-found can belong to another root layout's (issue #4304).
      const boundaryModule = route.notFound ?? getDefaultHttpAccessFallbackModule(404);
      const renderedNotFound = await options.renderHttpAccessFallbackPage(
        404,
        { boundaryModule, matchedParams: options.params },
        options.middlewareContext,
      );
      const cachePolicy = {
        dynamicStaleTimeSeconds: options.dynamicStaleTimeSeconds,
        isDraftMode,
        isDynamicError,
        isForceDynamic,
        isForceStatic,
        isProduction: options.isProduction,
        isProgressiveActionRender: options.isProgressiveActionRender === true,
        isRscRequest: options.isRscRequest,
        isStaticEligible,
        middlewareContext: options.middlewareContext,
        peekDynamicUsage,
        revalidateSeconds: currentRevalidateSeconds,
        scriptNonce: options.scriptNonce,
      };
      if (renderedNotFound) {
        return applyIneligibleRouteCachePolicy(renderedNotFound, cachePolicy);
      }
      options.clearRequestContext();
      return applyIneligibleRouteCachePolicy(dynamicParamsResponse, cachePolicy);
    }
  }

  const fallbackShellResponse = options.pprRuntime
    ? await options.pprRuntime.tryServe(
        options,
        currentRevalidateSeconds,
        isDraftMode,
        isForceStatic,
        isForceDynamic,
      )
    : null;
  if (fallbackShellResponse) {
    return fallbackShellResponse;
  }

  let interceptDynamicConfig: string | null | undefined;
  let interceptDynamicConfigResolved = false;
  // Whether the source route that the intercepted response renders is
  // force-dynamic or revalidate = 0, from the config activated for its render.
  let isInterceptSourceKnownDynamic = false;
  // The head the page's render prepared, for its special-error fallback.
  const renderedRouteHead: RouteHeadRef = {
    observeSearchParams: !isForceStatic,
    searchParams: pageSearchParams,
    streamMetadata: placeGeneratedMetadataInBody && options.renderWholeDocument !== true,
    value: null,
  };
  const onHeadPrepared = (head: AppPagePreparedRouteHead) => {
    renderedRouteHead.value = head;
  };
  const interceptResult = await resolveAppPageIntercept<
    TRoute,
    unknown,
    AppPageDispatchInterceptOptions,
    AppPageElement
  >({
    async buildPageElement(interceptRoute, interceptParams, interceptOpts, interceptSearchParams) {
      // Deliberately no save/restore around buildPageElement: when this
      // callback runs, resolveAppPageIntercept returns the intercept response
      // directly and the dispatch never falls through to the original route.
      // The intercept route's fetch defaults must also stay active past this
      // call — its server components fetch lazily during the
      // renderToReadableStream in renderInterceptResponse below.
      const sourceDynamicConfig = interceptDynamicConfigResolved
        ? interceptDynamicConfig
        : options.resolveRouteDynamicConfig?.(interceptRoute);
      if (sourceDynamicConfig === "force-static" || sourceDynamicConfig === "error") {
        const { createStaticGenerationHeadersContext } = await import("./app-static-generation.js");
        setHeadersContext(
          createStaticGenerationHeadersContext({
            draftModeEnabled: isDraftMode,
            draftModeSecret: options.draftModeSecret,
            dynamicConfig: sourceDynamicConfig,
            routeKind: "page",
            routePattern: interceptRoute.pattern,
          }),
        );
      } else {
        setHeadersContext(requestHeadersContext);
      }
      const sourceRevalidateSeconds =
        options.resolveRouteRevalidateSeconds?.(interceptRoute) ?? null;
      isInterceptSourceKnownDynamic =
        sourceDynamicConfig === "force-dynamic" || sourceRevalidateSeconds === 0;
      setCurrentFetchCacheMode(options.resolveRouteFetchCacheMode?.(interceptRoute) ?? null);
      setCurrentFetchRevalidate(sourceRevalidateSeconds);
      setCurrentForceDynamicFetchDefault(sourceDynamicConfig === "force-dynamic");
      return options.buildPageElement(
        interceptRoute,
        interceptParams,
        interceptOpts,
        interceptSearchParams,
        {
          isForceStatic: sourceDynamicConfig === "force-static",
          observeMetadataSearchParamsAccess: sourceDynamicConfig !== "force-static",
          observePageSearchParamsAccess: sourceDynamicConfig !== "force-static",
          isUncacheableRender,
          serveStreamingMetadata: placeGeneratedMetadataInBody,
          placeStreamedMetadataInHead: options.renderWholeDocument === true,
          onHeadPrepared,
        },
      );
    },
    cleanPathname: options.cleanPathname,
    currentRoute: route,
    findIntercept(pathname) {
      return options.findIntercept(pathname);
    },
    getRouteParamNames(sourceRoute) {
      return sourceRoute.params;
    },
    getSourceRoute(sourceRouteIndex) {
      return options.getSourceRoute(sourceRouteIndex);
    },
    isRscRequest: options.isRscRequest,
    resolveNavigationParams(sourceRoute, navigationParams, pathname, interceptOpts) {
      return resolveAppPageNavigationParams(sourceRoute, navigationParams, pathname, interceptOpts);
    },
    renderInterceptResponse(sourceRoute, interceptElement) {
      const interceptOnError = options.createRscOnErrorHandler(
        options.cleanPathname,
        sourceRoute.pattern,
      );
      // No inner runWithFetchDedupe here: dispatchAppPage already activated
      // dedupe at line 294, and this callback runs inside dispatchAppPageInner.
      const interceptStream = options.renderToReadableStream(interceptElement, {
        onError: interceptOnError,
      });
      const interceptHeaders = new Headers({
        "Content-Type": VINEXT_RSC_CONTENT_TYPE,
        Vary: VINEXT_RSC_VARY_HEADER,
      });
      // This response renders the source route, so it takes the source's
      // cacheability and dynamic config, not the matched target's. A source
      // that can't be static, a render known dynamic before it starts, or a
      // draft-mode request is never cacheable, like the source's own render.
      // Middleware's policy still wins, merged after, as in the RSC builder.
      const isSourceStaticEligible =
        options.pprRuntime !== undefined || options.resolveRouteStaticEligible(sourceRoute);
      if (!isSourceStaticEligible || isDraftMode || isInterceptSourceKnownDynamic) {
        interceptHeaders.set("Cache-Control", resolveUncacheableCacheControl(options.isProduction));
      }
      mergeMiddlewareResponseHeaders(interceptHeaders, options.middlewareContext.headers);
      applyRscCompatibilityIdHeader(interceptHeaders);
      applyRscDeploymentIdHeader(interceptHeaders);
      return new Response(interceptStream, {
        status: options.middlewareContext.status ?? 200,
        headers: interceptHeaders,
      });
    },
    async resolveSearchParams(sourceRoute, searchParams) {
      await options.ensureRouteLoaded?.(sourceRoute);
      interceptDynamicConfig = options.resolveRouteDynamicConfig?.(sourceRoute);
      interceptDynamicConfigResolved = true;
      return interceptDynamicConfig === "force-static" ? new URLSearchParams() : searchParams;
    },
    searchParams: options.searchParams,
    setNavigationContext: options.setNavigationContext,
    toInterceptOpts(intercept) {
      return toInterceptOptions(options.interceptionContext, intercept);
    },
  });
  if (interceptResult.response) {
    return interceptResult.response;
  }

  const buildCurrentPageElement = () =>
    buildAppPageElement({
      buildPageElement() {
        // Each render owns its head. A PPR fallback shell's warm-up render
        // runs first and is discarded, so the final render's fallback must
        // never reuse the warm-up's head promises.
        renderedRouteHead.value = null;
        if (options.actionFailed) {
          throw options.actionError;
        }
        return options.buildPageElement(
          route,
          options.params,
          interceptResult.interceptOpts,
          pageSearchParams,
          {
            isForceStatic,
            observeMetadataSearchParamsAccess: !isForceStatic,
            observePageSearchParamsAccess: !isForceStatic,
            isUncacheableRender,
            // An intercepted render keeps every layout its interception wraps.
            mountedLayouts: interceptResult.interceptOpts ? null : mountedLayouts,
            serveStreamingMetadata: placeGeneratedMetadataInBody,
            placeStreamedMetadataInHead: options.renderWholeDocument === true,
            onHeadPrepared,
          },
        );
      },
      renderErrorBoundaryPage(buildError) {
        return options.renderErrorBoundaryPage(buildError);
      },
      renderSpecialError(specialError) {
        return renderPageSpecialError(
          options,
          specialError,
          serveStreamingMetadata,
          interceptResult.interceptOpts,
          false,
          undefined,
          renderedRouteHead,
        );
      },
      resolveSpecialError: resolveAppPageSpecialError,
    });

  const fallbackShellState = options.pprRuntime?.getState() ?? null;
  if (fallbackShellState && process.env.VINEXT_PRERENDER === "1" && !options.isRscRequest) {
    const warmupBuildResult = await buildCurrentPageElement();
    if (warmupBuildResult.response) {
      return warmupBuildResult.response;
    }
    await options.pprRuntime!.warm({
      element: warmupBuildResult.element,
      onError: options.createRscOnErrorHandler(options.cleanPathname, route.pattern),
      renderToReadableStream: options.renderToReadableStream,
      state: fallbackShellState,
    });
    discardAppPageRenderState();
  }

  const navigationParams = resolveAppPageNavigationParams(
    route,
    options.params,
    options.cleanPathname,
    interceptResult.interceptOpts,
  );
  const activeFallbackShellState = options.pprRuntime?.getState() ?? null;
  const pprFallbackShellSignal = activeFallbackShellState?.abortController.signal;
  const pprFallbackShellReactSignal = activeFallbackShellState?.reactAbortController.signal;
  const isSpeculativePrerender =
    isPrerender && options.request.headers.get(VINEXT_PRERENDER_SPECULATIVE_HEADER) === "1";
  const requestCacheLife = _captureRequestScopedCacheLifeAccessors();
  // Next.js's ResponseCache awaits an on-demand revalidation's writes before
  // it answers, so `await res.revalidate()` resolves once the entry is stored.
  const onDemandCacheWrites: Promise<void>[] | null = isOnDemandRevalidate ? [] : null;

  const lifecycleOptions: Parameters<typeof renderAppPageLifecycle>[0] = {
    basePath: options.basePath,
    bypassInterceptionContextCache: options.bypassInterceptionContextCache,
    clientTraceMetadata: options.clientTraceMetadata,
    reactMaxHeadersLength: options.reactMaxHeadersLength,
    cleanPathname: options.cleanPathname,
    clearRequestContext: options.clearRequestContext,
    consumeDynamicUsage,
    peekDynamicUsage,
    consumeInvalidDynamicUsageError,
    consumeRenderObservationState: consumeAppPageRenderObservationState,
    createRscOnErrorHandler(pathname, routePath, overrides) {
      return options.createRscOnErrorHandler(pathname, routePath, overrides);
    },
    async prepareElement() {
      const pageBuildResult = await buildCurrentPageElement();
      if (pageBuildResult.response) return { response: pageBuildResult.response };
      options.setNavigationContext({
        pathname: options.displayPathname ?? options.cleanPathname,
        searchParams: pageSearchParams,
        params: navigationParams,
      });
      return { element: pageBuildResult.element };
    },
    getDraftModeCookieHeader,
    getFontLinks: options.getFontLinks,
    getFontPreloads: options.getFontPreloads,
    getFontStyles: options.getFontStyles,
    getNavigationContext: options.getNavigationContext,
    getPageTags() {
      return buildAppPageTags(options.cleanPathname, getCollectedFetchTags(), route.routeSegments);
    },
    getRequestCacheLife() {
      return requestCacheLife.consume();
    },
    peekRequestCacheLife() {
      return requestCacheLife.peek();
    },
    handlerStart: options.handlerStart,
    // Only candidate HTML renders gate searchParams, so their MISS is final.
    omitPendingDynamicCacheState:
      hasRequestSearchParams && !(isCacheCandidate && !options.isRscRequest),
    formState: options.formState ?? null,
    isProgressiveActionRender: options.isProgressiveActionRender === true,
    isDynamicError,
    isDraftMode,
    isForceDynamic,
    isForceStatic,
    isEdgeRuntime: options.isEdgeRuntime === true,
    isStaticEligible,
    isCacheCandidate,
    isPrerender,
    isRoutePPREnabled: options.pprRuntime !== undefined,
    isSpeculativePrerender,
    // An RSC payload streams either way; only a document waits for SSR.
    renderWholeDocument: options.renderWholeDocument === true && !options.isRscRequest,
    isProduction: options.isProduction,
    isRscRequest: options.isRscRequest,
    traceOperation,
    isrDebug: options.isrDebug,
    isrHtmlKey: options.isrHtmlKey,
    isrRscKey: options.isrRscKey,
    isrSet: options.isrSet,
    interceptionContext: options.interceptionContext,
    interceptionId,
    expireSeconds: options.expireSeconds,
    loadSsrHandler: options.loadSsrHandler,
    middlewareContext: options.middlewareContext,
    navigationParams,
    params: options.params,
    pprFallbackShellSignal,
    pprFallbackShellReactSignal,
    renderedPathAndSearch: options.renderedPathAndSearch,
    abortPprFallbackShell: activeFallbackShellState
      ? () => {
          options.pprRuntime!.beginFinalRender(activeFallbackShellState);
        }
      : undefined,
    rootParams: options.rootParams,
    peekRenderObservationState() {
      return {
        dynamicFetches: peekDynamicFetchObservations(),
        requestApis: peekRenderRequestApiUsage(),
      };
    },
    dynamicStaleTimeSeconds: options.dynamicStaleTimeSeconds,
    revalidateSeconds: currentRevalidateSeconds,
    mountedSlotsHeader: options.mountedSlotsHeader,
    renderMode: options.renderMode ?? APP_RSC_RENDER_MODE_NAVIGATION,
    renderErrorBoundaryResponse(renderError, errorOrigin, throwingLayoutIndex) {
      return options.renderErrorBoundaryPage(renderError, errorOrigin, throwingLayoutIndex);
    },
    renderPageSpecialError(specialError, renderOptions) {
      return renderPageSpecialError(
        options,
        specialError,
        serveStreamingMetadata,
        interceptResult.interceptOpts,
        renderOptions?.isCacheCandidate === true,
        renderOptions?.caughtDocument,
        renderedRouteHead,
      );
    },
    renderToReadableStream: options.renderToReadableStream,
    hasCustomGlobalError: options.hasCustomGlobalError,
    prerenderToReadableStream: options.prerenderToReadableStream,
    routePattern: route.pattern,
    scriptNonce: options.scriptNonce,
    waitUntil(cachePromise) {
      onDemandCacheWrites?.push(cachePromise);
      getRequestExecutionContext()?.waitUntil(cachePromise);
    },
  };
  const renderResponse = async () => {
    const response = await renderAppPageLifecycle(lifecycleOptions);
    // Each write reads its own branch of the render's streams, so it completes
    // while the response's branch stays unread.
    if (onDemandCacheWrites) await Promise.all(onDemandCacheWrites);
    return response;
  };
  // Concurrent on-demand revalidations of one stored entry share a single
  // render, as Next.js batches ResponseCache work by its key and
  // isOnDemandRevalidate. A mounted-slots RSC variant is never stored.
  if (
    isOnDemandRevalidate &&
    isStoredRender &&
    isStaticEligible &&
    !(options.isRscRequest && options.mountedSlotsHeader)
  ) {
    const cacheKey = options.isRscRequest
      ? options.isrRscKey(
          options.cleanPathname,
          null,
          options.renderMode,
          options.interceptionContext,
          interceptionId,
        )
      : options.isrHtmlKey(options.cleanPathname);
    return coalesceOnDemandResponse(
      `${options.request.method}:${cacheKey}`,
      options.request.method,
      renderResponse,
    );
  }
  return renderResponse();
}

/** One render's head, once it prepares one, and how that render resolves it. */
type RouteHeadRef = Omit<AppPageFallbackRouteHead, "prepared"> & {
  value: AppPagePreparedRouteHead | null;
};

/**
 * A signal the route's own render threw keeps the route's head, reusing the
 * one that render prepared. A progressive server action's signal doesn't:
 * Next.js answers it with a not-found tree in place of the page
 * (`createNotFoundLoaderTree`), so the page's metadata never applies.
 * https://github.com/vercel/next.js/blob/canary/packages/next/src/server/app-render/app-render.tsx
 */
function resolveFallbackRouteHead<TRoute extends AppPageDispatchRoute>(
  options: DispatchAppPageOptions<TRoute>,
  renderedRouteHead: RouteHeadRef | null,
): AppPageFallbackRouteHead | null {
  if (options.actionFailed || !renderedRouteHead) return null;
  const { value, ...render } = renderedRouteHead;
  return { ...render, prepared: value };
}

/**
 * The outermost layout above every loading boundary whose subtree throws the
 * HTTP access fallback with `statusCode`. The document's shell rejected with
 * one that a component nothing tags threw: one a layout renders, the page
 * renders or a template. This runs only on that error path, as a layout's own
 * component tags what it throws.
 */
async function findAppPageLayoutSubtreeSpecialErrorIndex<TRoute extends AppPageDispatchRoute>(
  options: DispatchAppPageOptions<TRoute>,
  statusCode: number,
  limit: number,
): Promise<number | null> {
  const layoutCount = Math.min(
    limit,
    getAppPageLayoutProbeCount(options.route, getActiveLoadingTreePositions(options.route)),
  );
  if (layoutCount === 0) return null;
  // The render's own dynamic usage already decides how the fallback is stored.
  return await runWithDetachedDynamicUsage(() =>
    options.runWithSuppressedHookWarning(async () => {
      for (let layoutIndex = 0; layoutIndex < layoutCount; layoutIndex++) {
        const outcome = await runWithConnectionProbe(async () => {
          try {
            await options.probeLayoutAt(layoutIndex);
            return false;
          } catch (error) {
            const specialError = resolveAppPageSpecialError(error);
            return (
              specialError?.kind === "http-access-fallback" &&
              specialError.statusCode === statusCode
            );
          }
        });
        if (outcome.completed && outcome.result) return layoutIndex;
      }
      return null;
    }),
  );
}

/**
 * The fallback for a special error a layout threw, or a parallel slot that
 * layout renders: the boundary above the layout catches it. With
 * `insideLayout`, the layout re-renders around its own segment's boundary
 * instead. Without a segment boundary, Next.js' built-in not-found,
 * forbidden or unauthorized page renders inside the root layout, or without
 * it when the root layout, or a slot beside it outside `insideLayout`, threw.
 */
function renderLayoutBoundaryFallback<TRoute extends AppPageDispatchRoute>(
  options: DispatchAppPageOptions<TRoute>,
  statusCode: number,
  layoutIndex: number,
  fallbackOptions: {
    headLayouts: readonly AppPageModule[];
    insideLayout?: boolean;
    intercept?: AppPageDispatchInterceptOptions | null;
    isCacheCandidate?: boolean;
    routeHead: AppPageFallbackRouteHead | null;
  },
): Promise<Response | null> {
  const { route } = options;
  const layoutTreePositions = route.layoutTreePositions ?? [];
  const boundaryModules =
    statusCode === 403
      ? route.segmentForbiddens
      : statusCode === 401
        ? route.segmentUnauthorizeds
        : route.segmentNotFounds;
  const boundaryTreePositions =
    statusCode === 403
      ? route.segmentForbiddenTreePositions
      : statusCode === 401
        ? route.segmentUnauthorizedTreePositions
        : route.segmentNotFoundTreePositions;
  const insideLayout = fallbackOptions.insideLayout === true;
  const ownLayoutTreePosition = layoutTreePositions[layoutIndex];
  // Inside the layout, its own segment's boundary catches too.
  const layoutTreePosition =
    ownLayoutTreePosition === undefined || !insideLayout
      ? ownLayoutTreePosition
      : ownLayoutTreePosition + 1;
  const renderedLayoutCount = insideLayout ? layoutIndex + 1 : layoutIndex;
  const boundary =
    layoutTreePosition === undefined
      ? null
      : resolveAppPageLayoutHttpAccessBoundary({
          boundaryModules: boundaryModules ?? [],
          boundaryTreePositions: boundaryTreePositions ?? [],
          layoutTreePosition,
        });
  // Without a segment boundary, Next.js renders its built-in not-found,
  // forbidden or unauthorized page.
  const boundaryModule = boundary?.module ?? getDefaultHttpAccessFallbackModule(statusCode);
  if (!boundaryModule) return Promise.resolve(null);
  // The boundary replaces its segment's children, so layouts below its
  // segment do not render around it. It never renders above the root layout.
  const boundaryTreePosition = Math.max(
    boundary?.treePosition ?? 0,
    resolveAppPageRootHttpAccessBoundaryTreePosition(
      route.routeSegments,
      layoutTreePositions,
      layoutTreePosition,
    ),
  );
  // Next.js takes the head from the route's deepest boundary file, which
  // can sit below the one that catches the error.
  const headBoundary = resolveAppPageLayoutHttpAccessBoundary({
    boundaryModules: boundaryModules ?? [],
    boundaryTreePositions: boundaryTreePositions ?? [],
    layoutTreePosition: Number.POSITIVE_INFINITY,
  });
  return options.renderHttpAccessFallbackPage(
    statusCode,
    {
      boundaryComponent: boundaryModule.default,
      boundaryModule,
      headBoundaryModule: headBoundary?.module ?? boundaryModule,
      headLayouts: fallbackOptions.headLayouts,
      ...(fallbackOptions.intercept ? { intercept: fallbackOptions.intercept } : {}),
      ...(fallbackOptions.isCacheCandidate ? { isCacheCandidate: true } : {}),
      layouts: route.layouts.filter(
        (_, index) =>
          index < renderedLayoutCount && (layoutTreePositions[index] ?? 0) <= boundaryTreePosition,
      ),
      matchedParams: options.params,
      ...(fallbackOptions.routeHead ? { routeHead: fallbackOptions.routeHead } : {}),
    },
    null,
  );
}

/**
 * The fallback for a page's `notFound()` / `forbidden()` / `unauthorized()`.
 * Next.js wraps each segment's children in its boundaries, with or without a
 * layout, so the route's deepest boundary catches the signal and replaces
 * every layout below its segment. Without one, the built-in not-found,
 * forbidden or unauthorized page renders inside the root layout. Returns
 * `null` for routes without segment data.
 * https://github.com/vercel/next.js/blob/canary/packages/next/src/server/app-render/create-component-tree.tsx
 */
function renderPageSegmentBoundaryFallback<TRoute extends AppPageDispatchRoute>(
  options: DispatchAppPageOptions<TRoute>,
  statusCode: number,
  intercept: AppPageDispatchInterceptOptions | null | undefined,
  isCacheCandidate: boolean,
  routeHead: AppPageFallbackRouteHead | null,
): Promise<Response | null> | null {
  const { route } = options;
  const boundaryModules =
    statusCode === 403
      ? route.segmentForbiddens
      : statusCode === 401
        ? route.segmentUnauthorizeds
        : route.segmentNotFounds;
  const boundaryTreePositions =
    statusCode === 403
      ? route.segmentForbiddenTreePositions
      : statusCode === 401
        ? route.segmentUnauthorizedTreePositions
        : route.segmentNotFoundTreePositions;
  if (!boundaryTreePositions) return null;
  const boundary = resolveAppPageLayoutHttpAccessBoundary({
    boundaryModules: boundaryModules ?? [],
    boundaryTreePositions,
    layoutTreePosition: Number.POSITIVE_INFINITY,
  });
  const boundaryModule = boundary?.module ?? getDefaultHttpAccessFallbackModule(statusCode);
  if (!boundaryModule) return Promise.resolve(null);
  const layoutTreePositions = route.layoutTreePositions ?? [];
  // The root segment's boundary renders inside the root layout, including a
  // first-layer route group's layout, as Turbopack copies it into the group.
  // No boundary renders above the root layout.
  const boundaryTreePosition = Math.max(
    boundary?.treePosition ?? 0,
    resolveAppPageRootHttpAccessBoundaryTreePosition(
      route.routeSegments,
      layoutTreePositions,
      Number.POSITIVE_INFINITY,
    ),
  );
  return options.renderHttpAccessFallbackPage(
    statusCode,
    {
      boundaryComponent: boundaryModule.default,
      boundaryModule,
      // Every layout on the route still contributes metadata.
      headLayouts: route.layouts,
      intercept,
      ...(isCacheCandidate ? { isCacheCandidate } : {}),
      layouts: route.layouts.filter(
        (_, index) => (layoutTreePositions[index] ?? 0) <= boundaryTreePosition,
      ),
      matchedParams: options.params,
      ...(routeHead ? { routeHead } : {}),
    },
    null,
  );
}

async function renderPageSpecialError<TRoute extends AppPageDispatchRoute>(
  options: DispatchAppPageOptions<TRoute>,
  specialError: AppPageSpecialError,
  serveStreamingMetadata: boolean,
  intercept: AppPageDispatchInterceptOptions | null | undefined,
  isCacheCandidate = false,
  caughtDocument?: Response,
  renderedRouteHead: RouteHeadRef | null = null,
): Promise<Response> {
  const routeHead = resolveFallbackRouteHead(options, renderedRouteHead);
  return buildAppPageSpecialErrorResponse({
    basePath: options.basePath,
    buildRscRedirectFlightStream: (rscOptions) =>
      buildRscRedirectFlightStream({
        renderToReadableStream: options.renderToReadableStream,
        digest: rscOptions.digest,
      }),
    clearRequestContext: options.clearRequestContext,
    getAndClearPendingCookies,
    serveStreamingMetadata,
    isEdgeRuntime: options.isEdgeRuntime,
    isRscRequest: options.isRscRequest,
    middlewareContext: options.middlewareContext,
    async renderFallbackPage(statusCode) {
      // Parallel slot not-found boundaries caught it in the page's own document.
      if (caughtDocument) return caughtDocument;
      if (specialError.kind === "http-access-fallback") {
        // A layout's signal is caught above that layout, so the layouts above
        // it contribute the head. One a component the layout renders threw
        // carries no tag, so it's found among the layouts above the tagged
        // ones, which it would be caught outside of.
        let layoutIndex = specialError.layoutIndex ?? null;
        if (specialError.unattributed === true) {
          layoutIndex =
            (await findAppPageLayoutSubtreeSpecialErrorIndex(
              options,
              statusCode,
              layoutIndex ??
                (specialError.slotLayoutIndex === undefined
                  ? options.route.layouts.length
                  : specialError.slotLayoutIndex + 1),
            )) ?? layoutIndex;
        }
        if (layoutIndex !== null) {
          return renderLayoutBoundaryFallback(options, statusCode, layoutIndex, {
            headLayouts: options.route.layouts.slice(0, layoutIndex),
            intercept,
            isCacheCandidate,
            routeHead,
          });
        }
      }
      // A slot's signal is caught above the layout that renders it.
      if (
        specialError.kind === "http-access-fallback" &&
        specialError.slotLayoutIndex !== undefined
      ) {
        return renderLayoutBoundaryFallback(options, statusCode, specialError.slotLayoutIndex, {
          // Every layout on the route still contributes metadata.
          headLayouts: options.route.layouts,
          // Next.js re-renders a root layout that has a named slot around the
          // root segment's not-found, keeping the document's <html> and <body>
          // (`isRootLayoutWithChildrenSlotAndAtLeastOneMoreSlot`). A server
          // root layout gets that fallback for not-found only, so forbidden and
          // unauthorized bubble above it; a client one gets all three.
          insideLayout:
            specialError.slotLayoutIndex === 0 &&
            (statusCode === 404 || isAppClientReference(options.route.layouts[0]?.default)),
          intercept,
          isCacheCandidate,
          routeHead,
        });
      }
      const pageBoundaryFallback = renderPageSegmentBoundaryFallback(
        options,
        statusCode,
        intercept,
        isCacheCandidate,
        routeHead,
      );
      if (pageBoundaryFallback) return pageBoundaryFallback;
      // Routes without segment data resolve the boundary from the files
      // beside each layout.
      // `forbidden()` / `unauthorized()` / `notFound()` should be caught by the
      // nearest ancestor boundary. When the page (the deepest segment) calls
      // one of these and an intermediate layout has no matching boundary file,
      // resolve to the closest ancestor layout's boundary and slice off any
      // layouts beneath it so their UI does not render alongside the fallback.
      // Mirrors Next.js's per-segment boundary nesting in
      // `create-component-tree.tsx` (issue #1547).
      //
      // We only narrow layouts when the resolved boundary file lives at a
      // layout's own directory. A `forbidden.tsx` sibling to the route's
      // `page.tsx` (no layout there) wraps just the page subtree in Next.js,
      // so all of the route's layouts must still render.
      const routeBoundaryModule = resolveAppPageRouteBoundaryModule(options.route, statusCode);
      const layoutCount = options.route.layouts.length;
      const { module: parentBoundaryModule, layoutIndex: boundaryLayoutIndex } =
        resolveAppPageParentHttpAccessBoundary({
          layoutIndex: layoutCount,
          rootForbiddenModule: options.rootForbiddenModule,
          rootNotFoundModule: options.rootNotFoundModule,
          rootUnauthorizedModule: options.rootUnauthorizedModule,
          routeForbiddenModules: options.route.forbiddens,
          routeNotFoundModules: options.route.notFounds,
          routeUnauthorizedModules: options.route.unauthorizeds,
          statusCode,
        });
      // If the route-level boundary (closest walking up from page-dir) differs
      // from the per-layout resolution, a non-layout-aligned boundary sits
      // below the deepest layout — keep all layouts and let the existing route
      // boundary handling render it.
      const useLayoutAlignedBoundary =
        boundaryLayoutIndex !== null &&
        (routeBoundaryModule === null || routeBoundaryModule === parentBoundaryModule);
      const fallbackOptions: Parameters<typeof options.renderHttpAccessFallbackPage>[1] = {
        intercept,
        ...(isCacheCandidate ? { isCacheCandidate } : {}),
        matchedParams: options.params,
        ...(routeHead ? { routeHead } : {}),
      };
      if (useLayoutAlignedBoundary && boundaryLayoutIndex !== null) {
        fallbackOptions.layouts = options.route.layouts.slice(0, boundaryLayoutIndex + 1);
        if (parentBoundaryModule) {
          fallbackOptions.boundaryComponent = parentBoundaryModule.default;
          fallbackOptions.boundaryModule = parentBoundaryModule;
        }
      }
      return options.renderHttpAccessFallbackPage(statusCode, fallbackOptions, null);
    },
    request: options.request,
    specialError,
  });
}
