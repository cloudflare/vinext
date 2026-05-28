/**
 * Pages Router server entry generator.
 *
 * Generates the virtual SSR server entry module (`virtual:vinext-server-entry`).
 * This is the entry point for `vite build --ssr`. It handles SSR, API routes,
 * middleware, ISR, and i18n for the Pages Router.
 *
 * Extracted from index.ts.
 */
import { resolveEntryPath, normalizePathSeparators } from "./runtime-entry-module.js";
import { pagesRouter, apiRouter, type Route } from "../routing/pages-router.js";
import { createValidFileMatcher } from "../routing/file-matcher.js";
import { type ResolvedNextConfig } from "../config/next-config.js";
import { isProxyFile } from "../server/middleware.js";
import { findFileWithExts } from "./pages-entry-helpers.js";

const _requestContextShimPath = resolveEntryPath("../shims/request-context.js", import.meta.url);
const _middlewareRuntimePath = resolveEntryPath("../server/middleware-runtime.js", import.meta.url);
const _routeTriePath = resolveEntryPath("../routing/route-trie.js", import.meta.url);
const _pagesI18nPath = resolveEntryPath("../server/pages-i18n.js", import.meta.url);
const _pagesPageResponsePath = resolveEntryPath(
  "../server/pages-page-response.js",
  import.meta.url,
);
const _pagesPageDataPath = resolveEntryPath("../server/pages-page-data.js", import.meta.url);
const _pagesPageMethodPath = resolveEntryPath("../server/pages-page-method.js", import.meta.url);
const _pagesDataRoutePath = resolveEntryPath("../server/pages-data-route.js", import.meta.url);
const _pagesDefault404Path = resolveEntryPath("../server/pages-default-404.js", import.meta.url);
const _pagesNodeCompatPath = resolveEntryPath("../server/pages-node-compat.js", import.meta.url);
const _pagesApiRoutePath = resolveEntryPath("../server/pages-api-route.js", import.meta.url);
const _isrCachePath = resolveEntryPath("../server/isr-cache.js", import.meta.url);
const _cspPath = resolveEntryPath("../server/csp.js", import.meta.url);
const _serverGlobalsPath = resolveEntryPath("../server/server-globals.js", import.meta.url);

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
  const appAssetPathJson =
    appFilePath !== null ? JSON.stringify(normalizePathSeparators(appFilePath)) : "null";
  const appImportCode =
    appFilePath !== null
      ? `import { default as AppComponent } from ${JSON.stringify(normalizePathSeparators(appFilePath))};`
      : `const AppComponent = null;`;

  const docImportCode =
    docFilePath !== null
      ? `import { default as DocumentComponent } from ${JSON.stringify(normalizePathSeparators(docFilePath))};`
      : `const DocumentComponent = null;`;

  const errorAssetPathJson =
    errorFilePath !== null ? JSON.stringify(normalizePathSeparators(errorFilePath)) : "null";
  const errorImportCode =
    errorFilePath !== null
      ? `import * as ErrorPageModule from ${JSON.stringify(normalizePathSeparators(errorFilePath))};`
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
    i18n: nextConfig?.i18n ?? null,
    // Mirrors Next.js `experimental.disableOptimizedLoading` — when false
    // (the default), page scripts are emitted with `defer` in <head>. See
    // `.nextjs-ref/packages/next/src/pages/_document.tsx` getScripts().
    disableOptimizedLoading: nextConfig?.disableOptimizedLoading === true,
    clientTraceMetadata: nextConfig?.clientTraceMetadata,
    images: {
      deviceSizes: nextConfig?.images?.deviceSizes,
      imageSizes: nextConfig?.images?.imageSizes,
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
  // Auto-detect /_next/data/<buildId>/<page>.json requests so user-written
  // worker entries don't need to know about the data endpoint protocol.
  // Mismatched buildId → JSON 404 short-circuit. Matched → middleware sees
  // the normalized page path via the request URL, and the worker sees the
  // normalized URL via result.rewriteUrl (if middleware didn't already
  // rewrite to something else).
  const __dataNorm = __normalizePagesDataRequest(request);
  if (__dataNorm.notFoundResponse) {
    return { continue: false, response: __dataNorm.notFoundResponse };
  }
  const __result = await __runGeneratedMiddleware({
    basePath: vinextConfig.basePath,
    ctx,
    i18nConfig,
    isDataRequest: options?.isDataRequest === true || __dataNorm.isDataReq,
    isProxy: ${JSON.stringify(isProxyFile(middlewarePath))},
    module: middlewareModule,
    request: __dataNorm.request,
    trailingSlash: vinextConfig.trailingSlash,
  });
  if (__dataNorm.isDataReq && __result.continue && !__result.rewriteUrl && !__result.redirectUrl) {
    return { ...__result, rewriteUrl: __dataNorm.normalizedPathname + __dataNorm.search };
  }
  return __result;
}
`
    : `
