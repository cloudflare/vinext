/**
 * Pages Router server entry generator.
 *
 * Generates the virtual SSR server entry module (`virtual:vinext-server-entry`).
 * This is the entry point for `vite build --ssr`. It handles SSR, API routes,
 * middleware, ISR, and i18n for the Pages Router.
 *
 * Extracted from index.ts.
 */
import { resolveEntryPath } from "./runtime-entry-module.js";
import { normalizePathSeparators } from "../utils/path.js";
import { pagesRouter, apiRouter, type Route } from "../routing/pages-router.js";
import { createValidFileMatcher } from "../routing/file-matcher.js";
import { type ResolvedNextConfig } from "../config/next-config.js";
import { isProxyFile } from "../server/middleware.js";
import { findFileWithExts } from "./pages-entry-helpers.js";

const _requestContextShimPath = resolveEntryPath("../shims/request-context.js", import.meta.url);
const _middlewareRuntimePath = resolveEntryPath("../server/middleware-runtime.js", import.meta.url);
const _routeTriePath = resolveEntryPath("../routing/route-trie.js", import.meta.url);
const _pagesI18nPath = resolveEntryPath("../server/pages-i18n.js", import.meta.url);
const _pagesDataRoutePath = resolveEntryPath("../server/pages-data-route.js", import.meta.url);
const _pagesDefault404Path = resolveEntryPath("../server/pages-default-404.js", import.meta.url);
const _pagesApiRoutePath = resolveEntryPath("../server/pages-api-route.js", import.meta.url);
const _serverGlobalsPath = resolveEntryPath("../server/server-globals.js", import.meta.url);
const _queryUtilsPath = resolveEntryPath("../utils/query.js", import.meta.url);
const _pagesPageHandlerPath = resolveEntryPath("../server/pages-page-handler.js", import.meta.url);

/**
 * Generate the virtual SSR server entry module.
 * This is the entry point for `vite build --ssr`.
 */
