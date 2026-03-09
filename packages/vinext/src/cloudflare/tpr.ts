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
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface TPROptions {
  /** Project root directory. */
  root: string;
  /** Traffic coverage percentage (0–100). Default: 90. */
  coverage: number;
  /** Hard cap on number of pages to pre-render. Default: 1000. */
  limit: number;
  /** Analytics lookback window in hours. Default: 24. */
  window: number;
}

export interface TPRResult {
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
}

interface TrafficEntry {
  path: string;
  requests: number;
}

interface SelectedRoutes {
  routes: TrafficEntry[];
  totalRequests: number;
  coveredRequests: number;
  coveragePercent: number;
}

interface PrerenderResult {
  html: string;
  status: number;
  headers: Record<string, string>;
}

interface WranglerConfig {
  accountId?: string;
  kvNamespaceId?: string;
  customDomain?: string;
}

// ─── Wrangler Config Parsing ─────────────────────────────────────────────────

/**
 * Parse wrangler config (JSONC or TOML) to extract the fields TPR needs:
 * account_id, VINEXT_CACHE KV namespace ID, and custom domain.
 */
export function parseWranglerConfig(root: string): WranglerConfig | null {
  // Try JSONC / JSON first
  for (const filename of ["wrangler.jsonc", "wrangler.json"]) {
    const filepath = path.join(root, filename);
    if (fs.existsSync(filepath)) {
      const content = fs.readFileSync(filepath, "utf-8");
      try {
        const json = JSON.parse(stripJsonComments(content));
        return extractFromJSON(json);
      } catch {
        continue;
      }
    }
  }

  // Try TOML
  const tomlPath = path.join(root, "wrangler.toml");
  if (fs.existsSync(tomlPath)) {
    const content = fs.readFileSync(tomlPath, "utf-8");
    return extractFromTOML(content);
  }

  return null;
}

/**
 * Strip single-line (//) and multi-line comments from JSONC while
 * preserving strings that contain slashes.
 */
function stripJsonComments(str: string): string {
  let result = "";
  let inString = false;
  let inSingleLine = false;
  let inMultiLine = false;
  let escapeNext = false;

  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    const next = str[i + 1];

    if (escapeNext) {
      if (!inSingleLine && !inMultiLine) result += ch;
      escapeNext = false;
      continue;
    }

    if (ch === "\\" && inString) {
      result += ch;
      escapeNext = true;
      continue;
    }

    if (inSingleLine) {
      if (ch === "\n") {
        inSingleLine = false;
        result += ch;
      }
      continue;
    }

    if (inMultiLine) {
      if (ch === "*" && next === "/") {
        inMultiLine = false;
        i++;
      }
      continue;
    }

    if (ch === '"' && !inString) {
      inString = true;
      result += ch;
      continue;
    }

    if (ch === '"' && inString) {
      inString = false;
      result += ch;
      continue;
    }

    if (!inString && ch === "/" && next === "/") {
      inSingleLine = true;
      i++;
      continue;
    }

    if (!inString && ch === "/" && next === "*") {
      inMultiLine = true;
      i++;
      continue;
    }

    result += ch;
  }

  return result;
}

function extractFromJSON(config: Record<string, unknown>): WranglerConfig {
  const result: WranglerConfig = {};

  // account_id
  if (typeof config.account_id === "string") {
    result.accountId = config.account_id;
  }

  // KV namespace ID for VINEXT_CACHE
  if (Array.isArray(config.kv_namespaces)) {
    const vinextKV = config.kv_namespaces.find(
      (ns: Record<string, unknown>) =>
        ns && typeof ns === "object" && ns.binding === "VINEXT_CACHE",
    );
    if (vinextKV && typeof vinextKV.id === "string" && vinextKV.id !== "<your-kv-namespace-id>") {
      result.kvNamespaceId = vinextKV.id;
    }
  }

  // Custom domain — check routes[] and custom_domains[]
  const domain = extractDomainFromRoutes(config.routes) ?? extractDomainFromCustomDomains(config);
  if (domain) result.customDomain = domain;

  return result;
}

function extractDomainFromRoutes(routes: unknown): string | null {
  if (!Array.isArray(routes)) return null;

  for (const route of routes) {
    if (typeof route === "string") {
      const domain = cleanDomain(route);
      if (domain && !domain.includes("workers.dev")) return domain;
    } else if (route && typeof route === "object") {
      const r = route as Record<string, unknown>;
      const pattern =
        typeof r.zone_name === "string"
          ? r.zone_name
          : typeof r.pattern === "string"
            ? r.pattern
            : null;
      if (pattern) {
        const domain = cleanDomain(pattern);
        if (domain && !domain.includes("workers.dev")) return domain;
      }
    }
  }
  return null;
}

