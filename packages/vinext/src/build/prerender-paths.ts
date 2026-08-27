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
import {
  getAppRouteRenderEntryPath,
  classifyAppRoute,
  classifyAppRouteHandler,
  classifyPagesRoute,
  extractExportConstString,
} from "./report.js";
import { buildUrlFromParams, resolveParentParams, type StaticParamsMap } from "./prerender.js";
import { readPrerenderSecret } from "./server-manifest.js";
import { startProdServer } from "../server/prod-server.js";
import { findDir } from "../utils/project.js";
import { BLOCKED_PAGES, PHASE_PRODUCTION_BUILD } from "vinext/shims/constants";
import { VINEXT_PRERENDER_SECRET_HEADER } from "../server/headers.js";
import type { VinextRouteRootConfig } from "../config/prerender.js";
import { enterPrerenderPhase } from "./prerender-phase.js";
import type { CdnCacheAdapterCapabilities } from "../cache/cache-adapters-virtual.js";
import { matchHeaders, matchesRewriteSource } from "../config/config-matchers.js";
import { pagesRouteHasPriorityOverAppRoute } from "../server/hybrid-route-priority.js";
import { resolveAppPageDynamicConfig } from "../server/app-segment-config.js";
import { extractLocaleFromUrl, normalizeDefaultLocalePathname } from "../server/pages-i18n.js";
import { normalizePathTrailingSlash } from "vinext/shims/url-utils";
import { buildPagesDataHref } from "vinext/shims/internal/pages-data-url";
import { CACHEABILITY_POLICY_HEADERS } from "vinext/shims/cacheability-classification";

export type PrerenderRoutePattern = {
  kind: "app-page" | "app-route" | "pages-page";
  pattern: string;
  /** Closed-world safety facts for probe coordinator optimizations. */
  cacheabilityProbe?: {
    canPrunePattern: boolean;
    /** HTML pathname shared by alternate representations of this route. */
    concretePathname?: string;
  };
};

export type PrerenderPathManifest = {
  /** App Page HTML paths after hybrid route ownership has been resolved. */
  appPaths?: string[];
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
  /** Statically eligible App Route Handler request paths. */
  routeHandlerPaths?: string[];
  /** App Router paths with an ordinary main-tree loading boundary. */
  loadingShellPaths?: string[];
  /** Pages Router paths selected by the existing HTML warm discovery pass. */
  pagesPaths?: string[];
  /** Pages Router JSON data identities corresponding to discovered static paths. */
  pagesDataPaths?: string[];
  /** Public paths omitted because configured routes can replace their page response. */
  excludedWarmPaths?: string[];
  /** Static dynamic-route patterns with no build-discovered concrete path. */
  fallbackRoutePatterns?: PrerenderRoutePattern[];
  /** Resolved route ownership for grouping cacheability probes without re-matching paths. */
  routePatterns?: Record<string, PrerenderRoutePattern>;
  trailingSlash?: boolean;
  paths: string[];
};

export const PRERENDER_PATH_DISCOVERY_ENV = "__VINEXT_PRERENDER_PATH_DISCOVERY";
export const PRERENDER_PATHS_MANIFEST = "vinext-prerender-paths.json";

const PATH_DISCOVERY_FETCH_TIMEOUT_MS = 30_000;
export const DEFAULT_REMOTE_PATH_DISCOVERY_RETRY_DELAY_MS = 1_000;
export const DEFAULT_REMOTE_PATH_DISCOVERY_PHASE_TIMEOUT_MS = 120_000;

type PathDiscoveryRetryOptions = {
  deadlineAt?: number;
  phaseTimeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
};

