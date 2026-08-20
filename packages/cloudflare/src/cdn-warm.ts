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
  VINEXT_RSC_BUILD_ID_HEADER,
  VINEXT_RSC_CONTENT_TYPE,
  VINEXT_RSC_VARY_HEADER,
} from "vinext/internal/server/app-rsc-cache-busting";
import { isNonCacheableCacheControl } from "vinext/shims/cdn-cache";
import { normalizePathTrailingSlash } from "vinext/shims/url-utils";

export type CdnWarmOptions = {
  targetUrl: string;
  paths: readonly string[];
  /** App Router ISR paths whose definitive client-navigation payload is warmed. */
  rscPaths?: readonly string[];
  /** App Router paths whose deterministic loading-boundary payload is warmed. */
  loadingShellPaths?: readonly string[];
  /** Build identity that the warmed RSC response must have been rendered by. */
  expectedRscBuildId?: string;
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

export const DEFAULT_CDN_WARM_TIMEOUT_MS = 5_000;

export type PrerenderCdnWarmOptions = Omit<CdnWarmOptions, "paths"> & {
  root: string;
  includeFallbackShells?: boolean;
};

export type CdnWarmResult = {
  total: number;
  warmed: number;
  skipped: number;
  failed: number;
  failures: Array<{ path: string; error: string }>;
};

export type PrerenderWarmPlan = {
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
  kind: "html" | "rsc";
  label: string;
  pathname: string;
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
const ADMITTED_CF_CACHE_STATUSES = new Set([
  "HIT",
  "MISS",
  "EXPIRED",
  "REVALIDATED",
  "UPDATING",
  "STALE",
]);
const NON_CACHEABLE_CF_CACHE_STATUSES = new Set(["BYPASS", "DYNAMIC"]);

type WarmValidation =
  | { outcome: "warmed" }
  | { outcome: "skipped"; reason: string }
  | { outcome: "failed"; error: string };

function validateCachePolicy(response: Response, requireCacheStatus: boolean): WarmValidation {
  const nonCacheableHeaders = [
    "Cache-Control",
    "CDN-Cache-Control",
    "Cloudflare-CDN-Cache-Control",
  ].filter((name) => {
    const value = response.headers.get(name);
    return value !== null && isNonCacheableCacheControl(value);
  });
  const hasSetCookie = response.headers.has("Set-Cookie");
  const cacheStatus = response.headers.get("CF-Cache-Status")?.trim().toUpperCase();

  if (nonCacheableHeaders.length > 0 || hasSetCookie) {
    const reason =
      nonCacheableHeaders.length > 0
        ? `${nonCacheableHeaders.join(", ")} opts out of caching`
        : "response sets a cookie";
    if (cacheStatus && NON_CACHEABLE_CF_CACHE_STATUSES.has(cacheStatus)) {
      return { outcome: "skipped", reason };
    }
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
  if (!ADMITTED_CF_CACHE_STATUSES.has(cacheStatus)) {
    return { outcome: "failed", error: `CF-Cache-Status is ${cacheStatus}` };
  }
  return { outcome: "warmed" };
}

function validateRscWarmResponse(response: Response, expectedRscBuildId?: string): WarmValidation {
  if (response.redirected || response.status < 200 || response.status >= 300) {
    return {
      outcome: "failed",
      error: response.redirected ? "redirected response" : `HTTP ${response.status}`,
    };
  }
  if (!response.headers.get("Content-Type")?.toLowerCase().startsWith(VINEXT_RSC_CONTENT_TYPE)) {
    return { outcome: "failed", error: `expected ${VINEXT_RSC_CONTENT_TYPE} response` };
  }
  if (
    expectedRscBuildId !== undefined &&
    response.headers.get(VINEXT_RSC_BUILD_ID_HEADER) !== expectedRscBuildId
  ) {
    return {
      outcome: "failed",
      error: `response ${VINEXT_RSC_BUILD_ID_HEADER} does not match build ${expectedRscBuildId}`,
    };
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
  const extraVary = Array.from(vary).find((name) => !REQUIRED_RSC_VARY_HEADERS.includes(name));
  if (extraVary) {
    return { outcome: "failed", error: `response Vary has unsupported field ${extraVary}` };
  }
  return validateCachePolicy(response, true);
}

function validateHtmlWarmResponse(response: Response): WarmValidation {
  if (response.redirected || response.status < 200 || response.status >= 300) {
    return {
      outcome: "failed",
      error: response.redirected ? "redirected response" : `HTTP ${response.status}`,
    };
  }
  return validateCachePolicy(response, true);
}

async function warmOnePath(
  target: WarmTarget,
  options: Required<Pick<CdnWarmOptions, "targetUrl" | "timeoutMs" | "retries">> & {
    fetchImpl: typeof fetch;
    headers?: HeadersInit;
    expectedRscBuildId?: string;
    retryAllValidationErrors: boolean;
    retryDeadlineAt?: number;
    retryDelayMs: number;
    retryNotFound: boolean;
  },
): Promise<
  | { path: string; ok: true; skipped: false }
  | { path: string; ok: true; skipped: true; reason: string }
  | { path: string; ok: false; error: string }
> {
  const url = buildWarmupUrl(options.targetUrl, target.pathname);
  let lastError = "propagation deadline expired before request";
  const retryDeadline = options.retryDeadlineAt;

  const canRetry = (attempt: number): boolean =>
    attempt < options.retries && (retryDeadline === undefined || Date.now() < retryDeadline);

  const waitBeforeRetry = async (): Promise<void> => {
    if (options.retryDelayMs <= 0) return;
    const delay =
      retryDeadline === undefined
        ? options.retryDelayMs
        : Math.min(options.retryDelayMs, Math.max(0, retryDeadline - Date.now()));
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
  };

  for (let attempt = 0; attempt <= options.retries; attempt++) {
    if (retryDeadline !== undefined && Date.now() >= retryDeadline) break;
    try {
      const timeoutMs =
        retryDeadline === undefined
          ? options.timeoutMs
          : Math.min(options.timeoutMs, Math.max(1, retryDeadline - Date.now()));
      const { response } = await fetchWithTimeout(
        options.fetchImpl,
        url,
        timeoutMs,
        target.headers ?? options.headers,
        "manual",
      );

      if (target.kind === "rsc") {
        const validation = validateRscWarmResponse(response, options.expectedRscBuildId);
        if (validation.outcome === "warmed") {
          return { path: target.label, ok: true, skipped: false };
        }
        if (validation.outcome === "skipped") {
          return { path: target.label, ok: true, skipped: true, reason: validation.reason };
        }
        lastError = validation.error;
        if (
          !options.retryAllValidationErrors &&
          !isRetryableStatus(response.status, options.retryNotFound)
        )
          break;
        if (!canRetry(attempt)) break;
        await waitBeforeRetry();
        continue;
      }

      const validation = validateHtmlWarmResponse(response);
      if (validation.outcome === "warmed") {
        return { path: target.label, ok: true, skipped: false };
      }
      if (validation.outcome === "skipped") {
        return { path: target.label, ok: true, skipped: true, reason: validation.reason };
      }
      lastError = validation.error;
      if (
        !options.retryAllValidationErrors &&
        !isRetryableStatus(response.status, options.retryNotFound)
      )
        break;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        lastError = `timed out after ${options.timeoutMs}ms`;
      } else {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
    if (!canRetry(attempt)) break;
    await waitBeforeRetry();
  }

  return { path: target.label, ok: false, error: lastError };
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
  const loadingShellPaths = new Set(options.loadingShellPaths ?? []);
  const commonHeaders = new Headers(options.headers);
  for (const pathname of options.rscPaths ?? []) {
    const rscHeaders = new Headers(commonHeaders);
    for (const [name, value] of createCanonicalRscRequestHeaders(options.deploymentId)) {
      rscHeaders.set(name, value);
    }
    requests.push({
      headers: rscHeaders,
      kind: "rsc",
      label: `${pathname} (RSC full)`,
      pathname: createCanonicalRscRequestUrl(pathname),
    });

    if (loadingShellPaths.has(pathname)) {
      const loadingHeaders = new Headers(commonHeaders);
      for (const [name, value] of createCanonicalLoadingShellRscRequestHeaders(
        options.deploymentId,
      )) {
        loadingHeaders.set(name, value);
      }
      requests.push({
        headers: loadingHeaders,
        kind: "rsc",
        label: `${pathname} (RSC loading shell)`,
        pathname: createCanonicalRscRequestUrl(pathname),
      });
    }
  }

  for (const pathname of options.paths) {
    const htmlHeaders = new Headers(commonHeaders);
    htmlHeaders.set("Accept", "text/html");
    htmlRequests.push({ headers: htmlHeaders, kind: "html", label: pathname, pathname });
  }
  // For a serialized propagating target, prove that requests have reached the
  // uploaded build before filling any HTML cache entries.
  requests.push(...htmlRequests);
  const timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_CDN_WARM_TIMEOUT_MS);
  const hasVersionOverride = new Headers(options.headers).has(WORKER_VERSION_OVERRIDE_HEADER);
  const propagatingTarget = options.propagatingTarget ?? hasVersionOverride;
  // Immediately after upload, prove the RSC handler and immutable assets have
  // reached the new build, then give the first real HTML fill the same bounded
  // propagation policy. Once those gates pass, fill the remaining independent
  // cache keys concurrently under the same bounded propagation deadline.
  const concurrency = Math.max(1, options.concurrency ?? 10);
  const normalRetries = Math.max(0, options.retries ?? 1);
  const propagationRetries = Math.max(0, options.retries ?? 30);
  const normalRetryDelayMs = Math.max(0, options.retryDelayMs ?? 0);
  const propagationRetryDelayMs = Math.max(0, options.retryDelayMs ?? 1_000);
  const fetchImpl = options.fetchImpl ?? fetch;
  const createPropagationDeadline = (): number | undefined =>
    propagatingTarget && options.retries === undefined ? Date.now() + 30_000 : undefined;

  if (requests.length === 0) {
    return { total: 0, warmed: 0, skipped: 0, failed: 0, failures: [] };
  }

  console.log(`\n  Warming CDN cache with ${requests.length} discovered request(s)...`);

  const progress = new CdnWarmProgress();
  let completedRequests = 0;
  progress.update(0, requests.length, "waiting for uploaded build");

  const warmTarget = (
    target: WarmTarget,
    propagationGate = false,
    retryDeadlineAt = propagationGate ? createPropagationDeadline() : undefined,
  ) =>
    warmOnePath(target, {
      targetUrl: options.targetUrl,
      timeoutMs,
      retries: propagationGate ? propagationRetries : normalRetries,
      fetchImpl,
      headers: options.headers,
      expectedRscBuildId: options.expectedRscBuildId,
      retryAllValidationErrors: propagationGate,
      retryDeadlineAt,
      retryDelayMs: propagationGate ? propagationRetryDelayMs : normalRetryDelayMs,
      retryNotFound: propagationGate,
    });

  const warmRequest = async (
    target: WarmTarget,
    propagationGate = false,
    retryDeadlineAt?: number,
  ): Promise<Awaited<ReturnType<typeof warmOnePath>>> => {
    const result = await warmTarget(target, propagationGate, retryDeadlineAt);
    progress.update(++completedRequests, requests.length, target.label);
    return result;
  };

  const skipRequests = (
    targets: readonly WarmTarget[],
    error: string,
  ): Array<{ path: string; ok: false; error: string }> =>
    targets.map((target) => {
      progress.update(++completedRequests, requests.length, target.label);
      return { path: target.label, ok: false as const, error };
    });

  const warmAfterHtmlGate = async (
    confirmed: Awaited<ReturnType<typeof warmOnePath>>[],
    remaining: readonly WarmTarget[],
    propagationDeadlineAt?: number,
  ): Promise<Awaited<ReturnType<typeof warmOnePath>>[]> => {
    const htmlGateIndex = remaining.findIndex((target) => target.kind === "html");
    if (htmlGateIndex < 0) {
      return [
        ...confirmed,
        ...(await runWithConcurrency(remaining, concurrency, (target) =>
          warmRequest(target, true, propagationDeadlineAt),
        )),
      ];
    }

    const htmlGateResult = await warmRequest(remaining[htmlGateIndex], true, propagationDeadlineAt);
    const afterHtmlGate = remaining.filter((_target, index) => index !== htmlGateIndex);
    if (!htmlGateResult.ok) {
      return [
        ...confirmed,
        htmlGateResult,
        ...skipRequests(
          afterHtmlGate,
          `skipped because the first HTML request did not reach the uploaded build: ${htmlGateResult.error}`,
        ),
      ];
    }
    return [
      ...confirmed,
      htmlGateResult,
      ...(await runWithConcurrency(afterHtmlGate, concurrency, (target) =>
        warmRequest(target, true, propagationDeadlineAt),
      )),
    ];
  };

  const gateIndex = propagatingTarget ? requests.findIndex((target) => target.kind === "rsc") : -1;
  let results: Awaited<ReturnType<typeof warmOnePath>>[];
  if (gateIndex >= 0) {
    const propagationDeadlineAt = createPropagationDeadline();
    const gateResult = await warmRequest(requests[gateIndex], true, propagationDeadlineAt);
    const remaining = requests.filter((_target, index) => index !== gateIndex);
    if (gateResult.ok) {
      results = await warmAfterHtmlGate([gateResult], remaining, propagationDeadlineAt);
    } else {
      results = [
        gateResult,
        ...skipRequests(
          remaining,
          "skipped because the uploaded RSC build identity was not confirmed",
        ),
      ];
    }
  } else if (propagatingTarget) {
    results = await warmAfterHtmlGate([], requests, createPropagationDeadline());
  } else {
    results = await runWithConcurrency(requests, concurrency, (target) => warmRequest(target));
  }

  progress.finish();

  const failures = results
    .filter((result): result is { path: string; ok: false; error: string } => !result.ok)
    .map(({ path, error }) => ({ path, error }));
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
  return warmCdnCache({ ...options, ...plan });
}
