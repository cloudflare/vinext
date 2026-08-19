import path from "node:path";
import fs from "node:fs";
import {
  PRERENDER_PATHS_MANIFEST,
  type PrerenderPathManifest,
} from "vinext/internal/build/prerender-paths";
import {
  getPrerenderedConcretePaths,
  getPrewarmableAppPaths,
  readPrerenderManifest,
  type PrerenderManifest,
  type PrerenderedPathSelectionOptions,
} from "vinext/internal/server/prerender-manifest";
import {
  createCanonicalRscRequestHeaders,
  createRscRequestUrl,
  VINEXT_RSC_BUILD_ID_HEADER,
  VINEXT_RSC_CONTENT_TYPE,
  VINEXT_RSC_VARY_HEADER,
} from "vinext/internal/server/app-rsc-cache-busting";
import { normalizePathTrailingSlash } from "vinext/shims/url-utils";

export type CdnWarmOptions = {
  targetUrl: string;
  paths: readonly string[];
  /** App Router ISR paths whose definitive client-navigation payload is warmed. */
  rscPaths?: readonly string[];
  /** Build identity that the warmed RSC response must have been rendered by. */
  expectedRscBuildId?: string;
  /** Immutable same-origin asset that proves the uploaded build is serving. */
  buildIdentityPath?: string;
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
  failed: number;
  failures: Array<{ path: string; error: string }>;
};

