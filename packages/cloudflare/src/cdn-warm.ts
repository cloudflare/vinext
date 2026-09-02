import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  PRERENDER_PATHS_MANIFEST,
  type PrerenderPathManifest,
  type PrerenderRoutePattern,
} from "vinext/internal/build/prerender-paths";
import {
  getPrerenderedConcretePaths,
  readPrerenderManifest,
  type PrerenderManifest,
  type PrerenderedPathSelectionOptions,
} from "vinext/internal/server/prerender-manifest";
import {
  createCanonicalLoadingShellRscRequestHeaders,
  createCanonicalRscRequestHeaders,
  createCanonicalRscRequestUrl,
  createRscRequestUrl,
  VINEXT_RSC_BUILD_ID_HEADER,
  VINEXT_RSC_CONTENT_TYPE,
  VINEXT_RSC_VARY_HEADER,
} from "vinext/internal/server/app-rsc-cache-busting";
import { isNonCacheableCacheControl } from "vinext/shims/cdn-cache";
import { normalizePathTrailingSlash } from "vinext/shims/url-utils";
import {
  VINEXT_PRERENDER_READINESS_HEADER,
  VINEXT_PRERENDER_READINESS_PATH,
  VINEXT_PRERENDER_SECRET_HEADER,
} from "vinext/internal/server/headers";
import { cacheabilityRoutePathname } from "vinext/internal/server/cacheability-manifest";
import { VINEXT_CDN_BUILD_ID_HEADER } from "./cache/cdn-build-id.js";

export type CdnWarmOptions = {
  targetUrl: string;
  paths: readonly string[];
  /** Pages Router JSON data identities used by client navigation. */
  pagesDataPaths?: readonly string[];
  /** Statically eligible App Route Handler request identities. */
  routeHandlerPaths?: readonly string[];
  routePatterns?: Readonly<Record<string, PrerenderRoutePattern>>;
  /** App Router ISR paths whose definitive client-navigation payload is warmed. */
  rscPaths?: readonly string[];
  /** App Router paths whose deterministic loading-boundary payload is warmed. */
  loadingShellPaths?: readonly string[];
  /** Build identity that the warmed RSC response must have been rendered by. */
  expectedRscBuildId?: string;
  /** Application build identity stamped by the configured CDN adapter. */
  expectedBuildId?: string;
  deploymentId?: string;
  headers?: HeadersInit;
  concurrency?: number;
  timeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
  /** Bound the whole warm phase, including queued targets and retries. */
  phaseTimeoutMs?: number;
  /** Retry a newly staged version or preview alias until its routing has propagated. */
  propagatingTarget?: boolean;
  /** Require the response to come from a reusable cache entry, not merely an eligible MISS. */
  requireCacheHit?: boolean;
  strict?: boolean;
  fetchImpl?: typeof fetch;
};

export const DEFAULT_CDN_WARM_CONCURRENCY = 25;
export const DEFAULT_CDN_WARM_TIMEOUT_MS = 10_000;
export const DEFAULT_STAGED_READINESS_RETRIES = 60;
export const DEFAULT_STAGED_READINESS_INTERVAL_MS = 1_000;
export const DEFAULT_STAGED_READINESS_PHASE_TIMEOUT_MS = 120_000;
const DEFAULT_STAGED_READINESS_SUCCESSES = 6;
const STAGED_READINESS_QUERY_PARAM = "__vinext_cdn_warm_readiness";

export type PrerenderCdnWarmOptions = Omit<CdnWarmOptions, "paths"> & {
  root: string;
  includeFallbackShells?: boolean;
  /** Use the manifest build identity unless the configured adapter cannot expose it. */
  validateBuildIdentity?: boolean;
};

export type CdnWarmResult = {
  total: number;
  warmed: number;
  skipped: number;
  failed: number;
  failures: Array<{ path: string; error: string }>;
  skippedTargets: CdnWarmTarget[];
  warmedPlan: CdnWarmRequestPlan;
  retryPlan: CdnWarmRequestPlan;
};

export type CdnWarmRequestPlan = {
  loadingShellPaths: string[];
  pagesDataPaths: string[];
  paths: string[];
  rscPaths: string[];
  routeHandlerPaths?: string[];
  routePatterns?: Record<string, PrerenderRoutePattern>;
};

export type CdnWarmReadinessResult = { ready: true } | { error: string; ready: false };

export type PrerenderWarmPlan = {
  appPaths?: string[];
  buildId?: string;
  buildIdentity?: string;
  deploymentId?: string;
  fallbackRoutePatterns?: PrerenderRoutePattern[];
  loadingShellPaths: string[];
  pagesDataPaths?: string[];
  pagesPaths?: string[];
  paths: string[];
  routeHandlerPaths?: string[];
  routePatterns?: Record<string, PrerenderRoutePattern>;
  rscBuildId?: string;
  rscPaths: string[];
};

function applyWarmPathConfig(
  pathname: string,
  config: Pick<PrerenderPathManifest, "basePath" | "trailingSlash">,
): string {
  const withBasePath = config.basePath
    ? pathname === "/"
      ? config.basePath
      : `${config.basePath}${pathname}`
    : pathname;
  const normalized = normalizePathTrailingSlash(withBasePath, config.trailingSlash === true);
  return new URL(normalized, "http://vinext.local").pathname;
}

