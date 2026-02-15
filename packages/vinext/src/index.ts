import type { Plugin, ViteDevServer } from "vite";
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

// i18n config (embedded at build time)
const i18nConfig = ${i18nConfigJson};

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
  if (!manifest) return "";
  const tags = [];
  const seen = new Set();
  const idsToCheck = moduleIds && moduleIds.length > 0
    ? moduleIds
    : Object.keys(manifest);
  for (const id of idsToCheck) {
    const files = manifest[id];
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

    const bodyHtml = await renderToStringAsync(element);
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

    let html;
    if (DocumentComponent) {
      const docElement = React.createElement(DocumentComponent);
      html = await renderToStringAsync(docElement);
      html = html.replace("__NEXT_MAIN__", bodyHtml);
      if (ssrHeadHTML || assetTags) {
        html = html.replace("</head>", "  " + ssrHeadHTML + "\\n  " + assetTags + "\\n</head>");
      }
      html = html.replace("<!-- __NEXT_SCRIPTS__ -->", nextDataScript);
      if (!html.includes("__NEXT_DATA__")) {
        html = html.replace("</body>", "  " + nextDataScript + "\\n</body>");
      }
    } else {
      html = "<!DOCTYPE html>\\n<html>\\n<head>\\n  <meta charset=\\"utf-8\\" />\\n  <meta name=\\"viewport\\" content=\\"width=device-width, initial-scale=1\\" />\\n  " + ssrHeadHTML + "\\n  " + assetTags + "\\n</head>\\n<body>\\n  <div id=\\"__next\\">" + bodyHtml + "</div>\\n  " + nextDataScript + "\\n</body>\\n</html>";
    }

    if (typeof setSSRContext === "function") setSSRContext(null);

    // Cache the rendered HTML for ISR if revalidate was set
    if (isrRevalidateSeconds !== null && isrRevalidateSeconds > 0) {
      const pathname = url.split("?")[0];
      const cacheKey = "pages:" + (pathname === "/" ? "/" : pathname.replace(/\\/$/, ""));
      await isrSet(cacheKey, { kind: "PAGES", html: html, pageData: pageProps, headers: undefined, status: undefined }, isrRevalidateSeconds);
    }

    const responseHeaders = { "Content-Type": "text/html" };
    if (isrRevalidateSeconds) {
      responseHeaders["Cache-Control"] = "s-maxage=" + isrRevalidateSeconds + ", stale-while-revalidate";
      responseHeaders["X-Vinext-Cache"] = "MISS";
    }
    return new Response(html, { status: 200, headers: responseHeaders });
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
          "vinext/error-boundary": path.join(shimsDir, "error-boundary"),
          "vinext/layout-segment-context": path.join(shimsDir, "layout-segment-context"),
          "vinext/metadata": path.join(shimsDir, "metadata"),
          "vinext/fetch-cache": path.join(shimsDir, "fetch-cache"),
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
          return generateRscEntry(appDir, routes, middlewarePath, metaRoutes, globalErrorPath, nextConfig?.basePath, nextConfig?.trailingSlash);
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
    // Cloudflare Workers production build integration:
    // After all environments are built, copy RSC/SSR outputs into the Worker
    // directory and rewrite cross-environment imports so workerd can resolve them.
    {
      name: "vinext:cloudflare-build",
      apply: "build",
      enforce: "post",
      closeBundle: {
        sequential: true,
        order: "post",
        async handler() {
          // Only act if Cloudflare plugin is present and this is the worker environment.
          // The Cloudflare plugin names worker environments with the sanitized worker name.
          const envName = (this as any).environment?.name as string | undefined;
          if (!envName || !hasCloudflarePlugin) return;

          // Worker environments are NOT "rsc", "ssr", or "client"
          if (envName === "rsc" || envName === "ssr" || envName === "client") return;

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
