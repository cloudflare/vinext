import type { ReactNode } from "react";
import type { ClassificationReason } from "../build/layout-classification-types.js";
import {
  _consumeRequestScopedCacheLife,
  _peekRequestScopedCacheLife,
  type CachedAppPageValue,
} from "vinext/shims/cache";
import {
  consumeDynamicUsage,
  consumeInvalidDynamicUsageError,
  getDraftModeCookieHeader,
  markDynamicUsage,
  setHeadersContext,
} from "vinext/shims/headers";
import { getRequestExecutionContext } from "vinext/shims/request-context";
import { createRequestContext, runWithRequestContext } from "vinext/shims/unified-request-context";
import {
  ensureFetchPatch,
  getCollectedFetchTags,
  setCurrentFetchSoftTags,
} from "vinext/shims/fetch-cache";
import type { AppOutgoingElements } from "./app-elements.js";
import { readAppPageCacheResponse } from "./app-page-cache.js";
import { resolveAppPageParentHttpAccessBoundaryModule } from "./app-page-boundary.js";
import {
  buildAppPageSpecialErrorResponse,
  readAppPageTextStream,
  resolveAppPageSpecialError,
  teeAppPageRscStreamForCapture,
  type AppPageFontPreload,
  type AppPageSpecialError,
  type LayoutClassificationOptions,
} from "./app-page-execution.js";
import { resolveAppPageMethodResponse } from "./app-page-method.js";
import {
  buildAppPageElement,
  resolveAppPageIntercept,
  validateAppPageDynamicParams,
} from "./app-page-request.js";
import { renderAppPageLifecycle } from "./app-page-render.js";
import {
  mergeMiddlewareResponseHeaders,
  type AppPageMiddlewareContext,
} from "./app-page-response.js";
import { createAppPageTreePath } from "./app-page-route-wiring.js";
import type { AppPageSsrHandler } from "./app-page-stream.js";
import { createStaticGenerationHeadersContext } from "./app-static-generation.js";
import { buildPageCacheTags } from "./implicit-tags.js";
import type { ISRCacheEntry } from "./isr-cache.js";

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
  slotKey: string;
  sourceRouteIndex: number;
};

type AppPageDispatchInterceptOptions<TPage = unknown> = {
  interceptionContext: string | null;
  interceptLayouts?: readonly AppPageModule[] | null;
  interceptPage: TPage;
  interceptParams: AppPageParams;
  interceptSlotKey: string;
};

type AppPageModule = {
  default?: unknown;
};

type AppPageDispatchRoute = {
  __buildTimeClassifications?: LayoutClassificationOptions["buildTimeClassifications"];
  __buildTimeReasons?: LayoutClassificationOptions["buildTimeReasons"];
  error?: AppPageModule | null;
  errors?: readonly (AppPageModule | null | undefined)[];
  forbiddens?: readonly (AppPageModule | null | undefined)[];
  isDynamic: boolean;
  layouts: readonly AppPageModule[];
  layoutTreePositions?: readonly number[];
  loading?: AppPageModule | null;
  notFounds?: readonly (AppPageModule | null | undefined)[];
  params: readonly string[];
  pattern: string;
  routeSegments: readonly string[];
  unauthorizeds?: readonly (AppPageModule | null | undefined)[];
};

