/**
 * Static export for `output: 'export'`.
 *
 * Renders all pages to static HTML files at build time. Produces a directory
 * of HTML + client JS/CSS that can be deployed to any static file host
 * (S3, Cloudflare Pages, GitHub Pages, Nginx, etc.) with no server required.
 *
 * Pages Router:
 *   - Static pages → render to HTML
 *   - getStaticProps pages → call at build time, render with props
 *   - Dynamic routes → call getStaticPaths, render each (fallback: false required)
 *   - Dynamic routes without getStaticPaths → warning, skipped
 *   - getServerSideProps → build error
 *   - API routes → skipped with warning
 *
 * App Router:
 *   - Static pages → run Server Components at build time, render to HTML
 *   - Dynamic routes → call generateStaticParams(), render each
 *   - Dynamic routes without generateStaticParams → warning, skipped
 */
import type { ViteDevServer } from "vite";
import { patternToNextFormat, type Route } from "../routing/pages-router.js";
import type { AppRoute } from "../routing/app-router.js";
import {
  loadNextConfig,
  resolveNextConfig,
  type ResolvedNextConfig,
  type NextConfig,
} from "../config/next-config.js";
import { pagesRouter, apiRouter } from "../routing/pages-router.js";
import { appRouter } from "../routing/app-router.js";
import { classifyPagesRoute, classifyAppRoute, type RouteType } from "./report.js";
import { safeJsonStringify } from "../server/html.js";
import { escapeAttr } from "../shims/head.js";
import path from "node:path";
import fs from "node:fs";
import React from "react";
import { renderToReadableStream } from "react-dom/server.edge";
import { createValidFileMatcher, type ValidFileMatcher } from "../routing/file-matcher.js";

/**
 * Create a temporary Vite dev server for a project root.
 *
 * Always uses configFile: false with vinext loaded directly from this
 * package. Loading from the user's vite.config causes module resolution
 * issues: the config-file vinext instance resolves @vitejs/plugin-rsc
 * from a different path than the inline instance, causing instanceof
 * checks to fail and the RSC middleware to silently not handle requests.
 *
 * Pass `listen: true` to bind an HTTP port (needed for fetching pages).
 */
async function createTempViteServer(
  root: string,
  opts: { listen?: boolean } = {},
): Promise<import("vite").ViteDevServer> {
  const vite = await import("vite");
  const { default: vinextPlugin } = await import("../index.js");

  // `appDir: root` is a workaround for earlyBaseDir initialisation order.
  //
  // vinextPlugin() captures `earlyBaseDir = appDir ?? process.cwd()` at
  // *construction time*, before the Vite `config()` hook fires and before
  // `root` is known to the plugin. That value is used to resolve
  // @vitejs/plugin-rsc from the project's own node_modules. Without it, when
  // this function is invoked from tests (where process.cwd() is the monorepo
  // root), earlyAppDirExists evaluates to false, rscPluginPromise is set to
  // null, and the RSC middleware is never loaded — causing all App Router
  // requests to return 404.
  //
  // Passing `appDir: root` ensures earlyBaseDir equals the fixture/project root
  // so @vitejs/plugin-rsc resolves from the correct node_modules. The value
  // is semantically the project root here, not necessarily a directory named
  // "app/" — it overrides the default process.cwd() fallback only.
  const server = await vite.createServer({
    root,
    configFile: false,
    plugins: [vinextPlugin({ appDir: root /* project root, not app/ dir — see comment above */ })],
    optimizeDeps: { holdUntilCrawlEnd: true },
    server: { port: 0, cors: false },
    logLevel: "silent",
  });
  if (opts.listen) await server.listen();
  return server;
}

function findFileWithExtensions(basePath: string, matcher: ValidFileMatcher): boolean {
  return matcher.dottedExtensions.some((ext) => fs.existsSync(basePath + ext));
}

/**
 * Render a React element to string using renderToReadableStream (Suspense support).
 * Uses Web Streams API — works in Node.js 18+ and Cloudflare Workers.
 */
async function renderToStringAsync(element: React.ReactElement): Promise<string> {
  const stream = await renderToReadableStream(element);
  await stream.allReady;
  return new Response(stream).text();
}

export interface StaticExportOptions {
  /** Vite dev server (for SSR module loading) */
  server: ViteDevServer;
  /** Discovered page routes (excludes API routes) */
  routes: Route[];
  /** Discovered API routes */
  apiRoutes: Route[];
  /** Pages directory path */
  pagesDir: string;
  /** Output directory for static files */
  outDir: string;
  /** Resolved next.config.js */
  config: ResolvedNextConfig;
}

export interface StaticExportResult {
  /** Number of HTML files generated */
  pageCount: number;
  /** Generated file paths (relative to outDir) */
  files: string[];
  /** Warnings encountered */
  warnings: string[];
  /** Errors encountered (non-fatal, specific pages) */
  errors: Array<{ route: string; error: string }>;
  /**
   * Confirmed route classifications keyed by URL pattern.
   * Populated from runtime data (module execution, getStaticPaths, etc.) —
   * more accurate than the regex-based analysis in report.ts.
   * Consumed by printBuildReport() to show correct route types.
   */
  routeClassifications: Map<string, { type: RouteType; revalidate?: number }>;
}

/**
 * Run static export for Pages Router.
 *
 * Creates a directory of static HTML files by rendering each route at build time.
 */
