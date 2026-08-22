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
import { VINEXT_WORKER_VERSION_HEADER } from "vinext/internal/server/worker-version";
import { normalizeTrailingSlashPathname } from "vinext/server/request-pipeline";

export type CdnWarmOptions = {
  targetUrl: string;
  paths: readonly string[];
  headers?: HeadersInit;
  concurrency?: number;
  timeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
  strict?: boolean;
  expectedVersionId?: string;
  /**
   * Require cf-cache-status proof that Workers Cache stored the response, not
   * just that the expected Worker produced it. A MISS fill is confirmed with a
   * second identical request that must come back cache-served.
   */
  confirmCache?: boolean;
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
    if (!Array.isArray(manifest.paths)) return null;
    return manifest;
  } catch (error) {
    console.warn(`[vinext] Failed to read prerender path manifest at ${manifestPath}:`, error);
    return null;
  }
}

/**
 * Manifests record bare route paths and carry `trailingSlash` separately, but
 * warmup fetches with `redirect: "manual"` so it can verify each cache key
 * exactly. Requesting `/about` under `trailingSlash: true` would evaluate (and
 * possibly cache) the 308 at the pre-redirect key while the canonical HTML
 * entry stays cold — apply the request pipeline's own normalization so warmup
 * requests the URL the server serves without a redirect.
 */
function canonicalizeWarmPathTrailingSlashes(
  paths: readonly string[],
  trailingSlash: boolean | undefined,
): string[] {
  if (trailingSlash === undefined) return [...paths];
  const seen = new Set<string>();
  const canonical: string[] = [];
  for (const pathname of paths) {
    const normalized = normalizeTrailingSlashPathname(pathname, trailingSlash) ?? pathname;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    canonical.push(normalized);
  }
  return canonical;
}

function readPrerenderPathWarmPaths(root: string, options?: { strict?: boolean }): string[] | null {
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
    return [];
  }

  return canonicalizeWarmPathTrailingSlashes(
    manifest.paths.filter((pathname) => pathname.startsWith("/")),
    manifest.trailingSlash,
  );
}

export function readPrerenderWarmPaths(
  root: string,
  options?: { includeFallbackShells?: boolean; strict?: boolean },
): string[] {
  const shouldPreferPrerenderManifest = options?.includeFallbackShells === true;
  if (!shouldPreferPrerenderManifest) {
    const pathManifestPaths = readPrerenderPathWarmPaths(root, options);
    if (pathManifestPaths !== null) return pathManifestPaths;
  }

  const manifest = readPrerenderManifest(
    path.join(root, "dist", "server", "vinext-prerender.json"),
  );
  if (!manifest) {
    if (shouldPreferPrerenderManifest) {
      const pathManifestPaths = readPrerenderPathWarmPaths(root, options);
      if (pathManifestPaths !== null) {
        console.warn(
          "[vinext] CDN warmup fallback shells requested, but prerender manifest not found; warming build-discovered paths only.",
        );
        return pathManifestPaths;
      }
    }
    const message = "[vinext] CDN warmup skipped: prerender manifest not found.";
    if (options?.strict) throw new Error(message);
    return [];
  }

  const builtBuildId = readBuiltBuildId(root);
  if (!manifest.buildId || !builtBuildId || manifest.buildId !== builtBuildId) {
    const message =
      "[vinext] CDN warmup skipped: prerender manifest buildId does not match dist/server/BUILD_ID.";
    if (options?.strict) throw new Error(message);
    console.warn(message);
    return [];
  }

  return canonicalizeWarmPathTrailingSlashes(
    getPrerenderedConcretePaths(manifest, options),
    manifest.trailingSlash,
  );
}

