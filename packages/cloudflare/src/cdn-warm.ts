import path from "node:path";
import fs from "node:fs";
import {
  PRERENDER_PATHS_MANIFEST,
  type PrerenderPathManifest,
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
import { VINEXT_CDN_BUILD_ID_HEADER } from "./cache/cdn-build-id.js";

export type CdnWarmOptions = {
  targetUrl: string;
  paths: readonly string[];
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
  /** Retry a newly staged version or preview alias until its routing has propagated. */
  propagatingTarget?: boolean;
  strict?: boolean;
  fetchImpl?: typeof fetch;
};

export const DEFAULT_CDN_WARM_CONCURRENCY = 25;
export const DEFAULT_CDN_WARM_TIMEOUT_MS = 10_000;

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
  retryPlan: CdnWarmRequestPlan;
};

export type CdnWarmRequestPlan = {
  loadingShellPaths: string[];
  paths: string[];
  rscPaths: string[];
};

export type PrerenderWarmPlan = {
  buildId?: string;
  buildIdentity?: string;
  deploymentId?: string;
  loadingShellPaths: string[];
  paths: string[];
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
      (manifest.pagesPaths !== undefined &&
        (!Array.isArray(manifest.pagesPaths) ||
          !manifest.pagesPaths.every((pathname) => typeof pathname === "string"))) ||
      (manifest.rscPaths !== undefined &&
        (!Array.isArray(manifest.rscPaths) ||
          !manifest.rscPaths.every((pathname) => typeof pathname === "string"))) ||
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
      .map((pathname) => applyWarmPathConfig(pathname, manifest)),
    paths: manifest.paths
      .filter((pathname) => pathname.startsWith("/"))
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
        .map(applyConfig);
    }
  }
  return {
    buildId: manifest.buildId,
    ...(manifest.buildIdentity ? { buildIdentity: manifest.buildIdentity } : {}),
    ...(manifest.deploymentId ? { deploymentId: manifest.deploymentId } : {}),
    loadingShellPaths: supportsCanonicalRsc
      ? (manifest.loadingShellPaths ?? []).map(applyConfig)
      : [],
    paths: htmlPaths,
    ...(supportsCanonicalRsc ? { rscBuildId: manifest.rscBuildId } : {}),
    rscPaths: supportsCanonicalRsc ? manifest.rscPaths!.map(applyConfig) : [],
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

type WarmTarget = {
  headers?: HeadersInit;
  kind: "html" | "rsc-full" | "rsc-loading-shell";
  label: string;
  pathname: string;
  sourcePathname: string;
};

class CdnWarmProgress {
  private readonly isTTY = process.stderr.isTTY;
  private lastLineLength = 0;

  update(completed: number, total: number, label: string): void {
    if (!this.isTTY) return;
    const percent = total > 0 ? Math.floor((completed / total) * 100) : 0;
    const filled = Math.floor(percent / 5);
    const bar = `[${"█".repeat(filled)}${" ".repeat(20 - filled)}]`;
    const maxLabelLength = 40;
    const shortLabel =
      label.length > maxLabelLength ? `…${label.slice(-(maxLabelLength - 1))}` : label;
    const line = `Warming CDN cache... ${bar} ${String(completed).padStart(String(total).length)}/${total} ${shortLabel}`;
    process.stderr.write(`\r${line.padEnd(this.lastLineLength)}`);
    this.lastLineLength = line.length;
  }

  finish(): void {
    if (!this.isTTY) return;
    process.stderr.write(`\r${" ".repeat(this.lastLineLength)}\r`);
  }
}

const REQUIRED_RSC_VARY_HEADERS = VINEXT_RSC_VARY_HEADER.split(",").map((name) =>
  name.trim().toLowerCase(),
);
const ADMITTED_CF_CACHE_STATUSES = new Set(["HIT", "MISS", "EXPIRED", "REVALIDATED", "UPDATING"]);
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

function validateCachePolicy(response: Response, requireCacheStatus: boolean): WarmValidation {
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
    return {
      outcome: "failed",
      error: `response ${VINEXT_CDN_BUILD_ID_HEADER} does not match build ${expectedBuildId}`,
    };
  }
  return null;
}

