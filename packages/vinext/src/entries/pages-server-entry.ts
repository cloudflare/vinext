/**
 * Pages Router server entry generator.
 *
 * Generates the virtual SSR server entry module (`virtual:vinext-server-entry`).
 * This is the entry point for `vite build --ssr`. It handles SSR, API routes,
 * middleware, ISR, and i18n for the Pages Router.
 *
 * Extracted from index.ts.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pagesRouter, apiRouter, type Route } from "../routing/pages-router.js";
import { createValidFileMatcher } from "../routing/file-matcher.js";
import { type ResolvedNextConfig } from "../config/next-config.js";
import { isProxyFile } from "../server/middleware.js";
import {
  generateSafeRegExpCode,
  generateMiddlewareMatcherCode,
  generateNormalizePathCode,
} from "../server/middleware-codegen.js";
import { findFileWithExts } from "./pages-entry-helpers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
      return `  { pattern: ${JSON.stringify(r.pattern)}, isDynamic: ${r.isDynamic}, params: ${JSON.stringify(r.params)}, module: page_${i}, filePath: ${JSON.stringify(absPath)} }`;
    });

    const apiRouteEntries = apiRoutes.map((r: Route, i: number) => {
      return `  { pattern: ${JSON.stringify(r.pattern)}, isDynamic: ${r.isDynamic}, params: ${JSON.stringify(r.params)}, module: api_${i} }`;
    });

    // Check for _app and _document
    const appFilePath = findFileWithExts(pagesDir, "_app", fileMatcher);
    const docFilePath = findFileWithExts(pagesDir, "_document", fileMatcher);
    const hasApp = appFilePath !== null;
    const hasDoc = docFilePath !== null;

    const appImportCode = hasApp
      ? `import { default as AppComponent } from ${JSON.stringify(appFilePath!.replace(/\\/g, "/"))};`
      : `const AppComponent = null;`;

    const docImportCode = hasDoc
      ? `import { default as DocumentComponent } from ${JSON.stringify(docFilePath!.replace(/\\/g, "/"))};`
      : `const DocumentComponent = null;`;

    // Serialize i18n config for embedding in the server entry
    const i18nConfigJson = nextConfig?.i18n
      ? JSON.stringify({
          locales: nextConfig.i18n.locales,
          defaultLocale: nextConfig.i18n.defaultLocale,
          localeDetection: nextConfig.i18n.localeDetection,
        })
      : "null";

    // Serialize the full resolved config for the production server.
    // This embeds redirects, rewrites, headers, basePath, trailingSlash
    // so prod-server.ts can apply them without loading next.config.js at runtime.
    const vinextConfigJson = JSON.stringify({
      basePath: nextConfig?.basePath ?? "",
      trailingSlash: nextConfig?.trailingSlash ?? false,
      redirects: nextConfig?.redirects ?? [],
      rewrites: nextConfig?.rewrites ?? { beforeFiles: [], afterFiles: [], fallback: [] },
      headers: nextConfig?.headers ?? [],
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
      ? `import * as middlewareModule from ${JSON.stringify(middlewarePath.replace(/\\/g, "/"))};
import { NextRequest, NextFetchEvent } from "next/server";`
      : "";

    // The matcher config is read from the middleware module at import time.
    // We inline the matching + execution logic so the prod server can call it.
    const middlewareExportCode = middlewarePath
      ? `
// --- Middleware support (generated from middleware-codegen.ts) ---
${generateNormalizePathCode("es5")}
${generateSafeRegExpCode("es5")}
${generateMiddlewareMatcherCode("es5")}

export async function runMiddleware(request, ctx) {
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

  // Normalize pathname before matching to prevent path-confusion bypasses
  // (percent-encoding like /%61dmin, double slashes like /dashboard//settings).
  var decodedPathname;
  try { decodedPathname = decodeURIComponent(url.pathname); } catch (e) {
    return { continue: false, response: new Response("Bad Request", { status: 400 }) };
  }
  var normalizedPathname = __normalizePath(decodedPathname);

  if (!matchesMiddleware(normalizedPathname, matcher)) return { continue: true };

   // Construct a new Request with the decoded + normalized pathname so middleware
   // always sees the same canonical path that the router uses.
  var mwRequest = request;
  if (normalizedPathname !== url.pathname) {
    var mwUrl = new URL(url);
    mwUrl.pathname = normalizedPathname;
    mwRequest = new Request(mwUrl, request);
  }
  var nextRequest = mwRequest instanceof NextRequest ? mwRequest : new NextRequest(mwRequest);
  var fetchEvent = new NextFetchEvent({ page: normalizedPathname });
  var response;
  try { response = await middlewareFn(nextRequest, fetchEvent); }
  catch (e) {
    console.error("[vinext] Middleware error:", e);
    return { continue: false, response: new Response("Internal Server Error", { status: 500 }) };
  }
  if (ctx && typeof ctx.waitUntil === "function") { ctx.waitUntil(fetchEvent.drainWaitUntil()); } else { fetchEvent.drainWaitUntil(); }

  if (!response) return { continue: true };

  if (response.headers.get("x-middleware-next") === "1") {
    var rHeaders = new Headers();
    for (var [key, value] of response.headers) {
      // Keep x-middleware-request-* headers so the production server can
      // apply middleware-request header overrides before stripping internals
      // from the final client response.
      if (
        !key.startsWith("x-middleware-") ||
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
      if (!k.startsWith("x-middleware-") || k.startsWith("x-middleware-request-")) rwHeaders.append(k, v);
    }
    var rewritePath;
    try { var parsed = new URL(rewriteUrl, request.url); rewritePath = parsed.pathname + parsed.search; }
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
import React from "react";
import { renderToReadableStream } from "react-dom/server.edge";
import { resetSSRHead, getSSRHeadHTML } from "next/head";
import { flushPreloads } from "next/dynamic";
import { setSSRContext, wrapWithRouterContext } from "next/router";
import { getCacheHandler } from "next/cache";
import { runWithFetchCache } from "vinext/fetch-cache";
import { _runWithCacheState } from "next/cache";
import { runWithPrivateCache } from "vinext/cache-runtime";
import { runWithRouterState } from "vinext/router-state";
import { runWithHeadState } from "vinext/head-state";
import { safeJsonStringify } from "vinext/html";
import { getSSRFontLinks as _getSSRFontLinks, getSSRFontStyles as _getSSRFontStylesGoogle, getSSRFontPreloads as _getSSRFontPreloadsGoogle } from "next/font/google";
import { getSSRFontStyles as _getSSRFontStylesLocal, getSSRFontPreloads as _getSSRFontPreloadsLocal } from "next/font/local";
import { parseCookies } from ${JSON.stringify(path.resolve(__dirname, "../config/config-matchers.js").replace(/\\/g, "/"))};
${instrumentationImportCode}
${middlewareImportCode}

${instrumentationInitCode}

// i18n config (embedded at build time)
const i18nConfig = ${i18nConfigJson};

// Full resolved config for production server (embedded at build time)
export const vinextConfig = ${vinextConfigJson};

// ISR cache helpers (inlined for the server entry)
async function isrGet(key) {
  const handler = getCacheHandler();
  const result = await handler.get(key);
  if (!result || !result.value) return null;
  return { value: result, isStale: result.cacheState === "stale" };
}
async function isrSet(key, data, revalidateSeconds, tags) {
  const handler = getCacheHandler();
  await handler.set(key, data, { revalidate: revalidateSeconds, tags: tags || [] });
}
const pendingRegenerations = new Map();
function triggerBackgroundRegeneration(key, renderFn) {
  if (pendingRegenerations.has(key)) return;
  const promise = renderFn()
    .catch((err) => console.error("[vinext] ISR regen failed for " + key + ":", err))
    .finally(() => pendingRegenerations.delete(key));
  pendingRegenerations.set(key, promise);
}

async function renderToStringAsync(element) {
  const stream = await renderToReadableStream(element);
  await stream.allReady;
  return new Response(stream).text();
}

${pageImports.join("\n")}
${apiImports.join("\n")}

${appImportCode}
${docImportCode}

const pageRoutes = [
${pageRouteEntries.join(",\n")}
];

const apiRoutes = [
${apiRouteEntries.join(",\n")}
];

function matchRoute(url, routes) {
  const pathname = url.split("?")[0];
  let normalizedUrl = pathname === "/" ? "/" : pathname.replace(/\\/$/, "");
  // NOTE: Do NOT decodeURIComponent here. The pathname is already decoded at
  // the entry point. Decoding again would create a double-decode vector.
  for (const route of routes) {
    const params = matchPattern(normalizedUrl, route.pattern);
    if (params !== null) return { route, params };
  }
  return null;
}

function matchPattern(url, pattern) {
  const urlParts = url.split("/").filter(Boolean);
  const patternParts = pattern.split("/").filter(Boolean);
  const params = Object.create(null);
  for (let i = 0; i < patternParts.length; i++) {
    const pp = patternParts[i];
    if (pp.endsWith("+")) {
      const paramName = pp.slice(1, -1);
      const remaining = urlParts.slice(i);
      if (remaining.length === 0) return null;
      params[paramName] = remaining;
      return params;
    }
    if (pp.endsWith("*")) {
      const paramName = pp.slice(1, -1);
      params[paramName] = urlParts.slice(i);
      return params;
    }
    if (pp.startsWith(":")) {
      if (i >= urlParts.length) return null;
      params[pp.slice(1)] = urlParts[i];
      continue;
    }
    if (i >= urlParts.length || urlParts[i] !== pp) return null;
  }
  if (urlParts.length !== patternParts.length) return null;
  return params;
}

function parseQuery(url) {
  const qs = url.split("?")[1];
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

function patternToNextFormat(pattern) {
  return pattern
    .replace(/:([\\w]+)\\*/g, "[[...$1]]")
    .replace(/:([\\w]+)\\+/g, "[...$1]")
    .replace(/:([\\w]+)/g, "[$1]");
}