function extractDomainFromCustomDomains(config: Record<string, unknown>): string | null {
  // Workers Custom Domains: "custom_domains": ["example.com"]
  if (Array.isArray(config.custom_domains)) {
    for (const d of config.custom_domains) {
      if (typeof d === "string" && !d.includes("workers.dev")) {
        return cleanDomain(d);
      }
    }
  }
  return null;
}

/** Strip protocol and trailing wildcards from a route pattern to get a bare domain. */
function cleanDomain(raw: string): string | null {
  const cleaned = raw
    .replace(/^https?:\/\//, "")
    .replace(/\/\*$/, "")
    .replace(/\/+$/, "")
    .split("/")[0]; // Take only the host part
  return cleaned || null;
}

/**
 * Simple extraction of specific fields from wrangler.toml content.
 * Not a full TOML parser — just enough for the fields we need.
 */
function extractFromTOML(content: string): WranglerConfig {
  const result: WranglerConfig = {};

  // account_id = "..."
  const accountMatch = content.match(/^account_id\s*=\s*"([^"]+)"/m);
  if (accountMatch) result.accountId = accountMatch[1];

  // KV namespace with binding = "VINEXT_CACHE"
  // Look for [[kv_namespaces]] blocks
  const kvBlocks = content.split(/\[\[kv_namespaces\]\]/);
  for (let i = 1; i < kvBlocks.length; i++) {
    const block = kvBlocks[i].split(/\[\[/)[0]; // Take until next section
    const bindingMatch = block.match(/binding\s*=\s*"([^"]+)"/);
    const idMatch = block.match(/\bid\s*=\s*"([^"]+)"/);
    if (
      bindingMatch?.[1] === "VINEXT_CACHE" &&
      idMatch?.[1] &&
      idMatch[1] !== "<your-kv-namespace-id>"
    ) {
      result.kvNamespaceId = idMatch[1];
    }
  }

  // routes — both string and table forms
  // route = "example.com/*"
  const routeMatch = content.match(/^route\s*=\s*"([^"]+)"/m);
  if (routeMatch) {
    const domain = cleanDomain(routeMatch[1]);
    if (domain && !domain.includes("workers.dev")) {
      result.customDomain = domain;
    }
  }

  // [[routes]] blocks
  if (!result.customDomain) {
    const routeBlocks = content.split(/\[\[routes\]\]/);
    for (let i = 1; i < routeBlocks.length; i++) {
      const block = routeBlocks[i].split(/\[\[/)[0];
      const patternMatch = block.match(/pattern\s*=\s*"([^"]+)"/);
      if (patternMatch) {
        const domain = cleanDomain(patternMatch[1]);
        if (domain && !domain.includes("workers.dev")) {
          result.customDomain = domain;
          break;
        }
      }
    }
  }

  return result;
}

// ─── Cloudflare API ──────────────────────────────────────────────────────────

