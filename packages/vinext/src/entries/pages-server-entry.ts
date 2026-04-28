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
import { pagesRouter, apiRouter, type Route } from "../routing/pages-router.js";
import { createValidFileMatcher } from "../routing/file-matcher.js";
import { type ResolvedNextConfig } from "../config/next-config.js";
import { isProxyFile } from "../server/middleware.js";
import {
  generateSafeRegExpCode,
  generateMiddlewareMatcherCode,
  generateNormalizePathCode,
  generateRouteMatchNormalizationCode,
} from "../server/middleware-codegen.js";
import { findFileWithExts } from "./pages-entry-helpers.js";

const _requestContextShimPath = resolveEntryPath("../shims/request-context.js", import.meta.url);
const _routeTriePath = resolveEntryPath("../routing/route-trie.js", import.meta.url);
const _pagesI18nPath = resolveEntryPath("../server/pages-i18n.js", import.meta.url);
const _pagesPageResponsePath = resolveEntryPath(
  "../server/pages-page-response.js",
  import.meta.url,
);
const _pagesPageDataPath = resolveEntryPath("../server/pages-page-data.js", import.meta.url);
const _pagesNodeCompatPath = resolveEntryPath("../server/pages-node-compat.js", import.meta.url);
const _pagesApiRoutePath = resolveEntryPath("../server/pages-api-route.js", import.meta.url);
const _isrCachePath = resolveEntryPath("../server/isr-cache.js", import.meta.url);
const _cspPath = resolveEntryPath("../server/csp.js", import.meta.url);
const _edgeRuntimeGlobalsPath = resolveEntryPath(
  "../server/edge-runtime-globals.js",
  import.meta.url,
);

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
  includeApiRoutes = true,
): Promise<string> {
  const pageRoutes = await pagesRouter(pagesDir, nextConfig?.pageExtensions, fileMatcher);
  const apiRoutes = includeApiRoutes
    ? await apiRouter(pagesDir, nextConfig?.pageExtensions, fileMatcher)
    : [];

  // Generate import statements using absolute paths since virtual
  // modules don't have a real file location for relative resolution.
  const pageImports = pageRoutes.map((r: Route, i: number) => {
    const absPath = r.filePath.replace(/\\/g, "/");
    return `import * as page_${i} from ${JSON.stringify(absPath)};`;
  });

  const apiImports = apiRoutes.map((r: Route, i: number) => {
    const absPath = r.filePath.replace(/\\/g, "/");
    return `import * as api_${i} from ${JSON.stringify(absPath)};`;
  });

  // Build the route table — include filePath for SSR manifest lookup
  const pageRouteEntries = pageRoutes.map((r: Route, i: number) => {
    const absPath = r.filePath.replace(/\\/g, "/");
    return `  { pattern: ${JSON.stringify(r.pattern)}, patternParts: ${JSON.stringify(r.patternParts)}, isDynamic: ${r.isDynamic}, params: ${JSON.stringify(r.params)}, module: page_${i}, filePath: ${JSON.stringify(absPath)} }`;
  });

  const apiRouteEntries = apiRoutes.map(
    (r: Route, i: number) =>
      `  { pattern: ${JSON.stringify(r.pattern)}, patternParts: ${JSON.stringify(r.patternParts)}, isDynamic: ${r.isDynamic}, params: ${JSON.stringify(r.params)}, module: api_${i} }`,
  );

  // Check for special Pages Router files.
  const appFilePath = findFileWithExts(pagesDir, "_app", fileMatcher);
  const docFilePath = findFileWithExts(pagesDir, "_document", fileMatcher);
  const errorFilePath = findFileWithExts(pagesDir, "_error", fileMatcher);
  const appImportCode =
    appFilePath !== null
      ? `import { default as AppComponent } from ${JSON.stringify(appFilePath.replace(/\\/g, "/"))};`
      : `const AppComponent = null;`;

  const docImportCode =
    docFilePath !== null
      ? `import { default as DocumentComponent } from ${JSON.stringify(docFilePath.replace(/\\/g, "/"))};`
      : `const DocumentComponent = null;`;

  const errorImportCode =
    errorFilePath !== null
      ? `import { default as ErrorComponent } from ${JSON.stringify(errorFilePath.replace(/\\/g, "/"))};`
      : `const ErrorComponent = null;`;

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
    buildId: nextConfig?.buildId ?? null,
    basePath: nextConfig?.basePath ?? "",
    assetPrefix: nextConfig?.assetPrefix ?? "",
    trailingSlash: nextConfig?.trailingSlash ?? false,
    redirects: nextConfig?.redirects ?? [],
    rewrites: nextConfig?.rewrites ?? { beforeFiles: [], afterFiles: [], fallback: [] },
    headers: nextConfig?.headers ?? [],
    crossOrigin: nextConfig?.crossOrigin ?? null,
    clientTraceMetadata: nextConfig?.clientTraceMetadata,
    i18n: nextConfig?.i18n ?? null,
    images: {
      deviceSizes: nextConfig?.images?.deviceSizes,
      imageSizes: nextConfig?.images?.imageSizes,
      dangerouslyAllowSVG: nextConfig?.images?.dangerouslyAllowSVG,
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
    ? `import * as _instrumentation from ${JSON.stringify(instrumentationPath.replace(/\\/g, "/"))};`
    : "";

  const instrumentationInitCode = instrumentationPath
    ? `// Run instrumentation register() once at module evaluation time — before any
// requests are handled. Matches Next.js semantics: register() is called once
// on startup in the process that handles requests.
if (typeof _instrumentation.register === "function") {
  const __previousNextRuntime = process.env.NEXT_RUNTIME;
  process.env.NEXT_RUNTIME = "nodejs";
  try {
    await _instrumentation.register();
  } finally {
    if (__previousNextRuntime === undefined) {
      delete process.env.NEXT_RUNTIME;
    } else {
      process.env.NEXT_RUNTIME = __previousNextRuntime;
    }
  }
}
// Store the onRequestError handler on globalThis so it is visible to all
// code within the Worker (same global scope).
if (typeof _instrumentation.onRequestError === "function") {
  globalThis.__VINEXT_onRequestErrorHandler__ = _instrumentation.onRequestError;
}`
    : "";

  // Generate middleware code if middleware.ts exists
  const middlewareImportCode = middlewarePath
    ? `import * as middlewareModule from ${JSON.stringify(middlewarePath.replace(/\\/g, "/"))};
import { NextRequest, NextFetchEvent } from "next/server";`
    : "";

  // The matcher config is read from the middleware module at import time.
  // We inline the matching + execution logic so the prod server can call it.
  const middlewareExportCode = middlewarePath
    ? `
// --- Middleware support (generated from middleware-codegen.ts) ---
${generateNormalizePathCode("es5")}
${generateRouteMatchNormalizationCode("es5")}
${generateSafeRegExpCode("es5")}
${generateMiddlewareMatcherCode("es5")}

export async function runMiddleware(request, ctx) {
  if (ctx) return _runWithExecutionContext(ctx, () => _runMiddleware(request));
  return _runMiddleware(request);
}

async function _runMiddleware(request) {
  var isProxy = ${middlewarePath ? JSON.stringify(isProxyFile(middlewarePath)) : "false"};
  var middlewareFn = isProxy
    ? (middlewareModule.proxy ?? middlewareModule.default)
    : (middlewareModule.middleware ?? middlewareModule.default);
  if (typeof middlewareFn !== "function") {
    var fileType = isProxy ? "Proxy" : "Middleware";
    var expectedExport = isProxy ? "proxy" : "middleware";
    throw new Error("The " + fileType + " file must export a function named \`" + expectedExport + "\` or a \`default\` function.");
  }

  var config = middlewareModule.config;
  var matcher = config && config.matcher;
  var url = new URL(request.url);

  if (vinextConfig.basePath && matcher !== undefined && request.headers.get("x-vinext-request-had-base-path") === "0") {
    return { continue: true };
  }

  // Normalize pathname before matching to prevent path-confusion bypasses
  // (percent-encoding like /%61dmin, double slashes like /dashboard//settings).
  var decodedPathname;
  try { decodedPathname = __normalizePathnameForRouteMatchStrict(url.pathname); } catch (e) {
    return { continue: false, response: new Response("Bad Request", { status: 400 }) };
  }
  var normalizedPathname = __normalizePath(decodedPathname);

  if (!matchesMiddleware(normalizedPathname, matcher, request, i18nConfig)) return { continue: true };

   // Construct a new Request with the decoded + normalized pathname so middleware
   // always sees the same canonical path that the router uses.
  var mwRequest = request;
  if (normalizedPathname !== url.pathname) {
    var mwUrl = new URL(url);
    mwUrl.pathname = normalizedPathname;
    mwRequest = new Request(mwUrl, request.clone());
  }
  var __mwBasePath = vinextConfig.basePath && request.headers.get("x-vinext-request-had-base-path") !== "0" ? vinextConfig.basePath : "";
  var __mwNextConfig = (__mwBasePath || i18nConfig) ? { basePath: __mwBasePath, i18n: i18nConfig || undefined } : undefined;
  var nextRequest = mwRequest instanceof NextRequest ? mwRequest : new NextRequest(mwRequest, __mwNextConfig ? { nextConfig: __mwNextConfig } : undefined);
  if (mwRequest.headers.get("x-vinext-data-request") === "1") {
    Object.defineProperty(nextRequest, "__isData", {
      value: true,
      enumerable: false,
      configurable: true,
    });
  }
  var fetchEvent = new NextFetchEvent({ page: normalizedPathname });
  var response;
  try { response = await middlewareFn(nextRequest, fetchEvent); }
  catch (e) {
    console.error("[vinext] Middleware error:", e);
    var _mwCtxErr = _getRequestExecutionContext();
    if (_mwCtxErr && typeof _mwCtxErr.waitUntil === "function") { _mwCtxErr.waitUntil(fetchEvent.drainWaitUntil()); } else { fetchEvent.drainWaitUntil(); }
    return { continue: false, response: new Response("Internal Server Error", { status: 500 }) };
  }
  var _mwCtx = _getRequestExecutionContext();
  if (_mwCtx && typeof _mwCtx.waitUntil === "function") { _mwCtx.waitUntil(fetchEvent.drainWaitUntil()); } else { fetchEvent.drainWaitUntil(); }

  if (!response) return { continue: true };

  if (response.headers.get("x-middleware-next") === "1") {
    var rHeaders = new Headers();
    for (var [key, value] of response.headers) {
      // Keep x-middleware-request-* headers so the production server can
      // apply middleware-request header overrides before stripping internals
      // from the final client response.
      if (
        !key.startsWith("x-middleware-") ||
        key === "x-middleware-override-headers" ||
        key.startsWith("x-middleware-request-")
      ) rHeaders.append(key, value);
    }
    return { continue: true, responseHeaders: rHeaders };
  }

  if (response.status >= 300 && response.status < 400) {
    var location = response.headers.get("Location") || response.headers.get("location");
    if (location) {
      var rdHeaders = new Headers();
      for (var [rk, rv] of response.headers) {
        if (!rk.startsWith("x-middleware-") && rk.toLowerCase() !== "location") rdHeaders.append(rk, rv);
      }
      return { continue: false, redirectUrl: location, redirectStatus: response.status, responseHeaders: rdHeaders };
    }
  }

  var rewriteUrl = response.headers.get("x-middleware-rewrite");
  if (rewriteUrl) {
    var rwHeaders = new Headers();
    for (var [k, v] of response.headers) {
      if (!k.startsWith("x-middleware-") || k === "x-middleware-override-headers" || k.startsWith("x-middleware-request-")) rwHeaders.append(k, v);
    }
    var rewritePath;
    try {
      var parsed = new URL(rewriteUrl, request.url);
      var current = new URL(request.url);
      if (parsed.origin !== current.origin) {
        rewritePath = parsed.toString();
      } else {
        var parsedPathname = parsed.pathname;
        if (__mwBasePath && (parsedPathname === __mwBasePath || parsedPathname.startsWith(__mwBasePath + "/"))) {
          parsedPathname = parsedPathname.slice(__mwBasePath.length) || "/";
        }
        rewritePath = parsedPathname + parsed.search;
      }
    }
    catch { rewritePath = rewriteUrl; }
    return { continue: true, rewriteUrl: rewritePath, rewriteStatus: response.status !== 200 ? response.status : undefined, responseHeaders: rwHeaders };
  }

  return { continue: false, response: response };
}
`
    : `
export async function runMiddleware() { return { continue: true }; }
`;

  // The server entry is a self-contained module that uses Web-standard APIs
  // (Request/Response, renderToReadableStream) so it runs on Cloudflare Workers.
  return `
import ${JSON.stringify(_edgeRuntimeGlobalsPath)};
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
import { buildPagesIsrCacheControl as __buildPagesIsrCacheControl, isPagesHtmlBotUserAgent as __isPagesHtmlBotUserAgent, renderPagesPageResponse as __renderPagesPageResponse } from ${JSON.stringify(_pagesPageResponsePath)};
${instrumentationImportCode}
${middlewareImportCode}

${instrumentationInitCode}

// i18n config (embedded at build time)
const i18nConfig = ${i18nConfigJson};

// Build ID (embedded at build time)
const buildId = process.env.__VINEXT_BUILD_ID || ${buildIdJson};
const __generatedFallbackPaths = new Set();
const __onDemandRevalidatePaths = new Set();

// Full resolved config for production server (embedded at build time)
export const vinextConfig = ${vinextConfigJson};

function isrGet(key) {
  return __sharedIsrGet(key);
}
function isrSet(key, data, revalidateSeconds, tags) {
  return __sharedIsrSet(key, data, revalidateSeconds, tags);
}
function triggerBackgroundRegeneration(key, renderFn) {
  return __sharedTriggerBackgroundRegeneration(key, renderFn);
}
function isrCacheKey(router, pathname) {
  return __sharedIsrCacheKey(router, pathname, buildId || undefined);
}

function normalizeRevalidatePath(urlPath) {
  try {
    const parsed = new URL(urlPath, "http://vinext.local");
    const pathname = parsed.pathname || "/";
    return pathname !== "/" && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  } catch (_error) {
    const pathname = String(urlPath || "/").split("?")[0] || "/";
    return pathname !== "/" && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  }
}

async function renderToStringAsync(element) {
  const stream = await renderToReadableStream(element);
  await stream.allReady;
  return new Response(stream).text();
}

async function renderHeadPrepassAsync(element) {
  const stream = await renderToReadableStream(element, {
    onError() {
      // The prepass is intentionally aborted after synchronous next/head tags render.
    },
  });
  try {
    await stream.cancel();
  } catch (_error) {
    // The prepass only exists to collect synchronously rendered next/head tags.
  }
  return "";
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

const appModuleFilePath = ${JSON.stringify(appFilePath?.replace(/\\/g, "/") ?? null)};
const errorModuleFilePath = ${JSON.stringify(errorFilePath?.replace(/\\/g, "/") ?? null)};

export const pageRoutes = [
${pageRouteEntries.join(",\n")}
];
const _pageRouteTrie = _buildRouteTrie(pageRoutes);

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

function parseQuery(url) {
  const queryIndex = url.indexOf("?");
  const qs = queryIndex === -1 ? "" : url.slice(queryIndex + 1);
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

function mergeRouteQuery(params, url) {
  return { ...parseQuery(url), ...params };
}

function requestPathAndSearch(request) {
  const url = new URL(request.url);
  return url.pathname + url.search;
}

function patternToNextFormat(pattern) {
  return pattern
    .replace(/:([\\w]+)\\*/g, "[[...$1]]")
    .replace(/:([\\w]+)\\+/g, "[...$1]")
    .replace(/:([\\w]+)/g, "[$1]");
}

function findModuleJsAsset(manifest, moduleId) {
  const m = (manifest && Object.keys(manifest).length > 0)
    ? manifest
    : (typeof globalThis !== "undefined" && globalThis.__VINEXT_SSR_MANIFEST__) || null;
  if (!m || !moduleId) return undefined;

  var files = m[moduleId];
  if (!files) {
    for (var mk in m) {
      if (moduleId.endsWith("/" + mk) || moduleId === mk) {
        files = m[mk];
        break;
      }
    }
  }
  if (!files) return undefined;
  for (var i = 0; i < files.length; i++) {
    var file = files[i];
    if (!file || !file.endsWith(".js")) continue;
    if (file.charAt(0) !== "/") file = "/" + file;
    return file;
  }
  return undefined;
}

function collectAssetTags(manifest, moduleIds, scriptNonce) {
  // Fall back to embedded manifest (set by vinext:cloudflare-build for Workers)
  const m = (manifest && Object.keys(manifest).length > 0)
    ? manifest
    : (typeof globalThis !== "undefined" && globalThis.__VINEXT_SSR_MANIFEST__) || null;
  const tags = [];
  const seen = new Set();
  const nonceAttr = __createNonceAttribute(scriptNonce);
  const crossOriginAttr = vinextConfig.crossOrigin
    ? ' crossorigin="' + vinextConfig.crossOrigin + '"'
    : " crossorigin";

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
    tags.push('<script type="module"' + nonceAttr + ' defer src="/' + entry + '"' + crossOriginAttr + '></script>');
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
        var files = m[id];
        if (!files) {
          // Absolute path didn't match — try matching by suffix.
          // Manifest keys are relative (e.g. "pages/about.tsx") while
          // moduleIds may be absolute (e.g. "/home/.../pages/about.tsx").
          for (var mk in m) {
            if (id.endsWith("/" + mk) || id === mk) {
              files = m[mk];
              break;
            }
          }
        }
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
        tags.push('<script type="module"' + nonceAttr + ' defer src="/' + tf + '"' + crossOriginAttr + '></script>');
      }
    }
  }
  return tags.join("\\n  ");
}

// i18n helpers
function extractLocale(url) {
  if (!i18nConfig) return { locale: undefined, url, hadPrefix: false };
  const pathname = url.split("?")[0];
  const parts = pathname.split("/").filter(Boolean);
  const query = url.includes("?") ? url.slice(url.indexOf("?")) : "";
  if (parts.length > 0 && i18nConfig.locales.includes(parts[0])) {
    const locale = parts[0];
    const rest = "/" + parts.slice(1).join("/");
    return { locale, url: (rest || "/") + query, hadPrefix: true };
  }
  return { locale: i18nConfig.defaultLocale, url, hadPrefix: false };
}

function detectLocaleFromHeaders(headers) {
  if (!i18nConfig) return null;
  const acceptLang = headers.get("accept-language");
  if (!acceptLang) return null;
  const langs = acceptLang.split(",").map(function(part) {
    const pieces = part.trim().split(";");
    const q = pieces[1] ? parseFloat(pieces[1].replace("q=", "")) : 1;
    return { lang: pieces[0].trim().toLowerCase(), q: q };
  }).sort(function(a, b) { return b.q - a.q; });
  for (let k = 0; k < langs.length; k++) {
    const lang = langs[k].lang;
    for (let j = 0; j < i18nConfig.locales.length; j++) {
      if (i18nConfig.locales[j].toLowerCase() === lang) return i18nConfig.locales[j];
    }
    const prefix = lang.split("-")[0];
    for (let j = 0; j < i18nConfig.locales.length; j++) {
      const loc = i18nConfig.locales[j].toLowerCase();
      if (loc === prefix || loc.startsWith(prefix + "-")) return i18nConfig.locales[j];
    }
  }
  return null;
}

function parseCookieLocaleFromHeader(cookieHeader) {
  if (!i18nConfig || !cookieHeader) return null;
  const match = cookieHeader.match(/(?:^|;\\s*)NEXT_LOCALE=([^;]*)/);
  if (!match) return null;
  var value;
  try { value = decodeURIComponent(match[1].trim()); } catch (e) { return null; }
  if (i18nConfig.locales.indexOf(value) !== -1) return value;
  return null;
}

export async function renderPage(request, url, manifest, ctx, middlewareHeaders, isDataRequest) {
  if (ctx) return _runWithExecutionContext(ctx, () => _renderPage(request, url, manifest, middlewareHeaders, isDataRequest));
  return _renderPage(request, url, manifest, middlewareHeaders, isDataRequest);
}

async function renderStatusPage(options) {
  const statusCode = options.statusCode;
  const statusRoutePattern = statusCode === 404 ? "/404" : "/500";
  const statusRoute = pageRoutes.find(function(route) {
    return route.pattern === statusRoutePattern;
  });
  const route = statusRoute || null;
  const PageComponent = route && route.module && route.module.default
    ? route.module.default
    : ErrorComponent;

  if (!PageComponent) return null;

  const routePattern = route ? patternToNextFormat(route.pattern) : "/_error";
  const routeUrl = route ? route.pattern : "/_error";
  const requestUrl = requestPathAndSearch(options.request);
  let pageProps = { statusCode };
  const query = {};
  const scriptNonce = __getScriptNonceFromHeaderSources(options.request.headers, options.middlewareHeaders);
  const shouldBufferResponse = true;

  if (typeof setSSRContext === "function") {
    setSSRContext({
      pathname: routePattern,
      query,
      asPath: requestUrl,
      isFallback: false,
      locale: options.locale,
      locales: i18nConfig ? i18nConfig.locales : undefined,
      defaultLocale: options.defaultLocale,
      domainLocales: options.domainLocales,
    });
  }

  if (i18nConfig) {
    setI18nContext({
      locale: options.locale,
      locales: i18nConfig.locales,
      defaultLocale: options.defaultLocale,
      domainLocales: options.domainLocales,
      hostname: new URL(options.request.url).hostname,
    });
  }

  if (PageComponent && typeof PageComponent.getInitialProps === "function") {
    const errorReqRes = __createPagesReqRes({
      body: undefined,
      query,
      request: options.request,
      url: requestUrl,
    });
    errorReqRes.res.statusCode = statusCode;
    const nextErrorProps = await PageComponent.getInitialProps({
      pathname: routePattern,
      query,
      asPath: requestUrl,
      locale: options.locale,
      locales: i18nConfig ? i18nConfig.locales : undefined,
      defaultLocale: options.defaultLocale,
      req: errorReqRes.req,
      res: errorReqRes.res,
      err: options.err,
    });
    if (errorReqRes.res.headersSent) {
      return await errorReqRes.responsePromise;
    }
    if (nextErrorProps && typeof nextErrorProps === "object") {
      pageProps = { ...pageProps, ...nextErrorProps };
    }
  }

  function createPageElement(currentPageProps) {
    var currentElement = AppComponent
      ? React.createElement(AppComponent, { Component: PageComponent, pageProps: currentPageProps })
      : React.createElement(PageComponent, currentPageProps);
    return wrapWithRouterContext(currentElement);
  }

  let documentInitialProps = {};
  if (DocumentComponent && typeof DocumentComponent.getInitialProps === "function") {
    const documentReqRes = __createPagesReqRes({
      body: undefined,
      query,
      request: options.request,
      url: requestUrl,
    });
    const documentCtx = {
      pathname: routePattern,
      query,
      asPath: requestUrl,
      locale: options.locale,
      locales: i18nConfig ? i18nConfig.locales : undefined,
      defaultLocale: options.defaultLocale,
      req: documentReqRes.req,
      res: documentReqRes.res,
      renderPage: async function renderDocumentPage() {
        const html = await renderToStringAsync(createPageElement(pageProps));
        return { html, head: [], styles: [] };
      },
    };
    const nextDocumentProps = await DocumentComponent.getInitialProps(documentCtx);
    if (documentReqRes.res.headersSent) {
      return await documentReqRes.responsePromise;
    }
    if (nextDocumentProps && typeof nextDocumentProps === "object") {
      documentInitialProps = nextDocumentProps;
    }
  }

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

  const pageModuleFilePath = route ? route.filePath : errorModuleFilePath;
  const pageModuleUrl = pageModuleFilePath ? findModuleJsAsset(options.manifest, pageModuleFilePath) : null;
  const appModuleUrl = findModuleJsAsset(options.manifest, appModuleFilePath);
  const pageModuleIds = pageModuleFilePath ? [pageModuleFilePath] : [];
  const assetTags = collectAssetTags(options.manifest, pageModuleIds, scriptNonce);
  const response = await __renderPagesPageResponse({
    assetTags,
    appProps: {},
    buildId,
    clientTraceMetadata: vinextConfig.clientTraceMetadata,
    clearSsrContext() {
      if (typeof setSSRContext === "function") setSSRContext(null);
    },
    createPageElement,
    crossOrigin: vinextConfig.crossOrigin,
    DocumentComponent,
    documentProps: documentInitialProps,
    documentRenderPageOptions: null,
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
    gsspRes: null,
    isFallback: false,
    isGsp: false,
    isrCacheKey,
    isrRevalidateSeconds: null,
    isrSet,
    i18n: {
      locale: options.locale,
      locales: i18nConfig ? i18nConfig.locales : undefined,
      defaultLocale: options.defaultLocale,
      domainLocales: options.domainLocales,
    },
    pageProps,
    pageModuleUrl,
    appModuleUrl,
    params: query,
    renderDocumentToString(element) {
      return renderToStringAsync(element);
    },
    renderHeadPrepassToStringAsync(element) {
      return renderHeadPrepassAsync(element);
    },
    renderIsrPassToStringAsync,
    renderToReadableStream(element) {
      return renderToReadableStream(element);
    },
    resetSSRHead: typeof resetSSRHead === "function" ? resetSSRHead : undefined,
    routePattern,
    routeUrl,
    safeJsonStringify,
    scriptNonce,
    shouldBufferResponse,
  });

  return new Response(response.body, {
    status: statusCode,
    headers: response.headers,
  });
}

async function _renderPage(request, url, manifest, middlewareHeaders, isDataRequest) {
  const localeInfo = i18nConfig
    ? resolvePagesI18nRequest(
        url,
        i18nConfig,
        request.headers,
        new URL(request.url).hostname,
        vinextConfig.basePath,
        vinextConfig.trailingSlash,
        { skipLocaleRedirect: isDataRequest },
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

  const match = matchRoute(routeUrl, pageRoutes);
  if (!match) {
    const notFoundResponse = await renderStatusPage({
      request,
      manifest,
      middlewareHeaders,
      statusCode: 404,
      locale,
      defaultLocale: currentDefaultLocale,
      domainLocales,
    });
    if (notFoundResponse) return notFoundResponse;
    return new Response("<!DOCTYPE html><html><body><h1>404 - Page not found</h1><p>This page could not be found.</p></body></html>",
      { status: 404, headers: { "Content-Type": "text/html" } });
  }

  const { route, params } = match;
  const __uCtx = _createUnifiedCtx({
    executionContext: _getRequestExecutionContext(),
  });
  return _runWithUnifiedCtx(__uCtx, async () => {
    ensureFetchPatch();
    try {
      const routePattern = patternToNextFormat(route.pattern);
      const requestUrl = request.headers.get("x-vinext-original-url") || requestPathAndSearch(request);
      const asPath = isDataRequest ? routeUrl : requestUrl;
      const routeUrlObject = new URL(routeUrl, "http://vinext.local");
      const requestUrlObject = new URL(requestUrl, "http://vinext.local");
      const routePathname = normalizeRevalidatePath(routeUrlObject.pathname);
      const hasOnDemandRevalidate = __onDemandRevalidatePaths.delete(routePathname);
      const revalidateReason = hasOnDemandRevalidate
        ? "on-demand"
        : process.env.VINEXT_PRERENDER === "1"
          ? "build"
          : undefined;
      const resolvedUrl = isDataRequest
        ? routeUrl
        : routeUrlObject.pathname + requestUrlObject.search;
      const pageModule = route.module;
      const isGsspPage = typeof pageModule.getServerSideProps === "function";
      const isGspPage = typeof pageModule.getStaticProps === "function";
      const routeSearchWasRewritten =
        routeUrlObject.search !== "" && routeUrlObject.search !== requestUrlObject.search;
      const query = isGsspPage
        ? mergeRouteQuery(params, routeUrl)
        : isGspPage
          ? routeSearchWasRewritten
            ? mergeRouteQuery(params, routeUrl)
            : { ...params }
          : mergeRouteQuery(params, requestUrl);
      if (!isGsspPage && request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method Not Allowed", {
          status: 405,
          headers: { Allow: "GET, HEAD" },
        });
      }

      if (typeof setSSRContext === "function") {
        setSSRContext({
          pathname: routePattern,
          query,
          asPath,
          isFallback: false,
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

      const PageComponent = pageModule.default;
      if (!PageComponent) {
        return new Response("Page has no default export", { status: 500 });
      }
      const scriptNonce = __getScriptNonceFromHeaderSources(request.headers, middlewareHeaders);
      const isCrawlerRequest = __isPagesHtmlBotUserAgent(request.headers.get("user-agent") || "");
      const shouldBufferResponse = isCrawlerRequest;
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
        applyRequestContexts() {
          if (typeof setSSRContext === "function") {
            setSSRContext({
              pathname: routePattern,
              query,
              asPath,
              isFallback: false,
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
          return __createPagesReqRes({ body: undefined, query, request, url: requestUrl });
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
        pageModule,
        params,
        query,
        hasGeneratedFallbackPath: __generatedFallbackPaths.has(routeUrlObject.pathname),
        isCrawlerRequest,
        isDataRequest,
        revalidateReason,
        resolvedUrl,
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
        triggerBackgroundRegeneration,
      });
      if (pageDataResult.kind === "response") {
        return pageDataResult.response;
      }
      if (pageDataResult.kind === "notFound") {
        const notFoundResponse = await renderStatusPage({
          request,
          manifest,
          middlewareHeaders,
          statusCode: 404,
          locale,
          defaultLocale: currentDefaultLocale,
          domainLocales,
        });
        if (notFoundResponse) return notFoundResponse;
        return new Response("<!DOCTYPE html><html><body><h1>404 - Page not found</h1><p>This page could not be found.</p></body></html>",
          { status: 404, headers: { "Content-Type": "text/html" } });
      }
      let pageProps = pageDataResult.pageProps;
      var gsspRes = pageDataResult.gsspRes;
      let isrRevalidateSeconds = pageDataResult.isrRevalidateSeconds;
      const isFallback = pageDataResult.isFallback === true;
      if (typeof setSSRContext === "function") {
        setSSRContext({
          pathname: routePattern,
          query,
          asPath,
          isFallback,
          locale: locale,
          locales: i18nConfig ? i18nConfig.locales : undefined,
          defaultLocale: currentDefaultLocale,
          domainLocales: domainLocales,
        });
      }
      let appInitialProps = {};
      const documentQuery = query;
      if (AppComponent && typeof AppComponent.getInitialProps === "function") {
        const appReqRes = __createPagesReqRes({ body: undefined, query: documentQuery, request, url: requestUrl });
        const appCtx = {
          Component: PageComponent,
          router: {
            pathname: routePattern,
            route: routePattern,
            query: documentQuery,
            asPath,
          },
          ctx: {
            req: appReqRes.req,
            res: appReqRes.res,
            pathname: routePattern,
            query: documentQuery,
            asPath,
            locale: locale,
            locales: i18nConfig ? i18nConfig.locales : undefined,
            defaultLocale: currentDefaultLocale,
          },
        };
        const nextAppProps = await AppComponent.getInitialProps(appCtx);
        if (appReqRes.res.headersSent) {
          return await appReqRes.responsePromise;
        }
        if (nextAppProps && typeof nextAppProps === "object") {
          const { pageProps: appPageProps, ...restAppProps } = nextAppProps;
          appInitialProps = restAppProps;
          if (appPageProps && typeof appPageProps === "object") {
            pageProps = { ...appPageProps, ...pageProps };
          }
        }
      }

      function normalizeDocumentRenderPageOptions(renderOptions) {
        if (!renderOptions) return null;
        if (typeof renderOptions === "function") {
          return { enhanceComponent: renderOptions };
        }
        return renderOptions;
      }

      function createPageElementWithOptions(currentPageProps, renderOptions) {
        var normalizedRenderOptions = normalizeDocumentRenderPageOptions(renderOptions);
        var RenderPageComponent = PageComponent;
        var RenderAppComponent = AppComponent;
        if (normalizedRenderOptions && typeof normalizedRenderOptions.enhanceComponent === "function") {
          RenderPageComponent = normalizedRenderOptions.enhanceComponent(RenderPageComponent);
        }

        var currentElement;
        if (RenderAppComponent) {
          if (normalizedRenderOptions && typeof normalizedRenderOptions.enhanceApp === "function") {
            RenderAppComponent = normalizedRenderOptions.enhanceApp(RenderAppComponent);
          }
          currentElement = React.createElement(RenderAppComponent, { Component: RenderPageComponent, pageProps: currentPageProps, ...appInitialProps });
        } else if (normalizedRenderOptions && typeof normalizedRenderOptions.enhanceApp === "function") {
          var DefaultApp = function DefaultApp(props) {
            return React.createElement(props.Component, props.pageProps);
          };
          RenderAppComponent = normalizedRenderOptions.enhanceApp(DefaultApp);
          currentElement = React.createElement(RenderAppComponent, { Component: RenderPageComponent, pageProps: currentPageProps });
        } else {
          currentElement = React.createElement(RenderPageComponent, currentPageProps);
        }
        return wrapWithRouterContext(currentElement);
      }

      let documentInitialProps = {};
      let documentRenderPageOptions = null;
      if (DocumentComponent && typeof DocumentComponent.getInitialProps === "function") {
        const documentReqRes = __createPagesReqRes({ body: undefined, query: documentQuery, request, url: requestUrl });
        const documentCtx = {
          pathname: routePattern,
          query: documentQuery,
          asPath,
          locale: locale,
          locales: i18nConfig ? i18nConfig.locales : undefined,
          defaultLocale: currentDefaultLocale,
          req: documentReqRes.req,
          res: documentReqRes.res,
          renderPage: async function renderDocumentPage(renderOptions) {
            documentRenderPageOptions = normalizeDocumentRenderPageOptions(renderOptions);
            const html = await renderToStringAsync(
              createPageElementWithOptions(pageProps, documentRenderPageOptions),
            );
            return { html, head: [], styles: [] };
          },
        };
        const nextDocumentProps = await DocumentComponent.getInitialProps(documentCtx);
        if (documentReqRes.res.headersSent) {
          return await documentReqRes.responsePromise;
        }
        if (nextDocumentProps && typeof nextDocumentProps === "object") {
          documentInitialProps = nextDocumentProps;
        }
      }

      const pageModuleUrl = findModuleJsAsset(manifest, route.filePath);
      const appModuleUrl = findModuleJsAsset(manifest, appModuleFilePath);

      if (isDataRequest) {
        var dataHeaders = new Headers({ "Content-Type": "application/json" });
        if (process.env.NEXT_DEPLOYMENT_ID) {
          dataHeaders.set("x-nextjs-deployment-id", process.env.NEXT_DEPLOYMENT_ID);
        }
        if (gsspRes && typeof gsspRes.getHeaders === "function") {
          var gsspHeaders = gsspRes.getHeaders();
          for (var hk in gsspHeaders) {
            var hv = gsspHeaders[hk];
            if (Array.isArray(hv)) {
              for (var hi = 0; hi < hv.length; hi++) dataHeaders.append(hk, String(hv[hi]));
            } else if (hv !== undefined) {
              dataHeaders.set(hk, String(hv));
            }
          }
          dataHeaders.set("Content-Type", "application/json");
        }
        if (gsspRes && !dataHeaders.has("Cache-Control")) {
          dataHeaders.set("Cache-Control", "private, no-cache, no-store, max-age=0, must-revalidate");
        }
        if (isGspPage && !dataHeaders.has("Cache-Control")) {
          dataHeaders.set("Cache-Control", __buildPagesIsrCacheControl(isrRevalidateSeconds || undefined, "MISS"));
        }
        if (isGspPage) {
          __generatedFallbackPaths.add(routeUrlObject.pathname);
        }
        return new Response(safeJsonStringify({
          ...appInitialProps,
          pageProps,
          page: routePattern,
          query,
          buildId,
          isFallback,
          ...(i18nConfig ? {
            locale,
            locales: i18nConfig.locales,
            defaultLocale: currentDefaultLocale,
            domainLocales,
          } : {}),
          ...(isGspPage ? { gsp: true } : {}),
          ...(gsspRes ? { gssp: true } : {}),
          __vinext: {
            ...(pageModuleUrl ? { pageModuleUrl } : {}),
            ...(appModuleUrl ? { appModuleUrl } : {}),
          },
        }), {
          status: gsspRes ? gsspRes.statusCode : 200,
          headers: dataHeaders,
        });
      }

      const pageModuleIds = route.filePath ? [route.filePath] : [];
      const assetTags = collectAssetTags(manifest, pageModuleIds, scriptNonce);

      return await __renderPagesPageResponse({
        assetTags,
        appProps: appInitialProps,
        buildId,
        clientTraceMetadata: vinextConfig.clientTraceMetadata,
        clearSsrContext() {
          if (typeof setSSRContext === "function") setSSRContext(null);
        },
        createPageElement(currentPageProps) {
          return createPageElementWithOptions(currentPageProps, documentRenderPageOptions);
        },
        crossOrigin: vinextConfig.crossOrigin,
        DocumentComponent,
        documentProps: documentInitialProps,
        documentRenderPageOptions,
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
        gsspRes,
        isFallback,
        isGsp: isGspPage,
        isrCacheKey,
        isrRevalidateSeconds,
        isrSet,
        i18n: {
          locale: locale,
          locales: i18nConfig ? i18nConfig.locales : undefined,
          defaultLocale: currentDefaultLocale,
          domainLocales: domainLocales,
        },
        pageProps,
        pageModuleUrl,
        appModuleUrl,
        params: query,
        renderDocumentToString(element) {
          return renderToStringAsync(element);
        },
        renderHeadPrepassToStringAsync(element) {
          return renderHeadPrepassAsync(element);
        },
        renderIsrPassToStringAsync,
        renderToReadableStream(element) {
          return renderToReadableStream(element);
        },
        resetSSRHead: typeof resetSSRHead === "function" ? resetSSRHead : undefined,
        routePattern,
        routeUrl,
        safeJsonStringify,
        scriptNonce,
        shouldBufferResponse,
      });
    } catch (e) {
      console.error("[vinext] SSR error:", e);
      _reportRequestError(
        e instanceof Error ? e : new Error(String(e)),
        { path: url, method: request.method, headers: Object.fromEntries(request.headers.entries()) },
        { routerKind: "Pages Router", routePath: route.pattern, routeType: "render" },
      ).catch(() => { /* ignore reporting errors */ });
      try {
        const errorResponse = await renderStatusPage({
          request,
          manifest,
          middlewareHeaders,
          statusCode: 500,
          locale,
          defaultLocale: currentDefaultLocale,
          domainLocales,
        });
        if (errorResponse) return errorResponse;
      } catch (_render500Error) {
        // Fall through to the generic 500 below.
      }
      return new Response("Internal Server Error", { status: 500 });
    }
  });
}

export async function handleApiRoute(request, url) {
  const match = matchRoute(url, apiRoutes);
  return __handlePagesApiRoute({
    match,
    onRevalidate(urlPath) {
      __onDemandRevalidatePaths.add(normalizeRevalidatePath(urlPath));
    },
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
