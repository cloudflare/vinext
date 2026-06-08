import React, { type ReactNode } from "react";
import type { ReactFormState } from "react-dom/client";
import type { NavigationContext } from "vinext/shims/navigation";
import type { ClassificationReason } from "../build/layout-classification-types.js";
import {
  _consumeRequestScopedCacheLife,
  _peekRequestScopedCacheLife,
  type CachedAppPageValue,
} from "vinext/shims/cache";
import type { RootParams } from "vinext/shims/root-params";
import {
  consumeDynamicUsage,
  consumeInvalidDynamicUsageError,
  consumeRenderRequestApiUsage,
  getAndClearPendingCookies,
  getDraftModeCookieHeader,
  isDraftModeRequest,
  markDynamicUsage,
  peekRenderRequestApiUsage,
  setHeadersContext,
} from "vinext/shims/headers";
import { getRequestExecutionContext } from "vinext/shims/request-context";
import { createRequestContext, runWithRequestContext } from "vinext/shims/unified-request-context";
import {
  ensureFetchPatch,
  consumeDynamicFetchObservations,
  type FetchCacheMode,
  getCollectedFetchTags,
  peekDynamicFetchObservations,
  runWithFetchDedupe,
  setCurrentFetchCacheMode,
  setCurrentFetchSoftTags,
} from "vinext/shims/fetch-cache";
import { AppElementsWire, type AppOutgoingElements } from "./app-elements.js";
import { readAppPageCacheResponse } from "./app-page-cache.js";
import {
  resolveAppPageParentHttpAccessBoundary,
  resolveAppPageParentHttpAccessBoundaryModule,
} from "./app-page-boundary.js";
import { readStreamAsText } from "../utils/text-stream.js";
import {
  buildAppPageSpecialErrorResponse,
  resolveAppPageSpecialError,
  teeAppPageRscStreamForCapture,
  type AppPageFontPreload,
  type AppPageSpecialError,
  type LayoutClassificationOptions,
} from "./app-page-execution.js";
import { resolveAppPageMethodResponse } from "./app-page-method.js";
import {
  buildAppPageElement,
  resolveAppPageInterceptionRerenderTarget,
  resolveAppPageIntercept,
  validateAppPageDynamicParams,
  type ValidateAppPageDynamicParamsOptions,
} from "./app-page-request.js";
import { renderAppPageLifecycle } from "./app-page-render.js";
import {
  createAppPageHtmlOutputScope,
  createAppPageRenderObservation,
  createAppPageRscOutputScope,
} from "./app-page-render-observation.js";
import {
  mergeMiddlewareResponseHeaders,
  type AppPageMiddlewareContext,
} from "./app-page-response.js";
import {
  VINEXT_RSC_CONTENT_TYPE,
  VINEXT_RSC_VARY_HEADER,
  applyRscCompatibilityIdHeader,
} from "./app-rsc-cache-busting.js";
import {
  APP_RSC_RENDER_MODE_NAVIGATION,
  shouldSuppressLoadingBoundaries,
  type AppRscRenderMode,
} from "./app-rsc-render-mode.js";
import { shouldServeStreamingMetadata } from "./streaming-metadata.js";
import { createAppPageTreePath } from "./app-page-route-wiring.js";
import { isAppSsrRenderResult, type AppPageSsrHandler } from "./app-page-stream.js";
import type { ClientReuseManifestParseResult } from "./client-reuse-manifest.js";
import { createStaticGenerationHeadersContext } from "./app-static-generation.js";
import { buildPageCacheTags } from "./implicit-tags.js";
import type { ISRCacheEntry } from "./isr-cache.js";
import {
  createAppLayoutParamAccessTracker,
  isAppLayoutObservationUnsafeForStaticReuse,
  type AppLayoutParamAccessTracker,
} from "./app-layout-param-observation.js";

type AppPageParams = Record<string, string | string[]>;
type AppPageElement = ReactNode | Readonly<Record<string, ReactNode>>;
type AppPageRenderableElement = ReactNode | AppOutgoingElements;
type AppPageBoundaryOnError = (
  error: unknown,
  requestInfo: unknown,
  errorContext: unknown,
) => unknown;
type AppPageDebugLogger = (event: string, detail: string) => void;
type AppPageCacheSetter = (
  key: string,
  data: CachedAppPageValue,
  revalidateSeconds: number,
  tags: string[],
  expireSeconds?: number,
) => Promise<void>;
type AppPageCacheGetter = (key: string) => Promise<ISRCacheEntry | null>;
type AppPageBackgroundRegenerationErrorContext = {
  routerKind: "App Router";
  routePath: string;
  routeType: "render";
};
type AppPageBackgroundRegenerator = (
  key: string,
  renderFn: () => Promise<void>,
  errorContext?: AppPageBackgroundRegenerationErrorContext,
) => void;