export async function staticExportPages(options: StaticExportOptions): Promise<StaticExportResult> {
  const { server, routes, apiRoutes, pagesDir, outDir, config } = options;
  const fileMatcher = createValidFileMatcher(config.pageExtensions);
  const result: StaticExportResult = {
    pageCount: 0,
    files: [],
    warnings: [],
    errors: [],
    routeClassifications: new Map(),
  };

  // Ensure output directory exists
  fs.mkdirSync(outDir, { recursive: true });

  // Warn about API routes
  if (apiRoutes.length > 0) {
    result.warnings.push(
      `${apiRoutes.length} API route(s) skipped — API routes are not supported with output: 'export'`,
    );
    for (const r of apiRoutes) {
      result.routeClassifications.set(r.pattern, { type: "api" });
    }
  }

  // Gather all pages to render (expand dynamic routes via getStaticPaths)
  const pagesToRender: Array<{
    route: Route;
    urlPath: string;
    params: Record<string, string | string[]>;
  }> = [];

  for (const route of routes) {
    // Skip internal pages
    const routeName = path.basename(route.filePath, path.extname(route.filePath));
    if (routeName.startsWith("_")) continue;

    let pageModule: Record<string, unknown>;
    try {
      pageModule = await server.ssrLoadModule(route.filePath);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      result.routeClassifications.set(route.pattern, { type: "unknown" });
      result.warnings.push(`Failed to load ${route.pattern}: ${msg} — skipping`);
      continue;
    }

    // Validate: getServerSideProps is not allowed with static export
    if (typeof pageModule.getServerSideProps === "function") {
      result.routeClassifications.set(route.pattern, { type: "ssr" });
      result.errors.push({
        route: route.pattern,
        error: `Page uses getServerSideProps which is not supported with output: 'export'. Use getStaticProps instead.`,
      });
      continue;
    }

    if (route.isDynamic) {
      // Dynamic route — needs getStaticPaths to enumerate params
      if (typeof pageModule.getStaticPaths !== "function") {
        // Classify as "unknown", not "ssr": the route is skipped because its
        // params can't be enumerated statically, not because it uses SSR APIs.
        result.routeClassifications.set(route.pattern, { type: "unknown" });
        result.warnings.push(
          `Dynamic route ${route.pattern} has no getStaticPaths() — skipping (no pages generated)`,
        );
        continue;
      }

      const pathsResult = await pageModule.getStaticPaths({
        locales: config.i18n?.locales ?? [],
        defaultLocale: config.i18n?.defaultLocale ?? "",
      });
      const fallback = pathsResult?.fallback ?? false;

      if (fallback !== false) {
        result.routeClassifications.set(route.pattern, { type: "ssr" });
        result.errors.push({
          route: route.pattern,
          error: `getStaticPaths must return fallback: false with output: 'export' (got: ${JSON.stringify(fallback)})`,
        });
        continue;
      }

      const paths: Array<{ params: Record<string, string | string[]> }> = pathsResult?.paths ?? [];

      for (const { params } of paths) {
        // Build the URL path from the route pattern and params
        const urlPath = buildUrlFromParams(route.pattern, params);
        pagesToRender.push({ route, urlPath, params });
      }
    } else {
      // Static route — render directly
      pagesToRender.push({ route, urlPath: route.pattern, params: {} });
    }
  }

  // Classify all routes queued for rendering using source analysis.
  // We have the actual file paths here, so classifyPagesRoute gives us ISR
  // revalidate values and static/ssr distinctions that the regex in
  // collectStaticRoutesFromSource loses. Each pattern is only classified once
  // even if it expands to multiple concrete URLs via getStaticPaths.
  for (const { route } of pagesToRender) {
    if (!result.routeClassifications.has(route.pattern)) {
      result.routeClassifications.set(route.pattern, classifyPagesRoute(route.filePath));
    }
  }

  // Load shared components (_app, _document, head shim, dynamic shim)
  let AppComponent: React.ComponentType<{
    Component: React.ComponentType;
    pageProps: Record<string, unknown>;
  }> | null = null;
  const appPath = path.join(pagesDir, "_app");
  if (findFileWithExtensions(appPath, fileMatcher)) {
    try {
      const appModule = await server.ssrLoadModule(appPath);
      AppComponent = appModule.default ?? null;
    } catch {
      // _app exists but failed to load
    }
  }

  let DocumentComponent: React.ComponentType | null = null;
  const docPath = path.join(pagesDir, "_document");
  if (findFileWithExtensions(docPath, fileMatcher)) {
    try {
      const docModule = await server.ssrLoadModule(docPath);
      DocumentComponent = docModule.default ?? null;
    } catch {
      // _document exists but failed to load
    }
  }

  const headShim = await server.ssrLoadModule("next/head");
  const dynamicShim = await server.ssrLoadModule("next/dynamic");
  const routerShim = await server.ssrLoadModule("next/router");

  // Render each page
  for (const { route, urlPath, params } of pagesToRender) {
    try {
      // renderStaticPage always returns HTML (in-process rendering, not fetched over HTTP)
      // so no Content-Type check is needed, unlike the HTTP-based export paths.
      const html = await renderStaticPage({
        server,
        route,
        urlPath,
        params,
        pagesDir,
        config,
        AppComponent,
        DocumentComponent,
        headShim,
        dynamicShim,
        routerShim,
      });

      const outputPath = getOutputPath(urlPath, config.trailingSlash, outDir);
      const fullPath = path.join(outDir, outputPath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, html, "utf-8");

      result.files.push(outputPath);
      result.pageCount++;
    } catch (e) {
      result.errors.push({
        route: urlPath,
        error: (e as Error).message,
      });
    }
  }

  // Render 404 page
  try {
    const html404 = await renderErrorPage({
      server,
      pagesDir,
      statusCode: 404,
      AppComponent,
      DocumentComponent,
      headShim,
      fileMatcher,
    });
    if (html404) {
      const fullPath = path.join(outDir, "404.html");
      fs.writeFileSync(fullPath, html404, "utf-8");
      result.files.push("404.html");
      result.pageCount++;
    }
  } catch {
    // No custom 404, skip
  }

  return result;
}