export type PrerenderWarmPlan = {
  buildIdentityPath?: string;
  deploymentId?: string;
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
      (manifest.basePath !== undefined && typeof manifest.basePath !== "string") ||
      (manifest.buildIdentityPath !== undefined &&
        typeof manifest.buildIdentityPath !== "string") ||
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
  const manifest = readPrerenderManifest(
    path.join(root, "dist", "server", "vinext-prerender.json"),
  );
  if (!manifest) {
    if (pathPlan) {
      console.warn(
        "[vinext] CDN warmup has no completed prerender manifest; RSC warmup is disabled.",
      );
      return {
        ...(pathPlan.manifest.buildIdentityPath
          ? { buildIdentityPath: pathPlan.manifest.buildIdentityPath }
          : {}),
        ...(pathPlan.manifest.deploymentId ? { deploymentId: pathPlan.manifest.deploymentId } : {}),
        paths: pathPlan.paths,
        rscPaths: [],
      };
    }
    const message = "[vinext] CDN warmup skipped: prerender manifest not found.";
    if (options?.strict) throw new Error(message);
    return { paths: [], rscPaths: [] };
  }

  const builtBuildId = readBuiltBuildId(root);
  if (!manifest.buildId || !builtBuildId || manifest.buildId !== builtBuildId) {
    const message =
      "[vinext] CDN warmup skipped: prerender manifest buildId does not match dist/server/BUILD_ID.";
    if (options?.strict) throw new Error(message);
    console.warn(message);
    return { paths: [], rscPaths: [] };
  }

  const pathConfig = pathPlan?.manifest ?? {};
  const appPaths = getPrewarmableAppPaths(manifest);
  const hasFinalRscEligibility =
    pathPlan?.manifest.responseVary === "verbatim" &&
    pathPlan.manifest.rscPaths !== undefined &&
    !!pathPlan.manifest.rscBuildId;
  const appHtmlPaths =
    hasFinalRscEligibility && !options?.includeFallbackShells
      ? appPaths
      : getPrerenderedConcretePaths(manifest, {
          ...options,
          router: "app",
        });
  const pagePaths = getPrerenderedConcretePaths(manifest, {
    ...options,
    router: "pages",
  });
  const pagesHtmlPaths =
    pathPlan?.manifest.pagesPaths !== undefined
      ? pathPlan.pagesPaths
      : pagePaths.map((pathname) => applyWarmPathConfig(pathname, pathConfig));
  const completedHtmlPaths = Array.from(
    new Set([
      ...appHtmlPaths.map((pathname) => applyWarmPathConfig(pathname, pathConfig)),
      ...pagesHtmlPaths,
    ]),
  );
  return {
    ...(pathPlan?.manifest.buildIdentityPath
      ? { buildIdentityPath: pathPlan.manifest.buildIdentityPath }
      : {}),
    ...(pathPlan?.manifest.deploymentId ? { deploymentId: pathPlan.manifest.deploymentId } : {}),
    ...(hasFinalRscEligibility ? { rscBuildId: pathPlan.manifest.rscBuildId } : {}),
    paths: completedHtmlPaths,
    rscPaths: hasFinalRscEligibility
      ? appPaths.map((pathname) => applyWarmPathConfig(pathname, pathConfig))
      : [],
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
): Promise<Response> {
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
        await response.arrayBuffer();
        return response;
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
  kind: "html" | "identity" | "rsc";
  label: string;
  pathname: string;
};

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

function validateRscWarmResponse(response: Response, expectedRscBuildId?: string): string | null {
  if (response.redirected || response.status < 200 || response.status >= 300) {
    return response.redirected ? "redirected response" : `HTTP ${response.status}`;
  }
  if (!response.headers.get("Content-Type")?.toLowerCase().startsWith(VINEXT_RSC_CONTENT_TYPE)) {
    return `expected ${VINEXT_RSC_CONTENT_TYPE} response`;
  }
  if (
    expectedRscBuildId !== undefined &&
    response.headers.get(VINEXT_RSC_BUILD_ID_HEADER) !== expectedRscBuildId
  ) {
    return `response ${VINEXT_RSC_BUILD_ID_HEADER} does not match build ${expectedRscBuildId}`;
  }

  const vary = new Set(
    (response.headers.get("Vary") ?? "")
      .split(",")
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean),
  );
  const missingVary = REQUIRED_RSC_VARY_HEADERS.find((name) => !vary.has(name));
  if (missingVary) return `response Vary is missing ${missingVary}`;
  const extraVary = Array.from(vary).find((name) => !REQUIRED_RSC_VARY_HEADERS.includes(name));
  if (extraVary) return `response Vary has unsupported field ${extraVary}`;

  for (const name of ["Cache-Control", "CDN-Cache-Control", "Cloudflare-CDN-Cache-Control"]) {
    const value = response.headers.get(name);
    if (value && /\b(?:private|no-store|no-cache)\b/i.test(value)) {
      return `${name} is not cacheable`;
    }
  }
  const cacheStatus = response.headers.get("CF-Cache-Status")?.toUpperCase();
  if (!cacheStatus) return "response is missing CF-Cache-Status";
  if (!ADMITTED_CF_CACHE_STATUSES.has(cacheStatus)) {
    return `CF-Cache-Status is ${cacheStatus}`;
  }
  return null;
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
): Promise<{ path: string; ok: true } | { path: string; ok: false; error: string }> {
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
      const response = await fetchWithTimeout(
        options.fetchImpl,
        url,
        timeoutMs,
        target.headers ?? options.headers,
        target.kind === "html" ? "follow" : "manual",
      );

      if (target.kind === "rsc") {
        const validationError = validateRscWarmResponse(response, options.expectedRscBuildId);
        if (validationError === null) return { path: target.label, ok: true };
        lastError = validationError;
        if (
          !options.retryAllValidationErrors &&
          !isRetryableStatus(response.status, options.retryNotFound)
        )
          break;
        if (!canRetry(attempt)) break;
        await waitBeforeRetry();
        continue;
      }

      if (target.kind === "identity") {
        if (!response.redirected && response.status >= 200 && response.status < 300) {
          return { path: target.label, ok: true };
        }
        lastError = response.redirected ? "redirected response" : `HTTP ${response.status}`;
        if (!isRetryableStatus(response.status, options.retryNotFound)) break;
      } else if (response.status < 400) {
        return { path: target.label, ok: true };
      } else {
        lastError = `HTTP ${response.status}`;
        if (!isRetryableStatus(response.status, options.retryNotFound)) break;
      }
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
  const rscPaths = new Set(options.rscPaths ?? []);
  const commonHeaders = new Headers(options.headers);
  for (const pathname of options.paths) {
    if (rscPaths.has(pathname)) {
      const rscHeaders = new Headers(commonHeaders);
      for (const [name, value] of createCanonicalRscRequestHeaders(options.deploymentId)) {
        rscHeaders.set(name, value);
      }
      requests.push({
        headers: rscHeaders,
        kind: "rsc",
        label: `${pathname} (RSC)`,
        pathname: await createRscRequestUrl(pathname, rscHeaders),
      });
    }

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
  // Immediately after a 0% staging deployment, first prove one RSC request has
  // reached the uploaded build. Once it has, fill the remaining independent
  // cache keys with normal concurrency; a propagation deadline must not cap a
  // large warm plan that has already passed the identity gate.
  const concurrency = Math.max(1, options.concurrency ?? 10);
  const normalRetries = Math.max(0, options.retries ?? 1);
  const propagationRetries = Math.max(0, options.retries ?? 30);
  const normalRetryDelayMs = Math.max(0, options.retryDelayMs ?? 0);
  const propagationRetryDelayMs = Math.max(0, options.retryDelayMs ?? 1_000);
  const fetchImpl = options.fetchImpl ?? fetch;
  const propagationDeadlineAt =
    propagatingTarget && options.retries === undefined ? Date.now() + 30_000 : undefined;

  if (requests.length === 0) {
    return { total: 0, warmed: 0, failed: 0, failures: [] };
  }

  console.log(`\n  Warming CDN cache with ${requests.length} prerendered request(s)...`);

  const warmTarget = (target: WarmTarget, propagationGate = false) =>
    warmOnePath(target, {
      targetUrl: options.targetUrl,
      timeoutMs,
      retries: propagationGate ? propagationRetries : normalRetries,
      fetchImpl,
      headers: options.headers,
      expectedRscBuildId: options.expectedRscBuildId,
      retryAllValidationErrors: propagationGate,
      retryDeadlineAt: propagationGate ? propagationDeadlineAt : undefined,
      retryDelayMs: propagationGate ? propagationRetryDelayMs : normalRetryDelayMs,
      retryNotFound: propagationGate,
    });

  const gateIndex = propagatingTarget ? requests.findIndex((target) => target.kind === "rsc") : -1;
  const buildIdentityGate =
    propagatingTarget && gateIndex < 0 && options.buildIdentityPath
      ? ({
          kind: "identity",
          label: "uploaded build identity",
          pathname: options.buildIdentityPath,
        } satisfies WarmTarget)
      : null;
  let results: Awaited<ReturnType<typeof warmOnePath>>[];
  if (gateIndex >= 0) {
    const gateResult = await warmTarget(requests[gateIndex], true);
    const remaining = requests.filter((_target, index) => index !== gateIndex);
    if (gateResult.ok) {
      results = [
        gateResult,
        ...(await runWithConcurrency(remaining, concurrency, (target) => warmTarget(target))),
      ];
    } else {
      results = [
        gateResult,
        ...remaining.map((target) => ({
          path: target.label,
          ok: false as const,
          error: "skipped because the uploaded RSC build identity was not confirmed",
        })),
      ];
    }
  } else if (buildIdentityGate) {
    const gateResult = await warmTarget(buildIdentityGate, true);
    results = gateResult.ok
      ? await runWithConcurrency(requests, concurrency, (target) => warmTarget(target))
      : requests.map((target) => ({
          path: target.label,
          ok: false as const,
          error: `skipped because the uploaded build identity was not confirmed: ${gateResult.error}`,
        }));
  } else {
    // Legacy callers/manifests have no build-identity asset. Preserve their
    // propagation retry behavior; current build output always supplies a gate.
    results = await runWithConcurrency(requests, concurrency, (target) =>
      warmTarget(target, propagatingTarget),
    );
  }

  const failures = results
    .filter((result): result is { path: string; ok: false; error: string } => !result.ok)
    .map(({ path, error }) => ({ path, error }));
  const warmed = results.length - failures.length;

  console.log(`  CDN warmup: ${warmed}/${requests.length} request(s) warmed.`);
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