type AppPageDispatchIntercept<TPage = unknown> = {
  interceptLayouts?: readonly AppPageModule[] | null;
  matchedParams: AppPageParams;
  page: TPage;
  slotId?: string | null;
  slotKey: string;
  sourceRouteIndex: number;
};

type AppPageDispatchInterceptOptions<TPage = unknown> = {
  interceptionContext: string | null;
  interceptLayouts?: readonly AppPageModule[] | null;
  interceptPage: TPage;
  interceptParams: AppPageParams;
  interceptSlotId?: string | null;
  interceptSlotKey: string;
  interceptSourceMatchedUrl?: string | null;
};

type AppPageModule = {
  default?: unknown;
  dynamic?: unknown;
  revalidate?: unknown;
};

type LayoutSegmentConfigClassification = Readonly<{
  kind: "dynamic" | "static";
  reason: ClassificationReason;
}>;

type EffectiveLayoutClassifications = Readonly<{
  buildTimeClassifications: ReadonlyMap<number, "static" | "dynamic"> | null;
  buildTimeReasons: ReadonlyMap<number, ClassificationReason> | null | undefined;
}>;

type AppPageDispatchRoute = {
  __buildTimeClassifications?: LayoutClassificationOptions["buildTimeClassifications"];
  __buildTimeReasons?: LayoutClassificationOptions["buildTimeReasons"];
  error?: AppPageModule | null;
  errors?: readonly (AppPageModule | null | undefined)[];
  forbidden?: AppPageModule | null;
  forbiddens?: readonly (AppPageModule | null | undefined)[];
  isDynamic: boolean;
  layouts: readonly AppPageModule[];
  layoutTreePositions?: readonly number[];
  loading?: AppPageModule | null;
  notFound?: AppPageModule | null;
  notFounds?: readonly (AppPageModule | null | undefined)[];
  params: readonly string[];
  pattern: string;
  routeSegments: readonly string[];
  unauthorized?: AppPageModule | null;
  unauthorizeds?: readonly (AppPageModule | null | undefined)[];
};

function resolveAppPageRouteBoundaryModule(
  route: AppPageDispatchRoute,
  statusCode: number,
): AppPageModule | null {
  if (statusCode === 403) return route.forbidden ?? null;
  if (statusCode === 401) return route.unauthorized ?? null;
  if (statusCode === 404) return route.notFound ?? null;
  return null;
}

type DispatchAppPageOptions<TRoute extends AppPageDispatchRoute> = {
  /** Configured basePath (e.g. "/blog"). Used to prefix redirect Locations. */
  basePath?: string;
  /**
   * Allow-list of OpenTelemetry propagation keys (from
   * `experimental.clientTraceMetadata`) to surface as `<meta>` tags in the
   * SSR head. Undefined or empty disables emission entirely.
   */
  clientTraceMetadata?: readonly string[];
  buildPageElement: (
    route: TRoute,
    params: AppPageParams,
    opts: AppPageDispatchInterceptOptions | undefined,
    searchParams: URLSearchParams,
    layoutParamAccess?: AppLayoutParamAccessTracker,
  ) => Promise<AppPageElement>;
  clientReuseManifest?: ClientReuseManifestParseResult;
  cleanPathname: string;
  clearRequestContext: () => void;
  createRscOnErrorHandler: (pathname: string, routePath: string) => AppPageBoundaryOnError;
  debugClassification?: (layoutId: string, reason: ClassificationReason) => void;
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
  hasGenerateStaticParams: boolean;
  hasPageDefaultExport: boolean;
  hasPageModule: boolean;
  handlerStart: number;
  htmlLimitedBots?: string;
  interceptionContext: string | null;
  isEdgeRuntime?: boolean;
  isProgressiveActionRender?: boolean;
  isProduction: boolean;
  isRscRequest: boolean;
  isrDebug?: AppPageDebugLogger;
  isrGet: AppPageCacheGetter;
  isrHtmlKey: (pathname: string) => string;
  isrRscKey: (
    pathname: string,
    mountedSlotsHeader?: string | null,
    renderMode?: AppRscRenderMode,
    interceptionContext?: string | null,
  ) => string;
  isrSet: AppPageCacheSetter;
  loadSsrHandler: () => Promise<AppPageSsrHandler>;
  middlewareContext: AppPageMiddlewareContext;
  mountedSlotsHeader?: string | null;
  params: AppPageParams;
  staticParamsValidationParams?: AppPageParams;
  rootParams?: RootParams;
  probeLayoutAt: (layoutIndex: number, layoutParamAccess?: AppLayoutParamAccessTracker) => unknown;
  probePage: () => unknown;
  expireSeconds?: number;
  renderErrorBoundaryPage: (error: unknown) => Promise<Response | null>;
  renderHttpAccessFallbackPage: (
    statusCode: number,
    opts: {
      boundaryComponent?: unknown;
      boundaryModule?: AppPageModule | null;
      layouts?: readonly AppPageModule[];
      matchedParams: AppPageParams;
    },
    middlewareContext: AppPageMiddlewareContext | null,
  ) => Promise<Response | null>;
  renderToReadableStream: (
    element: AppPageRenderableElement,
    options: { onError: AppPageBoundaryOnError },
  ) => ReadableStream<Uint8Array>;
  request: Request;
  revalidateSeconds: number | null;
  resolveRouteFetchCacheMode?: (route: TRoute) => FetchCacheMode | null;
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
};