interface RenderStaticPageOptions {
  server: ViteDevServer;
  route: Route;
  urlPath: string;
  params: Record<string, string | string[]>;
  pagesDir: string;
  config: ResolvedNextConfig;
  AppComponent: React.ComponentType<{
    Component: React.ComponentType;
    pageProps: Record<string, unknown>;
  }> | null;
  DocumentComponent: React.ComponentType | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  headShim: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  dynamicShim: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  routerShim: any;
}

async function renderStaticPage(options: RenderStaticPageOptions): Promise<string> {
  const {
    server,
    route,
    urlPath,
    params,
    config: _config,
    AppComponent,
    DocumentComponent,
    headShim,
    dynamicShim,
    routerShim,
  } = options;

  // Set SSR context for router shim
  if (typeof routerShim.setSSRContext === "function") {
    routerShim.setSSRContext({
      pathname: patternToNextFormat(route.pattern),
      query: params,
      asPath: urlPath,
    });
  }

  try {
    const pageModule = await server.ssrLoadModule(route.filePath);
    const PageComponent = pageModule.default;
    if (!PageComponent) {
      throw new Error(`Page ${route.filePath} has no default export`);
    }

    // Collect page props
    let pageProps: Record<string, unknown> = {};

    if (typeof pageModule.getStaticProps === "function") {
      const result = await pageModule.getStaticProps({ params });
      if (result && "props" in result) {
        pageProps = result.props as Record<string, unknown>;
      }
      if (result && "redirect" in result) {
        // Static export can't handle redirects — write a meta redirect
        const redirect = result.redirect as { destination: string };
        return `<!DOCTYPE html><html><head><meta http-equiv="refresh" content="0;url=${escapeAttr(redirect.destination)}" /></head><body></body></html>`;
      }
      if (result && "notFound" in result && result.notFound) {
        throw new Error(`Page ${urlPath} returned notFound: true`);
      }
    }

    // Build element
    const createElement = React.createElement;
    let element: React.ReactElement;

    if (AppComponent) {
      element = createElement(AppComponent, {
        Component: PageComponent,
        pageProps,
      });
    } else {
      element = createElement(PageComponent, pageProps);
    }

    // Reset head collector and flush dynamic preloads
    if (typeof headShim.resetSSRHead === "function") {
      headShim.resetSSRHead();
    }
    if (typeof dynamicShim.flushPreloads === "function") {
      await dynamicShim.flushPreloads();
    }

    // Render page body
    const bodyHtml = await renderToStringAsync(element);

    // Collect head tags
    const ssrHeadHTML =
      typeof headShim.getSSRHeadHTML === "function" ? headShim.getSSRHeadHTML() : "";

    // __NEXT_DATA__ for client hydration.
    // `page` must use Next.js bracket notation ([slug]) so the client-side
    // router can match this route during hydration. Colon notation (:slug)
    // is vinext's internal format and is not understood by next/router.
    const nextDataScript = `<script>window.__NEXT_DATA__ = ${safeJsonStringify({
      props: { pageProps },
      page: patternToNextFormat(route.pattern),
      query: params,
      buildId: _config.buildId,
    })}</script>`;

    // Build HTML shell
    let html: string;

    if (DocumentComponent) {
      const docElement = createElement(DocumentComponent);
      // renderToReadableStream auto-prepends <!DOCTYPE html> when root is <html>
      let docHtml = await renderToStringAsync(docElement);
      docHtml = docHtml.replace("__NEXT_MAIN__", bodyHtml);
      if (ssrHeadHTML) {
        docHtml = docHtml.replace("</head>", `  ${ssrHeadHTML}\n</head>`);
      }
      docHtml = docHtml.replace("<!-- __NEXT_SCRIPTS__ -->", nextDataScript);
      if (!docHtml.includes("__NEXT_DATA__")) {
        docHtml = docHtml.replace("</body>", `  ${nextDataScript}\n</body>`);
      }
      html = docHtml;
    } else {
      html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  ${ssrHeadHTML}
</head>
<body>
  <div id="__next">${bodyHtml}</div>
  ${nextDataScript}
</body>
</html>`;
    }

    return html;
  } finally {
    // Always clear SSR context, even if rendering throws
    if (typeof routerShim.setSSRContext === "function") {
      routerShim.setSSRContext(null);
    }
  }
}

interface RenderErrorPageOptions {
  server: ViteDevServer;
  pagesDir: string;
  statusCode: number;
  AppComponent: React.ComponentType<{
    Component: React.ComponentType;
    pageProps: Record<string, unknown>;
  }> | null;
  DocumentComponent: React.ComponentType | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  headShim: any;
  fileMatcher: ValidFileMatcher;
}

async function renderErrorPage(options: RenderErrorPageOptions): Promise<string | null> {
  const { server, pagesDir, statusCode, AppComponent, DocumentComponent, headShim, fileMatcher } =
    options;

  const candidates =
    statusCode === 404 ? ["404", "_error"] : statusCode === 500 ? ["500", "_error"] : ["_error"];

  for (const candidate of candidates) {
    const candidatePath = path.join(pagesDir, candidate);
    if (!findFileWithExtensions(candidatePath, fileMatcher)) continue;

    const errorModule = await server.ssrLoadModule(candidatePath);
    const ErrorComponent = errorModule.default;
    if (!ErrorComponent) continue;

    const createElement = React.createElement;
    const errorProps = { statusCode };

    let element: React.ReactElement;
    if (AppComponent) {
      element = createElement(AppComponent, {
        Component: ErrorComponent,
        pageProps: errorProps,
      });
    } else {
      element = createElement(ErrorComponent, errorProps);
    }

    if (typeof headShim.resetSSRHead === "function") {
      headShim.resetSSRHead();
    }

    const bodyHtml = await renderToStringAsync(element);

    let html: string;
    if (DocumentComponent) {
      const docElement = createElement(DocumentComponent);
      let docHtml = await renderToStringAsync(docElement);
      docHtml = docHtml.replace("__NEXT_MAIN__", bodyHtml);
      docHtml = docHtml.replace("<!-- __NEXT_SCRIPTS__ -->", "");
      html = docHtml;
    } else {
      html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
</head>
<body>
  <div id="__next">${bodyHtml}</div>
</body>
</html>`;
    }

    return html;
  }

  return null;
}

