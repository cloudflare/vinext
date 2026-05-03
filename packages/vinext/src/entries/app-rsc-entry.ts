/**
 * App Router RSC entry generator.
 *
 * Generates the virtual RSC entry module for the App Router.
 * The RSC entry does route matching and renders the component tree,
 * then delegates to the SSR entry for HTML generation.
 *
 * Previously housed in server/app-dev-server.ts.
 */
import { buildAppRscManifestCode } from "./app-rsc-manifest.js";
import { resolveEntryPath } from "./runtime-entry-module.js";
import type {
  NextHeader,
  NextI18nConfig,
  NextRedirect,
  NextRewrite,
} from "../config/next-config.js";
import type { AppRoute } from "../routing/app-router.js";
import { generateDevOriginCheckCode } from "../server/dev-origin-check.js";
import type { MetadataFileRoute } from "../server/metadata-routes.js";
import { isProxyFile } from "../server/middleware.js";

const DEFAULT_EXPIRE_TIME = 31_536_000;

// Pre-computed absolute paths for generated-code imports. The virtual RSC
// entry can't use relative imports (it has no real file location), so we
// resolve these at code-generation time and embed them as absolute paths.
const middlewareRequestHeadersPath = resolveEntryPath(
  "../server/middleware-request-headers.js",
  import.meta.url,
);
const normalizePathModulePath = resolveEntryPath("../server/normalize-path.js", import.meta.url);
const appRscHandlerPath = resolveEntryPath("../server/app-rsc-handler.js", import.meta.url);
const appRouteHandlerDispatchPath = resolveEntryPath(
  "../server/app-route-handler-dispatch.js",
  import.meta.url,
);
const appServerActionExecutionPath = resolveEntryPath(
  "../server/app-server-action-execution.js",
  import.meta.url,
);
const appRscErrorsPath = resolveEntryPath("../server/app-rsc-errors.js", import.meta.url);
const appPageExecutionPath = resolveEntryPath("../server/app-page-execution.js", import.meta.url);
const appFallbackRendererPath = resolveEntryPath(
  "../server/app-fallback-renderer.js",
  import.meta.url,
);
const appElementsPath = resolveEntryPath("../server/app-elements.js", import.meta.url);
const appPageRouteWiringPath = resolveEntryPath(
  "../server/app-page-route-wiring.js",
  import.meta.url,
);
const appPageHeadPath = resolveEntryPath("../server/app-page-head.js", import.meta.url);
const appPageParamsPath = resolveEntryPath("../server/app-page-params.js", import.meta.url);
const appPageDispatchPath = resolveEntryPath("../server/app-page-dispatch.js", import.meta.url);
const appPageRequestPath = resolveEntryPath("../server/app-page-request.js", import.meta.url);
const appSegmentConfigPath = resolveEntryPath("../server/app-segment-config.js", import.meta.url);
const appRscRouteMatchingPath = resolveEntryPath(
  "../server/app-rsc-route-matching.js",
  import.meta.url,
);
const rscStreamHintsPath = resolveEntryPath("../server/rsc-stream-hints.js", import.meta.url);
const isrCachePath = resolveEntryPath("../server/isr-cache.js", import.meta.url);
const thenableParamsShimPath = resolveEntryPath("../shims/thenable-params.js", import.meta.url);
const appPageElementBuilderPath = resolveEntryPath(
  "../server/app-page-element-builder.js",
  import.meta.url,
);
const instrumentationRuntimePath = resolveEntryPath(
  "../server/instrumentation-runtime.js",
  import.meta.url,
);
const appRscErrorHandlerPath = resolveEntryPath(
  "../server/app-rsc-error-handler.js",
  import.meta.url,
);
const appRequestContextPath = resolveEntryPath("../server/app-request-context.js", import.meta.url);
const appHookWarningSuppressionPath = resolveEntryPath(
  "../server/app-hook-warning-suppression.js",
  import.meta.url,
);

/**
 * Resolved config options relevant to App Router request handling.
 * Passed from the Vite plugin where the full next.config.js is loaded.
 */
