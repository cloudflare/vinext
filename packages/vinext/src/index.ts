import type { Plugin, ViteDevServer } from "vite";
import { parseAst } from "vite";
import { pagesRouter, apiRouter, invalidateRouteCache, matchRoute, type Route } from "./routing/pages-router.js";
import { appRouter, invalidateAppRouteCache } from "./routing/app-router.js";
import { createSSRHandler } from "./server/dev-server.js";
import { handleApiRoute } from "./server/api-handler.js";
import {
  generateRscEntry,
  generateSsrEntry,
  generateBrowserEntry,
} from "./server/app-dev-server.js";
import {
  loadNextConfig,
  resolveNextConfig,
  type ResolvedNextConfig,
  type NextRedirect,
  type NextRewrite,
} from "./config/next-config.js";

import { findMiddlewareFile, runMiddleware } from "./server/middleware.js";
import { findInstrumentationFile, runInstrumentation } from "./server/instrumentation.js";
import { scanMetadataFiles } from "./server/metadata-routes.js";
import { staticExportPages } from "./build/static-export.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import fs from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Detect Vite major version at runtime by resolving from cwd.
 * The plugin may be installed in a workspace root with Vite 7 but used
 * by a project that has Vite 8 — so we resolve from cwd, not from
 * the plugin's own location.
 */
function getViteMajorVersion(): number {
  try {
    const require = createRequire(path.join(process.cwd(), "package.json"));
    const vitePkg = require("vite/package.json");
    return parseInt(vitePkg.version, 10);
  } catch {
    return 7; // default to Vite 7
  }
}

// Virtual module IDs for Pages Router production build
const VIRTUAL_SERVER_ENTRY = "virtual:vinext-server-entry";
const RESOLVED_SERVER_ENTRY = "\0" + VIRTUAL_SERVER_ENTRY;
const VIRTUAL_CLIENT_ENTRY = "virtual:vinext-client-entry";
const RESOLVED_CLIENT_ENTRY = "\0" + VIRTUAL_CLIENT_ENTRY;

// Virtual module IDs for App Router entries
const VIRTUAL_RSC_ENTRY = "virtual:vinext-rsc-entry";
const RESOLVED_RSC_ENTRY = "\0" + VIRTUAL_RSC_ENTRY;
const VIRTUAL_APP_SSR_ENTRY = "virtual:vinext-app-ssr-entry";
const RESOLVED_APP_SSR_ENTRY = "\0" + VIRTUAL_APP_SSR_ENTRY;
const VIRTUAL_APP_BROWSER_ENTRY = "virtual:vinext-app-browser-entry";
const RESOLVED_APP_BROWSER_ENTRY = "\0" + VIRTUAL_APP_BROWSER_ENTRY;

export interface VinextOptions {
  /** Root directory of the Next.js app (default: Vite root) */
  appDir?: string;
}

