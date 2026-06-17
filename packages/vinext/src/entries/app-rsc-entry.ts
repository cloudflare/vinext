/**
 * App Router RSC entry generator.
 *
 * Generates the virtual RSC entry module for the App Router.
 * The RSC entry does route matching and renders the component tree,
 * then delegates to the SSR entry for HTML generation.
 *
 * Previously housed in server/app-dev-server.ts.
 */
import { randomUUID } from "node:crypto";
import { buildAppRscManifestCode } from "./app-rsc-manifest.js";
import { resolveEntryPath } from "./runtime-entry-module.js";
import { normalizePathSeparators } from "../utils/path.js";
import type {
  NextHeader,
  NextI18nConfig,
  NextRedirect,
  NextRewrite,
} from "../config/next-config.js";
import type { ImageConfig } from "../server/image-optimization.js";
import type { AppRoute } from "../routing/app-router.js";
import { generateDevOriginCheckCode } from "../server/dev-origin-check.js";
import type { MetadataFileRoute } from "../server/metadata-routes.js";
import { isProxyFile } from "../server/middleware.js";

const DEFAULT_EXPIRE_TIME = 31_536_000;
const DEFAULT_REACT_MAX_HEADERS_LENGTH = 6000;

// Pre-computed absolute paths for generated-code imports. The virtual RSC
// entry can't use relative imports (it has no real file location), so we
// resolve these at code-generation time and embed them as absolute paths.
const middlewareRequestHeadersPath = resolveEntryPath(
  "../server/middleware-request-headers.js",
  import.meta.url,
);
const normalizePathModulePath = resolveEntryPath("../server/normalize-path.js", import.meta.url);
const appRouteHandlerDispatchPath = resolveEntryPath(
  "../server/app-route-handler-dispatch.js",
  import.meta.url,
);
const appRouteHandlerResponsePath = resolveEntryPath(
  "../server/app-route-handler-response.js",
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
const appPageProbePath = resolveEntryPath("../server/app-page-probe.js", import.meta.url);
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
const appRouteModuleLoaderPath = resolveEntryPath(
  "../server/app-route-module-loader.js",
  import.meta.url,
);
const appPrerenderStaticParamsPath = resolveEntryPath(
  "../server/app-prerender-static-params.js",
  import.meta.url,
);
const seedCachePath = resolveEntryPath("../server/seed-cache.js", import.meta.url);
const pregeneratedConcretePathsPath = resolveEntryPath(
  "../server/pregenerated-concrete-paths.js",
  import.meta.url,
);
const appHookWarningSuppressionPath = resolveEntryPath(
  "../server/app-hook-warning-suppression.js",
  import.meta.url,
);
const serverGlobalsPath = resolveEntryPath("../server/server-globals.js", import.meta.url);
const appPagesBridgePath = resolveEntryPath("../server/app-pages-bridge.js", import.meta.url);

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
  /** Verbatim body size limit config value (e.g. "2mb") for the "Body exceeded {limit} limit" error. */
  bodySizeLimitLabel?: string;
  /** Serialized next.config htmlLimitedBots regexp source. */
  htmlLimitedBots?: string;
  /**
   * Allow-list of keys (from `experimental.clientTraceMetadata`) to surface
   * from the active OpenTelemetry context as `<meta>` tags in the SSR head.
   * Undefined or empty disables emission entirely.
   */
  clientTraceMetadata?: string[] | undefined;
  /**
   * Resolved `assetPrefix` from next.config. Empty string when unset.
   * Embedded in the generated entry so the App Router prod-server reads
   * it from the imported module instead of a sidecar JSON file —
   * matches how the Pages Router entry exposes `vinextConfig.assetPrefix`.
   *
   * @see https://nextjs.org/docs/app/api-reference/config/next-config-js/assetPrefix
   */
  assetPrefix?: string;
  /** Route-level expire fallback in seconds for ISR entries with numeric revalidate. */
  expireTime?: number;
  /**
   * Maximum total length (in characters) of the preload `Link` header emitted
   * during App Router SSR. `0` disables emission. Defaults to 6000.
   */
  reactMaxHeadersLength?: number;
  /** Maximum in-memory cache size in bytes. 0 disables the default memory cache. */
  cacheMaxMemorySize?: number;
  /** Inline app CSS into production HTML (from experimental.inlineCss). */
  inlineCss?: boolean;
  /** Enables Next.js Cache Components semantics for App Router document HTML. */
  cacheComponents?: boolean;
  /** Internationalization routing config for middleware matcher locale handling. */
  i18n?: NextI18nConfig | null;
  imageConfig?: ImageConfig;
  /**
   * Absolute path to `app/global-not-found.{tsx,ts,js,jsx}` when present.
   * When provided, route-miss 404s render this module standalone (it owns its
   * own `<html>` and `<body>`) instead of wrapping the regular `not-found.tsx`
   * boundary inside the root layout. Mirrors Next.js 16's
   * `experimental.globalNotFound` behavior.
   * @see https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/global-not-found
   */
  globalNotFoundPath?: string | null;
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
  /** Server-only token used to validate the draft-mode bypass cookie. */
  draftModeSecret?: string;
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
  const bodySizeLimitLabel = config?.bodySizeLimitLabel ?? "1 MB";
  const htmlLimitedBots = config?.htmlLimitedBots;
  const clientTraceMetadata = config?.clientTraceMetadata;
  const assetPrefix = config?.assetPrefix ?? "";
  const expireTime = config?.expireTime ?? DEFAULT_EXPIRE_TIME;
  const reactMaxHeadersLength = config?.reactMaxHeadersLength ?? DEFAULT_REACT_MAX_HEADERS_LENGTH;
  const cacheMaxMemorySize = config?.cacheMaxMemorySize;
  const inlineCss = config?.inlineCss === true;
  const cacheComponents = config?.cacheComponents === true;
  const i18nConfig = config?.i18n ?? null;
  const hasPagesDir = config?.hasPagesDir ?? false;
  const publicFiles = config?.publicFiles ?? [];
  const draftModeSecret = config?.draftModeSecret ?? randomUUID();
  const manifestCode = buildAppRscManifestCode({
    routes,
    metadataRoutes,
    globalErrorPath,
    globalNotFoundPath: config?.globalNotFoundPath ?? null,
  });
  const {
    imports,
    routeEntries,
    metaRouteEntries,
    generateStaticParamsEntries,
    rootParamNameEntries,
    rootNotFoundVar,
    rootForbiddenVar,
    rootUnauthorizedVar,
    rootLayoutVars,
    globalErrorVar,
    globalNotFoundImportSpecifier,
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
import ${JSON.stringify(serverGlobalsPath)};
import {
  renderToReadableStream as _renderToReadableStream,
  decodeAction,
  decodeFormState,
  decodeReply,
  loadServerAction,
  createTemporaryReferenceSet,
} from "@vitejs/plugin-rsc/rsc";
import { createClientManifest as _createClientManifest } from "@vitejs/plugin-rsc/core/rsc";
import { prerender as _prerender } from "@vitejs/plugin-rsc/vendor/react-server-dom/static.edge";
import { createRscPrerenderer, createRscRenderer } from ${JSON.stringify(rscStreamHintsPath)};

const renderToReadableStream = createRscRenderer(_renderToReadableStream);
const prerenderToReadableStream = createRscPrerenderer(async (model, options) =>
  _prerender(model, _createClientManifest(), options),
);
import { createElement } from "react";
import { getNavigationContext as _getNavigationContext } from "next/navigation";
import { configureMemoryCacheHandler as __configureMemoryCacheHandler } from "next/cache";
import { headersContextFromRequest, getDraftModeCookieHeader, getAndClearPendingCookies, consumeDynamicUsage, consumeInvalidDynamicUsageError, setHeadersAccessPhase } from "next/headers";
import { mergeMetadata, resolveModuleMetadata, mergeViewport, resolveModuleViewport } from "vinext/metadata";
${middlewarePath ? `import * as middlewareModule from ${JSON.stringify(normalizePathSeparators(middlewarePath))};` : ""}
${
  instrumentationPath
    ? `import * as _instrumentation from ${JSON.stringify(normalizePathSeparators(instrumentationPath))};
import { ensureInstrumentationRegistered as __ensureInstrumentationRegistered } from ${JSON.stringify(instrumentationRuntimePath)};`
    : ""
}
import { createAppRscHandler } from "vinext/server/app-rsc-handler";
import { registerConfiguredCacheAdapters as __registerConfiguredCacheAdapters } from "virtual:vinext-cache-adapters";
import { decodePathParams as __decodePathParams } from ${JSON.stringify(normalizePathModulePath)};
import { buildRequestHeadersFromMiddlewareResponse as __buildRequestHeadersFromMiddlewareResponse } from ${JSON.stringify(middlewareRequestHeadersPath)};
import {
  dispatchAppRouteHandler as __dispatchAppRouteHandler,
} from ${JSON.stringify(appRouteHandlerDispatchPath)};
import {
  applyRouteHandlerMiddlewareContext as __applyRouteHandlerMiddlewareContext,
} from ${JSON.stringify(appRouteHandlerResponsePath)};
import {
  handleProgressiveServerActionRequest as __handleProgressiveServerActionRequest,
  handleServerActionRscRequest as __handleServerActionRscRequest,
  isProgressiveServerActionRequest as __isProgressiveServerActionRequest,
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
  AppElementsWire as __AppElementsWire,
} from ${JSON.stringify(appElementsPath)};
import {
  probeAppPageLayoutWithTracking as __probeAppPageLayoutWithTracking,
  resolveAppPageChildSegments as __resolveAppPageChildSegments,
} from ${JSON.stringify(appPageRouteWiringPath)};
import { buildPageElements as __buildPageElements } from ${JSON.stringify(appPageElementBuilderPath)};
import { buildAppPageProbes as __buildAppPageProbes } from ${JSON.stringify(appPageProbePath)};
import {
  dispatchAppPage as __dispatchAppPage,
} from ${JSON.stringify(appPageDispatchPath)};
import {
  resolveAppPageGenerateStaticParamsSources as __resolveAppPageGenerateStaticParamsSources,
} from ${JSON.stringify(appPageRequestPath)};
import {
  isEdgeRuntime as __isEdgeRuntime,
  resolveAppPageFetchCacheMode as __resolveAppPageFetchCacheMode,
  resolveAppPageSegmentConfig as __resolveAppPageSegmentConfig,
} from ${JSON.stringify(appSegmentConfigPath)};
import { makeThenableParams } from ${JSON.stringify(thenableParamsShimPath)};
import {
  createAppRscRouteMatcher as __createAppRscRouteMatcher,
  SIBLING_PAGE_INTERCEPT_SLOT_KEY as __SIBLING_PAGE_INTERCEPT_SLOT_KEY,
} from ${JSON.stringify(appRscRouteMatchingPath)};
import {
  appIsrHtmlKey as __isrHtmlKey,
  appIsrRscKey as __isrRscKey,
  appIsrRouteKey as __isrRouteKey,
  isrGet as __isrGet,
  isrSet as __isrSet,
  isrSetPrerenderedAppPage as __isrSetPrerenderedAppPage,
  triggerBackgroundRegeneration as __triggerBackgroundRegeneration,
} from ${JSON.stringify(isrCachePath)};
// Import server-only state module to register ALS-backed accessors.
import "vinext/navigation-state";
import { reportRequestError as _reportRequestError } from "vinext/instrumentation";
import { getSSRFontLinks as _getSSRFontLinks, getSSRFontStyles as _getSSRFontStylesGoogle, getSSRFontPreloads as _getSSRFontPreloadsGoogle } from "next/font/google";
import { getSSRFontStyles as _getSSRFontStylesLocal, getSSRFontPreloads as _getSSRFontPreloadsLocal } from "next/font/local";
function _getSSRFontStyles() { return [..._getSSRFontStylesGoogle(), ..._getSSRFontStylesLocal()]; }
function _getSSRFontPreloads() { return [..._getSSRFontPreloadsGoogle(), ..._getSSRFontPreloadsLocal()]; }
${
  hasPagesDir
    ? `// Pages Router routes are loaded lazily from the SSR environment for internal prerender requests.
import { renderPagesFallback as __renderPagesFallback } from ${JSON.stringify(appPagesBridgePath)};`
    : ""
}

// Suppress expected "Invalid hook call" dev warning when layout/page
// components are probed outside React's render cycle. The import patches
// console.error once at module load (side-effect) and exposes the ALS
// so per-route dispatch can opt into suppression via .run(true, ...).
import { suppressHookWarningAls } from ${JSON.stringify(appHookWarningSuppressionPath)};
import { clearAppRequestContext as __clearRequestContext, setAppNavigationContext as setNavigationContext } from ${JSON.stringify(appRequestContextPath)};

__configureMemoryCacheHandler({ cacheMaxMemorySize: ${JSON.stringify(cacheMaxMemorySize)} });
import { createAppPrerenderStaticParamsResolver as __createAppPrerenderStaticParamsResolver } from ${JSON.stringify(appPrerenderStaticParamsPath)};
import { ensureAppRouteModulesLoaded as __ensureRouteLoaded } from ${JSON.stringify(appRouteModuleLoaderPath)};
import { seedMemoryCacheFromPrerender as __seedMemoryCacheFromPrerender } from ${JSON.stringify(seedCachePath)};
import {
  getRenderedConcreteUrlPathsForRoute as __getRenderedConcreteUrlPathsForRoute,
  initPregeneratedPathsFromGlobals as __initPregeneratedPathsFromGlobals,
} from ${JSON.stringify(pregeneratedConcretePathsPath)};

const __draftModeSecret = ${JSON.stringify(draftModeSecret)};

__initPregeneratedPathsFromGlobals();

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

function __resolveRouteDynamicConfig(route) {
  return __resolveAppPageSegmentConfig({
    layouts: route.layouts,
    page: route.page,
  }).dynamicConfig ?? null;
}

function __resolveRouteRuntime(route) {
  return __resolveAppPageSegmentConfig({
    layouts: route.layouts,
    page: route.page,
  }).runtime ?? null;
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

// Build-time layout classification dispatch. Replaced in renderChunk
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
// Replaced in renderChunk with a real dispatch table; the stub returns
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

// Hoisted ahead of __fallbackRenderer / buildPageElements so both can thread
// the configured basePath through file-based metadata href emission.
// Re-exported so the Cloudflare worker entry can strip basePath before
// recognising /_next/static/* paths (parity with __assetPrefix below).
export const __basePath = ${JSON.stringify(bp)};

// Hoisted alongside __basePath so __fallbackRenderer / buildPageElements can
// thread the configured trailingSlash flag through canonical URL rendering.
const __trailingSlash = ${JSON.stringify(ts)};

const rootNotFoundModule = ${rootNotFoundVar ? rootNotFoundVar : "null"};
const rootForbiddenModule = ${rootForbiddenVar ? rootForbiddenVar : "null"};
const rootUnauthorizedModule = ${rootUnauthorizedVar ? rootUnauthorizedVar : "null"};
const rootLayouts = [${rootLayoutVars.join(", ")}];
// Root-level app/global-not-found loader. When present, route-miss 404s render
// this module standalone (it provides its own html/body) instead of wrapping
// the not-found.tsx boundary inside the root layout. Page-triggered notFound()
// calls still use the regular not-found.tsx boundary inside the layouts.
//
// The module is loaded via dynamic \`import()\` (not a static \`import * as\`)
// so the bundler emits it in its own JS+CSS chunk. Without that isolation,
// global-not-found's CSS gets concatenated with the root layout's CSS into a
// single file, where the CSS minifier (lightningcss) drops overlapping
// declarations as dead code — breaking the cascade for route-miss 404s.
// See https://github.com/vercel/next.js/blob/canary/packages/next/src/server/app-render/app-render.tsx#L495-L520
// See Next.js test: test/e2e/app-dir/initial-css-order/initial-css-order.test.ts
const __loadGlobalNotFoundModule = ${
    globalNotFoundImportSpecifier ? `() => import(${globalNotFoundImportSpecifier})` : "null"
  };

const createRscOnErrorHandler = (request, pathname, routePath) =>
  createAppRscOnErrorHandler(_reportRequestError, request, pathname, routePath);

const __fallbackRenderer = __createAppFallbackRenderer({
  basePath: __basePath,
  trailingSlash: __trailingSlash,
  rootBoundaries: {
    rootForbiddenModule,
    rootLayouts,
    rootNotFoundModule,
    rootUnauthorizedModule,
  },
  globalErrorModule: ${globalErrorVar ? globalErrorVar : "null"},
  loadGlobalNotFoundModule: __loadGlobalNotFoundModule,
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

async function buildPageElements(route, params, routePath, pageRequest, layoutParamAccess, displayPathname = routePath) {
  // Hydrate lazy page/route-handler modules before any synchronous read.
  await __ensureRouteLoaded(route);
  return __buildPageElements({
    route,
    params,
    routePath,
    displayPathname,
    pageRequest,
    globalErrorModule: ${globalErrorVar ? globalErrorVar : "null"},
    rootNotFoundModule: ${rootNotFoundVar ? rootNotFoundVar : "null"},
    rootForbiddenModule: ${rootForbiddenVar ? rootForbiddenVar : "null"},
    rootUnauthorizedModule: ${rootUnauthorizedVar ? rootUnauthorizedVar : "null"},
    metadataRoutes,
    layoutParamAccess,
    basePath: __basePath,
    trailingSlash: __trailingSlash,
    htmlLimitedBots: __htmlLimitedBots,
  });
}

const __i18nConfig = ${JSON.stringify(i18nConfig)};
const __configRedirects = ${JSON.stringify(redirects)};
const __configRewrites = ${JSON.stringify(rewrites)};
const __configHeaders = ${JSON.stringify(headers)};
const __imageConfig = ${JSON.stringify(config?.imageConfig)};
const __publicFiles = new Set(${JSON.stringify(publicFiles)});
const __allowedOrigins = ${JSON.stringify(allowedOrigins)};
const __expireTime = ${JSON.stringify(expireTime)};
const __htmlLimitedBots = ${JSON.stringify(htmlLimitedBots)};
const __clientTraceMetadata = ${JSON.stringify(clientTraceMetadata)};
const __reactMaxHeadersLength = ${JSON.stringify(reactMaxHeadersLength)};
// Re-exported for the App Router prod-server to consume at startup —
// mirrors the embedded \`__basePath\` pattern (and Pages Router's
// \`vinextConfig\` export). Empty string when unset.
export const __assetPrefix = ${JSON.stringify(assetPrefix)};
export const __inlineCss = ${JSON.stringify(inlineCss)};
export const __hasPagesDir = ${JSON.stringify(hasPagesDir)};
export const getRenderedConcreteUrlPathsForRoute = __getRenderedConcreteUrlPathsForRoute;
const __cacheComponents = ${JSON.stringify(cacheComponents)};

export function seedMemoryCacheFromPrerender(serverDir) {
  return __seedMemoryCacheFromPrerender(serverDir, {
    buildAppPageHtmlKey(pathname) {
      return __isrHtmlKey(pathname);
    },
    buildAppPageRscKey(pathname) {
      return __isrRscKey(pathname);
    },
    writeAppPageEntry(key, data, metadata) {
      return __isrSetPrerenderedAppPage(key, data, metadata);
    },
  });
}

${generateDevOriginCheckCode(config?.allowedDevOrigins)}

/**
 * Maximum server-action request body size.
 * Configurable via experimental.serverActions.bodySizeLimit in next.config.
 * Defaults to 1MB, matching the Next.js default.
 * @see https://nextjs.org/docs/app/api-reference/config/next-config-js/serverActions#bodysizelimit
 * Prevents unbounded request body buffering.
 */
var __MAX_ACTION_BODY_SIZE = ${JSON.stringify(bodySizeLimit)};

/**
 * Verbatim serverActions.bodySizeLimit config value (e.g. "2mb"), used in the
 * "Body exceeded {limit} limit" error so the message matches Next.js byte-for-byte.
 * Defaults to "1 MB" (Next.js' defaultBodySizeLimit literal).
 */
var __MAX_ACTION_BODY_SIZE_LABEL = ${JSON.stringify(bodySizeLimitLabel)};

// Map from route pattern to generateStaticParams function.
// Used by the prerender phase to enumerate dynamic route URLs without
// loading route modules via the dev server.
export const generateStaticParamsMap = {
${generateStaticParamsEntries.join("\n")}
};${loadPrerenderPagesRoutesCode}
const rootParamNamesMap = {
${rootParamNameEntries.join("\n")}
};

export default createAppRscHandler({
  basePath: __basePath,
  buildId: process.env.__VINEXT_BUILD_ID ?? null,
  ensureRouteLoaded: __ensureRouteLoaded,
  clearRequestContext() {
    __clearRequestContext();
  },
  registerCacheAdapters: __registerConfiguredCacheAdapters,
  configHeaders: __configHeaders,
  cacheComponents: __cacheComponents,
  configRedirects: __configRedirects,
  configRewrites: __configRewrites,
  imageConfig: __imageConfig,
  isDev: process.env.NODE_ENV !== "production",
  draftModeSecret: __draftModeSecret,
  dispatchMatchedPage({
    clientReuseManifest,
    cleanPathname,
    displayPathname,
    formState,
    actionError,
    actionFailed,
    handlerStart,
    interceptionContext,
    isProgressiveActionRender,
    isRscRequest,
    middlewareContext,
    mountedSlotsHeader,
    params,
    pprFallbackCacheShells,
    pprFallbackShell,
    renderedConcreteUrlPaths,
    skipStaticParamsValidation,
    staticParamsValidationParams,
    rootParams,
    request,
    route,
    scriptNonce,
    searchParams,
    renderMode,
  }) {
    const PageComponent = route.page?.default;
    const __segmentConfig = __resolveAppPageSegmentConfig({
      layouts: route.layouts,
      page: route.page,
      parallelPages: Object.values(route.slots ?? {}).map((slot) => slot.page),
    });
    const __generateStaticParams = __resolveAppPageGenerateStaticParamsSources({
      layouts: route.layouts,
      layoutTreePositions: route.layoutTreePositions,
      page: route.page,
      routeSegments: route.routeSegments,
    });
    const _asyncRouteParams = makeThenableParams(params);
    return __dispatchAppPage({
      basePath: __basePath,
      ensureRouteLoaded: __ensureRouteLoaded,
      clientTraceMetadata: __clientTraceMetadata,
      reactMaxHeadersLength: __reactMaxHeadersLength,
      buildPageElement(targetRoute, targetParams, targetOpts, targetSearchParams, layoutParamAccess) {
        return buildPageElements(targetRoute, targetParams, cleanPathname, {
          opts: targetOpts,
          searchParams: targetSearchParams,
          isRscRequest,
          request,
          mountedSlotsHeader,
          renderMode,
        }, layoutParamAccess, displayPathname);
      },
      clientReuseManifest,
      cleanPathname,
      displayPathname,
      clearRequestContext() {
        __clearRequestContext();
      },
      createRscOnErrorHandler(pathname, routePath) {
        return createRscOnErrorHandler(request, pathname, routePath);
      },
      debugClassification: __classDebug,
      draftModeSecret: __draftModeSecret,
      dynamicConfig: __segmentConfig.dynamicConfig,
      dynamicStaleTimeSeconds: __segmentConfig.dynamicStaleTimeSeconds,
      dynamicParamsConfig: __segmentConfig.dynamicParamsConfig,
      fetchCache: __segmentConfig.fetchCache ?? null,
      isEdgeRuntime: __isEdgeRuntime(__segmentConfig.runtime),
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
      hasCustomGlobalError: ${globalErrorVar ? `Boolean(${globalErrorVar}?.default)` : "false"},
      hasGenerateStaticParams: __generateStaticParams.length > 0,
      hasPageDefaultExport: !!PageComponent,
      hasPageModule: !!route.page,
      handlerStart,
      htmlLimitedBots: __htmlLimitedBots,
      interceptionContext,
      expireSeconds: __expireTime,
      formState,
      actionError,
      actionFailed,
      isProgressiveActionRender,
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
      pprFallbackCacheShells,
      pprFallbackShell,
      renderedConcreteUrlPaths,
      skipStaticParamsValidation,
      staticParamsValidationParams,
      rootParams,
      probeLayoutAt(li, layoutParamAccess) {
        return __probeAppPageLayoutWithTracking({
          layoutIndex: li,
          layoutParamAccess,
          makeThenableParams,
          matchedParams: params,
          route,
        });
      },
      async probePage() {
        const __probeIntercept = findIntercept(cleanPathname, interceptionContext);
        // The intercepting-route page module is lazy (page: null + __pageLoader).
        // Resolve it before probing so buildAppPageProbes inspects the real page
        // component for dynamic bailout — matching the render path, which also
        // awaits __pageLoader (resolveAppPageInterceptState). Without this the
        // intercept probe branch silently inspects an undefined component and
        // never observes the page's searchParams/headers access.
        if (__probeIntercept && __probeIntercept.__pageLoader && __probeIntercept.page == null) {
          __probeIntercept.page = await __probeIntercept.__pageLoader();
        }
        return Promise.all(__buildAppPageProbes({
          route,
          pageComponent: PageComponent,
          asyncRouteParams: _asyncRouteParams,
          searchParams,
          intercept: __probeIntercept,
          isRscRequest,
          matchedParams: params,
          makeThenableParams,
        }));
      },
      renderErrorBoundaryPage(renderErr) {
        const __activeIntercept = findIntercept(cleanPathname, interceptionContext);
        return __fallbackRenderer.renderErrorBoundary(route, renderErr, isRscRequest, request, params, scriptNonce, middlewareContext, {
          isEdgeRuntime: __isEdgeRuntime(__segmentConfig.runtime),
          sourcePageSegments: __activeIntercept?.slotKey === __SIBLING_PAGE_INTERCEPT_SLOT_KEY
            ? __activeIntercept.sourcePageSegments
            : null,
        });
      },
      renderHttpAccessFallbackPage(statusCode, opts, currentMiddlewareContext) {
        const __activeIntercept = findIntercept(cleanPathname, interceptionContext);
        return __fallbackRenderer.renderHttpAccessFallback(route, statusCode, isRscRequest, request, opts, scriptNonce, currentMiddlewareContext, {
          isEdgeRuntime: __isEdgeRuntime(__segmentConfig.runtime),
          sourcePageSegments: __activeIntercept?.slotKey === __SIBLING_PAGE_INTERCEPT_SLOT_KEY
            ? __activeIntercept.sourcePageSegments
            : null,
        });
      },
      renderToReadableStream,
      prerenderToReadableStream,
      request,
      revalidateSeconds: __segmentConfig.revalidateSeconds,
      resolveRouteFetchCacheMode(targetRoute) {
        return __resolveRouteFetchCacheMode(targetRoute);
      },
      resolveRouteDynamicConfig(targetRoute) {
        return __resolveRouteDynamicConfig(targetRoute);
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
      renderMode,
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
      draftModeSecret: __draftModeSecret,
      i18n: __i18nConfig,
      trailingSlash: __trailingSlash,
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
    // A multipart form POST to a page is always a server-action attempt, so a
    // body that decodes to no action must surface as 404 action-not-found
    // (#1340). Route handlers run after this dispatch and accept raw multipart
    // POSTs, so only flag actual page routes. The __loadPage / __loadRouteHandler
    // markers are static and available before lazy module hydration.
    //
    // Only the progressive (multipart, no actionId) POST path consults
    // hasPageRoute, so skip the route match entirely for every other request
    // rather than re-matching on each App Router request.
    const __isProgressiveAction = __isProgressiveServerActionRequest(
      request,
      contentType,
      actionId,
    );
    const __progressiveActionMatch = __isProgressiveAction ? matchRoute(cleanPathname) : null;
    const __hasPageRoute = Boolean(
      __progressiveActionMatch &&
        __progressiveActionMatch.route.__loadPage &&
        !__progressiveActionMatch.route.__loadRouteHandler,
    );
    return __handleProgressiveServerActionRequest({
      actionId,
      allowedOrigins: __allowedOrigins,
      basePath: __basePath,
      cleanPathname,
      clearRequestContext() {
        __clearRequestContext();
      },
      contentType,
      decodeAction,
      decodeFormState,
      getAndClearPendingCookies,
      getDraftModeCookieHeader,
      hasPageRoute: __hasPageRoute,
      maxActionBodySize: __MAX_ACTION_BODY_SIZE,
      middlewareHeaders: middlewareContext.headers,
      readFormDataWithLimit: __readFormDataWithLimit,
      reportRequestError: _reportRequestError,
      request,
      setHeadersAccessPhase,
    });
  },
  async handleServerActionRequest({
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
    const __actionMatch = matchRoute(cleanPathname);
    if (__actionMatch) await __ensureRouteLoaded(__actionMatch.route);
    const __actionIsEdgeRuntime = __actionMatch
      ? __isEdgeRuntime(__resolveAppPageSegmentConfig({ layouts: __actionMatch.route.layouts, page: __actionMatch.route.page }).runtime)
      : false;
    return __handleServerActionRscRequest({
      actionId,
      ensureRouteLoaded: __ensureRouteLoaded,
      allowedOrigins: __allowedOrigins,
      basePath: __basePath,
      isEdgeRuntime: __actionIsEdgeRuntime,
      buildPageElement({
        route: actionRoute,
        params: actionParams,
        cleanPathname: actionCleanPathname,
        interceptOpts,
        searchParams: actionSearchParams,
        isRscRequest: actionIsRscRequest,
        request: actionRequest,
        mountedSlotsHeader: actionMountedSlotsHeader,
        renderMode: actionRenderMode,
      }) {
        return buildPageElements(actionRoute, actionParams, actionCleanPathname, {
          opts: interceptOpts,
          searchParams: actionSearchParams,
          isRscRequest: actionIsRscRequest,
          request: actionRequest,
          mountedSlotsHeader: actionMountedSlotsHeader,
          renderMode: actionRenderMode,
        });
      },
      cleanPathname,
      clearRequestContext() {
        __clearRequestContext();
      },
      contentType,
      createNotFoundElement(actionRouteId) {
        return {
          ...__AppElementsWire.createMetadataEntries({
            interceptionContext: null,
            rootLayoutTreePath: null,
            routeId: actionRouteId,
          }),
          [actionRouteId]: createElement("div", null, "Page not found"),
        };
      },
      createPayloadRouteId(pathnameToRender, currentInterceptionContext) {
        return __AppElementsWire.encodeRouteId(pathnameToRender, currentInterceptionContext);
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
      maxActionBodySizeLabel: __MAX_ACTION_BODY_SIZE_LABEL,
      middlewareHeaders: middlewareContext.headers,
      middlewareStatus: middlewareContext.status,
      mountedSlotsHeader,
      readBodyWithLimit: __readBodyWithLimit,
      readFormDataWithLimit: __readFormDataWithLimit,
      renderToReadableStream,
      reportRequestError: _reportRequestError,
      resolveRouteFetchCacheMode(targetRoute) {
        return __resolveRouteFetchCacheMode(targetRoute);
      },
      resolveRouteDynamicConfig(targetRoute) {
        return __resolveRouteDynamicConfig(targetRoute);
      },
      resolveRouteRuntime: __resolveRouteRuntime,
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
          interceptSlotId: intercept.slotId,
          interceptSlotKey: intercept.slotKey,
          interceptSourceMatchedUrl: interceptionContext,
          interceptSourcePageSegments: intercept.sourcePageSegments,
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
    const __isEdge = route ? __isEdgeRuntime(__resolveAppPageSegmentConfig({ layouts: route.layouts, page: route.page }).runtime) : false;
    return __fallbackRenderer.renderNotFound(route, isRscRequest, request, matchedParams, scriptNonce, middlewareContext, { isEdgeRuntime: __isEdge });
  },
  ${
    hasPagesDir
      ? `async renderPagesFallback({ allowRscDocumentFallback, appRouteMatch, isDataRequest, isRscRequest, matchKind, middlewareContext, pathname, pagesDataRequest, request, url }) {
    return __renderPagesFallback(
      { allowRscDocumentFallback, appRouteMatch, isDataRequest, isRscRequest, matchKind, middlewareContext, pathname, pagesDataRequest, request, url },
      {
        loadPagesEntry() {
          return import.meta.viteRsc.loadModule("ssr", "index");
        },
        buildRequestHeaders: __buildRequestHeadersFromMiddlewareResponse,
        decodePathParams: __decodePathParams,
        applyRouteHandlerMiddlewareContext: __applyRouteHandlerMiddlewareContext,
        getDraftModeCookieHeader,
      }
    );
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
