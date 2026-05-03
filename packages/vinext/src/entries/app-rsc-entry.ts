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
const appRscRequestNormalizationPath = resolveEntryPath(
  "../server/app-rsc-request-normalization.js",
  import.meta.url,
);
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
const appPageResponsePath = resolveEntryPath("../server/app-page-response.js", import.meta.url);
const appPageDispatchPath = resolveEntryPath("../server/app-page-dispatch.js", import.meta.url);
const cspPath = resolveEntryPath("../server/csp.js", import.meta.url);
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
const appPageElementBuilderPath = resolveEntryPath(
  "../server/app-page-element-builder.js",
  import.meta.url,
);
const errorCausePath = resolveEntryPath("../utils/error-cause.js", import.meta.url);
const instrumentationRuntimePath = resolveEntryPath(
  "../server/instrumentation-runtime.js",
  import.meta.url,
);
const appPostMiddlewareContextPath = resolveEntryPath(
  "../server/app-post-middleware-context.js",
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
import { handleMetadataRouteRequest as __handleMetadataRouteRequest } from ${JSON.stringify(metadataRouteResponsePath)};
import { requestContextFromRequest, matchRedirect, matchRewrite, isExternalUrl, proxyExternalRequest, sanitizeDestination } from ${JSON.stringify(configMatchersPath)};
import { normalizeRscRequest as __normalizeRscRequest } from ${JSON.stringify(appRscRequestNormalizationPath)};
import { buildPostMwRequestContext } from ${JSON.stringify(appPostMiddlewareContextPath)};
import { decodePathParams as __decodePathParams, normalizePath as __normalizePath } from ${JSON.stringify(normalizePathModulePath)};
import { normalizePathnameForRouteMatch as __normalizePathnameForRouteMatch } from ${JSON.stringify(routingUtilsPath)};
import { buildRequestHeadersFromMiddlewareResponse as __buildRequestHeadersFromMiddlewareResponse } from ${JSON.stringify(middlewareRequestHeadersPath)};
import { applyConfigHeadersToResponse, resolvePublicFileRoute, validateImageUrl, hasBasePath, normalizeTrailingSlash } from ${JSON.stringify(requestPipelinePath)};
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
  mergeMiddlewareResponseHeaders as __mergeMiddlewareResponseHeaders,
} from ${JSON.stringify(appPageResponsePath)};
import {
  dispatchAppPage as __dispatchAppPage,
} from ${JSON.stringify(appPageDispatchPath)};
import { getScriptNonceFromHeaderSources as __getScriptNonceFromHeaderSources } from ${JSON.stringify(cspPath)};
import { buildPageCacheTags } from ${JSON.stringify(implicitTagsPath)};
import { getRequestExecutionContext as _getRequestExecutionContext } from ${JSON.stringify(requestContextShimPath)};
import { setRootParams as __setRootParams, pickRootParams as __pickRootParams } from ${JSON.stringify(rootParamsShimPath)};
import { makeThenableParams } from ${JSON.stringify(thenableParamsShimPath)};
import { ensureFetchPatch as _ensureFetchPatch, setCurrentFetchSoftTags } from "vinext/fetch-cache";
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
    return createAppRscOnErrorHandler(_reportRequestError, request, pathname, routePath);
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