export default function vinext(options: VinextOptions = {}): Plugin[] {
  let root: string;
  let pagesDir: string;
  let appDir: string;
  let hasAppDir = false;
  let hasPagesDir = false;
  let nextConfig: ResolvedNextConfig;
  let middlewarePath: string | null = null;
  let instrumentationPath: string | null = null;
  let hasCloudflarePlugin = false;

  // Resolve shim paths - works both from source (.ts) and built (.js)
  const shimsDir = path.resolve(__dirname, "shims");

  // Shim alias map — populated in config(), used by resolveId() for .js variants
  let nextShimMap: Record<string, string> = {};

  /**
   * Generate the virtual SSR server entry module.
   * This is the entry point for `vite build --ssr`.
   */
  async function generateServerEntry(): Promise<string> {
    const pageRoutes = await pagesRouter(pagesDir);
    const apiRoutes = await apiRouter(pagesDir);

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
    const hasApp = fs.existsSync(path.join(pagesDir, "_app.tsx")) || fs.existsSync(path.join(pagesDir, "_app.jsx")) || fs.existsSync(path.join(pagesDir, "_app.ts")) || fs.existsSync(path.join(pagesDir, "_app.js"));
    const hasDoc = fs.existsSync(path.join(pagesDir, "_document.tsx")) || fs.existsSync(path.join(pagesDir, "_document.jsx")) || fs.existsSync(path.join(pagesDir, "_document.ts")) || fs.existsSync(path.join(pagesDir, "_document.js"));

    // Use absolute paths for _app and _document too
    const appFileBase = path.join(pagesDir, "_app").replace(/\\/g, "/");
    const docFileBase = path.join(pagesDir, "_document").replace(/\\/g, "/");

    const appImportCode = hasApp
      ? `import { default as AppComponent } from ${JSON.stringify(appFileBase)};`
      : `const AppComponent = null;`;

    const docImportCode = hasDoc
      ? `import { default as DocumentComponent } from ${JSON.stringify(docFileBase)};`
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
    });

    // Generate middleware code if middleware.ts exists
    const middlewareImportCode = middlewarePath
      ? `import * as middlewareModule from ${JSON.stringify(middlewarePath.replace(/\\/g, "/"))};
import { NextRequest } from "next/server";`
      : "";

    // The matcher config is read from the middleware module at import time.
    // We inline the matching + execution logic so the prod server can call it.
    const middlewareExportCode = middlewarePath
      ? `
// --- Middleware support ---
function matchesMiddleware(pathname, matcher) {
  if (!matcher) {
    return !pathname.startsWith("/_next") && !pathname.startsWith("/api") && !pathname.includes(".") && pathname !== "/favicon.ico";
  }
  var patterns = [];
  if (typeof matcher === "string") { patterns.push(matcher); }
  else if (Array.isArray(matcher)) {
    for (var m of matcher) {
      if (typeof m === "string") patterns.push(m);
      else if (m && typeof m === "object" && "source" in m) patterns.push(m.source);
    }
  }
  return patterns.some(function(p) { return matchMiddlewarePattern(pathname, p); });
}

function matchMiddlewarePattern(pathname, pattern) {
  if (pattern.includes("(") || pattern.includes("\\\\")) {
    try { return new RegExp("^" + pattern + "$").test(pathname); } catch {}
  }
  var regexStr = pattern
    .replace(/\\./g, "\\\\.")
    .replace(/\\/:([\\w]+)\\*/g, "(?:/.*)?")
    .replace(/\\/:([\\w]+)\\+/g, "(?:/.+)")
    .replace(/:([\\w]+)/g, "([^/]+)");
  try { return new RegExp("^" + regexStr + "$").test(pathname); } catch { return pathname === pattern; }
}

export async function runMiddleware(request) {
  var middlewareFn = middlewareModule.default || middlewareModule.middleware;
  if (typeof middlewareFn !== "function") return { continue: true };

  var config = middlewareModule.config;
  var matcher = config && config.matcher;
  var url = new URL(request.url);

  if (!matchesMiddleware(url.pathname, matcher)) return { continue: true };

  var nextRequest = request instanceof NextRequest ? request : new NextRequest(request);
  var response;
  try { response = await middlewareFn(nextRequest); }
  catch (e) {
    console.error("[vinext] Middleware error:", e);
    return { continue: false, response: new Response("Middleware Error: " + (e && e.message ? e.message : String(e)), { status: 500 }) };
  }

  if (!response) return { continue: true };

  if (response.headers.get("x-middleware-next") === "1") {
    var rHeaders = new Headers();
    for (var [key, value] of response.headers) {
      if (key !== "x-middleware-next" && key !== "x-middleware-rewrite") rHeaders.set(key, value);
    }
    return { continue: true, responseHeaders: rHeaders };
  }

  if (response.status >= 300 && response.status < 400) {
    var location = response.headers.get("Location") || response.headers.get("location");
    if (location) return { continue: false, redirectUrl: location, redirectStatus: response.status };
  }

  var rewriteUrl = response.headers.get("x-middleware-rewrite");
  if (rewriteUrl) {
    var rwHeaders = new Headers();
    for (var [k, v] of response.headers) { if (k !== "x-middleware-rewrite") rwHeaders.set(k, v); }
    var rewritePath;
    try { var parsed = new URL(rewriteUrl, request.url); rewritePath = parsed.pathname + parsed.search; }
    catch { rewritePath = rewriteUrl; }
    return { continue: true, rewriteUrl: rewritePath, responseHeaders: rwHeaders };
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
import { setSSRContext } from "next/router";
import { getCacheHandler } from "next/cache";
import { withFetchCache } from "vinext/fetch-cache";
${middlewareImportCode}

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
  const normalizedUrl = pathname === "/" ? "/" : pathname.replace(/\\/$/, "");
  for (const route of routes) {
    const params = matchPattern(normalizedUrl, route.pattern);
    if (params !== null) return { route, params };
  }
  return null;
}

function matchPattern(url, pattern) {
  const urlParts = url.split("/").filter(Boolean);
  const patternParts = pattern.split("/").filter(Boolean);
  const params = {};
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
  for (const [k, v] of p) q[k] = v;
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
  // Inject the client entry script if embedded by vinext:cloudflare-build
  if (typeof globalThis !== "undefined" && globalThis.__VINEXT_CLIENT_ENTRY__) {
    const entry = globalThis.__VINEXT_CLIENT_ENTRY__;
    seen.add(entry);
    tags.push('<script type="module" src="/' + entry + '" crossorigin></script>');
  }
  if (m) {
    const idsToCheck = moduleIds && moduleIds.length > 0
      ? moduleIds
      : Object.keys(m);
    for (const id of idsToCheck) {
      const files = m[id];
      if (!files) continue;
      for (const file of files) {
        if (seen.has(file)) continue;
        seen.add(file);
        if (file.endsWith(".css")) {
          tags.push('<link rel="stylesheet" href="/' + file + '" />');
        } else if (file.endsWith(".js")) {
          tags.push('<script type="module" src="/' + file + '" crossorigin></script>');
        }
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
  const value = decodeURIComponent(match[1].trim());
  if (i18nConfig.locales.indexOf(value) !== -1) return value;
  return null;
}

function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  for (const part of cookieHeader.split(";")) {
    const [key, ...rest] = part.split("=");
    if (key) cookies[key.trim()] = rest.join("=").trim();
  }
  return cookies;
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
  };

  return { req, res, responsePromise };
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
  const cleanupFetchCache = withFetchCache();
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
    if (typeof pageModule.getServerSideProps === "function") {
      const { req, res } = createReqRes(request, routeUrl, parseQuery(routeUrl), undefined);
      const ctx = {
        params, req, res,
        query: parseQuery(routeUrl),
        resolvedUrl: routeUrl,
        locale: locale,
        locales: i18nConfig ? i18nConfig.locales : undefined,
        defaultLocale: i18nConfig ? i18nConfig.defaultLocale : undefined,
      };
      const result = await pageModule.getServerSideProps(ctx);
      if (result && result.props) pageProps = result.props;
      if (result && result.redirect) {
        var gsspStatus = result.redirect.statusCode != null ? result.redirect.statusCode : (result.redirect.permanent ? 308 : 307);
        return new Response(null, { status: gsspStatus, headers: { Location: result.redirect.destination } });
      }
      if (result && result.notFound) {
        return new Response("404", { status: 404 });
      }
    }
    let isrRevalidateSeconds = null;
    if (typeof pageModule.getStaticProps === "function") {
      const pathname = routeUrl.split("?")[0];
      const cacheKey = "pages:" + (pathname === "/" ? "/" : pathname.replace(/\\/$/, ""));
      const cached = await isrGet(cacheKey);

      if (cached && !cached.isStale && cached.value.value && cached.value.value.kind === "PAGES") {
        return new Response(cached.value.value.html, { status: 200, headers: {
          "Content-Type": "text/html", "X-Vinext-Cache": "HIT",
          "Cache-Control": "s-maxage=" + (cached.value.value.revalidate || 60) + ", stale-while-revalidate",
        }});
      }

      if (cached && cached.isStale && cached.value.value && cached.value.value.kind === "PAGES") {
        triggerBackgroundRegeneration(cacheKey, async function() {
          const freshResult = await pageModule.getStaticProps({ params });
          if (freshResult && freshResult.props && typeof freshResult.revalidate === "number" && freshResult.revalidate > 0) {
            await isrSet(cacheKey, { kind: "PAGES", html: cached.value.value.html, pageData: freshResult.props, headers: undefined, status: undefined }, freshResult.revalidate);
          }
        });
        return new Response(cached.value.value.html, { status: 200, headers: {
          "Content-Type": "text/html", "X-Vinext-Cache": "STALE",
          "Cache-Control": "s-maxage=0, stale-while-revalidate",
        }});
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
        return new Response(null, { status: gspStatus, headers: { Location: result.redirect.destination } });
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

    if (typeof resetSSRHead === "function") resetSSRHead();
    if (typeof flushPreloads === "function") await flushPreloads();

    const ssrHeadHTML = typeof getSSRHeadHTML === "function" ? getSSRHeadHTML() : "";
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
      ? ";window.__VINEXT_LOCALE__=" + JSON.stringify(locale) +
        ";window.__VINEXT_LOCALES__=" + JSON.stringify(i18nConfig.locales) +
        ";window.__VINEXT_DEFAULT_LOCALE__=" + JSON.stringify(i18nConfig.defaultLocale)
      : "";
    const nextDataScript = "<script>window.__NEXT_DATA__ = " + JSON.stringify(nextDataPayload) + localeGlobals + "</script>";

    // Build the document shell with a placeholder for the streamed body
    var BODY_MARKER = "<!--VINEXT_STREAM_BODY-->";
    var shellHtml;
    if (DocumentComponent) {
      const docElement = React.createElement(DocumentComponent);
      shellHtml = await renderToStringAsync(docElement);
      shellHtml = shellHtml.replace("__NEXT_MAIN__", BODY_MARKER);
      if (ssrHeadHTML || assetTags) {
        shellHtml = shellHtml.replace("</head>", "  " + ssrHeadHTML + "\\n  " + assetTags + "\\n</head>");
      }
      shellHtml = shellHtml.replace("<!-- __NEXT_SCRIPTS__ -->", nextDataScript);
      if (!shellHtml.includes("__NEXT_DATA__")) {
        shellHtml = shellHtml.replace("</body>", "  " + nextDataScript + "\\n</body>");
      }
    } else {
      shellHtml = "<!DOCTYPE html>\\n<html>\\n<head>\\n  <meta charset=\\"utf-8\\" />\\n  <meta name=\\"viewport\\" content=\\"width=device-width, initial-scale=1\\" />\\n  " + ssrHeadHTML + "\\n  " + assetTags + "\\n</head>\\n<body>\\n  <div id=\\"__next\\">" + BODY_MARKER + "</div>\\n  " + nextDataScript + "\\n</body>\\n</html>";
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
      var isrHtml = await renderToStringAsync(isrElement);
      var fullHtml = shellPrefix + isrHtml + shellSuffix;
      var isrPathname = url.split("?")[0];
      var isrCacheKey = "pages:" + (isrPathname === "/" ? "/" : isrPathname.replace(/\\/$/, ""));
      await isrSet(isrCacheKey, { kind: "PAGES", html: fullHtml, pageData: pageProps, headers: undefined, status: undefined }, isrRevalidateSeconds);
    }

    const responseHeaders = { "Content-Type": "text/html" };
    if (isrRevalidateSeconds) {
      responseHeaders["Cache-Control"] = "s-maxage=" + isrRevalidateSeconds + ", stale-while-revalidate";
      responseHeaders["X-Vinext-Cache"] = "MISS";
    }
    return new Response(compositeStream, { status: 200, headers: responseHeaders });
  } catch (e) {
    console.error("[vinext] SSR error:", e);
    return new Response("Internal Server Error: " + (e && e.message ? e.message : String(e)), { status: 500 });
  } finally {
    cleanupFetchCache();
  }
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
  if (qs) { for (const [k, v] of new URLSearchParams(qs)) query[k] = v; }

  // Parse request body
  let body;
  const ct = request.headers.get("content-type") || "";
  const rawBody = await request.text();
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
    return new Response("API Error: " + (e && e.message ? e.message : String(e)), { status: 500 });
  }
}

${middlewareExportCode}
`;
  }

  /**
   * Generate the virtual client hydration entry module.
   * This is the entry point for `vite build` (client bundle).
   *
   * It maps route patterns to dynamic imports of page modules so Vite
   * code-splits each page into its own chunk. At runtime it reads
   * __NEXT_DATA__ to determine which page to hydrate.
   */
  async function generateClientEntry(): Promise<string> {
    const pageRoutes = await pagesRouter(pagesDir);

    const hasApp = fs.existsSync(path.join(pagesDir, "_app.tsx")) || fs.existsSync(path.join(pagesDir, "_app.jsx")) || fs.existsSync(path.join(pagesDir, "_app.ts")) || fs.existsSync(path.join(pagesDir, "_app.js"));

    // Build a map of route pattern -> dynamic import
    const loaderEntries = pageRoutes.map((r: Route) => {
      const absPath = r.filePath.replace(/\\/g, "/");
      return `  ${JSON.stringify(r.pattern)}: () => import(${JSON.stringify(absPath)})`;
    });

    const appFileBase = path.join(pagesDir, "_app").replace(/\\/g, "/");

    return `
import React from "react";
import { hydrateRoot } from "react-dom/client";

const pageLoaders = {
${loaderEntries.join(",\n")}
};

async function hydrate() {
  const nextData = window.__NEXT_DATA__;
  if (!nextData) {
    console.error("[vinext] No __NEXT_DATA__ found");
    return;
  }

  const { pageProps } = nextData.props;
  const loader = pageLoaders[nextData.page];
  if (!loader) {
    console.error("[vinext] No page loader for route:", nextData.page);
    return;
  }

  const pageModule = await loader();
  const PageComponent = pageModule.default;
  if (!PageComponent) {
    console.error("[vinext] Page module has no default export");
    return;
  }

  let element;
  ${hasApp ? `
  try {
    const appModule = await import(${JSON.stringify(appFileBase)});
    const AppComponent = appModule.default;
    window.__VINEXT_APP__ = AppComponent;
    element = React.createElement(AppComponent, { Component: PageComponent, pageProps });
  } catch {
    element = React.createElement(PageComponent, pageProps);
  }
  ` : `
  element = React.createElement(PageComponent, pageProps);
  `}

  const container = document.getElementById("__next");
  if (!container) {
    console.error("[vinext] No #__next element found");
    return;
  }

  const root = hydrateRoot(container, element);
  window.__VINEXT_ROOT__ = root;
}

hydrate();
`;
  }

  return [
    {
      name: "vinext:config",
      enforce: "pre",

      async config(config) {
        root = config.root ?? process.cwd();
        const baseDir = options.appDir ?? root;
        pagesDir = path.join(baseDir, "pages");
        appDir = path.join(baseDir, "app");
        hasPagesDir = fs.existsSync(pagesDir);
        hasAppDir = fs.existsSync(appDir);
        middlewarePath = findMiddlewareFile(baseDir);
        instrumentationPath = findInstrumentationFile(baseDir);

        // Load next.config.js if present
        const rawConfig = await loadNextConfig(baseDir);
        nextConfig = await resolveNextConfig(rawConfig);

        // Merge env from next.config.js with NEXT_PUBLIC_* env vars
        const defines = getNextPublicEnvDefines();
        for (const [key, value] of Object.entries(nextConfig.env)) {
          defines[`process.env.${key}`] = JSON.stringify(value);
        }
        // Expose basePath to client-side code
        defines["process.env.__NEXT_ROUTER_BASEPATH"] = JSON.stringify(
          nextConfig.basePath,
        );

        // Build the shim alias map — used by both resolve.alias and resolveId
        // (resolveId handles .js extension variants for libraries like nuqs)
        nextShimMap = {
          "next/link": path.join(shimsDir, "link"),
          "next/head": path.join(shimsDir, "head"),
          "next/router": path.join(shimsDir, "router"),
          "next/image": path.join(shimsDir, "image"),
          "next/legacy/image": path.join(shimsDir, "legacy-image"),
          "next/dynamic": path.join(shimsDir, "dynamic"),
          "next/app": path.join(shimsDir, "app"),
          "next/document": path.join(shimsDir, "document"),
          "next/config": path.join(shimsDir, "config"),
          "next/script": path.join(shimsDir, "script"),
          "next/server": path.join(shimsDir, "server"),
          "next/navigation": path.join(shimsDir, "navigation"),
          "next/headers": path.join(shimsDir, "headers"),
          "next/font/google": path.join(shimsDir, "font-google"),
          "next/font/local": path.join(shimsDir, "font-local"),
          "next/cache": path.join(shimsDir, "cache"),
          "next/form": path.join(shimsDir, "form"),
          "next/og": path.join(shimsDir, "og"),
          "next/web-vitals": path.join(shimsDir, "web-vitals"),
          "next/amp": path.join(shimsDir, "amp"),
          "next/error": path.join(shimsDir, "error"),
          "next/constants": path.join(shimsDir, "constants"),
          // Internal next/dist/* paths used by popular libraries
          // (next-intl, @clerk/nextjs, @sentry/nextjs, next-nprogress-bar, etc.)
          "next/dist/shared/lib/app-router-context.shared-runtime": path.join(shimsDir, "internal", "app-router-context"),
          "next/dist/shared/lib/app-router-context": path.join(shimsDir, "internal", "app-router-context"),
          "next/dist/shared/lib/router-context.shared-runtime": path.join(shimsDir, "internal", "router-context"),
          "next/dist/shared/lib/utils": path.join(shimsDir, "internal", "utils"),
          "next/dist/server/api-utils": path.join(shimsDir, "internal", "api-utils"),
          "next/dist/server/web/spec-extension/cookies": path.join(shimsDir, "internal", "cookies"),
          "next/dist/compiled/@edge-runtime/cookies": path.join(shimsDir, "internal", "cookies"),
          "next/dist/server/app-render/work-unit-async-storage.external": path.join(shimsDir, "internal", "work-unit-async-storage"),
          "next/dist/client/components/work-unit-async-storage.external": path.join(shimsDir, "internal", "work-unit-async-storage"),
          "next/dist/client/components/request-async-storage.external": path.join(shimsDir, "internal", "work-unit-async-storage"),
          "next/dist/client/components/request-async-storage": path.join(shimsDir, "internal", "work-unit-async-storage"),
          // Re-export public modules for internal path imports
          "next/dist/client/components/navigation": path.join(shimsDir, "navigation"),
          "next/dist/server/config-shared": path.join(shimsDir, "internal", "utils"),
          // server-only / client-only marker packages
          "server-only": path.join(shimsDir, "server-only"),
          "client-only": path.join(shimsDir, "client-only"),
          "vinext/error-boundary": path.join(shimsDir, "error-boundary"),
          "vinext/layout-segment-context": path.join(shimsDir, "layout-segment-context"),
          "vinext/metadata": path.join(shimsDir, "metadata"),
          "vinext/fetch-cache": path.join(shimsDir, "fetch-cache"),
          "vinext/cache-runtime": path.join(shimsDir, "cache-runtime"),
          "vinext/instrumentation": path.resolve(__dirname, "server", "instrumentation"),
        };

        // Detect if Cloudflare's vite plugin is present — if so, skip
        // SSR externals (Workers bundle everything, can't have Node.js externals).
        const pluginsFlat: any[] = [];
        function flattenPlugins(arr: any[]) {
          for (const p of arr) {
            if (Array.isArray(p)) flattenPlugins(p);
            else if (p) pluginsFlat.push(p);
          }
        }
        flattenPlugins(config.plugins as any[] ?? []);
        hasCloudflarePlugin = pluginsFlat.some(
          (p: any) => p && typeof p === "object" && typeof p.name === "string" && (
            p.name === "vite-plugin-cloudflare" || p.name.startsWith("vite-plugin-cloudflare:")
          ),
        );

        const viteConfig: Record<string, any> = {
          // Disable Vite's default HTML serving - we handle all routing
          appType: "custom",
          // Externalize React packages from SSR transform — they are CJS and
          // must be loaded natively by Node, not through Vite's ESM evaluator.
          // Skip when targeting Cloudflare Workers (they bundle everything).
          ...(hasCloudflarePlugin ? {} : {
            ssr: {
              external: ["react", "react-dom", "react-dom/server"],
            },
          }),
          resolve: {
            alias: nextShimMap,
          },
          // Enable JSX in .tsx/.jsx files
          // Vite 7 uses `esbuild` for transforms, Vite 8+ uses `oxc`
          ...(getViteMajorVersion() >= 8
            ? { oxc: { jsx: "automatic" } }
            : { esbuild: { jsx: "automatic" } }),
          // Define env vars for client bundle
          define: defines,
          // Set base path if configured
          ...(nextConfig.basePath ? { base: nextConfig.basePath + "/" } : {}),
        };

        // If app/ directory exists, configure RSC environments
        if (hasAppDir) {
          viteConfig.environments = {
            rsc: {
              ...(hasCloudflarePlugin ? {} : {
                resolve: {
                  // Externalize native/heavy packages so the RSC environment
                  // loads them natively via Node rather than through Vite's
                  // ESM module evaluator (which can't handle native addons).
                  // Note: Do NOT externalize react/react-dom here — they must
                  // be bundled with the "react-server" condition for RSC.
                  // Skip when targeting Cloudflare Workers.
                  external: [
                    "satori",
                    "@resvg/resvg-js",
                    "yoga-wasm-web",
                  ],
                },
              }),
              build: {
                rollupOptions: {
                  input: { index: VIRTUAL_RSC_ENTRY },
                },
              },
            },
            ssr: {
              build: {
                rollupOptions: {
                  input: { index: VIRTUAL_APP_SSR_ENTRY },
                },
              },
            },
            client: {
              build: {
                rollupOptions: {
                  input: { index: VIRTUAL_APP_BROWSER_ENTRY },
                },
              },
            },
          };
        } else if (hasCloudflarePlugin) {
          // Pages Router on Cloudflare Workers: add a client environment
          // so the multi-environment build produces client JS bundles
          // alongside the worker. Without this, only the worker is built
          // and there's no client-side hydration.
          viteConfig.environments = {
            client: {
              build: {
                manifest: true,
                ssrManifest: true,
                rollupOptions: {
                  input: { index: VIRTUAL_CLIENT_ENTRY },
                },
              },
            },
          };
        }

        return viteConfig;
      },

      resolveId(id) {
        // Strip \0 prefix if present — @vitejs/plugin-rsc's generated
        // browser entry imports our virtual module using the already-resolved
        // ID (with \0 prefix). We need to re-resolve it so the client
        // environment's import-analysis can find it.
        const cleanId = id.startsWith("\0") ? id.slice(1) : id;

        // Handle next/* imports with .js extension (e.g. "next/navigation.js")
        // Libraries like nuqs import "next/navigation.js" which doesn't match
        // our resolve.alias for "next/navigation". Strip the .js and resolve
        // through our shim map, appending .js to the resolved path.
        if (cleanId.startsWith("next/") && cleanId.endsWith(".js")) {
          const withoutExt = cleanId.slice(0, -3);
          if (nextShimMap[withoutExt]) {
            const shimPath = nextShimMap[withoutExt];
            // Alias values don't include .js — append it for resolveId
            return shimPath.endsWith(".js") ? shimPath : shimPath + ".js";
          }
        }

        // Pages Router virtual modules
        if (cleanId === VIRTUAL_SERVER_ENTRY) return RESOLVED_SERVER_ENTRY;
        if (cleanId === VIRTUAL_CLIENT_ENTRY) return RESOLVED_CLIENT_ENTRY;
        if (cleanId.endsWith("/" + VIRTUAL_SERVER_ENTRY) || cleanId.endsWith("\\" + VIRTUAL_SERVER_ENTRY)) {
          return RESOLVED_SERVER_ENTRY;
        }
        if (cleanId.endsWith("/" + VIRTUAL_CLIENT_ENTRY) || cleanId.endsWith("\\" + VIRTUAL_CLIENT_ENTRY)) {
          return RESOLVED_CLIENT_ENTRY;
        }
        // App Router virtual modules
        if (cleanId === VIRTUAL_RSC_ENTRY) return RESOLVED_RSC_ENTRY;
        if (cleanId === VIRTUAL_APP_SSR_ENTRY) return RESOLVED_APP_SSR_ENTRY;
        if (cleanId === VIRTUAL_APP_BROWSER_ENTRY) return RESOLVED_APP_BROWSER_ENTRY;
        if (cleanId.endsWith("/" + VIRTUAL_RSC_ENTRY) || cleanId.endsWith("\\" + VIRTUAL_RSC_ENTRY)) {
          return RESOLVED_RSC_ENTRY;
        }
        if (cleanId.endsWith("/" + VIRTUAL_APP_SSR_ENTRY) || cleanId.endsWith("\\" + VIRTUAL_APP_SSR_ENTRY)) {
          return RESOLVED_APP_SSR_ENTRY;
        }
        if (cleanId.endsWith("/" + VIRTUAL_APP_BROWSER_ENTRY) || cleanId.endsWith("\\" + VIRTUAL_APP_BROWSER_ENTRY)) {
          return RESOLVED_APP_BROWSER_ENTRY;
        }
      },

      async load(id) {
        // Pages Router virtual modules
        if (id === RESOLVED_SERVER_ENTRY) {
          return await generateServerEntry();
        }
        if (id === RESOLVED_CLIENT_ENTRY) {
          return await generateClientEntry();
        }
        // App Router virtual modules
        if (id === RESOLVED_RSC_ENTRY && hasAppDir) {
          const routes = await appRouter(appDir);
          const metaRoutes = scanMetadataFiles(appDir);
          // Check for global-error.tsx at app root
          const globalErrorPath = findFileWithExts(appDir, "global-error");
          return generateRscEntry(appDir, routes, middlewarePath, metaRoutes, globalErrorPath, nextConfig?.basePath, nextConfig?.trailingSlash, {
            redirects: nextConfig?.redirects,
            rewrites: nextConfig?.rewrites,
            headers: nextConfig?.headers,
          });
        }
        if (id === RESOLVED_APP_SSR_ENTRY && hasAppDir) {
          return generateSsrEntry();
        }
        if (id === RESOLVED_APP_BROWSER_ENTRY && hasAppDir) {
          return generateBrowserEntry();
        }
      },
    },
    {
      name: "vinext:pages-router",

      configureServer(server: ViteDevServer) {
        // Watch pages directory for file additions/removals to invalidate route cache.
        const pageExtensions = /\.(tsx?|jsx?)$/;
        server.watcher.on("add", (filePath: string) => {
          if (hasPagesDir && filePath.startsWith(pagesDir) && pageExtensions.test(filePath)) {
            invalidateRouteCache(pagesDir);
          }
          if (hasAppDir && filePath.startsWith(appDir) && pageExtensions.test(filePath)) {
            invalidateAppRouteCache();
          }
        });
        server.watcher.on("unlink", (filePath: string) => {
          if (hasPagesDir && filePath.startsWith(pagesDir) && pageExtensions.test(filePath)) {
            invalidateRouteCache(pagesDir);
          }
          if (hasAppDir && filePath.startsWith(appDir) && pageExtensions.test(filePath)) {
            invalidateAppRouteCache();
          }
        });

        // Run instrumentation.ts register() if present (once at server startup)
        if (instrumentationPath) {
          runInstrumentation(server, instrumentationPath).catch((err) => {
            console.error("[vinext] Instrumentation error:", err);
          });
        }

        // Return a function to register middleware AFTER Vite's built-in middleware
        return () => {
          server.middlewares.use(async (req: any, res: any, next: any) => {
            try {
              let url: string = req.url ?? "/";

              // If no pages directory, skip this middleware entirely
              // (app router is handled by @vitejs/plugin-rsc's built-in middleware)
              if (!hasPagesDir) return next();

              // Skip Vite internal requests and static files
              if (
                url.startsWith("/@") ||
                url.startsWith("/__vite") ||
                url.startsWith("/node_modules")
              ) {
                return next();
              }

              // Skip .rsc requests — those are for the App Router RSC handler
              if (url.split("?")[0].endsWith(".rsc")) {
                return next();
              }

              // Vite's built-in middleware may rewrite "/" to "/index.html".
              // Normalize it back so our router can match correctly.
              const rawPathname = url.split("?")[0];
              if (rawPathname.endsWith("/index.html")) {
                url = url.replace("/index.html", "/");
              } else if (rawPathname.endsWith(".html")) {
                // Strip .html extensions (e.g. "/about.html" -> "/about")
                url = url.replace(/\.html(?=\?|$)/, "");
              }

              // Skip requests for files with extensions (static assets)
              let pathname = url.split("?")[0];
              if (pathname.includes(".") && !pathname.endsWith(".html")) {
                return next();
              }

              // Strip basePath prefix from URL for route matching.
              // All internal routing uses basePath-free paths.
              //
              // NOTE: When basePath is set, we also set Vite's `base` config to
              // `basePath + "/"`. Vite's connect middleware stack strips the base
              // prefix from req.url before passing it to our middleware, so the
              // URL will already lack the basePath prefix. We still attempt to
              // strip it (for robustness) but don't reject paths that don't start
              // with basePath — Vite has already done the filtering.
              const bp = nextConfig?.basePath ?? "";
              if (bp && pathname.startsWith(bp)) {
                const stripped = pathname.slice(bp.length) || "/";
                const qs = url.includes("?") ? url.slice(url.indexOf("?")) : "";
                url = stripped + qs;
                pathname = stripped;
              }

              // Normalize trailing slash based on next.config.js trailingSlash setting.
              // Redirect to the canonical form if needed.
              if (nextConfig && pathname !== "/" && !pathname.startsWith("/api")) {
                const hasTrailing = pathname.endsWith("/");
                if (nextConfig.trailingSlash && !hasTrailing) {
                  // trailingSlash: true — redirect /about → /about/
                  const qs = url.includes("?") ? url.slice(url.indexOf("?")) : "";
                  const dest = bp + pathname + "/" + qs;
                  res.writeHead(308, { Location: dest });
                  res.end();
                  return;
                } else if (!nextConfig.trailingSlash && hasTrailing) {
                  // trailingSlash: false (default) — redirect /about/ → /about
                  const qs = url.includes("?") ? url.slice(url.indexOf("?")) : "";
                  const dest = bp + pathname.replace(/\/+$/, "") + qs;
                  res.writeHead(308, { Location: dest });
                  res.end();
                  return;
                }
              }

              // Run middleware.ts if present
              if (middlewarePath) {
                const origin = `${req.headers["x-forwarded-proto"] || "http"}://${req.headers.host || "localhost"}`;
                const middlewareRequest = new Request(new URL(url, origin), {
                  method: req.method,
                  headers: Object.fromEntries(
                    Object.entries(req.headers)
                      .filter(([, v]) => v !== undefined)
                      .map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : String(v)])
                  ),
                });
                const result = await runMiddleware(server, middlewarePath, middlewareRequest);

                if (!result.continue) {
                  if (result.redirectUrl) {
                    res.writeHead(result.redirectStatus ?? 307, {
                      Location: result.redirectUrl,
                    });
                    res.end();
                    return;
                  }
                  if (result.response) {
                    res.statusCode = result.response.status;
                    for (const [key, value] of result.response.headers) {
                      res.setHeader(key, value);
                    }
                    const body = await result.response.text();
                    res.end(body);
                    return;
                  }
                }

                // Apply middleware response headers
                if (result.responseHeaders) {
                  for (const [key, value] of result.responseHeaders) {
                    res.setHeader(key, value);
                  }
                }

                // Apply middleware rewrite
                if (result.rewriteUrl) {
                  url = result.rewriteUrl;
                }
              }

              // Apply custom headers from next.config.js
              if (nextConfig?.headers.length) {
                applyHeaders(pathname, res, nextConfig.headers);
              }

              // Apply redirects from next.config.js
              if (nextConfig?.redirects.length) {
                const redirected = applyRedirects(
                  pathname,
                  res,
                  nextConfig.redirects,
                );
                if (redirected) return;
              }

              // Apply rewrites from next.config.js (beforeFiles)
              let resolvedUrl = url;
              if (nextConfig?.rewrites.beforeFiles.length) {
                resolvedUrl =
                  applyRewrites(pathname, nextConfig.rewrites.beforeFiles) ??
                  url;
              }

              // Handle API routes first (pages/api/*)
              const resolvedPathname = resolvedUrl.split("?")[0];
              if (
                resolvedPathname.startsWith("/api/") ||
                resolvedPathname === "/api"
              ) {
                const apiRoutes = await apiRouter(pagesDir);
                const handled = await handleApiRoute(
                  server,
                  req,
                  res,
                  resolvedUrl,
                  apiRoutes,
                );
                if (handled) return;
                // No API route matched — fall through to 404
                res.statusCode = 404;
                res.end("404 - API route not found");
                return;
              }

              const routes = await pagesRouter(pagesDir);

              // Apply afterFiles rewrites — these run after initial route matching
              // If beforeFiles already rewrote the URL, afterFiles still run on the
              // *resolved* pathname. Next.js applies these when route matching succeeds
              // but allows overriding with rewrites.
              if (nextConfig?.rewrites.afterFiles.length) {
                const afterRewrite = applyRewrites(
                  resolvedUrl.split("?")[0],
                  nextConfig.rewrites.afterFiles,
                );
                if (afterRewrite) resolvedUrl = afterRewrite;
              }

              const handler = createSSRHandler(server, routes, pagesDir, nextConfig?.i18n);

              // Try rendering the resolved URL
              const match = matchRoute(resolvedUrl.split("?")[0], routes);
              if (match) {
                await handler(req, res, resolvedUrl);
                return;
              }

              // No route matched — try fallback rewrites
              if (nextConfig?.rewrites.fallback.length) {
                const fallbackRewrite = applyRewrites(
                  resolvedUrl.split("?")[0],
                  nextConfig.rewrites.fallback,
                );
                if (fallbackRewrite) {
                  await handler(req, res, fallbackRewrite);
                  return;
                }
              }

              // No fallback matched — render as-is (will hit 404 handler)
              await handler(req, res, resolvedUrl);
            } catch (e) {
              next(e);
            }
          });
        };
      },
    },
    // Local image import transform:
    // When a source file imports a local image (e.g., `import hero from './hero.jpg'`),
    // this plugin transforms the default import to a StaticImageData object with
    // { src, width, height } so the next/image shim can set correct dimensions
    // on <img> tags, preventing CLS.
    //
    // Vite's default image import returns a URL string. We intercept this by
    // adding a `?vinext-meta` suffix: the original import gets the URL from Vite,
    // and we resolve the `?vinext-meta` virtual module to provide dimensions.
    {
      name: "vinext:image-imports",
      enforce: "pre",

      // Cache of image dimensions to avoid re-reading files
      _dimCache: new Map<string, { width: number; height: number }>(),

      resolveId(source, _importer) {
        if (!source.endsWith("?vinext-meta")) return null;
        // Resolve the real image path from the importer
        const realPath = source.replace("?vinext-meta", "");
        return `\0vinext-image-meta:${realPath}`;
      },

      async load(id) {
        if (!id.startsWith("\0vinext-image-meta:")) return null;
        const imagePath = id.replace("\0vinext-image-meta:", "");

        // Read from cache first
        const cache = (this as any)._dimCache as Map<string, { width: number; height: number }>;
        let dims = cache.get(imagePath);
        if (!dims) {
          try {
            const { imageSize } = await import("image-size");
            const buffer = fs.readFileSync(imagePath);
            const result = imageSize(buffer);
            dims = { width: result.width ?? 0, height: result.height ?? 0 };
            cache.set(imagePath, dims);
          } catch {
            dims = { width: 0, height: 0 };
          }
        }

        return `export default ${JSON.stringify(dims)};`;
      },

      async transform(code, id) {
        // Only transform source files that import images
        if (id.includes("node_modules")) return null;
        if (id.startsWith("\0")) return null;
        if (!id.match(/\.(tsx?|jsx?|mjs)$/)) return null;

        // Quick check: does this file import an image?
        const imageImportRe = /import\s+(\w+)\s+from\s+['"]([^'"]+\.(png|jpe?g|gif|webp|avif|svg|ico|bmp|tiff?))['"];?/g;
        if (!imageImportRe.test(code)) return null;

        // Reset regex lastIndex
        imageImportRe.lastIndex = 0;

        const { default: MagicString } = await import("magic-string");
        const s = new MagicString(code);
        let hasChanges = false;

        let match;
        while ((match = imageImportRe.exec(code)) !== null) {
          const [fullMatch, varName, importPath] = match;
          const matchStart = match.index;
          const matchEnd = matchStart + fullMatch.length;

          // Resolve the absolute path of the image
          const dir = path.dirname(id);
          const absImagePath = path.resolve(dir, importPath);

          if (!fs.existsSync(absImagePath)) continue;

          // Replace the single import with two:
          // 1. Original import (Vite gives us the URL string)
          // 2. Meta import (we provide { width, height })
          // Combined into a StaticImageData object
          const urlVar = `__vinext_img_url_${varName}`;
          const metaVar = `__vinext_img_meta_${varName}`;
          const replacement =
            `import ${urlVar} from ${JSON.stringify(importPath)};\n` +
            `import ${metaVar} from ${JSON.stringify(absImagePath + "?vinext-meta")};\n` +
            `const ${varName} = { src: ${urlVar}, width: ${metaVar}.width, height: ${metaVar}.height };`;

          s.overwrite(matchStart, matchEnd, replacement);
          hasChanges = true;
        }

        if (!hasChanges) return null;

        return {
          code: s.toString(),
          map: s.generateMap({ hires: "boundary" }),
        };
      },
    } as Plugin & { _dimCache: Map<string, { width: number; height: number }> },
    // "use cache" directive transform:
    // Detects "use cache" at file-level or function-level and wraps the
    // exports/functions with registerCachedFunction() from vinext/cache-runtime.
    // Runs without enforce so it executes after JSX transform (parseAst needs plain JS).
    {
      name: "vinext:use-cache",

      async transform(code, id) {
        // Only process app source files, not node_modules or virtual modules
        if (id.includes("node_modules")) return null;
        if (id.startsWith("\0")) return null;
        if (!id.match(/\.(tsx?|jsx?|mjs)$/)) return null;
        if (!code.includes("use cache")) return null;

        // Lazy-load the transforms to avoid startup cost
        const { transformWrapExport, transformHoistInlineDirective } = await import("@vitejs/plugin-rsc/transforms");
        const ast = parseAst(code);

        // Check for file-level "use cache" directive
        const cacheDirective = (ast.body as any[]).find(
          (node: any) =>
            node.type === "ExpressionStatement" &&
            node.expression?.type === "Literal" &&
            typeof node.expression.value === "string" &&
            node.expression.value.startsWith("use cache"),
        );

        if (cacheDirective) {
          // File-level "use cache" — wrap non-component exports with caching.
          // Page components (default export) are NOT wrapped because React
          // elements can't be JSON-serialized. For pages, file-level "use cache"
          // is treated as ISR — the cacheLife() call inside the component sets
          // the revalidation period, handled by the existing ISR cache layer.
          const directiveValue: string = cacheDirective.expression.value;
          const variant = directiveValue === "use cache" ? "" : directiveValue.replace("use cache:", "").replace("use cache: ", "").trim();

          // Detect if this is a React component convention file whose default
          // export returns JSX.  These can't be cached with JSON.stringify
          // because React elements contain Symbols and function references.
          // For pages, file-level "use cache" is treated as ISR instead.
          // For layouts/templates/etc., we still wrap non-default exports
          // like generateMetadata (which returns serializable data).
          const isComponentFile = /\/(page|layout|template|loading|error|not-found|default)\.(tsx?|jsx?|mjs)$/.test(id);

          const runtimeModulePath = path.join(shimsDir, "cache-runtime.js");
          const result = transformWrapExport(code, ast as any, {
            runtime: (value, name) =>
              `(await import(${JSON.stringify(runtimeModulePath)})).registerCachedFunction(${value}, ${JSON.stringify(id + ":" + name)}, ${JSON.stringify(variant)})`,
            rejectNonAsyncFunction: false,
            filter: (name, meta) => {
              // Skip non-functions (constants, types, etc.)
              if (meta.isFunction === false) return false;
              // Skip the default export on component convention files — these
              // are React components whose return value (JSX elements) can't
              // be JSON-serialized.  Covers page, layout, template, loading,
              // error, not-found, and default convention files.
              if (isComponentFile && name === "default") return false;
              return true;
            },
          });

          if (result.exportNames.length > 0) {
            // Remove the directive itself so it doesn't cause runtime errors
            const output = result.output;
            output.overwrite(cacheDirective.start, cacheDirective.end, `/* "use cache" — wrapped by vinext */`);
            return {
              code: output.toString(),
              map: output.generateMap({ hires: "boundary" }),
            };
          }

          // Even if no exports were wrapped, still strip the directive
          // (e.g., page-only file with just a default export)
          const { default: MagicString } = await import("magic-string");
          const output = new MagicString(code);
          output.overwrite(cacheDirective.start, cacheDirective.end, `/* "use cache" — handled by vinext */`);
          return {
            code: output.toString(),
            map: output.generateMap({ hires: "boundary" }),
          };
        }

        // Check for function-level "use cache" directives
        // (e.g., async function getData() { "use cache"; ... })
        const hasInlineCache = code.includes("use cache") && !cacheDirective;
        if (hasInlineCache) {
          const runtimeModulePath = path.join(shimsDir, "cache-runtime.js");

          try {
            const result = transformHoistInlineDirective(code, ast as any, {
              directive: /^use cache(:\s*\w+)?$/,
              runtime: (value, name, meta) => {
                const directiveMatch = meta.directiveMatch[0];
                const variant = directiveMatch === "use cache" ? "" : directiveMatch.replace("use cache:", "").replace("use cache: ", "").trim();
                return `(await import(${JSON.stringify(runtimeModulePath)})).registerCachedFunction(${value}, ${JSON.stringify(id + ":" + name)}, ${JSON.stringify(variant)})`;
              },
              rejectNonAsyncFunction: false,
            });

            if (result.names.length > 0) {
              return {
                code: result.output.toString(),
                map: result.output.generateMap({ hires: "boundary" }),
              };
            }
          } catch {
            // If hoisting fails (e.g., complex closure), fall through
          }
        }

        return null;
      },
    },
    // Cloudflare Workers production build integration:
    // After all environments are built, copy RSC/SSR outputs into the Worker
    // directory, rewrite cross-environment imports so workerd can resolve them,
    // and embed the client manifest for Pages Router hydration.
    {
      name: "vinext:cloudflare-build",
      apply: "build",
      enforce: "post",
      closeBundle: {
        sequential: true,
        order: "post",
        async handler() {
          // Only act if Cloudflare plugin is present.
          const envName = (this as any).environment?.name as string | undefined;
          if (!envName || !hasCloudflarePlugin) return;

          // Skip RSC and SSR environments — they're handled by the worker env
          if (envName === "rsc" || envName === "ssr") return;

          // Client environment: embed manifest in the worker entry for hydration.
          // The client builds AFTER the worker, so this is the right time to
          // read the client manifest and patch the worker entry.
          if (envName === "client") {
            const envConfig = (this as any).environment?.config;
            if (!envConfig) return;
            const buildRoot = envConfig.root ?? process.cwd();

            // Find the worker output directory by scanning dist/ for
            // a directory containing wrangler.json (the worker output)
            const distDir = path.resolve(buildRoot, "dist");
            if (!fs.existsSync(distDir)) return;
            let workerOutDir: string | null = null;
            for (const entry of fs.readdirSync(distDir)) {
              const candidate = path.join(distDir, entry);
              if (entry === "client" || entry === "rsc" || entry === "ssr") continue;
              if (fs.statSync(candidate).isDirectory() &&
                  fs.existsSync(path.join(candidate, "wrangler.json"))) {
                workerOutDir = candidate;
                break;
              }
            }
            if (!workerOutDir) return;

            const workerEntry = path.join(workerOutDir, "index.js");
            if (!fs.existsSync(workerEntry)) return;

            const clientDir = path.resolve(buildRoot, "dist", "client");
            let clientEntryFile: string | null = null;
            let ssrManifestData: Record<string, string[]> | null = null;

            // Read build manifest to find the client entry chunk filename
            const buildManifestPath = path.join(clientDir, ".vite", "manifest.json");
            if (fs.existsSync(buildManifestPath)) {
              try {
                const buildManifest = JSON.parse(fs.readFileSync(buildManifestPath, "utf-8"));
                for (const [, value] of Object.entries(buildManifest) as [string, any][]) {
                  if (value && value.isEntry && value.file) {
                    clientEntryFile = value.file;
                    break;
                  }
                }
              } catch { /* ignore parse errors */ }
            }

            // Fallback: scan dist/client/assets/ for the client entry chunk
            if (!clientEntryFile) {
              const assetsDir = path.join(clientDir, "assets");
              if (fs.existsSync(assetsDir)) {
                const files = fs.readdirSync(assetsDir);
                const entry = files.find((f: string) =>
                  f.includes("vinext-client-entry") && f.endsWith(".js"));
                if (entry) clientEntryFile = "assets/" + entry;
              }
            }

            // Read SSR manifest for per-page CSS/JS injection
            const ssrManifestPath = path.join(clientDir, ".vite", "ssr-manifest.json");
            if (fs.existsSync(ssrManifestPath)) {
              try {
                ssrManifestData = JSON.parse(fs.readFileSync(ssrManifestPath, "utf-8"));
              } catch { /* ignore parse errors */ }
            }

            // Prepend globals to worker entry
            if (clientEntryFile || ssrManifestData) {
              let code = fs.readFileSync(workerEntry, "utf-8");
              const globals: string[] = [];
              if (clientEntryFile) {
                globals.push(`globalThis.__VINEXT_CLIENT_ENTRY__ = ${JSON.stringify(clientEntryFile)};`);
              }
              if (ssrManifestData) {
                globals.push(`globalThis.__VINEXT_SSR_MANIFEST__ = ${JSON.stringify(ssrManifestData)};`);
              }
              code = globals.join("\n") + "\n" + code;
              fs.writeFileSync(workerEntry, code);
            }
            return;
          }

          const envConfig = (this as any).environment?.config;
          if (!envConfig) return;
          const buildRoot = envConfig.root ?? process.cwd();
          const workerOutDir = path.resolve(buildRoot, envConfig.build.outDir);

          // Copy RSC and SSR outputs into the worker directory
          for (const childEnv of ["rsc", "ssr"]) {
            const srcDir = path.resolve(buildRoot, "dist", childEnv);
            const destDir = path.join(workerOutDir, childEnv);
            if (!fs.existsSync(srcDir)) continue;
            fs.cpSync(srcDir, destDir, { recursive: true });
          }

          // Rewrite imports in the worker entry from "../rsc/" → "./rsc/", "../ssr/" → "./ssr/"
          const workerEntry = path.join(workerOutDir, "index.js");
          if (fs.existsSync(workerEntry)) {
            let code = fs.readFileSync(workerEntry, "utf-8");
            code = code.replace(/from\s*"\.\.\/rsc\//g, 'from "./rsc/');
            code = code.replace(/from\s*"\.\.\/ssr\//g, 'from "./ssr/');
            code = code.replace(/import\(\s*"\.\.\/rsc\//g, 'import("./rsc/');
            code = code.replace(/import\(\s*"\.\.\/ssr\//g, 'import("./ssr/');
            fs.writeFileSync(workerEntry, code);
          }

          // Rewrite cross-env imports within RSC entry (rsc → ssr: "../../ssr/" → "../ssr/")
          const rscEntry = path.join(workerOutDir, "rsc", "index.js");
          if (fs.existsSync(rscEntry)) {
            let code = fs.readFileSync(rscEntry, "utf-8");
            code = code.replace(/import\(\s*"\.\.\/\.\.\/ssr\//g, 'import("../ssr/');
            fs.writeFileSync(rscEntry, code);
          }

          // Rewrite cross-env imports within SSR entry (ssr → rsc: "../../rsc/" → "../rsc/")
          const ssrEntry = path.join(workerOutDir, "ssr", "index.js");
          if (fs.existsSync(ssrEntry)) {
            let code = fs.readFileSync(ssrEntry, "utf-8");
            code = code.replace(/import\(\s*"\.\.\/\.\.\/rsc\//g, 'import("../rsc/');
            fs.writeFileSync(ssrEntry, code);
          }


        },
      },
    },
  ];
}

/**
 * Collect all NEXT_PUBLIC_* env vars and create Vite define entries
 * so they get inlined into the client bundle.
 */
function getNextPublicEnvDefines(): Record<string, string> {
  const defines: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("NEXT_PUBLIC_") && value !== undefined) {
      defines[`process.env.${key}`] = JSON.stringify(value);
    }
  }
  return defines;
}

/**
 * Match a Next.js route pattern (e.g. "/blog/:slug", "/docs/:path*") against a pathname.
 * Returns matched params or null.
 *
 * Supports:
 *   :param     — matches a single path segment
 *   :param*    — matches zero or more segments (catch-all)
 *   :param+    — matches one or more segments
 *   (regex)    — inline regex patterns in the source
 */
export function matchConfigPattern(
  pathname: string,
  pattern: string,
): Record<string, string> | null {
  // If the pattern contains regex groups like (\\d+) or (.*), use regex matching
  if (pattern.includes("(") || pattern.includes("\\")) {
    try {
      // Extract named params and their constraints from the pattern.
      // :param(constraint) -> use constraint as the regex group
      // :param -> ([^/]+)
      // :param* -> (.*)
      // :param+ -> (.+)
      const paramNames: string[] = [];
      const regexStr = pattern
        .replace(/\./g, "\\.")
        // :param* with optional constraint
        .replace(/:(\w+)\*(?:\(([^)]+)\))?/g, (_m, name, constraint) => {
          paramNames.push(name);
          return constraint ? `(${constraint})` : "(.*)";
        })
        // :param+ with optional constraint
        .replace(/:(\w+)\+(?:\(([^)]+)\))?/g, (_m, name, constraint) => {
          paramNames.push(name);
          return constraint ? `(${constraint})` : "(.+)";
        })
        // :param(constraint) — named param with inline regex constraint
        .replace(/:(\w+)\(([^)]+)\)/g, (_m, name, constraint) => {
          paramNames.push(name);
          return `(${constraint})`;
        })
        // :param — plain named param
        .replace(/:(\w+)/g, (_m, name) => {
          paramNames.push(name);
          return "([^/]+)";
        });
      const re = new RegExp("^" + regexStr + "$");
      const match = re.exec(pathname);
      if (!match) return null;
      const params: Record<string, string> = {};
      for (let i = 0; i < paramNames.length; i++) {
        params[paramNames[i]] = match[i + 1] ?? "";
      }
      return params;
    } catch {
      // Fall through to segment-based matching
    }
  }

  // Check for catch-all patterns (:param* or :param+) without regex groups
  const catchAllMatch = pattern.match(/:(\w+)(\*|\+)$/);
  if (catchAllMatch) {
    const prefix = pattern.slice(0, pattern.lastIndexOf(":"));
    const paramName = catchAllMatch[1];
    const isPlus = catchAllMatch[2] === "+";

    if (!pathname.startsWith(prefix.replace(/\/$/, ""))) return null;

    const rest = pathname.slice(prefix.replace(/\/$/, "").length);
    // For :path+ we need at least one segment (non-empty after the prefix)
    if (isPlus && (!rest || rest === "/")) return null;
    // For :path* zero segments is fine
    return { [paramName]: rest.startsWith("/") ? rest.slice(1) : rest };
  }

  // Simple segment-based matching for exact patterns and :param
  const parts = pattern.split("/");
  const pathParts = pathname.split("/");

  if (parts.length !== pathParts.length) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].startsWith(":")) {
      params[parts[i].slice(1)] = pathParts[i];
    } else if (parts[i] !== pathParts[i]) {
      return null;
    }
  }
  return params;
}