function validateRscWarmResponse(
  response: Response,
  expectedBuildId?: string,
  expectedRscBuildId?: string,
): WarmValidation {
  if (response.redirected || response.status < 200 || response.status >= 300) {
    return {
      outcome: "failed",
      error: response.redirected ? "redirected response" : `HTTP ${response.status}`,
    };
  }
  if (!response.headers.get("Content-Type")?.toLowerCase().startsWith(VINEXT_RSC_CONTENT_TYPE)) {
    return { outcome: "failed", error: `expected ${VINEXT_RSC_CONTENT_TYPE} response` };
  }
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
  const cachePolicyValidation = validateCachePolicy(response, true);
  if (cachePolicyValidation.outcome !== "warmed") return cachePolicyValidation;
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
  const extraVary = Array.from(vary).find((name) => !REQUIRED_RSC_VARY_HEADERS.includes(name));
  if (extraVary) {
    return { outcome: "failed", error: `response Vary has unsupported field ${extraVary}` };
  }
  return { outcome: "warmed" };
}

function validateHtmlWarmResponse(response: Response, expectedBuildId?: string): WarmValidation {
  if (response.redirected || response.status < 200 || response.status >= 300) {
    return {
      outcome: "failed",
      error: response.redirected ? "redirected response" : `HTTP ${response.status}`,
    };
  }
  const buildIdentityValidation = validateBuildIdentity(response, expectedBuildId);
  if (buildIdentityValidation) return buildIdentityValidation;
  const cachePolicyValidation = validateCachePolicy(response, true);
  if (cachePolicyValidation.outcome !== "warmed") return cachePolicyValidation;
  const extraVary = (response.headers.get("Vary") ?? "")
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .find((name) => name && !REQUIRED_RSC_VARY_HEADERS.includes(name));
  if (extraVary) {
    return { outcome: "failed", error: `response Vary has unsupported field ${extraVary}` };
  }
  return { outcome: "warmed" };
}

function shouldRetryValidationFailure(
  response: Response,
  target: WarmTarget,
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
    target.kind === "html" || options.expectedRscBuildId === undefined
      ? null
      : response.headers.get(VINEXT_RSC_BUILD_ID_HEADER) === options.expectedRscBuildId,
  ].filter((matches): matches is boolean => matches !== null);
  if (expectedIdentities.some((matches) => !matches)) return true;

  // A matching identity proves routing reached the uploaded Worker. From that
  // point, retry only transient HTTP failures; response-shape and admission
  // failures are deterministic for that build.
  if (expectedIdentities.length > 0) {
    return isRetryableStatus(response.status, false);
  }
  return isRetryableStatus(response.status, options.retryNotFound);
}

async function warmOnePath(
  target: WarmTarget,
  options: Required<Pick<CdnWarmOptions, "targetUrl" | "timeoutMs" | "retries">> & {
    fetchImpl: typeof fetch;
    headers?: HeadersInit;
    expectedBuildId?: string;
    expectedRscBuildId?: string;
    retryPropagationFailures: boolean;
    retryDelayMs: number;
    retryNotFound: boolean;
  },
): Promise<
  | { path: string; ok: true; skipped: false }
  | { path: string; ok: true; skipped: true; reason: string }
  | { path: string; ok: false; error: string; retryable: boolean }