export async function runMiddleware(request) {
  // Even without user middleware, the data-endpoint URL must be normalized so
  // the worker pipeline sees the page path. Mismatched buildId → JSON 404.
  const __dataNorm = __normalizePagesDataRequest(request);
  if (__dataNorm.notFoundResponse) {
    return { continue: false, response: __dataNorm.notFoundResponse };
  }
  if (__dataNorm.isDataReq) {
    return { continue: true, rewriteUrl: __dataNorm.normalizedPathname + __dataNorm.search };
  }
  return { continue: true };
}
`;

  // The server entry is a self-contained module that uses Web-standard APIs
  // (Request/Response, renderToReadableStream) so it runs on Cloudflare Workers.
  return `
import ${JSON.stringify(_serverGlobalsPath)};
import React from "react";
import { renderToReadableStream } from "react-dom/server.edge";
import { resetSSRHead, getSSRHeadHTML } from "next/head";
import { flushPreloads } from "next/dynamic";
import { setSSRContext, wrapWithRouterContext } from "next/router";
import { _runWithCacheState } from "next/cache";
import { runWithPrivateCache } from "vinext/cache-runtime";
import { ensureFetchPatch, runWithFetchCache } from "vinext/fetch-cache";
import { runWithRequestContext as _runWithUnifiedCtx, createRequestContext as _createUnifiedCtx } from "vinext/unified-request-context";
import "vinext/router-state";
import { runWithServerInsertedHTMLState } from "vinext/navigation-state";
import { runWithHeadState } from "vinext/head-state";
import "vinext/i18n-state";
import { setI18nContext } from "vinext/i18n-context";
import { createNonceAttribute as __createNonceAttribute, safeJsonStringify } from "vinext/html";
import { getSSRFontLinks as _getSSRFontLinks, getSSRFontStyles as _getSSRFontStylesGoogle, getSSRFontPreloads as _getSSRFontPreloadsGoogle } from "next/font/google";
import { getSSRFontStyles as _getSSRFontStylesLocal, getSSRFontPreloads as _getSSRFontPreloadsLocal } from "next/font/local";
import { sanitizeDestination as sanitizeDestinationLocal } from ${JSON.stringify(resolveEntryPath("../config/config-matchers.js", import.meta.url))};
import { runWithExecutionContext as _runWithExecutionContext, getRequestExecutionContext as _getRequestExecutionContext } from ${JSON.stringify(_requestContextShimPath)};
import { runGeneratedMiddleware as __runGeneratedMiddleware } from ${JSON.stringify(_middlewareRuntimePath)};
import { buildRouteTrie as _buildRouteTrie, trieMatch as _trieMatch } from ${JSON.stringify(_routeTriePath)};
import { reportRequestError as _reportRequestError } from "vinext/instrumentation";
import { resolvePagesI18nRequest } from ${JSON.stringify(_pagesI18nPath)};
import { createPagesReqRes as __createPagesReqRes } from ${JSON.stringify(_pagesNodeCompatPath)};
import { handlePagesApiRoute as __handlePagesApiRoute } from ${JSON.stringify(_pagesApiRoutePath)};
import {
  isrGet as __sharedIsrGet,
  isrSet as __sharedIsrSet,
  isrCacheKey as __sharedIsrCacheKey,
  triggerBackgroundRegeneration as __sharedTriggerBackgroundRegeneration,
} from ${JSON.stringify(_isrCachePath)};
import { getScriptNonceFromHeaderSources as __getScriptNonceFromHeaderSources } from ${JSON.stringify(_cspPath)};
import { resolvePagesPageData as __resolvePagesPageData } from ${JSON.stringify(_pagesPageDataPath)};
import { resolvePagesPageMethodResponse as __resolvePagesPageMethodResponse } from ${JSON.stringify(_pagesPageMethodPath)};
import { buildNextDataJsonResponse as __buildNextDataJsonResponse, buildNextDataNotFoundResponse as __buildNextDataNotFoundResponse, isNextDataPathname as __isNextDataPathname, parseNextDataPathname as __parseNextDataPathname } from ${JSON.stringify(_pagesDataRoutePath)};
import { buildDefaultPagesNotFoundResponse as __buildDefaultPagesNotFoundResponse } from ${JSON.stringify(_pagesDefault404Path)};
import { renderPagesPageResponse as __renderPagesPageResponse } from ${JSON.stringify(_pagesPageResponsePath)};
${instrumentationImportCode}
${middlewareImportCode}

${instrumentationInitCode}

