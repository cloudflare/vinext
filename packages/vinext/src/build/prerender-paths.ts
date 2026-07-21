import fs from "node:fs";
import path, { toSlash } from "pathslash";
import type { Server as HttpServer } from "node:http";
import {
  loadNextConfig,
  resolveNextConfig,
  type ResolvedNextConfig,
} from "../config/next-config.js";
import { appRouter } from "../routing/app-router.js";
import { apiRouter, pagesRouter } from "../routing/pages-router.js";
import { normalizeStaticPathsEntry, type StaticPathsEntry } from "../routing/route-pattern.js";
import {
  getAppRouteRenderEntryPath,
  classifyAppRoute,
  classifyPagesRoute,
  hasNamedExport,
} from "./report.js";
import { buildUrlFromParams, resolveParentParams, type StaticParamsMap } from "./prerender.js";
import { readPrerenderSecret } from "./server-manifest.js";
import { startProdServer } from "../server/prod-server.js";
import { findDir } from "../utils/project.js";
import { BLOCKED_PAGES, PHASE_PRODUCTION_BUILD } from "vinext/shims/constants";
import { VINEXT_PRERENDER_SECRET_HEADER } from "../server/headers.js";
import type { VinextRouteRootConfig } from "../config/prerender.js";

export type PrerenderPathManifest = {
  buildId?: string;
  trailingSlash?: boolean;
  paths: string[];
};

export const PRERENDER_PATH_DISCOVERY_ENV = "__VINEXT_PRERENDER_PATH_DISCOVERY";
export const PRERENDER_PATHS_MANIFEST = "vinext-prerender-paths.json";

const PATH_DISCOVERY_FETCH_TIMEOUT_MS = 30_000;

type EmitPrerenderPathManifestOptions = {
  root: string;
  /** Fully resolved Next.js config. Loaded from disk when omitted. */
  nextConfig?: ResolvedNextConfig;
  appDir?: string | null;
  pagesDir?: string | null;
  routeRootConfig?: VinextRouteRootConfig | null;
  pagesBundlePath?: string;
  rscBundlePath?: string;
};