/** Resolve zone ID from a domain name via the Cloudflare API. */
async function resolveZoneId(domain: string, apiToken: string): Promise<string | null> {
  // Extract the registrable domain (e.g., "shop.example.com" → "example.com").
  // TODO: This doesn't handle multi-part TLDs like .co.uk, .com.br, .com.au.
  // For those, we'd need a public suffix list. For now, we try the simple
  // two-part extraction first, then fall back to the full domain if the zone
  // lookup fails. Cloudflare's zone API will match on the correct registrable
  // domain regardless.
  const parts = domain.split(".");
  const MULTI_PART_TLDS = [
    "co.uk",
    "com.br",
    "com.au",
    "co.jp",
    "co.kr",
    "co.nz",
    "co.za",
    "com.mx",
    "com.ar",
    "com.cn",
    "org.uk",
    "net.au",
  ];
  const lastTwo = parts.slice(-2).join(".");
  let rootDomain: string;
  if (MULTI_PART_TLDS.includes(lastTwo) && parts.length > 2) {
    rootDomain = parts.slice(-3).join(".");
  } else {
    rootDomain = parts.length > 2 ? parts.slice(-2).join(".") : domain;
  }

  const response = await fetch(
    `https://api.cloudflare.com/client/v4/zones?name=${encodeURIComponent(rootDomain)}`,
    {
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
    },
  );

  if (!response.ok) return null;

  const data = (await response.json()) as {
    success: boolean;
    result?: Array<{ id: string }>;
  };
  if (!data.success || !data.result?.length) return null;

  return data.result[0].id;
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
    if (e.path.startsWith("/_vinext/") || e.path.startsWith("/_next/")) return false;
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
export function selectRoutes(
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

          // Only cache successful responses (2xx and 3xx)
          if (response.status < 400) {
            const html = await response.text();
            const headers: Record<string, string> = {};
            response.headers.forEach((value, key) => {
              // Only keep relevant headers
              if (
                key === "content-type" ||
                key === "cache-control" ||
                key === "x-vinext-revalidate" ||
                key === "location"
              ) {
                headers[key] = value;
              }
            });
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
 * Uses the same Node.js binary and resolves prod-server.js relative
 * to the current module (works whether vinext is installed or linked).
 */
function startLocalServer(root: string, port: number): ChildProcess {
  const thisDir = fileURLToPath(new URL(".", import.meta.url));
  const prodServerPath = path.resolve(thisDir, "..", "server", "prod-server.js");
  const outDir = path.join(root, "dist");

  // Escape backslashes for Windows paths inside the JS string
  const escapedProdServer = prodServerPath.replace(/\\/g, "\\\\");
  const escapedOutDir = outDir.replace(/\\/g, "\\\\");

  const script = [
    `import("file://${escapedProdServer}")`,
    `.then(m => m.startProdServer({ port: ${port}, host: "127.0.0.1", outDir: "${escapedOutDir}" }))`,
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
): Promise<void> {
  const now = Date.now();

  // Build the bulk write payload
  const pairs: Array<{
    key: string;
    value: string;
    expiration_ttl?: number;
  }> = [];

  for (const [routePath, result] of entries) {
    // Determine revalidation window — use the page's revalidate header
    // if present, otherwise fall back to the default
    const revalidateHeader = result.headers["x-vinext-revalidate"];
    const revalidateSeconds =
      revalidateHeader && !isNaN(Number(revalidateHeader))
        ? Number(revalidateHeader)
        : defaultRevalidateSeconds;

    const revalidateAt = revalidateSeconds > 0 ? now + revalidateSeconds * 1000 : null;

    // KV TTL: 10x the revalidation period, clamped to [60s, 30d]
    // (matches the logic in KVCacheHandler.set)
    const kvTtl =
      revalidateSeconds > 0
        ? Math.max(Math.min(revalidateSeconds * 10, 30 * 24 * 3600), 60)
        : 24 * 3600; // 24h fallback if no revalidation

    const entry = {
      value: {
        kind: "APP_PAGE" as const,
        html: result.html,
        headers: result.headers,
        status: result.status,
      },
      tags: [] as string[],
      lastModified: now,
      revalidateAt,
    };

    pairs.push({
      key: `cache:${routePath}`,
      value: JSON.stringify(entry),
      expiration_ttl: kvTtl,
    });
  }

  // Upload in batches (KV bulk API accepts up to 10,000 per request)
  const BATCH_SIZE = 10_000;
  for (let i = 0; i < pairs.length; i += BATCH_SIZE) {
    const batch = pairs.slice(i, i + BATCH_SIZE);
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
        `KV bulk upload failed (batch ${Math.floor(i / BATCH_SIZE) + 1}): ${response.status} — ${text}`,
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
 * Designed to be called between the build step and wrangler deploy in
 * the `vinext deploy` pipeline. Gracefully skips (never errors) when
 * the prerequisites aren't met.
 */
export async function runTPR(options: TPROptions): Promise<TPRResult> {
  const startTime = Date.now();
  const { root, coverage, limit, window: windowHours } = options;

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
  const wranglerConfig = parseWranglerConfig(root);
  if (!wranglerConfig) {
    return skip("could not parse wrangler config");
  }

  // ── 3. Check for custom domain ────────────────────────────────
  if (!wranglerConfig.customDomain) {
    return skip("no custom domain — zone analytics unavailable");
  }

  // ── 4. Check for KV namespace ─────────────────────────────────
  if (!wranglerConfig.kvNamespaceId) {
    return skip("no VINEXT_CACHE KV namespace configured");
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
  try {
    await uploadToKV(
      rendered,
      wranglerConfig.kvNamespaceId,
      accountId,
      apiToken,
      DEFAULT_REVALIDATE_SECONDS,
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