/**
 * Apply redirect rules from next.config.js.
 * Returns true if a redirect was applied.
 */
function applyRedirects(
  pathname: string,
  res: any,
  redirects: NextRedirect[],
): boolean {
  for (const redirect of redirects) {
    const params = matchConfigPattern(pathname, redirect.source);
    if (params) {
      let dest = redirect.destination;
      for (const [key, value] of Object.entries(params)) {
        dest = dest.replace(`:${key}`, value);
      }
      res.writeHead(redirect.permanent ? 308 : 307, { Location: dest });
      res.end();
      return true;
    }
  }
  return false;
}

/**
 * Apply rewrite rules from next.config.js.
 * Returns the rewritten URL or null if no rewrite matched.
 */
function applyRewrites(
  pathname: string,
  rewrites: NextRewrite[],
): string | null {
  for (const rewrite of rewrites) {
    const params = matchConfigPattern(pathname, rewrite.source);
    if (params) {
      let dest = rewrite.destination;
      for (const [key, value] of Object.entries(params)) {
        dest = dest.replace(`:${key}`, value);
      }
      return dest;
    }
  }
  return null;
}

/**
 * Apply custom header rules from next.config.js.
 */
function applyHeaders(
  pathname: string,
  res: any,
  headers: Array<{ source: string; headers: Array<{ key: string; value: string }> }>,
): void {
  for (const rule of headers) {
    // Escape regex metacharacters in the source, then convert Next.js patterns.
    // Strategy: extract regex groups first, process the rest, then restore groups.
    const groups: string[] = [];
    const withPlaceholders = rule.source.replace(/\(([^)]+)\)/g, (_m, inner) => {
      groups.push(inner);
      return `___GROUP_${groups.length - 1}___`;
    });
    const escaped = withPlaceholders
      // Escape dots and other metacharacters
      .replace(/\./g, "\\.")
      .replace(/\+/g, "\\+")
      .replace(/\?/g, "\\?")
      // Convert glob * to .*
      .replace(/\*/g, ".*")
      // Convert :param to [^/]+
      .replace(/:\w+/g, "[^/]+")
      // Restore regex groups (contents are untouched)
      .replace(/___GROUP_(\d+)___/g, (_m, idx) => `(${groups[Number(idx)]})`);
    const sourceRegex = new RegExp("^" + escaped + "$");
    if (sourceRegex.test(pathname)) {
      for (const header of rule.headers) {
        res.setHeader(header.key, header.value);
      }
    }
  }
}

/**
 * Find a file by name (without extension) in a directory.
 * Checks .tsx, .ts, .jsx, .js extensions.
 */
function findFileWithExts(dir: string, name: string): string | null {
  const extensions = [".tsx", ".ts", ".jsx", ".js"];
  for (const ext of extensions) {
    const filePath = path.join(dir, name + ext);
    if (fs.existsSync(filePath)) return filePath;
  }
  return null;
}

// Public exports for static export
export { staticExportPages, staticExportApp } from "./build/static-export.js";
export type { StaticExportResult, StaticExportOptions, AppStaticExportOptions } from "./build/static-export.js";
