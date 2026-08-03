import path from "node:path";
import fs from "node:fs";
import {
  PRERENDER_PATHS_MANIFEST,
  type PrerenderPathManifest,
} from "vinext/internal/build/prerender-paths";
import {
  getPrewarmableAppPaths,
  getPrewarmableConcretePaths,
  readPrerenderManifest,
  type PrerenderManifest,
  type PrerenderedPathSelectionOptions,
} from "vinext/internal/server/prerender-manifest";
import type { RscCacheKeyMode } from "vinext/internal/cache-adapters";
import {
  createRscRequestHeaders,
  createRscRequestUrl,
  VINEXT_RSC_CONTENT_TYPE,
  VINEXT_RSC_NON_CONTEXTUAL_VARY_HEADER,
  VINEXT_RSC_VARY_HEADER,
} from "vinext/internal/server/app-rsc-cache-busting";
import { normalizePathTrailingSlash } from "vinext/shims/url-utils";

// Keep these deploy-probe protocol names in sync with the Cloudflare CDN adapter.
const VINEXT_VERSION_PROBE_HEADER = "X-Vinext-Version-Probe";
const VINEXT_VERSION_PROBE_QUERY = "__vinext_version_probe";
const VINEXT_WORKER_VERSION_HEADER = "X-Vinext-Worker-Version";
const CLOUDFLARE_FORWARDED_PROTO_HEADER = "X-Forwarded-Proto";

export type CdnWarmOptions = {
  targetUrl: string;
  paths: readonly string[];
  /** App Router paths whose ordinary client-navigation RSC variant should also be warmed. */
  rscPaths?: readonly string[];
  /** RSC URL mode compiled into the deployed browser/server bundles. */
  rscCacheKeyMode?: RscCacheKeyMode;
  /** Deployment ID compiled into client-side RSC request headers. */
  deploymentId?: string;
  headers?: HeadersInit;
  concurrency?: number;
  timeoutMs?: number;
  retries?: number;
  strict?: boolean;
  fetchImpl?: typeof fetch;
};

export const DEFAULT_CDN_WARM_TIMEOUT_MS = 5_000;
export const DEFAULT_VERSION_PROBE_RETRIES = 8;
export const DEFAULT_VERSION_PROBE_RETRY_DELAY_MS = 250;

export type WorkerVersionProbeResult =
  | { verified: true }
  | { verified: false; reason: "binding-unavailable" | "not-ready" };

export type WorkerVersionProbeOptions = {
  targetUrl: string;
  pathname: string;
  versionId: string;
  headers?: HeadersInit;
  timeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
  fetchImpl?: typeof fetch;
};

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
  deploymentId?: string;
  paths: string[];
  rscPaths: string[];
  rscCacheKeyMode: RscCacheKeyMode;
};

type PrerenderPathWarmPlan = PrerenderWarmPlan & {
  appPaths: string[];
  pathConfig: Pick<PrerenderPathManifest, "basePath" | "trailingSlash">;
};

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}

