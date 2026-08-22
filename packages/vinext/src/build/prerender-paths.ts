import fs from "node:fs";
import path, { toSlash } from "pathslash";
import type { Server as HttpServer } from "node:http";
import {
  loadNextConfig,
  resolveNextConfig,
  type ResolvedNextConfig,
} from "../config/next-config.js";
import {
  appRouteHasMainTreeLoadingBoundary,
  appRouter,
  matchAppRoute,
} from "../routing/app-router.js";
import { apiRouter, matchRoute, pagesRouter } from "../routing/pages-router.js";
import {
  normalizeStaticPathname,
  normalizeStaticPathsEntry,
  type StaticPathsEntry,
} from "../routing/route-pattern.js";
import { getAppRouteRenderEntryPath, classifyAppRoute, classifyPagesRoute } from "./report.js";
import { buildUrlFromParams, resolveParentParams, type StaticParamsMap } from "./prerender.js";
import { readPrerenderSecret } from "./server-manifest.js";
import { startProdServer } from "../server/prod-server.js";
import { findDir } from "../utils/project.js";
import { BLOCKED_PAGES, PHASE_PRODUCTION_BUILD } from "vinext/shims/constants";
import { VINEXT_PRERENDER_SECRET_HEADER } from "../server/headers.js";
import type { VinextRouteRootConfig } from "../config/prerender.js";
import { enterPrerenderPhase } from "./prerender-phase.js";
import type { CdnCacheAdapterCapabilities } from "../cache/cache-adapters-virtual.js";
import { matchesRewriteSource } from "../config/config-matchers.js";
import { pagesRouteHasPriorityOverAppRoute } from "../server/hybrid-route-priority.js";
import { extractLocaleFromUrl, normalizeDefaultLocalePathname } from "../server/pages-i18n.js";
import { normalizePathTrailingSlash } from "vinext/shims/url-utils";