function readDiscoveryUserFailure(response: Response, text: string): string | null {
  if (
    response.status !== 500 ||
    !response.headers.get("content-type")?.includes("application/json")
  ) {
    return null;
  }
  try {
    const value = JSON.parse(text) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const error = (value as { error?: unknown }).error;
    return typeof error === "string" && error.length > 0 ? error : null;
  } catch {
    return null;
  }
}

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
  /** Execute dynamic path hooks against an already-uploaded Worker. */
  pathDiscoveryTarget?: {
    baseUrl: string;
    headers?: HeadersInit;
    /** Retry transient staged-version routing responses before failing discovery. */
    phaseTimeoutMs?: number;
    retries?: number;
    retryDelayMs?: number;
  };
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
  if (/cloudflare:|ERR_UNSUPPORTED_ESM_URL_SCHEME/i.test(message)) {
    throw new Error(
      `Failed to discover warmup path(s) for ${route}: Cloudflare runtime bindings cannot execute in the local Node prerender server. ` +
        "Use `vinext-cloudflare deploy --experimental-warm-cdn-cache` so path discovery runs against the staged Worker version.",
      { cause: error },
    );
  }
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
  retryOptions: PathDiscoveryRetryOptions = {},
): Promise<string | null> {
  const hasSharedPhaseDeadline = retryOptions.deadlineAt !== undefined;
  const retryDelayMs = Math.max(
    0,
    retryOptions.retryDelayMs ??
      (hasSharedPhaseDeadline ? DEFAULT_REMOTE_PATH_DISCOVERY_RETRY_DELAY_MS : 0),
  );
  const phaseTimeoutMs = Math.max(
    1,
    retryOptions.phaseTimeoutMs ?? DEFAULT_REMOTE_PATH_DISCOVERY_PHASE_TIMEOUT_MS,
  );
  // An explicit retry limit remains authoritative. Otherwise let fast
  // transient responses keep retrying for the advertised phase duration
  // instead of silently stopping halfway through it. A zero-delay caller uses
  // the standard cadence only for calculating a bounded attempt budget; the
  // deadline below remains the authoritative wall-clock limit.
  const retryBudgetDelayMs =
    retryDelayMs > 0 ? retryDelayMs : DEFAULT_REMOTE_PATH_DISCOVERY_RETRY_DELAY_MS;
  const retries = Math.max(
    0,
    retryOptions.retries ??
      (hasSharedPhaseDeadline ? Math.ceil(phaseTimeoutMs / retryBudgetDelayMs) : 0),
  );
  const deadlineAt = retryOptions.deadlineAt ?? Date.now() + phaseTimeoutMs;
  let lastError: unknown;
  let attemptsRun = 0;
  let lastTransientStatus: number | undefined;

  const attemptSummary = () =>
    ` after ${attemptsRun} attempt(s)${
      lastTransientStatus === undefined
        ? ""
        : `; last transient status was HTTP ${lastTransientStatus}`
    }`;
  const phaseTimeoutError = () =>
    new Error(
      `remote path discovery exceeded its ${phaseTimeoutMs}ms phase deadline${attemptSummary()}`,
    );

  for (let attempt = 0; attempt <= retries; attempt++) {
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) throw phaseTimeoutError();
    attemptsRun++;

    const controller = new AbortController();
    const attemptTimeoutMs = Math.min(PATH_DISCOVERY_FETCH_TIMEOUT_MS, remainingMs);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let shouldRetry = true;
    try {
      const request = (async () => {
        const res = await fetch(url, {
          headers,
          signal: controller.signal,
        });
        return { res, text: await res.text() };
      })();
      const timedOut = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new DOMException(`Timed out after ${attemptTimeoutMs}ms`, "AbortError"));
        }, attemptTimeoutMs);
      });
      const { res, text } = await Promise.race([request, timedOut]);
      if (res.ok) {
        if (res.status === 204) return null;
        return text;
      }

      const userFailure = readDiscoveryUserFailure(res, text);
      const detail =
        userFailure ??
        (/cloudflare:|ERR_UNSUPPORTED_ESM_URL_SCHEME/i.test(text) ? text.trim() : "");
      lastError = new Error(
        `path discovery returned HTTP ${res.status}${detail ? `: ${detail}` : ""}`,
      );
      // A newly applied route can briefly reach the previous Worker (404), and
      // version-metadata validation rejects that mismatch with 503. Cloudflare
      // can also return an unshaped 5xx while the uploaded version propagates.
      // The authenticated endpoint's JSON { error } envelope is instead a real
      // generateStaticParams/getStaticPaths failure and must surface once.
      const transient =
        res.status === 404 || (res.status >= 500 && res.status <= 599 && userFailure === null);
      if (!transient) {
        shouldRetry = false;
        throw lastError;
      }
      lastTransientStatus = res.status;
    } catch (error) {
      if (Date.now() >= deadlineAt) throw phaseTimeoutError();
      lastError =
        error instanceof Error && error.name === "AbortError"
          ? new Error(`path discovery timed out after ${attemptTimeoutMs}ms`)
          : error;
      if (!shouldRetry) throw lastError;
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }

    if (attempt < retries && retryDelayMs > 0) {
      const delayMs = Math.min(retryDelayMs, Math.max(0, deadlineAt - Date.now()));
      if (delayMs <= 0) throw phaseTimeoutError();
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`${message}${attemptSummary()}`, { cause: lastError });
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
  retryOptions?: PathDiscoveryRetryOptions;
  secretHeaders: Record<string, string>;
}): Promise<{
  dataPaths: string[];
  fallbackRoutePatterns: PrerenderRoutePattern[];
  paths: string[];
}> {
  const [pageRoutes, apiRoutes] = await Promise.all([
    pagesRouter(options.pagesDir, options.pageExtensions),
    apiRouter(options.pagesDir, options.pageExtensions),
  ]);
  const apiPatterns = new Set(apiRoutes.map((route) => route.pattern));
  const paths: string[] = [];
  const seen = new Set<string>();
  const dataPaths: string[] = [];
  const seenDataPaths = new Set<string>();
  const fallbackRoutePatterns: PrerenderRoutePattern[] = [];

  for (const route of pageRoutes) {
    if (apiPatterns.has(route.pattern)) continue;
    if (BLOCKED_PAGES.includes(route.pattern)) continue;
    if (route.pattern === "/404" || route.pattern === "/500" || route.pattern === "/_error") {
      continue;
    }

    const { hasServerSideProps, hasStaticProps, type } = classifyPagesRoute(route.filePath);
    if (type === "api") continue;

    if (!route.isDynamic) {
      if (options.i18n) {
        for (const locale of options.i18n.locales) {
          const pathname = localizePagesPath(route.pattern, locale, options.i18n);
          addPath(paths, seen, pathname);
          if (hasStaticProps || hasServerSideProps) addPath(dataPaths, seenDataPaths, pathname);
        }
      } else {
        addPath(paths, seen, route.pattern);
        if (hasStaticProps || hasServerSideProps) {
          addPath(dataPaths, seenDataPaths, route.pattern);
        }
      }
      continue;
    }

    // A dynamic GSSP route has no enumerable parameter source. It remains
    // fail-closed unless another deployment input supplies a concrete path.
    if (type === "ssr") continue;

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
        options.retryOptions,
      );
      if (text === null) {
        continue;
      }

      const pathsResult = validatePagesStaticPathsResult(JSON.parse(text), route.pattern);
      if (pathsResult.fallback !== false) {
        fallbackRoutePatterns.push({ kind: "pages-page", pattern: route.pattern });
      }
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
        if (hasStaticProps) addPath(dataPaths, seenDataPaths, pathname);
      }
    } catch (error) {
      throwDiscoveryFailure(route.pattern, error);
    }
  }

  return { dataPaths, fallbackRoutePatterns, paths };
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