// i18n config (embedded at build time)
const i18nConfig = ${i18nConfigJson};

// Build ID (embedded at build time). Exported so the production server can
// match _next/data requests against the embedded buildId without needing
// to load next.config.js at runtime.
export const buildId = ${buildIdJson};
const __hasMiddleware = ${JSON.stringify(Boolean(middlewarePath))};

// Full resolved config for production server (embedded at build time)
export const vinextConfig = ${vinextConfigJson};

// Path to the user's pages/_app file (or null). Used to look up the
// _app's CSS/JS chunks in the SSR manifest so any global styles imported
// by _app are included in every page's <link rel="stylesheet"> set.
const _appAssetPath = ${appAssetPathJson};

function isrGet(key) {
  return __sharedIsrGet(key);
}
function isrSet(key, data, revalidateSeconds, tags, expireSeconds) {
  return __sharedIsrSet(key, data, revalidateSeconds, tags, expireSeconds);
}
function triggerBackgroundRegeneration(key, renderFn, errorContext) {
  return __sharedTriggerBackgroundRegeneration(key, renderFn, errorContext);
}
function isrCacheKey(router, pathname) {
  return __sharedIsrCacheKey(router, pathname, buildId || undefined);
}

/**
 * Detect and normalize /_next/data/<buildId>/<page>.json requests in one
 * place so user-written worker entries don't need to know about the data
 * endpoint protocol. Returns the normalized request (with the page path as
 * its URL), an isDataReq flag, and notFoundResponse when the buildId in
 * the URL does not match this server's buildId — callers should return that
 * response immediately so a stale client falls back to a hard navigation.
 */
function __normalizePagesDataRequest(request) {
  const reqUrl = new URL(request.url);
  if (!__isNextDataPathname(reqUrl.pathname)) {
    return { isDataReq: false, request, normalizedPathname: null, search: "", notFoundResponse: null };
  }
  const dataMatch = buildId ? __parseNextDataPathname(reqUrl.pathname, buildId) : null;
  if (!dataMatch) {
    return {
      isDataReq: false,
      request,
      normalizedPathname: null,
      search: "",
      notFoundResponse: __buildNextDataNotFoundResponse(),
    };
  }
  const normalizedUrl = new URL(reqUrl);
  normalizedUrl.pathname = dataMatch.pagePathname;
  return {
    isDataReq: true,
    request: new Request(normalizedUrl, request),
    normalizedPathname: dataMatch.pagePathname,
    search: reqUrl.search,
    notFoundResponse: null,
  };
}

async function renderToStringAsync(element) {
  const stream = await renderToReadableStream(element);
  await stream.allReady;
  return new Response(stream).text();
}