/**
 * Build a URL path from a route pattern and params.
 * E.g., "/posts/:id" + { id: "42" } → "/posts/42"
 * E.g., "/docs/:slug+" + { slug: ["a", "b"] } → "/docs/a/b"
 */
function buildUrlFromParams(pattern: string, params: Record<string, string | string[]>): string {
  const parts = pattern.split("/").filter(Boolean);
  const result: string[] = [];

  for (const part of parts) {
    if (part.endsWith("+") || part.endsWith("*")) {
      // Catch-all: :slug+ or :slug*
      const paramName = part.slice(1, -1);
      const value = params[paramName];
      if (Array.isArray(value)) {
        result.push(...value);
      } else if (value) {
        result.push(String(value));
      }
    } else if (part.startsWith(":")) {
      // Dynamic segment: :id
      const paramName = part.slice(1);
      const value = params[paramName];
      if (value === undefined || value === null) {
        throw new Error(
          `getStaticPaths/generateStaticParams returned an entry missing required param "${paramName}" for pattern "${pattern}"`,
        );
      }
      result.push(String(value));
    } else {
      result.push(part);
    }
  }

  return "/" + result.join("/");
}

/**
 * Determine the output file path for a given URL and verify it stays
 * within the output directory. Respects trailingSlash config.
 *
 * `outDir` is the resolved absolute path of the output directory.
 * After computing the relative output path, the function resolves it
 * against `outDir` and checks that it doesn't escape the boundary
 * (e.g. via crafted `generateStaticParams` / `getStaticPaths` values).
 */
