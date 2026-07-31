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
import type { RscCacheKeyMode } from "vinext/internal/cache-adapters";
import {
  createRscRequestHeaders,
  createRscRequestUrl,
  VINEXT_RSC_CONTENT_TYPE,
} from "vinext/internal/server/app-rsc-cache-busting";
import { normalizePathTrailingSlash } from "vinext/shims/url-utils";

export type CdnWarmOptions = {
  targetUrl: string;
  paths: readonly string[];
  /** App Router paths whose ordinary client-navigation RSC variant should also be warmed. */
  rscPaths?: readonly string[];
  /** RSC URL mode compiled into the deployed browser/server bundles. */
  rscCacheKeyMode?: RscCacheKeyMode;
  headers?: HeadersInit;
  concurrency?: number;
  timeoutMs?: number;
  retries?: number;
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
  paths: string[];
  rscPaths: string[];
  rscCacheKeyMode: RscCacheKeyMode;
};

type PrerenderPathWarmPlan = PrerenderWarmPlan & {
  pathConfig: Pick<PrerenderPathManifest, "basePath" | "trailingSlash">;
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
  return normalizePathTrailingSlash(withBasePath, config.trailingSlash === true);
}

function toPublicWarmPlan(plan: PrerenderPathWarmPlan): PrerenderWarmPlan {
  return {
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
    if (manifest.basePath !== undefined && typeof manifest.basePath !== "string") return null;
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
      rscCacheKeyMode: "header-digest",
      pathConfig: {},
    };
  }

  const pathConfig = {
    basePath: manifest.basePath,
    trailingSlash: manifest.trailingSlash,
  };
  const paths = manifest.paths
    .filter((pathname) => pathname.startsWith("/"))
    .map((pathname) => applyWarmPathConfig(pathname, pathConfig));
  const pathSet = new Set(paths);
  const rscPaths = (manifest.appPaths ?? [])
    .filter((pathname) => pathname.startsWith("/"))
    .map((pathname) => applyWarmPathConfig(pathname, pathConfig))
    .filter((pathname) => pathSet.has(pathname));
  return {
    paths,
    rscPaths,
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
  if (!shouldPreferPrerenderManifest) {
    if (pathManifestPlan !== null) return toPublicWarmPlan(pathManifestPlan);
  }

  const manifest = readPrerenderManifest(
    path.join(root, "dist", "server", "vinext-prerender.json"),
  );
  if (!manifest) {
    if (shouldPreferPrerenderManifest) {
      if (pathManifestPlan !== null) {
        console.warn(
          "[vinext] CDN warmup fallback shells requested, but prerender manifest not found; warming build-discovered paths only.",
        );
        return toPublicWarmPlan(pathManifestPlan);
      }
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

  const pathConfig = pathManifestPlan?.pathConfig ?? {};
  return {
    paths: getPrerenderedConcretePaths(manifest, options).map((pathname) =>
      applyWarmPathConfig(pathname, pathConfig),
    ),
    rscPaths: getPrerenderedConcretePaths(manifest, { ...options, router: "app" }).map((pathname) =>
      applyWarmPathConfig(pathname, pathConfig),
    ),
    rscCacheKeyMode: pathManifestPlan?.rscCacheKeyMode ?? "header-digest",
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

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: URL,
  timeoutMs: number,
  headers: HeadersInit | undefined,
  redirect: RequestRedirect,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const requestHeaders = new Headers(headers);
  requestHeaders.set("User-Agent", "vinext-cloudflare-cdn-warm");
  try {
    return await fetchImpl(url, {
      method: "GET",
      redirect,
      headers: requestHeaders,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
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
      const response = await fetchWithTimeout(
        options.fetchImpl,
        url,
        options.timeoutMs,
        target.headers ?? options.headers,
        target.kind === "rsc" ? "manual" : "follow",
      );
      await response.arrayBuffer();

      if (
        target.kind === "rsc" &&
        (response.redirected || response.status < 200 || response.status >= 300)
      ) {
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
    for (const [name, value] of createRscRequestHeaders()) rscHeaders.set(name, value);
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