async function renderIsrPassToStringAsync(element) {
  // The cache-fill render is a second render pass for the same request.
  // Reset render-scoped state so it cannot leak from the streamed response
  // render or affect async work that is still draining from that stream.
  // Keep request identity state (pathname/query/locale/executionContext)
  // intact: this second pass still belongs to the same request.
  return await runWithServerInsertedHTMLState(() =>
    runWithHeadState(() =>
      _runWithCacheState(() =>
        runWithPrivateCache(() => runWithFetchCache(async () => renderToStringAsync(element))),
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

function parseQuery(url) {
  // Per RFC 3986 only the first "?" separates path from query, so additional
  // "?" chars belong to the query string (e.g. /linker?href=/about?hello=world
  // has query "href=/about?hello=world"). split("?")[1] would drop everything
  // after the second "?" and strip embedded query strings from values.
  const queryIndex = url.indexOf("?");
  if (queryIndex === -1) return {};
  const hashIndex = url.indexOf("#", queryIndex + 1);
  const qs = hashIndex === -1 ? url.slice(queryIndex + 1) : url.slice(queryIndex + 1, hashIndex);
  if (!qs) return {};
  const p = new URLSearchParams(qs);
  const q = {};
  for (const [k, v] of p) {
    if (k in q) {
      q[k] = Array.isArray(q[k]) ? q[k].concat(v) : [q[k], v];
    } else {
      q[k] = v;
    }
  }
  return q;
}

function mergeRouteParamsIntoQuery(query, params) {
  return Object.assign(query, params);
}

function patternToNextFormat(pattern) {
  // Match any non-/ param name. Non-greedy with lookahead prevents
  // the +/* suffix being consumed into the param name when the name
  // itself contains + or * internally (e.g. :c++lang → [c++lang]).
  return pattern
    .replace(/:([^\\/]+?)\\+(?=\\/|$)/g, "[...$1]")
    .replace(/:([^\\/]+?)\\*(?=\\/|$)/g, "[[...$1]]")
    .replace(/:([^\\/]+?)(?=\\/|$)/g, "[$1]");
}

function resolveSsrManifest(manifest) {
  // Fall back to embedded manifest (set by vinext:cloudflare-build for Workers)
  return (manifest && Object.keys(manifest).length > 0)
    ? manifest
    : (typeof globalThis !== "undefined" && globalThis.__VINEXT_SSR_MANIFEST__) || null;
}

function getManifestFilesForModule(manifest, moduleId) {
  if (!manifest || !moduleId) return null;

  var files = manifest[moduleId];
  if (files) return files;

  for (var key in manifest) {
    if (moduleId.endsWith("/" + key) || moduleId === key) {
      return manifest[key];
    }
  }
  return null;
}

function collectAssetTags(manifest, moduleIds, scriptNonce) {
  const m = resolveSsrManifest(manifest);
  const tags = [];
  const seen = new Set();
  const nonceAttr = __createNonceAttribute(scriptNonce);
  // Mirrors Next.js \`_document\` behaviour: when \`experimental.disableOptimizedLoading\`
  // is false (the default), page scripts are emitted with \`defer\` in <head>. See
  // .nextjs-ref/packages/next/src/pages/_document.tsx getScripts() — \`defer={!disableOptimizedLoading}\`.
  // vinext always emits \`type="module"\` (which already defers implicitly), but
  // upstream tests (e.g. test/e2e/optimized-loading) assert the literal \`defer\`
  // attribute, and adding it preserves parity without changing browser behaviour.
  const deferAttr = vinextConfig.disableOptimizedLoading ? "" : " defer";

  // Load the set of lazy chunk filenames (only reachable via dynamic imports).
  // These should NOT get <link rel="modulepreload"> or <script type="module">
  // tags — they are fetched on demand when the dynamic import() executes (e.g.
  // chunks behind React.lazy() or next/dynamic boundaries).
  var lazyChunks = (typeof globalThis !== "undefined" && globalThis.__VINEXT_LAZY_CHUNKS__) || null;
  var lazySet = lazyChunks && lazyChunks.length > 0 ? new Set(lazyChunks) : null;

  // Inject the client entry script if embedded by vinext:cloudflare-build
  if (typeof globalThis !== "undefined" && globalThis.__VINEXT_CLIENT_ENTRY__) {
    const entry = globalThis.__VINEXT_CLIENT_ENTRY__;
    seen.add(entry);
    tags.push('<link rel="modulepreload"' + nonceAttr + ' href="/' + entry + '" />');
    tags.push('<script type="module"' + deferAttr + nonceAttr + ' src="/' + entry + '" crossorigin></script>');
  }
  if (m) {
    // Always inject shared chunks (framework, vinext runtime, entry) and
    // page-specific chunks. The manifest maps module file paths to their
    // associated JS/CSS assets.
    //
    // For page-specific injection, the module IDs may be absolute paths
    // while the manifest uses relative paths. Try both the original ID
    // and a suffix match to find the correct manifest entry.
    var allFiles = [];

    if (moduleIds && moduleIds.length > 0) {
      // Collect assets for the requested page modules
      for (var mi = 0; mi < moduleIds.length; mi++) {
        var id = moduleIds[mi];
        var files = getManifestFilesForModule(m, id);
        if (files) {
          for (var fi = 0; fi < files.length; fi++) allFiles.push(files[fi]);
        }
      }

      // Also inject shared chunks that every page needs: framework,
      // vinext runtime, and the entry bootstrap. These are identified
      // by scanning all manifest values for chunk filenames containing
      // known prefixes.
      for (var key in m) {
        var vals = m[key];
        if (!vals) continue;
        for (var vi = 0; vi < vals.length; vi++) {
          var file = vals[vi];
          var basename = file.split("/").pop() || "";
          if (
            basename.startsWith("framework-") ||
            basename.startsWith("vinext-") ||
            basename.includes("vinext-client-entry") ||
            basename.includes("vinext-app-browser-entry")
          ) {
            allFiles.push(file);
          }
        }
      }
    } else {
      // No specific modules — include all assets from manifest
      for (var akey in m) {
        var avals = m[akey];
        if (avals) {
          for (var ai = 0; ai < avals.length; ai++) allFiles.push(avals[ai]);
        }
      }
    }

    for (var ti = 0; ti < allFiles.length; ti++) {
      var tf = allFiles[ti];
      // Normalize: Vite's SSR manifest values include a leading '/'
      // (from base path), but we prepend '/' ourselves when building
      // href/src attributes. Strip any existing leading slash to avoid
      // producing protocol-relative URLs like "//assets/chunk.js".
      // This also ensures consistent keys for the seen-set dedup and
      // lazySet.has() checks (which use values without leading slash).
      if (tf.charAt(0) === '/') tf = tf.slice(1);
      if (seen.has(tf)) continue;
      seen.add(tf);
      if (tf.endsWith(".css")) {
        tags.push('<link rel="stylesheet"' + nonceAttr + ' href="/' + tf + '" />');
      } else if (tf.endsWith(".js")) {
        // Skip lazy chunks — they are behind dynamic import() boundaries
        // (React.lazy, next/dynamic) and should only be fetched on demand.
        if (lazySet && lazySet.has(tf)) continue;
        tags.push('<link rel="modulepreload"' + nonceAttr + ' href="/' + tf + '" />');
        tags.push('<script type="module"' + deferAttr + nonceAttr + ' src="/' + tf + '" crossorigin></script>');
      }
    }
  }
  return tags.join("\\n  ");
}

function resolveClientModuleUrl(manifest, moduleId) {
  const files = getManifestFilesForModule(resolveSsrManifest(manifest), moduleId);
  if (!files) return undefined;
  for (var i = 0; i < files.length; i++) {
    var file = files[i];
    if (!file || !file.endsWith(".js")) continue;
    if (file.charAt(0) !== "/") file = "/" + file;
    return file;
  }
  return undefined;
}

export async function renderPage(request, url, manifest, ctx, middlewareHeaders, options) {
  if (ctx) return _runWithExecutionContext(ctx, () => _renderPage(request, url, manifest, middlewareHeaders, options));
  return _renderPage(request, url, manifest, middlewareHeaders, options);
}

async function _renderPage(request, url, manifest, middlewareHeaders, options) {
  let isDataReq = !!(options && options.isDataReq);
  // Auto-detect /_next/data/... requests by inspecting the incoming request
  // URL. The worker pipeline does not need to know about the data endpoint
  // protocol — when it forwards an unrewritten data URL as the url arg, we
  // normalize it to the page path here.
  if (!isDataReq) {
    const __dataNorm = __normalizePagesDataRequest(request);
    if (__dataNorm.notFoundResponse) return __dataNorm.notFoundResponse;
    if (__dataNorm.isDataReq) {
      isDataReq = true;
      if (url && url.startsWith("/_next/data/")) {
        const __qs = url.includes("?") ? url.slice(url.indexOf("?")) : "";
        url = __dataNorm.normalizedPathname + __qs;
      }
    }
  }
  const statusCode = options && typeof options.statusCode === "number" ? options.statusCode : undefined;
  const asPath = options && typeof options.asPath === "string" ? options.asPath : undefined;
  const renderErrorPageOnMiss = !(options && options.renderErrorPageOnMiss === false);
  // Guard against infinite recursion when the user's custom 500/error page
  // itself throws during render. When this flag is set, the catch block below
  // returns the plain "Internal Server Error" text response instead of trying
  // to render an error page again. Fixes #1458.
  const isInternalErrorRender = !!(options && options.__isInternalErrorRender);
  const localeInfo = i18nConfig
    ? resolvePagesI18nRequest(
        url,
        i18nConfig,
        request.headers,
        new URL(request.url).hostname,
        vinextConfig.basePath,
        vinextConfig.trailingSlash,
      )
    : { locale: undefined, url, hadPrefix: false, domainLocale: undefined, redirectUrl: undefined };
  const locale = localeInfo.locale;
  const routeUrl = localeInfo.url;
  const currentDefaultLocale = i18nConfig
    ? (localeInfo.domainLocale ? localeInfo.domainLocale.defaultLocale : i18nConfig.defaultLocale)
    : undefined;
  const domainLocales = i18nConfig ? i18nConfig.domains : undefined;

  if (localeInfo.redirectUrl) {
    return new Response(null, { status: 307, headers: { Location: localeInfo.redirectUrl } });
  }

  // Internal error render path: caller has pinned a specific route (the
  // user's pages/500 or pages/_error) to render in response to an SSR throw.
  // Skip route matching so we don't accidentally double-route, and skip the
  // missing-route 404 fallback. See catch block below. Fixes #1458.
  let match = options && options.__forcedRoute
    ? { route: options.__forcedRoute, params: {} }
    : matchRoute(routeUrl, pageRoutes);
  let renderStatusCodeOverride = statusCode;
  let renderAsPath = asPath;
  if (!match) {
    if (isDataReq) {
      return __buildNextDataNotFoundResponse();
    }
    if (!renderErrorPageOnMiss) {
      return __buildDefaultPagesNotFoundResponse();
    }
    const notFoundMatch = matchRoute("/404", pageRoutes);
    // matchRoute may match a catch-all (e.g. [...slug]); only use the explicit pages/404 route.
    if (notFoundMatch && notFoundMatch.route.pattern === "/404") {
      match = notFoundMatch;
      renderStatusCodeOverride = 404;
      renderAsPath = routeUrl;
    } else if (_errorPageRoute) {
      match = { route: _errorPageRoute, params: {} };
      renderStatusCodeOverride = 404;
      renderAsPath = routeUrl;
    } else {
      return __buildDefaultPagesNotFoundResponse();
    }
  }

  const { route, params } = match;
  const __uCtx = _createUnifiedCtx({
    executionContext: _getRequestExecutionContext(),
  });
  return _runWithUnifiedCtx(__uCtx, async () => {
    ensureFetchPatch();
    try {
      const routePattern = patternToNextFormat(route.pattern);
      const renderStatusCode = renderStatusCodeOverride ?? (routePattern === "/404" ? 404 : undefined);
      const query = mergeRouteParamsIntoQuery(parseQuery(routeUrl), params);
      if (typeof setSSRContext === "function") {
        setSSRContext({
          pathname: routePattern,
          query,
          asPath: renderAsPath || routeUrl,
          locale: locale,
          locales: i18nConfig ? i18nConfig.locales : undefined,
          defaultLocale: currentDefaultLocale,
          domainLocales: domainLocales,
        });
      }

      if (i18nConfig) {
        setI18nContext({
          locale: locale,
          locales: i18nConfig.locales,
          defaultLocale: currentDefaultLocale,
          domainLocales: domainLocales,
          hostname: new URL(request.url).hostname,
        });
      }

      const pageModule = route.module;
      const PageComponent = pageModule.default;
      if (!PageComponent) {
        return new Response("Page has no default export", { status: 500 });
      }

      // Refs #1463: reject non-GET/HEAD methods on static (no
      // getServerSideProps) Pages routes with 405 + Allow: GET, HEAD.
      // Skip for error/status pages (/_error, /404, /500), data requests
      // (those go through the JSON envelope path and have their own shape),
      // and renders that are already an error-page miss-render override.
      // Mirrors Next.js's base-server.ts L2277 carve-outs.
      if (
        !isDataReq &&
        routePattern !== "/_error" &&
        routePattern !== "/404" &&
        routePattern !== "/500" &&
        renderStatusCodeOverride === undefined
      ) {
        const methodResponse = __resolvePagesPageMethodResponse({
          hasGetServerSideProps: typeof pageModule.getServerSideProps === "function",
          method: request.method,
        });
        if (methodResponse) {
          return methodResponse;
        }
      }

      const pageModuleUrl = resolveClientModuleUrl(manifest, route.filePath);
      const appModuleUrl = resolveClientModuleUrl(manifest, _appAssetPath);
      const scriptNonce = __getScriptNonceFromHeaderSources(request.headers, middlewareHeaders);
      // Build font Link header early so it's available for ISR cached responses too.
      // Font preloads are module-level state populated at import time and persist across requests.
      var _fontLinkHeader = "";
      var _allFp = [];
      try {
        var _fpGoogle = typeof _getSSRFontPreloadsGoogle === "function" ? _getSSRFontPreloadsGoogle() : [];
        var _fpLocal = typeof _getSSRFontPreloadsLocal === "function" ? _getSSRFontPreloadsLocal() : [];
        _allFp = _fpGoogle.concat(_fpLocal);
        if (_allFp.length > 0) {
          _fontLinkHeader = _allFp.map(function(p) { return "<" + p.href + ">; rel=preload; as=font; type=" + p.type + "; crossorigin"; }).join(", ");
        }
      } catch (e) { /* font preloads not available */ }
      const pageDataResult = await __resolvePagesPageData({
        isDataReq,
        applyRequestContexts() {
          if (typeof setSSRContext === "function") {
            setSSRContext({
              pathname: routePattern,
              query,
              asPath: renderAsPath || routeUrl,
              locale: locale,
              locales: i18nConfig ? i18nConfig.locales : undefined,
              defaultLocale: currentDefaultLocale,
              domainLocales: domainLocales,
            });
          }
          if (i18nConfig) {
            setI18nContext({
              locale: locale,
              locales: i18nConfig.locales,
              defaultLocale: currentDefaultLocale,
              domainLocales: domainLocales,
              hostname: new URL(request.url).hostname,
            });
          }
        },
        buildId,
        createGsspReqRes() {
          return __createPagesReqRes({ body: undefined, query, request, url: routeUrl });
        },
        createPageElement(currentPageProps) {
          var currentElement = AppComponent
            ? React.createElement(AppComponent, { Component: PageComponent, pageProps: currentPageProps })
            : React.createElement(PageComponent, currentPageProps);
          return wrapWithRouterContext(currentElement);
        },
        fontLinkHeader: _fontLinkHeader,
        i18n: {
          locale: locale,
          locales: i18nConfig ? i18nConfig.locales : undefined,
          defaultLocale: currentDefaultLocale,
          domainLocales: domainLocales,
        },
        isrCacheKey,
        isrGet,
        isrSet,
        expireSeconds: vinextConfig.expireTime,
        // The vinext build phase boots the prod server with VINEXT_PRERENDER=1
        // and fetches every statically-generated page through it. That hit is
        // the "build" prerender for revalidateReason; runtime hits are not.
        // Mirrors Next.js's \`renderOpts.isBuildTimePrerendering\`. See
        // \`.nextjs-ref/packages/next/src/server/render.tsx\` and
        // \`packages/vinext/src/build/prerender.ts\`.
        isBuildTimePrerendering: typeof process !== "undefined" && process.env && process.env.VINEXT_PRERENDER === "1",
        pageModule,
        params,
        query,
        renderIsrPassToStringAsync,
        route: {
          isDynamic: route.isDynamic,
        },
        routePattern,
        routeUrl,
        runInFreshUnifiedContext(callback) {
          var revalCtx = _createUnifiedCtx({
            executionContext: _getRequestExecutionContext(),
          });
          return _runWithUnifiedCtx(revalCtx, async () => {
            ensureFetchPatch();
            return callback();
          });
        },
        safeJsonStringify,
        sanitizeDestination: sanitizeDestinationLocal,
        scriptNonce,
        statusCode: renderStatusCode,
        triggerBackgroundRegeneration,
        vinext: {
          pageModuleUrl,
          appModuleUrl,
          hasMiddleware: __hasMiddleware,
        },
      });
      if (pageDataResult.kind === "response") {
        return pageDataResult.response;
      }
      let pageProps = pageDataResult.pageProps;
      if (routePattern === "/_error" && typeof renderStatusCode === "number") {
        pageProps = { ...pageProps, statusCode: renderStatusCode };
      }
      var gsspRes = pageDataResult.gsspRes;
      let isrRevalidateSeconds = pageDataResult.isrRevalidateSeconds;
      const isFallbackRender = pageDataResult.isFallback === true;

      // Republish the SSR context with isFallback flipped on so the page's
      // \`useRouter().isFallback\` returns true during render, matching Next.js's
      // \`render.tsx\` fallback shell. Without this, the page would still see
      // \`isFallback: false\` and run the non-fallback branch.
      if (isFallbackRender && typeof setSSRContext === "function") {
        setSSRContext({
          pathname: routePattern,
          query,
          asPath: renderAsPath || routeUrl,
          locale: locale,
          locales: i18nConfig ? i18nConfig.locales : undefined,
          defaultLocale: currentDefaultLocale,
          domainLocales: domainLocales,
          isFallback: true,
        });
      }

      // ── _next/data JSON envelope short-circuit ───────────────────────
      // For client-side navigations Next.js fetches /_next/data/<buildId>/<page>.json
      // and expects { pageProps } as JSON instead of the full HTML page. Skip
      // rendering the React tree and emit the JSON envelope directly via the
      // typed helper so the envelope shape stays in one place. Headers and
      // cookies set on the gsspRes by getServerSideProps are forwarded so
      // middleware/auth flows work the same as the HTML page.
      if (isDataReq) {
        const init = { headers: {} };
        if (gsspRes && typeof gsspRes.getHeaders === "function") {
          const gsspHeaders = gsspRes.getHeaders();
          for (const k of Object.keys(gsspHeaders)) {
            const v = gsspHeaders[k];
            if (v === undefined || v === null) continue;
            init.headers[k] = Array.isArray(v) ? v.join(", ") : String(v);
          }
        }
        if (gsspRes) {
          // Default Cache-Control for gSSP-driven _next/data responses,
          // matching Next.js's pages-handler.ts (revalidate: 0 →
          // getCacheControlHeader). Skip when gSSP already set one via
          // res.setHeader (case-insensitive). Mirrors the HTML branch in
          // pages-page-response.ts and the dev-server branch. Fixes #1461.
          var hasUserCacheControl = false;
          for (const headerKey of Object.keys(init.headers)) {
            if (headerKey.toLowerCase() === "cache-control") {
              hasUserCacheControl = true;
              break;
            }
          }
          if (!hasUserCacheControl) {
            init.headers["Cache-Control"] =
              "private, no-cache, no-store, max-age=0, must-revalidate";
          }
        }
        return __buildNextDataJsonResponse(pageProps, safeJsonStringify, init);
      }

      // Include both the matched page module and the global _app module
      // (if present). _app is wrapped around every page in Pages Router,
      // and any CSS/JS it imports must be linked from the rendered HTML
      // so the browser actually loads it. Without _app in this list, a
      // global stylesheet imported via import "./globals.scss" in
      // _app.tsx never reaches the page, producing the LHF-5 symptom
      // where styled elements render with the browser default colour.
      const pageModuleIds = [];
      if (route.filePath) pageModuleIds.push(route.filePath);
      if (_appAssetPath) pageModuleIds.push(_appAssetPath);
      const assetTags = collectAssetTags(manifest, pageModuleIds, scriptNonce);

      return __renderPagesPageResponse({
        assetTags,
        buildId,
        clearSsrContext() {
          if (typeof setSSRContext === "function") setSSRContext(null);
        },
        createPageElement(currentPageProps) {
          var currentElement;
          if (AppComponent) {
            currentElement = React.createElement(AppComponent, { Component: PageComponent, pageProps: currentPageProps });
          } else {
            currentElement = React.createElement(PageComponent, currentPageProps);
          }
          return wrapWithRouterContext(currentElement);
        },
        DocumentComponent,
        flushPreloads: typeof flushPreloads === "function" ? flushPreloads : undefined,
        fontLinkHeader: _fontLinkHeader,
        fontPreloads: _allFp,
        getFontLinks() {
          try {
            return typeof _getSSRFontLinks === "function" ? _getSSRFontLinks() : [];
          } catch (e) {
            return [];
          }
        },
        getFontStyles() {
          try {
            var allFontStyles = [];
            if (typeof _getSSRFontStylesGoogle === "function") allFontStyles.push(..._getSSRFontStylesGoogle());
            if (typeof _getSSRFontStylesLocal === "function") allFontStyles.push(..._getSSRFontStylesLocal());
            return allFontStyles;
          } catch (e) {
            return [];
          }
        },
        getSSRHeadHTML: typeof getSSRHeadHTML === "function" ? getSSRHeadHTML : undefined,
        clientTraceMetadata: vinextConfig.clientTraceMetadata,
        gsspRes,
        isrCacheKey,
        expireSeconds: vinextConfig.expireTime,
        isrRevalidateSeconds,
        isrSet,
        i18n: {
          locale: locale,
          locales: i18nConfig ? i18nConfig.locales : undefined,
          defaultLocale: currentDefaultLocale,
          domainLocales: domainLocales,
        },
        isFallback: isFallbackRender,
        pageProps,
        params,
        renderDocumentToString(element) {
          return renderToStringAsync(element);
        },
        renderToReadableStream(element) {
          return renderToReadableStream(element);
        },
        resetSSRHead: typeof resetSSRHead === "function" ? resetSSRHead : undefined,
        routePattern,
        routeUrl,
        safeJsonStringify,
        scriptNonce,
        statusCode: renderStatusCode,
        vinext: {
          pageModuleUrl,
          appModuleUrl,
          hasMiddleware: __hasMiddleware,
        },
      });
    } catch (e) {
      console.error("[vinext] SSR error:", e);
      _reportRequestError(
        e instanceof Error ? e : new Error(String(e)),
        { path: url, method: request.method, headers: Object.fromEntries(request.headers.entries()) },
        { routerKind: "Pages Router", routePath: route.pattern, routeType: "render" },
      ).catch(() => { /* ignore reporting errors */ });
      // Data (_next/data) requests can't render HTML, and avoid recursion if
      // we're already in the middle of rendering the error page itself.
      // Mirrors Next.js base-server.ts which renders /500 (or _error) when
      // SSR throws. Fixes #1458.
      if (!isInternalErrorRender && !isDataReq) {
        // Look for an explicit pages/500.tsx first, then fall back to _error.
        // Only match the literal /500 pattern — never a catch-all/dynamic route.
        let errorRoute = null;
        for (var __i = 0; __i < pageRoutes.length; __i++) {
          if (pageRoutes[__i].pattern === "/500") {
            errorRoute = pageRoutes[__i];
            break;
          }
        }
        if (!errorRoute && _errorPageRoute) {
          errorRoute = _errorPageRoute;
        }
        if (errorRoute) {
          try {
            return await _renderPage(request, url, manifest, middlewareHeaders, {
              statusCode: 500,
              asPath: url,
              renderErrorPageOnMiss: false,
              __isInternalErrorRender: true,
              __forcedRoute: errorRoute,
            });
          } catch (errorPageErr) {
            console.error("[vinext] Error page render failed:", errorPageErr);
          }
        }
      }
      return new Response("Internal Server Error", { status: 500 });
    }
  });
}

export async function handleApiRoute(request, url, ctx) {
  const match = matchRoute(url, apiRoutes);
  return __handlePagesApiRoute({
    ctx,
    match,
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