/**
 * Request-time counterpart to the build-time `classifyLayoutSegmentConfig`
 * (`build/report.ts`). Both classify a layout by its `dynamic`/`revalidate`
 * segment config and agree on the shared cases (the build-time version
 * normalizes `revalidate = false` to `Infinity` upstream, so both treat it as
 * static); keep them aligned when either changes.
 *
 * The meaningful difference is scope, not logic: this request-time pass reads
 * the resolved module value, so it classifies layouts that were never captured
 * at build time (e.g. dev mode). Its result is merged on top of the build-time
 * classification map in `createEffectiveLayoutClassifications`, so such layouts
 * are classified here where they previously were not.
 */
function classifyLayoutSegmentConfigFromModule(
  layout: AppPageModule | null | undefined,
): LayoutSegmentConfigClassification | null {
  if (!layout) return null;

  switch (layout.dynamic) {
    case "force-dynamic":
      return {
        kind: "dynamic",
        reason: { layer: "segment-config", key: "dynamic", value: "force-dynamic" },
      };
    case "force-static":
    case "error":
      return {
        kind: "static",
        reason: { layer: "segment-config", key: "dynamic", value: layout.dynamic },
      };
  }

  if (layout.revalidate === false || layout.revalidate === Infinity) {
    return {
      kind: "static",
      reason: { layer: "segment-config", key: "revalidate", value: Infinity },
    };
  }
  if (layout.revalidate === 0) {
    return {
      kind: "dynamic",
      reason: { layer: "segment-config", key: "revalidate", value: 0 },
    };
  }

  return null;
}

function createEffectiveLayoutClassifications(
  route: AppPageDispatchRoute,
  includeReasons: boolean,
): EffectiveLayoutClassifications {
  const classifications = new Map(route.__buildTimeClassifications ?? []);
  const reasons = includeReasons ? new Map(route.__buildTimeReasons ?? []) : null;

  for (let index = 0; index < route.layouts.length; index++) {
    const classification = classifyLayoutSegmentConfigFromModule(route.layouts[index]);
    if (classification === null) continue;

    // Precedence: when a layout's module segment config classifies, it is
    // authoritative and overrides the build-time map for that layout — even if
    // a Layer 1/2 build-time classifier marked it differently for a
    // non-segment-config reason. Downstream consumers should treat this merged
    // result, not `__buildTimeClassifications`, as the source of truth.
    classifications.set(index, classification.kind);
    reasons?.set(index, classification.reason);
  }

  return {
    buildTimeClassifications: classifications.size > 0 ? classifications : null,
    buildTimeReasons: reasons && reasons.size > 0 ? reasons : null,
  };
}

function getEffectiveLayoutClassifications(
  route: AppPageDispatchRoute,
  debugClassification: DispatchAppPageOptions<AppPageDispatchRoute>["debugClassification"],
): EffectiveLayoutClassifications {
  return createEffectiveLayoutClassifications(route, debugClassification !== undefined);
}