function isSafeWarmPathname(pathname: string): boolean {
  return (
    pathname.startsWith("/") &&
    !pathname.startsWith("//") &&
    !/[\\?#]/.test(pathname) &&
    !hasControlCharacter(pathname)
  );
}

function isSafeWarmPathAndSearch(value: string): boolean {
  const queryIndex = value.indexOf("?");
  const pathname = queryIndex === -1 ? value : value.slice(0, queryIndex);
  const search = queryIndex === -1 ? "" : value.slice(queryIndex + 1);
  return (
    isSafeWarmPathname(pathname) &&
    !search.includes("#") &&
    !search.includes("\\") &&
    !hasControlCharacter(search)
  );
}

function applyWarmPathConfig(
  pathname: string,
  config: Pick<PrerenderPathManifest, "basePath" | "trailingSlash">,
): string {
  const withBasePath = config.basePath
    ? pathname === "/"
      ? config.basePath
      : `${config.basePath}${pathname}`
    : pathname;
  return normalizePathTrailingSlash(withBasePath, config.trailingSlash === true);
}

function toPublicWarmPlan(plan: PrerenderPathWarmPlan): PrerenderWarmPlan {
  return {
    ...(plan.deploymentId ? { deploymentId: plan.deploymentId } : {}),
    paths: plan.paths,
    rscPaths: plan.rscPaths,
    rscCacheKeyMode: plan.rscCacheKeyMode,
  };
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
      manifest.basePath !== undefined &&
      (typeof manifest.basePath !== "string" ||
        (manifest.basePath !== "" &&
          (manifest.basePath === "/" ||
            manifest.basePath.endsWith("/") ||
            !isSafeWarmPathname(manifest.basePath))))
    ) {
      return null;
    }
    if (
      manifest.deploymentId !== undefined &&
      (typeof manifest.deploymentId !== "string" || !/^[a-zA-Z0-9_-]+$/.test(manifest.deploymentId))
    ) {
      return null;
    }
    if (manifest.trailingSlash !== undefined && typeof manifest.trailingSlash !== "boolean") {
      return null;
    }
    if (
      !Array.isArray(manifest.paths) ||
      !manifest.paths.every((path) => typeof path === "string")
    ) {
      return null;
    }
    if (
      manifest.appPaths !== undefined &&
      (!Array.isArray(manifest.appPaths) ||
        !manifest.appPaths.every((path) => typeof path === "string"))
    ) {
      return null;
    }
    if (
      manifest.rscCacheKeyMode !== undefined &&
      manifest.rscCacheKeyMode !== "header-digest" &&
      manifest.rscCacheKeyMode !== "response-vary"
    ) {
      return null;
    }
    return manifest;
  } catch (error) {
    console.warn(`[vinext] Failed to read prerender path manifest at ${manifestPath}:`, error);
    return null;
  }
}

function readPrerenderPathWarmPlan(
  root: string,
  options?: { strict?: boolean },
): PrerenderPathWarmPlan | null {
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
    return {
      paths: [],
      rscPaths: [],
      appPaths: [],
      rscCacheKeyMode: "header-digest",
      pathConfig: {},
    };
  }

  const pathConfig = {
    basePath: manifest.basePath,
    trailingSlash: manifest.trailingSlash,
  };
  const paths = manifest.paths
    .filter(isSafeWarmPathname)
    .map((pathname) => applyWarmPathConfig(pathname, pathConfig));
  const pathSet = new Set(paths);
  const appPaths = (manifest.appPaths ?? [])
    .filter(isSafeWarmPathname)
    .map((pathname) => applyWarmPathConfig(pathname, pathConfig));
  const rscPaths = appPaths.filter((pathname) => pathSet.has(pathname));
  return {
    ...(manifest.deploymentId ? { deploymentId: manifest.deploymentId } : {}),
    paths,
    rscPaths,
    appPaths,
    rscCacheKeyMode: manifest.rscCacheKeyMode ?? "header-digest",
    pathConfig,
  };
}