function readBuiltBuildId(root: string): string | null {
  try {
    const buildId = fs.readFileSync(path.join(root, "dist", "server", "BUILD_ID"), "utf-8").trim();
    return buildId.length > 0 ? buildId : null;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function readPrerenderPathManifest(manifestPath: string): PrerenderPathManifest | null {
  if (!fs.existsSync(manifestPath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const manifest = parsed as PrerenderPathManifest;
    if (
      !Array.isArray(manifest.paths) ||
      !manifest.paths.every((pathname) => typeof pathname === "string") ||
      (manifest.appPaths !== undefined &&
        (!Array.isArray(manifest.appPaths) ||
          !manifest.appPaths.every((pathname) => typeof pathname === "string"))) ||
      (manifest.pagesPaths !== undefined &&
        (!Array.isArray(manifest.pagesPaths) ||
          !manifest.pagesPaths.every((pathname) => typeof pathname === "string"))) ||
      (manifest.pagesDataPaths !== undefined &&
        (!Array.isArray(manifest.pagesDataPaths) ||
          !manifest.pagesDataPaths.every((pathname) => typeof pathname === "string"))) ||
      (manifest.excludedWarmPaths !== undefined &&
        (!Array.isArray(manifest.excludedWarmPaths) ||
          !manifest.excludedWarmPaths.every((pathname) => typeof pathname === "string"))) ||
      (manifest.fallbackRoutePatterns !== undefined &&
        (!Array.isArray(manifest.fallbackRoutePatterns) ||
          !manifest.fallbackRoutePatterns.every(
            (route) =>
              route !== null &&
              typeof route === "object" &&
              !Array.isArray(route) &&
              (route.kind === "app-page" ||
                route.kind === "app-route" ||
                route.kind === "pages-page") &&
              typeof route.pattern === "string" &&
              route.pattern.startsWith("/"),
          ))) ||
      (manifest.rscPaths !== undefined &&
        (!Array.isArray(manifest.rscPaths) ||
          !manifest.rscPaths.every((pathname) => typeof pathname === "string"))) ||
      (manifest.routeHandlerPaths !== undefined &&
        (!Array.isArray(manifest.routeHandlerPaths) ||
          !manifest.routeHandlerPaths.every((pathname) => typeof pathname === "string"))) ||
      (manifest.routePatterns !== undefined &&
        (!manifest.routePatterns ||
          typeof manifest.routePatterns !== "object" ||
          Array.isArray(manifest.routePatterns) ||
          !Object.entries(manifest.routePatterns).every(
            ([pathname, route]) =>
              pathname.startsWith("/") &&
              route !== null &&
              typeof route === "object" &&
              !Array.isArray(route) &&
              (route.kind === "app-page" ||
                route.kind === "app-route" ||
                route.kind === "pages-page") &&
              typeof route.pattern === "string" &&
              route.pattern.startsWith("/") &&
              (route.cacheabilityProbe === undefined ||
                (route.cacheabilityProbe !== null &&
                  typeof route.cacheabilityProbe === "object" &&
                  !Array.isArray(route.cacheabilityProbe) &&
                  typeof route.cacheabilityProbe.canPrunePattern === "boolean" &&
                  (route.cacheabilityProbe.concretePathname === undefined ||
                    (typeof route.cacheabilityProbe.concretePathname === "string" &&
                      route.cacheabilityProbe.concretePathname.startsWith("/"))))),
          ))) ||
      (manifest.loadingShellPaths !== undefined &&
        (!Array.isArray(manifest.loadingShellPaths) ||
          !manifest.loadingShellPaths.every((pathname) => typeof pathname === "string"))) ||
      (manifest.basePath !== undefined && typeof manifest.basePath !== "string") ||
      (manifest.buildIdentity !== undefined && typeof manifest.buildIdentity !== "string") ||
      (manifest.deploymentId !== undefined && typeof manifest.deploymentId !== "string") ||
      (manifest.rscBuildId !== undefined && typeof manifest.rscBuildId !== "string") ||
      (manifest.trailingSlash !== undefined && typeof manifest.trailingSlash !== "boolean") ||
      (manifest.responseVary !== undefined && manifest.responseVary !== "verbatim")
    ) {
      return null;
    }
    return manifest;
  } catch (error) {
    console.warn(`[vinext] Failed to read prerender path manifest at ${manifestPath}:`, error);
    return null;
  }
}

function readPrerenderPathWarmPaths(
  root: string,
  options?: { strict?: boolean },
): { manifest: PrerenderPathManifest; pagesPaths: string[]; paths: string[] } | null {
  const manifest = readPrerenderPathManifest(
    path.join(root, "dist", "server", PRERENDER_PATHS_MANIFEST),
  );
  if (!manifest) return null;

  const builtBuildId = readBuiltBuildId(root);
  if (!manifest.buildId || !builtBuildId || manifest.buildId !== builtBuildId) {
    const message =
      "[vinext] CDN warmup skipped: prerender path manifest buildId does not match dist/server/BUILD_ID.";
    if (options?.strict) throw new Error(message);
    console.warn(message);
    return null;
  }

  return {
    manifest,
    pagesPaths: (manifest.pagesPaths ?? [])
      .filter((pathname) => pathname.startsWith("/"))
      .filter((pathname) => !manifest.excludedWarmPaths?.includes(pathname))
      .map((pathname) => applyWarmPathConfig(pathname, manifest)),
    paths: manifest.paths
      .filter((pathname) => pathname.startsWith("/"))
      .filter((pathname) => !manifest.excludedWarmPaths?.includes(pathname))
      .map((pathname) => applyWarmPathConfig(pathname, manifest)),
  };
}

export function readPrerenderWarmPlan(
  root: string,
  options?: { includeFallbackShells?: boolean; strict?: boolean },
): PrerenderWarmPlan {
  const pathPlan = readPrerenderPathWarmPaths(root, options);
  if (!pathPlan) {
    const message = "[vinext] CDN warmup skipped: prerender path manifest not found.";
    if (options?.strict) throw new Error(message);
    return { loadingShellPaths: [], paths: [], rscPaths: [] };
  }

  const { manifest } = pathPlan;
  const supportsCanonicalRsc =
    manifest.responseVary === "verbatim" &&
    manifest.rscPaths !== undefined &&
    manifest.rscBuildId !== undefined;
  const applyConfig = (pathname: string) => applyWarmPathConfig(pathname, manifest);
  const routePatterns = manifest.routePatterns
    ? Object.fromEntries(
        Object.entries(manifest.routePatterns).map(([pathname, route]) => [
          pathname.includes("/_next/data/") ? pathname : applyConfig(pathname),
          route,
        ]),
      )
    : undefined;
  let htmlPaths = pathPlan.paths;
  if (options?.includeFallbackShells === true) {
    const prerenderManifest = readPrerenderManifest(
      path.join(root, "dist", "server", "vinext-prerender.json"),
    );
    if (!prerenderManifest) {
      console.warn(
        "[vinext] CDN warmup fallback shells requested, but prerender manifest not found; warming build-discovered paths only.",
      );
    } else if (!prerenderManifest.buildId || prerenderManifest.buildId !== manifest.buildId) {
      const message =
        "[vinext] CDN warmup skipped: prerender manifest buildId does not match dist/server/BUILD_ID.";
      if (options.strict) throw new Error(message);
      console.warn(message);
      htmlPaths = [];
    } else {
      htmlPaths = getPrerenderedConcretePaths(prerenderManifest, {
        includeFallbackShells: true,
      })
        .filter((pathname) => pathname.startsWith("/"))
        .filter((pathname) => !manifest.excludedWarmPaths?.includes(pathname))
        .map(applyConfig);
    }
  }
  return {
    ...(manifest.appPaths ? { appPaths: manifest.appPaths.map(applyConfig) } : {}),
    buildId: manifest.buildId,
    ...(manifest.buildIdentity ? { buildIdentity: manifest.buildIdentity } : {}),
    ...(manifest.deploymentId ? { deploymentId: manifest.deploymentId } : {}),
    ...(manifest.fallbackRoutePatterns
      ? { fallbackRoutePatterns: manifest.fallbackRoutePatterns }
      : {}),
    loadingShellPaths: supportsCanonicalRsc
      ? (manifest.loadingShellPaths ?? []).map(applyConfig)
      : [],
    ...(manifest.pagesDataPaths ? { pagesDataPaths: manifest.pagesDataPaths } : {}),
    ...(manifest.pagesPaths ? { pagesPaths: manifest.pagesPaths.map(applyConfig) } : {}),
    paths: htmlPaths,
    ...(supportsCanonicalRsc ? { rscBuildId: manifest.rscBuildId } : {}),
    rscPaths: supportsCanonicalRsc ? manifest.rscPaths!.map(applyConfig) : [],
    ...(manifest.routeHandlerPaths
      ? { routeHandlerPaths: manifest.routeHandlerPaths.map(applyConfig) }
      : {}),
    ...(routePatterns ? { routePatterns } : {}),
  };
}

export function readPrerenderWarmPaths(
  root: string,
  options?: { includeFallbackShells?: boolean; strict?: boolean },
): string[] {
  return readPrerenderWarmPlan(root, options).paths;
}

export function getWarmPathsFromPrerenderManifest(
  manifest: PrerenderManifest,
  options?: PrerenderedPathSelectionOptions,
): string[] {
  return getPrerenderedConcretePaths(manifest, options);
}

function normalizeWarmPath(pathname: string): string {
  return pathname.startsWith("/") ? pathname : `/${pathname}`;
}

export function buildWarmupUrl(targetUrl: string, pathname: string): URL {
  return new URL(
    normalizeWarmPath(pathname),
    targetUrl.endsWith("/") ? targetUrl : `${targetUrl}/`,
  );
}

function isRetryableStatus(status: number, retryNotFound: boolean): boolean {
  return status === 408 || status === 429 || status >= 500 || (retryNotFound && status === 404);
}

const WORKER_VERSION_OVERRIDE_HEADER = "Cloudflare-Workers-Version-Overrides";

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: URL,
  timeoutMs: number,
  headers: HeadersInit | undefined,
  redirect: RequestRedirect,
): Promise<{ body: ArrayBuffer; response: Response }> {
  const controller = new AbortController();
  let response: Response | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const requestHeaders = new Headers(headers);
  requestHeaders.set("User-Agent", "vinext-cloudflare-cdn-warm");
  try {
    const timedOut = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new DOMException(`Timed out after ${timeoutMs}ms`, "AbortError"));
      }, timeoutMs);
    });
    return await Promise.race([
      (async () => {
        response = await fetchImpl(url, {
          method: "GET",
          redirect,
          headers: requestHeaders,
          signal: controller.signal,
        });
        // A cache fill is not complete until the entire response body has
        // arrived. Keep that inside the request deadline so a Worker that
        // sends headers and then stalls cannot hang deployment indefinitely.
        const body = await response.arrayBuffer();
        return { body, response };
      })(),
      timedOut,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (controller.signal.aborted && response?.body) {
      void response.body.cancel().catch(() => {});
    }
  }
}

