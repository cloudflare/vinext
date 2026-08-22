/**
 * TPR: Traffic-aware Pre-Rendering
 *
 * Uses Cloudflare zone analytics to determine which pages actually get
 * traffic, and pre-renders only those during deploy. The pre-rendered
 * HTML is uploaded to KV in the same format ISR uses at runtime — no
 * runtime changes needed.
 *
 * Flow:
 *   1. Parse wrangler config to find custom domain and KV namespace
 *   2. Resolve the Cloudflare zone for the custom domain
 *   3. Query zone analytics (GraphQL) for top pages by request count
 *   4. Walk ranked list until coverage threshold is met
 *   5. Start the built production server locally
 *   6. Fetch each hot route to produce HTML
 *   7. Upload pre-rendered HTML to KV (same KVCacheEntry format ISR reads)
 *
 * TPR is an experimental feature enabled via --experimental-tpr. It
 * gracefully skips when no custom domain, no API token, no traffic data,
 * or no KV namespace is configured.
 */

import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { VINEXT_REVALIDATE_HEADER } from "vinext/internal/server/headers";
import { isrCacheKey } from "vinext/internal/server/isr-cache";
import { buildAppPageCacheTags } from "vinext/internal/server/app-page-cache";
import { createKvKeySpace } from "./cache/kv-key.js";
import { parseWranglerConfig } from "./wrangler-config.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export type TPROptions = {
  /** Project root directory. */
  root: string;
  /** Wrangler config path, relative to root unless absolute. */
  config?: string;
  /** Traffic coverage percentage (0–100). Default: 90. */
  coverage: number;
  /** Hard cap on number of pages to pre-render. Default: 1000. */
  limit: number;
  /** Analytics lookback window in hours. Default: 24. */
  window: number;
};

export type TPRResult = {
  /** Total unique page paths found in analytics. */
  totalPaths: number;
  /** Number of pages successfully pre-rendered and uploaded. */
  prerenderedCount: number;
  /** Actual traffic coverage achieved (percentage). */
  coverageAchieved: number;
  /** Wall-clock duration of the TPR step in milliseconds. */
  durationMs: number;
  /** If TPR was skipped, the reason. */
  skipped?: string;
};

type TrafficEntry = {
  path: string;
  requests: number;
};

type SelectedRoutes = {
  routes: TrafficEntry[];
  totalRequests: number;
  coveredRequests: number;
  coveragePercent: number;
};

type PrerenderResult = {
  html: string;
  status: number;
  headers: Record<string, string>;
};

// ─── Cloudflare API ──────────────────────────────────────────────────────────

/**
 * Generate zone lookup candidates from shortest (2-part) to longest.
 * Tries the most common case first (e.g., "example.com") and progressively
 * adds labels for multi-part TLDs (e.g., "co.uk" → "example.co.uk").
 *
 * "shop.example.com"    → ["example.com", "shop.example.com"]
 * "shop.example.co.uk"  → ["co.uk", "example.co.uk", "shop.example.co.uk"]
 * "example.com"         → ["example.com"]
 */
export function domainCandidates(domain: string): string[] {
  const parts = domain.split(".");
  const candidates: string[] = [];
  for (let i = parts.length - 2; i >= 0; i--) {
    candidates.push(parts.slice(i).join("."));
  }
  return candidates;
}