type AppRouterConfig = {
  redirects?: NextRedirect[];
  rewrites?: {
    beforeFiles: NextRewrite[];
    afterFiles: NextRewrite[];
    fallback: NextRewrite[];
  };
  headers?: NextHeader[];
  /** Extra origins allowed for server action CSRF checks (from experimental.serverActions.allowedOrigins). */
  allowedOrigins?: string[];
  /** Extra origins allowed for dev server access (from allowedDevOrigins). */
  allowedDevOrigins?: string[];
  /** Body size limit for server actions in bytes (from experimental.serverActions.bodySizeLimit). */
  bodySizeLimit?: number;
  /** Route-level expire fallback in seconds for ISR entries with numeric revalidate. */
  expireTime?: number;
  /** Internationalization routing config for middleware matcher locale handling. */
  i18n?: NextI18nConfig | null;
  /**
   * When true, the project has a `pages/` directory alongside the App Router.
   * The generated RSC entry exposes `/__vinext/prerender/pages-static-paths`
   * so `prerenderPages` can call `getStaticPaths` via `wrangler unstable_startWorker`
   * in CF Workers builds. `pageRoutes` is loaded from the SSR environment via
   * `import("./ssr/index.js")`, which re-exports it from
   * `virtual:vinext-server-entry` when this flag is set.
   */
  hasPagesDir?: boolean;
  /** Exact public/ file routes, using normalized leading-slash pathnames. */
  publicFiles?: string[];
};

/**
 * Generate the virtual RSC entry module.
 *
 * This runs in the `rsc` Vite environment (react-server condition).
 * It matches the incoming request URL to an app route, builds the
 * nested layout + page tree, and renders it to an RSC stream.
 */