type DispatchAppPageOptions<TRoute extends AppPageDispatchRoute> = {
  buildPageElement: (
    route: TRoute,
    params: AppPageParams,
    opts: AppPageDispatchInterceptOptions | undefined,
    searchParams: URLSearchParams,
  ) => Promise<AppPageElement>;
  cleanPathname: string;
  clearRequestContext: () => void;
  createRscOnErrorHandler: (pathname: string, routePath: string) => AppPageBoundaryOnError;
  debugClassification?: (layoutId: string, reason: ClassificationReason) => void;
  dynamicConfig?: string;
  dynamicParamsConfig?: boolean;
  findIntercept: (pathname: string) => AppPageDispatchIntercept | null;
  generateStaticParams?: ((args: { params: AppPageParams }) => unknown) | null;
  getFontLinks: () => string[];
  getFontPreloads: () => AppPageFontPreload[];
  getFontStyles: () => string[];
  getNavigationContext: () => unknown;
  getSourceRoute: (sourceRouteIndex: number) => TRoute | undefined;
  hasGenerateStaticParams: boolean;
  hasPageDefaultExport: boolean;
  hasPageModule: boolean;
  handlerStart: number;
  interceptionContext: string | null;
  isProduction: boolean;
  isRscRequest: boolean;
  isrDebug?: AppPageDebugLogger;
  isrGet: AppPageCacheGetter;
  isrHtmlKey: (pathname: string) => string;
  isrRscKey: (pathname: string, mountedSlotsHeader?: string | null) => string;
  isrSet: AppPageCacheSetter;
  loadSsrHandler: () => Promise<AppPageSsrHandler>;
  middlewareContext: AppPageMiddlewareContext;
  mountedSlotsHeader?: string | null;
  params: AppPageParams;
  probeLayoutAt: (layoutIndex: number) => unknown;
  probePage: () => unknown;
  expireSeconds?: number;
  renderErrorBoundaryPage: (error: unknown) => Promise<Response | null>;
  renderHttpAccessFallbackPage: (
    statusCode: number,
    opts: {
      boundaryComponent?: unknown;
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
};

function shouldReadAppPageCache(options: {
  isForceDynamic: boolean;
  isProduction: boolean;
  isRscRequest: boolean;
  revalidateSeconds: number | null;
  scriptNonce?: string;
}): boolean {
  return (
    options.isProduction &&
    !options.isForceDynamic &&
    (options.isRscRequest || !options.scriptNonce) &&
    (options.revalidateSeconds === null ||
      (options.revalidateSeconds > 0 && options.revalidateSeconds !== Infinity))
  );
}

function buildAppPageTags(
  cleanPathname: string,
  extraTags: string[],
  routeSegments: readonly string[],
): string[] {
  return buildPageCacheTags(cleanPathname, extraTags, [...routeSegments], "page");
}

async function runAppPageRevalidationContext(
  options: {
    cleanPathname: string;
    dynamicConfig?: string;
    params: AppPageParams;
    routePattern: string;
    routeSegments: readonly string[];
    setNavigationContext: DispatchAppPageOptions<AppPageDispatchRoute>["setNavigationContext"];
  },
  renderFn: () => Promise<{
    html: string;
    rscData: ArrayBuffer;
    tags: string[];
  }>,
): Promise<{
  html: string;
  rscData: ArrayBuffer;
  tags: string[];
}> {
  const headersContext = createStaticGenerationHeadersContext({
    dynamicConfig: options.dynamicConfig,
    routeKind: "page",
    routePattern: options.routePattern,
  });
  const requestContext = createRequestContext({
    headersContext,
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
    return renderFn();
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
    interceptSlotKey: intercept.slotKey,
  };
}

export async function dispatchAppPage<TRoute extends AppPageDispatchRoute>(
  options: DispatchAppPageOptions<TRoute>,
): Promise<Response> {
  const route = options.route;
  const dynamicConfig = options.dynamicConfig;
  const currentRevalidateSeconds = options.revalidateSeconds;
  const isForceStatic = dynamicConfig === "force-static";
  const isDynamicError = dynamicConfig === "error";
  const isForceDynamic = dynamicConfig === "force-dynamic";

  setCurrentFetchSoftTags(buildAppPageTags(options.cleanPathname, [], route.routeSegments));

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

  if (isForceStatic || isDynamicError) {
    setHeadersContext(
      createStaticGenerationHeadersContext({
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
      isForceDynamic,
      isProduction: options.isProduction,
      isRscRequest: options.isRscRequest,
      revalidateSeconds: currentRevalidateSeconds,
      scriptNonce: options.scriptNonce,
    })
  ) {
    const cachedPageResponse = await readAppPageCacheResponse({
      cleanPathname: options.cleanPathname,
      clearRequestContext: options.clearRequestContext,
      isRscRequest: options.isRscRequest,
      isrDebug: options.isrDebug,
      isrGet: options.isrGet,
      isrHtmlKey: options.isrHtmlKey,
      isrRscKey: options.isrRscKey,
      isrSet: options.isrSet,
      mountedSlotsHeader: options.mountedSlotsHeader,
      expireSeconds: options.expireSeconds,
      // cacheLife-only routes discover their actual revalidate during the
      // fresh render; this seed only gets them into the cache read path.
      revalidateSeconds: currentRevalidateSeconds ?? 0,
      renderFreshPageForCache: async () =>
        runAppPageRevalidationContext(
          {
            cleanPathname: options.cleanPathname,
            dynamicConfig,
            params: options.params,
            routePattern: route.pattern,
            routeSegments: route.routeSegments,
            setNavigationContext: options.setNavigationContext,
          },
          async () => {
            const revalidatedElement = await options.buildPageElement(
              route,
              options.params,
              undefined,
              new URLSearchParams(),
            );
            const revalidatedOnError = options.createRscOnErrorHandler(
              options.cleanPathname,
              route.pattern,
            );
            const revalidatedRscStream = options.renderToReadableStream(revalidatedElement, {
              onError: revalidatedOnError,
            });
            const revalidatedRscCapture = teeAppPageRscStreamForCapture(revalidatedRscStream, true);
            const revalidatedSsrEntry = await options.loadSsrHandler();
            const revalidatedCapturedRscRef: { value: Promise<ArrayBuffer> | null } = {
              value: null,
            };
            const revalidatedHtmlStream = await revalidatedSsrEntry.handleSsr(
              revalidatedRscCapture.ssrStream,
              options.getNavigationContext(),
              {
                links: options.getFontLinks(),
                styles: options.getFontStyles(),
                preloads: options.getFontPreloads(),
              },
              revalidatedRscCapture.sideStream
                ? {
                    sideStream: revalidatedRscCapture.sideStream,
                    capturedRscDataRef: revalidatedCapturedRscRef,
                  }
                : undefined,
            );
            const html = await readAppPageTextStream(revalidatedHtmlStream);
            const rscData = await getCapturedRscDataPromise(revalidatedCapturedRscRef.value);
            const cacheLife = _consumeRequestScopedCacheLife();
            options.clearRequestContext();
            const tags = buildAppPageTags(
              options.cleanPathname,
              getCollectedFetchTags(),
              route.routeSegments,
            );
            return {
              html,
              rscData,
              tags,
              cacheControl:
                typeof cacheLife?.revalidate === "number"
                  ? { revalidate: cacheLife.revalidate, expire: cacheLife.expire }
                  : undefined,
            };
          },
        ),
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
    logGenerateStaticParamsError(error) {
      console.error("[vinext] generateStaticParams error:", error);
    },
    params: options.params,
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
    buildPageElement(interceptRoute, interceptParams, interceptOpts, interceptSearchParams) {
      return options.buildPageElement(
        interceptRoute,
        interceptParams,
        interceptOpts,
        interceptSearchParams,
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
    renderInterceptResponse(sourceRoute, interceptElement) {
      const interceptOnError = options.createRscOnErrorHandler(
        options.cleanPathname,
        sourceRoute.pattern,
      );
      const interceptStream = options.renderToReadableStream(interceptElement, {
        onError: interceptOnError,
      });
      const interceptHeaders = new Headers({
        "Content-Type": "text/x-component; charset=utf-8",
        Vary: "RSC, Accept",
      });
      mergeMiddlewareResponseHeaders(interceptHeaders, options.middlewareContext.headers);
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
      return options.buildPageElement(
        route,
        options.params,
        interceptResult.interceptOpts,
        options.searchParams,
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

  return renderAppPageLifecycle({
    cleanPathname: options.cleanPathname,
    clearRequestContext: options.clearRequestContext,
    consumeDynamicUsage,
    consumeInvalidDynamicUsageError,
    createRscOnErrorHandler(pathname, routePath) {
      return options.createRscOnErrorHandler(pathname, routePath);
    },
    element: pageBuildResult.element,
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
    hasLoadingBoundary: Boolean(route.loading?.default),
    isDynamicError,
    isForceDynamic,
    isForceStatic,
    isPrerender: process.env.VINEXT_PRERENDER === "1",
    isProduction: options.isProduction,
    isRscRequest: options.isRscRequest,
    isrDebug: options.isrDebug,
    isrHtmlKey: options.isrHtmlKey,
    isrRscKey: options.isrRscKey,
    isrSet: options.isrSet,
    expireSeconds: options.expireSeconds,
    layoutCount: route.layouts.length,
    loadSsrHandler: options.loadSsrHandler,
    middlewareContext: options.middlewareContext,
    params: options.params,
    probeLayoutAt(layoutIndex) {
      return options.probeLayoutAt(layoutIndex);
    },
    probePage() {
      return options.probePage();
    },
    classification: {
      getLayoutId(index) {
        const treePosition = route.layoutTreePositions?.[index] ?? 0;
        return "layout:" + createAppPageTreePath([...route.routeSegments], treePosition);
      },
      buildTimeClassifications: route.__buildTimeClassifications,
      buildTimeReasons: route.__buildTimeReasons,
      debugClassification: options.debugClassification,
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
    revalidateSeconds: currentRevalidateSeconds,
    mountedSlotsHeader: options.mountedSlotsHeader,
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

async function renderLayoutSpecialError<TRoute extends AppPageDispatchRoute>(
  options: DispatchAppPageOptions<TRoute>,
  specialError: AppPageSpecialError,
  layoutIndex: number,
): Promise<Response> {
  return buildAppPageSpecialErrorResponse({
    clearRequestContext: options.clearRequestContext,
    middlewareContext: options.middlewareContext,
    renderFallbackPage(statusCode) {
      const parentBoundary = resolveAppPageParentHttpAccessBoundaryModule({
        layoutIndex,
        rootForbiddenModule: options.rootForbiddenModule,
        rootNotFoundModule: options.rootNotFoundModule,
        rootUnauthorizedModule: options.rootUnauthorizedModule,
        routeForbiddenModules: options.route.forbiddens,
        routeNotFoundModules: options.route.notFounds,
        routeUnauthorizedModules: options.route.unauthorizeds,
        statusCode,
      })?.default;
      return options.renderHttpAccessFallbackPage(
        statusCode,
        {
          boundaryComponent: parentBoundary,
          layouts: options.route.layouts.slice(0, layoutIndex),
          matchedParams: options.params,
        },
        null,
      );
    },
    requestUrl: options.request.url,
    specialError,
  });
}

async function renderPageSpecialError<TRoute extends AppPageDispatchRoute>(
  options: DispatchAppPageOptions<TRoute>,
  specialError: AppPageSpecialError,
): Promise<Response> {
  return buildAppPageSpecialErrorResponse({
    clearRequestContext: options.clearRequestContext,
    middlewareContext: options.middlewareContext,
    renderFallbackPage(statusCode) {
      return options.renderHttpAccessFallbackPage(
        statusCode,
        { matchedParams: options.params },
        null,
      );
    },
    requestUrl: options.request.url,
    specialError,
  });
}