export type PrerenderPathManifest = {
  basePath?: string;
  buildId?: string;
  /** Opaque per-build identity emitted by CDN adapter page responses. */
  buildIdentity?: string;
  deploymentId?: string;
  /** Opaque per-build identity emitted by RSC responses. */
  rscBuildId?: string;
  responseVary?: CdnCacheAdapterCapabilities["responseVary"];
  /** App Router paths discovered without rendering their page responses. */
  rscPaths?: string[];
  /** App Router paths with an ordinary main-tree loading boundary. */
  loadingShellPaths?: string[];
  /** Pages Router paths selected by the existing HTML warm discovery pass. */
  pagesPaths?: string[];
  /** Public paths omitted because configured routes can replace their page response. */
  excludedWarmPaths?: string[];
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
  buildIdentity?: CdnCacheAdapterCapabilities["buildIdentity"];
  responseVary?: CdnCacheAdapterCapabilities["responseVary"];
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

function readBuiltRscBuildId(serverDir: string): string | null {
  try {
    const buildId = fs.readFileSync(path.join(serverDir, "RSC_BUILD_ID"), "utf-8").trim();
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

function throwDiscoveryFailure(route: string, error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  throw new Error(`Failed to discover warmup path(s) for ${route}: ${message}`, { cause: error });
}

function validatePagesStaticPathsResult(
  value: unknown,
  route: string,
): { fallback: boolean | "blocking"; paths: StaticPathsEntry[] } {
  const expected = "Expected { paths: [], fallback: boolean | 'blocking' }.";
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid value returned from getStaticPaths for ${route}. ${expected}`);
  }

  const result = value as Record<string, unknown>;
  const extraKeys = Object.keys(result).filter((key) => key !== "paths" && key !== "fallback");
  if (extraKeys.length > 0) {
    throw new Error(
      `Extra key(s) returned from getStaticPaths for ${route}: ${extraKeys.join(", ")}. ${expected}`,
    );
  }
  if (typeof result.fallback !== "boolean" && result.fallback !== "blocking") {
    throw new Error(`Invalid fallback returned from getStaticPaths for ${route}. ${expected}`);
  }
  if (!Array.isArray(result.paths)) {
    throw new Error(
      `Invalid paths returned from getStaticPaths for ${route}; paths must be an array.`,
    );
  }

  return {
    fallback: result.fallback,
    paths: result.paths as StaticPathsEntry[],
  };
}

type DynamicPatternParam = { name: string; optional: boolean; repeat: boolean };

function hasUnsafeRawUrlPathCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code === 92 || code <= 31 || code === 127) return true;
  }
  return false;
}

function getDynamicPatternParams(pattern: string): DynamicPatternParam[] {
  return pattern
    .split("/")
    .filter((segment) => segment.startsWith(":"))
    .map((segment) => ({
      name: segment.slice(1, segment.endsWith("+") || segment.endsWith("*") ? -1 : undefined),
      optional: segment.endsWith("*"),
      repeat: segment.endsWith("+") || segment.endsWith("*"),
    }));
}

function validateDiscoveredParams(
  value: unknown,
  pattern: string,
  source: "generateStaticParams" | "getStaticPaths",
): Record<string, string | string[]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${source} must return parameter objects for ${pattern}.`);
  }

  const params = { ...(value as Record<string, unknown>) };
  for (const { name, optional, repeat } of getDynamicPatternParams(pattern)) {
    const hasValue = Object.prototype.hasOwnProperty.call(params, name);
    let paramValue = params[name];
    if (
      optional &&
      hasValue &&
      (paramValue === null || paramValue === undefined || paramValue === false)
    ) {
      paramValue = [];
      params[name] = paramValue;
    }
    const valid = repeat
      ? Array.isArray(paramValue) && paramValue.every((entry) => typeof entry === "string")
      : typeof paramValue === "string";
    if (!valid) {
      throw new Error(
        `Parameter ${name} from ${source} for ${pattern} must be ${repeat ? "an array of strings" : "a string"}.`,
      );
    }
    const values = Array.isArray(paramValue) ? paramValue : [paramValue];
    if (values.some((entry) => entry === "." || entry === "..")) {
      throw new Error(
        `Parameter ${name} from ${source} for ${pattern} must not contain dot path segments.`,
      );
    }
  }
  return params as Record<string, string | string[]>;
}

function validatePagesStaticPathsEntry(entry: StaticPathsEntry, pattern: string): StaticPathsEntry {
  if (typeof entry === "string") {
    if (
      !entry.startsWith("/") ||
      entry.includes("//") ||
      entry.includes("?") ||
      entry.includes("#") ||
      hasUnsafeRawUrlPathCharacter(entry)
    ) {
      throw new Error(
        `The provided path \`${entry}\` from getStaticPaths does not match the route pattern \`${pattern}\`.`,
      );
    }
    let decodedSegments: string[];
    try {
      decodedSegments = entry.split("/").map((segment) => decodeURIComponent(segment));
    } catch {
      throw new Error(
        `The provided path \`${entry}\` from getStaticPaths contains malformed percent-encoding.`,
      );
    }
    if (decodedSegments.some((segment) => segment === "." || segment === "..")) {
      throw new Error(
        `The provided path \`${entry}\` from getStaticPaths contains a dot path segment.`,
      );
    }
    return entry;
  }
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;

  const extraKeys = Object.keys(entry).filter((key) => key !== "params" && key !== "locale");
  if (extraKeys.length > 0) {
    throw new Error(
      `Additional key(s) returned from getStaticPaths for ${pattern}: ${extraKeys.join(", ")}.`,
    );
  }
  if (entry.locale !== undefined && typeof entry.locale !== "string") {
    throw new Error(`Invalid locale returned from getStaticPaths for ${pattern}.`);
  }
  return {
    ...entry,
    params: validateDiscoveredParams(entry.params, pattern, "getStaticPaths"),
  };
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
    if (!res.ok) throw new Error(`path discovery returned HTTP ${res.status}`);
    if (res.status === 204) return null;
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

async function shouldStartPathDiscoveryServer(options: {
  appDir: string | null;
  pagesDir: string | null;
  pageExtensions: readonly string[];
}): Promise<boolean> {
  if (options.appDir) {
    const routes = await appRouter(options.appDir, options.pageExtensions);
    if (routes.some((route) => route.isDynamic)) return true;
  }

  if (options.pagesDir) {
    const routes = await pagesRouter(options.pagesDir, options.pageExtensions);
    if (routes.some((route) => route.isDynamic)) return true;
  }

  return false;
}

async function withPrerenderEndpoints<T>(fn: () => Promise<T>): Promise<T> {
  const restorePrerenderPhase = enterPrerenderPhase();
  const previousPathDiscoveryFlag = process.env[PRERENDER_PATH_DISCOVERY_ENV];
  process.env[PRERENDER_PATH_DISCOVERY_ENV] = "1";
  try {
    return await fn();
  } finally {
    restorePrerenderPhase();
    if (previousPathDiscoveryFlag === undefined) delete process.env[PRERENDER_PATH_DISCOVERY_ENV];
    else process.env[PRERENDER_PATH_DISCOVERY_ENV] = previousPathDiscoveryFlag;
  }
}

async function collectPagesPaths(options: {
  baseUrl: string | null;
  i18n: ResolvedNextConfig["i18n"];
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
      if (options.i18n) {
        for (const locale of options.i18n.locales) {
          addPath(paths, seen, localizePagesPath(route.pattern, locale, options.i18n));
        }
      } else {
        addPath(paths, seen, route.pattern);
      }
      continue;
    }

    if (!options.baseUrl) continue;

    try {
      const search = new URLSearchParams({ pattern: route.pattern });
      if (options.i18n) {
        search.set("locales", JSON.stringify(options.i18n.locales));
        search.set("defaultLocale", options.i18n.defaultLocale);
      }
      const text = await fetchDiscoveryEndpoint(
        `${options.baseUrl}/__vinext/prerender/pages-static-paths?${search}`,
        options.secretHeaders,
      );
      if (text === null) {
        continue;
      }

      const pathsResult = validatePagesStaticPathsResult(JSON.parse(text), route.pattern);
      for (const item of pathsResult.paths) {
        const validatedItem = validatePagesStaticPathsEntry(item, route.pattern);
        let itemToNormalize = validatedItem;
        let locale = options.i18n?.defaultLocale;
        if (options.i18n && typeof validatedItem === "string") {
          const localeInfo = extractPagesStaticPathLocale(validatedItem, options.i18n);
          itemToNormalize = localeInfo.url;
        } else if (
          options.i18n &&
          validatedItem &&
          typeof validatedItem === "object" &&
          validatedItem.locale
        ) {
          if (!options.i18n.locales.includes(validatedItem.locale)) {
            throw new Error(
              `Invalid locale returned from getStaticPaths for ${route.pattern}: ${validatedItem.locale}`,
            );
          }
          locale = validatedItem.locale;
        }

        const normalized = normalizeStaticPathsEntry(itemToNormalize, route.pattern);
        if ("error" in normalized) {
          throw new Error(normalized.error);
        }
        const pathname =
          typeof validatedItem === "string"
            ? normalizeStaticPathname(validatedItem)
            : localizePagesPath(
                buildUrlFromParams(route.pattern, normalized.params),
                locale,
                options.i18n,
              );
        addPath(paths, seen, pathname);
      }
    } catch (error) {
      throwDiscoveryFailure(route.pattern, error);
    }
  }

  return paths;
}

async function excludePagesApiWarmPaths(options: {
  i18n: ResolvedNextConfig["i18n"];
  pagesDir: string;
  pageExtensions: readonly string[];
  paths: readonly string[];
}): Promise<string[]> {
  const apiRoutes = await apiRouter(options.pagesDir, options.pageExtensions);
  return options.paths.filter((pathname) => {
    const pagesPathname = options.i18n
      ? extractLocaleFromUrl(pathname, options.i18n).url
      : pathname;
    if (pagesPathname !== "/api" && !pagesPathname.startsWith("/api/")) return true;
    return matchRoute(pagesPathname, apiRoutes) === null;
  });
}

function localizePagesPath(
  pathname: string,
  locale: string | undefined,
  i18n: ResolvedNextConfig["i18n"],
): string {
  if (!i18n || !locale || locale === i18n.defaultLocale) return pathname;
  return pathname === "/" ? `/${locale}` : `/${locale}${pathname}`;
}

function extractPagesStaticPathLocale(
  url: string,
  i18n: NonNullable<ResolvedNextConfig["i18n"]>,
): { explicitLocalePrefix?: string; locale: string; url: string } {
  const queryIndex = url.indexOf("?");
  const pathname = queryIndex === -1 ? url : url.slice(0, queryIndex);
  const query = queryIndex === -1 ? "" : url.slice(queryIndex);
  const parts = pathname.split("/").filter(Boolean);
  const locale =
    parts.length > 0
      ? i18n.locales.find((candidate) => candidate.toLowerCase() === parts[0].toLowerCase())
      : undefined;
  if (!locale) return extractLocaleFromUrl(url, i18n);
  const rest = `/${parts.slice(1).join("/")}`;
  return { explicitLocalePrefix: parts[0], locale, url: `${rest || "/"}${query}` };
}

async function collectAppPaths(options: {
  appDir: string;
  baseUrl: string | null;
  pageExtensions: readonly string[];
  secretHeaders: Record<string, string>;
}): Promise<{ loadingShellPaths: string[]; paths: string[] }> {
  const routes = await appRouter(options.appDir, options.pageExtensions);
  const paths: string[] = [];
  const seen = new Set<string>();
  const loadingShellPaths: string[] = [];
  const seenLoadingShellPaths = new Set<string>();
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
          const value = JSON.parse(text) as unknown;
          if (!Array.isArray(value)) {
            throw new Error(`generateStaticParams must return an array for ${pattern}.`);
          }
          return value.map((entry) => {
            if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
              throw new Error(`generateStaticParams must return parameter objects for ${pattern}.`);
            }
            return validateDiscoveredParams(
              { ...params, ...(entry as Record<string, unknown>) },
              pattern,
              "generateStaticParams",
            );
          });
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

    const hasMainTreeLoadingBoundary = appRouteHasMainTreeLoadingBoundary(route);
    const addDiscoveredPath = (pathname: string): void => {
      addPath(paths, seen, pathname);
      if (hasMainTreeLoadingBoundary) {
        addPath(loadingShellPaths, seenLoadingShellPaths, pathname);
      }
    };

    if (!route.isDynamic) {
      addDiscoveredPath(route.pattern);
      continue;
    }

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
        if (results === null) {
          const layoutParamSets = await resolveParentParams(route, staticParamsMap, {
            includeLastDynamicSegment: true,
          });
          paramSets = layoutParamSets.length > 0 ? layoutParamSets : null;
        } else {
          paramSets = Array.isArray(results) ? results : [];
        }
      }

      if (!paramSets?.length) continue;

      for (const params of paramSets) {
        if (params === null || params === undefined) continue;
        addDiscoveredPath(buildUrlFromParams(route.pattern, params));
      }
    } catch (error) {
      throwDiscoveryFailure(route.pattern, error);
    }
  }

  return { loadingShellPaths, paths };
}