async function resolvePagesWarmRoutePatterns(options: {
  i18n: ResolvedNextConfig["i18n"];
  pagesDir: string;
  pageExtensions: readonly string[];
  paths: readonly string[];
}): Promise<Record<string, PrerenderRoutePattern>> {
  const pageRoutes = await pagesRouter(options.pagesDir, options.pageExtensions);
  return Object.fromEntries(
    options.paths.flatMap((pathname) => {
      const pagesPathname = options.i18n
        ? extractLocaleFromUrl(pathname, options.i18n).url
        : pathname;
      const match = matchRoute(pagesPathname, pageRoutes);
      return match
        ? [[pathname, { kind: "pages-page" as const, pattern: match.route.pattern }] as const]
        : [];
    }),
  );
}

function localizePagesPath(
  pathname: string,
  locale: string | undefined,
  i18n: ResolvedNextConfig["i18n"],
): string {
  if (!i18n || !locale || locale === i18n.defaultLocale) return pathname;
  return pathname === "/" ? `/${locale}` : `/${locale}${pathname}`;
}

/**
 * Next.js data URLs always carry the locale segment, including the default
 * locale that is omitted from the corresponding public HTML pathname.
 *
 * Ported from Next.js:
 * packages/next/src/shared/lib/router/utils/format-next-pathname-info.ts
 */