function readBuiltBuildId(serverDir: string): string | null {
  try {
    const buildId = fs.readFileSync(path.join(serverDir, "BUILD_ID"), "utf-8").trim();
    return buildId.length > 0 ? buildId : null;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function addPath(paths: string[], seen: Set<string>, pathname: string): void {
  if (seen.has(pathname)) return;
  seen.add(pathname);
  paths.push(pathname);
}

function warnDiscoveryFailure(route: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`[vinext] Warning: failed to discover warmup path(s) for ${route}: ${message}`);
}

async function fetchDiscoveryEndpoint(
  url: string,
  headers: Record<string, string>,
): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PATH_DISCOVERY_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers,
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok || text === "null") return null;
    return text;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`path discovery timed out after ${PATH_DISCOVERY_FETCH_TIMEOUT_MS}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function fileHasNamedExport(filePath: string | null | undefined, name: string): boolean {
  if (!filePath) return false;
  try {
    return hasNamedExport(fs.readFileSync(filePath, "utf-8"), name);
  } catch {
    return false;
  }
}

function resolveConfiguredRouteDirs(
  root: string,
  routeRootConfig: VinextRouteRootConfig | null | undefined,
): { appDir: string | null; pagesDir: string | null } {
  if (!routeRootConfig) {
    return {
      appDir: findDir(root, "app", "src/app"),
      pagesDir: findDir(root, "pages", "src/pages"),
    };
  }

  let baseDir: string;
  if (routeRootConfig.appDir) {
    baseDir = path.isAbsolute(routeRootConfig.appDir)
      ? routeRootConfig.appDir
      : path.resolve(root, routeRootConfig.appDir);
    // The absolute branch above is the user-supplied appDir verbatim, which
    // may carry native separators on Windows.
    baseDir = toSlash(baseDir);
  } else {
    const hasRootApp = fs.existsSync(path.join(root, "app"));
    const hasRootPages = fs.existsSync(path.join(root, "pages"));
    const hasSrcApp = fs.existsSync(path.join(root, "src", "app"));
    const hasSrcPages = fs.existsSync(path.join(root, "src", "pages"));
    baseDir =
      hasRootApp || hasRootPages ? root : hasSrcApp || hasSrcPages ? path.join(root, "src") : root;
  }

  const appDir = path.join(baseDir, "app");
  const pagesDir = path.join(baseDir, "pages");
  return {
    appDir: !routeRootConfig.disableAppRouter && fs.existsSync(appDir) ? appDir : null,
    pagesDir: fs.existsSync(pagesDir) ? pagesDir : null,
  };
}

function appRouteMayHaveGenerateStaticParams(route: Awaited<ReturnType<typeof appRouter>>[number]) {
  if (fileHasNamedExport(route.pagePath, "generateStaticParams")) return true;
  return route.layouts.some((layoutPath) => fileHasNamedExport(layoutPath, "generateStaticParams"));
}

async function shouldStartPathDiscoveryServer(options: {
  appDir: string | null;
  pagesDir: string | null;
  pageExtensions: readonly string[];
}): Promise<boolean> {
  if (options.appDir) {
    const routes = await appRouter(options.appDir, options.pageExtensions);
    if (routes.some((route) => route.isDynamic && appRouteMayHaveGenerateStaticParams(route))) {
      return true;
    }
  }

  if (options.pagesDir) {
    const routes = await pagesRouter(options.pagesDir, options.pageExtensions);
    if (
      routes.some(
        (route) => route.isDynamic && fileHasNamedExport(route.filePath, "getStaticPaths"),
      )
    ) {
      return true;
    }
  }

  return false;
}

async function withPrerenderEndpoints<T>(fn: () => Promise<T>): Promise<T> {
  const previousPrerenderFlag = process.env.VINEXT_PRERENDER;
  const previousPathDiscoveryFlag = process.env[PRERENDER_PATH_DISCOVERY_ENV];
  process.env.VINEXT_PRERENDER = "1";
  process.env[PRERENDER_PATH_DISCOVERY_ENV] = "1";
  try {
    return await fn();
  } finally {
    if (previousPrerenderFlag === undefined) delete process.env.VINEXT_PRERENDER;
    else process.env.VINEXT_PRERENDER = previousPrerenderFlag;
    if (previousPathDiscoveryFlag === undefined) delete process.env[PRERENDER_PATH_DISCOVERY_ENV];
    else process.env[PRERENDER_PATH_DISCOVERY_ENV] = previousPathDiscoveryFlag;
  }
}

async function collectPagesPaths(options: {
  baseUrl: string | null;
  pagesDir: string;
  pageExtensions: readonly string[];
  secretHeaders: Record<string, string>;
}): Promise<string[]> {
  const [pageRoutes, apiRoutes] = await Promise.all([
    pagesRouter(options.pagesDir, options.pageExtensions),
    apiRouter(options.pagesDir, options.pageExtensions),
  ]);
  const apiPatterns = new Set(apiRoutes.map((route) => route.pattern));
  const paths: string[] = [];
  const seen = new Set<string>();

  for (const route of pageRoutes) {
    if (apiPatterns.has(route.pattern)) continue;
    if (BLOCKED_PAGES.includes(route.pattern)) continue;
    if (route.pattern === "/404" || route.pattern === "/500" || route.pattern === "/_error") {
      continue;
    }

    const { type } = classifyPagesRoute(route.filePath);
    if (type === "api" || type === "ssr") continue;

    if (!route.isDynamic) {
      addPath(paths, seen, route.pattern);
      continue;
    }

    if (!fileHasNamedExport(route.filePath, "getStaticPaths")) continue;
    if (!options.baseUrl) continue;

    try {
      const search = new URLSearchParams({ pattern: route.pattern });
      const text = await fetchDiscoveryEndpoint(
        `${options.baseUrl}/__vinext/prerender/pages-static-paths?${search}`,
        options.secretHeaders,
      );
      if (text === null) continue;

      const pathsResult = JSON.parse(text) as {
        paths?: Array<StaticPathsEntry>;
        fallback?: unknown;
      };
      for (const item of pathsResult.paths ?? []) {
        const normalized = normalizeStaticPathsEntry(item, route.pattern);
        if ("error" in normalized) {
          throw new Error(normalized.error);
        }
        addPath(paths, seen, buildUrlFromParams(route.pattern, normalized.params));
      }
    } catch (error) {
      warnDiscoveryFailure(route.pattern, error);
    }
  }

  return paths;
}

async function collectAppPaths(options: {
  appDir: string;
  baseUrl: string | null;
  pageExtensions: readonly string[];
  secretHeaders: Record<string, string>;
}): Promise<string[]> {
  const routes = await appRouter(options.appDir, options.pageExtensions);
  const paths: string[] = [];
  const seen = new Set<string>();
  const staticParamsCache = new Map<string, Promise<Record<string, string | string[]>[] | null>>();
  const staticParamsMap = new Proxy({} as StaticParamsMap, {
    get(_target, pattern: string) {
      return async ({ params }: { params: Record<string, string | string[]> }) => {
        if (!options.baseUrl) return null;
        const cacheKey = `${pattern}\0${JSON.stringify(params)}`;
        const cached = staticParamsCache.get(cacheKey);
        if (cached !== undefined) return cached;
        const request = (async () => {
          const search = new URLSearchParams({ pattern });
          if (Object.keys(params).length > 0) {
            search.set("parentParams", JSON.stringify(params));
          }
          const text = await fetchDiscoveryEndpoint(
            `${options.baseUrl}/__vinext/prerender/static-params?${search}`,
            options.secretHeaders,
          );
          if (text === null) return null;
          return JSON.parse(text) as Record<string, string | string[]>[];
        })();
        void request.catch(() => staticParamsCache.delete(cacheKey));
        staticParamsCache.set(cacheKey, request);
        return request;
      };
    },
    has() {
      return false;
    },
  });

  for (const route of routes) {
    const renderEntryPath = getAppRouteRenderEntryPath(route);
    if (!renderEntryPath) continue;

    const { type } = classifyAppRoute(renderEntryPath, route.routePath, route.isDynamic);
    if (type === "api") continue;

    const isConfiguredDynamic = type === "ssr" && !route.isDynamic;
    if (isConfiguredDynamic) continue;

    if (!route.isDynamic) {
      addPath(paths, seen, route.pattern);
      continue;
    }

    if (!appRouteMayHaveGenerateStaticParams(route)) continue;
    try {
      const generateStaticParams = staticParamsMap[route.pattern];
      if (typeof generateStaticParams !== "function") continue;

      const parentParamSets = await resolveParentParams(route, staticParamsMap);
      let paramSets: Record<string, string | string[]>[] | null;

      if (parentParamSets.length > 0) {
        paramSets = [];
        for (const parentParams of parentParamSets) {
          const childResults = await generateStaticParams({ params: parentParams });
          if (childResults === null) {
            paramSets = null;
            break;
          }
          if (Array.isArray(childResults)) {
            for (const childParams of childResults) {
              paramSets.push({ ...parentParams, ...childParams });
            }
          }
        }
      } else {
        const results = await generateStaticParams({ params: {} });
        paramSets = Array.isArray(results) || results === null ? results : [];
      }

      if (!paramSets?.length) continue;

      for (const params of paramSets) {
        if (params === null || params === undefined) continue;
        addPath(paths, seen, buildUrlFromParams(route.pattern, params));
      }
    } catch (error) {
      warnDiscoveryFailure(route.pattern, error);
    }
  }

  return paths;
}

async function startPathDiscoveryServer(options: {
  serverDir: string;
  pagesBundlePath?: string;
  rscBundlePath?: string;
}): Promise<{ server: HttpServer; port: number }> {
  return startProdServer({
    port: 0,
    host: "127.0.0.1",
    outDir: options.pagesBundlePath
      ? path.dirname(path.dirname(options.pagesBundlePath))
      : path.dirname(options.serverDir),
    rscEntryPath: options.rscBundlePath,
    serverEntryPath: options.pagesBundlePath,
    noCompression: true,
    purpose: "prerender",
  });
}

export async function emitPrerenderPathManifest(
  options: EmitPrerenderPathManifestOptions,
): Promise<PrerenderPathManifest | null> {
  const { root } = options;
  const configuredRouteDirs = resolveConfiguredRouteDirs(root, options.routeRootConfig);
  const appDir = options.appDir !== undefined ? options.appDir : configuredRouteDirs.appDir;
  const pagesDir = options.pagesDir !== undefined ? options.pagesDir : configuredRouteDirs.pagesDir;

  if (!appDir && !pagesDir) return null;

  const defaultRscBundlePath = options.routeRootConfig?.rscOutDir
    ? path.join(path.resolve(root, options.routeRootConfig.rscOutDir), "index.js")
    : path.join(root, "dist", "server", "index.js");
  const rscBundlePath = options.rscBundlePath ?? defaultRscBundlePath;
  const pagesBundlePath = options.pagesBundlePath ?? path.join(root, "dist", "server", "entry.js");
  const bundleServerDir = fs.existsSync(rscBundlePath)
    ? path.dirname(rscBundlePath)
    : path.dirname(pagesBundlePath);
  const manifestDir = path.join(root, "dist", "server");
  const config = options.nextConfig
    ? { ...options.nextConfig }
    : { ...(await resolveNextConfig(await loadNextConfig(root, PHASE_PRODUCTION_BUILD), root)) };
  const builtBuildId = readBuiltBuildId(manifestDir) ?? readBuiltBuildId(bundleServerDir);
  if (builtBuildId) {
    config.buildId = builtBuildId;
  }

  const paths: string[] = [];
  const seen = new Set<string>();
  await withPrerenderEndpoints(async () => {
    let prodServer: { server: HttpServer; port: number } | null = null;
    const needsServer = await shouldStartPathDiscoveryServer({
      appDir,
      pagesDir,
      pageExtensions: config.pageExtensions,
    });
    if (needsServer) {
      try {
        prodServer = await startPathDiscoveryServer({
          serverDir: bundleServerDir,
          pagesBundlePath: !appDir && pagesDir ? pagesBundlePath : undefined,
          rscBundlePath: appDir ? rscBundlePath : undefined,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(
          `[vinext] Warning: failed to start prerender path discovery server: ${message}`,
        );
      }
    }

    const baseUrl = prodServer ? `http://127.0.0.1:${prodServer.port}` : null;
    const prerenderSecret =
      readPrerenderSecret(bundleServerDir) ?? readPrerenderSecret(manifestDir);
    const secretHeaders: Record<string, string> = prerenderSecret
      ? { [VINEXT_PRERENDER_SECRET_HEADER]: prerenderSecret }
      : {};

    try {
      if (appDir) {
        for (const pathname of await collectAppPaths({
          appDir,
          baseUrl,
          pageExtensions: config.pageExtensions,
          secretHeaders,
        })) {
          addPath(paths, seen, pathname);
        }
      }

      if (pagesDir) {
        for (const pathname of await collectPagesPaths({
          baseUrl,
          pagesDir,
          pageExtensions: config.pageExtensions,
          secretHeaders,
        })) {
          addPath(paths, seen, pathname);
        }
      }
    } finally {
      if (prodServer) {
        await new Promise<void>((resolve) => prodServer!.server.close(() => resolve()));
      }
    }
  });

  const manifest: PrerenderPathManifest = {
    buildId: config.buildId,
    trailingSlash: config.trailingSlash,
    paths,
  };
  fs.mkdirSync(manifestDir, { recursive: true });
  fs.writeFileSync(
    path.join(manifestDir, PRERENDER_PATHS_MANIFEST),
    JSON.stringify(manifest, null, 2) + "\n",
    "utf-8",
  );
  console.log(`  Discovered ${paths.length} CDN warmup path(s).`);

  return manifest;
}
