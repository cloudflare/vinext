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
import fs from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Virtual module IDs for Pages Router production build
const VIRTUAL_SERVER_ENTRY = "virtual:nextcompat-server-entry";
const RESOLVED_SERVER_ENTRY = "\0" + VIRTUAL_SERVER_ENTRY;
const VIRTUAL_CLIENT_ENTRY = "virtual:nextcompat-client-entry";
const RESOLVED_CLIENT_ENTRY = "\0" + VIRTUAL_CLIENT_ENTRY;

// Virtual module IDs for App Router entries
const VIRTUAL_RSC_ENTRY = "virtual:nextcompat-rsc-entry";
const RESOLVED_RSC_ENTRY = "\0" + VIRTUAL_RSC_ENTRY;
const VIRTUAL_APP_SSR_ENTRY = "virtual:nextcompat-app-ssr-entry";
const RESOLVED_APP_SSR_ENTRY = "\0" + VIRTUAL_APP_SSR_ENTRY;
const VIRTUAL_APP_BROWSER_ENTRY = "virtual:nextcompat-app-browser-entry";
const RESOLVED_APP_BROWSER_ENTRY = "\0" + VIRTUAL_APP_BROWSER_ENTRY;

export interface NextcompatOptions {
  /** Root directory of the Next.js app (default: Vite root) */
  appDir?: string;
}