export async function generateServerEntry(
  pagesDir: string,
  nextConfig: ResolvedNextConfig,
  fileMatcher: ReturnType<typeof createValidFileMatcher>,
  middlewarePath: string | null,
  instrumentationPath: string | null,
): Promise<string> {
  const pageRoutes = await pagesRouter(pagesDir, nextConfig?.pageExtensions, fileMatcher);
  const apiRoutes = await apiRouter(pagesDir, nextConfig?.pageExtensions, fileMatcher);

  // Generate import statements using absolute paths since virtual
  // modules don't have a real file location for relative resolution.
  const pageImports = pageRoutes.map((r: Route, i: number) => {
    const absPath = normalizePathSeparators(r.filePath);
    return `import * as page_${i} from ${JSON.stringify(absPath)};`;
  });

  const apiImports = apiRoutes.map((r: Route, i: number) => {
    const absPath = normalizePathSeparators(r.filePath);
    return `import * as api_${i} from ${JSON.stringify(absPath)};`;
  });

  // Build the route table — include filePath for SSR manifest lookup
  const pageRouteEntries = pageRoutes.map((r: Route, i: number) => {
    const absPath = normalizePathSeparators(r.filePath);
    return `  { pattern: ${JSON.stringify(r.pattern)}, patternParts: ${JSON.stringify(r.patternParts)}, isDynamic: ${r.isDynamic}, params: ${JSON.stringify(r.params)}, module: page_${i}, filePath: ${JSON.stringify(absPath)} }`;
  });

  const apiRouteEntries = apiRoutes.map(
    (r: Route, i: number) =>
      `  { pattern: ${JSON.stringify(r.pattern)}, patternParts: ${JSON.stringify(r.patternParts)}, isDynamic: ${r.isDynamic}, params: ${JSON.stringify(r.params)}, module: api_${i} }`,
  );

  // Check for _app, _document, and _error.
  const appFilePath = findFileWithExts(pagesDir, "_app", fileMatcher);
  const docFilePath = findFileWithExts(pagesDir, "_document", fileMatcher);
  const errorFilePath = findFileWithExts(pagesDir, "_error", fileMatcher);
  // Embed the resolved _app path (or null) so the runtime can look it up
  // in the SSR manifest and include any CSS/JS chunks `_app` brings in
  // (e.g. global stylesheets imported by `_app.tsx`) alongside the page's
  // own assets. Without this, `_app`-imported CSS is emitted by Vite but
  // never `<link>`ed from the rendered HTML — see LHF-5 cluster.
  const appAssetPathJson = appFilePath !== null ? JSON.stringify(appFilePath) : "null";
  const appImportCode =
    appFilePath !== null
      ? `import { default as AppComponent } from ${JSON.stringify(appFilePath)};`
      : `const AppComponent = null;`;

  const docImportCode =
    docFilePath !== null
      ? `import { default as DocumentComponent } from ${JSON.stringify(docFilePath)};`
      : `const DocumentComponent = null;`;

  const errorAssetPathJson = errorFilePath !== null ? JSON.stringify(errorFilePath) : "null";
  const errorImportCode =
    errorFilePath !== null
      ? `import * as ErrorPageModule from ${JSON.stringify(errorFilePath)};`
      : `const ErrorPageModule = null;`;

  // Serialize i18n config for embedding in the server entry
  const i18nConfigJson = nextConfig?.i18n
    ? JSON.stringify({
        locales: nextConfig.i18n.locales,
        defaultLocale: nextConfig.i18n.defaultLocale,
        localeDetection: nextConfig.i18n.localeDetection,
        domains: nextConfig.i18n.domains,
      })
    : "null";

  // Embed the resolved build ID at build time
  const buildIdJson = JSON.stringify(nextConfig?.buildId ?? null);

  // Serialize the full resolved config for the production server.
  // This embeds redirects, rewrites, headers, basePath, trailingSlash
  // so prod-server.ts can apply them without loading next.config.js at runtime.
  const vinextConfigJson = JSON.stringify({
    basePath: nextConfig?.basePath ?? "",
    assetPrefix: nextConfig?.assetPrefix ?? "",
    trailingSlash: nextConfig?.trailingSlash ?? false,
    redirects: nextConfig?.redirects ?? [],
    rewrites: nextConfig?.rewrites ?? { beforeFiles: [], afterFiles: [], fallback: [] },
    headers: nextConfig?.headers ?? [],
    expireTime: nextConfig?.expireTime,
    cacheMaxMemorySize: nextConfig?.cacheMaxMemorySize,
    htmlLimitedBots: nextConfig?.htmlLimitedBots,
    i18n: nextConfig?.i18n ?? null,
    // Mirrors Next.js `experimental.disableOptimizedLoading` — when false
    // (the default), page scripts are emitted with `defer` in <head>. See
    // `.nextjs-ref/packages/next/src/pages/_document.tsx` getScripts().
    disableOptimizedLoading: nextConfig?.disableOptimizedLoading === true,
    clientTraceMetadata: nextConfig?.clientTraceMetadata,
    images: {
      deviceSizes: nextConfig?.images?.deviceSizes,
      imageSizes: nextConfig?.images?.imageSizes,
      qualities: nextConfig?.images?.qualities,
      dangerouslyAllowSVG: nextConfig?.images?.dangerouslyAllowSVG,
      dangerouslyAllowLocalIP: nextConfig?.images?.dangerouslyAllowLocalIP,
      contentDispositionType: nextConfig?.images?.contentDispositionType,
      contentSecurityPolicy: nextConfig?.images?.contentSecurityPolicy,
    },
  });

  // Generate instrumentation code if instrumentation.ts exists.
  // For production (Cloudflare Workers), instrumentation.ts is bundled into the
  // Worker and register() is called as a top-level await at module evaluation time —
  // before any request is handled. This mirrors App Router behavior (generateRscEntry)
  // and matches Next.js semantics: register() runs once on startup in the process
  // that handles requests.
  //
  // The onRequestError handler is stored on globalThis so it is visible across
  // all code within the Worker (same global scope).
  const instrumentationImportCode = instrumentationPath
    ? `import * as _instrumentation from ${JSON.stringify(normalizePathSeparators(instrumentationPath))};`
    : "";

  const instrumentationInitCode = instrumentationPath
    ? `// Run instrumentation register() once at module evaluation time — before any
// requests are handled. Matches Next.js semantics: register() is called once
// on startup in the process that handles requests.
if (typeof _instrumentation.register === "function") {
  await _instrumentation.register();
}
// Store the onRequestError handler on globalThis so it is visible to all
// code within the Worker (same global scope).
if (typeof _instrumentation.onRequestError === "function") {
  globalThis.__VINEXT_onRequestErrorHandler__ = _instrumentation.onRequestError;
}`
    : "";

  // Generate middleware code if middleware.ts exists
  const middlewareImportCode = middlewarePath
    ? `import * as middlewareModule from ${JSON.stringify(normalizePathSeparators(middlewarePath))};`
    : "";

  // The matcher config is read from the middleware module at request time.
  // The generated entry only wires the user module into the shared runtime
  // helper; matcher, execution, waitUntil, and result shaping live in normal
  // TypeScript modules so dev/prod paths cannot drift.
  const middlewareExportCode = middlewarePath
    ? `
export async function runMiddleware(request, ctx, options) {
  return __runGeneratedMiddleware({
    basePath: vinextConfig.basePath,
    ctx,
    filePath: ${JSON.stringify(normalizePathSeparators(middlewarePath))},
    i18nConfig,
    isDataRequest: options?.isDataRequest === true,
    isProxy: ${JSON.stringify(isProxyFile(middlewarePath))},
    module: middlewareModule,
    request,
    trailingSlash: vinextConfig.trailingSlash,
  });
}
`
    : `
export async function runMiddleware(request) {
  return { continue: true };
}
`;

  // The server entry is a self-contained module that uses Web-standard APIs
  // (Request/Response, renderToReadableStream) so it runs on Cloudflare Workers.
  return `
import ${JSON.stringify(_serverGlobalsPath)};
import React from "react";
import { renderToReadableStream } from "react-dom/server.edge";
import { resetSSRHead, getSSRHeadHTML, setDocumentInitialHead } from "next/head";
import { flushPreloads } from "next/dynamic";
import Router, { setSSRContext, wrapWithRouterContext, getPagesNavigationIsReadyFromSerializedState } from "next/router";
import { _runWithCacheState } from "vinext/shims/cache-request-state";
import { configureMemoryCacheHandler as __configureMemoryCacheHandler } from "vinext/shims/cache-handler";
import { registerConfiguredCacheAdapters as __registerConfiguredCacheAdapters } from "virtual:vinext-cache-adapters";
import __pagesClientAssets from "virtual:vinext-pages-client-assets";
import { setPagesClientAssets as __setPagesClientAssets } from "vinext/server/pages-client-assets";
import { runWithPrivateCache } from "vinext/cache-runtime";
import { ensureFetchPatch, runWithFetchCache } from "vinext/fetch-cache";
import "vinext/router-state";
import { runWithServerInsertedHTMLState } from "vinext/navigation-state";
import { runWithHeadState } from "vinext/head-state";
import "vinext/i18n-state";
import { setI18nContext } from "vinext/i18n-context";
import { safeJsonStringify } from "vinext/html";
import { mergeRouteParamsIntoQuery, parseQueryString as parseQuery } from ${JSON.stringify(_queryUtilsPath)};
import { getSSRFontLinks as _getSSRFontLinks, getSSRFontStyles as _getSSRFontStylesGoogle, getSSRFontPreloads as _getSSRFontPreloadsGoogle } from "next/font/google";
import { getSSRFontStyles as _getSSRFontStylesLocal, getSSRFontPreloads as _getSSRFontPreloadsLocal } from "next/font/local";
import { sanitizeDestination as sanitizeDestinationLocal } from ${JSON.stringify(resolveEntryPath("../config/config-matchers.js", import.meta.url))};
import { runWithExecutionContext as _runWithExecutionContext } from ${JSON.stringify(_requestContextShimPath)};
import { runGeneratedMiddleware as __runGeneratedMiddleware } from ${JSON.stringify(_middlewareRuntimePath)};
import { buildRouteTrie as _buildRouteTrie, trieMatch as _trieMatch } from ${JSON.stringify(_routeTriePath)};
import { reportRequestError as _reportRequestError } from "vinext/instrumentation";
import { resolvePagesI18nRequest } from ${JSON.stringify(_pagesI18nPath)};
import { handlePagesApiRoute as __handlePagesApiRoute } from ${JSON.stringify(_pagesApiRoutePath)};
import { normalizePagesDataRequest as __normalizePagesDataRequest, buildNextDataNotFoundResponse as __buildNextDataNotFoundResponse } from ${JSON.stringify(_pagesDataRoutePath)};
import { buildDefaultPagesNotFoundResponse as __buildDefaultPagesNotFoundResponse } from ${JSON.stringify(_pagesDefault404Path)};
import { createPagesPageHandler as __createPagesPageHandler } from ${JSON.stringify(_pagesPageHandlerPath)};
${instrumentationImportCode}
${middlewareImportCode}

${instrumentationInitCode}

// i18n config (embedded at build time)
const i18nConfig = ${i18nConfigJson};

// Build ID (embedded at build time). Exported so the production server can
// match _next/data requests against the embedded buildId without needing
// to load next.config.js at runtime.
export const buildId = ${buildIdJson};
export function normalizeDataRequest(request) {
  return __normalizePagesDataRequest(request, buildId);
}
export const hasMiddleware = ${JSON.stringify(Boolean(middlewarePath))};

// Full resolved config for production server (embedded at build time)
export const vinextConfig = ${vinextConfigJson};

// Default to the in-memory data cache; a configured cache.data/cache.cdn adapter
// overrides it on the first request via registerConfiguredCacheAdapters (called
// from renderPage/handleApiRoute below, and with env from the worker entry on
// Cloudflare). The registration self-guards, so the first call wins.
__configureMemoryCacheHandler({ cacheMaxMemorySize: vinextConfig.cacheMaxMemorySize });

// Path to the user's pages/_app file (or null). Used to look up the
// _app's CSS/JS chunks in the SSR manifest so any global styles imported
// by _app are included in every page's <link rel="stylesheet"> set.
const _appAssetPath = ${appAssetPathJson};

async function _renderToStringAsync(element) {
  const stream = await renderToReadableStream(element);
  await stream.allReady;
  return new Response(stream).text();
}

async function _renderIsrPassToStringAsync(element) {
  // The cache-fill render is a second render pass for the same request.
  // Reset render-scoped state so it cannot leak from the streamed response
  // render or affect async work that is still draining from that stream.
  // Keep request identity state (pathname/query/locale/executionContext)
  // intact: this second pass still belongs to the same request.
  return await runWithServerInsertedHTMLState(() =>
    runWithHeadState(() =>
      _runWithCacheState(() =>
        runWithPrivateCache(() => runWithFetchCache(async () => _renderToStringAsync(element))),
      ),
    ),
  );
}

${pageImports.join("\n")}
${apiImports.join("\n")}

${appImportCode}
${docImportCode}
${errorImportCode}

export const pageRoutes = [
${pageRouteEntries.join(",\n")}
];
const _pageRouteTrie = _buildRouteTrie(pageRoutes);
const _errorPageRoute = ErrorPageModule
  ? {
      pattern: "/_error",
      patternParts: ["_error"],
      isDynamic: false,
      params: [],
      module: ErrorPageModule,
      filePath: ${errorAssetPathJson},
    }
  : null;

const apiRoutes = [
${apiRouteEntries.join(",\n")}
];
const _apiRouteTrie = _buildRouteTrie(apiRoutes);

function matchRoute(url, routes) {
  const pathname = url.split("?")[0];
  let normalizedUrl = pathname === "/" ? "/" : pathname.replace(/\\/$/, "");
  // NOTE: Do NOT decodeURIComponent here. The pathname is already decoded at
  // the entry point. Decoding again would create a double-decode vector.
  const urlParts = normalizedUrl.split("/").filter(Boolean);
  const trie = routes === pageRoutes ? _pageRouteTrie : _apiRouteTrie;
  return _trieMatch(trie, urlParts);
}

export function matchPageRoute(url, request) {
  const routeUrl = i18nConfig && request
    ? resolvePagesI18nRequest(
        url,
        i18nConfig,
        request.headers,
        new URL(request.url).hostname,
        vinextConfig.basePath,
        vinextConfig.trailingSlash,
      ).url
    : url;
  return matchRoute(routeUrl, pageRoutes);
}

export function matchApiRoute(url, request) {
  const routeUrl = i18nConfig && request
    ? resolvePagesI18nRequest(
        url,
        i18nConfig,
        request.headers,
        new URL(request.url).hostname,
        vinextConfig.basePath,
        vinextConfig.trailingSlash,
      ).url
    : url;
  return matchRoute(routeUrl, apiRoutes);
}

// ── Pages render orchestrator — delegates to server/pages-page-handler.ts ──
//
// All next/*-derived values are passed as closures so the handler module
// stays importable in test environments (the root vite.config.ts only
// aliases vinext/shims/*, not next/*).
__setPagesClientAssets(__pagesClientAssets);
const _renderPage = __createPagesPageHandler({
  pageRoutes,
  errorPageRoute: _errorPageRoute,
  matchRoute: (url) => matchRoute(url, pageRoutes),
  i18nConfig,
  vinextConfig: {
    basePath: vinextConfig.basePath,
    assetPrefix: vinextConfig.assetPrefix,
    trailingSlash: vinextConfig.trailingSlash,
    expireTime: vinextConfig.expireTime,
    htmlLimitedBots: vinextConfig.htmlLimitedBots,
    clientTraceMetadata: vinextConfig.clientTraceMetadata,
    disableOptimizedLoading: vinextConfig.disableOptimizedLoading,
  },
  buildId,
  hasMiddleware,
  appAssetPath: _appAssetPath,
  hasRewrites:
    vinextConfig.rewrites.beforeFiles.length > 0 ||
    vinextConfig.rewrites.afterFiles.length > 0 ||
    vinextConfig.rewrites.fallback.length > 0,

  // next/*-derived closures
  setSSRContext: typeof setSSRContext === "function" ? setSSRContext : null,
  getPagesNavigationIsReadyFromSerializedState:
    typeof getPagesNavigationIsReadyFromSerializedState === "function"
      ? getPagesNavigationIsReadyFromSerializedState
      : null,
  setI18nContext: typeof setI18nContext === "function" ? setI18nContext : null,
  wrapWithRouterContext: typeof wrapWithRouterContext === "function" ? wrapWithRouterContext : null,
  resetSSRHead: typeof resetSSRHead === "function" ? resetSSRHead : undefined,
  getSSRHeadHTML: typeof getSSRHeadHTML === "function" ? getSSRHeadHTML : undefined,
  setDocumentInitialHead: typeof setDocumentInitialHead === "function" ? setDocumentInitialHead : undefined,
  flushPreloads: typeof flushPreloads === "function" ? flushPreloads : undefined,
  getFontLinks() {
    try { return typeof _getSSRFontLinks === "function" ? _getSSRFontLinks() : []; } catch { return []; }
  },
  getFontStyles() {
    try {
      const styles = [];
      if (typeof _getSSRFontStylesGoogle === "function") styles.push(..._getSSRFontStylesGoogle());
      if (typeof _getSSRFontStylesLocal === "function") styles.push(..._getSSRFontStylesLocal());
      return styles;
    } catch { return []; }
  },
  getFontPreloads() {
    try {
      const preloads = [];
      if (typeof _getSSRFontPreloadsGoogle === "function") preloads.push(..._getSSRFontPreloadsGoogle());
      if (typeof _getSSRFontPreloadsLocal === "function") preloads.push(..._getSSRFontPreloadsLocal());
      return preloads;
    } catch { return []; }
  },
  renderToReadableStream,
  renderIsrPassToStringAsync: _renderIsrPassToStringAsync,
  safeJsonStringify,
  sanitizeDestination: sanitizeDestinationLocal,
  createPageElement(PageComponent, AppComponent, props) {
    const rawPageProps = props?.pageProps;
    const pageProps = rawPageProps && typeof rawPageProps === "object"
      ? props.pageProps
      : {};
    return AppComponent
      ? React.createElement(AppComponent, {
          ...props,
          Component: PageComponent,
          pageProps: rawPageProps,
          router: Router,
        })
      : React.createElement(PageComponent, pageProps);
  },
  enhancePageElement(PageComponent, AppComponent, props, opts) {
    const rawPageProps = props?.pageProps;
    const pageProps = rawPageProps && typeof rawPageProps === "object"
      ? props.pageProps
      : {};
    let FinalApp = AppComponent;
    let FinalComp = PageComponent;
    if (opts && typeof opts.enhanceApp === "function" && FinalApp) FinalApp = opts.enhanceApp(FinalApp);
    if (opts && typeof opts.enhanceComponent === "function") FinalComp = opts.enhanceComponent(FinalComp);
    return FinalApp
      ? React.createElement(FinalApp, {
          ...props,
          Component: FinalComp,
          pageProps: rawPageProps,
          router: Router,
        })
      : React.createElement(FinalComp, pageProps);
  },
  AppComponent,
  DocumentComponent,
});

export async function renderPage(request, url, manifest, ctx, middlewareHeaders, options) {
  __registerConfiguredCacheAdapters();
  if (ctx) return _runWithExecutionContext(ctx, () => _renderPage(request, url, manifest, middlewareHeaders, options));
  return _renderPage(request, url, manifest, middlewareHeaders, options);
}



export async function handleApiRoute(request, url, ctx) {
  __registerConfiguredCacheAdapters();
  const match = matchRoute(url, apiRoutes);
  return __handlePagesApiRoute({
    ctx,
    match,
    nextConfig: vinextConfig,
    request,
    url,
    reportRequestError(error, routePattern) {
      console.error("[vinext] API error:", error);
      void _reportRequestError(
        error,
        { path: url, method: request.method, headers: Object.fromEntries(request.headers.entries()) },
        { routerKind: "Pages Router", routePath: routePattern, routeType: "route" },
      );
    },
  });
}

${middlewareExportCode}
`;
}