export function readPrerenderWarmPlan(
  root: string,
  options?: { includeFallbackShells?: boolean; strict?: boolean },
): PrerenderWarmPlan {
  const shouldPreferPrerenderManifest = options?.includeFallbackShells === true;
  const pathManifestPlan = readPrerenderPathWarmPlan(root, options);

  const manifest = readPrerenderManifest(
    path.join(root, "dist", "server", "vinext-prerender.json"),
  );
  if (!manifest) {
    if (shouldPreferPrerenderManifest) {
      if (pathManifestPlan !== null) {
        console.warn(
          "[vinext] CDN warmup fallback shells requested, but prerender manifest not found; warming build-discovered paths only.",
        );
        return { ...toPublicWarmPlan(pathManifestPlan), rscPaths: [] };
      }
    }
    if (pathManifestPlan !== null) {
      return { ...toPublicWarmPlan(pathManifestPlan), rscPaths: [] };
    }
    const message = "[vinext] CDN warmup skipped: prerender manifest not found.";
    if (options?.strict) throw new Error(message);
    return { paths: [], rscPaths: [], rscCacheKeyMode: "header-digest" };
  }

  const builtBuildId = readBuiltBuildId(root);
  if (!manifest.buildId || !builtBuildId || manifest.buildId !== builtBuildId) {
    const message =
      "[vinext] CDN warmup skipped: prerender manifest buildId does not match dist/server/BUILD_ID.";
    if (options?.strict) throw new Error(message);
    console.warn(message);
    return { paths: [], rscPaths: [], rscCacheKeyMode: "header-digest" };
  }

  const pathConfig = {
    basePath: pathManifestPlan?.pathConfig.basePath,
    trailingSlash: pathManifestPlan?.pathConfig.trailingSlash ?? manifest.trailingSlash,
  };
  const fullManifestDeploymentId =
    typeof manifest.deploymentId === "string" && /^[a-zA-Z0-9_-]+$/.test(manifest.deploymentId)
      ? manifest.deploymentId
      : undefined;
  const manifestPaths = getPrewarmableConcretePaths(manifest, options)
    .filter(isSafeWarmPathname)
    .map((pathname) => applyWarmPathConfig(pathname, pathConfig));
  const finalPathSet = new Set(manifestPaths);
  const representedPathSet = new Set(
    (manifest.routes ?? [])
      .map((route) => route.path ?? route.route)
      .filter(isSafeWarmPathname)
      .map((pathname) => applyWarmPathConfig(pathname, pathConfig)),
  );
  const discoveredAppPathSet = new Set(pathManifestPlan?.appPaths ?? []);
  const paths =
    !shouldPreferPrerenderManifest && pathManifestPlan !== null
      ? pathManifestPlan.paths.filter(
          (pathname) =>
            finalPathSet.has(pathname) ||
            (!representedPathSet.has(pathname) && !discoveredAppPathSet.has(pathname)),
        )
      : [];
  const selectedPathSet = new Set(paths);
  for (const pathname of manifestPaths) {
    if (!selectedPathSet.has(pathname)) {
      selectedPathSet.add(pathname);
      paths.push(pathname);
    }
  }
  const rscCacheKeyMode = pathManifestPlan?.rscCacheKeyMode ?? "header-digest";
  const rscPaths =
    rscCacheKeyMode === "response-vary"
      ? getPrewarmableAppPaths(manifest).filter(isSafeWarmPathname)
      : [];
  const configuredRscPaths = rscPaths.map((pathname) => applyWarmPathConfig(pathname, pathConfig));
  const htmlPathSet = new Set(paths);
  for (const pathname of configuredRscPaths) {
    if (!htmlPathSet.has(pathname)) {
      htmlPathSet.add(pathname);
      paths.push(pathname);
    }
  }
  const deploymentId =
    pathManifestPlan !== null ? pathManifestPlan.deploymentId : fullManifestDeploymentId;
  return {
    ...(deploymentId ? { deploymentId } : {}),
    paths,
    rscPaths: configuredRscPaths,
    rscCacheKeyMode,
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
  return getPrewarmableConcretePaths(manifest, options);
}

export function buildWarmupUrl(targetUrl: string, pathname: string): URL {
  if (!isSafeWarmPathAndSearch(pathname)) {
    throw new Error(`Unsafe CDN warmup pathname: ${JSON.stringify(pathname)}`);
  }
  const target = new URL(targetUrl);
  const resolved = new URL(pathname, target);
  if (resolved.origin !== target.origin) {
    throw new Error(`CDN warmup pathname escaped target origin: ${JSON.stringify(pathname)}`);
  }
  return resolved;
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

const ADMITTED_CF_CACHE_STATUSES = new Set([
  "HIT",
  "MISS",
  "EXPIRED",
  "REVALIDATED",
  "UPDATING",
  "STALE",
]);
const CANONICAL_RSC_VARY_FIELDS = new Set(
  [
    "accept",
    "cookie",
    "authorization",
    "host",
    CLOUDFLARE_FORWARDED_PROTO_HEADER,
    ...VINEXT_RSC_VARY_HEADER.split(","),
  ].map((field) => field.trim().toLowerCase()),
);
const REQUIRED_CANONICAL_RSC_VARY_FIELDS = new Set(
  [
    ...VINEXT_RSC_NON_CONTEXTUAL_VARY_HEADER.split(","),
    "Cookie",
    "Authorization",
    "Host",
    CLOUDFLARE_FORWARDED_PROTO_HEADER,
  ].map((field) => field.trim().toLowerCase()),
);
const REQUIRED_HTML_VARY_FIELDS = new Set(
  ["Cookie", "Authorization", "Host", CLOUDFLARE_FORWARDED_PROTO_HEADER].map((field) =>
    field.toLowerCase(),
  ),
);

function findUnsupportedWarmVaryField(response: Response, kind: "html" | "rsc"): string | null {
  const vary = response.headers.get("Vary");
  if (!vary) return null;
  for (const token of vary.split(",")) {
    const field = token.trim().toLowerCase();
    if (!field) continue;
    if (
      field === "*" ||
      (kind === "html" && field === "accept") ||
      !CANONICAL_RSC_VARY_FIELDS.has(field)
    ) {
      return token.trim() || "*";
    }
  }
  return null;
}

function findMissingWarmVaryField(response: Response, kind: "html" | "rsc"): string | null {
  const present = new Set(
    (response.headers.get("Vary") ?? "")
      .split(",")
      .map((field) => field.trim().toLowerCase())
      .filter(Boolean),
  );
  const required = kind === "rsc" ? REQUIRED_CANONICAL_RSC_VARY_FIELDS : REQUIRED_HTML_VARY_FIELDS;
  for (const field of required) {
    if (!present.has(field)) return field;
  }
  return null;
}

async function drainResponseBody(response: Response, signal: AbortSignal): Promise<void> {
  if (!response.body) {
    signal.throwIfAborted();
    return;
  }

  if (signal.aborted) {
    // A custom fetch implementation may resolve after ignoring the aborted
    // signal. Cancel its late body without acquiring a reader, then preserve
    // the timeout reason for the caller.
    void response.body.cancel(signal.reason).catch(() => {});
    signal.throwIfAborted();
  }

  const reader = response.body.getReader();
  let rejectOnAbort: ((reason?: unknown) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectOnAbort = reject;
  });
  const abort = () => {
    const reason = signal.reason ?? new DOMException("The operation was aborted", "AbortError");
    // Do not leave a stalled response producing data after its warmup deadline.
    // Reject immediately even if a custom stream's cancellation hook is slow.
    void reader.cancel(reason).catch(() => {});
    rejectOnAbort?.(reason);
  };
  signal.addEventListener("abort", abort, { once: true });

  const drain = (async () => {
    try {
      while (true) {
        const { done } = await reader.read();
        if (done) return;
      }
    } finally {
      // This runs only after the pending read settles. Keeping release here
      // avoids masking the timeout while still unlocking cancellable streams.
      reader.releaseLock();
    }
  })();

  try {
    signal.throwIfAborted();
    await Promise.race([drain, aborted]);
    signal.throwIfAborted();
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

async function fetchAndDrainWithTimeout(
  fetchImpl: typeof fetch,
  url: URL,
  timeoutMs: number,
  headers: HeadersInit | undefined,
  redirect: RequestRedirect,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const requestHeaders = new Headers(headers);
  if (!requestHeaders.has("User-Agent")) {
    requestHeaders.set("User-Agent", "vinext-cloudflare-cdn-warm");
  }
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      redirect,
      headers: requestHeaders,
      signal: controller.signal,
    });
    await drainResponseBody(response, controller.signal);
    return response;
  } finally {
    clearTimeout(timer);
  }
}