export default function nextcompat(options: NextcompatOptions = {}): Plugin[] {
  let root: string;
  let pagesDir: string;
  let appDir: string;
  let hasAppDir = false;
  let hasPagesDir = false;
  let nextConfig: ResolvedNextConfig;
  let middlewarePath: string | null = null;
  let instrumentationPath: string | null = null;

  // Resolve shim paths - works both from source (.ts) and built (.js)
  const shimsDir = path.resolve(__dirname, "shims");

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

    // The server entry is a self-contained module. It uses template literals
    // with escaped backticks for string construction in the generated code.
    return `
import React from "react";
import ReactDOMServer from "react-dom/server";
import { Writable } from "node:stream";
import { resetSSRHead, getSSRHeadHTML } from "next/head";
import { flushPreloads } from "next/dynamic";
import { setSSRContext } from "next/router";
import { getCacheHandler } from "next/cache";
import { withFetchCache } from "nextcompat/fetch-cache";

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
    .catch((err) => console.error("[nextcompat] ISR regen failed for " + key + ":", err))
    .finally(() => pendingRegenerations.delete(key));
  pendingRegenerations.set(key, promise);
}

function renderToStringAsync(element) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const writable = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        callback();
      },
      final(callback) {
        resolve(Buffer.concat(chunks).toString("utf-8"));
        callback();
      },
    });
    const { pipe } = ReactDOMServer.renderToPipeableStream(element, {
      onAllReady() { pipe(writable); },
      onError(error) { reject(error); },
    });
  });
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

function collectAssetTags(manifest, moduleIds) {
  if (!manifest) return "";
  const tags = [];
  const seen = new Set();
  // Collect assets for the specified module IDs
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

export async function renderPage(req, res, url, manifest) {
  const match = matchRoute(url, pageRoutes);
  if (!match) {
    res.writeHead(404, { "Content-Type": "text/html" });
    res.end("<!DOCTYPE html><html><body><h1>404 - Page not found</h1></body></html>");
    return;
  }

  const { route, params } = match;
  const cleanupFetchCache = withFetchCache();
  try {
    if (typeof setSSRContext === "function") {
      setSSRContext({ pathname: url.split("?")[0], query: { ...params, ...parseQuery(url) }, asPath: url });
    }

    const pageModule = route.module;
    const PageComponent = pageModule.default;
    if (!PageComponent) {
      res.writeHead(500);
      res.end("Page has no default export");
      return;
    }

    let pageProps = {};
    if (typeof pageModule.getServerSideProps === "function") {
      const ctx = { params, req, res, query: parseQuery(url), resolvedUrl: url };
      const result = await pageModule.getServerSideProps(ctx);
      if (result && result.props) pageProps = result.props;
      if (result && result.redirect) {
        res.writeHead(result.redirect.permanent ? 308 : 307, { Location: result.redirect.destination });
        res.end();
        return;
      }
      if (result && result.notFound) { res.writeHead(404); res.end("404"); return; }
    }
    let isrRevalidateSeconds = null;
    if (typeof pageModule.getStaticProps === "function") {
      const pathname = url.split("?")[0];
      const cacheKey = "pages:" + (pathname === "/" ? "/" : pathname.replace(/\\/$/, ""));
      const cached = await isrGet(cacheKey);

      if (cached && !cached.isStale && cached.value.value && cached.value.value.kind === "PAGES") {
        // Fresh ISR cache hit
        res.writeHead(200, { "Content-Type": "text/html", "X-Nextcompat-Cache": "HIT",
          "Cache-Control": "s-maxage=" + (cached.value.value.revalidate || 60) + ", stale-while-revalidate" });
        res.end(cached.value.value.html);
        return;
      }

      if (cached && cached.isStale && cached.value.value && cached.value.value.kind === "PAGES") {
        // Stale ISR cache hit — serve stale, trigger background regen
        triggerBackgroundRegeneration(cacheKey, async function() {
          const freshResult = await pageModule.getStaticProps({ params });
          if (freshResult && freshResult.props && typeof freshResult.revalidate === "number" && freshResult.revalidate > 0) {
            // Re-render would be expensive, so just update the data for now
            await isrSet(cacheKey, { kind: "PAGES", html: cached.value.value.html, pageData: freshResult.props, headers: undefined, status: undefined }, freshResult.revalidate);
          }
        });
        res.writeHead(200, { "Content-Type": "text/html", "X-Nextcompat-Cache": "STALE",
          "Cache-Control": "s-maxage=0, stale-while-revalidate" });
        res.end(cached.value.value.html);
        return;
      }

      // Cache miss — call getStaticProps
      const ctx = { params };
      const result = await pageModule.getStaticProps(ctx);
      if (result && result.props) pageProps = result.props;
      if (result && result.redirect) {
        res.writeHead(result.redirect.permanent ? 308 : 307, { Location: result.redirect.destination });
        res.end();
        return;
      }
      if (result && result.notFound) { res.writeHead(404); res.end("404"); return; }
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
    // Look up this page's assets + the client entry assets in the manifest
    const pageModuleIds = route.filePath ? [route.filePath] : [];
    const assetTags = collectAssetTags(manifest, pageModuleIds);
    const nextDataScript = "<script>window.__NEXT_DATA__ = " + JSON.stringify({
      props: { pageProps }, page: route.pattern, query: params
    }) + "</script>";

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
      responseHeaders["X-Nextcompat-Cache"] = "MISS";
    }
    res.writeHead(200, responseHeaders);
    res.end(html);
  } catch (e) {
    console.error("[nextcompat] SSR error:", e);
    res.writeHead(500);
    res.end("Internal Server Error: " + (e && e.message ? e.message : String(e)));
  } finally {
    cleanupFetchCache();
  }
}

export async function handleApiRoute(req, res, url) {
  const match = matchRoute(url, apiRoutes);
  if (!match) {
    res.writeHead(404);
    res.end("404 - API route not found");
    return;
  }

  const { route, params } = match;
  const handler = route.module.default;
  if (typeof handler !== "function") {
    res.writeHead(500);
    res.end("API route does not export a default function");
    return;
  }

  const query = { ...params };
  const qs = url.split("?")[1];
  if (qs) { for (const [k, v] of new URLSearchParams(qs)) query[k] = v; }

  const body = await new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8");
      if (!raw) return resolve(undefined);
      const ct = req.headers["content-type"] || "";
      if (ct.includes("application/json")) {
        try { resolve(JSON.parse(raw)); } catch { resolve(raw); }
      } else resolve(raw);
    });
  });

  req.query = query;
  req.body = body;
  const cookieHeader = req.headers.cookie || "";
  req.cookies = {};
  for (const part of cookieHeader.split(";")) {
    const [key, ...rest] = part.split("=");
    if (key) req.cookies[key.trim()] = rest.join("=").trim();
  }
  res.status = function(code) { this.statusCode = code; return this; };
  res.json = function(data) { this.setHeader("Content-Type", "application/json"); this.end(JSON.stringify(data)); };
  res.send = function(data) {
    if (typeof data === "object" && data !== null) { this.json(data); }
    else { if (!this.getHeader("Content-Type")) this.setHeader("Content-Type", "text/plain"); this.end(String(data)); }
  };
  res.redirect = function(statusOrUrl, url2) {
    if (typeof statusOrUrl === "string") { this.writeHead(307, { Location: statusOrUrl }); }
    else { this.writeHead(statusOrUrl, { Location: url2 }); }
    this.end();
  };

  try {
    await handler(req, res);
  } catch (e) {
    console.error("[nextcompat] API error:", e);
    res.writeHead(500);
    res.end("API Error: " + (e && e.message ? e.message : String(e)));
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
    console.error("[nextcompat] No __NEXT_DATA__ found");
    return;
  }

  const { pageProps } = nextData.props;
  const loader = pageLoaders[nextData.page];
  if (!loader) {
    console.error("[nextcompat] No page loader for route:", nextData.page);
    return;
  }

  const pageModule = await loader();
  const PageComponent = pageModule.default;
  if (!PageComponent) {
    console.error("[nextcompat] Page module has no default export");
    return;
  }

  let element;
  ${hasApp ? `
  try {
    const appModule = await import(${JSON.stringify(appFileBase)});
    const AppComponent = appModule.default;
    window.__NEXTCOMPAT_APP__ = AppComponent;
    element = React.createElement(AppComponent, { Component: PageComponent, pageProps });
  } catch {
    element = React.createElement(PageComponent, pageProps);
  }
  ` : `
  element = React.createElement(PageComponent, pageProps);
  `}

  const container = document.getElementById("__next");
  if (!container) {
    console.error("[nextcompat] No #__next element found");
    return;
  }

  const root = hydrateRoot(container, element);
  window.__NEXTCOMPAT_ROOT__ = root;
}

hydrate();
`;
  }

  return [
    {
      name: "nextcompat:config",
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

        const viteConfig: Record<string, any> = {
          // Disable Vite's default HTML serving - we handle all routing
          appType: "custom",
          // Externalize React packages from SSR transform — they are CJS and
          // must be loaded natively by Node, not through Vite's ESM evaluator.
          ssr: {
            external: ["react", "react-dom", "react-dom/server"],
          },
          resolve: {
            alias: {
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
              "nextcompat/error-boundary": path.join(shimsDir, "error-boundary"),
              "nextcompat/metadata": path.join(shimsDir, "metadata"),
              "nextcompat/fetch-cache": path.join(shimsDir, "fetch-cache"),
            },
          },
          // Enable JSX in .tsx/.jsx files
          esbuild: {
            jsx: "automatic",
          },
          // Define env vars for client bundle
          define: defines,
          // Set base path if configured
          ...(nextConfig.basePath ? { base: nextConfig.basePath + "/" } : {}),
        };

        // If app/ directory exists, configure RSC environments
        if (hasAppDir) {
          viteConfig.environments = {
            rsc: {
              resolve: {
                // Externalize native/heavy packages so the RSC environment
                // loads them natively via Node rather than through Vite's
                // ESM module evaluator (which can't handle native addons).
                // Note: Do NOT externalize react/react-dom here — they must
                // be bundled with the "react-server" condition for RSC.
                external: [
                  "satori",
                  "@resvg/resvg-js",
                  "yoga-wasm-web",
                ],
              },
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
      name: "nextcompat:pages-router",

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
            console.error("[nextcompat] Instrumentation error:", err);
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
              const bp = nextConfig?.basePath ?? "";
              if (bp && pathname.startsWith(bp)) {
                const stripped = pathname.slice(bp.length) || "/";
                const qs = url.includes("?") ? url.slice(url.indexOf("?")) : "";
                url = stripped + qs;
                pathname = stripped;
              } else if (bp && pathname !== "/") {
                // URL doesn't start with basePath — let Vite handle it
                return next();
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
 * Match a Next.js route pattern (e.g. "/blog/:slug") against a pathname.
 * Returns matched params or null.
 */
function matchConfigPattern(
  pathname: string,
  pattern: string,
): Record<string, string> | null {
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
    const sourceRegex = new RegExp(
      "^" + rule.source.replace(/\*/g, ".*").replace(/:\w+/g, "[^/]+") + "$",
    );
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