> {
  const url = buildWarmupUrl(options.targetUrl, target.pathname);
  let lastError = "request failed before the first attempt";
  let lastRetryable = true;

  const canRetry = (attempt: number): boolean => attempt < options.retries;

  const waitBeforeRetry = async (): Promise<void> => {
    if (options.retryDelayMs <= 0) return;
    await new Promise((resolve) => setTimeout(resolve, options.retryDelayMs));
  };

  for (let attempt = 0; attempt <= options.retries; attempt++) {
    try {
      const { response } = await fetchWithTimeout(
        options.fetchImpl,
        url,
        options.timeoutMs,
        target.headers ?? options.headers,
        "manual",
      );

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

      if (target.kind !== "html") {
        const validation = validateRscWarmResponse(
          response,
          options.expectedBuildId,
          options.expectedRscBuildId,
        );
        if (validation.outcome === "warmed") {
          return { path: target.label, ok: true, skipped: false };
        }
        if (validation.outcome === "skipped") {
          return { path: target.label, ok: true, skipped: true, reason: validation.reason };
        }
        lastError = validation.error;
        lastRetryable = shouldRetryValidationFailure(response, target, options);
        if (!lastRetryable) break;
        if (!canRetry(attempt)) break;
        await waitBeforeRetry();
        continue;
      }

      const validation = validateHtmlWarmResponse(response, options.expectedBuildId);
      if (validation.outcome === "warmed") {
        return { path: target.label, ok: true, skipped: false };
      }
      if (validation.outcome === "skipped") {
        return { path: target.label, ok: true, skipped: true, reason: validation.reason };
      }
      lastError = validation.error;
      lastRetryable = shouldRetryValidationFailure(response, target, options);
      if (!lastRetryable) break;
    } catch (error) {
      lastRetryable = true;
      if (error instanceof DOMException && error.name === "AbortError") {
        lastError = `timed out after ${options.timeoutMs}ms`;
      } else {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
    if (!canRetry(attempt)) break;
    await waitBeforeRetry();
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
  const requests: WarmTarget[] = [];
  const htmlRequests: WarmTarget[] = [];
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
      });
    }
  }

  for (const pathname of options.paths) {
    const htmlHeaders = new Headers(commonHeaders);
    htmlHeaders.set("Accept", "text/html");
    htmlRequests.push({
      headers: htmlHeaders,
      kind: "html",
      label: pathname,
      pathname,
      sourcePathname: pathname,
    });
  }
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

  if (requests.length === 0) {
    return {
      total: 0,
      warmed: 0,
      skipped: 0,
      failed: 0,
      failures: [],
      retryPlan: { loadingShellPaths: [], paths: [], rscPaths: [] },
    };
  }

  console.log(`\n  Warming CDN cache with ${requests.length} discovered request(s)...`);

  const progress = new CdnWarmProgress();
  let completedRequests = 0;
  progress.update(0, requests.length, "starting warmup");

  type WarmRetryMode = "normal" | "propagation-pass" | "propagation-retry";
  const warmTarget = (target: WarmTarget, retryMode: WarmRetryMode = "normal") => {
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
      fetchImpl,
      headers: options.headers,
      expectedBuildId: options.expectedBuildId,
      expectedRscBuildId: options.expectedRscBuildId,
      retryPropagationFailures: isPropagationRequest,
      retryDelayMs: isPropagationRequest ? propagationRetryDelayMs : normalRetryDelayMs,
      retryNotFound: isPropagationRequest,
    });
  };

  const warmRequest = async (
    target: WarmTarget,
    retryMode: WarmRetryMode = "normal",
    countCompletion = true,
  ): Promise<Awaited<ReturnType<typeof warmOnePath>>> => {
    const result = await warmTarget(target, retryMode);
    if (countCompletion) completedRequests++;
    progress.update(
      completedRequests,
      requests.length,
      countCompletion ? target.label : `retrying ${target.label}`,
    );
    return result;
  };

  const warmPropagatingPass = async (
    targets: readonly WarmTarget[],
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
          target: WarmTarget;
        } => !entry.result.ok,
      );
    const retryableFailed = failed.filter(({ result }) => result.retryable);
    if (retryableFailed.length === 0 || propagationRetries === 0) return results;

    progress.finish();
    console.log(
      `  CDN warmup: retrying ${retryableFailed.length} failed request(s) after completing the initial pass...`,
    );
    const retried = await runWithConcurrency(
      retryableFailed.map(({ target }) => target),
      concurrency,
      (target) => warmRequest(target, "propagation-retry", false),
    );
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
        target: WarmTarget;
      } => !entry.result.ok,
    );
  const failures = failedRequests.map(({ result: { path, error } }) => ({ path, error }));
  const skippedResults = results.filter((result) => result.ok && result.skipped);
  const warmed = results.length - failures.length - skippedResults.length;

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
    retryPlan: {
      loadingShellPaths: failedRequests
        .filter(({ target }) => target.kind === "rsc-loading-shell")
        .map(({ target }) => target.sourcePathname),
      paths: failedRequests
        .filter(({ target }) => target.kind === "html")
        .map(({ target }) => target.sourcePathname),
      rscPaths: failedRequests
        .filter(({ target }) => target.kind === "rsc-full")
        .map(({ target }) => target.sourcePathname),
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
    paths: plan.paths,
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
