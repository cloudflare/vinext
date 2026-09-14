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

type PrerenderResult = {
  html: string;
  status: number;
  headers: Record<string, string>;
};

type WranglerConfig = {
  accountId?: string;
  kvNamespaceId?: string;
  customDomain?: string;
  routePathLike?: string;
  routeZoneId?: string;
  routeZoneName?: string;
  unsupportedTrafficScope?: string;
  name?: string;
  legacyEnv?: boolean;
  env?: Record<string, WranglerEnvironmentConfig>;
};

export type WranglerEnvironmentConfig = {
  customDomain?: string;
  name?: string;
};

type WranglerRouteTarget = {
  hostname: string;
  pathLike?: string;
  scheme?: "http" | "https";
  zoneId?: string;
  zoneName?: string;
};

// ─── Wrangler Config Parsing ─────────────────────────────────────────────────

/**
 * Parse wrangler config (JSONC or TOML) to extract the fields TPR needs:
 * account_id, VINEXT_KV_CACHE KV namespace ID, and custom domain.
 */
export function parseWranglerConfig(root: string, configPath?: string): WranglerConfig | null {
  if (configPath) {
    const filepath = path.resolve(root, configPath);
    if (!fs.existsSync(filepath)) return null;
    const content = fs.readFileSync(filepath, "utf-8");
    if (filepath.endsWith(".toml")) {
      return extractFromTOML(content);
    }
    try {
      const json = JSON.parse(stripJsonCommentsAndTrailingCommas(content));
      return extractFromJSON(json);
    } catch {
      return null;
    }
  }

  // Try JSONC / JSON first
  for (const filename of ["wrangler.jsonc", "wrangler.json"]) {
    const filepath = path.join(root, filename);
    if (fs.existsSync(filepath)) {
      const content = fs.readFileSync(filepath, "utf-8");
      try {
        const json = JSON.parse(stripJsonCommentsAndTrailingCommas(content));
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
 * Strip single-line (//), multi-line comments, and trailing commas from JSONC
 * while preserving strings that contain comment-like text or commas.
 */
function stripJsonCommentsAndTrailingCommas(str: string): string {
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

    if (!inString && ch === "," && isJsonTrailingComma(str, i + 1)) {
      continue;
    }

    result += ch;
  }

  return result;
}

function isJsonTrailingComma(str: string, start: number): boolean {
  for (let i = start; i < str.length; i++) {
    const ch = str[i];
    const next = str[i + 1];
    if (ch === undefined) return false;
    if (/\s/.test(ch)) {
      continue;
    }
    if (ch === "/" && next === "/") {
      i += 2;
      while (i < str.length && str[i] !== "\n") {
        i++;
      }
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < str.length) {
        if (str[i] === "*" && str[i + 1] === "/") {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    return ch === "}" || ch === "]";
  }

  return false;
}

function extractFromJSON(config: Record<string, unknown>): WranglerConfig {
  const result: WranglerConfig = {};

  if (typeof config.name === "string" && config.name.length > 0) {
    result.name = config.name;
  }

  if (typeof config.legacy_env === "boolean") {
    result.legacyEnv = config.legacy_env;
  }

  // account_id
  if (typeof config.account_id === "string") {
    result.accountId = config.account_id;
  }

  // KV namespace ID for VINEXT_KV_CACHE
  if (Array.isArray(config.kv_namespaces)) {
    const vinextKV = config.kv_namespaces.find(
      (ns: Record<string, unknown>) =>
        ns &&
        typeof ns === "object" &&
        (ns.binding === "VINEXT_KV_CACHE" || ns.binding === "VINEXT_CACHE"),
    );
    if (vinextKV && typeof vinextKV.id === "string" && vinextKV.id !== "<your-kv-namespace-id>") {
      result.kvNamespaceId = vinextKV.id;
    }
  }

  // Custom domain — check route, routes[], and custom_domains[]
  const routeValues = extractRouteValues(config);
  const routeTargets = extractRouteTargets(routeValues);
  const customDomains = extractDomainsFromCustomDomains(config);
  if (routeTargets.length > 1) {
    result.unsupportedTrafficScope = "multiple Worker routes — TPR requires one traffic scope";
  } else if (routeTargets[0]?.scheme) {
    result.unsupportedTrafficScope =
      "scheme-specific Worker route — TPR cannot safely combine HTTP and HTTPS analytics";
  } else if (routeTargets[0]) {
    const routeTarget = routeTargets[0];
    result.customDomain = routeTarget.hostname;
    result.routePathLike = routeTarget.pathLike;
    result.routeZoneId = routeTarget.zoneId;
    result.routeZoneName = routeTarget.zoneName;
  } else if (customDomains.length > 1) {
    result.unsupportedTrafficScope =
      "multiple Worker custom domains — TPR requires one traffic scope";
  } else if (customDomains[0]) {
    result.customDomain = customDomains[0];
  }

  const env = extractEnvConfigs(config.env);
  if (env) result.env = env;

  return result;
}

function extractEnvConfigs(envs: unknown): Record<string, WranglerEnvironmentConfig> | undefined {
  if (!envs || typeof envs !== "object" || Array.isArray(envs)) return undefined;

  const result: Record<string, WranglerEnvironmentConfig> = {};
  for (const [envName, rawConfig] of Object.entries(envs)) {
    if (!rawConfig || typeof rawConfig !== "object" || Array.isArray(rawConfig)) continue;
    const envConfig = extractEnvironmentConfig(rawConfig as Record<string, unknown>);
    if (envConfig.name || envConfig.customDomain) {
      result[envName] = envConfig;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function extractEnvironmentConfig(config: Record<string, unknown>): WranglerEnvironmentConfig {
  const result: WranglerEnvironmentConfig = {};
  if (typeof config.name === "string" && config.name.length > 0) {
    result.name = config.name;
  }
  const domain =
    extractRouteTargets(extractRouteValues(config))[0]?.hostname ??
    extractDomainFromCustomDomains(config);
  if (domain) result.customDomain = domain;
  return result;
}

function extractRouteValues(config: Record<string, unknown>): unknown[] {
  const routes: unknown[] = [];
  if (config.route !== undefined) routes.push(config.route);
  if (Array.isArray(config.routes)) routes.push(...config.routes);
  return routes;
}

function extractRouteTargets(routes: unknown): WranglerRouteTarget[] {
  if (!Array.isArray(routes)) return [];
  const targets: WranglerRouteTarget[] = [];

  for (const route of routes) {
    if (typeof route === "string") {
      const target = parseRoutePattern(route);
      if (target && !target.hostname.includes("workers.dev")) targets.push(target);
    } else if (route && typeof route === "object") {
      const r = route as Record<string, unknown>;
      const pattern = typeof r.pattern === "string" ? r.pattern : null;
      if (pattern) {
        const target = parseRoutePattern(pattern);
        if (target && !target.hostname.includes("workers.dev")) {
          targets.push({
            ...target,
            zoneId: typeof r.zone_id === "string" ? r.zone_id : undefined,
            zoneName: typeof r.zone_name === "string" ? r.zone_name.toLowerCase() : undefined,
          });
        }
      }
    }
  }
  return targets;
}

function parseRoutePattern(raw: string): WranglerRouteTarget | null {
  const scheme = raw.match(/^(https?):\/\//i)?.[1]?.toLowerCase() as "http" | "https" | undefined;
  const withoutProtocol = raw.replace(/^https?:\/\//i, "");
  const slashIndex = withoutProtocol.indexOf("/");
  const hostname = (slashIndex === -1 ? withoutProtocol : withoutProtocol.slice(0, slashIndex))
    .replace(/\/+$/, "")
    .toLowerCase();
  if (!hostname || hostname.includes("*")) return null;

  const routePath = slashIndex === -1 ? "" : withoutProtocol.slice(slashIndex);
  if (!routePath || routePath === "/*") return { hostname, scheme };

  // Cloudflare GraphQL uses SQL LIKE syntax. Preserve literal URL-encoded
  // percent signs and underscores while translating route wildcards.
  const pathLike = routePath
    .replaceAll("\\", "\\\\")
    .replaceAll("%", "\\%")
    .replaceAll("_", "\\_")
    .replaceAll("*", "%");
  return { hostname, pathLike, scheme };
}

function extractDomainFromCustomDomains(config: Record<string, unknown>): string | null {
  return extractDomainsFromCustomDomains(config)[0] ?? null;
}

function extractDomainsFromCustomDomains(config: Record<string, unknown>): string[] {
  const domains: string[] = [];
  // Workers Custom Domains: "custom_domains": ["example.com"]
  if (Array.isArray(config.custom_domains)) {
    for (const d of config.custom_domains) {
      if (typeof d !== "string") continue;
      const domain = cleanDomain(d);
      if (domain && !domain.includes("workers.dev")) domains.push(domain);
    }
  }
  return domains;
}

/** Strip protocol and trailing wildcards from a route pattern to get a bare domain. */
function cleanDomain(raw: string): string | null {
  return parseRoutePattern(raw)?.hostname ?? null;
}

function getTomlRootBody(content: string): string {
  const lines: string[] = [];
  for (const line of content.split("\n")) {
    if (parseTomlSectionHeader(line)) break;
    lines.push(line);
  }
  return lines.join("\n");
}

function parseTomlRouteTable(table: string): WranglerRouteTarget | null {
  const pattern = table.match(/\bpattern\s*=\s*"([^"]+)"/)?.[1];
  if (!pattern) return null;
  const target = parseRoutePattern(pattern);
  if (!target || target.hostname.includes("workers.dev")) return null;
  return {
    ...target,
    zoneId: table.match(/\bzone_id\s*=\s*"([^"]+)"/)?.[1],
    zoneName: table.match(/\bzone_name\s*=\s*"([^"]+)"/)?.[1]?.toLowerCase(),
  };
}

function extractTomlInlineRouteTargets(content: string): WranglerRouteTarget[] {
  const root = getTomlRootBody(content);
  const targets: WranglerRouteTarget[] = [];

  const scalar = root.match(/^route\s*=\s*"([^"]+)"/m)?.[1];
  if (scalar) {
    const target = parseRoutePattern(scalar);
    if (target && !target.hostname.includes("workers.dev")) targets.push(target);
  }

  const inlineTable = root.match(/^route\s*=\s*\{([^}]*)\}/m)?.[1];
  if (inlineTable) {
    const target = parseTomlRouteTable(inlineTable);
    if (target) targets.push(target);
  }

  const routesArray = root.match(/^routes\s*=\s*\[([\s\S]*?)\]/m)?.[1];
  if (routesArray) {
    const tables = [...routesArray.matchAll(/\{([^{}]*)\}/g)];
    for (const table of tables) {
      const target = parseTomlRouteTable(table[1]);
      if (target) targets.push(target);
    }

    const stringsOnly = routesArray.replaceAll(/\{[^{}]*\}/g, "");
    for (const match of stringsOnly.matchAll(/"([^"]+)"/g)) {
      const target = parseRoutePattern(match[1]);
      if (target && !target.hostname.includes("workers.dev")) targets.push(target);
    }
  }

  return targets;
}

function applyTomlRouteTargets(result: WranglerConfig, targets: WranglerRouteTarget[]): void {
  if (targets.length > 1) {
    result.unsupportedTrafficScope = "multiple Worker routes — TPR requires one traffic scope";
  } else if (targets[0]?.scheme) {
    result.unsupportedTrafficScope =
      "scheme-specific Worker route — TPR cannot safely combine HTTP and HTTPS analytics";
  } else if (targets[0]) {
    result.customDomain = targets[0].hostname;
    result.routePathLike = targets[0].pathLike;
    result.routeZoneId = targets[0].zoneId;
    result.routeZoneName = targets[0].zoneName;
  }
}

/**
 * Simple extraction of specific fields from wrangler.toml content.
 * Not a full TOML parser — just enough for the fields we need.
 */
function extractFromTOML(content: string): WranglerConfig {
  const result: WranglerConfig = {};

  const nameMatch = content.match(/^name\s*=\s*"([^"]+)"/m);
  if (nameMatch) result.name = nameMatch[1];

  const legacyEnvMatch = content.match(/^legacy_env\s*=\s*(true|false)\s*$/m);
  if (legacyEnvMatch) result.legacyEnv = legacyEnvMatch[1] === "true";

  // account_id = "..."
  const accountMatch = content.match(/^account_id\s*=\s*"([^"]+)"/m);
  if (accountMatch) result.accountId = accountMatch[1];

  // KV namespace with binding = "VINEXT_KV_CACHE"
  // Look for [[kv_namespaces]] blocks
  const kvBlocks = content.split(/\[\[kv_namespaces\]\]/);
  for (let i = 1; i < kvBlocks.length; i++) {
    const block = kvBlocks[i].split(/\[\[/)[0]; // Take until next section
    const bindingMatch = block.match(/binding\s*=\s*"([^"]+)"/);
    const idMatch = block.match(/\bid\s*=\s*"([^"]+)"/);
    if (
      (bindingMatch?.[1] === "VINEXT_KV_CACHE" || bindingMatch?.[1] === "VINEXT_CACHE") &&
      idMatch?.[1] &&
      idMatch[1] !== "<your-kv-namespace-id>"
    ) {
      result.kvNamespaceId = idMatch[1];
    }
  }

  const routeTargets = extractTomlInlineRouteTargets(content);
  for (const block of content.split(/\[\[routes\]\]/).slice(1)) {
    const target = parseTomlRouteTable(block.split(/\[\[/)[0]);
    if (target) routeTargets.push(target);
  }
  applyTomlRouteTargets(result, routeTargets);

  const env = extractEnvConfigsFromTOML(content);
  if (env) result.env = env;

  return result;
}

function extractEnvConfigsFromTOML(
  content: string,
): Record<string, WranglerEnvironmentConfig> | undefined {
  const result: Record<string, WranglerEnvironmentConfig> = {};

  for (const section of getTomlSections(content)) {
    const envName = section.header.match(/^env\.([^.]+)$/)?.[1];
    if (envName) {
      const envConfig = result[envName] ?? {};
      const nameMatch = section.body.match(/^name\s*=\s*"([^"]+)"/m);
      if (nameMatch) envConfig.name = nameMatch[1];
      const domain =
        extractTomlScalarRouteDomain(section.body) ?? extractTomlRoutesArrayDomain(section.body);
      if (domain) envConfig.customDomain = domain;
      if (envConfig.name || envConfig.customDomain) {
        result[envName] = envConfig;
      }
      continue;
    }

    const routesEnvName = section.header.match(/^env\.([^.]+)\.routes$/)?.[1];
    if (routesEnvName) {
      const envConfig = result[routesEnvName] ?? {};
      const domain = extractTomlRouteBlockDomain(section.body);
      if (domain) envConfig.customDomain = domain;
      if (envConfig.name || envConfig.customDomain) {
        result[routesEnvName] = envConfig;
      }
    }
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

function getTomlSections(content: string): Array<{ header: string; body: string }> {
  const sections: Array<{ header: string; body: string }> = [];
  let currentHeader: string | null = null;
  let currentBody: string[] = [];

  for (const line of content.split("\n")) {
    const header = parseTomlSectionHeader(line);
    if (header) {
      if (currentHeader) {
        sections.push({ header: currentHeader, body: currentBody.join("\n") });
      }
      currentHeader = header;
      currentBody = [];
    } else if (currentHeader) {
      currentBody.push(line);
    }
  }

  if (currentHeader) {
    sections.push({ header: currentHeader, body: currentBody.join("\n") });
  }

  return sections;
}

function parseTomlSectionHeader(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return null;
  const isArrayHeader = trimmed.startsWith("[[") && trimmed.endsWith("]]");
  const start = isArrayHeader ? 2 : 1;
  const end = isArrayHeader ? trimmed.length - 2 : trimmed.length - 1;
  const header = trimmed.slice(start, end).trim();
  return header.length > 0 ? header : null;
}

function extractTomlScalarRouteDomain(section: string): string | null {
  const routeMatch = section.match(/^route\s*=\s*"([^"]+)"/m);
  if (!routeMatch) return null;
  const domain = cleanDomain(routeMatch[1]);
  return domain && !domain.includes("workers.dev") ? domain : null;
}

function extractTomlRoutesArrayDomain(section: string): string | null {
  const routesMatch = section.match(/^routes\s*=\s*\[([\s\S]*?)\]/m);
  if (!routesMatch) return null;
  const patternMatch = (routesMatch[1] ?? "").match(/(?:pattern\s*=\s*)?"([^"]+)"/);
  if (!patternMatch) return null;
  const domain = cleanDomain(patternMatch[1]);
  return domain && !domain.includes("workers.dev") ? domain : null;
}

function extractTomlRouteBlockDomain(section: string): string | null {
  // `zone_name` identifies the enclosing zone, while `pattern` identifies
  // the hostname actually routed to this Worker. Prefer the latter when both
  // are present so traffic from sibling hostnames is not mixed together.
  const patternMatch =
    section.match(/^pattern\s*=\s*"([^"]+)"/m) ?? section.match(/^zone_name\s*=\s*"([^"]+)"/m);
  if (!patternMatch) return null;
  const domain = cleanDomain(patternMatch[1]);
  return domain && !domain.includes("workers.dev") ? domain : null;
}

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

type ResolvedZone = {
  id: string;
  accountId?: string;
};

type ZoneApiResponse = {
  success: boolean;
  result?: ResolvedZoneApiResult | ResolvedZoneApiResult[];
  errors?: Array<{ message?: string }>;
};

type ResolvedZoneApiResult = {
  id: string;
  account?: { id?: string };
};

async function requestZone(url: string, apiToken: string): Promise<ZoneApiResponse> {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Zone lookup failed: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as ZoneApiResponse;
  if (!data.success) {
    const detail = data.errors
      ?.map((error) => error.message)
      .filter(Boolean)
      .join("; ");
    throw new Error(`Zone lookup failed${detail ? `: ${detail}` : ""}`);
  }
  return data;
}

function resolvedZone(result: ResolvedZoneApiResult): ResolvedZone {
  return { id: result.id, accountId: result.account?.id };
}

async function resolveZoneByName(name: string, apiToken: string): Promise<ResolvedZone | null> {
  const data = await requestZone(
    `https://api.cloudflare.com/client/v4/zones?name=${encodeURIComponent(name)}`,
    apiToken,
  );
  const result = Array.isArray(data.result) ? data.result[0] : undefined;
  return result ? resolvedZone(result) : null;
}

async function resolveZoneById(id: string, apiToken: string): Promise<ResolvedZone | null> {
  const data = await requestZone(
    `https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(id)}`,
    apiToken,
  );
  const result = !Array.isArray(data.result) ? data.result : undefined;
  return result ? resolvedZone(result) : null;
}

/** Resolve zone ID from a domain name via the Cloudflare API. */
async function resolveZone(domain: string, apiToken: string): Promise<ResolvedZone | null> {
  // Prefer the longest matching zone when Wrangler did not provide an
  // explicit zone selector. DNS uses a delegated child zone over its parent.
  for (const candidate of domainCandidates(domain).reverse()) {
    const zone = await resolveZoneByName(candidate, apiToken);
    if (zone) return zone;
  }

  return null;
}

async function resolveConfiguredZone(
  config: WranglerConfig,
  apiToken: string,
): Promise<ResolvedZone | null> {
  if (config.routeZoneId) return resolveZoneById(config.routeZoneId, apiToken);
  if (config.routeZoneName) return resolveZoneByName(config.routeZoneName, apiToken);
  return config.customDomain ? resolveZone(config.customDomain, apiToken) : null;
}

/** Resolve zone ID from a domain name via the Cloudflare API. */
export async function resolveZoneId(domain: string, apiToken: string): Promise<string | null> {
  return (await resolveZone(domain, apiToken))?.id ?? null;
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
 * Query Cloudflare zone analytics for one hostname's top page paths by
 * request count over the given time window. The Groups dataset has no cursor
 * pagination, so the maximum 10,000-row window is used.
 */
export async function queryTraffic(
  zoneTag: string,
  apiToken: string,
  windowHours: number,
  hostname: string,
  pathLike?: string,
): Promise<TrafficEntry[]> {
  const now = new Date();
  const start = new Date(now.getTime() - windowHours * 60 * 60 * 1000);

  const pathVariableDeclaration = pathLike ? "\n    $pathLike: string!" : "";
  const pathFilter = pathLike ? "\n            clientRequestPath_like: $pathLike" : "";
  const query = `query TPRTraffic(
    $zoneTag: string!
    $start: Time!
    $end: Time!
    $hostname: string!${pathVariableDeclaration}
  ) {
    viewer {
      zones(filter: { zoneTag: $zoneTag }) {
        httpRequestsAdaptiveGroups(
          limit: 10000
          orderBy: [count_DESC]
          filter: {
            datetime_geq: $start
            datetime_lt: $end
            clientRequestHTTPHost: $hostname
            edgeResponseStatus_lt: 400${pathFilter}
            requestSource: "eyeball"
            AND: [
              { clientRequestPath_neq: "/api" }
              { clientRequestPath_notlike: "/api/%" }
              { clientRequestPath_neq: "/_next" }
              { clientRequestPath_notlike: "/_next/%" }
              { clientRequestPath_neq: "/__vinext" }
              { clientRequestPath_notlike: "/__vinext/%" }
              { clientRequestPath_notlike: "%.js" }
              { clientRequestPath_notlike: "%.css" }
              { clientRequestPath_notlike: "%.png" }
              { clientRequestPath_notlike: "%.jpg" }
              { clientRequestPath_notlike: "%.jpeg" }
              { clientRequestPath_notlike: "%.gif" }
              { clientRequestPath_notlike: "%.svg" }
              { clientRequestPath_notlike: "%.ico" }
              { clientRequestPath_notlike: "%.woff" }
              { clientRequestPath_notlike: "%.woff2" }
              { clientRequestPath_notlike: "%.ttf" }
              { clientRequestPath_notlike: "%.eot" }
              { clientRequestPath_notlike: "%.map" }
              { clientRequestPath_notlike: "%.webp" }
              { clientRequestPath_notlike: "%.avif" }
              { clientRequestPath_notlike: "%.rsc" }
            ]
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
        hostname,
        ...(pathLike ? { pathLike } : {}),
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
    if (e.path === "/api" || e.path.startsWith("/api/")) return false;
    // Internal routes
    if (
      e.path === "/_next" ||
      e.path.startsWith("/_next/") ||
      e.path === "/__vinext" ||
      e.path.startsWith("/__vinext/")
    )
      return false;
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
  if (wranglerConfig.unsupportedTrafficScope) {
    return skip(wranglerConfig.unsupportedTrafficScope);
  }
  if (!wranglerConfig.customDomain) {
    return skip("no custom domain — zone analytics unavailable");
  }

  // ── 4. Check for KV namespace ─────────────────────────────────
  if (!wranglerConfig.kvNamespaceId) {
    return skip("no VINEXT_KV_CACHE KV namespace configured");
  }

  // ── 5. Resolve zone and account IDs ───────────────────────────
  console.log(`  TPR: Analyzing traffic for ${wranglerConfig.customDomain} (last ${windowHours}h)`);

  let zone: ResolvedZone | null;
  try {
    zone = await resolveConfiguredZone(wranglerConfig, apiToken);
  } catch (err) {
    return skip(err instanceof Error ? err.message : `zone lookup failed: ${String(err)}`);
  }
  if (!zone) {
    return skip(`could not resolve zone for ${wranglerConfig.customDomain}`);
  }

  // If account_id is omitted, use the account that owns the resolved zone.
  // Selecting the first account visible to a multi-account token can point KV
  // uploads at a different account from the application.
  const accountId =
    wranglerConfig.accountId ?? zone.accountId ?? (await resolveAccountId(apiToken));
  if (!accountId) {
    return skip("could not resolve Cloudflare account ID");
  }

  // ── 6. Query traffic data ─────────────────────────────────────
  let traffic: TrafficEntry[];
  try {
    traffic = await queryTraffic(
      zone.id,
      apiToken,
      windowHours,
      wranglerConfig.customDomain,
      wranglerConfig.routePathLike,
    );
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