async function resolveAppWarmPaths(options: {
  appDir: string;
  i18n: ResolvedNextConfig["i18n"];
  pagesDir: string | null;
  pageExtensions: readonly string[];
  paths: readonly string[];
}): Promise<{ htmlPaths: string[]; loadingShellPaths: string[]; rscPaths: string[] }> {
  const appRoutes = await appRouter(options.appDir, options.pageExtensions);
  const [pageRoutes, apiRoutes] = options.pagesDir
    ? await Promise.all([
        pagesRouter(options.pagesDir, options.pageExtensions),
        apiRouter(options.pagesDir, options.pageExtensions),
      ])
    : [[], []];

  const rscPaths: string[] = [];
  const htmlPaths: string[] = [];
  const loadingShellPaths: string[] = [];
  for (const pathname of options.paths) {
    const appMatch = matchAppRoute(pathname, appRoutes);
    // Pages Router i18n prefixes are routing metadata rather than part of the
    // filesystem route. Production strips them before matching Pages/API
    // routes, while the App Router still matches the original pathname.
    const pagesPathname = options.i18n
      ? extractLocaleFromUrl(pathname, options.i18n).url
      : pathname;
    // The App-to-Pages production bridge selects the API handler from the raw
    // request pathname before the Pages matcher strips i18n metadata. A
    // locale-prefixed `/fr/api/*` path therefore remains a page candidate,
    // rather than becoming a Pages API request after normalization.
    const isPagesApiRequest = pathname === "/api" || pathname.startsWith("/api/");
    const pagesMatch = matchRoute(pagesPathname, isPagesApiRequest ? apiRoutes : pageRoutes);
    if (
      pagesMatch &&
      (!appMatch || pagesRouteHasPriorityOverAppRoute(pagesMatch.route, appMatch.route))
    ) {
      if (!isPagesApiRequest) htmlPaths.push(pathname);
      continue;
    }
    if (!appMatch) continue;

    // The trie returns the exact object from appRoutes. Its public matcher type
    // exposes the shared AppRoute fields, so recover the graph-owned metadata
    // here without rescanning the route table for every concrete path.
    const matchedAppRoute = appMatch.route as (typeof appRoutes)[number];
    const appRenderEntryPath = getAppRouteRenderEntryPath(matchedAppRoute);
    if (!appRenderEntryPath) continue;
    if (
      classifyAppRoute(appRenderEntryPath, matchedAppRoute.routePath, matchedAppRoute.isDynamic)
        .type === "api"
    ) {
      continue;
    }

    htmlPaths.push(pathname);
    rscPaths.push(pathname);
    if (appRouteHasMainTreeLoadingBoundary(matchedAppRoute)) {
      loadingShellPaths.push(pathname);
    }
  }
  return { htmlPaths, loadingShellPaths, rscPaths };
}