function localizePagesDataPath(pathname: string, i18n: ResolvedNextConfig["i18n"]): string {
  if (!i18n) return pathname;
  if (extractPagesStaticPathLocale(pathname, i18n).explicitLocalePrefix) return pathname;
  return pathname === "/" ? `/${i18n.defaultLocale}` : `/${i18n.defaultLocale}${pathname}`;
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
  cacheComponents: boolean;
  pageExtensions: readonly string[];
  retryOptions?: PathDiscoveryRetryOptions;
  secretHeaders: Record<string, string>;
}): Promise<{
  fallbackRoutePatterns: PrerenderRoutePattern[];
  loadingShellPaths: string[];
  paths: string[];
  routeHandlerPaths: string[];
}> {
  const routes = await appRouter(options.appDir, options.pageExtensions);
  const paths: string[] = [];
  const seen = new Set<string>();
  const loadingShellPaths: string[] = [];
  const seenLoadingShellPaths = new Set<string>();
  const routeHandlerPaths: string[] = [];
  const seenRouteHandlerPaths = new Set<string>();
  const fallbackRoutePatterns: PrerenderRoutePattern[] = [];
  const staticParamsCache = new Map<string, Promise<Record<string, string | string[]>[] | null>>();
  let requireNonEmptyStaticParams = false;
  const staticParamsMap = new Proxy({} as StaticParamsMap, {
    get(_target, pattern: string) {
      return async ({ params }: { params: Record<string, string | string[]> }) => {
        if (!options.baseUrl) return null;
        const cacheKey = `${pattern}\0${JSON.stringify(params)}`;
        let request = staticParamsCache.get(cacheKey);
        if (request === undefined) {
          request = (async () => {
            const search = new URLSearchParams({ pattern });
            if (Object.keys(params).length > 0) {
              search.set("parentParams", JSON.stringify(params));
            }
            const text = await fetchDiscoveryEndpoint(
              `${options.baseUrl}/__vinext/prerender/static-params?${search}`,
              options.secretHeaders,
              options.retryOptions,
            );
            if (text === null) return null;
            const value = JSON.parse(text) as unknown;
            if (!Array.isArray(value)) {
              throw new Error(`generateStaticParams must return an array for ${pattern}.`);
            }
            return value.map((entry) => {
              if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
                throw new Error(
                  `generateStaticParams must return parameter objects for ${pattern}.`,
                );
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
        }
        const value = await request;
        if (requireNonEmptyStaticParams && value?.length === 0) {
          throw new Error(
            "When using Cache Components, all `generateStaticParams` functions must return at least one result. " +
              "This is to ensure that we can perform build-time validation that there is no other dynamic accesses that would cause a runtime error.\n\n" +
              "Learn more: https://nextjs.org/docs/messages/empty-generate-static-params",
          );
        }
        return value;
      };
    },
    has() {
      return false;
    },
  });

  for (const route of routes) {
    const isRouteHandler = route.routePath !== null && route.pagePath === null;
    const renderEntryPath = isRouteHandler ? route.routePath : getAppRouteRenderEntryPath(route);
    if (!renderEntryPath) continue;
    if (isRouteHandler) {
      const classification = classifyAppRouteHandler(route.routePath!);
      if (!classification.hasGet || !classification.staticGenerationEnabled) continue;
    } else {
      const { type } = classifyAppRoute(renderEntryPath, route.routePath, route.isDynamic);
      if (type === "api") continue;
    }

    const hasMainTreeLoadingBoundary = appRouteHasMainTreeLoadingBoundary(route);
    const addDiscoveredPath = (pathname: string): void => {
      if (isRouteHandler) {
        addPath(routeHandlerPaths, seenRouteHandlerPaths, pathname);
        return;
      }
      addPath(paths, seen, pathname);
      if (hasMainTreeLoadingBoundary) {
        addPath(loadingShellPaths, seenLoadingShellPaths, pathname);
      }
    };

    if (!route.isDynamic) {
      addDiscoveredPath(route.pattern);
      continue;
    }

    // Next.js enables Cache Components PPR validation only for App Pages.
    // App Route Handlers still permit empty generateStaticParams results.
    requireNonEmptyStaticParams = options.cacheComponents && !isRouteHandler;
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

      if (!paramSets?.length) {
        if (isRouteHandler) {
          // App Route Handlers do not inherit page layouts or parallel slots.
          // Match Next.js's route-module eligibility: an empty
          // generateStaticParams result remains an on-demand static fallback,
          // while a handler without generateStaticParams needs an explicit
          // force-static/error contract.
          const dynamicConfig = extractExportConstString(
            fs.readFileSync(renderEntryPath, "utf8"),
            "dynamic",
          );
          const hasStaticFallback =
            paramSets !== null || dynamicConfig === "force-static" || dynamicConfig === "error";
          if (hasStaticFallback) {
            fallbackRoutePatterns.push({ kind: "app-route", pattern: route.pattern });
          }
          continue;
        }

        const parallelSegments = route.parallelSlots.flatMap((slot) =>
          [
            slot.layoutPath,
            ...(slot.configLayoutPaths ?? []),
            slot.pagePath ?? slot.defaultPath,
          ].filter((filePath): filePath is string => typeof filePath === "string"),
        );
        const segmentClassifications = [...route.layouts, renderEntryPath, ...parallelSegments].map(
          (filePath) => classifyAppRoute(filePath, null, false),
        );
        const hasDynamicSegment = segmentClassifications.some(
          (classification) => classification.type === "ssr",
        );
        const readDynamicConfig = (filePath: string): { dynamic?: string } => {
          const dynamic = extractExportConstString(fs.readFileSync(filePath, "utf8"), "dynamic");
          return dynamic === null ? {} : { dynamic };
        };
        const dynamicConfig = resolveAppPageDynamicConfig({
          layouts: route.layouts.map(readDynamicConfig),
          page: readDynamicConfig(renderEntryPath),
          parallelSegments: parallelSegments.map(readDynamicConfig),
        });
        const hasStaticFallback =
          paramSets !== null || dynamicConfig === "force-static" || dynamicConfig === "error";
        if (hasStaticFallback && !hasDynamicSegment) {
          fallbackRoutePatterns.push({ kind: "app-page", pattern: route.pattern });
        }
        continue;
      }

      for (const params of paramSets) {
        if (params === null || params === undefined) continue;
        addDiscoveredPath(buildUrlFromParams(route.pattern, params));
      }
    } catch (error) {
      throwDiscoveryFailure(route.pattern, error);
    }
  }

  return { fallbackRoutePatterns, loadingShellPaths, paths, routeHandlerPaths };
}

async function resolveAppWarmPaths(options: {
  appDir: string;
  i18n: ResolvedNextConfig["i18n"];
  pagesDir: string | null;
  pageExtensions: readonly string[];
  paths: readonly string[];
}): Promise<{
  appPaths: string[];
  appRoutePaths: string[];
  htmlPaths: string[];
  loadingShellPaths: string[];
  pagesPaths: string[];
  rscPaths: string[];
  routePatterns: Record<string, PrerenderRoutePattern>;
}> {
  const appRoutes = await appRouter(options.appDir, options.pageExtensions);
  const routeHandlerClassifications = new Map(
    appRoutes.flatMap((route) =>
      route.routePath && !route.pagePath
        ? [[route.routePath, classifyAppRouteHandler(route.routePath)] as const]
        : [],
    ),
  );
  const [pageRoutes, apiRoutes] = options.pagesDir
    ? await Promise.all([
        pagesRouter(options.pagesDir, options.pageExtensions),
        apiRouter(options.pagesDir, options.pageExtensions),
      ])
    : [[], []];

  const rscPaths: string[] = [];
  const appPaths: string[] = [];
  const appRoutePaths: string[] = [];
  const htmlPaths: string[] = [];
  const loadingShellPaths: string[] = [];
  const pagesPaths: string[] = [];
  const routePatterns: Record<string, PrerenderRoutePattern> = {};
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
      if (!isPagesApiRequest) {
        htmlPaths.push(pathname);
        pagesPaths.push(pathname);
        routePatterns[pathname] = { kind: "pages-page", pattern: pagesMatch.route.pattern };
      }
      continue;
    }
    if (!appMatch) continue;

    // The trie returns the exact object from appRoutes. Its public matcher type
    // exposes the shared AppRoute fields, so recover the graph-owned metadata
    // here without rescanning the route table for every concrete path.
    const matchedAppRoute = appMatch.route as (typeof appRoutes)[number];
    if (matchedAppRoute.routePath && !matchedAppRoute.pagePath) {
      const classification = routeHandlerClassifications.get(matchedAppRoute.routePath);
      if (classification?.hasGet && classification.staticGenerationEnabled) {
        appRoutePaths.push(pathname);
        routePatterns[pathname] = { kind: "app-route", pattern: matchedAppRoute.pattern };
      }
      continue;
    }

    const appRenderEntryPath = getAppRouteRenderEntryPath(matchedAppRoute);
    if (!appRenderEntryPath) continue;
    if (
      classifyAppRoute(appRenderEntryPath, matchedAppRoute.routePath, matchedAppRoute.isDynamic)
        .type === "api"
    ) {
      continue;
    }

    appPaths.push(pathname);
    htmlPaths.push(pathname);
    rscPaths.push(pathname);
    routePatterns[pathname] = { kind: "app-page", pattern: matchedAppRoute.pattern };
    if (appRouteHasMainTreeLoadingBoundary(matchedAppRoute)) {
      loadingShellPaths.push(pathname);
    }
  }
  return {
    appPaths,
    appRoutePaths,
    htmlPaths,
    loadingShellPaths,
    pagesPaths,
    routePatterns,
    rscPaths,
  };
}

const CACHEABILITY_POLICY_HEADER_NAMES = new Set<string>(CACHEABILITY_POLICY_HEADERS);
function cachePolicyRuleMatchesWarmPath(
  pathname: string,
  rule: ResolvedNextConfig["headers"][number],
  config: Pick<ResolvedNextConfig, "basePath" | "i18n" | "trailingSlash">,
): boolean {
  const canonicalPathname = normalizePathTrailingSlash(pathname, config.trailingSlash);
  const hostnames = [undefined, ...(config.i18n?.domains?.map((domain) => domain.domain) ?? [])];
  return hostnames.some((hostname) => {
    const matchPathname = normalizeDefaultLocalePathname(canonicalPathname, config.i18n, {
      hostname,
    });
    let sourceMatched = false;
    matchHeaders(
      matchPathname,
      [rule],
      {
        cookies: {},
        headers: new Headers(),
        host: hostname ?? "",
        query: new URLSearchParams(),
      },
      { basePath: config.basePath, hadBasePath: true },
      () => {
        sourceMatched = true;
      },
    );
    return sourceMatched;
  });
}

function cachePolicyRuleSourceMatchesWarmPath(
  pathname: string,
  rule: ResolvedNextConfig["headers"][number],
  config: Pick<ResolvedNextConfig, "basePath" | "i18n" | "trailingSlash">,
): boolean {
  return cachePolicyRuleMatchesWarmPath(
    pathname,
    { ...rule, has: undefined, missing: undefined },
    config,
  );
}

function staticConfigPatternSegments(pattern: string): string[] {
  const segments: string[] = [];
  for (const segment of pattern.split("/").filter(Boolean)) {
    if (/[:*()[\]{}]/.test(segment)) break;
    segments.push(segment);
  }
  return segments;
}

function routePatternCouldIntersectCachePolicyRule(
  routePattern: string,
  rule: ResolvedNextConfig["headers"][number],
  basePath: string,
): boolean {
  let ruleSource = rule.source;
  if (
    rule.basePath !== false &&
    basePath &&
    (ruleSource === basePath || ruleSource.startsWith(`${basePath}/`))
  ) {
    ruleSource = ruleSource.slice(basePath.length) || "/";
  }
  const routeSegments = staticConfigPatternSegments(routePattern);
  const ruleSegments = staticConfigPatternSegments(ruleSource);
  const sharedLength = Math.min(routeSegments.length, ruleSegments.length);
  for (let index = 0; index < sharedLength; index++) {
    if (routeSegments[index] !== ruleSegments[index]) return false;
  }
  return true;
}

/**
 * Certify only route-config bailouts that cannot hide a path- or
 * request-specific next.config cache policy. The final Worker still evaluates
 * every concrete response before emitting public cache headers.
 */
function annotateCacheabilityProbeSafety(
  routePatterns: Record<string, PrerenderRoutePattern>,
  config: Pick<ResolvedNextConfig, "basePath" | "headers" | "i18n" | "trailingSlash">,
): Record<string, PrerenderRoutePattern> {
  const cachePolicyRules = config.headers.filter((rule) =>
    rule.headers.some((header) => CACHEABILITY_POLICY_HEADER_NAMES.has(header.key.toLowerCase())),
  );
  const matchingPolicyRules = new Map(
    Object.keys(routePatterns).map((pathname) => [
      pathname,
      new Set(
        cachePolicyRules.filter((rule) => cachePolicyRuleMatchesWarmPath(pathname, rule, config)),
      ),
    ]),
  );
  const pathsByPattern = new Map<string, string[]>();
  for (const [pathname, route] of Object.entries(routePatterns)) {
    const key = `${route.kind}\0${route.pattern}`;
    const paths = pathsByPattern.get(key) ?? [];
    paths.push(pathname);
    pathsByPattern.set(key, paths);
  }
  const canPrunePatterns = new Map<string, boolean>();
  for (const [patternKey, patternPaths] of pathsByPattern) {
    const routePattern = routePatterns[patternPaths[0]].pattern;
    const relevantRules = cachePolicyRules.filter(
      (rule) =>
        patternPaths.some((path) => cachePolicyRuleSourceMatchesWarmPath(path, rule, config)) ||
        routePatternCouldIntersectCachePolicyRule(routePattern, rule, config.basePath),
    );
    canPrunePatterns.set(
      patternKey,
      relevantRules.every(
        (rule) =>
          !rule.has?.length &&
          !rule.missing?.length &&
          patternPaths.every((path) => matchingPolicyRules.get(path)?.has(rule) === true),
      ),
    );
  }

  return Object.fromEntries(
    Object.entries(routePatterns).map(([pathname, route]) => {
      const patternKey = `${route.kind}\0${route.pattern}`;
      const canPrunePattern = canPrunePatterns.get(patternKey) ?? false;
      return [
        pathname,
        {
          ...route,
          cacheabilityProbe: { canPrunePattern },
        },
      ];
    }),
  );
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
  const discoveredPagesDataPaths: string[] = [];
  const seenPagesDataPaths = new Set<string>();
  const discoveredAppPaths: string[] = [];
  const seenAppPaths = new Set<string>();
  const discoveredRouteHandlerPaths: string[] = [];
  const seenRouteHandlerPaths = new Set<string>();
  const discoveredLoadingShellPaths: string[] = [];
  const seenLoadingShellPaths = new Set<string>();
  const fallbackRoutePatterns: PrerenderRoutePattern[] = [];
  await withPrerenderEndpoints(async () => {
    let prodServer: { server: HttpServer; port: number } | null = null;
    const needsServer = await shouldStartPathDiscoveryServer({
      appDir,
      pagesDir,
      pageExtensions: config.pageExtensions,
    });
    if (needsServer && !options.pathDiscoveryTarget) {
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

    const baseUrl = options.pathDiscoveryTarget?.baseUrl
      ? new URL(options.pathDiscoveryTarget.baseUrl).origin
      : prodServer
        ? `http://127.0.0.1:${prodServer.port}`
        : null;
    const prerenderSecret =
      readPrerenderSecret(bundleServerDir) ?? readPrerenderSecret(manifestDir);
    if (needsServer && options.pathDiscoveryTarget && !prerenderSecret) {
      throw new Error(
        "Cannot discover warmup paths from the staged Worker because dist/server/vinext-server.json does not contain a prerender secret. Rebuild the app before deploying.",
      );
    }
    const secretHeaders: Record<string, string> = Object.fromEntries(
      new Headers(options.pathDiscoveryTarget?.headers),
    );
    if (prerenderSecret) {
      secretHeaders[VINEXT_PRERENDER_SECRET_HEADER] = prerenderSecret;
    }
    const pathDiscoveryRetryOptions = options.pathDiscoveryTarget
      ? {
          deadlineAt:
            Date.now() +
            Math.max(
              1,
              options.pathDiscoveryTarget.phaseTimeoutMs ??
                DEFAULT_REMOTE_PATH_DISCOVERY_PHASE_TIMEOUT_MS,
            ),
          phaseTimeoutMs: options.pathDiscoveryTarget.phaseTimeoutMs,
          retries: options.pathDiscoveryTarget.retries,
          retryDelayMs: options.pathDiscoveryTarget.retryDelayMs,
        }
      : undefined;

    try {
      if (appDir) {
        const appPathResult = await collectAppPaths({
          appDir,
          baseUrl,
          cacheComponents: config.cacheComponents,
          pageExtensions: config.pageExtensions,
          retryOptions: pathDiscoveryRetryOptions,
          secretHeaders,
        });
        for (const pathname of appPathResult.paths) {
          addPath(paths, seen, pathname);
          addPath(discoveredAppPaths, seenAppPaths, pathname);
        }
        for (const pathname of appPathResult.loadingShellPaths) {
          addPath(discoveredLoadingShellPaths, seenLoadingShellPaths, pathname);
        }
        for (const pathname of appPathResult.routeHandlerPaths) {
          addPath(discoveredRouteHandlerPaths, seenRouteHandlerPaths, pathname);
        }
        fallbackRoutePatterns.push(...appPathResult.fallbackRoutePatterns);
      }

      if (pagesDir) {
        const pagesPathResult = await collectPagesPaths({
          baseUrl,
          i18n: config.i18n,
          pagesDir,
          pageExtensions: config.pageExtensions,
          retryOptions: pathDiscoveryRetryOptions,
          secretHeaders,
        });
        for (const pathname of pagesPathResult.paths) {
          addPath(paths, seen, pathname);
          addPath(discoveredPagesPaths, seenPagesPaths, pathname);
        }
        for (const pathname of pagesPathResult.dataPaths) {
          addPath(discoveredPagesDataPaths, seenPagesDataPaths, pathname);
        }
        fallbackRoutePatterns.push(...pagesPathResult.fallbackRoutePatterns);
      }
    } finally {
      if (prodServer) {
        await new Promise<void>((resolve) => prodServer!.server.close(() => resolve()));
      }
    }
  });

  const excludedWarmPathSet = new Set(
    options.responseVary
      ? [...paths, ...discoveredRouteHandlerPaths].filter((pathname) =>
          configuredRouteAffectsWarmPath(pathname, config),
        )
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
  const discoveredPagesDataPathSet = new Set(discoveredPagesDataPaths);
  const configuredCandidatePaths = paths.filter((pathname) => !excludedWarmPathSet.has(pathname));
  const configuredRouteHandlerPaths = discoveredRouteHandlerPaths.filter(
    (pathname) => !excludedWarmPathSet.has(pathname),
  );
  const appOwnedWarmPaths = appDir
    ? await resolveAppWarmPaths({
        appDir,
        i18n: config.i18n,
        pagesDir,
        pageExtensions: config.pageExtensions,
        paths: [...configuredCandidatePaths, ...configuredRouteHandlerPaths],
      })
    : {
        appPaths: [],
        appRoutePaths: [],
        htmlPaths: discoveredAppPaths,
        loadingShellPaths: discoveredLoadingShellPaths,
        pagesPaths: resolvedPagesWarmPaths,
        routePatterns: pagesDir
          ? await resolvePagesWarmRoutePatterns({
              i18n: config.i18n,
              pagesDir,
              pageExtensions: config.pageExtensions,
              paths: resolvedPagesWarmPaths,
            })
          : {},
        rscPaths: discoveredAppPaths,
      };
  const warmPaths = appDir ? appOwnedWarmPaths.htmlPaths : resolvedPagesWarmPaths;
  const pagesOwnedWarmPaths = appDir ? appOwnedWarmPaths.pagesPaths : resolvedPagesWarmPaths;
  const resolvedPagesDataWarmPaths = pagesOwnedWarmPaths.filter((pathname) =>
    discoveredPagesDataPathSet.has(pathname),
  );
  const pagesDataPaths = resolvedPagesDataWarmPaths.map((pathname) =>
    buildPagesDataHref(
      config.basePath,
      config.buildId,
      localizePagesDataPath(pathname, config.i18n),
      "",
    ),
  );
  const routePatterns = annotateCacheabilityProbeSafety(appOwnedWarmPaths.routePatterns, config);
  for (let index = 0; index < resolvedPagesDataWarmPaths.length; index++) {
    const route = routePatterns[resolvedPagesDataWarmPaths[index]];
    if (route) {
      const htmlPathname =
        resolvedPagesDataWarmPaths[index] === "/"
          ? config.basePath || "/"
          : `${config.basePath}${resolvedPagesDataWarmPaths[index]}`;
      routePatterns[pagesDataPaths[index]] = {
        ...route,
        cacheabilityProbe: {
          ...route.cacheabilityProbe!,
          concretePathname: htmlPathname,
        },
      };
    }
  }

  const manifest: PrerenderPathManifest = {
    ...(appDir ? { appPaths: appOwnedWarmPaths.appPaths } : {}),
    ...(config.basePath ? { basePath: config.basePath } : {}),
    buildId: config.buildId,
    ...(rscBuildId && options.buildIdentity === "response-header"
      ? { buildIdentity: rscBuildId }
      : {}),
    ...(config.deploymentId ? { deploymentId: config.deploymentId } : {}),
    ...(pagesDir
      ? {
          pagesDataPaths,
          pagesPaths: pagesOwnedWarmPaths,
        }
      : {}),
    ...(excludedWarmPathSet.size > 0 ? { excludedWarmPaths: Array.from(excludedWarmPathSet) } : {}),
    ...(fallbackRoutePatterns.length > 0 ? { fallbackRoutePatterns } : {}),
    ...(rscBuildId ? { rscBuildId } : {}),
    ...(options.responseVary ? { responseVary: options.responseVary } : {}),
    ...(options.responseVary ? { rscPaths: appOwnedWarmPaths.rscPaths } : {}),
    ...(Object.keys(routePatterns).length > 0 ? { routePatterns } : {}),
    ...(appOwnedWarmPaths.appRoutePaths.length > 0
      ? { routeHandlerPaths: appOwnedWarmPaths.appRoutePaths }
      : {}),
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
  console.log(
    `  Discovered ${warmPaths.length + appOwnedWarmPaths.appRoutePaths.length} CDN warmup path(s).`,
  );

  return manifest;
}