/** Resolve zone ID from a domain name via the Cloudflare API. */
async function resolveZoneId(domain: string, apiToken: string): Promise<string | null> {
  // Try progressively longer domain candidates until one matches a zone.
  // This handles all public suffixes without a hardcoded TLD list —
  // for simple TLDs (.com, .io) the 2-part candidate hits on the first try;
  // for multi-part TLDs (.co.uk, .com.au) it takes one extra call.
  for (const candidate of domainCandidates(domain)) {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/zones?name=${encodeURIComponent(candidate)}`,
      {
        headers: {
          Authorization: `Bearer ${apiToken}`,
          "Content-Type": "application/json",
        },
      },
    );

    if (!response.ok) continue;

    const data = (await response.json()) as {
      success: boolean;
      result?: Array<{ id: string }>;
    };
    if (data.success && data.result?.length) {
      return data.result[0].id;
    }
  }

  return null;
}

/** Resolve the account ID associated with the API token. */
async function resolveAccountId(apiToken: string): Promise<string | null> {
  const response = await fetch("https://api.cloudflare.com/client/v4/accounts?per_page=1", {
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) return null;

  const data = (await response.json()) as {
    success: boolean;
    result?: Array<{ id: string }>;
  };
  if (!data.success || !data.result?.length) return null;

  return data.result[0].id;
}

// ─── Traffic Querying ────────────────────────────────────────────────────────

/**
 * Query Cloudflare zone analytics for top page paths by request count
 * over the given time window.
 */
async function queryTraffic(
  zoneTag: string,
  apiToken: string,
  windowHours: number,
): Promise<TrafficEntry[]> {
  const now = new Date();
  const start = new Date(now.getTime() - windowHours * 60 * 60 * 1000);

  const query = `{
    viewer {
      zones(filter: { zoneTag: "${zoneTag}" }) {
        httpRequestsAdaptiveGroups(
          limit: 10000
          orderBy: [sum_requests_DESC]
          filter: {
            datetime_geq: "${start.toISOString()}"
            datetime_lt: "${now.toISOString()}"
            requestSource: "eyeball"
          }
        ) {
          sum { requests }
          dimensions { clientRequestPath }
        }
      }
    }
  }`;

  const response = await fetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query }),
  });

  if (!response.ok) {
    throw new Error(`Zone analytics query failed: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as {
    errors?: Array<{ message: string }>;
    data?: {
      viewer?: {
        zones?: Array<{
          httpRequestsAdaptiveGroups?: Array<{
            sum: { requests: number };
            dimensions: { clientRequestPath: string };
          }>;
        }>;
      };
    };
  };

  if (data.errors?.length) {
    throw new Error(`Zone analytics error: ${data.errors[0].message}`);
  }

  const groups = data.data?.viewer?.zones?.[0]?.httpRequestsAdaptiveGroups;
  if (!groups || groups.length === 0) return [];

  return filterTrafficPaths(
    groups.map((g) => ({
      path: g.dimensions.clientRequestPath,
      requests: g.sum.requests,
    })),
  );
}

/** Filter out non-page requests (static assets, API routes, internal routes). */
function filterTrafficPaths(entries: TrafficEntry[]): TrafficEntry[] {
  return entries.filter((e) => {
    if (!e.path.startsWith("/")) return false;
    // Static assets
    if (/\.(js|css|png|jpg|jpeg|gif|svg|ico|woff2?|ttf|eot|map|webp|avif)$/i.test(e.path))
      return false;
    // API routes
    if (e.path.startsWith("/api/")) return false;
    // Internal routes
    if (e.path.startsWith("/_next/") || e.path.startsWith("/__vinext/")) return false;
    // RSC requests
    if (e.path.endsWith(".rsc")) return false;
    return true;
  });
}

// ─── Route Selection ─────────────────────────────────────────────────────────

/**
 * Walk the ranked traffic list, accumulating request counts until the
 * coverage target is met or the hard cap is reached.
 */
function selectRoutes(
  traffic: TrafficEntry[],
  coverageTarget: number,
  limit: number,
): SelectedRoutes {
  const totalRequests = traffic.reduce((sum, e) => sum + e.requests, 0);
  if (totalRequests === 0) {
    return { routes: [], totalRequests: 0, coveredRequests: 0, coveragePercent: 0 };
  }

  const target = totalRequests * (coverageTarget / 100);
  const selected: TrafficEntry[] = [];
  let accumulated = 0;

  // Traffic is already sorted DESC by requests from the GraphQL query
  for (const entry of traffic) {
    if (accumulated >= target || selected.length >= limit) break;
    selected.push(entry);
    accumulated += entry.requests;
  }

  return {
    routes: selected,
    totalRequests,
    coveredRequests: accumulated,
    coveragePercent: (accumulated / totalRequests) * 100,
  };
}

// ─── Pre-rendering ───────────────────────────────────────────────────────────

/** Pre-render port — high number to avoid collisions with dev servers. */
const PRERENDER_PORT = 19384;

/** Max time to wait for the local server to start (ms). */
const SERVER_STARTUP_TIMEOUT = 30_000;

/** Max concurrent fetch requests during pre-rendering. */
const FETCH_CONCURRENCY = 10;

const NON_CACHEABLE_CACHE_CONTROL_RE = /\b(?:no-store|no-cache|private)\b/i;

function getTprHeader(headers: Record<string, string>, name: string): string | undefined {
  const normalizedName = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === normalizedName) return value;
  }
  return undefined;
}

function hasNonCacheableCacheControl(headers: Record<string, string>): boolean {
  const cacheControl = getTprHeader(headers, "cache-control");
  return cacheControl ? NON_CACHEABLE_CACHE_CONTROL_RE.test(cacheControl) : false;
}