export function getOutputPath(urlPath: string, trailingSlash: boolean, outDir: string): string {
  if (urlPath === "/") {
    // INVARIANT: this early return must stay above the boundary check below.
    // Root maps to "index.html" — no traversal is possible for "/", so the
    // startsWith check is unnecessary. (path.resolve("/tmp/out", "index.html")
    // would pass anyway, so removing this early return would not change
    // behaviour — but keeping it makes the common case explicit and fast.)
    return "index.html";
  }

  // Reject backslashes before posix-normalizing. path.posix.normalize treats
  // '\' as a literal character (not a separator), so a Windows-style path like
  // "..\secret" would pass through unchanged and bypass the traversal guard.
  if (urlPath.includes("\\")) {
    throw new Error(`Output path "${urlPath}" escapes the output directory`);
  }
  const normalized = path.posix.normalize(urlPath);
  const clean = normalized.replace(/^\//, "");

  const relative = trailingSlash ? `${clean}/index.html` : `${clean}.html`;

  const resolved = path.resolve(outDir, relative);
  const resolvedOutDir = path.resolve(outDir);
  // Defence-in-depth: for URL inputs this check never fires because
  // path.posix.normalize on any path starting with "/" cannot produce a
  // segment above "/". The guard exists for non-URL callers (e.g. custom
  // generateStaticParams values on Windows where path.sep differs).
  if (!resolved.startsWith(resolvedOutDir + path.sep)) {
    throw new Error(`Output path "${urlPath}" escapes the output directory`);
  }

  return relative;
}

/**
 * Resolve parent dynamic segment params for a route.
 *
 * Implements Next.js's top-down params passing for generateStaticParams().
 * Walks up the route hierarchy to find parent dynamic segments that have their
 * own generateStaticParams. Collects parent params by calling each parent's
 * generateStaticParams in order, merging results top-down.
 *
 * Returns an array of parent param combinations. If empty, the child should
 * be called with `{ params: {} }` (bottom-up approach).
 */
async function resolveParentParams(
  childRoute: AppRoute,
  allRoutes: AppRoute[],
  server: ViteDevServer,
): Promise<Record<string, string | string[]>[]> {
  // Extract the dynamic segment names from the pattern
  const patternParts = childRoute.pattern.split("/").filter(Boolean);

  // Identify parent dynamic segments: each :param in the pattern except the last one(s)
  // that belong to the leaf page's directory.
  // Strategy: find ancestor routes (layout-level) that export generateStaticParams.
  // An ancestor route's pattern is a prefix of the child's pattern.

  // Collect parent segments with generateStaticParams by looking at page modules
  // along the ancestor path. We look for pages/layouts that define generateStaticParams
  // at each level of the path hierarchy.
  type ParentSegment = {
    params: string[];
    generateStaticParams: (opts: {
      params: Record<string, string | string[]>;
    }) => Promise<Record<string, string | string[]>[]>;
  };

  const parentSegments: ParentSegment[] = [];

  // Walk pattern parts to find intermediate dynamic segments
  // For /products/:category/:id, we look for a route or layout at /products/:category
  // that has generateStaticParams
  for (let i = 0; i < patternParts.length; i++) {
    const part = patternParts[i];
    if (!part.startsWith(":")) continue;

    // Check if this is not the last dynamic param (i.e., it's a parent segment)
    const isLastDynamicPart = !patternParts.slice(i + 1).some((p) => p.startsWith(":"));
    if (isLastDynamicPart) break; // This is the child's own segment

    // Build the prefix pattern up to this segment
    const prefixPattern = "/" + patternParts.slice(0, i + 1).join("/");

    // Find a route at this prefix that has generateStaticParams
    const parentRoute = allRoutes.find((r) => r.pattern === prefixPattern);
    if (parentRoute?.pagePath) {
      try {
        const parentModule = await server.ssrLoadModule(parentRoute.pagePath);
        if (typeof parentModule.generateStaticParams === "function") {
          const paramName = part.replace(/^:/, "").replace(/[+*]$/, "");
          parentSegments.push({
            params: [paramName],
            generateStaticParams: parentModule.generateStaticParams,
          });
        }
      } catch (e) {
        // Warn instead of silently swallowing: a failed parent load means we
        // call the child's generateStaticParams with an empty params object,
        // which produces wrong URLs and is very hard to debug otherwise.
        console.warn(
          `[vinext] Warning: failed to load parent module for ${childRoute.pattern} at ${parentRoute.pagePath}. ` +
            `Child generateStaticParams will be called with {} instead of parent params. Error: ${(e as Error).message}`,
        );
        // Skip — parent module couldn't be loaded
      }
    }
  }

  if (parentSegments.length === 0) return [];

  // Top-down resolution: call each parent's generateStaticParams in order,
  // accumulating params
  let currentParams: Record<string, string | string[]>[] = [{}];

  for (const segment of parentSegments) {
    const nextParams: Record<string, string | string[]>[] = [];
    for (const parentParams of currentParams) {
      const results = await segment.generateStaticParams({ params: parentParams });
      if (Array.isArray(results)) {
        for (const result of results) {
          nextParams.push({ ...parentParams, ...result });
        }
      }
    }
    currentParams = nextParams;
  }

  return currentParams;
}

/**
 * Expand a dynamic App Router route into concrete URLs via generateStaticParams.
 * Handles parent param resolution (top-down passing).
 * Returns the list of expanded URLs, or an empty array if the route has no params.
 */
async function expandDynamicAppRoute(
  route: AppRoute,
  allRoutes: AppRoute[],
  server: ViteDevServer,
  generateStaticParams: (opts: {
    params: Record<string, string | string[]>;
  }) => Promise<Record<string, string | string[]>[]>,
): Promise<string[]> {
  const parentParamSets = await resolveParentParams(route, allRoutes, server);

  let paramSets: Record<string, string | string[]>[];
  try {
    if (parentParamSets.length > 0) {
      paramSets = [];
      for (const parentParams of parentParamSets) {
        const childResults = await generateStaticParams({ params: parentParams });
        if (Array.isArray(childResults)) {
          for (const childParams of childResults) {
            paramSets.push({ ...parentParams, ...childParams });
          }
        }
      }
    } else {
      paramSets = await generateStaticParams({ params: {} });
    }
  } catch (e) {
    throw new Error(`generateStaticParams() failed for ${route.pattern}: ${(e as Error).message}`);
  }

  return paramSets.map((params) => buildUrlFromParams(route.pattern, params));
}

// -------------------------------------------------------------------
// App Router static export
// -------------------------------------------------------------------

export interface AppStaticExportOptions {
  /** Base URL of a running dev server (e.g. "http://localhost:5173") */
  baseUrl: string;
  /** Discovered app routes */
  routes: AppRoute[];
  /** Vite dev server (for loading page modules) */
  server: ViteDevServer;
  /** Output directory */
  outDir: string;
  /** Resolved next.config.js */
  config: ResolvedNextConfig;
}

/**
 * Run static export for App Router.
 *
 * Fetches each route from a running dev server and writes the HTML to disk.
 * For dynamic routes, calls generateStaticParams() to expand all paths.
 */
export async function staticExportApp(
  options: AppStaticExportOptions,
): Promise<StaticExportResult> {
  const { baseUrl, routes, server, outDir, config } = options;
  const result: StaticExportResult = {
    pageCount: 0,
    files: [],
    warnings: [],
    errors: [],
    routeClassifications: new Map(),
  };

  fs.mkdirSync(outDir, { recursive: true });

  // Collect all URLs to render
  const urlsToRender: string[] = [];

  for (const route of routes) {
    // Skip API route handlers — not supported in static export
    if (route.routePath && !route.pagePath) {
      result.routeClassifications.set(route.pattern, { type: "api" });
      result.warnings.push(
        `Route handler ${route.pattern} skipped — API routes are not supported with output: 'export'`,
      );
      continue;
    }

    if (!route.pagePath) continue;

    if (route.isDynamic) {
      // Dynamic route — must have generateStaticParams
      try {
        const pageModule = await server.ssrLoadModule(route.pagePath);

        if (typeof pageModule.generateStaticParams !== "function") {
          // Classify as "unknown", not "ssr": the route is skipped because its
          // params can't be enumerated statically, not because it uses SSR APIs.
          result.routeClassifications.set(route.pattern, { type: "unknown" });
          result.warnings.push(
            `Dynamic route ${route.pattern} has no generateStaticParams() — skipping (no pages generated)`,
          );
          continue;
        }

        const expandedUrls = await expandDynamicAppRoute(
          route,
          routes,
          server,
          pageModule.generateStaticParams,
        );

        if (expandedUrls.length === 0) {
          result.routeClassifications.set(route.pattern, { type: "unknown" });
          result.warnings.push(
            `generateStaticParams() for ${route.pattern} returned empty array — no pages generated`,
          );
          continue;
        }

        // Has generateStaticParams — statically pre-rendered at build time.
        // Use classifyAppRoute to pick up any explicit revalidate config.
        result.routeClassifications.set(
          route.pattern,
          classifyAppRoute(route.pagePath, route.routePath, route.isDynamic),
        );
        urlsToRender.push(...expandedUrls);
      } catch (e) {
        result.errors.push({
          route: route.pattern,
          error: (e as Error).message,
        });
      }
    } else {
      // Static route — classify and queue for rendering
      result.routeClassifications.set(
        route.pattern,
        classifyAppRoute(route.pagePath, route.routePath, route.isDynamic),
      );
      urlsToRender.push(route.pattern);
    }
  }

  // Fetch each URL from the dev server and write HTML
  for (const urlPath of urlsToRender) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const res = await fetch(`${baseUrl}${urlPath}`, { signal: controller.signal });
      if (!res.ok) {
        result.errors.push({
          route: urlPath,
          error: `Server returned ${res.status}`,
        });
        await res.body?.cancel(); // release connection
        continue;
      }

      const contentType = res.headers.get("content-type") ?? "";
      if (!contentType.includes("text/html")) {
        // Non-HTML response (e.g. a JSON response from a misclassified route).
        // Writing it as .html would produce a corrupt file — record as error.
        result.errors.push({
          route: urlPath,
          error: `Expected text/html but got "${contentType}" — skipping`,
        });
        await res.body?.cancel();
        continue;
      }
      const html = await res.text();
      const outputPath = getOutputPath(urlPath, config.trailingSlash, outDir);
      const fullPath = path.join(outDir, outputPath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, html, "utf-8");

      result.files.push(outputPath);
      result.pageCount++;
    } catch (e) {
      result.errors.push({
        route: urlPath,
        error: (e as Error).message,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  // Render 404 page
  const ctrl404 = new AbortController();
  const t404 = setTimeout(() => ctrl404.abort(), 30_000);
  try {
    const res = await fetch(`${baseUrl}/__nonexistent_page_for_404__`, {
      signal: ctrl404.signal,
    });
    if (res.status === 404) {
      const html = await res.text();
      if (html.length > 0) {
        const fullPath = path.join(outDir, "404.html");
        fs.writeFileSync(fullPath, html, "utf-8");
        result.files.push("404.html");
        result.pageCount++;
      } else {
        await res.body?.cancel();
      }
    } else {
      await res.body?.cancel();
    }
  } catch {
    // No custom 404, skip
  } finally {
    clearTimeout(t404);
  }

  return result;
}

// -------------------------------------------------------------------
// High-level orchestrator
// -------------------------------------------------------------------

export interface RunStaticExportOptions {
  root: string;
  outDir?: string;
  config?: ResolvedNextConfig;
  /**
   * Scalar config overrides applied on top of the resolved config.
   * Only safe scalar fields are permitted — non-scalar fields like
   * `pageExtensions` or `redirects` require re-running resolveNextConfig
   * and cannot be shallow-merged correctly.
   */
  configOverride?: Pick<NextConfig, "output" | "trailingSlash">;
}

/**
 * High-level orchestrator for static export.
 *
 * Loads next.config from the project root, detects the router type,
 * starts a temporary Vite dev server, scans routes, runs the appropriate
 * static export (Pages or App Router), and returns the result.
 */
export async function runStaticExport(
  options: RunStaticExportOptions,
): Promise<StaticExportResult> {
  const { root, configOverride } = options;
  const outDir = options.outDir ?? path.join(root, "out");

  // 1. Load and resolve config (reuse caller's config if provided, but always
  //    apply configOverride on top so callers can force e.g. output: "export")
  let config: ResolvedNextConfig;
  if (options.config) {
    if (configOverride && Object.keys(configOverride).length > 0) {
      // Apply the override directly on the already-resolved config. The
      // typical fields in configOverride (output, trailingSlash) are scalars
      // that need no further resolution, so a shallow merge is sufficient.
      config = { ...options.config, ...configOverride } as ResolvedNextConfig;
    } else {
      config = options.config;
    }
  } else {
    const loadedConfig = await loadNextConfig(root);
    const merged: NextConfig = { ...loadedConfig, ...configOverride };
    config = await resolveNextConfig(merged);
  }

  // 2. Detect router type
  const appDirCandidates = [path.join(root, "app"), path.join(root, "src", "app")];
  const pagesDirCandidates = [path.join(root, "pages"), path.join(root, "src", "pages")];

  const appDir = appDirCandidates.find((d) => fs.existsSync(d));
  const pagesDir = pagesDirCandidates.find((d) => fs.existsSync(d));

  if (!appDir && !pagesDir) {
    return {
      pageCount: 0,
      files: [],
      warnings: ["No app/ or pages/ directory found — nothing to export"],
      errors: [],
      routeClassifications: new Map(),
    };
  }

  // 3. Start a temporary Vite dev server (with listener for HTTP fetching)
  const server = await createTempViteServer(root, { listen: true });

  try {
    // 4. Clean output directory
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.mkdirSync(outDir, { recursive: true });

    // 5. Scan routes and run export
    //
    // Hybrid app/ + pages/ layout is supported: both routers run in sequence
    // and their results are merged. App Router is exported first, then Pages
    // Router. If both routers produce a file with the same relative path (e.g.
    // both have an index route), the Pages Router file wins — it is written
    // second and overwrites the App Router file on disk. A warning is emitted
    // for each collision so the user can resolve the overlap.
    if (appDir) {
      const addr = server.httpServer?.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      if (port === 0) {
        throw new Error("Vite dev server failed to bind to a port");
      }
      const baseUrl = `http://localhost:${port}`;

      const appRoutes = await appRouter(appDir);
      const appResult = await staticExportApp({
        baseUrl,
        routes: appRoutes,
        server,
        outDir,
        config,
      });

      if (!pagesDir) {
        return appResult;
      }

      // Hybrid: also export the Pages Router into the same outDir.
      const pageRoutes = await pagesRouter(pagesDir);
      const apiRoutes = await apiRouter(pagesDir);
      const pagesResult = await staticExportPages({
        server,
        routes: pageRoutes,
        apiRoutes,
        pagesDir,
        outDir,
        config,
      });

      // Detect file collisions (same relative path produced by both routers).
      const appFilesSet = new Set(appResult.files);
      const pagesFilesSet = new Set(pagesResult.files);
      const collisionWarnings: string[] = [];
      for (const f of pagesResult.files) {
        if (appFilesSet.has(f)) {
          collisionWarnings.push(
            `[vinext] Hybrid export collision: both App Router and Pages Router produced "${f}" — Pages Router output takes precedence`,
          );
        }
      }

      return {
        pageCount: appResult.pageCount + pagesResult.pageCount - collisionWarnings.length,
        files: [
          // Deduplicate: for colliding paths, pagesResult wins (it was written
          // second, overwriting the app result file on disk). Emit only the
          // de-duped union so the caller's file list matches what's on disk.
          ...appResult.files.filter((f) => !pagesFilesSet.has(f)),
          ...pagesResult.files,
        ],
        warnings: [...appResult.warnings, ...pagesResult.warnings, ...collisionWarnings],
        errors: [...appResult.errors, ...pagesResult.errors],
        routeClassifications: new Map([
          ...appResult.routeClassifications,
          // Pages Router wins on collision (same pattern in both routers)
          ...pagesResult.routeClassifications,
        ]),
      };
    } else {
      // Pages Router only
      const routes = await pagesRouter(pagesDir!);
      const apiRoutes = await apiRouter(pagesDir!);
      return await staticExportPages({
        server,
        routes,
        apiRoutes,
        pagesDir: pagesDir!,
        outDir,
        config,
      });
    }
  } finally {
    await server.close();
  }
}

// -------------------------------------------------------------------
// Pre-render static pages (after production build)
// -------------------------------------------------------------------

export interface PrerenderOptions {
  root: string;
  distDir?: string;
  /** Pre-resolved next.config.js. If omitted, loaded from root. */
  config?: ResolvedNextConfig;
}

export interface PrerenderResult {
  pageCount: number;
  files: string[];
  warnings: string[];
  skipped: string[];
  /** Route pattern → runtime-confirmed classification. Primary source for printBuildReport. */
  routeClassifications: Map<string, { type: RouteType; revalidate?: number }>;
}

/**
 * Pre-render static pages after a production build.
 *
 * Detects static routes via source-file inspection (regex-based, no dev
 * server), starts a temporary production server, fetches each static page,
 * and writes the HTML to dist/server/pages/.
 *
 * Only runs for Pages Router builds. App Router builds skip pre-rendering
 * because the App Router prod server delegates entirely to the RSC handler
 * (which manages its own middleware, auth, and streaming pipeline).
 */
export async function prerenderStaticPages(options: PrerenderOptions): Promise<PrerenderResult> {
  const { root } = options;
  const distDir = options.distDir ?? path.join(root, "dist");

  // Load config to get trailingSlash (and other settings). Reuse caller's
  // resolved config when provided to avoid a redundant disk read.
  let config: ResolvedNextConfig;
  if (options.config) {
    config = options.config;
  } else {
    config = await resolveNextConfig(await loadNextConfig(root));
  }

  const result: PrerenderResult = {
    pageCount: 0,
    files: [],
    warnings: [],
    skipped: [],
    routeClassifications: new Map(),
  };

  // Bail if dist/ doesn't exist
  if (!fs.existsSync(distDir)) {
    result.warnings.push("dist/ directory not found — run `vinext build` first");
    return result;
  }

  // Detect router type from build output
  const appRouterEntry = path.join(distDir, "server", "index.js");
  const pagesRouterEntry = path.join(distDir, "server", "entry.js");
  const isAppRouter = fs.existsSync(appRouterEntry);
  const isPagesRouter = fs.existsSync(pagesRouterEntry);

  if (!isAppRouter && !isPagesRouter) {
    result.warnings.push("No server entry found in dist/ — cannot detect router type");
    return result;
  }

  // App Router prod server delegates entirely to the RSC handler which manages
  // its own middleware, auth, and streaming pipeline. Pre-rendered HTML files
  // would never be served, so skip pre-rendering for pure App Router builds.
  // Hybrid projects (app/ + pages/) still have a Pages Router entry that CAN
  // serve pre-rendered pages, so only bail out when Pages Router is absent.
  if (isAppRouter && !isPagesRouter) {
    return result;
  }

  // Collect static routes via source-file inspection (no dev server needed).
  // We scan the filesystem for routes, then read each source file to detect
  // server-side exports. This avoids spinning up a Vite dev server just for
  // route classification. Dynamic routes are skipped since they need
  // getStaticPaths execution to enumerate param values.
  const collected = await collectStaticRoutesFromSource(root);
  result.skipped.push(...collected.skipped);
  // Seed routeClassifications with all classifications from source inspection.
  // Successfully pre-rendered routes will be upgraded to "static" below.
  for (const [pattern, cls] of collected.routeClassifications) {
    result.routeClassifications.set(pattern, cls);
  }

  if (collected.urls.length === 0) {
    result.warnings.push("No static routes found — nothing to pre-render");
    return result;
  }

  const staticUrls = collected.urls;

  // Start temp production server in-process
  const { startProdServer } = await import("../server/prod-server.js");
  const server = await startProdServer({
    port: 0, // Random available port
    host: "127.0.0.1",
    outDir: distDir,
  });
  const addr = server.address() as import("node:net").AddressInfo;
  if (!addr || addr.port === 0) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("Production server failed to bind to a port for pre-rendering");
  }
  const port = addr.port;

  try {
    const pagesOutDir = path.join(distDir, "server", "pages");
    fs.mkdirSync(pagesOutDir, { recursive: true });

    for (const urlPath of staticUrls) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      try {
        const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
          signal: controller.signal,
        });

        if (!res.ok) {
          result.skipped.push(urlPath);
          // Cancel the body without awaiting — avoids throwing an AbortError
          // (which would fall into the outer catch and double-count this URL in
          // result.skipped) if the AbortController already fired.
          res.body?.cancel();
          continue;
        }

        const contentType = res.headers.get("content-type") ?? "";
        if (!contentType.includes("text/html")) {
          // Non-HTML response (e.g. a JSON API route misclassified as static).
          // Writing it as .html would produce a corrupt file — skip instead.
          result.skipped.push(`${urlPath} (non-HTML content-type: ${contentType})`);
          await res.body?.cancel();
          continue;
        }
        const html = await res.text();
        const outputPath = getOutputPath(urlPath, config.trailingSlash, pagesOutDir);
        const fullPath = path.join(pagesOutDir, outputPath);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, html, "utf-8");

        result.files.push(outputPath);
        result.pageCount++;
        // Key by urlPath (= route.pattern for non-dynamic routes, which are the
        // only ones pre-rendered here). If dynamic route pre-rendering is ever
        // added, urlPath would be /blog/hello-world while pattern is /blog/:slug
        // — at that point this set call should use route.pattern instead, and
        // the pre-rendered URL should be stored separately.
        result.routeClassifications.set(urlPath, { type: "static" });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result.skipped.push(`${urlPath} (error: ${msg})`);
      } finally {
        clearTimeout(timer);
      }
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  return result;
}

