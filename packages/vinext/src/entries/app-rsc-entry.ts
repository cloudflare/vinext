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

// Pre-computed absolute paths for generated-code imports. The virtual RSC
// entry can't use relative imports (it has no real file location), so we
// resolve these at code-generation time and embed them as absolute paths.
const configMatchersPath = resolveEntryPath("../config/config-matchers.js", import.meta.url);
const requestPipelinePath = resolveEntryPath("../server/request-pipeline.js", import.meta.url);
const appMiddlewarePath = resolveEntryPath("../server/app-middleware.js", import.meta.url);
const middlewareRequestHeadersPath = resolveEntryPath(
  "../server/middleware-request-headers.js",
  import.meta.url,
);
const requestContextShimPath = resolveEntryPath("../shims/request-context.js", import.meta.url);
const normalizePathModulePath = resolveEntryPath("../server/normalize-path.js", import.meta.url);
const routingUtilsPath = resolveEntryPath("../routing/utils.js", import.meta.url);
const appRouteHandlerDispatchPath = resolveEntryPath(
  "../server/app-route-handler-dispatch.js",
  import.meta.url,
);
const appServerActionExecutionPath = resolveEntryPath(
  "../server/app-server-action-execution.js",
  import.meta.url,
);
const appRscErrorsPath = resolveEntryPath("../server/app-rsc-errors.js", import.meta.url);
const implicitTagsPath = resolveEntryPath("../server/implicit-tags.js", import.meta.url);
const appPageCachePath = resolveEntryPath("../server/app-page-cache.js", import.meta.url);
const appPageExecutionPath = resolveEntryPath("../server/app-page-execution.js", import.meta.url);
const appPageBoundaryPath = resolveEntryPath("../server/app-page-boundary.js", import.meta.url);
const appPageBoundaryRenderPath = resolveEntryPath(
  "../server/app-page-boundary-render.js",
  import.meta.url,
);
const appElementsPath = resolveEntryPath("../server/app-elements.js", import.meta.url);
const appPageRouteWiringPath = resolveEntryPath(
  "../server/app-page-route-wiring.js",
  import.meta.url,
);
const appPageHeadPath = resolveEntryPath("../server/app-page-head.js", import.meta.url);
const appPageParamsPath = resolveEntryPath("../server/app-page-params.js", import.meta.url);
const appPageRenderPath = resolveEntryPath("../server/app-page-render.js", import.meta.url);
const appPageResponsePath = resolveEntryPath("../server/app-page-response.js", import.meta.url);
const cspPath = resolveEntryPath("../server/csp.js", import.meta.url);
const appPageRequestPath = resolveEntryPath("../server/app-page-request.js", import.meta.url);
const appPageMethodPath = resolveEntryPath("../server/app-page-method.js", import.meta.url);
const appStaticGenerationPath = resolveEntryPath(
  "../server/app-static-generation.js",
  import.meta.url,
);
const appRscRouteMatchingPath = resolveEntryPath(
  "../server/app-rsc-route-matching.js",
  import.meta.url,
);
const appPrerenderEndpointsPath = resolveEntryPath(
  "../server/app-prerender-endpoints.js",
  import.meta.url,
);
const prerenderWorkUnitSetupPath = resolveEntryPath(
  "../server/prerender-work-unit-setup.js",
  import.meta.url,
);
const rscStreamHintsPath = resolveEntryPath("../server/rsc-stream-hints.js", import.meta.url);
const isrCachePath = resolveEntryPath("../server/isr-cache.js", import.meta.url);
const rootParamsShimPath = resolveEntryPath("../shims/root-params.js", import.meta.url);
const thenableParamsShimPath = resolveEntryPath("../shims/thenable-params.js", import.meta.url);
const metadataRouteResponsePath = resolveEntryPath(
  "../server/metadata-route-response.js",
  import.meta.url,
);
const errorCausePath = resolveEntryPath("../utils/error-cause.js", import.meta.url);

/**
 * Resolved config options relevant to App Router request handling.
 * Passed from the Vite plugin where the full next.config.js is loaded.
 */