function readTprRevalidateHeader(headers: Record<string, string>): number | undefined {
  const revalidateHeader = getTprHeader(headers, VINEXT_REVALIDATE_HEADER);
  if (revalidateHeader === undefined) return undefined;

  return Number(revalidateHeader);
}

function isTprCacheable(headers: Record<string, string>): boolean {
  if (hasNonCacheableCacheControl(headers)) return false;

  const revalidate = readTprRevalidateHeader(headers);
  return revalidate === undefined || (Number.isFinite(revalidate) && revalidate > 0);
}

/**
 * Start a local production server, fetch each route to produce HTML,
 * and return the results. Pages that fail to render are skipped.
 */
async function prerenderRoutes(
  routes: string[],
  root: string,
  hostDomain?: string,
): Promise<Map<string, PrerenderResult>> {
  const results = new Map<string, PrerenderResult>();
  let failedCount = 0;
  const port = PRERENDER_PORT;

  // Verify dist/ exists
  const distDir = path.join(root, "dist");
  if (!fs.existsSync(distDir)) {
    console.log("  TPR: Skipping pre-render — dist/ directory not found");
    return results;
  }

  // Start the local production server as a subprocess
  const serverProcess = startLocalServer(root, port);

  try {
    await waitForServer(port, SERVER_STARTUP_TIMEOUT);

    // Fetch routes in batches to limit concurrency
    for (let i = 0; i < routes.length; i += FETCH_CONCURRENCY) {
      const batch = routes.slice(i, i + FETCH_CONCURRENCY);
      const promises = batch.map(async (routePath) => {
        try {
          const response = await fetch(`http://127.0.0.1:${port}${routePath}`, {
            headers: {
              "User-Agent": "vinext-tpr/1.0",
              ...(hostDomain ? { Host: hostDomain } : {}),
            },
            redirect: "manual", // Don't follow redirects — cache the redirect itself
          });

          // Only cache successful, cacheable responses (2xx and 3xx)
          if (response.status < 400) {
            const headers: Record<string, string> = {};
            response.headers.forEach((value, key) => {
              // Only keep relevant headers
              if (
                key === "content-type" ||
                key === "cache-control" ||
                key === VINEXT_REVALIDATE_HEADER ||
                key === "location"
              ) {
                headers[key] = value;
              }
            });

            if (!isTprCacheable(headers)) return;

            const html = await response.text();
            results.set(routePath, {
              html,
              status: response.status,
              headers,
            });
          }
        } catch {
          // Skip pages that fail to render — they may depend on
          // request-specific data (cookies, headers, auth) that
          // isn't available during pre-rendering.
          failedCount++;
        }
      });

      await Promise.all(promises);
    }

    if (failedCount > 0) {
      console.log(`  TPR: ${failedCount} page(s) failed to pre-render (skipped)`);
    }
  } finally {
    serverProcess.kill("SIGTERM");
    // Give it a moment to clean up
    await new Promise<void>((resolve) => {
      serverProcess.on("exit", resolve);
      setTimeout(resolve, 2000);
    });
  }

  return results;
}

/**
 * Spawn a subprocess running the vinext production server.
 * Uses the same Node.js binary and resolves vinext from the project root so
 * linked/package-manager-managed installs use the app's vinext peer.
 */
function startLocalServer(root: string, port: number): ChildProcess {
  const prodServerPath = resolveVinextProdServerPath(root);
  const outDir = path.join(root, "dist");

  const script = [
    `import(${JSON.stringify(pathToFileURL(prodServerPath).href)})`,
    `.then(m => m.startProdServer({ port: ${port}, host: "127.0.0.1", outDir: ${JSON.stringify(outDir)} }))`,
    `.catch(e => { console.error("[vinext-tpr] Server failed to start:", e); process.exit(1); });`,
  ].join("");

  const proc = spawn(process.execPath, ["--input-type=module", "-e", script], {
    cwd: root,
    stdio: "pipe",
    env: { ...process.env, NODE_ENV: "production" },
  });

  // Forward server errors to the parent's stderr for debugging
  proc.stderr?.on("data", (chunk: Buffer) => {
    const msg = chunk.toString().trim();
    if (msg) console.error(`  [tpr-server] ${msg}`);
  });

  return proc;
}

export function resolveVinextProdServerPath(root: string): string {
  return createRequire(path.join(root, "package.json")).resolve("vinext/server/prod-server");
}