// ── Config pattern matching, redirects, rewrites, headers, CSRF validation,
//    external URL proxy, cookie parsing, and request context are imported from
//    config-matchers.ts and request-pipeline.ts (see import statements above).
//    This eliminates ~250 lines of duplicated inline code and ensures the
//    single-pass tokenizer in config-matchers.ts is used consistently
//    (fixing the chained .replace() divergence flagged by CodeQL).

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
  // This is a no-op after the first call (guarded by the shared promise in
  // ensureInstrumentationRegistered).
  await __ensureInstrumentationRegistered(_instrumentation);
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

  // ── Cross-origin request protection (dev only) ─────────────────────
  // Block requests from non-localhost origins to prevent data exfiltration.
  // Skipped in production — Vite replaces NODE_ENV at build time.
  if (process.env.NODE_ENV !== "production") {
    const __originBlock = __validateDevRequestOrigin(request);
    if (__originBlock) return __originBlock;
  }

  // Normalize the request: protocol-relative guard, strict percent-decode,
  // path normalization, basePath check/strip, RSC detection, and header sanitization.
  const __norm = __normalizeRscRequest(request, __basePath);
  if (__norm instanceof Response) return __norm;
  const { url, isRscRequest, interceptionContextHeader, mountedSlotsHeader: __mountedSlotsHeader } = __norm;
  let { pathname, cleanPathname } = __norm;

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
  const __postMwReqCtx = buildPostMwRequestContext(request);

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
      return createAppRscOnErrorHandler(_reportRequestError, actionRequest, actionPathname, routePattern);
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
    const notFoundResponse = await __fallbackRenderer.renderNotFound(null, isRscRequest, request, undefined, _scriptNonce, _mwCtx);
    if (notFoundResponse) return notFoundResponse;
    __clearRequestContext();
    const notFoundHeaders = new Headers();
    __mergeMiddlewareResponseHeaders(notFoundHeaders, _mwCtx.headers);
    return new Response("Not Found", { status: 404, headers: notFoundHeaders });
  }

  const { route, params } = match;

  // Update navigation context with matched params
  setNavigationContext({
    pathname: cleanPathname,
    searchParams: url.searchParams,
    params,
  });
  __setRootParams(__pickRootParams(params, route.rootParamNames));

  // Handle route.ts API handlers
  if (route.routeHandler) {
    setCurrentFetchSoftTags(
      buildPageCacheTags(cleanPathname, [], route.routeSegments, "route"),
    );
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

  const PageComponent = route.page?.default;
  const _asyncRouteParams = makeThenableParams(params);
  return __dispatchAppPage({
    buildPageElement(targetRoute, targetParams, targetOpts, targetSearchParams) {
      return buildPageElements(targetRoute, targetParams, cleanPathname, {
        opts: targetOpts,
        searchParams: targetSearchParams,
        isRscRequest,
        request,
        mountedSlotsHeader: __mountedSlotsHeader,
      });
    },
    cleanPathname,
    clearRequestContext() {
      __clearRequestContext();
    },
    createRscOnErrorHandler(pathname, routePath) {
      return createAppRscOnErrorHandler(_reportRequestError, request, pathname, routePath);
    },
    debugClassification: __classDebug,
    dynamicConfig: route.page?.dynamic,
    dynamicParamsConfig: route.page?.dynamicParams,
    findIntercept(pathname) {
      return findIntercept(pathname, interceptionContextHeader);
    },
    generateStaticParams: route.page?.generateStaticParams,
    getFontLinks: _getSSRFontLinks,
    getFontPreloads: _getSSRFontPreloads,
    getFontStyles: _getSSRFontStyles,
    getNavigationContext: _getNavigationContext,
    getSourceRoute(sourceRouteIndex) {
      return routes[sourceRouteIndex];
    },
    hasGenerateStaticParams: typeof route.page?.generateStaticParams === "function",
    hasPageDefaultExport: !!PageComponent,
    hasPageModule: !!route.page,
    handlerStart: __reqStart,
    interceptionContext: interceptionContextHeader,
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
    middlewareContext: _mwCtx,
    mountedSlotsHeader: __mountedSlotsHeader,
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
    renderErrorBoundaryPage(renderErr) {
      return __fallbackRenderer.renderErrorBoundary(route, renderErr, isRscRequest, request, params, _scriptNonce, _mwCtx);
    },
    renderHttpAccessFallbackPage(statusCode, opts, middlewareContext) {
      return __fallbackRenderer.renderHttpAccessFallback(route, statusCode, isRscRequest, request, opts, _scriptNonce, middlewareContext);
    },
    renderToReadableStream,
    request,
    revalidateSeconds: typeof route.page?.revalidate === "number" ? route.page.revalidate : null,
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
    scriptNonce: _scriptNonce,
    searchParams: url.searchParams,
    setNavigationContext,
  });
}

if (import.meta.hot) {
  import.meta.hot.accept();
}
`;
}
