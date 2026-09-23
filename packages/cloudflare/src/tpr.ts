/**
 * TPR: traffic-aware pre-warm route selection
 *
 * Uses Cloudflare zone analytics to determine which routes should be fed into
 * the standard CDN pre-warming flow.
 *
 * Flow:
 *   1. Find the custom domain in the generated Worker or Wrangler config
 *   2. Resolve the Cloudflare zone for the custom domain
 *   3. Query zone analytics (GraphQL) for top pages by request count
 *   4. Return the ranked candidates for standard route resolution and selection
 *
 * TPR is an experimental feature enabled via
 * --experimental-traffic-aware-warm-cache. It gracefully skips when no custom
 * domain, API token, or traffic data exists.
 */

import fs from "node:fs";
import path from "node:path";
import { parseWranglerConfig } from "./wrangler-config.js";

export { parseWranglerConfig };

// ─── Types ───────────────────────────────────────────────────────────────────

export type TPROptions = {
  /** Project root directory. */
  root: string;
  /** Wrangler config path, relative to root unless absolute. */
  config?: string;
  /** Wrangler environment whose custom domain should be analyzed. */
  env?: string;
  /** Explicit domain used to resolve the analytics zone, overriding Wrangler routes. */
  hostname?: string;
  /** Read domains from generated Build Output instead of a Wrangler config. */
  typedConfig?: boolean;
  /** Analytics lookback window in hours. Default: 24. */
  window: number;
};

export type TPRRouteResult = {
  routes: TrafficEntry[];
  /** If TPR was skipped, the reason. */
  skipped?: string;
};

export type TrafficEntry = {
  path: string;
  requests: number;
};

export type SelectedRoutes = {
  routes: TrafficEntry[];
  totalRequests: number;
  coveredRequests: number;
  coveragePercent: number;
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

  const query = `query($zoneTag: string!, $start: Time!, $end: Time!) {
    viewer {
      zones(filter: { zoneTag: $zoneTag }) {
        httpRequestsAdaptiveGroups(
          limit: 10000
          orderBy: [count_DESC]
          filter: {
            datetime_geq: $start
            datetime_lt: $end
            requestSource: "eyeball"
          }
        ) {
          count
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
    body: JSON.stringify({
      query,
      variables: {
        zoneTag,
        start: start.toISOString(),
        end: now.toISOString(),
      },
    }),
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
            count: number;
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
      requests: g.count,
    })),
  );
}

/** Filter out non-page requests (static assets, API routes, internal routes). */
export function filterTrafficPaths(entries: TrafficEntry[]): TrafficEntry[] {
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

// ─── Route resolution ─────────────────────────────────────────────────────────

/**
 * Resolve ranked traffic paths. The standard CDN pre-warming flow owns route
 * matching, coverage selection, rendering, and cache admission.
 */
export async function resolveTPRRoutes(options: TPROptions): Promise<TPRRouteResult> {
  const { root, config, window: windowHours } = options;
  const skip = (reason: string): TPRRouteResult => ({
    routes: [],
    skipped: reason,
  });

  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  if (!apiToken) return skip("no CLOUDFLARE_API_TOKEN set");

  const wranglerConfig =
    options.hostname || options.typedConfig ? null : parseWranglerConfig(root, config);
  const buildOutputConfigPath = path.join(
    root,
    ".cloudflare/output/v0/workers/default/worker.config.json",
  );
  const typedDomains: unknown =
    options.typedConfig && !options.hostname && fs.existsSync(buildOutputConfigPath)
      ? (JSON.parse(fs.readFileSync(buildOutputConfigPath, "utf8")) as { domains?: unknown })
          .domains
      : undefined;
  if (!wranglerConfig && !options.hostname && !options.typedConfig)
    return skip("could not parse wrangler config");
  const hostname =
    options.hostname ??
    (Array.isArray(typedDomains)
      ? typedDomains.find(
          (domain): domain is string => typeof domain === "string" && domain.length > 0,
        )
      : undefined) ??
    wranglerConfig?.env?.[options.env ?? ""]?.customDomain ??
    wranglerConfig?.customDomain;
  if (!hostname) {
    return skip("no custom domain — zone analytics unavailable");
  }

  console.log(`  TPR: Analyzing zone traffic for ${hostname} (last ${windowHours}h)`);

  const zoneId = await resolveZoneId(hostname, apiToken);
  if (!zoneId) return skip(`could not resolve zone for ${hostname}`);

  let traffic: TrafficEntry[];
  try {
    traffic = await queryTraffic(zoneId, apiToken, windowHours);
  } catch (error) {
    return skip(
      `analytics query failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (traffic.length === 0) return skip("no traffic data available (first deploy?)");

  return { routes: traffic };
}