function configuredRouteAffectsWarmPath(
  pathname: string,
  config: Pick<
    ResolvedNextConfig,
    "basePath" | "i18n" | "redirects" | "rewrites" | "trailingSlash"
  >,
): boolean {
  const canonicalPathname = normalizePathTrailingSlash(pathname, config.trailingSlash);
  const hostnames = [undefined, ...(config.i18n?.domains?.map((domain) => domain.domain) ?? [])];
  const matchPathnames = new Set(
    hostnames.map((hostname) =>
      normalizeDefaultLocalePathname(canonicalPathname, config.i18n, { hostname }),
    ),
  );
  const rewrites = [
    ...config.rewrites.beforeFiles,
    ...config.rewrites.afterFiles,
    ...config.rewrites.fallback,
  ];
  return [...rewrites, ...config.redirects].some((rule) =>
    Array.from(matchPathnames).some((matchPathname) =>
      matchesRewriteSource(matchPathname, rule, {
        basePath: config.basePath,
        hadBasePath: true,
      }),
    ),
  );
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
  const rscBuildId = readBuiltRscBuildId(manifestDir) ?? readBuiltRscBuildId(bundleServerDir);
  if (builtBuildId) {
    config.buildId = builtBuildId;
  }

  const paths: string[] = [];
  const seen = new Set<string>();
  const discoveredPagesPaths: string[] = [];
  const seenPagesPaths = new Set<string>();
  const discoveredAppPaths: string[] = [];
  const seenAppPaths = new Set<string>();
  const discoveredLoadingShellPaths: string[] = [];
  const seenLoadingShellPaths = new Set<string>();
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
        throw new Error(`Failed to start prerender path discovery server: ${message}`, {
          cause: error,
        });
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
        const appPathResult = await collectAppPaths({
          appDir,
          baseUrl,
          pageExtensions: config.pageExtensions,
          secretHeaders,
        });
        for (const pathname of appPathResult.paths) {
          addPath(paths, seen, pathname);
          addPath(discoveredAppPaths, seenAppPaths, pathname);
        }
        for (const pathname of appPathResult.loadingShellPaths) {
          addPath(discoveredLoadingShellPaths, seenLoadingShellPaths, pathname);
        }
      }

      if (pagesDir) {
        for (const pathname of await collectPagesPaths({
          baseUrl,
          i18n: config.i18n,
          pagesDir,
          pageExtensions: config.pageExtensions,
          secretHeaders,
        })) {
          addPath(paths, seen, pathname);
          addPath(discoveredPagesPaths, seenPagesPaths, pathname);
        }
      }
    } finally {
      if (prodServer) {
        await new Promise<void>((resolve) => prodServer!.server.close(() => resolve()));
      }
    }
  });

  const excludedWarmPathSet = new Set(
    options.responseVary
      ? paths.filter((pathname) => configuredRouteAffectsWarmPath(pathname, config))
      : [],
  );
  const configuredPagesWarmPaths = discoveredPagesPaths.filter(
    (pathname) => !excludedWarmPathSet.has(pathname),
  );
  const resolvedPagesWarmPaths =
    !appDir && pagesDir
      ? await excludePagesApiWarmPaths({
          i18n: config.i18n,
          pagesDir,
          pageExtensions: config.pageExtensions,
          paths: configuredPagesWarmPaths,
        })
      : configuredPagesWarmPaths;
  const configuredCandidatePaths = paths.filter((pathname) => !excludedWarmPathSet.has(pathname));
  const appOwnedWarmPaths = appDir
    ? await resolveAppWarmPaths({
        appDir,
        i18n: config.i18n,
        pagesDir,
        pageExtensions: config.pageExtensions,
        paths: configuredCandidatePaths,
      })
    : {
        htmlPaths: discoveredAppPaths,
        loadingShellPaths: discoveredLoadingShellPaths,
        rscPaths: discoveredAppPaths,
      };
  const warmPaths = appDir ? appOwnedWarmPaths.htmlPaths : resolvedPagesWarmPaths;

  const manifest: PrerenderPathManifest = {
    ...(config.basePath ? { basePath: config.basePath } : {}),
    buildId: config.buildId,
    ...(rscBuildId && options.buildIdentity === "response-header"
      ? { buildIdentity: rscBuildId }
      : {}),
    ...(config.deploymentId ? { deploymentId: config.deploymentId } : {}),
    ...(pagesDir
      ? {
          pagesPaths: resolvedPagesWarmPaths,
        }
      : {}),
    ...(excludedWarmPathSet.size > 0 ? { excludedWarmPaths: Array.from(excludedWarmPathSet) } : {}),
    ...(rscBuildId ? { rscBuildId } : {}),
    ...(options.responseVary ? { responseVary: options.responseVary } : {}),
    ...(options.responseVary ? { rscPaths: appOwnedWarmPaths.rscPaths } : {}),
    ...(options.responseVary ? { loadingShellPaths: appOwnedWarmPaths.loadingShellPaths } : {}),
    trailingSlash: config.trailingSlash,
    paths: warmPaths,
  };
  fs.mkdirSync(manifestDir, { recursive: true });
  fs.writeFileSync(
    path.join(manifestDir, PRERENDER_PATHS_MANIFEST),
    JSON.stringify(manifest, null, 2) + "\n",
    "utf-8",
  );
  console.log(`  Discovered ${warmPaths.length} CDN warmup path(s).`);

  return manifest;
}