/**
 * Lightweight route collection for pre-rendering via source-file inspection.
 *
 * Scans the pages/ directory and reads each source file to detect exports
 * like getServerSideProps and revalidate, without starting a Vite dev server.
 * Dynamic routes are skipped (they need getStaticPaths execution).
 *
 * **Source tree required at pre-render time.** This function reads the original
 * TypeScript/JSX source files (e.g. `pages/about.tsx`) to detect server-side
 * exports. If the source tree is absent at deploy time — such as in a Docker
 * multi-stage build where only `dist/` is copied — pre-rendering will silently
 * produce zero routes and return early. Ensure the pages/ source directory is
 * present in any environment where pre-rendering should run.
 */
async function collectStaticRoutesFromSource(root: string): Promise<CollectedRoutes> {
  const pagesDirCandidates = [path.join(root, "pages"), path.join(root, "src", "pages")];
  const pagesDir = pagesDirCandidates.find((d) => fs.existsSync(d));
  if (!pagesDir) return { urls: [], skipped: [], routeClassifications: new Map() };

  const routes = await pagesRouter(pagesDir);
  const urls: string[] = [];
  const skipped: string[] = [];
  const routeClassifications: Map<string, { type: RouteType; revalidate?: number }> = new Map();

  for (const route of routes) {
    const routeName = path.basename(route.filePath, path.extname(route.filePath));
    if (routeName.startsWith("_")) continue;

    if (route.isDynamic) {
      skipped.push(`${route.pattern} (dynamic)`);
      // Classify as "unknown", not "ssr": skipped due to unenumerable params,
      // not because the route uses SSR APIs.
      routeClassifications.set(route.pattern, { type: "unknown" });
      continue;
    }

    try {
      // Use classifyPagesRoute as the single source of truth — it already
      // detects getServerSideProps (→ ssr), getStaticProps+revalidate (→ isr),
      // re-exported getStaticProps (→ isr, conservative), and plain static pages.
      const classification = classifyPagesRoute(route.filePath);
      routeClassifications.set(route.pattern, classification);

      if (classification.type === "ssr") {
        skipped.push(`${route.pattern} (getServerSideProps)`);
        continue;
      }

      if (classification.type === "isr") {
        skipped.push(
          `${route.pattern} (ISR — getStaticProps with revalidate${classification.revalidate != null ? `=${classification.revalidate}` : ""})`,
        );
        continue;
      }

      urls.push(route.pattern);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      skipped.push(`${route.pattern} (classification error: ${msg})`);
    }
  }

  return { urls, skipped, routeClassifications };
}