async function fetchHeadersWithTimeout(
  fetchImpl: typeof fetch,
  url: URL,
  timeoutMs: number,
  headers?: HeadersInit,
  method: "GET" | "POST" = "GET",
): Promise<Response> {
  const controller = new AbortController();
  const requestHeaders = new Headers(headers);
  requestHeaders.set("User-Agent", "vinext-cloudflare-cdn-warm");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timedOut = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new DOMException(`Timed out after ${timeoutMs}ms`, "AbortError"));
      }, timeoutMs);
    });
    return await Promise.race([
      fetchImpl(url, {
        method,
        redirect: "manual",
        headers: requestHeaders,
        signal: controller.signal,
      }),
      timedOut,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export type CdnWarmTarget = {
  headers?: HeadersInit;
  kind: "app-route" | "html" | "pages-data" | "rsc-full" | "rsc-loading-shell";
  label: string;
  pathname: string;
  sourcePathname: string;
  route?: PrerenderRoutePattern;
};

const MAX_CDN_WARM_REPORT_ROUTES = 10;
const MAX_CDN_WARM_REPORT_PATTERN_WIDTH = 48;

type CdnWarmReportOutcome = "failed" | "skipped" | "warmed";

type CdnWarmRouteReport = {
  failed: number;
  kind: string;
  key: string;
  pattern: string;
  paths: Set<string>;
  skipped: number;
  total: number;
  warmed: number;
};

const CDN_WARM_ROUTE_KIND_LABELS = {
  "app-page": "App page",
  "app-route": "Route Handler",
  "pages-page": "Pages page",
} as const;

function formatCount(count: number, singular: string, plural = `${singular}s`): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? singular : plural}`;
}

function formatNumber(count: number): string {
  return count.toLocaleString("en-US");
}

function truncateMiddle(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const remaining = maxLength - 1;
  const startLength = Math.ceil(remaining / 2);
  return `${value.slice(0, startLength)}…${value.slice(-(remaining - startLength))}`;
}

function printCdnWarmTable(
  headings: readonly string[],
  rows: readonly (readonly string[])[],
  rightAlignedFrom: number,
): void {
  const widths = headings.map((heading, index) =>
    Math.max(heading.length, ...rows.map((row) => row[index]?.length ?? 0)),
  );
  for (const row of [headings, ...rows]) {
    console.log(
      `    ${row
        .map((value, index) =>
          index >= rightAlignedFrom ? value.padStart(widths[index]) : value.padEnd(widths[index]),
        )
        .join("  ")}`,
    );
  }
}

function createCdnWarmRouteReport(
  targets: readonly CdnWarmTarget[],
  outcomes?: readonly CdnWarmReportOutcome[],
): CdnWarmRouteReport[] {
  const routes = new Map<string, CdnWarmRouteReport>();
  for (const [index, target] of targets.entries()) {
    const key = target.route ? `${target.route.kind}\0${target.route.pattern}` : "unmatched";
    const route =
      routes.get(key) ??
      ({
        failed: 0,
        kind: target.route ? CDN_WARM_ROUTE_KIND_LABELS[target.route.kind] : "Other",
        key,
        pattern: target.route?.pattern ?? "Other discovered requests",
        paths: new Set<string>(),
        skipped: 0,
        total: 0,
        warmed: 0,
      } satisfies CdnWarmRouteReport);
    route.paths.add(
      target.route?.cacheabilityProbe?.concretePathname ??
        cacheabilityRoutePathname(target.pathname, target.kind),
    );
    route.total++;
    const outcome = outcomes?.[index];
    if (outcome) route[outcome]++;
    routes.set(key, route);
  }
  return [...routes.values()].sort(
    (left, right) => right.total - left.total || left.key.localeCompare(right.key),
  );
}

function printCdnWarmRouteReport(
  targets: readonly CdnWarmTarget[],
  outcomes?: readonly CdnWarmReportOutcome[],
): void {
  if (!targets.some((target) => target.route)) return;
  const routes = createCdnWarmRouteReport(targets, outcomes);
  if (routes.length === 0) return;

  console.log(`  CDN warmup ${outcomes ? "result" : "plan"} by route:`);
  const visible = routes.slice(0, MAX_CDN_WARM_REPORT_ROUTES);
  const routeColumns = (route: CdnWarmRouteReport) => [
    truncateMiddle(route.pattern, MAX_CDN_WARM_REPORT_PATTERN_WIDTH),
    route.kind,
  ];
  if (outcomes) {
    printCdnWarmTable(
      ["Route pattern", "Kind", "Warmed", "Skipped", "Failed"],
      visible.map((route) => [
        ...routeColumns(route),
        `${formatNumber(route.warmed)}/${formatNumber(route.total)}`,
        formatNumber(route.skipped),
        formatNumber(route.failed),
      ]),
      2,
    );
  } else {
    printCdnWarmTable(
      ["Route pattern", "Kind", "Paths", "Entries"],
      visible.map((route) => [
        ...routeColumns(route),
        formatNumber(route.paths.size),
        formatNumber(route.total),
      ]),
      2,
    );
  }

  const omitted = routes.slice(MAX_CDN_WARM_REPORT_ROUTES);
  if (omitted.length > 0) {
    const omittedEntries = omitted.reduce((total, route) => total + route.total, 0);
    console.log(
      `    ... ${formatCount(omitted.length, "additional route pattern")} omitted (${formatCount(omittedEntries, "cache entry", "cache entries")})`,
    );
  }
}

export async function createCdnWarmTargets(
  options: Pick<
    CdnWarmOptions,
    | "deploymentId"
    | "headers"
    | "loadingShellPaths"
    | "pagesDataPaths"
    | "paths"
    | "routeHandlerPaths"
    | "routePatterns"
    | "rscPaths"
  >,
): Promise<CdnWarmTarget[]> {
  const requests: CdnWarmTarget[] = [];
  const fullRscPaths = new Set(options.rscPaths ?? []);
  const loadingShellPaths = new Set(options.loadingShellPaths ?? []);
  const commonHeaders = new Headers(options.headers);
  for (const pathname of new Set([...fullRscPaths, ...loadingShellPaths])) {
    if (fullRscPaths.has(pathname)) {
      const rscHeaders = new Headers(commonHeaders);
      for (const [name, value] of createCanonicalRscRequestHeaders(options.deploymentId)) {
        rscHeaders.set(name, value);
      }
      requests.push({
        headers: rscHeaders,
        kind: "rsc-full",
        label: `${pathname} (RSC full)`,
        pathname: createCanonicalRscRequestUrl(pathname),
        sourcePathname: pathname,
        route: options.routePatterns?.[pathname],
      });
    }

    if (loadingShellPaths.has(pathname)) {
      const loadingHeaders = new Headers(commonHeaders);
      for (const [name, value] of createCanonicalLoadingShellRscRequestHeaders(
        options.deploymentId,
      )) {
        loadingHeaders.set(name, value);
      }
      requests.push({
        headers: loadingHeaders,
        kind: "rsc-loading-shell",
        label: `${pathname} (RSC loading shell)`,
        pathname: await createRscRequestUrl(pathname, loadingHeaders),
        sourcePathname: pathname,
        route: options.routePatterns?.[pathname],
      });
    }
  }

  for (const pathname of new Set(options.paths)) {
    const htmlHeaders = new Headers(commonHeaders);
    htmlHeaders.set("Accept", "text/html");
    requests.push({
      headers: htmlHeaders,
      kind: "html",
      label: pathname,
      pathname,
      sourcePathname: pathname,
      route: options.routePatterns?.[pathname],
    });
  }
  for (const pathname of new Set(options.pagesDataPaths ?? [])) {
    const dataHeaders = new Headers(commonHeaders);
    dataHeaders.set("Accept", "application/json");
    requests.push({
      headers: dataHeaders,
      kind: "pages-data",
      label: `${pathname} (Pages data)`,
      pathname,
      sourcePathname: pathname,
      route: options.routePatterns?.[pathname],
    });
  }
  for (const pathname of new Set(options.routeHandlerPaths ?? [])) {
    const routeHeaders = new Headers(commonHeaders);
    routeHeaders.set("Accept", "*/*");
    requests.push({
      headers: routeHeaders,
      kind: "app-route",
      label: `${pathname} (Route Handler)`,
      pathname,
      sourcePathname: pathname,
      route: options.routePatterns?.[pathname],
    });
  }
  return requests;
}

export class CdnOperationProgress {
  private readonly isTTY = process.stderr.isTTY;
  private lastLineLength = 0;

  update(completed: number, total: number, label: string, phase = "Warming CDN cache"): void {
    if (!this.isTTY) return;
    const percent = total > 0 ? Math.floor((completed / total) * 100) : 0;
    const filled = Math.floor(percent / 5);
    const bar = `[${"█".repeat(filled)}${" ".repeat(20 - filled)}]`;
    const maxLabelLength = 40;
    const shortLabel =
      label.length > maxLabelLength ? `…${label.slice(-(maxLabelLength - 1))}` : label;
    const line = `${phase}... ${bar} ${String(completed).padStart(String(total).length)}/${total} ${shortLabel}`;
    process.stderr.write(`\r${line.padEnd(this.lastLineLength)}`);
    this.lastLineLength = line.length;
  }

  finish(): void {
    if (!this.isTTY || this.lastLineLength === 0) return;
    process.stderr.write(`\r${" ".repeat(this.lastLineLength)}\r`);
    this.lastLineLength = 0;
  }
}

const REQUIRED_RSC_VARY_HEADERS = VINEXT_RSC_VARY_HEADER.split(",").map((name) =>
  name.trim().toLowerCase(),
);
const ADMITTED_CF_CACHE_STATUSES = new Set(["HIT", "MISS", "EXPIRED", "REVALIDATED", "UPDATING"]);
const REUSABLE_CF_CACHE_STATUSES = new Set(["HIT", "REVALIDATED", "UPDATING"]);
const NON_CACHEABLE_CF_CACHE_STATUSES = new Set(["BYPASS"]);
const CDN_CACHE_POLICY_HEADERS = [
  "Cloudflare-CDN-Cache-Control",
  "CDN-Cache-Control",
  "Cache-Control",
] as const;

function splitCacheControlDirectives(value: string): string[] {
  const directives: string[] = [];
  let start = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (escaped) {
      escaped = false;
    } else if (quoted && character === "\\") {
      escaped = true;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (character === "," && !quoted) {
      directives.push(value.slice(start, index));
      start = index + 1;
    }
  }
  directives.push(value.slice(start));
  return directives;
}

function hasFieldQualifiedSetCookie(value: string): boolean {
  return splitCacheControlDirectives(value).some((directive) => {
    const separator = directive.indexOf("=");
    if (separator === -1) return false;
    const name = directive.slice(0, separator).trim().toLowerCase();
    if (name !== "private" && name !== "no-cache") return false;
    const rawFields = directive.slice(separator + 1).trim();
    const fields =
      rawFields.startsWith('"') && rawFields.endsWith('"') ? rawFields.slice(1, -1) : rawFields;
    return fields.split(",").some((field) => field.trim().toLowerCase() === "set-cookie");
  });
}

type WarmValidation =
  | { outcome: "warmed" }
  | { outcome: "skipped"; reason: string }
  | { outcome: "failed"; error: string };

function validateCachePolicy(
  response: Response,
  requireCacheStatus: boolean,
  requireCacheHit = false,
): WarmValidation {
  const effectivePolicy = CDN_CACHE_POLICY_HEADERS.map((name) => ({
    name,
    value: response.headers.get(name),
  })).find(
    (entry): entry is { name: (typeof CDN_CACHE_POLICY_HEADERS)[number]; value: string } =>
      entry.value !== null,
  );
  const nonCacheableHeaders =
    effectivePolicy && isNonCacheableCacheControl(effectivePolicy.value)
      ? [effectivePolicy.name]
      : [];
  const hasSetCookie = response.headers.has("Set-Cookie");
  const cacheStatus = response.headers.get("CF-Cache-Status")?.trim().toUpperCase();

  if (requireCacheHit && !REUSABLE_CF_CACHE_STATUSES.has(cacheStatus ?? "")) {
    return {
      outcome: "failed",
      error: `CF-Cache-Status is ${cacheStatus ?? "missing"}; the cache fill is not reusable`,
    };
  }

  // Cloudflare-CDN-Cache-Control is consumed at the edge and is deliberately
  // not forwarded to clients. A cacheable Cloudflare-specific policy can
  // therefore coexist with a downstream `no-store` policy or a Set-Cookie
  // header that is stripped from the cached object. CF-Cache-Status is the
  // authoritative admission result: MISS means the response was eligible for
  // cache, while response-time rejection is reported as BYPASS. Downstream
  // freshness cannot reveal a stripped higher-priority edge policy.
  if (cacheStatus && ADMITTED_CF_CACHE_STATUSES.has(cacheStatus)) {
    if (hasSetCookie && (!effectivePolicy || !hasFieldQualifiedSetCookie(effectivePolicy.value))) {
      return {
        outcome: "failed",
        error: "response sets a cookie without an observable field-qualified cache policy",
      };
    }
    return { outcome: "warmed" };
  }

  if (cacheStatus && NON_CACHEABLE_CF_CACHE_STATUSES.has(cacheStatus)) {
    const reason =
      nonCacheableHeaders.length > 0
        ? `${nonCacheableHeaders.join(", ")} opts out of caching`
        : hasSetCookie
          ? "response sets a cookie"
          : `CF-Cache-Status is ${cacheStatus}`;
    return { outcome: "skipped", reason };
  }

  if (cacheStatus === "DYNAMIC") {
    if (nonCacheableHeaders.length > 0 || hasSetCookie) {
      const reason =
        nonCacheableHeaders.length > 0
          ? `${nonCacheableHeaders.join(", ")} opts out of caching`
          : "response sets a cookie";
      return { outcome: "skipped", reason };
    }
    return { outcome: "failed", error: "CF-Cache-Status is DYNAMIC" };
  }

  if (nonCacheableHeaders.length > 0 || hasSetCookie) {
    const reason =
      nonCacheableHeaders.length > 0
        ? `${nonCacheableHeaders.join(", ")} opts out of caching`
        : "response sets a cookie";
    return {
      outcome: "failed",
      error: `${reason}, but CF-Cache-Status is ${cacheStatus ?? "missing"}`,
    };
  }

  if (!cacheStatus) {
    return requireCacheStatus
      ? { outcome: "failed", error: "response is missing CF-Cache-Status" }
      : { outcome: "warmed" };
  }
  return { outcome: "failed", error: `CF-Cache-Status is ${cacheStatus}` };
}

function validateBuildIdentity(
  response: Response,
  expectedBuildId?: string,
): WarmValidation | null {
  if (
    expectedBuildId !== undefined &&
    response.headers.get(VINEXT_CDN_BUILD_ID_HEADER) !== expectedBuildId
  ) {
    const actualBuildId = response.headers.get(VINEXT_CDN_BUILD_ID_HEADER) ?? "missing";
    return {
      outcome: "failed",
      error: `response ${VINEXT_CDN_BUILD_ID_HEADER} does not match build ${expectedBuildId} (received ${actualBuildId})`,
    };
  }
  return null;
}

function isExpectedTerminalStatus(status: number): boolean {
  return (status >= 300 && status < 400) || status === 404;
}

function validateRscWarmResponse(
  response: Response,
  expectedBuildId?: string,
  expectedRscBuildId?: string,
  requireCacheHit = false,
): WarmValidation {
  const buildIdentityValidation = validateBuildIdentity(response, expectedBuildId);
  if (buildIdentityValidation) return buildIdentityValidation;
  if (
    expectedRscBuildId !== undefined &&
    response.headers.get(VINEXT_RSC_BUILD_ID_HEADER) !== expectedRscBuildId
  ) {
    return {
      outcome: "failed",
      error: `response ${VINEXT_RSC_BUILD_ID_HEADER} does not match build ${expectedRscBuildId}`,
    };
  }
  if (response.redirected) {
    return { outcome: "failed", error: "redirected response" };
  }
  const terminalResponse = response.status < 200 || response.status >= 300;
  if (terminalResponse) {
    if (
      !isExpectedTerminalStatus(response.status) ||
      (expectedBuildId === undefined && expectedRscBuildId === undefined)
    ) {
      return { outcome: "failed", error: `HTTP ${response.status}` };
    }
  } else if (
    !response.headers.get("Content-Type")?.toLowerCase().startsWith(VINEXT_RSC_CONTENT_TYPE)
  ) {
    return { outcome: "failed", error: `expected ${VINEXT_RSC_CONTENT_TYPE} response` };
  }
  const cachePolicyValidation = validateCachePolicy(response, true, requireCacheHit);
  if (cachePolicyValidation.outcome !== "warmed") return cachePolicyValidation;
  if (
    terminalResponse &&
    !response.headers.get("Content-Type")?.toLowerCase().startsWith(VINEXT_RSC_CONTENT_TYPE)
  ) {
    return { outcome: "failed", error: `expected ${VINEXT_RSC_CONTENT_TYPE} response` };
  }
  const vary = new Set(
    (response.headers.get("Vary") ?? "")
      .split(",")
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean),
  );
  const missingVary = REQUIRED_RSC_VARY_HEADERS.find((name) => !vary.has(name));
  if (missingVary) {
    return { outcome: "failed", error: `response Vary is missing ${missingVary}` };
  }
  return { outcome: "warmed" };
}

function validateHtmlWarmResponse(
  response: Response,
  expectedBuildId?: string,
  requireCacheHit = false,
): WarmValidation {
  const buildIdentityValidation = validateBuildIdentity(response, expectedBuildId);
  if (buildIdentityValidation) return buildIdentityValidation;
  if (response.redirected) {
    return { outcome: "failed", error: "redirected response" };
  }
  const terminalResponse = response.status < 200 || response.status >= 300;
  if (terminalResponse) {
    if (!isExpectedTerminalStatus(response.status) || expectedBuildId === undefined) {
      return { outcome: "failed", error: `HTTP ${response.status}` };
    }
  }
  const cachePolicyValidation = validateCachePolicy(response, true, requireCacheHit);
  if (cachePolicyValidation.outcome !== "warmed") return cachePolicyValidation;
  return { outcome: "warmed" };
}

function validatePagesDataWarmResponse(
  response: Response,
  expectedBuildId?: string,
  requireCacheHit = false,
): WarmValidation {
  const validation = validateHtmlWarmResponse(response, expectedBuildId, requireCacheHit);
  if (validation.outcome !== "warmed") return validation;
  if (!response.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) {
    return { outcome: "failed", error: "expected application/json response" };
  }
  return validation;
}

function validateReadinessResponse(
  response: Response,
  kind: "app-route" | "html" | "pages-data" | "rsc",
  expectedBuildId?: string,
  expectedRscBuildId?: string,
): string | null {
  const buildIdentityValidation = validateBuildIdentity(response, expectedBuildId);
  if (buildIdentityValidation?.outcome === "failed") return buildIdentityValidation.error;
  if (
    kind === "rsc" &&
    expectedRscBuildId !== undefined &&
    response.headers.get(VINEXT_RSC_BUILD_ID_HEADER) !== expectedRscBuildId
  ) {
    return `response ${VINEXT_RSC_BUILD_ID_HEADER} does not match build ${expectedRscBuildId}`;
  }
  if (response.redirected) return "redirected response";
  if (response.status >= 500) return `HTTP ${response.status}`;
  if (response.status >= 200 && response.status < 300) {
    const contentType = response.headers.get("Content-Type")?.toLowerCase();
    if (kind === "rsc" && !contentType?.startsWith(VINEXT_RSC_CONTENT_TYPE)) {
      return `expected ${VINEXT_RSC_CONTENT_TYPE} response`;
    }
    if (kind === "pages-data" && !contentType?.startsWith("application/json")) {
      return "expected application/json response";
    }
  }
  // Readiness proves only that version overrides consistently reach the
  // uploaded build. The real warm pass validates status, representation, and
  // cache admission for every untouched cache key.
  return null;
}

function validatePrerenderReadinessResponse(
  response: Response,
  expectedBuildId?: string,
): string | null {
  const buildIdentityValidation = validateBuildIdentity(response, expectedBuildId);
  if (buildIdentityValidation?.outcome === "failed") return buildIdentityValidation.error;
  if (response.redirected) return "redirected response";
  if (response.status !== 204) return `expected readiness HTTP 204, received ${response.status}`;
  if (response.headers.get(VINEXT_PRERENDER_READINESS_HEADER) !== "1") {
    return `response is missing ${VINEXT_PRERENDER_READINESS_HEADER}: 1`;
  }
  const cacheControl = response.headers.get("Cache-Control");
  if (!cacheControl || !/(?:^|,)\s*no-store\s*(?:,|$)/i.test(cacheControl)) {
    return "readiness response is missing Cache-Control: no-store";
  }
  return null;
}

/**
 * Wait until version-override requests consistently reach the uploaded build
 * before any real cache key is filled. Every probe has a unique query key, so
 * an early response cannot make a later readiness attempt pass from cache.
 */
export async function waitForCdnWarmTargetReadiness(
  options: Pick<
    CdnWarmOptions,
    | "deploymentId"
    | "expectedBuildId"
    | "expectedRscBuildId"
    | "fetchImpl"
    | "headers"
    | "retries"
    | "targetUrl"
    | "timeoutMs"
  > & {
    plan: CdnWarmRequestPlan;
    maxAttempts?: number;
    phaseTimeoutMs?: number;
    prerenderSecret?: string;
    probeIntervalMs?: number;
    requiredConsecutiveSuccesses?: number;
  },
): Promise<CdnWarmReadinessResult> {
  const rscPath = options.plan.rscPaths[0] ?? options.plan.loadingShellPaths[0];
  const htmlPath = options.plan.paths[0];
  const pagesDataPath = options.plan.pagesDataPaths[0];
  const routeHandlerPath = options.plan.routeHandlerPaths?.[0];
  const kind = rscPath ? "rsc" : htmlPath ? "html" : pagesDataPath ? "pages-data" : "app-route";
  const pathname = rscPath ?? htmlPath ?? pagesDataPath ?? routeHandlerPath;
  if (!pathname) return { ready: true };
  if (options.expectedBuildId === undefined && options.expectedRscBuildId === undefined) {
    return {
      error: "no response build identity is available for a staged-version readiness probe",
      ready: false,
    };
  }

  const headers = new Headers(options.headers);
  const readinessSecret = options.prerenderSecret;
  const useReadinessEndpoint = Boolean(readinessSecret);
  const probePath = useReadinessEndpoint
    ? VINEXT_PRERENDER_READINESS_PATH
    : kind === "rsc"
      ? createCanonicalRscRequestUrl(pathname)
      : pathname;
  if (readinessSecret) {
    headers.set("Accept", "text/html");
    headers.set(VINEXT_PRERENDER_SECRET_HEADER, readinessSecret);
  } else if (kind === "rsc") {
    for (const [name, value] of createCanonicalRscRequestHeaders(options.deploymentId)) {
      headers.set(name, value);
    }
  } else if (kind === "html") {
    headers.set("Accept", "text/html");
  } else if (kind === "pages-data") {
    headers.set("Accept", "application/json");
  } else {
    headers.set("Accept", "*/*");
  }
  headers.set("Cache-Control", "no-cache");
  headers.set("Pragma", "no-cache");

  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_CDN_WARM_TIMEOUT_MS);
  const probeIntervalMs = Math.max(
    0,
    options.probeIntervalMs ?? DEFAULT_STAGED_READINESS_INTERVAL_MS,
  );
  const requiredConsecutiveSuccesses = Math.max(
    1,
    options.requiredConsecutiveSuccesses ?? DEFAULT_STAGED_READINESS_SUCCESSES,
  );
  const readinessRetries = Math.max(0, options.retries ?? DEFAULT_STAGED_READINESS_RETRIES);
  const maxAttempts = Math.max(
    requiredConsecutiveSuccesses,
    options.maxAttempts ?? requiredConsecutiveSuccesses + readinessRetries,
  );
  const phaseTimeoutMs = Math.max(
    1,
    options.phaseTimeoutMs ?? DEFAULT_STAGED_READINESS_PHASE_TIMEOUT_MS,
  );
  const deadlineAt = Date.now() + phaseTimeoutMs;
  const probeId = randomUUID();
  let consecutiveSuccesses = 0;
  let lastError = "readiness probe did not run";

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) {
      lastError = `staged readiness exceeded its ${phaseTimeoutMs}ms phase deadline`;
      break;
    }
    const url = buildWarmupUrl(options.targetUrl, probePath);
    url.searchParams.set(STAGED_READINESS_QUERY_PARAM, `${probeId}-${attempt}`);
    let response: Response | undefined;
    try {
      response = await fetchHeadersWithTimeout(
        fetchImpl,
        url,
        Math.min(timeoutMs, remainingMs),
        headers,
        useReadinessEndpoint ? "POST" : "GET",
      );
      const validationError = useReadinessEndpoint
        ? validatePrerenderReadinessResponse(response, options.expectedBuildId)
        : validateReadinessResponse(
            response,
            kind,
            options.expectedBuildId,
            options.expectedRscBuildId,
          );
      if (process.env.VINEXT_CDN_WARM_DEBUG === "1") {
        console.log(
          `  CDN warm readiness attempt ${attempt + 1}: ` +
            `${url.pathname}${url.search} HTTP ${response.status} ` +
            `build=${response.headers.get(VINEXT_RSC_BUILD_ID_HEADER) ?? response.headers.get(VINEXT_CDN_BUILD_ID_HEADER) ?? "missing"}`,
        );
      }
      if (validationError === null) {
        consecutiveSuccesses++;
        if (consecutiveSuccesses >= requiredConsecutiveSuccesses) return { ready: true };
      } else {
        consecutiveSuccesses = 0;
        lastError = validationError;
      }
    } catch (error) {
      consecutiveSuccesses = 0;
      lastError =
        Date.now() >= deadlineAt
          ? `staged readiness exceeded its ${phaseTimeoutMs}ms phase deadline`
          : error instanceof DOMException && error.name === "AbortError"
            ? `timed out after ${Math.min(timeoutMs, remainingMs)}ms`
            : error instanceof Error
              ? error.message
              : String(error);
    } finally {
      // Cancellation is best-effort cleanup and must not extend the readiness
      // phase past its hard deadline if a runtime stalls the cancellation.
      if (response?.body) void response.body.cancel().catch(() => {});
    }
    if (attempt + 1 < maxAttempts && probeIntervalMs > 0) {
      const delayMs = Math.min(probeIntervalMs, Math.max(0, deadlineAt - Date.now()));
      if (delayMs <= 0) {
        lastError = `staged readiness exceeded its ${phaseTimeoutMs}ms phase deadline`;
        break;
      }
      await delay(delayMs);
    }
  }

  return {
    error: `${lastError}; uploaded build was not stable for ${requiredConsecutiveSuccesses} consecutive probe(s)`,
    ready: false,
  };
}

function shouldRetryValidationFailure(
  response: Response,
  target: CdnWarmTarget,
  options: {
    expectedBuildId?: string;
    expectedRscBuildId?: string;
    retryNotFound: boolean;
    retryPropagationFailures: boolean;
  },
): boolean {
  if (!options.retryPropagationFailures) {
    return isRetryableStatus(response.status, options.retryNotFound);
  }

  const expectedIdentities = [
    options.expectedBuildId === undefined
      ? null
      : response.headers.get(VINEXT_CDN_BUILD_ID_HEADER) === options.expectedBuildId,
    !target.kind.startsWith("rsc-") || options.expectedRscBuildId === undefined
      ? null
      : response.headers.get(VINEXT_RSC_BUILD_ID_HEADER) === options.expectedRscBuildId,
  ].filter((matches): matches is boolean => matches !== null);

  // A matching identity proves routing reached the uploaded Worker. From that
  // point, retry only transient HTTP failures; response-shape and admission
  // failures are deterministic for that build.
  if (expectedIdentities.some((matches) => matches)) {
    return isRetryableStatus(response.status, false);
  }
  if (expectedIdentities.some((matches) => !matches)) return true;
  return isRetryableStatus(response.status, options.retryNotFound);
}

async function warmOnePath(
  target: CdnWarmTarget,
  options: Required<Pick<CdnWarmOptions, "targetUrl" | "timeoutMs" | "retries">> & {
    deadlineAt?: number;
    fetchImpl: typeof fetch;
    headers?: HeadersInit;
    expectedBuildId?: string;
    expectedRscBuildId?: string;
    retryPropagationFailures: boolean;
    retryDelayMs: number;
    retryNotFound: boolean;
    phaseTimeoutMs?: number;
    requireCacheHit: boolean;
  },
): Promise<
  | { path: string; ok: true; skipped: false }
  | { path: string; ok: true; skipped: true; reason: string }
  | { path: string; ok: false; error: string; retryable: boolean }
> {
  const url = buildWarmupUrl(options.targetUrl, target.pathname);
  let lastError = "request failed before the first attempt";
  let lastRetryable = true;

  const phaseDeadlineError = () =>
    `CDN warmup exceeded its ${options.phaseTimeoutMs}ms phase deadline`;
  const remainingPhaseMs = (): number =>
    options.deadlineAt === undefined ? options.timeoutMs : options.deadlineAt - Date.now();

  const canRetry = (attempt: number): boolean => attempt < options.retries;

  const waitBeforeRetry = async (): Promise<boolean> => {
    if (options.retryDelayMs <= 0) return remainingPhaseMs() > 0;
    const delayMs = Math.min(options.retryDelayMs, Math.max(0, remainingPhaseMs()));
    if (delayMs <= 0) return false;
    await delay(delayMs);
    return remainingPhaseMs() > 0;
  };

  for (let attempt = 0; attempt <= options.retries; attempt++) {
    const remainingMs = remainingPhaseMs();
    if (remainingMs <= 0) {
      return { path: target.label, ok: false, error: phaseDeadlineError(), retryable: false };
    }
    const attemptTimeoutMs = Math.min(options.timeoutMs, remainingMs);
    try {
      const response = options.requireCacheHit
        ? await fetchHeadersWithTimeout(
            options.fetchImpl,
            url,
            attemptTimeoutMs,
            target.headers ?? options.headers,
          )
        : (
            await fetchWithTimeout(
              options.fetchImpl,
              url,
              attemptTimeoutMs,
              target.headers ?? options.headers,
              "manual",
            )
          ).response;
      if (options.deadlineAt !== undefined && Date.now() >= options.deadlineAt) {
        return { path: target.label, ok: false, error: phaseDeadlineError(), retryable: false };
      }
      // Certification only needs immutable response metadata. A reusable HIT
      // is already stored at the edge, so downloading it again would double
      // warmup bandwidth without proving anything more.
      if (options.requireCacheHit) void response.body?.cancel().catch(() => {});

      if (process.env.VINEXT_CDN_WARM_DEBUG === "1") {
        console.log(
          `  CDN warm debug ${target.label} attempt ${attempt + 1}: ` +
            `${url.pathname}${url.search} HTTP ${response.status} ` +
            `cache=${response.headers.get("CF-Cache-Status") ?? "missing"} ` +
            `ray=${response.headers.get("CF-Ray") ?? "missing"} ` +
            `encoding=${response.headers.get("Content-Encoding") ?? "identity"} ` +
            `rscBuild=${response.headers.get(VINEXT_RSC_BUILD_ID_HEADER) ?? "missing"}`,
        );
      }

      if (target.kind.startsWith("rsc-")) {
        const validation = validateRscWarmResponse(
          response,
          options.expectedBuildId,
          options.expectedRscBuildId,
          options.requireCacheHit,
        );
        if (validation.outcome === "warmed") {
          return { path: target.label, ok: true, skipped: false };
        }
        if (validation.outcome === "skipped") {
          return { path: target.label, ok: true, skipped: true, reason: validation.reason };
        }
        lastError = validation.error;
        const cacheStatus = response.headers.get("CF-Cache-Status")?.trim().toUpperCase();
        lastRetryable =
          (options.requireCacheHit &&
            ADMITTED_CF_CACHE_STATUSES.has(cacheStatus ?? "") &&
            !REUSABLE_CF_CACHE_STATUSES.has(cacheStatus ?? "")) ||
          shouldRetryValidationFailure(response, target, options);
        if (!lastRetryable) break;
        if (!canRetry(attempt)) break;
        if (!(await waitBeforeRetry())) {
          return { path: target.label, ok: false, error: phaseDeadlineError(), retryable: false };
        }
        continue;
      }

      const validation =
        target.kind === "pages-data"
          ? validatePagesDataWarmResponse(
              response,
              options.expectedBuildId,
              options.requireCacheHit,
            )
          : validateHtmlWarmResponse(response, options.expectedBuildId, options.requireCacheHit);
      if (validation.outcome === "warmed") {
        return { path: target.label, ok: true, skipped: false };
      }
      if (validation.outcome === "skipped") {
        return { path: target.label, ok: true, skipped: true, reason: validation.reason };
      }
      lastError = validation.error;
      const cacheStatus = response.headers.get("CF-Cache-Status")?.trim().toUpperCase();
      lastRetryable =
        (options.requireCacheHit &&
          ADMITTED_CF_CACHE_STATUSES.has(cacheStatus ?? "") &&
          !REUSABLE_CF_CACHE_STATUSES.has(cacheStatus ?? "")) ||
        shouldRetryValidationFailure(response, target, options);
      if (!lastRetryable) break;
    } catch (error) {
      lastRetryable = true;
      if (error instanceof DOMException && error.name === "AbortError") {
        lastError =
          options.deadlineAt !== undefined && Date.now() >= options.deadlineAt
            ? phaseDeadlineError()
            : `timed out after ${attemptTimeoutMs}ms`;
      } else {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
    if (!canRetry(attempt)) break;
    if (!(await waitBeforeRetry())) {
      return { path: target.label, ok: false, error: phaseDeadlineError(), retryable: false };
    }
  }

  return { path: target.label, ok: false, error: lastError, retryable: lastRetryable };
}

async function runWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = Array.from<R>({ length: items.length });
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await fn(items[index]);
    }
  }

  if (items.length === 0) return results;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

export async function warmCdnCache(options: CdnWarmOptions): Promise<CdnWarmResult> {
  const targets = await createCdnWarmTargets(options);
  const requests = targets.filter((target) => target.kind !== "html");
  const htmlRequests = targets.filter((target) => target.kind === "html");
  requests.push(...htmlRequests);
  const timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_CDN_WARM_TIMEOUT_MS);
  const hasVersionOverride = new Headers(options.headers).has(WORKER_VERSION_OVERRIDE_HEADER);
  const propagatingTarget = options.propagatingTarget ?? hasVersionOverride;
  // A propagating target gives every key one initial attempt, then retries only
  // failed keys after the queue completes. Build identity validation prevents
  // an old Worker response from being mistaken for a successful fill.
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CDN_WARM_CONCURRENCY);
  const normalRetries = Math.max(0, options.retries ?? 1);
  const propagationRetries = Math.max(0, options.retries ?? 60);
  const normalRetryDelayMs = Math.max(0, options.retryDelayMs ?? 0);
  const propagationRetryDelayMs = Math.max(0, options.retryDelayMs ?? 1_000);
  const fetchImpl = options.fetchImpl ?? fetch;
  const phaseTimeoutMs =
    options.phaseTimeoutMs === undefined ? undefined : Math.max(1, options.phaseTimeoutMs);
  const deadlineAt = phaseTimeoutMs === undefined ? undefined : Date.now() + phaseTimeoutMs;

  if (requests.length === 0) {
    return {
      total: 0,
      warmed: 0,
      skipped: 0,
      failed: 0,
      failures: [],
      skippedTargets: [],
      warmedPlan: { loadingShellPaths: [], pagesDataPaths: [], paths: [], rscPaths: [] },
      retryPlan: { loadingShellPaths: [], pagesDataPaths: [], paths: [], rscPaths: [] },
    };
  }

  console.log(
    `\n  Warming ${formatCount(requests.length, "CDN cache entry", "CDN cache entries")}...`,
  );
  printCdnWarmRouteReport(requests);

  const progress = new CdnOperationProgress();
  let completedRequests = 0;
  progress.update(0, requests.length, "starting warmup");

  type WarmRetryMode = "normal" | "propagation-pass" | "propagation-retry";
  const warmTarget = (target: CdnWarmTarget, retryMode: WarmRetryMode = "normal") => {
    const isPropagationRequest = retryMode !== "normal";
    const retries =
      retryMode === "propagation-retry"
        ? Math.max(0, propagationRetries - 1)
        : retryMode === "propagation-pass"
          ? 0
          : normalRetries;
    return warmOnePath(target, {
      targetUrl: options.targetUrl,
      timeoutMs,
      retries,
      deadlineAt,
      fetchImpl,
      headers: options.headers,
      expectedBuildId: options.expectedBuildId,
      expectedRscBuildId: options.expectedRscBuildId,
      retryPropagationFailures: isPropagationRequest,
      retryDelayMs: isPropagationRequest ? propagationRetryDelayMs : normalRetryDelayMs,
      retryNotFound: isPropagationRequest,
      phaseTimeoutMs,
      requireCacheHit: options.requireCacheHit === true,
    });
  };

  const warmRequest = async (
    target: CdnWarmTarget,
    retryMode: WarmRetryMode = "normal",
  ): Promise<Awaited<ReturnType<typeof warmOnePath>>> => {
    const result = await warmTarget(target, retryMode);
    completedRequests++;
    progress.update(completedRequests, requests.length, target.label);
    return result;
  };

  const warmPropagatingPass = async (
    targets: readonly CdnWarmTarget[],
  ): Promise<Awaited<ReturnType<typeof warmOnePath>>[]> => {
    const results = await runWithConcurrency(targets, concurrency, (target) =>
      warmRequest(target, "propagation-pass"),
    );
    const failed = targets
      .map((target, index) => ({ index, result: results[index], target }))
      .filter(
        (
          entry,
        ): entry is {
          index: number;
          result: { path: string; ok: false; error: string; retryable: boolean };
          target: CdnWarmTarget;
        } => !entry.result.ok,
      );
    const retryableFailed = failed.filter(({ result }) => result.retryable);
    if (retryableFailed.length === 0 || propagationRetries === 0) return results;

    progress.finish();
    console.log(
      `  CDN warmup: retrying ${retryableFailed.length} failed request(s) after completing the initial pass...`,
    );
    let completedRetries = 0;
    progress.update(0, retryableFailed.length, "starting retry pass", "Retrying CDN cache");
    const retried = await runWithConcurrency(
      retryableFailed.map(({ target }) => target),
      concurrency,
      async (target) => {
        const result = await warmTarget(target, "propagation-retry");
        completedRetries++;
        progress.update(
          completedRetries,
          retryableFailed.length,
          target.label,
          "Retrying CDN cache",
        );
        return result;
      },
    );
    progress.finish();
    for (const [retryIndex, { index }] of retryableFailed.entries()) {
      results[index] = retried[retryIndex];
    }
    return results;
  };

  let results: Awaited<ReturnType<typeof warmOnePath>>[];
  if (propagatingTarget) {
    results = await warmPropagatingPass(requests);
  } else {
    results = await runWithConcurrency(requests, concurrency, (target) => warmRequest(target));
  }

  progress.finish();

  const failedRequests = requests
    .map((target, index) => ({ result: results[index], target }))
    .filter(
      (
        entry,
      ): entry is {
        result: { path: string; ok: false; error: string; retryable: boolean };
        target: CdnWarmTarget;
      } => !entry.result.ok,
    );
  const failures = failedRequests.map(({ result: { path, error } }) => ({ path, error }));
  const skippedResults = results.filter((result) => result.ok && result.skipped);
  const skippedTargets = requests.filter((_target, index) => {
    const result = results[index];
    return result.ok && result.skipped;
  });
  const warmedRequests = requests.filter((_target, index) => {
    const result = results[index];
    return result.ok && !result.skipped;
  });
  const warmed = results.length - failures.length - skippedResults.length;
  const warmedRouteHandlerPaths = warmedRequests
    .filter((target) => target.kind === "app-route")
    .map((target) => target.sourcePathname);
  const failedRouteHandlerPaths = failedRequests
    .filter(({ target }) => target.kind === "app-route")
    .map(({ target }) => target.sourcePathname);

  printCdnWarmRouteReport(
    requests,
    results.map((result) => (!result.ok ? "failed" : result.skipped ? "skipped" : "warmed")),
  );
  console.log(
    `  CDN warmup: ${warmed} warmed, ${skippedResults.length} skipped, ${failures.length} failed.`,
  );
  for (const skipped of skippedResults.slice(0, 5)) {
    console.log(`  CDN warmup skipped ${skipped.path}: ${skipped.reason}`);
  }
  if (failures.length > 0) {
    for (const failure of failures.slice(0, 5)) {
      console.warn(`  CDN warmup failed for ${failure.path}: ${failure.error}`);
    }
    if (failures.length > 5) {
      console.warn(`  CDN warmup: ${failures.length - 5} additional failure(s) omitted.`);
    }
  }

  const result = {
    total: requests.length,
    warmed,
    skipped: skippedResults.length,
    failed: failures.length,
    failures,
    skippedTargets,
    warmedPlan: {
      loadingShellPaths: warmedRequests
        .filter((target) => target.kind === "rsc-loading-shell")
        .map((target) => target.sourcePathname),
      pagesDataPaths: warmedRequests
        .filter((target) => target.kind === "pages-data")
        .map((target) => target.sourcePathname),
      paths: warmedRequests
        .filter((target) => target.kind === "html")
        .map((target) => target.sourcePathname),
      rscPaths: warmedRequests
        .filter((target) => target.kind === "rsc-full")
        .map((target) => target.sourcePathname),
      ...(warmedRouteHandlerPaths.length > 0 ? { routeHandlerPaths: warmedRouteHandlerPaths } : {}),
    },
    retryPlan: {
      loadingShellPaths: failedRequests
        .filter(({ target }) => target.kind === "rsc-loading-shell")
        .map(({ target }) => target.sourcePathname),
      pagesDataPaths: failedRequests
        .filter(({ target }) => target.kind === "pages-data")
        .map(({ target }) => target.sourcePathname),
      paths: failedRequests
        .filter(({ target }) => target.kind === "html")
        .map(({ target }) => target.sourcePathname),
      rscPaths: failedRequests
        .filter(({ target }) => target.kind === "rsc-full")
        .map(({ target }) => target.sourcePathname),
      ...(failedRouteHandlerPaths.length > 0 ? { routeHandlerPaths: failedRouteHandlerPaths } : {}),
    },
  };

  if (options.strict && failures.length > 0) {
    throw new Error(
      `CDN warmup failed for ${failures.length}/${requests.length} request(s). ` +
        `First failure: ${failures[0].path}: ${failures[0].error}`,
    );
  }

  return result;
}

export async function warmCdnCacheFromPrerender(
  options: PrerenderCdnWarmOptions,
): Promise<CdnWarmResult> {
  const plan = readPrerenderWarmPlan(options.root, {
    includeFallbackShells: options.includeFallbackShells,
    strict: options.strict,
  });
  const warmPlan = {
    deploymentId: plan.deploymentId,
    loadingShellPaths: plan.loadingShellPaths,
    pagesDataPaths: plan.pagesDataPaths,
    paths: plan.paths,
    routeHandlerPaths: plan.routeHandlerPaths,
    rscPaths: plan.rscPaths,
  };
  return warmCdnCache({
    ...options,
    ...warmPlan,
    expectedBuildId:
      options.expectedBuildId ??
      (options.validateBuildIdentity === false ? undefined : plan.buildIdentity),
    expectedRscBuildId: options.expectedRscBuildId ?? plan.rscBuildId,
  });
}