export function generateRscEntry(
  appDir: string,
  routes: AppRoute[],
  middlewarePath?: string | null,
  metadataRoutes?: MetadataFileRoute[],
  globalErrorPath?: string | null,
  basePath?: string,
  trailingSlash?: boolean,
  config?: AppRouterConfig,
  instrumentationPath?: string | null,
): string {
  const bp = basePath ?? "";
  const ts = trailingSlash ?? false;
  const redirects = config?.redirects ?? [];
  const rewrites = config?.rewrites ?? { beforeFiles: [], afterFiles: [], fallback: [] };
  const headers = config?.headers ?? [];
  const allowedOrigins = config?.allowedOrigins ?? [];
  const bodySizeLimit = config?.bodySizeLimit ?? 1 * 1024 * 1024;
  const expireTime = config?.expireTime ?? DEFAULT_EXPIRE_TIME;
  const i18nConfig = config?.i18n ?? null;
  const hasPagesDir = config?.hasPagesDir ?? false;
  const publicFiles = config?.publicFiles ?? [];
  const manifestCode = buildAppRscManifestCode({ routes, metadataRoutes, globalErrorPath });
  const {
    imports,
    routeEntries,
    metaRouteEntries,
    generateStaticParamsEntries,
    rootNotFoundVar,
    rootForbiddenVar,
    rootUnauthorizedVar,
    rootLayoutVars,
    globalErrorVar,
  } = manifestCode;
  const loadPrerenderPagesRoutesCode = hasPagesDir
    ? `
async function __loadPrerenderPagesRoutes() {
  const __gspSsrEntry = await import.meta.viteRsc.loadModule("ssr", "index");
  return __gspSsrEntry.pageRoutes;
}
`
    : "";

  return `
import {
  renderToReadableStream as _renderToReadableStream,
  decodeAction,
  decodeReply,
  loadServerAction,
  createTemporaryReferenceSet,
} from "@vitejs/plugin-rsc/rsc";
import { createRscRenderer } from ${JSON.stringify(rscStreamHintsPath)};

const renderToReadableStream = createRscRenderer(_renderToReadableStream);
import { createElement } from "react";
import { getNavigationContext as _getNavigationContext } from "next/navigation";
import { headersContextFromRequest, getDraftModeCookieHeader, getAndClearPendingCookies, consumeDynamicUsage, consumeInvalidDynamicUsageError, setHeadersAccessPhase } from "next/headers";
import { mergeMetadata, resolveModuleMetadata, mergeViewport, resolveModuleViewport } from "vinext/metadata";
${middlewarePath ? `import * as middlewareModule from ${JSON.stringify(middlewarePath.replace(/\\/g, "/"))};` : ""}
${
  instrumentationPath
    ? `import * as _instrumentation from ${JSON.stringify(instrumentationPath.replace(/\\/g, "/"))};
import { ensureInstrumentationRegistered as __ensureInstrumentationRegistered } from ${JSON.stringify(instrumentationRuntimePath)};`
    : ""
}
import { createAppRscHandler as __createAppRscHandler } from ${JSON.stringify(appRscHandlerPath)};
import { decodePathParams as __decodePathParams } from ${JSON.stringify(normalizePathModulePath)};
import { buildRequestHeadersFromMiddlewareResponse as __buildRequestHeadersFromMiddlewareResponse } from ${JSON.stringify(middlewareRequestHeadersPath)};
import {
  dispatchAppRouteHandler as __dispatchAppRouteHandler,
} from ${JSON.stringify(appRouteHandlerDispatchPath)};
import {
  handleProgressiveServerActionRequest as __handleProgressiveServerActionRequest,
  handleServerActionRscRequest as __handleServerActionRscRequest,
  readActionBodyWithLimit as __readBodyWithLimit,
  readActionFormDataWithLimit as __readFormDataWithLimit,
} from ${JSON.stringify(appServerActionExecutionPath)};
import {
  sanitizeErrorForClient as __sanitizeErrorForClient,
} from ${JSON.stringify(appRscErrorsPath)};
import { createAppRscOnErrorHandler } from ${JSON.stringify(appRscErrorHandlerPath)};
import {
  buildAppPageFontLinkHeader as __buildAppPageFontLinkHeader,
  resolveAppPageSpecialError as __resolveAppPageSpecialError,
} from ${JSON.stringify(appPageExecutionPath)};
import {
  createAppFallbackRenderer as __createAppFallbackRenderer,
} from ${JSON.stringify(appFallbackRendererPath)};
import {
  APP_INTERCEPTION_CONTEXT_KEY as __APP_INTERCEPTION_CONTEXT_KEY,
  createAppPayloadRouteId as __createAppPayloadRouteId,
} from ${JSON.stringify(appElementsPath)};
import {
  resolveAppPageChildSegments as __resolveAppPageChildSegments,
} from ${JSON.stringify(appPageRouteWiringPath)};
import { buildPageElements as __buildPageElements } from ${JSON.stringify(appPageElementBuilderPath)};
import {
  resolveAppPageSegmentParams as __resolveAppPageSegmentParams,
} from ${JSON.stringify(appPageParamsPath)};
import {
  collectAppPageSearchParams as __collectAppPageSearchParams,
} from ${JSON.stringify(appPageHeadPath)};
import {
  dispatchAppPage as __dispatchAppPage,
} from ${JSON.stringify(appPageDispatchPath)};
import {
  resolveAppPageGenerateStaticParamsSources as __resolveAppPageGenerateStaticParamsSources,
} from ${JSON.stringify(appPageRequestPath)};
import {
  resolveAppPageFetchCacheMode as __resolveAppPageFetchCacheMode,
  resolveAppPageSegmentConfig as __resolveAppPageSegmentConfig,
} from ${JSON.stringify(appSegmentConfigPath)};
import { makeThenableParams } from ${JSON.stringify(thenableParamsShimPath)};
import {
  createAppRscRouteMatcher as __createAppRscRouteMatcher,
} from ${JSON.stringify(appRscRouteMatchingPath)};
import {
  appIsrHtmlKey as __isrHtmlKey,
  appIsrRscKey as __isrRscKey,
  appIsrRouteKey as __isrRouteKey,
  isrGet as __isrGet,
  isrSet as __isrSet,
  triggerBackgroundRegeneration as __triggerBackgroundRegeneration,
} from ${JSON.stringify(isrCachePath)};
// Import server-only state module to register ALS-backed accessors.
import "vinext/navigation-state";
import { reportRequestError as _reportRequestError } from "vinext/instrumentation";
import { getSSRFontLinks as _getSSRFontLinks, getSSRFontStyles as _getSSRFontStylesGoogle, getSSRFontPreloads as _getSSRFontPreloadsGoogle } from "next/font/google";
import { getSSRFontStyles as _getSSRFontStylesLocal, getSSRFontPreloads as _getSSRFontPreloadsLocal } from "next/font/local";
function _getSSRFontStyles() { return [..._getSSRFontStylesGoogle(), ..._getSSRFontStylesLocal()]; }
function _getSSRFontPreloads() { return [..._getSSRFontPreloadsGoogle(), ..._getSSRFontPreloadsLocal()]; }
${hasPagesDir ? `// Pages Router routes are loaded lazily from the SSR environment for internal prerender requests.` : ""}

// Suppress expected "Invalid hook call" dev warning when layout/page
// components are probed outside React's render cycle. The import patches
// console.error once at module load (side-effect) and exposes the ALS
// so per-route dispatch can opt into suppression via .run(true, ...).
import { suppressHookWarningAls } from ${JSON.stringify(appHookWarningSuppressionPath)};
import { clearAppRequestContext as __clearRequestContext, setAppNavigationContext as setNavigationContext } from ${JSON.stringify(appRequestContextPath)};

// Note: cache entries are written with \`headers: undefined\`. Next.js stores
// response headers (e.g. set-cookie from cookies().set() during render) in the
// cache entry so they can be replayed on HIT. We don't do this because:
//   1. Pages that call cookies().set() during render trigger dynamicUsedDuringRender,
//      which opts them out of ISR caching before we reach the write path.
//   2. Custom response headers set via next/headers are not yet captured separately
//      from the live Response object in vinext's server pipeline.
// In practice this means ISR-cached responses won't replay render-time set-cookie
// headers — but that case is already prevented by the dynamic-usage opt-out.
// TODO: capture render-time response headers for full Next.js parity.
// Verbose cache logging — opt in with NEXT_PRIVATE_DEBUG_CACHE=1.
// Matches the env var Next.js uses for its own cache debug output so operators
// have a single knob for all cache tracing.
const __isrDebug = process.env.NEXT_PRIVATE_DEBUG_CACHE
  ? console.debug.bind(console, "[vinext] ISR:")
  : undefined;

// Classification debug — opt in with VINEXT_DEBUG_CLASSIFICATION=1. Gated on
// the env var so the hot path pays no overhead unless an operator is actively
// tracing why a layout was flagged static or dynamic. The reason payload is
// carried by __VINEXT_CLASS_REASONS and consumed inside probeAppPageLayouts.
const __classDebug = process.env.VINEXT_DEBUG_CLASSIFICATION
  ? function(layoutId, reason) {
      console.debug("[vinext] CLS:", layoutId, reason);
    }
  : undefined;

function __resolveRouteFetchCacheMode(route) {
  return __resolveAppPageFetchCacheMode({
    layouts: route.layouts,
    page: route.page,
  });
}

${imports.join("\n")}

${
  instrumentationPath
    ? `// Lazy instrumentation initialisation is handled by ensureInstrumentationRegistered
// (imported from vinext/instrumentation-runtime). The generated entry only passes
// the user module in; all bookkeeping (initialized flag, shared promise, prerender
// skip) lives in the typed helper so it can be unit-tested independently.`
    : ""
}

// Build-time layout classification dispatch. Replaced in generateBundle
// with a switch statement that returns a pre-computed per-layout
// Map<layoutIndex, "static" | "dynamic"> for each route. Until the
// plugin patches this stub, every route falls back to the Layer 3
// runtime probe, which is the current (slow) behaviour.
function __VINEXT_CLASS(routeIdx) {
  return null;
}

// Build-time layout classification reasons dispatch. Sibling of
// __VINEXT_CLASS, returning a per-route Map<layoutIndex, ClassificationReason>
// that feeds the debug channel when VINEXT_DEBUG_CLASSIFICATION is active.
// Replaced in generateBundle with a real dispatch table; the stub returns
// null so the hot path never allocates reason maps when debug is off.
function __VINEXT_CLASS_REASONS(routeIdx) {
  return null;
}

const routes = [
${routeEntries.join(",\n")}
];
const __routeMatcher = __createAppRscRouteMatcher(routes);

const metadataRoutes = [
${metaRouteEntries.join(",\n")}
];

const rootNotFoundModule = ${rootNotFoundVar ? rootNotFoundVar : "null"};
const rootForbiddenModule = ${rootForbiddenVar ? rootForbiddenVar : "null"};
const rootUnauthorizedModule = ${rootUnauthorizedVar ? rootUnauthorizedVar : "null"};
const rootLayouts = [${rootLayoutVars.join(", ")}];

const createRscOnErrorHandler = (request, pathname, routePath) =>
  createAppRscOnErrorHandler(_reportRequestError, request, pathname, routePath);

const __fallbackRenderer = __createAppFallbackRenderer({
  rootBoundaries: {
    rootForbiddenModule,
    rootLayouts,
    rootNotFoundModule,
    rootUnauthorizedModule,
  },
  globalErrorModule: ${globalErrorVar ? globalErrorVar : "null"},
  metadataRoutes,
  ssrLoader() {
    return import.meta.viteRsc.loadModule("ssr", "index");
  },
  fontProviders: {
    buildFontLinkHeader: __buildAppPageFontLinkHeader,
    getFontLinks: _getSSRFontLinks,
    getFontPreloads: _getSSRFontPreloads,
    getFontStyles: _getSSRFontStyles,
  },
  makeThenableParams,
  sanitizer: __sanitizeErrorForClient,
  rscRenderer: renderToReadableStream,
  getNavigationContext: _getNavigationContext,
  resolveChildSegments: __resolveAppPageChildSegments,
  clearRequestContext() {
    __clearRequestContext();
  },
  createRscOnErrorHandler(request, pathname, routePath) {
    return createRscOnErrorHandler(request, pathname, routePath);
  },
});

function matchRoute(url) {
  return __routeMatcher.matchRoute(url);
}

/**
 * Check if a pathname matches any intercepting route.
 * Returns the match info or null.
 */
function findIntercept(pathname, sourcePathname = null) {
  return __routeMatcher.findIntercept(pathname, sourcePathname);
}

async function buildPageElements(route, params, routePath, pageRequest) {
  return __buildPageElements({
    route,
    params,
    routePath,
    pageRequest,
    globalErrorModule: ${globalErrorVar ? globalErrorVar : "null"},
    rootNotFoundModule: ${rootNotFoundVar ? rootNotFoundVar : "null"},
    rootForbiddenModule: ${rootForbiddenVar ? rootForbiddenVar : "null"},
    rootUnauthorizedModule: ${rootUnauthorizedVar ? rootUnauthorizedVar : "null"},
    metadataRoutes,
  });
}

const __basePath = ${JSON.stringify(bp)};
const __trailingSlash = ${JSON.stringify(ts)};
const __i18nConfig = ${JSON.stringify(i18nConfig)};
const __configRedirects = ${JSON.stringify(redirects)};
const __configRewrites = ${JSON.stringify(rewrites)};
const __configHeaders = ${JSON.stringify(headers)};
const __publicFiles = new Set(${JSON.stringify(publicFiles)});
const __allowedOrigins = ${JSON.stringify(allowedOrigins)};
const __expireTime = ${JSON.stringify(expireTime)};

${generateDevOriginCheckCode(config?.allowedDevOrigins)}

/**
 * Maximum server-action request body size.
 * Configurable via experimental.serverActions.bodySizeLimit in next.config.
 * Defaults to 1MB, matching the Next.js default.
 * @see https://nextjs.org/docs/app/api-reference/config/next-config-js/serverActions#bodysizelimit
 * Prevents unbounded request body buffering.
 */
var __MAX_ACTION_BODY_SIZE = ${JSON.stringify(bodySizeLimit)};

// Map from route pattern to generateStaticParams function.
// Used by the prerender phase to enumerate dynamic route URLs without
// loading route modules via the dev server.
export const generateStaticParamsMap = {
// TODO: layout-level generateStaticParams — this map only includes routes that
// have a pagePath (leaf pages). Layout segments can also export generateStaticParams
// to provide parent params for nested dynamic routes, but they don't have a pagePath
// so they are excluded here. Supporting layout-level generateStaticParams requires
// scanning layout.tsx files separately and including them in this map.
${generateStaticParamsEntries.join("\n")}
};${loadPrerenderPagesRoutesCode}
const rootParamNamesMap = {
${routes
  .filter((r) => r.isDynamic && r.pagePath && r.rootParamNames && r.rootParamNames.length > 0)
  .map((r) => `  ${JSON.stringify(r.pattern)}: ${JSON.stringify(r.rootParamNames)},`)
  .join("\n")}
};

export default __createAppRscHandler({
  basePath: __basePath,
  clearRequestContext() {
    __clearRequestContext();
  },
  configHeaders: __configHeaders,
  configRedirects: __configRedirects,
  configRewrites: __configRewrites,
  dispatchMatchedPage({
    cleanPathname,
    handlerStart,
    interceptionContext,
    isRscRequest,
    middlewareContext,
    mountedSlotsHeader,
    params,
    request,
    route,
    scriptNonce,
    searchParams,
  }) {
    const PageComponent = route.page?.default;
    const __segmentConfig = __resolveAppPageSegmentConfig({
      layouts: route.layouts,
      page: route.page,
    });
    const __generateStaticParams = __resolveAppPageGenerateStaticParamsSources({
      layouts: route.layouts,
      layoutTreePositions: route.layoutTreePositions,
      page: route.page,
      routeSegments: route.routeSegments,
    });
    const _asyncRouteParams = makeThenableParams(params);
    return __dispatchAppPage({
      buildPageElement(targetRoute, targetParams, targetOpts, targetSearchParams) {
        return buildPageElements(targetRoute, targetParams, cleanPathname, {
          opts: targetOpts,
          searchParams: targetSearchParams,
          isRscRequest,
          request,
          mountedSlotsHeader,
        });
      },
      cleanPathname,
      clearRequestContext() {
        __clearRequestContext();
      },
      createRscOnErrorHandler(pathname, routePath) {
        return createRscOnErrorHandler(request, pathname, routePath);
      },
      debugClassification: __classDebug,
      dynamicConfig: __segmentConfig.dynamicConfig,
      dynamicParamsConfig: __segmentConfig.dynamicParamsConfig,
      fetchCache: __segmentConfig.fetchCache ?? null,
      findIntercept(pathname) {
        return findIntercept(pathname, interceptionContext);
      },
      generateStaticParams: __generateStaticParams,
      getFontLinks: _getSSRFontLinks,
      getFontPreloads: _getSSRFontPreloads,
      getFontStyles: _getSSRFontStyles,
      getNavigationContext: _getNavigationContext,
      getSourceRoute(sourceRouteIndex) {
        return routes[sourceRouteIndex];
      },
      hasGenerateStaticParams: __generateStaticParams.length > 0,
      hasPageDefaultExport: !!PageComponent,
      hasPageModule: !!route.page,
      handlerStart,
      interceptionContext,
      expireSeconds: __expireTime,
      isProduction: process.env.NODE_ENV === "production",
      isRscRequest,
      isrDebug: __isrDebug,
      isrGet: __isrGet,
      isrHtmlKey: __isrHtmlKey,
      isrRscKey: __isrRscKey,
      isrSet: __isrSet,
      loadSsrHandler() {
        return import.meta.viteRsc.loadModule("ssr", "index");
      },
      middlewareContext,
      mountedSlotsHeader,
      params,
      probeLayoutAt(li) {
        const LayoutComp = route.layouts[li]?.default;
        if (!LayoutComp) return null;
        return LayoutComp({
          params: makeThenableParams(__resolveAppPageSegmentParams(
            route.routeSegments,
            route.layoutTreePositions?.[li] ?? 0,
            params,
          )),
          children: null,
        });
      },
      probePage() {
        if (!PageComponent) return null;
        const _asyncSearchParams = makeThenableParams(
          __collectAppPageSearchParams(searchParams).searchParamsObject,
        );
        return PageComponent({ params: _asyncRouteParams, searchParams: _asyncSearchParams });
      },
      renderErrorBoundaryPage(renderErr) {
        return __fallbackRenderer.renderErrorBoundary(route, renderErr, isRscRequest, request, params, scriptNonce, middlewareContext);
      },
      renderHttpAccessFallbackPage(statusCode, opts, currentMiddlewareContext) {
        return __fallbackRenderer.renderHttpAccessFallback(route, statusCode, isRscRequest, request, opts, scriptNonce, currentMiddlewareContext);
      },
      renderToReadableStream,
      request,
      revalidateSeconds: __segmentConfig.revalidateSeconds,
      resolveRouteFetchCacheMode(targetRoute) {
        return __resolveRouteFetchCacheMode(targetRoute);
      },
      rootForbiddenModule,
      rootNotFoundModule,
      rootUnauthorizedModule,
      route,
      runWithSuppressedHookWarning(probe) {
        return suppressHookWarningAls.run(true, probe);
      },
      scheduleBackgroundRegeneration(key, renderFn, errorContext) {
        __triggerBackgroundRegeneration(key, renderFn, errorContext);
      },
      scriptNonce,
      searchParams,
      setNavigationContext,
    });
  },
  dispatchMatchedRouteHandler({
    cleanPathname,
    middlewareContext,
    params,
    request,
    route,
    searchParams,
  }) {
    return __dispatchAppRouteHandler({
      basePath: __basePath,
      cleanPathname,
      clearRequestContext() {
        __clearRequestContext();
      },
      i18n: __i18nConfig,
      isrDebug: __isrDebug,
      isrGet: __isrGet,
      isrRouteKey: __isrRouteKey,
      isrSet: __isrSet,
      middlewareContext,
      middlewareRequestHeaders: middlewareContext.requestHeaders,
      params,
      request,
      route: {
        pattern: route.pattern,
        routeHandler: route.routeHandler,
        routeSegments: route.routeSegments,
      },
      scheduleBackgroundRegeneration: __triggerBackgroundRegeneration,
      searchParams,
    });
  },
  ${
    instrumentationPath
      ? `ensureInstrumentation() {
    return __ensureInstrumentationRegistered(_instrumentation);
  },`
      : ""
  }
  handleProgressiveActionRequest({
    actionId,
    cleanPathname,
    contentType,
    middlewareContext,
    request,
  }) {
    return __handleProgressiveServerActionRequest({
      actionId,
      allowedOrigins: __allowedOrigins,
      cleanPathname,
      clearRequestContext() {
        __clearRequestContext();
      },
      contentType,
      decodeAction,
      getAndClearPendingCookies,
      getDraftModeCookieHeader,
      maxActionBodySize: __MAX_ACTION_BODY_SIZE,
      middlewareHeaders: middlewareContext.headers,
      readFormDataWithLimit: __readFormDataWithLimit,
      reportRequestError: _reportRequestError,
      request,
      setHeadersAccessPhase,
    });
  },
  handleServerActionRequest({
    actionId,
    cleanPathname,
    contentType,
    interceptionContext,
    isRscRequest,
    middlewareContext,
    mountedSlotsHeader,
    request,
    searchParams,
  }) {
    return __handleServerActionRscRequest({
      actionId,
      allowedOrigins: __allowedOrigins,
      buildPageElement({
        route: actionRoute,
        params: actionParams,
        cleanPathname: actionCleanPathname,
        interceptOpts,
        searchParams: actionSearchParams,
        isRscRequest: actionIsRscRequest,
        request: actionRequest,
        mountedSlotsHeader: actionMountedSlotsHeader,
      }) {
        return buildPageElements(actionRoute, actionParams, actionCleanPathname, {
          opts: interceptOpts,
          searchParams: actionSearchParams,
          isRscRequest: actionIsRscRequest,
          request: actionRequest,
          mountedSlotsHeader: actionMountedSlotsHeader,
        });
      },
      cleanPathname,
      clearRequestContext() {
        __clearRequestContext();
      },
      contentType,
      createNotFoundElement(actionRouteId) {
        return {
          [__APP_INTERCEPTION_CONTEXT_KEY]: null,
          __route: actionRouteId,
          __rootLayout: null,
          [actionRouteId]: createElement("div", null, "Page not found"),
        };
      },
      createPayloadRouteId(pathnameToRender, currentInterceptionContext) {
        return __createAppPayloadRouteId(pathnameToRender, currentInterceptionContext);
      },
      createRscOnErrorHandler(actionRequest, actionPathname, routePattern) {
        return createRscOnErrorHandler(actionRequest, actionPathname, routePattern);
      },
      createTemporaryReferenceSet,
      decodeReply,
      findIntercept(pathnameToMatch) {
        return findIntercept(pathnameToMatch, interceptionContext);
      },
      getAndClearPendingCookies,
      getDraftModeCookieHeader,
      getRouteParamNames(sourceRoute) {
        return sourceRoute.params;
      },
      getSourceRoute(sourceRouteIndex) {
        return routes[sourceRouteIndex];
      },
      isRscRequest,
      loadServerAction,
      matchRoute(pathnameToMatch) {
        return matchRoute(pathnameToMatch);
      },
      maxActionBodySize: __MAX_ACTION_BODY_SIZE,
      middlewareHeaders: middlewareContext.headers,
      middlewareStatus: middlewareContext.status,
      mountedSlotsHeader,
      readBodyWithLimit: __readBodyWithLimit,
      readFormDataWithLimit: __readFormDataWithLimit,
      renderToReadableStream,
      reportRequestError: _reportRequestError,
      request,
      sanitizeErrorForClient(error) {
        return __sanitizeErrorForClient(error);
      },
      searchParams,
      setHeadersAccessPhase,
      setNavigationContext,
      toInterceptOpts(intercept) {
        return {
          interceptionContext,
          interceptLayouts: intercept.interceptLayouts,
          interceptSlotKey: intercept.slotKey,
          interceptPage: intercept.page,
          interceptParams: intercept.matchedParams,
        };
      },
    });
  },
  i18nConfig: __i18nConfig,
  isMiddlewareProxy: ${JSON.stringify(middlewarePath ? isProxyFile(middlewarePath) : false)},
  ${hasPagesDir ? `loadPrerenderPagesRoutes: __loadPrerenderPagesRoutes,` : ""}
  makeThenableParams,
  matchRoute,
  metadataRoutes,
  middlewareModule: ${middlewarePath ? "middlewareModule" : "null"},
  publicFiles: __publicFiles,
  renderNotFound({ isRscRequest, matchedParams, middlewareContext, request, route, scriptNonce }) {
    return __fallbackRenderer.renderNotFound(route, isRscRequest, request, matchedParams, scriptNonce, middlewareContext);
  },
  ${
    hasPagesDir
      ? `async renderPagesFallback({ isRscRequest, middlewareContext, request, url }) {
    if (isRscRequest) return null;

    const __pagesEntry = await import.meta.viteRsc.loadModule("ssr", "index");
    if (typeof __pagesEntry.renderPage !== "function") return null;

    const __pagesRequestHeaders = middlewareContext.requestHeaders
      ? __buildRequestHeadersFromMiddlewareResponse(request.headers, middlewareContext.requestHeaders)
      : null;
    const __pagesRequest = __pagesRequestHeaders
      ? new Request(request.url, { method: request.method, headers: __pagesRequestHeaders })
      : request;
    const __pagesRes = await __pagesEntry.renderPage(
      __pagesRequest,
      __decodePathParams(url.pathname) + (url.search || ""),
      {},
      undefined,
      middlewareContext.requestHeaders,
    );
    return __pagesRes.status !== 404 ? __pagesRes : null;
  },`
      : ""
  }
  rootParamNamesByPattern: rootParamNamesMap,
  setNavigationContext,
  staticParamsMap: generateStaticParamsMap,
  trailingSlash: __trailingSlash,
  validateDevRequestOrigin: __validateDevRequestOrigin,
});

if (import.meta.hot) {
  import.meta.hot.accept();
}
`;
}