/** Poll the local server until it responds or the timeout is reached. */
async function waitForServer(port: number, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2000);
      const response = await fetch(`http://127.0.0.1:${port}/`, {
        redirect: "manual",
        signal: controller.signal,
      });
      clearTimeout(timer);
      // Any response means the server is up
      await response.text(); // consume body
      return;
    } catch {
      await new Promise<void>((r) => setTimeout(r, 300));
    }
  }
  throw new Error(`Local production server failed to start within ${timeoutMs / 1000}s`);
}

// ─── KV Upload ───────────────────────────────────────────────────────────────

/** KV bulk API accepts up to 10,000 pairs per request */
const KV_BATCH_SIZE = 10_000;

/** Maximum KV expiration TTL: 30 days */
const MAX_KV_TTL_SECONDS = 30 * 24 * 3600;

/**
 * Build KV bulk API pairs from pre-rendered entries.
 *
 * Key format matches the runtime KVCacheHandler exactly:
 *   createKvKeySpace().entryKey(isrCacheKey("app", pathname, buildId) + ":html")
 *   → "cache:app:<buildId>:<pathname>:html"
 */
export function buildTprKVPairs(
  entries: Map<string, PrerenderResult>,
  buildId: string | undefined,
  defaultRevalidateSeconds: number,
): Array<{ key: string; value: string; expiration_ttl: number }> {
  const now = Date.now();
  const pairs: Array<{ key: string; value: string; expiration_ttl: number }> = [];
  const keySpace = createKvKeySpace(undefined);

  for (const [routePath, result] of entries) {
    if (!isTprCacheable(result.headers)) continue;

    const revalidateSeconds = readTprRevalidateHeader(result.headers) ?? defaultRevalidateSeconds;
    if (!Number.isFinite(revalidateSeconds) || revalidateSeconds <= 0) continue;

    const revalidateAt = now + revalidateSeconds * 1000;

    // 30-day TTL matches runtime KVCacheHandler.set().
    const kvTtl = MAX_KV_TTL_SECONDS;

    // Path-derived implicit tags so revalidatePath()/revalidateTag() can
    // invalidate TPR-seeded entries. Without this the seeded entry has no
    // tags and tag-based invalidation can never reach it (#1486).
    const tags = buildAppPageCacheTags(routePath, []);

    const entry = {
      value: {
        kind: "APP_PAGE" as const,
        html: result.html,
        headers: result.headers,
        status: result.status,
      },
      tags,
      lastModified: now,
      revalidateAt,
    };

    const cacheKey = keySpace.entryKey(isrCacheKey("app", routePath, buildId) + ":html");

    pairs.push({
      key: cacheKey,
      value: JSON.stringify(entry),
      expiration_ttl: kvTtl,
    });
  }

  return pairs;
}

/**
 * Upload pre-rendered pages to KV using the Cloudflare REST API.
 * Writes in the same KVCacheEntry format that KVCacheHandler reads
 * at runtime, so ISR serves these entries without any code changes.
 */