async function waitForRetry(delayMs: number): Promise<void> {
  if (delayMs <= 0) return;
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}

/** Verify that a staged-version override has propagated before warming it. */
export async function probeWorkerVersion(
  options: WorkerVersionProbeOptions,
): Promise<WorkerVersionProbeResult> {
  const url = buildWarmupUrl(options.targetUrl, options.pathname);
  url.searchParams.set(VINEXT_VERSION_PROBE_QUERY, options.versionId);
  const headers = new Headers(options.headers);
  headers.set(VINEXT_VERSION_PROBE_HEADER, "1");
  headers.set("Cache-Control", "no-cache");
  headers.set("User-Agent", "vinext-cloudflare-version-probe");
  const timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_CDN_WARM_TIMEOUT_MS);
  const retries = Math.max(0, options.retries ?? DEFAULT_VERSION_PROBE_RETRIES);
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? DEFAULT_VERSION_PROBE_RETRY_DELAY_MS);
  const fetchImpl = options.fetchImpl ?? fetch;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      // Probes may briefly reach the previously deployed Worker while the
      // version override propagates. Keep them non-mutating so an older
      // Worker cannot route the probe into user POST behavior. Bound both the
      // fetch and body discard so an old response cannot hang or be buffered.
      const response = await fetchAndDrainWithTimeout(fetchImpl, url, timeoutMs, headers, "manual");
      const observedVersion = response.headers.get(VINEXT_WORKER_VERSION_HEADER);
      if (response.status === 204 && observedVersion === options.versionId) {
        return { verified: true };
      }
      if (observedVersion === "unavailable") {
        return { verified: false, reason: "binding-unavailable" };
      }
    } catch {
      // A failed override may reach the old version or a not-yet-propagated
      // route. Retry the exact non-mutating probe within the bounded window.
    }
    if (attempt < retries) await waitForRetry(retryDelayMs);
  }

  return { verified: false, reason: "not-ready" };
}