export function getWarmPathsFromPrerenderManifest(
  manifest: PrerenderManifest,
  options?: PrerenderedPathSelectionOptions,
): string[] {
  return canonicalizeWarmPathTrailingSlashes(
    getPrerenderedConcretePaths(manifest, options),
    manifest.trailingSlash,
  );
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

async function waitBeforeRetry(
  attempt: number,
  retries: number,
  retryDelayMs: number,
): Promise<void> {
  if (attempt >= retries || retryDelayMs === 0) return;
  await new Promise((resolve) => setTimeout(resolve, retryDelayMs * 2 ** attempt));
}

const CF_CACHE_STATUS_HEADER = "cf-cache-status";
/** Statuses proving the edge served the response from the cache partition. */
const CACHE_SERVED_STATUSES = new Set(["HIT", "STALE", "UPDATING", "REVALIDATED"]);
/** Statuses where the Worker ran and the response may have been written to cache. */
const CACHE_FILL_STATUSES = new Set(["MISS", "EXPIRED"]);

function getCacheStatus(response: Response): string | null {
  return response.headers.get(CF_CACHE_STATUS_HEADER)?.toUpperCase() ?? null;
}

/**
 * Null when the response proves the cache served it from the expected Worker
 * version's partition; otherwise the reason it does not.
 */
function describeUnconfirmedCacheServe(
  response: Response,
  expectedVersionId: string | undefined,
): string | null {
  if (expectedVersionId) {
    const actualVersionId = response.headers.get(VINEXT_WORKER_VERSION_HEADER);
    if (actualVersionId !== expectedVersionId) {
      return describeVersionMismatch(expectedVersionId, actualVersionId);
    }
  }
  if (response.status >= 400) return `HTTP ${response.status}`;
  const cacheStatus = getCacheStatus(response);
  if (cacheStatus && CACHE_SERVED_STATUSES.has(cacheStatus)) return null;
  return `cache entry not confirmed (${CF_CACHE_STATUS_HEADER}: ${cacheStatus ?? "missing"})`;
}

/** Error text for a response that didn't prove it came from the expected Worker version. */
function describeVersionMismatch(
  expectedVersionId: string,
  actualVersionId: string | null,
): string {
  return actualVersionId
    ? `expected Worker version ${expectedVersionId}, received ${actualVersionId}`
    : `expected Worker version ${expectedVersionId}, but the response did not include ` +
        `${VINEXT_WORKER_VERSION_HEADER} — a custom Worker entry must forward its bindings ` +
        "as `handler.fetch(request, env, ctx)` for the version to be stamped";
}

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: URL,
  timeoutMs: number,
  headers: HeadersInit | undefined,
  redirect: RequestRedirect = "follow",
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
  pathname: string,
  options: Required<
    Pick<CdnWarmOptions, "targetUrl" | "timeoutMs" | "retries" | "retryDelayMs">
  > & {
    fetchImpl: typeof fetch;
    headers?: HeadersInit;
    expectedVersionId?: string;
    confirmCache?: boolean;
  },
): Promise<{ path: string; ok: true } | { path: string; ok: false; error: string }> {
  const url = buildWarmupUrl(options.targetUrl, pathname);
  let lastError = "unknown error";

  for (let attempt = 0; attempt <= options.retries; attempt++) {
    try {
      const response = await fetchWithTimeout(
        options.fetchImpl,
        url,
        options.timeoutMs,
        options.headers,
        "manual",
      );
      await response.arrayBuffer();

      // A staged version can take a few seconds to become globally routable, so
      // before the override propagates, the old Worker answers with its own
      // status codes (including 404s for newly added routes). Check which
      // Worker actually produced the response before trusting its status —
      // otherwise a pre-propagation old-Worker 404 looks like a terminal
      // failure instead of "not warmed yet".
      if (options.expectedVersionId) {
        const actualVersionId = response.headers.get(VINEXT_WORKER_VERSION_HEADER);
        if (actualVersionId !== options.expectedVersionId) {
          lastError = describeVersionMismatch(options.expectedVersionId, actualVersionId);
          await waitBeforeRetry(attempt, options.retries, options.retryDelayMs);
          continue;
        }
      }

      if (response.status < 400) {
        if (!options.confirmCache) return { path: pathname, ok: true };

        // "The expected version produced a 200" and "the edge stored that
        // response in the version's cache partition" are different facts.
        // Per-entrypoint cache overrides and response-level bypasses
        // (Set-Cookie, Cache-Control: no-store/private) return a healthy 200
        // that Workers Cache never stores — only cf-cache-status can tell
        // those apart from a real warm.
        const cacheStatus = getCacheStatus(response);
        if (cacheStatus && CACHE_SERVED_STATUSES.has(cacheStatus)) {
          return { path: pathname, ok: true };
        }
        if (!cacheStatus || !CACHE_FILL_STATUSES.has(cacheStatus)) {
          // BYPASS/DYNAMIC or a missing header is deterministic for this
          // response shape: the cache will never store it, so retrying only
          // burns the retry budget on the same answer.
          lastError = `response was not stored by Workers Cache (${CF_CACHE_STATUS_HEADER}: ${cacheStatus ?? "missing"})`;
          break;
        }

        // MISS/EXPIRED started a fill. Only a second identical request coming
        // back cache-served proves the fill became a reusable entry.
        const confirm = await fetchWithTimeout(
          options.fetchImpl,
          url,
          options.timeoutMs,
          options.headers,
          "manual",
        );
        await confirm.arrayBuffer();
        const confirmError = describeUnconfirmedCacheServe(confirm, options.expectedVersionId);
        if (!confirmError) return { path: pathname, ok: true };
        lastError = confirmError;
        await waitBeforeRetry(attempt, options.retries, options.retryDelayMs);
        continue;
      }

      // These paths came from this build's prerender manifest, so even a 4xx
      // from the expected Worker version means the intended cache entry was
      // not populated and must remain a warmup failure.
      lastError = `HTTP ${response.status}`;
      if (!isRetryableStatus(response.status)) break;
      await waitBeforeRetry(attempt, options.retries, options.retryDelayMs);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        lastError = `timed out after ${options.timeoutMs}ms`;
      } else {
        lastError = error instanceof Error ? error.message : String(error);
      }
      await waitBeforeRetry(attempt, options.retries, options.retryDelayMs);
    }
  }

  return { path: pathname, ok: false, error: lastError };
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
  const paths = options.paths;
  const concurrency = Math.max(1, options.concurrency ?? 10);
  const timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_CDN_WARM_TIMEOUT_MS);
  const retries = Math.max(0, options.retries ?? (options.expectedVersionId ? 3 : 1));
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? 500);
  const fetchImpl = options.fetchImpl ?? fetch;

  if (paths.length === 0) {
    return { total: 0, warmed: 0, failed: 0, failures: [] };
  }

  console.log(`\n  Warming CDN cache for ${paths.length} build-discovered path(s)...`);

  const results = await runWithConcurrency(paths, concurrency, (pathname) =>
    warmOnePath(pathname, {
      targetUrl: options.targetUrl,
      timeoutMs,
      retries,
      retryDelayMs,
      fetchImpl,
      headers: options.headers,
      expectedVersionId: options.expectedVersionId,
      confirmCache: options.confirmCache,
    }),
  );

  const failures = results
    .filter((result): result is { path: string; ok: false; error: string } => !result.ok)
    .map(({ path, error }) => ({ path, error }));
  const warmed = results.length - failures.length;

  console.log(`  CDN warmup: ${warmed}/${paths.length} path(s) warmed.`);
  if (failures.length > 0) {
    for (const failure of failures.slice(0, 5)) {
      console.warn(`  CDN warmup failed for ${failure.path}: ${failure.error}`);
    }
    if (failures.length > 5) {
      console.warn(`  CDN warmup: ${failures.length - 5} additional failure(s) omitted.`);
    }
  }

  const result = {
    total: paths.length,
    warmed,
    failed: failures.length,
    failures,
  };

  if (options.strict && failures.length > 0) {
    throw new Error(
      `CDN warmup failed for ${failures.length}/${paths.length} path(s); ` +
        `verified ${warmed}/${paths.length}. ` +
        `First failure: ${failures[0].path}: ${failures[0].error}`,
    );
  }

  return result;
}

export async function warmCdnCacheFromPrerender(
  options: PrerenderCdnWarmOptions,
): Promise<CdnWarmResult> {
  const paths = readPrerenderWarmPaths(options.root, {
    includeFallbackShells: options.includeFallbackShells,
    strict: options.strict,
  });
  return warmCdnCache({ ...options, paths });
}