/**
 * Classify all routes in the project via static source-file analysis.
 *
 * Covers both App Router (app/) and Pages Router (pages/). Does NOT start a
 * dev server or execute any page modules — all classification is done by
 * reading source files with regex-based analysis. This means:
 *
 *   - `export const dynamic = "force-dynamic"` → ssr
 *   - `export const revalidate = 60` → isr
 *   - `getServerSideProps` → ssr
 *   - `getStaticProps` with no revalidate → static
 *   - dynamic URL pattern with no explicit config → unknown (conservative)
 *   - re-exported `getStaticProps` → isr (conservative)
 *
 * Limitation: cannot detect implicit dynamic behaviour from runtime API
 * calls (`headers()`, `cookies()`, etc.) that are invisible to static
 * analysis. Routes without explicit config are classified as "unknown"
 * rather than "static".
 *
 * This is the same analysis used internally by `prerenderStaticPages` and
 * `printBuildReport`. Exposing it as a public function lets callers build
 * the route map cheaply — without pre-rendering — and then decide what to
 * do with that information.
 */
export async function classifyRoutesFromSource(
  root: string,
): Promise<Map<string, { type: RouteType; revalidate?: number }>> {
  const routeClassifications: Map<string, { type: RouteType; revalidate?: number }> = new Map();

  // ── App Router ────────────────────────────────────────────────────────────
  const appDirCandidates = [path.join(root, "app"), path.join(root, "src", "app")];
  const appDir = appDirCandidates.find((d) => fs.existsSync(d));

  if (appDir) {
    const routes = await appRouter(appDir);
    for (const route of routes) {
      routeClassifications.set(
        route.pattern,
        classifyAppRoute(route.pagePath, route.routePath, route.isDynamic),
      );
    }
  }

  // ── Pages Router ──────────────────────────────────────────────────────────
  const pagesDirCandidates = [path.join(root, "pages"), path.join(root, "src", "pages")];
  const pagesDir = pagesDirCandidates.find((d) => fs.existsSync(d));

  if (pagesDir) {
    const [pageRoutes, apiRoutes] = await Promise.all([pagesRouter(pagesDir), apiRouter(pagesDir)]);

    for (const route of apiRoutes) {
      routeClassifications.set(route.pattern, { type: "api" });
    }

    for (const route of pageRoutes) {
      const routeName = path.basename(route.filePath, path.extname(route.filePath));
      if (routeName.startsWith("_")) continue;
      routeClassifications.set(route.pattern, classifyPagesRoute(route.filePath));
    }
  }

  return routeClassifications;
}

interface CollectedRoutes {
  urls: string[];
  skipped: string[];
  routeClassifications: Map<string, { type: RouteType; revalidate?: number }>;
}