function collectAssetTags(manifest, moduleIds) {
  // Fall back to embedded manifest (set by vinext:cloudflare-build for Workers)
  const m = (manifest && Object.keys(manifest).length > 0)
    ? manifest
    : (typeof globalThis !== "undefined" && globalThis.__VINEXT_SSR_MANIFEST__) || null;
  const tags = [];
  const seen = new Set();

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
    tags.push('<link rel="modulepreload" href="/' + entry + '" />');
    tags.push('<script type="module" src="/' + entry + '" crossorigin></script>');
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
        tags.push('<link rel="stylesheet" href="/' + tf + '" />');
      } else if (tf.endsWith(".js")) {
        // Skip lazy chunks — they are behind dynamic import() boundaries
        // (React.lazy, next/dynamic) and should only be fetched on demand.
        if (lazySet && lazySet.has(tf)) continue;
        tags.push('<link rel="modulepreload" href="/' + tf + '" />');
        tags.push('<script type="module" src="/' + tf + '" crossorigin></script>');
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

// Lightweight req/res facade for getServerSideProps and API routes.
// Next.js pages expect ctx.req/ctx.res with Node-like shapes.
function createReqRes(request, url, query, body) {
  const headersObj = {};
  for (const [k, v] of request.headers) headersObj[k.toLowerCase()] = v;

  const req = {
    method: request.method,
    url: url,
    headers: headersObj,
    query: query,
    body: body,
    cookies: parseCookies(request.headers.get("cookie")),
  };

  let resStatusCode = 200;
  const resHeaders = {};
  // set-cookie needs array support (multiple Set-Cookie headers are common)
  const setCookieHeaders = [];
  let resBody = null;
  let ended = false;
  let resolveResponse;
  const responsePromise = new Promise(function(r) { resolveResponse = r; });

  const res = {
    get statusCode() { return resStatusCode; },
    set statusCode(code) { resStatusCode = code; },
    writeHead: function(code, headers) {
      resStatusCode = code;
      if (headers) {
        for (const [k, v] of Object.entries(headers)) {
          if (k.toLowerCase() === "set-cookie") {
            if (Array.isArray(v)) { for (const c of v) setCookieHeaders.push(c); }
            else { setCookieHeaders.push(v); }
          } else {
            resHeaders[k] = v;
          }
        }
      }
      return res;
    },
    setHeader: function(name, value) {
      if (name.toLowerCase() === "set-cookie") {
        if (Array.isArray(value)) { for (const c of value) setCookieHeaders.push(c); }
        else { setCookieHeaders.push(value); }
      } else {
        resHeaders[name.toLowerCase()] = value;
      }
      return res;
    },
    getHeader: function(name) {
      if (name.toLowerCase() === "set-cookie") return setCookieHeaders.length > 0 ? setCookieHeaders : undefined;
      return resHeaders[name.toLowerCase()];
    },
    end: function(data) {
      if (ended) return;
      ended = true;
      if (data !== undefined && data !== null) resBody = data;
      const h = new Headers(resHeaders);
      for (const c of setCookieHeaders) h.append("set-cookie", c);
      resolveResponse(new Response(resBody, { status: resStatusCode, headers: h }));
    },
    status: function(code) { resStatusCode = code; return res; },
    json: function(data) {
      resHeaders["content-type"] = "application/json";
      res.end(JSON.stringify(data));
    },
    send: function(data) {
      if (typeof data === "object" && data !== null) { res.json(data); }
      else { if (!resHeaders["content-type"]) resHeaders["content-type"] = "text/plain"; res.end(String(data)); }
    },
    redirect: function(statusOrUrl, url2) {
      if (typeof statusOrUrl === "string") { res.writeHead(307, { Location: statusOrUrl }); }
      else { res.writeHead(statusOrUrl, { Location: url2 }); }
      res.end();
    },
    getHeaders: function() {
      var h = Object.assign({}, resHeaders);
      if (setCookieHeaders.length > 0) h["set-cookie"] = setCookieHeaders;
      return h;
    },
    get headersSent() { return ended; },
  };

  return { req, res, responsePromise };
}

/**
 * Read request body as text with a size limit.
 * Throws if the body exceeds maxBytes. This prevents DoS via chunked
 * transfer encoding where Content-Length is absent or spoofed.
 */
async function readBodyWithLimit(request, maxBytes) {
  if (!request.body) return "";
  var reader = request.body.getReader();
  var decoder = new TextDecoder();
  var chunks = [];
  var totalSize = 0;
  for (;;) {
    var result = await reader.read();
    if (result.done) break;
    totalSize += result.value.byteLength;
    if (totalSize > maxBytes) {
      reader.cancel();
      throw new Error("Request body too large");
    }
    chunks.push(decoder.decode(result.value, { stream: true }));
  }
  chunks.push(decoder.decode());
  return chunks.join("");
}

export async function renderPage(request, url, manifest) {
  const localeInfo = extractLocale(url);
  const locale = localeInfo.locale;
  const routeUrl = localeInfo.url;
  const cookieHeader = request.headers.get("cookie") || "";

  // i18n redirect: check NEXT_LOCALE cookie first, then Accept-Language
  if (i18nConfig && !localeInfo.hadPrefix) {
    const cookieLocale = parseCookieLocaleFromHeader(cookieHeader);
    if (cookieLocale && cookieLocale !== i18nConfig.defaultLocale) {
      return new Response(null, { status: 307, headers: { Location: "/" + cookieLocale + routeUrl } });
    }
    if (!cookieLocale && i18nConfig.localeDetection !== false) {
      const detected = detectLocaleFromHeaders(request.headers);
      if (detected && detected !== i18nConfig.defaultLocale) {
        return new Response(null, { status: 307, headers: { Location: "/" + detected + routeUrl } });
      }
    }
  }

  const match = matchRoute(routeUrl, pageRoutes);
  if (!match) {
    return new Response("<!DOCTYPE html><html><body><h1>404 - Page not found</h1></body></html>",
      { status: 404, headers: { "Content-Type": "text/html" } });
  }

  const { route, params } = match;
  return runWithRouterState(() =>
    runWithHeadState(() =>
      _runWithCacheState(() =>
        runWithPrivateCache(() =>
          runWithFetchCache(async () => {
  try {
    if (typeof setSSRContext === "function") {
      setSSRContext({
        pathname: routeUrl.split("?")[0],
        query: { ...params, ...parseQuery(routeUrl) },
        asPath: routeUrl,
        locale: locale,
        locales: i18nConfig ? i18nConfig.locales : undefined,
        defaultLocale: i18nConfig ? i18nConfig.defaultLocale : undefined,
      });
    }

    if (i18nConfig) {
      globalThis.__VINEXT_LOCALE__ = locale;
      globalThis.__VINEXT_LOCALES__ = i18nConfig.locales;
      globalThis.__VINEXT_DEFAULT_LOCALE__ = i18nConfig.defaultLocale;
    }

    const pageModule = route.module;
    const PageComponent = pageModule.default;
    if (!PageComponent) {
      return new Response("Page has no default export", { status: 500 });
    }

    // Handle getStaticPaths for dynamic routes
    if (typeof pageModule.getStaticPaths === "function" && route.isDynamic) {
      const pathsResult = await pageModule.getStaticPaths({
        locales: i18nConfig ? i18nConfig.locales : [],
        defaultLocale: i18nConfig ? i18nConfig.defaultLocale : "",
      });
      const fallback = pathsResult && pathsResult.fallback !== undefined ? pathsResult.fallback : false;

      if (fallback === false) {
        const paths = pathsResult && pathsResult.paths ? pathsResult.paths : [];
        const isValidPath = paths.some(function(p) {
          return Object.entries(p.params).every(function(entry) {
            var key = entry[0], val = entry[1];
            var actual = params[key];
            if (Array.isArray(val)) {
              return Array.isArray(actual) && val.join("/") === actual.join("/");
            }
            return String(val) === String(actual);
          });
        });
        if (!isValidPath) {
          return new Response("<!DOCTYPE html><html><body><h1>404 - Page not found</h1></body></html>",
            { status: 404, headers: { "Content-Type": "text/html" } });
        }
      }
    }

    let pageProps = {};
    var gsspRes = null;
    if (typeof pageModule.getServerSideProps === "function") {
      const { req, res, responsePromise } = createReqRes(request, routeUrl, parseQuery(routeUrl), undefined);
      const ctx = {
        params, req, res,
        query: parseQuery(routeUrl),
        resolvedUrl: routeUrl,
        locale: locale,
        locales: i18nConfig ? i18nConfig.locales : undefined,
        defaultLocale: i18nConfig ? i18nConfig.defaultLocale : undefined,
      };
      const result = await pageModule.getServerSideProps(ctx);
      // If gSSP called res.end() directly (short-circuit), return that response.
      if (res.headersSent) {
        return await responsePromise;
      }
      if (result && result.props) pageProps = result.props;
      if (result && result.redirect) {
        var gsspStatus = result.redirect.statusCode != null ? result.redirect.statusCode : (result.redirect.permanent ? 308 : 307);
        return new Response(null, { status: gsspStatus, headers: { Location: sanitizeDestinationLocal(result.redirect.destination) } });
      }
      if (result && result.notFound) {
        return new Response("404", { status: 404 });
      }
      // Preserve the res object so headers/status/cookies set by gSSP
      // can be merged into the final HTML response.
      gsspRes = res;
    }
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

    let isrRevalidateSeconds = null;
    if (typeof pageModule.getStaticProps === "function") {
      const pathname = routeUrl.split("?")[0];
      const cacheKey = "pages:" + (pathname === "/" ? "/" : pathname.replace(/\\/$/, ""));
      const cached = await isrGet(cacheKey);

      if (cached && !cached.isStale && cached.value.value && cached.value.value.kind === "PAGES") {
        var _hitHeaders = {
          "Content-Type": "text/html", "X-Vinext-Cache": "HIT",
          "Cache-Control": "s-maxage=" + (cached.value.value.revalidate || 60) + ", stale-while-revalidate",
        };
        if (_fontLinkHeader) _hitHeaders["Link"] = _fontLinkHeader;
        return new Response(cached.value.value.html, { status: 200, headers: _hitHeaders });
      }

      if (cached && cached.isStale && cached.value.value && cached.value.value.kind === "PAGES") {
        triggerBackgroundRegeneration(cacheKey, async function() {
          const freshResult = await pageModule.getStaticProps({ params });
          if (freshResult && freshResult.props && typeof freshResult.revalidate === "number" && freshResult.revalidate > 0) {
            await isrSet(cacheKey, { kind: "PAGES", html: cached.value.value.html, pageData: freshResult.props, headers: undefined, status: undefined }, freshResult.revalidate);
          }
        });
        var _staleHeaders = {
          "Content-Type": "text/html", "X-Vinext-Cache": "STALE",
          "Cache-Control": "s-maxage=0, stale-while-revalidate",
        };
        if (_fontLinkHeader) _staleHeaders["Link"] = _fontLinkHeader;
        return new Response(cached.value.value.html, { status: 200, headers: _staleHeaders });
      }

      const ctx = {
        params,
        locale: locale,
        locales: i18nConfig ? i18nConfig.locales : undefined,
        defaultLocale: i18nConfig ? i18nConfig.defaultLocale : undefined,
      };
      const result = await pageModule.getStaticProps(ctx);
      if (result && result.props) pageProps = result.props;
      if (result && result.redirect) {
        var gspStatus = result.redirect.statusCode != null ? result.redirect.statusCode : (result.redirect.permanent ? 308 : 307);
        return new Response(null, { status: gspStatus, headers: { Location: sanitizeDestinationLocal(result.redirect.destination) } });
      }
      if (result && result.notFound) {
        return new Response("404", { status: 404 });
      }
      if (typeof result.revalidate === "number" && result.revalidate > 0) {
        isrRevalidateSeconds = result.revalidate;
      }
    }

    let element;
    if (AppComponent) {
      element = React.createElement(AppComponent, { Component: PageComponent, pageProps });
    } else {
      element = React.createElement(PageComponent, pageProps);
    }
    element = wrapWithRouterContext(element);

    if (typeof resetSSRHead === "function") resetSSRHead();
    if (typeof flushPreloads === "function") await flushPreloads();

    const ssrHeadHTML = typeof getSSRHeadHTML === "function" ? getSSRHeadHTML() : "";

    // Collect SSR font data (Google Font links, font preloads, font-face styles)
    var fontHeadHTML = "";
    function _escAttr(s) { return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;"); }
    try {
      var fontLinks = typeof _getSSRFontLinks === "function" ? _getSSRFontLinks() : [];
      for (var fl of fontLinks) { fontHeadHTML += '<link rel="stylesheet" href="' + _escAttr(fl) + '" />\\n  '; }
    } catch (e) { /* next/font/google not used */ }
    // Emit <link rel="preload"> for all font files (reuse _allFp collected earlier for Link header)
    for (var fp of _allFp) { fontHeadHTML += '<link rel="preload" href="' + _escAttr(fp.href) + '" as="font" type="' + _escAttr(fp.type) + '" crossorigin />\\n  '; }
    try {
      var allFontStyles = [];
      if (typeof _getSSRFontStylesGoogle === "function") allFontStyles.push(..._getSSRFontStylesGoogle());
      if (typeof _getSSRFontStylesLocal === "function") allFontStyles.push(..._getSSRFontStylesLocal());
      if (allFontStyles.length > 0) { fontHeadHTML += '<style data-vinext-fonts>' + allFontStyles.join("\\n") + '</style>\\n  '; }
    } catch (e) { /* font styles not available */ }

    const pageModuleIds = route.filePath ? [route.filePath] : [];
    const assetTags = collectAssetTags(manifest, pageModuleIds);
    const nextDataPayload = {
      props: { pageProps }, page: patternToNextFormat(route.pattern), query: params, isFallback: false,
    };
    if (i18nConfig) {
      nextDataPayload.locale = locale;
      nextDataPayload.locales = i18nConfig.locales;
      nextDataPayload.defaultLocale = i18nConfig.defaultLocale;
    }
    const localeGlobals = i18nConfig
      ? ";window.__VINEXT_LOCALE__=" + safeJsonStringify(locale) +
        ";window.__VINEXT_LOCALES__=" + safeJsonStringify(i18nConfig.locales) +
        ";window.__VINEXT_DEFAULT_LOCALE__=" + safeJsonStringify(i18nConfig.defaultLocale)
      : "";
    const nextDataScript = "<script>window.__NEXT_DATA__ = " + safeJsonStringify(nextDataPayload) + localeGlobals + "</script>";

    // Build the document shell with a placeholder for the streamed body
    var BODY_MARKER = "<!--VINEXT_STREAM_BODY-->";
    var shellHtml;
    if (DocumentComponent) {
      const docElement = React.createElement(DocumentComponent);
      shellHtml = await renderToStringAsync(docElement);
      shellHtml = shellHtml.replace("__NEXT_MAIN__", BODY_MARKER);
      if (ssrHeadHTML || assetTags || fontHeadHTML) {
        shellHtml = shellHtml.replace("</head>", "  " + fontHeadHTML + ssrHeadHTML + "\\n  " + assetTags + "\\n</head>");
      }
      shellHtml = shellHtml.replace("<!-- __NEXT_SCRIPTS__ -->", nextDataScript);
      if (!shellHtml.includes("__NEXT_DATA__")) {
        shellHtml = shellHtml.replace("</body>", "  " + nextDataScript + "\\n</body>");
      }
    } else {
      shellHtml = "<!DOCTYPE html>\\n<html>\\n<head>\\n  <meta charset=\\"utf-8\\" />\\n  <meta name=\\"viewport\\" content=\\"width=device-width, initial-scale=1\\" />\\n  " + fontHeadHTML + ssrHeadHTML + "\\n  " + assetTags + "\\n</head>\\n<body>\\n  <div id=\\"__next\\">" + BODY_MARKER + "</div>\\n  " + nextDataScript + "\\n</body>\\n</html>";
    }

    if (typeof setSSRContext === "function") setSSRContext(null);

    // Split the shell at the body marker
    var markerIdx = shellHtml.indexOf(BODY_MARKER);
    var shellPrefix = shellHtml.slice(0, markerIdx);
    var shellSuffix = shellHtml.slice(markerIdx + BODY_MARKER.length);

    // Start the React body stream — progressive SSR (no allReady wait)
    var bodyStream = await renderToReadableStream(element);
    var encoder = new TextEncoder();

    // Create a composite stream: prefix + body + suffix
    var compositeStream = new ReadableStream({
      async start(controller) {
        controller.enqueue(encoder.encode(shellPrefix));
        var reader = bodyStream.getReader();
        try {
          for (;;) {
            var chunk = await reader.read();
            if (chunk.done) break;
            controller.enqueue(chunk.value);
          }
        } finally {
          reader.releaseLock();
        }
        controller.enqueue(encoder.encode(shellSuffix));
        controller.close();
      }
    });

    // Cache the rendered HTML for ISR (needs the full string — re-render synchronously)
    if (isrRevalidateSeconds !== null && isrRevalidateSeconds > 0) {
      // Tee the stream so we can cache and respond simultaneously would be ideal,
      // but ISR responses are rare on first hit. Re-render to get complete HTML for cache.
      var isrElement;
      if (AppComponent) {
        isrElement = React.createElement(AppComponent, { Component: PageComponent, pageProps });
      } else {
        isrElement = React.createElement(PageComponent, pageProps);
      }
      isrElement = wrapWithRouterContext(isrElement);
      var isrHtml = await renderToStringAsync(isrElement);
      var fullHtml = shellPrefix + isrHtml + shellSuffix;
      var isrPathname = url.split("?")[0];
      var isrCacheKey = "pages:" + (isrPathname === "/" ? "/" : isrPathname.replace(/\\/$/, ""));
      await isrSet(isrCacheKey, { kind: "PAGES", html: fullHtml, pageData: pageProps, headers: undefined, status: undefined }, isrRevalidateSeconds);
    }

    // Merge headers/status/cookies set by getServerSideProps on the res object.
    // gSSP commonly uses res.setHeader("Set-Cookie", ...) or res.status(304).
    var finalStatus = 200;
    const responseHeaders = new Headers({ "Content-Type": "text/html" });
    if (gsspRes) {
      finalStatus = gsspRes.statusCode;
      var gsspHeaders = gsspRes.getHeaders();
      for (var hk of Object.keys(gsspHeaders)) {
        var hv = gsspHeaders[hk];
        if (hk === "set-cookie" && Array.isArray(hv)) {
          for (var sc of hv) responseHeaders.append("set-cookie", sc);
        } else if (hv != null) {
          responseHeaders.set(hk, String(hv));
        }
      }
      // Ensure Content-Type stays text/html (gSSP shouldn't override it for page renders)
      responseHeaders.set("Content-Type", "text/html");
    }
    if (isrRevalidateSeconds) {
      responseHeaders.set("Cache-Control", "s-maxage=" + isrRevalidateSeconds + ", stale-while-revalidate");
      responseHeaders.set("X-Vinext-Cache", "MISS");
    }
    // Set HTTP Link header for font preloading
    if (_fontLinkHeader) {
      responseHeaders.set("Link", _fontLinkHeader);
    }
    return new Response(compositeStream, { status: finalStatus, headers: responseHeaders });
  } catch (e) {
    console.error("[vinext] SSR error:", e);
    return new Response("Internal Server Error", { status: 500 });
  }
          }) // end runWithFetchCache
        ) // end runWithPrivateCache
      ) // end _runWithCacheState
    ) // end runWithHeadState
  ); // end runWithRouterState
}

export async function handleApiRoute(request, url) {
  const match = matchRoute(url, apiRoutes);
  if (!match) {
    return new Response("404 - API route not found", { status: 404 });
  }

  const { route, params } = match;
  const handler = route.module.default;
  if (typeof handler !== "function") {
    return new Response("API route does not export a default function", { status: 500 });
  }

  const query = { ...params };
  const qs = url.split("?")[1];
  if (qs) {
    for (const [k, v] of new URLSearchParams(qs)) {
      if (k in query) {
        // Multi-value: promote to array (Next.js returns string[] for duplicate keys)
        query[k] = Array.isArray(query[k]) ? query[k].concat(v) : [query[k], v];
      } else {
        query[k] = v;
      }
    }
  }

  // Parse request body (enforce 1MB limit to prevent memory exhaustion,
  // matching Next.js default bodyParser sizeLimit).
  // Check Content-Length first as a fast path, then enforce on the actual
  // stream to prevent bypasses via chunked transfer encoding.
  const contentLength = parseInt(request.headers.get("content-length") || "0", 10);
  if (contentLength > 1 * 1024 * 1024) {
    return new Response("Request body too large", { status: 413 });
  }
  let body;
  const ct = request.headers.get("content-type") || "";
  let rawBody;
  try { rawBody = await readBodyWithLimit(request, 1 * 1024 * 1024); }
  catch { return new Response("Request body too large", { status: 413 }); }
  if (!rawBody) {
    body = undefined;
  } else if (ct.includes("application/json")) {
    try { body = JSON.parse(rawBody); } catch { body = rawBody; }
  } else {
    body = rawBody;
  }

  const { req, res, responsePromise } = createReqRes(request, url, query, body);

  try {
    await handler(req, res);
    // If handler didn't call res.end(), end it now.
    // The end() method is idempotent — safe to call twice.
    res.end();
    return await responsePromise;
  } catch (e) {
    console.error("[vinext] API error:", e);
    return new Response("Internal Server Error", { status: 500 });
  }
}

${middlewareExportCode}
`;
}