async function warmOnePath(
  target: { headers?: HeadersInit; kind: "html" | "rsc"; label: string; pathname: string },
  options: Required<Pick<CdnWarmOptions, "targetUrl" | "timeoutMs" | "retries">> & {
    fetchImpl: typeof fetch;
    headers?: HeadersInit;
  },
): Promise<{ path: string; ok: true } | { path: string; ok: false; error: string }> {
  const url = buildWarmupUrl(options.targetUrl, target.pathname);
  let lastError = "unknown error";

  for (let attempt = 0; attempt <= options.retries; attempt++) {
    try {
      const response = await fetchAndDrainWithTimeout(
        options.fetchImpl,
        url,
        options.timeoutMs,
        target.headers ?? options.headers,
        "manual",
      );

      if (response.redirected || response.status < 200 || response.status >= 300) {
        lastError = response.redirected ? "redirected response" : `HTTP ${response.status}`;
        if (!isRetryableStatus(response.status)) break;
        continue;
      }

      if (response.status < 400) {
        if (
          target.kind === "rsc" &&
          !response.headers.get("Content-Type")?.toLowerCase().startsWith(VINEXT_RSC_CONTENT_TYPE)
        ) {
          lastError = `expected ${VINEXT_RSC_CONTENT_TYPE} response`;
          break;
        }
        const unsupportedVaryField = findUnsupportedWarmVaryField(response, target.kind);
        if (unsupportedVaryField !== null) {
          lastError = `unsupported Vary field: ${unsupportedVaryField}`;
          break;
        }
        const missingVaryField = findMissingWarmVaryField(response, target.kind);
        if (missingVaryField !== null) {
          lastError = `missing required Vary field: ${missingVaryField}`;
          break;
        }
        const cacheStatus = response.headers.get("CF-Cache-Status")?.trim().toUpperCase() ?? "";
        if (!ADMITTED_CF_CACHE_STATUSES.has(cacheStatus)) {
          lastError = cacheStatus ? `CF-Cache-Status: ${cacheStatus}` : "missing CF-Cache-Status";
          break;
        }
        return { path: target.label, ok: true };
      }

      lastError = `HTTP ${response.status}`;
      if (!isRetryableStatus(response.status)) break;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        lastError = `timed out after ${options.timeoutMs}ms`;
      } else {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
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
  const requests: Array<{
    headers?: HeadersInit;
    kind: "html" | "rsc";
    label: string;
    pathname: string;
  }> = options.paths.map((pathname) => ({ kind: "html", label: pathname, pathname }));
  const commonHeaders = new Headers(options.headers);
  for (const pathname of options.rscPaths ?? []) {
    const rscHeaders = new Headers(commonHeaders);
    for (const [name, value] of createRscRequestHeaders({ deploymentId: options.deploymentId })) {
      rscHeaders.set(name, value);
    }
    requests.push({
      headers: rscHeaders,
      kind: "rsc",
      label: `${pathname} (RSC)`,
      pathname: await createRscRequestUrl(
        pathname,
        rscHeaders,
        options.rscCacheKeyMode ?? "header-digest",
      ),
    });
  }
  const concurrency = Math.max(1, options.concurrency ?? 10);
  const timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_CDN_WARM_TIMEOUT_MS);
  const retries = Math.max(0, options.retries ?? 1);
  const fetchImpl = options.fetchImpl ?? fetch;

  if (requests.length === 0) {
    return { total: 0, warmed: 0, failed: 0, failures: [] };
  }

  console.log(`\n  Warming CDN cache with ${requests.length} build-discovered request(s)...`);

  const results = await runWithConcurrency(requests, concurrency, (target) =>
    warmOnePath(target, {
      targetUrl: options.targetUrl,
      timeoutMs,
      retries,
      fetchImpl,
      headers: options.headers,
    }),
  );

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