export type AppRouterConfig = {
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
  const prerenderPagesLoaderOption = hasPagesDir
    ? "    loadPagesRoutes: __loadPrerenderPagesRoutes,\n"
    : "";

  return `
import {
  renderToReadableStream as _renderToReadableStream,
  decodeAction,
  decodeReply,
  loadServerAction,
  createTemporaryReferenceSet,
} from "@vitejs/plugin-rsc/rsc";
import { AsyncLocalStorage } from "node:async_hooks";

import {
  normalizeReactFlightPreloadHints as __normalizeReactFlightPreloadHints,
} from ${JSON.stringify(rscStreamHintsPath)};

function renderToReadableStream(model, options) {
  return __normalizeReactFlightPreloadHints(_renderToReadableStream(model, options));
}
import { createElement } from "react";
import { setNavigationContext as _setNavigationContextOrig, getNavigationContext as _getNavigationContext } from "next/navigation";
import { setHeadersContext, headersContextFromRequest, getDraftModeCookieHeader, getAndClearPendingCookies, consumeDynamicUsage, consumeInvalidDynamicUsageError, markDynamicUsage, getHeadersContext, setHeadersAccessPhase } from "next/headers";
import { mergeMetadata, resolveModuleMetadata, mergeViewport, resolveModuleViewport } from "vinext/metadata";
${middlewarePath ? `import * as middlewareModule from ${JSON.stringify(middlewarePath.replace(/\\/g, "/"))};` : ""}
${instrumentationPath ? `import * as _instrumentation from ${JSON.stringify(instrumentationPath.replace(/\\/g, "/"))};` : ""}
import { handleMetadataRouteRequest as __handleMetadataRouteRequest } from ${JSON.stringify(metadataRouteResponsePath)};
import { requestContextFromRequest, normalizeHost, matchRedirect, matchRewrite, isExternalUrl, proxyExternalRequest, sanitizeDestination } from ${JSON.stringify(configMatchersPath)};
import { decodePathParams as __decodePathParams, normalizePath as __normalizePath } from ${JSON.stringify(normalizePathModulePath)};
import { normalizePathnameForRouteMatch as __normalizePathnameForRouteMatch, normalizePathnameForRouteMatchStrict as __normalizePathnameForRouteMatchStrict } from ${JSON.stringify(routingUtilsPath)};
import { buildRequestHeadersFromMiddlewareResponse as __buildRequestHeadersFromMiddlewareResponse } from ${JSON.stringify(middlewareRequestHeadersPath)};
import { applyConfigHeadersToResponse, resolvePublicFileRoute, validateImageUrl, guardProtocolRelativeUrl, hasBasePath, stripBasePath, normalizeTrailingSlash } from ${JSON.stringify(requestPipelinePath)};
import { applyAppMiddleware as __applyAppMiddleware } from ${JSON.stringify(appMiddlewarePath)};
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
  createRscOnErrorHandler as __createRscOnErrorHandler,
  sanitizeErrorForClient as __sanitizeErrorForClient,
} from ${JSON.stringify(appRscErrorsPath)};
import { readAppPageCacheResponse as __readAppPageCacheResponse } from ${JSON.stringify(appPageCachePath)};
import {
  buildAppPageFontLinkHeader as __buildAppPageFontLinkHeader,
  buildAppPageSpecialErrorResponse as __buildAppPageSpecialErrorResponse,
  readAppPageTextStream as __readAppPageTextStream,
  resolveAppPageSpecialError as __resolveAppPageSpecialError,
  teeAppPageRscStreamForCapture as __teeAppPageRscStreamForCapture,
} from ${JSON.stringify(appPageExecutionPath)};
import {
  resolveAppPageParentHttpAccessBoundaryModule as __resolveAppPageParentHttpAccessBoundaryModule,
} from ${JSON.stringify(appPageBoundaryPath)};
import {
  renderAppPageErrorBoundary as __renderAppPageErrorBoundary,
  renderAppPageHttpAccessFallback as __renderAppPageHttpAccessFallback,
} from ${JSON.stringify(appPageBoundaryRenderPath)};
import {
  APP_INTERCEPTION_CONTEXT_KEY as __APP_INTERCEPTION_CONTEXT_KEY,
  createAppPayloadRouteId as __createAppPayloadRouteId,
} from ${JSON.stringify(appElementsPath)};
import {
  buildAppPageElements as __buildAppPageElements,
  createAppPageTreePath as __createAppPageTreePath,
  resolveAppPageChildSegments as __resolveAppPageChildSegments,
} from ${JSON.stringify(appPageRouteWiringPath)};
import {
  resolveAppPageSegmentParams as __resolveAppPageSegmentParams,
} from ${JSON.stringify(appPageParamsPath)};
import {
  collectAppPageSearchParams as __collectAppPageSearchParams,
  resolveActiveParallelRouteHeadInputs as __resolveActiveParallelRouteHeadInputs,
  resolveAppPageHead as __resolveAppPageHead,
} from ${JSON.stringify(appPageHeadPath)};
import {
  renderAppPageLifecycle as __renderAppPageLifecycle,
} from ${JSON.stringify(appPageRenderPath)};
import {
  mergeMiddlewareResponseHeaders as __mergeMiddlewareResponseHeaders,
} from ${JSON.stringify(appPageResponsePath)};
import { getScriptNonceFromHeaderSources as __getScriptNonceFromHeaderSources } from ${JSON.stringify(cspPath)};
import {
  buildAppPageElement as __buildAppPageElement,
  resolveAppPageIntercept as __resolveAppPageIntercept,
  validateAppPageDynamicParams as __validateAppPageDynamicParams,
} from ${JSON.stringify(appPageRequestPath)};
import {
  resolveAppPageMethodResponse as __resolveAppPageMethodResponse,
} from ${JSON.stringify(appPageMethodPath)};
import {
  createStaticGenerationHeadersContext as __createStaticGenerationHeadersContext,
} from ${JSON.stringify(appStaticGenerationPath)};
import { buildPageCacheTags } from ${JSON.stringify(implicitTagsPath)};
import { _consumeRequestScopedCacheLife } from "next/cache";
import { getRequestExecutionContext as _getRequestExecutionContext } from ${JSON.stringify(requestContextShimPath)};
import { setRootParams as __setRootParams, pickRootParams as __pickRootParams } from ${JSON.stringify(rootParamsShimPath)};
import { makeThenableParams } from ${JSON.stringify(thenableParamsShimPath)};
import { ensureFetchPatch as _ensureFetchPatch, getCollectedFetchTags, setCurrentFetchSoftTags } from "vinext/fetch-cache";
import {
  createAppRscRouteMatcher as __createAppRscRouteMatcher,
} from ${JSON.stringify(appRscRouteMatchingPath)};
import {
  handleAppPrerenderEndpoint as __handleAppPrerenderEndpoint,
} from ${JSON.stringify(appPrerenderEndpointsPath)};
import {
  appIsrHtmlKey as __isrHtmlKey,
  appIsrRscKey as __isrRscKey,
  appIsrRouteKey as __isrRouteKey,
  isrGet as __isrGet,
  isrSet as __isrSet,
  normalizeMountedSlotsHeader as __normalizeMountedSlotsHeader,
  triggerBackgroundRegeneration as __triggerBackgroundRegeneration,
} from ${JSON.stringify(isrCachePath)};
// Import server-only state module to register ALS-backed accessors.
import "vinext/navigation-state";
import { runWithPrerenderWorkUnit as __runWithPrerenderWorkUnit } from ${JSON.stringify(prerenderWorkUnitSetupPath)};
import { runWithRequestContext as _runWithUnifiedCtx, createRequestContext as _createUnifiedCtx } from "vinext/unified-request-context";
import { reportRequestError as _reportRequestError } from "vinext/instrumentation";
import { flattenErrorCauses as __flattenErrorCauses } from ${JSON.stringify(errorCausePath)};
import { getSSRFontLinks as _getSSRFontLinks, getSSRFontStyles as _getSSRFontStylesGoogle, getSSRFontPreloads as _getSSRFontPreloadsGoogle } from "next/font/google";
import { getSSRFontStyles as _getSSRFontStylesLocal, getSSRFontPreloads as _getSSRFontPreloadsLocal } from "next/font/local";
function _getSSRFontStyles() { return [..._getSSRFontStylesGoogle(), ..._getSSRFontStylesLocal()]; }
function _getSSRFontPreloads() { return [..._getSSRFontPreloadsGoogle(), ..._getSSRFontPreloadsLocal()]; }
${hasPagesDir ? `// Pages Router routes are loaded lazily from the SSR environment for internal prerender requests.` : ""}

// ALS used to suppress the expected "Invalid hook call" dev warning when
// layout/page components are probed outside React's render cycle. Patching
// console.error once at module load (instead of per-request) avoids the
// concurrent-request issue where request A's suppression filter could
// swallow real errors from request B.
const _suppressHookWarningAls = new AsyncLocalStorage();
const _origConsoleError = console.error;
console.error = (...args) => {
  if (_suppressHookWarningAls.getStore() === true &&
      typeof args[0] === "string" &&
      args[0].includes("Invalid hook call")) return;
  _origConsoleError.apply(console, args);
};

// Set navigation context in the ALS-backed store. "use client" components
// rendered during SSR need the pathname/searchParams/params but the SSR
// environment has a separate module instance of next/navigation.
// Use _getNavigationContext() to read the current context — never cache
// it in a module-level variable (that would leak between concurrent requests).
function setNavigationContext(ctx) {
  _setNavigationContextOrig(ctx);
  if (ctx === null) __setRootParams(null);
}

function __clearRequestContext() {
  setHeadersContext(null);
  setNavigationContext(null);
  // setNavigationContext(null) already clears root params internally
}

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

function createRscOnErrorHandler(request, pathname, routePath) {
  const requestInfo = {
    path: pathname,
    method: request.method,
    headers: Object.fromEntries(request.headers.entries()),
  };
  const errorContext = {
    routerKind: "App Router",
    routePath: routePath || pathname,
    routeType: "render",
  };
  return __createRscOnErrorHandler({
    errorContext,
    reportRequestError: _reportRequestError,
    requestInfo,
  });
}

${imports.join("\n")}

${
  instrumentationPath
    ? `// Run instrumentation register() exactly once, lazily on the first request.
// Previously this was a top-level await, which blocked the entire module graph
// from finishing initialization until register() resolved — adding that latency
// to every cold start. Moving it here preserves the "runs before any request is
// handled" guarantee while not blocking V8 isolate initialization.
// On Cloudflare Workers, module evaluation happens synchronously in the isolate
// startup phase; a top-level await extends that phase and increases cold-start
// wall time for all requests, not just the first.
let __instrumentationInitialized = false;
let __instrumentationInitPromise = null;
async function __ensureInstrumentation() {
  if (process.env.VINEXT_PRERENDER === "1") return;
  if (__instrumentationInitialized) return;
  if (__instrumentationInitPromise) return __instrumentationInitPromise;
  __instrumentationInitPromise = (async () => {
    if (typeof _instrumentation.register === "function") {
      await _instrumentation.register();
    }
    // Store the onRequestError handler on globalThis so it is visible to
    // reportRequestError() (imported as _reportRequestError above) regardless
    // of which Vite environment module graph it is called from. With
    // @vitejs/plugin-rsc the RSC and SSR environments run in the same Node.js
    // process and share globalThis. With @cloudflare/vite-plugin everything
    // runs inside the Worker so globalThis is the Worker's global — also correct.
    if (typeof _instrumentation.onRequestError === "function") {
      globalThis.__VINEXT_onRequestErrorHandler__ = _instrumentation.onRequestError;
    }
    __instrumentationInitialized = true;
  })();
  return __instrumentationInitPromise;
}`
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
const __APP_PAGE_EMPTY_MW_CTX = { headers: null, status: null };

/**
 * Render an HTTP access fallback page (not-found/forbidden/unauthorized) with layouts and noindex meta.
 * Returns null if no matching component is available.
 *
 * @param opts.boundaryComponent - Override the boundary component (for layout-level notFound)
 * @param opts.layouts - Override the layouts to wrap with (for layout-level notFound, excludes the throwing layout)
 */
async function renderHTTPAccessFallbackPage(route, statusCode, isRscRequest, request, opts, scriptNonce, middlewareContext) {
  return __renderAppPageHttpAccessFallback({
    boundaryComponent: opts?.boundaryComponent ?? null,
    buildFontLinkHeader: __buildAppPageFontLinkHeader,
    clearRequestContext() {
      __clearRequestContext();
    },
    createRscOnErrorHandler(pathname, routePath) {
      return createRscOnErrorHandler(request, pathname, routePath);
    },
    getFontLinks: _getSSRFontLinks,
    getFontPreloads: _getSSRFontPreloads,
    getFontStyles: _getSSRFontStyles,
    getNavigationContext: _getNavigationContext,
    globalErrorModule: ${globalErrorVar ? globalErrorVar : "null"},
    isRscRequest,
    layoutModules: opts?.layouts ?? null,
    loadSsrHandler() {
      return import.meta.viteRsc.loadModule("ssr", "index");
    },
    makeThenableParams,
    matchedParams: opts?.matchedParams ?? route?.params ?? {},
    middlewareContext: middlewareContext ?? __APP_PAGE_EMPTY_MW_CTX,
    metadataRoutes,
    requestUrl: request.url,
    resolveChildSegments: __resolveAppPageChildSegments,
    rootForbiddenModule: rootForbiddenModule,
    rootLayouts: rootLayouts,
    rootNotFoundModule: rootNotFoundModule,
    rootUnauthorizedModule: rootUnauthorizedModule,
    route,
    renderToReadableStream,
    scriptNonce,
    statusCode,
  });
}

/** Convenience: render a not-found page (404) */
async function renderNotFoundPage(route, isRscRequest, request, matchedParams, scriptNonce, middlewareContext) {
  return renderHTTPAccessFallbackPage(route, 404, isRscRequest, request, { matchedParams }, scriptNonce, middlewareContext);
}

/**
 * Render an error.tsx boundary page when a server component or generateMetadata() throws.
 * Returns null if no error boundary component is available for this route.
 *
 * Next.js returns HTTP 200 when error.tsx catches an error (the error is "handled"
 * by the boundary). This matches that behavior intentionally.
 */
async function renderErrorBoundaryPage(route, error, isRscRequest, request, matchedParams, scriptNonce, middlewareContext) {
  return __renderAppPageErrorBoundary({
    buildFontLinkHeader: __buildAppPageFontLinkHeader,
    clearRequestContext() {
      __clearRequestContext();
    },
    createRscOnErrorHandler(pathname, routePath) {
      return createRscOnErrorHandler(request, pathname, routePath);
    },
    error,
    getFontLinks: _getSSRFontLinks,
    getFontPreloads: _getSSRFontPreloads,
    getFontStyles: _getSSRFontStyles,
    getNavigationContext: _getNavigationContext,
    globalErrorModule: ${globalErrorVar ? globalErrorVar : "null"},
    isRscRequest,
    loadSsrHandler() {
      return import.meta.viteRsc.loadModule("ssr", "index");
    },
    makeThenableParams,
    matchedParams: matchedParams ?? route?.params ?? {},
    middlewareContext: middlewareContext ?? __APP_PAGE_EMPTY_MW_CTX,
    metadataRoutes,
    requestUrl: request.url,
    resolveChildSegments: __resolveAppPageChildSegments,
    rootLayouts: rootLayouts,
    route,
    renderToReadableStream,
    sanitizeErrorForClient: __sanitizeErrorForClient,
    scriptNonce,
  });
}

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
  const {
    opts,
    searchParams,
    isRscRequest,
    request,
    mountedSlotsHeader,
  } = pageRequest;
  const hasPageModule = !!route.page;
  const PageComponent = route.page?.default;
  if (hasPageModule && !PageComponent) {
    const _interceptionContext = opts?.interceptionContext ?? null;
    const _noExportRouteId = __createAppPayloadRouteId(routePath, _interceptionContext);
    let _noExportRootLayout = null;
    if (route.layouts?.length > 0) {
      // Compute the root layout tree path for this error payload using the
      // canonical helper so it stays aligned with buildAppPageElements().
      const _tp = route.layoutTreePositions?.[0] ?? 0;
      _noExportRootLayout = __createAppPageTreePath(route.routeSegments, _tp);
    }
    return {
      [__APP_INTERCEPTION_CONTEXT_KEY]: _interceptionContext,
      __route: _noExportRouteId,
      __rootLayout: _noExportRootLayout,
      [_noExportRouteId]: createElement("div", null, "Page has no default export"),
    };
  }

  const {
    hasSearchParams,
    metadata: resolvedMetadata,
    pageSearchParams,
    viewport: resolvedViewport,
  } = await __resolveAppPageHead({
    layoutModules: route.layouts,
    layoutTreePositions: route.layoutTreePositions,
    metadataRoutes,
    pageModule: route.page,
    parallelRoutes: __resolveActiveParallelRouteHeadInputs({
      interceptLayouts: opts?.interceptLayouts ?? null,
      interceptPage: opts?.interceptPage ?? null,
      interceptParams: opts?.interceptParams ?? null,
      interceptSlotKey: opts?.interceptSlotKey ?? null,
      params,
      routeSegments: route.routeSegments,
      slots: route.slots,
    }),
    params,
    routePath: route.pattern,
    routeSegments: route.routeSegments,
    searchParams,
  });

  // Build the route tree from the leaf page, then delegate the boundary/layout/
  // template/segment wiring to a typed runtime helper so the generated entry
  // stays thin and the wiring logic can be unit tested directly.
  const pageProps = { params: makeThenableParams(params) };
  if (searchParams) {
    // Always provide searchParams prop when the URL object is available, even
    // when the query string is empty -- pages that do "await searchParams" need
    // it to be a thenable rather than undefined.
    pageProps.searchParams = makeThenableParams(pageSearchParams);
    // If the URL has query parameters, mark the page as dynamic.
    // In Next.js, only accessing the searchParams prop signals dynamic usage,
    // but a Proxy-based approach doesn't work here because React's RSC debug
    // serializer accesses properties on all props (e.g. $$typeof check in
    // isClientReference), triggering the Proxy even when user code doesn't
    // read searchParams. Checking for non-empty query params is a safe
    // approximation: pages with query params in the URL are almost always
    // dynamic, and this avoids false positives from React internals.
    if (hasSearchParams) markDynamicUsage();
  }
  // mountedSlotsHeader is threaded through from the handler scope so every
  // call site shares one source of truth for request-derived values. Reading
  // the same header in two places invites silent drift when a future refactor
  // changes only one of them.
  const mountedSlotIds = mountedSlotsHeader
    ? new Set(mountedSlotsHeader.split(" "))
    : null;

  return __buildAppPageElements({
    element: PageComponent ? createElement(PageComponent, pageProps) : null,
    globalErrorModule: ${globalErrorVar ? globalErrorVar : "null"},
    isRscRequest,
    mountedSlotIds,
    makeThenableParams,
    matchedParams: params,
    resolvedMetadata,
    resolvedViewport,
    interceptionContext: opts?.interceptionContext ?? null,
    routePath,
    rootNotFoundModule: ${rootNotFoundVar ? rootNotFoundVar : "null"},
    rootForbiddenModule: ${rootForbiddenVar ? rootForbiddenVar : "null"},
    rootUnauthorizedModule: ${rootUnauthorizedVar ? rootUnauthorizedVar : "null"},
    route,
    slotOverrides:
      opts && opts.interceptSlotKey && opts.interceptPage
        ? {
            [opts.interceptSlotKey]: {
              layoutModules: opts.interceptLayouts || null,
              pageModule: opts.interceptPage,
              params: opts.interceptParams || params,
            },
          }
        : null,
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

${generateDevOriginCheckCode(config?.allowedDevOrigins)}

// ── Config pattern matching, redirects, rewrites, headers, CSRF validation,
//    external URL proxy, cookie parsing, and request context are imported from
//    config-matchers.ts and request-pipeline.ts (see import statements above).
//    This eliminates ~250 lines of duplicated inline code and ensures the
//    single-pass tokenizer in config-matchers.ts is used consistently
//    (fixing the chained .replace() divergence flagged by CodeQL).

/**
 * Build a request context from the live ALS HeadersContext, which reflects
 * any x-middleware-request-* header mutations applied by middleware.
 * Used for afterFiles and fallback rewrite has/missing evaluation — these
 * run after middleware in the App Router execution order.
 */
function __buildPostMwRequestContext(request) {
  const url = new URL(request.url);
  const ctx = getHeadersContext();
  if (!ctx) return requestContextFromRequest(request);
  // ctx.cookies is a Map<string, string> (HeadersContext), but RequestContext
  // requires a plain Record<string, string> for has/missing cookie evaluation
  // (config-matchers.ts uses obj[key] not Map.get()). Convert here.
  const cookiesRecord = Object.fromEntries(ctx.cookies);
  return {
    headers: ctx.headers,
    cookies: cookiesRecord,
    query: url.searchParams,
    host: normalizeHost(ctx.headers.get("host"), url.hostname),
  };
}

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

export default async function handler(request, ctx) {
  ${
    instrumentationPath
      ? `// Ensure instrumentation.register() has run before handling the first request.
  // This is a no-op after the first call (guarded by __instrumentationInitialized).
  await __ensureInstrumentation();
  `
      : ""
  }
  // Wrap the entire request in a single unified ALS scope for per-request
  // isolation. All state modules (headers, navigation, cache, fetch-cache,
  // execution-context) read from this store via isInsideUnifiedScope().
  const headersCtx = headersContextFromRequest(request);
  const __uCtx = _createUnifiedCtx({
    headersContext: headersCtx,
    executionContext: ctx ?? _getRequestExecutionContext() ?? null,
    unstableCacheRevalidation: "background",
  });
  return _runWithUnifiedCtx(__uCtx, () =>
    __runWithPrerenderWorkUnit(async () => {
    _ensureFetchPatch();
    const __reqCtx = requestContextFromRequest(request);
    // Per-request container for middleware state. Passed into
    // _handleRequest which fills in .headers and .status;
    // avoids module-level variables that race on Workers.
    const _mwCtx = { headers: null, requestHeaders: null, status: null };
    let response;
    try {
      response = await _handleRequest(request, __reqCtx, _mwCtx);
    } catch (err) {
      // Dev only: embed err.cause chain into err.message/err.stack so Vite's
      // dev-server "Internal server error:" logger (which builds output from
      // message + stack only) reveals the underlying root cause (ECONNREFUSED,
      // role missing, workerd socket error, etc.) instead of dropping it.
      // Skipped in production because Node's util.inspect / workerd's logger
      // already render .cause natively, so flattening would double-print it.
      // NODE_ENV is build-time-replaced by Vite, so the prod bundle compiles
      // this branch out entirely.
      if (process.env.NODE_ENV !== "production") {
        __flattenErrorCauses(err);
      }
      throw err;
    }
    // Apply custom headers from next.config.js to non-redirect responses.
    // Skip redirects (3xx) because Response.redirect() creates immutable headers,
    // and Next.js doesn't apply custom headers to redirects anyway.
    if (response && response.headers && !(response.status >= 300 && response.status < 400)) {
      if (__configHeaders.length) {
        const url = new URL(request.url);
        let pathname;
        try { pathname = __normalizePath(__normalizePathnameForRouteMatch(url.pathname)); } catch { pathname = url.pathname; }
        ${bp ? `if (pathname.startsWith(${JSON.stringify(bp)})) pathname = pathname.slice(${JSON.stringify(bp)}.length) || "/";` : ""}
        applyConfigHeadersToResponse(response.headers, {
          configHeaders: __configHeaders,
          pathname,
          requestContext: __reqCtx,
        });
      }
    }
    return response;
    }, { route: () => new URL(request.url).pathname })
  );
}

async function _handleRequest(request, __reqCtx, _mwCtx) {
  const __reqStart = process.env.NODE_ENV !== "production" ? performance.now() : 0;
  // __reqStart is included in the timing header so the Node logging middleware
  // can compute true compile time as: handlerStart - middlewareStart.
  // Format: "handlerStart,compileMs,renderMs" - all as integers (ms). Dev-only.
  const url = new URL(request.url);

  // ── Cross-origin request protection (dev only) ─────────────────────
  // Block requests from non-localhost origins to prevent data exfiltration.
  // Skipped in production — Vite replaces NODE_ENV at build time.
  if (process.env.NODE_ENV !== "production") {
    const __originBlock = __validateDevRequestOrigin(request);
    if (__originBlock) return __originBlock;
  }

  // Guard against protocol-relative URL open redirects (see request-pipeline.ts).
  const __protoGuard = guardProtocolRelativeUrl(url.pathname);
  if (__protoGuard) return __protoGuard;

  // Decode percent-encoding segment-wise and normalize pathname to canonical form.
  // This preserves encoded path delimiters like %2F within a single segment.
  // __normalizePath collapses //foo///bar → /foo/bar, resolves . and .. segments.
  let decodedUrlPathname;
  try { decodedUrlPathname = __normalizePathnameForRouteMatchStrict(url.pathname); } catch (e) {
    return new Response("Bad Request", { status: 400 });
  }
  let pathname = __normalizePath(decodedUrlPathname);

  ${
    bp
      ? `
  if (!hasBasePath(pathname, __basePath) && !pathname.startsWith("/__vinext/")) {
    return new Response("Not Found", { status: 404 });
  }
  // Strip basePath prefix
  pathname = stripBasePath(pathname, __basePath);
  `
      : ""
  }

  const __prerenderEndpointResponse = await __handleAppPrerenderEndpoint(request, {
    isPrerenderEnabled() {
      return process.env.VINEXT_PRERENDER === "1";
    },
${prerenderPagesLoaderOption}
    pathname,
    rootParamNamesByPattern: rootParamNamesMap,
    staticParamsMap: generateStaticParamsMap,
  });
  if (__prerenderEndpointResponse) return __prerenderEndpointResponse;

  // Trailing slash normalization (redirect to canonical form)
  const __tsRedirect = normalizeTrailingSlash(pathname, __basePath, __trailingSlash, url.search);
  if (__tsRedirect) return __tsRedirect;

  // ── Apply redirects from next.config.js ───────────────────────────────
  if (__configRedirects.length) {
    // Strip .rsc suffix before matching redirect rules - RSC (client-side nav) requests
    // arrive as /some/path.rsc but redirect patterns are defined without it (e.g.
    // /some/path). Without this, soft-nav fetches bypass all config redirects.
    const __redirPathname = pathname.endsWith(".rsc") ? pathname.slice(0, -4) : pathname;
    const __redir = matchRedirect(__redirPathname, __configRedirects, __reqCtx);
    if (__redir) {
      const __redirDest = sanitizeDestination(
        __basePath &&
          !isExternalUrl(__redir.destination) &&
          !hasBasePath(__redir.destination, __basePath)
          ? __basePath + __redir.destination
          : __redir.destination
      );
      return new Response(null, {
        status: __redir.permanent ? 308 : 307,
        headers: { Location: __redirDest },
      });
    }
  }

  const isRscRequest = pathname.endsWith(".rsc") || request.headers.get("accept")?.includes("text/x-component");
  // Read mounted-slots header once at the handler scope and thread it through
  // every buildPageElements call site. Previously both the handler and
  // buildPageElements read and normalized it independently, which invited
  // silent drift if a future refactor changed only one path.
  const __mountedSlotsHeader = __normalizeMountedSlotsHeader(
    request.headers.get("x-vinext-mounted-slots"),
  );
  const interceptionContextHeader = request.headers.get("X-Vinext-Interception-Context")?.replaceAll("\0", "") || null;
  let cleanPathname = pathname.replace(/\\.rsc$/, "");

  // Middleware response headers and custom rewrite status are stored in
  // _mwCtx (per-request container) so handler() can merge them into
  // every response path without module-level state that races on Workers.

  ${
    middlewarePath
      ? `
  const __mwResult = await __applyAppMiddleware({
    basePath: __basePath,
    cleanPathname,
    context: _mwCtx,
    i18nConfig: __i18nConfig,
    isProxy: ${JSON.stringify(isProxyFile(middlewarePath))},
    module: middlewareModule,
    request,
  });
  if (__mwResult.kind === "response") return __mwResult.response;
  cleanPathname = __mwResult.cleanPathname;
  if (__mwResult.search !== null) {
    url.search = __mwResult.search;
  }
  `
      : ""
  }

  const _scriptNonce = __getScriptNonceFromHeaderSources(request.headers, _mwCtx.headers);

  // Build post-middleware request context for afterFiles/fallback rewrites.
  // These run after middleware in the App Router execution order and should
  // evaluate has/missing conditions against middleware-modified headers.
  // When no middleware is present, this falls back to requestContextFromRequest.
  const __postMwReqCtx = __buildPostMwRequestContext(request);

  // ── Apply beforeFiles rewrites from next.config.js ────────────────────
  // In App Router execution order, beforeFiles runs after middleware so that
  // has/missing conditions can evaluate against middleware-modified headers.
  if (__configRewrites.beforeFiles && __configRewrites.beforeFiles.length) {
    const __rewritten = matchRewrite(cleanPathname, __configRewrites.beforeFiles, __postMwReqCtx);
    if (__rewritten) {
      if (isExternalUrl(__rewritten)) {
        __clearRequestContext();
        return proxyExternalRequest(request, __rewritten);
      }
      cleanPathname = __rewritten;
    }
  }

  // ── Image optimization passthrough (dev mode — no transformation) ───────
  if (cleanPathname === "/_vinext/image") {
    const __imgResult = validateImageUrl(url.searchParams.get("url"), request.url);
    if (__imgResult instanceof Response) return __imgResult;
    // In dev, redirect to the original asset URL so Vite's static serving handles it.
    return Response.redirect(new URL(__imgResult, url.origin).href, 302);
  }

  const metadataRouteResponse = await __handleMetadataRouteRequest({
    metadataRoutes,
    cleanPathname,
    makeThenableParams,
  });
  if (metadataRouteResponse) return metadataRouteResponse;

  // Serve public/ files as filesystem routes after middleware and before
  // afterFiles/fallback rewrites, matching Next.js routing semantics.
  const __publicFileResponse = resolvePublicFileRoute({
    cleanPathname,
    middlewareContext: _mwCtx,
    pathname,
    publicFiles: __publicFiles,
    request,
  });
  if (__publicFileResponse) {
    __clearRequestContext();
    return __publicFileResponse;
  }

  // Set navigation context for Server Components.
  // Note: Headers context is already set by runWithRequestContext in the handler wrapper.
  setNavigationContext({
    pathname: cleanPathname,
    searchParams: url.searchParams,
    params: {},
  });

  // Handle server action POST requests
  const actionId = request.headers.get("x-rsc-action") ?? request.headers.get("next-action");
  const actionContentType = request.headers.get("content-type") || "";
  const progressiveActionResponse = await __handleProgressiveServerActionRequest({
    actionId,
    allowedOrigins: __allowedOrigins,
    cleanPathname,
    clearRequestContext() {
      __clearRequestContext();
    },
    contentType: actionContentType,
    decodeAction,
    getAndClearPendingCookies,
    getDraftModeCookieHeader,
    maxActionBodySize: __MAX_ACTION_BODY_SIZE,
    middlewareHeaders: _mwCtx.headers,
    readFormDataWithLimit: __readFormDataWithLimit,
    reportRequestError: _reportRequestError,
    request,
    setHeadersAccessPhase,
  });
  if (progressiveActionResponse) return progressiveActionResponse;

  const serverActionResponse = await __handleServerActionRscRequest({
    actionId,
    allowedOrigins: __allowedOrigins,
    buildPageElement({
      route: actionRoute,
      params: actionParams,
      cleanPathname: actionCleanPathname,
      interceptOpts,
      searchParams,
      isRscRequest: actionIsRscRequest,
      request: actionRequest,
      mountedSlotsHeader,
    }) {
      return buildPageElements(actionRoute, actionParams, actionCleanPathname, {
        opts: interceptOpts,
        searchParams,
        isRscRequest: actionIsRscRequest,
        request: actionRequest,
        mountedSlotsHeader,
      });
    },
    cleanPathname,
    clearRequestContext() {
      __clearRequestContext();
    },
    contentType: actionContentType,
    createNotFoundElement(actionRouteId) {
      return {
        [__APP_INTERCEPTION_CONTEXT_KEY]: null,
        __route: actionRouteId,
        __rootLayout: null,
        [actionRouteId]: createElement("div", null, "Page not found"),
      };
    },
    createPayloadRouteId(pathnameToRender, interceptionContext) {
      return __createAppPayloadRouteId(pathnameToRender, interceptionContext);
    },
    createRscOnErrorHandler(actionRequest, actionPathname, routePattern) {
      return createRscOnErrorHandler(actionRequest, actionPathname, routePattern);
    },
    createTemporaryReferenceSet,
    decodeReply,
    findIntercept(pathnameToMatch) {
      return findIntercept(pathnameToMatch, interceptionContextHeader);
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
    middlewareHeaders: _mwCtx.headers,
    middlewareStatus: _mwCtx.status,
    mountedSlotsHeader: __mountedSlotsHeader,
    readBodyWithLimit: __readBodyWithLimit,
    readFormDataWithLimit: __readFormDataWithLimit,
    renderToReadableStream,
    reportRequestError: _reportRequestError,
    request,
    sanitizeErrorForClient(error) {
      return __sanitizeErrorForClient(error);
    },
    searchParams: url.searchParams,
    setHeadersAccessPhase,
    setNavigationContext,
    toInterceptOpts(intercept) {
      return {
        interceptionContext: interceptionContextHeader,
        interceptLayouts: intercept.interceptLayouts,
        interceptSlotKey: intercept.slotKey,
        interceptPage: intercept.page,
        interceptParams: intercept.matchedParams,
      };
    },
  });
  if (serverActionResponse) return serverActionResponse;

  // ── Apply afterFiles rewrites from next.config.js ──────────────────────
  if (__configRewrites.afterFiles && __configRewrites.afterFiles.length) {
    const __afterRewritten = matchRewrite(cleanPathname, __configRewrites.afterFiles, __postMwReqCtx);
    if (__afterRewritten) {
      if (isExternalUrl(__afterRewritten)) {
        __clearRequestContext();
        return proxyExternalRequest(request, __afterRewritten);
      }
      cleanPathname = __afterRewritten;
    }
  }

  let match = matchRoute(cleanPathname);

  // ── Fallback rewrites from next.config.js (if no route matched) ───────
  if (!match && __configRewrites.fallback && __configRewrites.fallback.length) {
    const __fallbackRewritten = matchRewrite(cleanPathname, __configRewrites.fallback, __postMwReqCtx);
    if (__fallbackRewritten) {
      if (isExternalUrl(__fallbackRewritten)) {
        __clearRequestContext();
        return proxyExternalRequest(request, __fallbackRewritten);
      }
      cleanPathname = __fallbackRewritten;
      match = matchRoute(cleanPathname);
    }
  }

  if (!match) {
    ${
      hasPagesDir
        ? `
    // ── Pages Router fallback ────────────────────────────────────────────
    // When a request doesn't match any App Router route, delegate to the
    // Pages Router handler (available in the SSR environment). This covers
    // both production request serving and prerender fetches from wrangler.
    // RSC requests (.rsc suffix or Accept: text/x-component) cannot be
    // handled by the Pages Router, so skip the delegation for those.
    if (!isRscRequest) {
      const __pagesEntry = await import.meta.viteRsc.loadModule("ssr", "index");
      if (typeof __pagesEntry.renderPage === "function") {
        const __pagesRequestHeaders = _mwCtx.requestHeaders
          ? __buildRequestHeadersFromMiddlewareResponse(request.headers, _mwCtx.requestHeaders)
          : null;
        const __pagesRequest = __pagesRequestHeaders
          ? new Request(request.url, { method: request.method, headers: __pagesRequestHeaders })
          : request;
        // Use segment-wise decoding to preserve encoded path delimiters (%2F).
        // decodeURIComponent would turn /admin%2Fpanel into /admin/panel,
        // changing the path structure and bypassing middleware matchers.
        // Ported from Next.js: packages/next/src/server/lib/router-utils/decode-path-params.ts
        // https://github.com/vercel/next.js/blob/canary/packages/next/src/server/lib/router-utils/decode-path-params.ts
        const __pagesRes = await __pagesEntry.renderPage(
          __pagesRequest,
          __decodePathParams(url.pathname) + (url.search || ""),
          {},
          undefined,
          _mwCtx.requestHeaders,
        );
        // Only return the Pages Router response if it matched a route
        // (non-404). A 404 means the path isn't a Pages route either,
        // so fall through to the App Router not-found page below.
        if (__pagesRes.status !== 404) {
          __clearRequestContext();
          return __pagesRes;
        }
      }
    }
    `
        : ""
    }
    // Render custom not-found page if available, otherwise plain 404
    const notFoundResponse = await renderNotFoundPage(null, isRscRequest, request, undefined, _scriptNonce, _mwCtx);
    if (notFoundResponse) return notFoundResponse;
    __clearRequestContext();
    const notFoundHeaders = new Headers();
    __mergeMiddlewareResponseHeaders(notFoundHeaders, _mwCtx.headers);
    return new Response("Not Found", { status: 404, headers: notFoundHeaders });
  }

  const { route, params } = match;
  setCurrentFetchSoftTags(
    buildPageCacheTags(cleanPathname, [], route.routeSegments, route.routeHandler ? "route" : "page"),
  );

  // Update navigation context with matched params
  setNavigationContext({
    pathname: cleanPathname,
    searchParams: url.searchParams,
    params,
  });
  __setRootParams(__pickRootParams(params, route.rootParamNames));

  // Handle route.ts API handlers
  if (route.routeHandler) {
    return __dispatchAppRouteHandler({
      basePath: __basePath,
      cleanPathname,
      clearRequestContext: function() {
        __clearRequestContext();
      },
      i18n: __i18nConfig,
      isrDebug: __isrDebug,
      isrGet: __isrGet,
      isrRouteKey: __isrRouteKey,
      isrSet: __isrSet,
      middlewareContext: _mwCtx,
      middlewareRequestHeaders: _mwCtx.requestHeaders,
      params,
      request,
      route: {
        pattern: route.pattern,
        routeHandler: route.routeHandler,
        routeSegments: route.routeSegments,
      },
      scheduleBackgroundRegeneration: __triggerBackgroundRegeneration,
      searchParams: url.searchParams,
    });
  }

  // Build the component tree: layouts wrapping the page
  const hasPageModule = !!route.page;
  const PageComponent = route.page?.default;
  if (hasPageModule && !PageComponent) {
    __clearRequestContext();
    return new Response("Page has no default export", { status: 500 });
  }

  // Read route segment config from page module exports
  let revalidateSeconds = typeof route.page?.revalidate === "number" ? route.page.revalidate : null;
  const dynamicConfig = route.page?.dynamic; // 'auto' | 'force-dynamic' | 'force-static' | 'error'
  const dynamicParamsConfig = route.page?.dynamicParams; // true (default) | false
  const isForceStatic = dynamicConfig === "force-static";
  const isDynamicError = dynamicConfig === "error";
  const __methodResponse = __resolveAppPageMethodResponse({
    dynamicConfig,
    hasGenerateStaticParams: typeof route.page?.generateStaticParams === "function",
    isDynamicRoute: route.isDynamic,
    middlewareHeaders: _mwCtx.headers,
    request,
    revalidateSeconds,
  });
  if (__methodResponse) {
    __clearRequestContext();
    return __methodResponse;
  }

  // force-static: replace headers/cookies context with empty values and
  // clear searchParams so dynamic APIs return defaults instead of real data
  if (isForceStatic) {
    setHeadersContext(__createStaticGenerationHeadersContext({
      dynamicConfig,
      routeKind: "page",
      routePattern: route.pattern,
    }));
    setNavigationContext({
      pathname: cleanPathname,
      searchParams: new URLSearchParams(),
      params,
    });
  }

  // dynamic = 'error': install an access error so request APIs fail with the
  // static-generation message even for legacy sync property access.
  if (isDynamicError) {
    setHeadersContext(__createStaticGenerationHeadersContext({
      dynamicConfig,
      routeKind: "page",
      routePattern: route.pattern,
    }));
    setNavigationContext({
      pathname: cleanPathname,
      searchParams: new URLSearchParams(),
      params,
    });
  }

  // force-dynamic: set no-store Cache-Control
  const isForceDynamic = dynamicConfig === "force-dynamic";

  // ── ISR cache read (production only) ─────────────────────────────────────
  // Read from cache BEFORE generateStaticParams and all rendering work.
  // This is the critical performance optimization: on a cache hit we skip
  // ALL expensive work (generateStaticParams, buildPageElement, layout probe,
  // page probe, renderToReadableStream, SSR). Both HTML and RSC requests
  // (client-side navigation / prefetch) are served from cache.
  //
  // HTML and RSC are stored under separate keys (matching Next.js's .html/.rsc
  // file layout) so each request type reads and writes independently — no races,
  // no partial-entry sentinels, no read-before-write hacks needed.
  //
  // force-static and dynamic='error' are compatible with ISR — they control
  // how dynamic APIs behave during rendering, not whether results are cached.
  // Only force-dynamic truly bypasses the ISR cache.
  if (
    process.env.NODE_ENV === "production" &&
    !isForceDynamic &&
    (isRscRequest || !_scriptNonce) &&
    revalidateSeconds !== null && revalidateSeconds > 0 && revalidateSeconds !== Infinity
  ) {
    const __cachedPageResponse = await __readAppPageCacheResponse({
      cleanPathname,
      clearRequestContext: function() {
        __clearRequestContext();
      },
      isRscRequest,
      isrDebug: __isrDebug,
      isrGet: __isrGet,
      isrHtmlKey: __isrHtmlKey,
      isrRscKey: __isrRscKey,
      isrSet: __isrSet,
      mountedSlotsHeader: __mountedSlotsHeader,
      revalidateSeconds,
      renderFreshPageForCache: async function() {
        // Re-render the page to produce fresh HTML + RSC data for the cache
        // Use an empty headers context for background regeneration — not the original
        // user request — to prevent user-specific cookies/auth headers from leaking
        // into content that is cached and served to all subsequent users.
        const __revalHeadCtx = __createStaticGenerationHeadersContext({
          dynamicConfig,
          routeKind: "page",
          routePattern: route.pattern,
        });
        const __revalUCtx = _createUnifiedCtx({
          headersContext: __revalHeadCtx,
          executionContext: _getRequestExecutionContext(),
          unstableCacheRevalidation: "foreground",
        });
        return _runWithUnifiedCtx(__revalUCtx, async () => {
          _ensureFetchPatch();
          setCurrentFetchSoftTags(buildPageCacheTags(cleanPathname, [], route.routeSegments, "page"));
          setNavigationContext({ pathname: cleanPathname, searchParams: new URLSearchParams(), params });
          // Slot context (X-Vinext-Mounted-Slots) is inherited from the
          // triggering request so the regen result is cached under the
          // correct slot-variant key.
          const __revalElement = await buildPageElements(
            route,
            params,
            cleanPathname,
            {
              opts: undefined,
              searchParams: new URLSearchParams(),
              isRscRequest,
              request,
              mountedSlotsHeader: __mountedSlotsHeader,
            },
          );
          const __revalOnError = createRscOnErrorHandler(request, cleanPathname, route.pattern);
          const __revalRscStream = renderToReadableStream(__revalElement, { onError: __revalOnError });
          const __revalRscCapture = __teeAppPageRscStreamForCapture(__revalRscStream, true);
          const __revalFontData = { links: _getSSRFontLinks(), styles: _getSSRFontStyles(), preloads: _getSSRFontPreloads() };
          const __revalSsrEntry = await import.meta.viteRsc.loadModule("ssr", "index");
          const __revalCapturedRscRef = { value: null };
          const __revalHtmlStream = await __revalSsrEntry.handleSsr(
            __revalRscCapture.ssrStream,
            _getNavigationContext(),
            __revalFontData,
            __revalRscCapture.sideStream
              ? { sideStream: __revalRscCapture.sideStream, capturedRscDataRef: __revalCapturedRscRef }
              : undefined,
          );
          __clearRequestContext();
          const __freshHtml = await __readAppPageTextStream(__revalHtmlStream);
          const __freshRscData = __revalCapturedRscRef.value ? await __revalCapturedRscRef.value : null;
          const __pageTags = buildPageCacheTags(cleanPathname, getCollectedFetchTags(), route.routeSegments, "page");
          return { html: __freshHtml, rscData: __freshRscData, tags: __pageTags };
        });
      },
      scheduleBackgroundRegeneration(key, renderFn) {
        __triggerBackgroundRegeneration(key, renderFn, {
          routerKind: "App Router",
          routePath: route.pattern,
          routeType: "render",
        });
      },
    });
    if (__cachedPageResponse) {
      return __cachedPageResponse;
    }
  }

  // dynamicParams = false: only params from generateStaticParams are allowed.
  // This runs AFTER the ISR cache read so that a cache hit skips this work entirely.
  const __dynamicParamsResponse = await __validateAppPageDynamicParams({
    clearRequestContext() {
      __clearRequestContext();
    },
    enforceStaticParamsOnly: dynamicParamsConfig === false,
    generateStaticParams: route.page?.generateStaticParams,
    isDynamicRoute: route.isDynamic,
    logGenerateStaticParamsError(err) {
      console.error("[vinext] generateStaticParams error:", err);
    },
    params,
  });
  if (__dynamicParamsResponse) {
    return __dynamicParamsResponse;
  }

  // Check for intercepting routes on RSC requests (client-side navigation).
  // If the target URL matches an intercepting route in a parallel slot,
  // render the source route with the intercepting page in the slot.
  const __interceptResult = await __resolveAppPageIntercept({
    buildPageElement(interceptRoute, interceptParams, interceptOpts, interceptSearchParams) {
      return buildPageElements(
        interceptRoute,
        interceptParams,
        cleanPathname,
        {
          opts: interceptOpts,
          searchParams: interceptSearchParams,
          isRscRequest,
          request,
          mountedSlotsHeader: __mountedSlotsHeader,
        },
      );
    },
    cleanPathname,
    currentRoute: route,
    findIntercept(pathname) {
      return findIntercept(pathname, interceptionContextHeader);
    },
    getRouteParamNames(sourceRoute) {
      return sourceRoute.params;
    },
    getSourceRoute(sourceRouteIndex) {
      return routes[sourceRouteIndex];
    },
    isRscRequest,
    renderInterceptResponse(sourceRoute, interceptElement) {
      const interceptOnError = createRscOnErrorHandler(
        request,
        cleanPathname,
        sourceRoute.pattern,
      );
      const interceptStream = renderToReadableStream(interceptElement, {
        onError: interceptOnError,
      });
      // Do NOT clear headers/navigation context here — the RSC stream is consumed lazily
      // by the client, and async server components that run during consumption need the
      // context to still be live. The AsyncLocalStorage scope from runWithRequestContext
      // handles cleanup naturally when all async continuations complete.
      const interceptHeaders = new Headers({
        "Content-Type": "text/x-component; charset=utf-8",
        "Vary": "RSC, Accept",
      });
      __mergeMiddlewareResponseHeaders(interceptHeaders, _mwCtx.headers);
      return new Response(interceptStream, {
        status: _mwCtx.status ?? 200,
        headers: interceptHeaders,
      });
    },
    searchParams: url.searchParams,
    setNavigationContext,
    toInterceptOpts(intercept) {
      return {
        interceptionContext: interceptionContextHeader,
        interceptLayouts: intercept.interceptLayouts,
        interceptSlotKey: intercept.slotKey,
        interceptPage: intercept.page,
        interceptParams: intercept.matchedParams,
      };
    },
  });
  if (__interceptResult.response) {
    return __interceptResult.response;
  }
  const interceptOpts = __interceptResult.interceptOpts;

  const __pageBuildResult = await __buildAppPageElement({
    buildPageElement() {
      return buildPageElements(route, params, cleanPathname, {
        opts: interceptOpts,
        searchParams: url.searchParams,
        isRscRequest,
        request,
        mountedSlotsHeader: __mountedSlotsHeader,
      });
    },
    renderErrorBoundaryPage(buildErr) {
      return renderErrorBoundaryPage(route, buildErr, isRscRequest, request, params, _scriptNonce, _mwCtx);
    },
    renderSpecialError(__buildSpecialError) {
      return __buildAppPageSpecialErrorResponse({
        clearRequestContext() {
          __clearRequestContext();
        },
        middlewareContext: _mwCtx,
        renderFallbackPage(statusCode) {
          return renderHTTPAccessFallbackPage(
            route,
            statusCode,
            isRscRequest,
            request,
            {
              matchedParams: params,
            },
            _scriptNonce,
            // buildAppPageSpecialErrorResponse merges _mwCtx onto this returned
            // fallback response; keep this inner boundary render unmerged so
            // additive headers like Set-Cookie and Vary are not duplicated.
            null,
          );
        },
        requestUrl: request.url,
        specialError: __buildSpecialError,
      });
    },
    resolveSpecialError: __resolveAppPageSpecialError,
  });
  if (__pageBuildResult.response) {
    return __pageBuildResult.response;
  }
  const element = __pageBuildResult.element;

  // Note: CSS is automatically injected by @vitejs/plugin-rsc's
  // rscCssTransform — no manual loadCss() call needed.
  const _hasLoadingBoundary = !!(route.loading && route.loading.default);
  const _asyncRouteParams = makeThenableParams(params);
  return __renderAppPageLifecycle({
    cleanPathname,
    clearRequestContext() {
      __clearRequestContext();
    },
    consumeDynamicUsage,
    consumeInvalidDynamicUsageError,
    createRscOnErrorHandler(pathname, routePath) {
      return createRscOnErrorHandler(request, pathname, routePath);
    },
    element,
    getDraftModeCookieHeader,
    getFontLinks: _getSSRFontLinks,
    getFontPreloads: _getSSRFontPreloads,
    getFontStyles: _getSSRFontStyles,
    getNavigationContext: _getNavigationContext,
    getPageTags() {
      return buildPageCacheTags(cleanPathname, getCollectedFetchTags(), route.routeSegments, "page");
    },
    getRequestCacheLife() {
      return _consumeRequestScopedCacheLife();
    },
    handlerStart: __reqStart,
    hasLoadingBoundary: _hasLoadingBoundary,
    isDynamicError,
    isForceDynamic,
    isForceStatic,
    isProduction: process.env.NODE_ENV === "production",
    isRscRequest,
    isrDebug: __isrDebug,
    isrHtmlKey: __isrHtmlKey,
    isrRscKey: __isrRscKey,
    isrSet: __isrSet,
    layoutCount: route.layouts?.length ?? 0,
    loadSsrHandler() {
      return import.meta.viteRsc.loadModule("ssr", "index");
    },
    middlewareContext: _mwCtx,
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
        __collectAppPageSearchParams(url.searchParams).searchParamsObject,
      );
      return PageComponent({ params: _asyncRouteParams, searchParams: _asyncSearchParams });
    },
    classification: {
      getLayoutId(index) {
        const tp = route.layoutTreePositions?.[index] ?? 0;
        return "layout:" + __createAppPageTreePath(route.routeSegments, tp);
      },
      buildTimeClassifications: route.__buildTimeClassifications,
      buildTimeReasons: route.__buildTimeReasons,
      debugClassification: __classDebug,
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
    revalidateSeconds,
    mountedSlotsHeader: __mountedSlotsHeader,
    renderErrorBoundaryResponse(renderErr) {
      return renderErrorBoundaryPage(route, renderErr, isRscRequest, request, params, _scriptNonce, _mwCtx);
    },
    async renderLayoutSpecialError(__layoutSpecialError, li) {
      return __buildAppPageSpecialErrorResponse({
        clearRequestContext() {
          __clearRequestContext();
        },
        middlewareContext: _mwCtx,
        renderFallbackPage(statusCode) {
          const parentBoundary = __resolveAppPageParentHttpAccessBoundaryModule({
            layoutIndex: li,
            rootForbiddenModule: ${rootForbiddenVar ?? "null"},
            rootNotFoundModule: ${rootNotFoundVar ?? "null"},
            rootUnauthorizedModule: ${rootUnauthorizedVar ?? "null"},
            routeForbiddenModules: route.forbiddens,
            routeNotFoundModules: route.notFounds,
            routeUnauthorizedModules: route.unauthorizeds,
            statusCode,
          })?.default ?? null;
          const parentLayouts = route.layouts.slice(0, li);
          return renderHTTPAccessFallbackPage(
            route,
            statusCode,
            isRscRequest,
            request,
            {
              boundaryComponent: parentBoundary,
              layouts: parentLayouts,
              matchedParams: params,
            },
            _scriptNonce,
            // buildAppPageSpecialErrorResponse merges _mwCtx onto this returned
            // fallback response; keep this inner boundary render unmerged so
            // additive headers like Set-Cookie and Vary are not duplicated.
            null,
          );
        },
        requestUrl: request.url,
        specialError: __layoutSpecialError,
      });
    },
    async renderPageSpecialError(specialError) {
      return __buildAppPageSpecialErrorResponse({
        clearRequestContext() {
          __clearRequestContext();
        },
        middlewareContext: _mwCtx,
        renderFallbackPage(statusCode) {
          return renderHTTPAccessFallbackPage(
            route,
            statusCode,
            isRscRequest,
            request,
            {
              matchedParams: params,
            },
            _scriptNonce,
            // buildAppPageSpecialErrorResponse merges _mwCtx onto this returned
            // fallback response; keep this inner boundary render unmerged so
            // additive headers like Set-Cookie and Vary are not duplicated.
            null,
          );
        },
        requestUrl: request.url,
        specialError,
      });
    },
    renderToReadableStream,
    routeHasLocalBoundary: !!(route?.error?.default) || !!(route?.errors && route.errors.some(function(e) { return e?.default; })),
    routePattern: route.pattern,
    runWithSuppressedHookWarning(probe) {
      // Run inside ALS context so the module-level console.error patch suppresses
      // "Invalid hook call" only for this request's probe — concurrent requests
      // each have their own ALS store and are unaffected.
      return _suppressHookWarningAls.run(true, probe);
    },
    scriptNonce: _scriptNonce,
    waitUntil(__cachePromise) {
      _getRequestExecutionContext()?.waitUntil(__cachePromise);
    },
  });
}

if (import.meta.hot) {
  import.meta.hot.accept();
}
`;
}