function shouldReadAppPageCache(options: {
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

function hasSearchParams(searchParams: URLSearchParams | null | undefined): boolean {
  return searchParams !== null && searchParams !== undefined && searchParams.size > 0;
}

function buildAppPageTags(
  cleanPathname: string,
  extraTags: string[],
  routeSegments: readonly string[],
): string[] {
  return buildPageCacheTags(cleanPathname, extraTags, [...routeSegments], "page");
}

async function runAppPageRevalidationContext<
  TResult extends {
    html: string;
    rscData: ArrayBuffer;
    tags: string[];
  },
>(
  options: {
    cleanPathname: string;
    currentFetchCacheMode?: FetchCacheMode | null;
    draftModeSecret: string;
    dynamicConfig?: string;
    params: AppPageParams;
    routePattern: string;
    routeSegments: readonly string[];
    setNavigationContext: DispatchAppPageOptions<AppPageDispatchRoute>["setNavigationContext"];
  },
  renderFn: () => Promise<TResult>,
): Promise<TResult> {
  const headersContext = createStaticGenerationHeadersContext({
    draftModeSecret: options.draftModeSecret,
    dynamicConfig: options.dynamicConfig,
    routeKind: "page",
    routePattern: options.routePattern,
  });
  const requestContext = createRequestContext({
    headersContext,
    currentFetchCacheMode: options.currentFetchCacheMode ?? null,
    executionContext: getRequestExecutionContext(),
    unstableCacheRevalidation: "foreground",
  });

  return runWithRequestContext(requestContext, async () => {
    ensureFetchPatch();
    setCurrentFetchSoftTags(buildAppPageTags(options.cleanPathname, [], options.routeSegments));
    options.setNavigationContext({
      pathname: options.cleanPathname,
      searchParams: new URLSearchParams(),
      params: options.params,
    });
    return await runWithFetchDedupe(renderFn);
  });
}

function getCapturedRscDataPromise(
  capturedRscDataPromise: Promise<ArrayBuffer> | null,
): Promise<ArrayBuffer> {
  if (!capturedRscDataPromise) {
    throw new Error(
      "[vinext] Expected captured RSC data while regenerating an app page cache entry",
    );
  }

  return capturedRscDataPromise;
}

function toInterceptOptions(
  interceptionContext: string | null,
  intercept: AppPageDispatchIntercept,
): AppPageDispatchInterceptOptions {
  return {
    interceptionContext,
    interceptLayouts: intercept.interceptLayouts,
    interceptPage: intercept.page,
    interceptParams: intercept.matchedParams,
    interceptSlotId: intercept.slotId ?? null,
    interceptSlotKey: intercept.slotKey,
    interceptSourceMatchedUrl: interceptionContext,
  };
}

export async function dispatchAppPage<TRoute extends AppPageDispatchRoute>(
  options: DispatchAppPageOptions<TRoute>,
): Promise<Response> {
  return await runWithFetchDedupe(() => dispatchAppPageInner(options));
}

async function dispatchAppPageInner<TRoute extends AppPageDispatchRoute>(
  options: DispatchAppPageOptions<TRoute>,
): Promise<Response> {
  const route = options.route;
  const dynamicConfig = options.dynamicConfig;
  const currentRevalidateSeconds = options.revalidateSeconds;
  const isForceStatic = dynamicConfig === "force-static";
  const isDynamicError = dynamicConfig === "error";
  const isForceDynamic = dynamicConfig === "force-dynamic";
  const isDraftMode = isDraftModeRequest(options.request, options.draftModeSecret);
  const layoutParamAccess = createAppLayoutParamAccessTracker();

  setCurrentFetchSoftTags(buildAppPageTags(options.cleanPathname, [], route.routeSegments));
  setCurrentFetchCacheMode(options.fetchCache ?? null);

  if (options.hasPageModule && !options.hasPageDefaultExport) {
    options.clearRequestContext();
    return new Response("Page has no default export", { status: 500 });
  }

  const methodResponse = resolveAppPageMethodResponse({
    dynamicConfig,
    hasGenerateStaticParams: options.hasGenerateStaticParams,
    isDynamicRoute: route.isDynamic,
    middlewareHeaders: options.middlewareContext.headers,
    request: options.request,
    revalidateSeconds: currentRevalidateSeconds,
  });
  if (methodResponse) {
    options.clearRequestContext();
    return methodResponse;
  }

  if ((isForceStatic || isDynamicError) && !isDraftMode) {
    setHeadersContext(
      createStaticGenerationHeadersContext({
        draftModeSecret: options.draftModeSecret,
        dynamicConfig,
        routeKind: "page",
        routePattern: route.pattern,
      }),
    );
    options.setNavigationContext({
      pathname: options.cleanPathname,
      searchParams: new URLSearchParams(),
      params: options.params,
    });
  }

  if (
    shouldReadAppPageCache({
      isDraftMode,
      isForceDynamic,
      isProgressiveActionRender: options.isProgressiveActionRender === true,
      isProduction: options.isProduction,
      isRscRequest: options.isRscRequest,
      revalidateSeconds: currentRevalidateSeconds,
      scriptNonce: options.scriptNonce,
    })
  ) {
    const cachedPageResponse = await readAppPageCacheResponse({
      cleanPathname: options.cleanPathname,
      clearRequestContext: options.clearRequestContext,
      hasRequestSearchParams: !isForceStatic && hasSearchParams(options.searchParams),
      isEdgeRuntime: options.isEdgeRuntime,
      isRscRequest: options.isRscRequest,
      isrDebug: options.isrDebug,
      isrGet: options.isrGet,
      isrHtmlKey: options.isrHtmlKey,
      isrRscKey: options.isrRscKey,
      isrSet: options.isrSet,
      interceptionContext: options.interceptionContext,
      middlewareHeaders: options.middlewareContext.headers,
      middlewareStatus: options.middlewareContext.status,
      mountedSlotsHeader: options.mountedSlotsHeader,
      renderMode: options.renderMode,
      expireSeconds: options.expireSeconds,
      // cacheLife-only routes discover their actual revalidate during the
      // fresh render; this seed only gets them into the cache read path.
      revalidateSeconds: currentRevalidateSeconds ?? 0,
      renderFreshPageForCache: async () => {
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
        // page module for fetch-cache-mode resolution.
        await options.ensureRouteLoaded?.(revalidationTarget.route);
        return runAppPageRevalidationContext(
          {
            cleanPathname: options.cleanPathname,
            currentFetchCacheMode:
              options.resolveRouteFetchCacheMode?.(revalidationTarget.route) ??
              (revalidationTarget.route === route ? (options.fetchCache ?? null) : null),
            draftModeSecret: options.draftModeSecret,
            dynamicConfig,
            params: revalidationTarget.navigationParams,
            routePattern: revalidationTarget.route.pattern,
            routeSegments: revalidationTarget.route.routeSegments,
            setNavigationContext: options.setNavigationContext,
          },
          async () => {
            const revalidatedElement = await options.buildPageElement(
              revalidationTarget.route,
              revalidationTarget.params,
              revalidationTarget.interceptOpts,
              new URLSearchParams(),
            );
            const revalidatedOnError = options.createRscOnErrorHandler(
              options.cleanPathname,
              revalidationTarget.route.pattern,
            );
            // No inner runWithFetchDedupe here: this renderFn is already
            // wrapped in runWithFetchDedupe by runAppPageRevalidationContext.
            const revalidatedRscStream = options.renderToReadableStream(revalidatedElement, {
              onError: revalidatedOnError,
            });
            const revalidatedRscCapture = teeAppPageRscStreamForCapture(revalidatedRscStream, true);
            const revalidatedSsrEntry = await options.loadSsrHandler();
            const revalidatedCapturedRscRef: { value: Promise<ArrayBuffer> | null } = {
              value: null,
            };
            const revalidatedHtmlResult = await revalidatedSsrEntry.handleSsr(
              revalidatedRscCapture.ssrStream,
              options.getNavigationContext(),
              {
                links: options.getFontLinks(),
                styles: options.getFontStyles(),
                preloads: options.getFontPreloads(),
              },
              {
                basePath: options.basePath,
                clientTraceMetadata: options.clientTraceMetadata,
                rootParams: options.rootParams,
                waitForAllReady: true,
                ...(revalidatedRscCapture.sideStream
                  ? {
                      sideStream: revalidatedRscCapture.sideStream,
                      capturedRscDataRef: revalidatedCapturedRscRef,
                    }
                  : {}),
              },
            );
            const revalidatedHtmlStream = isAppSsrRenderResult(revalidatedHtmlResult)
              ? revalidatedHtmlResult.htmlStream
              : revalidatedHtmlResult;
            const html = await readStreamAsText(revalidatedHtmlStream);
            const rscData = await getCapturedRscDataPromise(revalidatedCapturedRscRef.value);
            const cacheLife = _consumeRequestScopedCacheLife();
            options.clearRequestContext();
            const tags = buildAppPageTags(
              options.cleanPathname,
              getCollectedFetchTags(),
              revalidationTarget.route.routeSegments,
            );
            // Consume once: HTML and RSC artifacts are produced by the same
            // regeneration render and should carry the same observation set.
            const observationState = {
              dynamicFetches: consumeDynamicFetchObservations(),
              requestApis: consumeRenderRequestApiUsage(),
            };
            return {
              html,
              htmlRenderObservation: createAppPageRenderObservation({
                boundaryOutcome: { kind: "success" },
                cacheability: "public",
                cacheTags: tags,
                cleanPathname: options.cleanPathname,
                completeness: "complete",
                output: createAppPageHtmlOutputScope({
                  element: revalidatedElement,
                  renderEpoch: null,
                  rootBoundaryId: null,
                  routePattern: revalidationTarget.route.pattern,
                }),
                params: revalidationTarget.navigationParams,
                state: observationState,
              }),
              rscData,
              rscRenderObservation: createAppPageRenderObservation({
                boundaryOutcome: { kind: "success" },
                cacheability: "public",
                cacheTags: tags,
                cleanPathname: options.cleanPathname,
                completeness: "complete",
                output: createAppPageRscOutputScope({
                  element: revalidatedElement,
                  mountedSlotsHeader: options.mountedSlotsHeader,
                  renderEpoch: null,
                  rootBoundaryId: null,
                  routePattern: revalidationTarget.route.pattern,
                }),
                params: revalidationTarget.navigationParams,
                state: observationState,
              }),
              tags,
              cacheControl:
                typeof cacheLife?.revalidate === "number"
                  ? { revalidate: cacheLife.revalidate, expire: cacheLife.expire }
                  : undefined,
            };
          },
        );
      },
      scheduleBackgroundRegeneration(key, renderFn) {
        options.scheduleBackgroundRegeneration(key, renderFn, {
          routerKind: "App Router",
          routePath: route.pattern,
          routeType: "render",
        });
      },
    });
    if (cachedPageResponse) {
      return cachedPageResponse;
    }
  }

  const dynamicParamsResponse = await validateAppPageDynamicParams({
    clearRequestContext: options.clearRequestContext,
    enforceStaticParamsOnly: options.dynamicParamsConfig === false,
    generateStaticParams: options.generateStaticParams,
    isDynamicRoute: route.isDynamic,
    params: options.staticParamsValidationParams ?? options.params,
  });
  if (dynamicParamsResponse) {
    return dynamicParamsResponse;
  }

  const interceptResult = await resolveAppPageIntercept<
    TRoute,
    unknown,
    AppPageDispatchInterceptOptions,
    AppPageElement
  >({
    async buildPageElement(
      interceptRoute,
      interceptParams,
      interceptOpts,
      interceptSearchParams,
      interceptLayoutParamAccess,
    ) {
      // Hydrate the intercept source route before reading its page module.
      await options.ensureRouteLoaded?.(interceptRoute);
      setCurrentFetchCacheMode(options.resolveRouteFetchCacheMode?.(interceptRoute) ?? null);
      return options.buildPageElement(
        interceptRoute,
        interceptParams,
        interceptOpts,
        interceptSearchParams,
        interceptLayoutParamAccess,
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
    layoutParamAccess,
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
      mergeMiddlewareResponseHeaders(interceptHeaders, options.middlewareContext.headers);
      applyRscCompatibilityIdHeader(interceptHeaders);
      return new Response(interceptStream, {
        status: options.middlewareContext.status ?? 200,
        headers: interceptHeaders,
      });
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

  const pageBuildResult = await buildAppPageElement({
    buildPageElement() {
      if (options.actionFailed) {
        throw options.actionError;
      }
      return options.buildPageElement(
        route,
        options.params,
        interceptResult.interceptOpts,
        options.searchParams,
        layoutParamAccess,
      );
    },
    renderErrorBoundaryPage(buildError) {
      return options.renderErrorBoundaryPage(buildError);
    },
    renderSpecialError(specialError) {
      return renderPageSpecialError(options, specialError);
    },
    resolveSpecialError: resolveAppPageSpecialError,
  });
  if (pageBuildResult.response) {
    return pageBuildResult.response;
  }

  const layoutClassifications = getEffectiveLayoutClassifications(
    route,
    options.debugClassification,
  );

  return renderAppPageLifecycle({
    basePath: options.basePath,
    clientTraceMetadata: options.clientTraceMetadata,
    cleanPathname: options.cleanPathname,
    clearRequestContext: options.clearRequestContext,
    consumeDynamicUsage,
    consumeInvalidDynamicUsageError,
    consumeRenderObservationState() {
      return {
        dynamicFetches: consumeDynamicFetchObservations(),
        requestApis: consumeRenderRequestApiUsage(),
      };
    },
    createRscOnErrorHandler(pathname, routePath) {
      return options.createRscOnErrorHandler(pathname, routePath);
    },
    element: pageBuildResult.element,
    clientReuseManifest: options.clientReuseManifest,
    getDraftModeCookieHeader,
    getFontLinks: options.getFontLinks,
    getFontPreloads: options.getFontPreloads,
    getFontStyles: options.getFontStyles,
    getNavigationContext: options.getNavigationContext,
    getPageTags() {
      return buildAppPageTags(options.cleanPathname, getCollectedFetchTags(), route.routeSegments);
    },
    getRequestCacheLife() {
      return _consumeRequestScopedCacheLife();
    },
    peekRequestCacheLife() {
      return _peekRequestScopedCacheLife();
    },
    handlerStart: options.handlerStart,
    hasLoadingBoundary: shouldSuppressLoadingBoundaries(
      options.renderMode ?? APP_RSC_RENDER_MODE_NAVIGATION,
    )
      ? false
      : Boolean(route.loading?.default),
    formState: options.formState ?? null,
    isProgressiveActionRender: options.isProgressiveActionRender === true,
    isDynamicError,
    isDraftMode,
    isForceDynamic,
    isForceStatic,
    isEdgeRuntime: options.isEdgeRuntime === true,
    isPrerender: process.env.VINEXT_PRERENDER === "1",
    isProduction: options.isProduction,
    isRscRequest: options.isRscRequest,
    isrDebug: options.isrDebug,
    isrHtmlKey: options.isrHtmlKey,
    isrRscKey: options.isrRscKey,
    isrSet: options.isrSet,
    interceptionContext: options.interceptionContext,
    expireSeconds: options.expireSeconds,
    layoutCount: route.layouts.length,
    loadSsrHandler: options.loadSsrHandler,
    middlewareContext: options.middlewareContext,
    params: options.params,
    layoutParamAccess,
    rootParams: options.rootParams,
    peekRenderObservationState() {
      return {
        dynamicFetches: peekDynamicFetchObservations(),
        requestApis: peekRenderRequestApiUsage(),
      };
    },
    probeLayoutAt(layoutIndex) {
      return options.probeLayoutAt(layoutIndex, layoutParamAccess);
    },
    probePage() {
      return options.probePage();
    },
    classification: {
      getLayoutId(index) {
        const treePosition = route.layoutTreePositions?.[index] ?? 0;
        return AppElementsWire.encodeLayoutId(
          createAppPageTreePath([...route.routeSegments], treePosition),
        );
      },
      buildTimeClassifications: layoutClassifications.buildTimeClassifications,
      buildTimeReasons: layoutClassifications.buildTimeReasons,
      debugClassification: options.debugClassification,
      isLayoutObservationDynamic(layoutId) {
        return isAppLayoutObservationUnsafeForStaticReuse(
          layoutParamAccess.getLayoutObservation(layoutId),
        );
      },
      async runWithIsolatedDynamicScope(fn) {
        const priorDynamic = consumeDynamicUsage();
        try {
          const result = await fn();
          const dynamicDetected = consumeDynamicUsage();
          return { result, dynamicDetected };
        } finally {
          consumeDynamicUsage();
          if (priorDynamic) markDynamicUsage();
        }
      },
    },
    dynamicStaleTimeSeconds: options.dynamicStaleTimeSeconds,
    revalidateSeconds: currentRevalidateSeconds,
    mountedSlotsHeader: options.mountedSlotsHeader,
    renderMode: options.renderMode ?? APP_RSC_RENDER_MODE_NAVIGATION,
    renderErrorBoundaryResponse(renderError) {
      return options.renderErrorBoundaryPage(renderError);
    },
    renderLayoutSpecialError(specialError, layoutIndex) {
      return renderLayoutSpecialError(options, specialError, layoutIndex);
    },
    renderPageSpecialError(specialError) {
      return renderPageSpecialError(options, specialError);
    },
    renderToReadableStream: options.renderToReadableStream,
    routeHasLocalBoundary: Boolean(
      route.error?.default || route.errors?.some((errorModule) => errorModule?.default),
    ),
    routePattern: route.pattern,
    runWithSuppressedHookWarning(probe) {
      return options.runWithSuppressedHookWarning(probe);
    },
    scriptNonce: options.scriptNonce,
    waitUntil(cachePromise) {
      getRequestExecutionContext()?.waitUntil(cachePromise);
    },
  });
}

/**
 * Builds an RSC flight payload that encodes a redirect as a React error chunk.
 * We render a tiny element that immediately throws an `Error` whose `digest`
 * is the canonical `NEXT_REDIRECT;...` string. `renderToReadableStream`'s
 * `onError` returns that digest, react-server-dom-webpack serializes the
 * error into the stream, and the client's `RedirectErrorBoundary` decodes it
 * via `getURLFromRedirectError` / `getRedirectTypeFromError`.
 *
 * The thrown error's digest matches Next.js's well-known router error format,
 * so neither vinext's RSC error handler nor Next.js's reporter logs it as a
 * "real" server error. Mirrors `app-render.tsx generateDynamicFlightRenderResult`
 * where a redirect thrown during RSC rendering propagates through
 * `renderToFlightStream`'s `onError` callback into the flight payload.
 */
function buildRscRedirectFlightStream<TRoute extends AppPageDispatchRoute>(
  options: DispatchAppPageOptions<TRoute>,
  digest: string,
): ReadableStream<Uint8Array> {
  const throwingElement = React.createElement(function NextRedirectFlightThrower() {
    const err = new Error("NEXT_REDIRECT") as Error & { digest: string };
    err.digest = digest;
    throw err;
  });

  return options.renderToReadableStream(throwingElement, {
    onError: () => digest,
  });
}

async function renderLayoutSpecialError<TRoute extends AppPageDispatchRoute>(
  options: DispatchAppPageOptions<TRoute>,
  specialError: AppPageSpecialError,
  layoutIndex: number,
): Promise<Response> {
  return buildAppPageSpecialErrorResponse({
    basePath: options.basePath,
    buildRscRedirectFlightStream: (rscOptions) =>
      buildRscRedirectFlightStream(options, rscOptions.digest),
    clearRequestContext: options.clearRequestContext,
    getAndClearPendingCookies,
    serveStreamingMetadata: shouldServeStreamingMetadata(
      options.request.headers.get("user-agent") ?? "",
      options.htmlLimitedBots,
    ),
    isEdgeRuntime: options.isEdgeRuntime,
    isRscRequest: options.isRscRequest,
    middlewareContext: options.middlewareContext,
    renderFallbackPage(statusCode) {
      const parentBoundaryModule = resolveAppPageParentHttpAccessBoundaryModule({
        layoutIndex,
        rootForbiddenModule: options.rootForbiddenModule,
        rootNotFoundModule: options.rootNotFoundModule,
        rootUnauthorizedModule: options.rootUnauthorizedModule,
        routeForbiddenModules: options.route.forbiddens,
        routeNotFoundModules: options.route.notFounds,
        routeUnauthorizedModules: options.route.unauthorizeds,
        statusCode,
      });
      const fallbackOptions: Parameters<typeof options.renderHttpAccessFallbackPage>[1] = {
        layouts: options.route.layouts.slice(0, layoutIndex),
        matchedParams: options.params,
      };
      if (parentBoundaryModule) {
        fallbackOptions.boundaryComponent = parentBoundaryModule.default;
        fallbackOptions.boundaryModule = parentBoundaryModule;
      }
      return options.renderHttpAccessFallbackPage(statusCode, fallbackOptions, null);
    },
    request: options.request,
    specialError,
  });
}

async function renderPageSpecialError<TRoute extends AppPageDispatchRoute>(
  options: DispatchAppPageOptions<TRoute>,
  specialError: AppPageSpecialError,
): Promise<Response> {
  return buildAppPageSpecialErrorResponse({
    basePath: options.basePath,
    buildRscRedirectFlightStream: (rscOptions) =>
      buildRscRedirectFlightStream(options, rscOptions.digest),
    clearRequestContext: options.clearRequestContext,
    getAndClearPendingCookies,
    serveStreamingMetadata: shouldServeStreamingMetadata(
      options.request.headers.get("user-agent") ?? "",
      options.htmlLimitedBots,
    ),
    isEdgeRuntime: options.isEdgeRuntime,
    isRscRequest: options.isRscRequest,
    middlewareContext: options.middlewareContext,
    renderFallbackPage(statusCode) {
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
        matchedParams: options.params,
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