async function uploadToKV(
  entries: Map<string, PrerenderResult>,
  namespaceId: string,
  accountId: string,
  apiToken: string,
  defaultRevalidateSeconds: number,
  buildId?: string,
): Promise<void> {
  const pairs = buildTprKVPairs(entries, buildId, defaultRevalidateSeconds);
  for (let i = 0; i < pairs.length; i += KV_BATCH_SIZE) {
    const batch = pairs.slice(i, i + KV_BATCH_SIZE);
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/bulk`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(batch),
      },
    );

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `KV bulk upload failed (batch ${Math.floor(i / KV_BATCH_SIZE) + 1}): ${response.status} — ${text}`,
      );
    }
  }
}

// ─── Main Entry ──────────────────────────────────────────────────────────────

/** Default revalidation TTL for pre-rendered pages (1 hour). */
const DEFAULT_REVALIDATE_SECONDS = 3600;

/**
 * Run the TPR pipeline: query traffic, select routes, pre-render, upload.
 *
 * Designed to be called between the build step and wrangler deploy in the
 * `vinext-cloudflare deploy` pipeline. Gracefully skips (never errors) when
 * the prerequisites aren't met.
 */
export async function runTPR(options: TPROptions): Promise<TPRResult> {
  const startTime = Date.now();
  const { root, config, coverage, limit, window: windowHours } = options;

  const skip = (reason: string): TPRResult => ({
    totalPaths: 0,
    prerenderedCount: 0,
    coverageAchieved: 0,
    durationMs: Date.now() - startTime,
    skipped: reason,
  });

  // ── 1. Check for API token ────────────────────────────────────
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  if (!apiToken) {
    return skip("no CLOUDFLARE_API_TOKEN set");
  }

  // ── 2. Parse wrangler config ──────────────────────────────────
  const wranglerConfig = parseWranglerConfig(root, config);
  if (!wranglerConfig) {
    return skip("could not parse wrangler config");
  }

  // ── 3. Check for custom domain ────────────────────────────────
  if (!wranglerConfig.customDomain) {
    return skip("no custom domain — zone analytics unavailable");
  }

  // ── 4. Check for KV namespace ─────────────────────────────────
  if (!wranglerConfig.kvNamespaceId) {
    return skip("no VINEXT_KV_CACHE KV namespace configured");
  }

  // ── 5. Resolve account ID ─────────────────────────────────────
  const accountId = wranglerConfig.accountId ?? (await resolveAccountId(apiToken));
  if (!accountId) {
    return skip("could not resolve Cloudflare account ID");
  }

  // ── 6. Resolve zone ID ────────────────────────────────────────
  console.log(`  TPR: Analyzing traffic for ${wranglerConfig.customDomain} (last ${windowHours}h)`);

  const zoneId = await resolveZoneId(wranglerConfig.customDomain, apiToken);
  if (!zoneId) {
    return skip(`could not resolve zone for ${wranglerConfig.customDomain}`);
  }

  // ── 7. Query traffic data ─────────────────────────────────────
  let traffic: TrafficEntry[];
  try {
    traffic = await queryTraffic(zoneId, apiToken, windowHours);
  } catch (err) {
    return skip(`analytics query failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (traffic.length === 0) {
    return skip("no traffic data available (first deploy?)");
  }

  // ── 8. Select routes by coverage ──────────────────────────────
  const selection = selectRoutes(traffic, coverage, limit);

  console.log(
    `  TPR: ${traffic.length.toLocaleString()} unique paths — ` +
      `${selection.routes.length} pages cover ${Math.round(selection.coveragePercent)}% of traffic`,
  );

  if (selection.routes.length === 0) {
    return {
      totalPaths: traffic.length,
      prerenderedCount: 0,
      coverageAchieved: 0,
      durationMs: Date.now() - startTime,
      skipped: "no pre-renderable routes after filtering",
    };
  }

  // ── 9. Pre-render selected routes ─────────────────────────────
  console.log(`  TPR: Pre-rendering ${selection.routes.length} pages...`);

  const routePaths = selection.routes.map((r) => r.path);
  let rendered: Map<string, PrerenderResult>;
  try {
    rendered = await prerenderRoutes(routePaths, root, wranglerConfig.customDomain);
  } catch (err) {
    return skip(`pre-rendering failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (rendered.size === 0) {
    return {
      totalPaths: traffic.length,
      prerenderedCount: 0,
      coverageAchieved: selection.coveragePercent,
      durationMs: Date.now() - startTime,
      skipped: "all pages failed to pre-render (request-dependent?)",
    };
  }

  // ── 10. Upload to KV ──────────────────────────────────────────
  // Read buildId from the BUILD_ID file written by vinext:build-id plugin.
  let buildId: string;
  try {
    buildId = fs.readFileSync(path.join(root, "dist", "server", "BUILD_ID"), "utf-8").trim();
  } catch {
    // BUILD_ID is written by vinext:build-id during every production build.
    // If missing, the build output is likely corrupted or incomplete.
    // Proceeding without buildId would write keys that never match runtime.
    console.warn(
      "  TPR: Could not read BUILD_ID from dist/server/ — KV keys will not match runtime. Skipping KV upload.",
    );
    return skip("BUILD_ID not found in dist/server/ — build output may be incomplete");
  }

  try {
    await uploadToKV(
      rendered,
      wranglerConfig.kvNamespaceId,
      accountId,
      apiToken,
      DEFAULT_REVALIDATE_SECONDS,
      buildId,
    );
  } catch (err) {
    return skip(`KV upload failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const durationMs = Date.now() - startTime;
  console.log(
    `  TPR: Pre-rendered ${rendered.size} pages in ${(durationMs / 1000).toFixed(1)}s → KV cache`,
  );

  return {
    totalPaths: traffic.length,
    prerenderedCount: rendered.size,
    coverageAchieved: selection.coveragePercent,
    durationMs,
  };
}
