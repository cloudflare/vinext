/**
 * Reads the narrow projection of wrangler.jsonc/.json/.toml that vinext's
 * deploy-time features consume: account and KV fields for TPR, cache/route/
 * environment/Worker-name/version-metadata fields for CDN warmup target
 * resolution. Deliberately partial: file parsing is delegated to Wrangler's
 * own reader (real TOML/JSONC grammar, not a hand-rolled subset), and
 * unknown fields are ignored rather than validated. Owned here so deploy
 * features depend on a config module instead of reaching into feature
 * modules like tpr.ts.
 */

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { isUnknownRecord } from "./utils/cache-control-metadata.js";

const require = createRequire(import.meta.url);
type ExperimentalReadRawConfig = (
  args: { config: string },
  options?: Record<string, never>,
) => { rawConfig: unknown };
let experimentalReadRawConfig: ExperimentalReadRawConfig | undefined;

function getExperimentalReadRawConfig(): ExperimentalReadRawConfig {
  // Loading Wrangler initializes its entire CLI runtime. Keep that cost off
  // deploy --help, ordinary deploys, and every other path that never reads a
  // Wrangler config while still delegating actual parsing to Wrangler.
  return (experimentalReadRawConfig ??= (
    require("wrangler") as {
      experimental_readRawConfig: ExperimentalReadRawConfig;
    }
  ).experimental_readRawConfig);
}

export type WranglerConfig = {
  accountId?: string;
  cache?: WranglerCacheConfig;
  kvNamespaceId?: string;
  customDomain?: string;
  warmupHosts?: readonly string[];
  hasUnwarmableRoute?: boolean;
  name?: string;
  legacyEnv?: boolean;
  targetEnvironment?: string;
  versionMetadataBinding?: string;
  workersDev?: boolean;
  env?: Record<string, WranglerEnvironmentConfig>;
};

type WranglerEnvironmentConfig = {
  cache?: WranglerCacheConfig;
  customDomain?: string;
  warmupHosts?: readonly string[];
  hasUnwarmableRoute?: boolean;
  /**
   * True when the env block itself contains any routing key (`route`,
   * `routes`, `custom_domains`), even one that yields no warmable host.
   * Wrangler resolves routes as inheritable keys, so an env that defines
   * none of them deploys with the top-level attachments — target resolution
   * falls back to the top-level routing fields exactly when this is false.
   */
  definesRoutes?: boolean;
  name?: string;
  versionMetadataBinding?: string;
  workersDev?: boolean;
};

export type WranglerCacheConfig = {
  enabled?: boolean;
  crossVersionCache?: boolean;
};

// ─── Wrangler Config Parsing ─────────────────────────────────────────────────

/**
 * Parse wrangler config (JSONC or TOML) to extract the fields used by TPR and
 * CDN warmup target resolution.
 */
export function parseWranglerConfig(root: string, configPath?: string): WranglerConfig | null {
  if (configPath) {
    const filepath = path.resolve(root, configPath);
    if (!fs.existsSync(filepath)) return null;
    const rawConfig = readRawWranglerConfig(filepath);
    return rawConfig && extractFromJSON(rawConfig);
  }

  for (const filename of ["wrangler.jsonc", "wrangler.json", "wrangler.toml"]) {
    const filepath = path.join(root, filename);
    if (!fs.existsSync(filepath)) continue;
    const rawConfig = readRawWranglerConfig(filepath);
    if (rawConfig) return extractFromJSON(rawConfig);
  }

  return null;
}

/**
 * Delegates to Wrangler's own config reader, which dispatches on file
 * extension to its real TOML or JSONC parser. Both formats resolve to the
 * same snake_case field shape (`account_id`, `kv_namespaces`, `routes`, ...),
 * so `extractFromJSON` below applies unchanged to either. A file that exists
 * but fails to parse (malformed syntax) degrades to null like a missing file,
 * matching the discovery loop's "try the next candidate" behavior above.
 */
function readRawWranglerConfig(filepath: string): Record<string, unknown> | null {
  try {
    return getExperimentalReadRawConfig()({ config: filepath }, {}).rawConfig as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }
}

function extractFromJSON(config: Record<string, unknown>): WranglerConfig {
  const result: WranglerConfig = {};

  const cache = extractCacheConfig(config.cache);
  if (cache) result.cache = cache;

  if (typeof config.name === "string" && config.name.length > 0) {
    result.name = config.name;
  }

  if (typeof config.legacy_env === "boolean") {
    result.legacyEnv = config.legacy_env;
  }

  if (typeof config.workers_dev === "boolean") {
    result.workersDev = config.workers_dev;
  }

  // Cloudflare's generated dist/server/wrangler.json is already flattened to
  // the environment selected at build time. Wrangler tags that redirected
  // config so deploy-time readers can distinguish it from a source config
  // that simply omitted the requested env block.
  if (typeof config.targetEnvironment === "string" && config.targetEnvironment.length > 0) {
    result.targetEnvironment = config.targetEnvironment;
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

  // TPR needs a zone-resolvable domain, while CDN warmup needs the exact route
  // host. Keep both because zone_name is not the hostname a request should use.
  const domain =
    extractDomainFromRoute(config.route) ??
    extractDomainFromRoutes(config.routes) ??
    extractDomainFromCustomDomains(config);
  if (domain) result.customDomain = domain;
  const warmupHosts = extractWarmupHosts(config);
  if (warmupHosts.length > 0) result.warmupHosts = warmupHosts;
  if (extractHasUnwarmableRoute(config)) result.hasUnwarmableRoute = true;
  const versionMetadataBinding = extractVersionMetadataBinding(config);
  if (versionMetadataBinding) result.versionMetadataBinding = versionMetadataBinding;

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
    if (
      envConfig.name ||
      envConfig.cache ||
      envConfig.customDomain ||
      envConfig.warmupHosts ||
      envConfig.definesRoutes ||
      envConfig.versionMetadataBinding ||
      envConfig.workersDev !== undefined
    ) {
      result[envName] = envConfig;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function extractEnvironmentConfig(config: Record<string, unknown>): WranglerEnvironmentConfig {
  const result: WranglerEnvironmentConfig = {};
  const cache = extractCacheConfig(config.cache);
  if (cache) result.cache = cache;
  if (typeof config.name === "string" && config.name.length > 0) {
    result.name = config.name;
  }
  if (typeof config.workers_dev === "boolean") {
    result.workersDev = config.workers_dev;
  }
  if ("route" in config || "routes" in config || "custom_domains" in config) {
    result.definesRoutes = true;
  }
  const domain =
    extractDomainFromRoute(config.route) ??
    extractDomainFromRoutes(config.routes) ??
    extractDomainFromCustomDomains(config);
  if (domain) result.customDomain = domain;
  const warmupHosts = extractWarmupHosts(config);
  if (warmupHosts.length > 0) result.warmupHosts = warmupHosts;
  if (extractHasUnwarmableRoute(config)) result.hasUnwarmableRoute = true;
  const versionMetadataBinding = extractVersionMetadataBinding(config);
  if (versionMetadataBinding) result.versionMetadataBinding = versionMetadataBinding;
  return result;
}

function extractCacheConfig(value: unknown): WranglerCacheConfig | null {
  if (!isUnknownRecord(value)) return null;
  const enabled = typeof value.enabled === "boolean" ? value.enabled : undefined;
  const crossVersionCache =
    typeof value.cross_version_cache === "boolean" ? value.cross_version_cache : undefined;
  return enabled === undefined && crossVersionCache === undefined
    ? null
    : { enabled, crossVersionCache };
}

function extractVersionMetadataBinding(config: Record<string, unknown>): string | null {
  const metadata = config.version_metadata;
  return isUnknownRecord(metadata) &&
    typeof metadata.binding === "string" &&
    metadata.binding.length > 0
    ? metadata.binding
    : null;
}

function extractDomainFromRoute(route: unknown): string | null {
  if (isUnknownRecord(route) && route.enabled === false) return null;
  if (typeof route === "string") {
    const domain = cleanDomain(route);
    return domain && !domain.includes("workers.dev") ? domain : null;
  }
  if (!isUnknownRecord(route)) return null;
  const domainSource =
    typeof route.zone_name === "string"
      ? route.zone_name
      : typeof route.pattern === "string"
        ? route.pattern
        : null;
  if (!domainSource) return null;
  const domain = cleanDomain(domainSource);
  return domain && !domain.includes("workers.dev") ? domain : null;
}

function extractDomainFromRoutes(routes: unknown): string | null {
  if (!Array.isArray(routes)) return null;
  return firstMatch(routes, extractDomainFromRoute);
}

/**
 * Every eligible host-wide origin, not only the first. The hostname is part of
 * Cloudflare's cache key, so each attached host owns its own cache partition:
 * a deployment with several routes or Custom Domains is only warm once every
 * one of those origins has been warmed.
 */
function extractWarmupHosts(config: Record<string, unknown>): string[] {
  const hosts: string[] = [];
  const singular = extractWarmupHostFromRoute(config.route);
  if (singular) hosts.push(singular);
  if (Array.isArray(config.routes)) {
    hosts.push(...collectMatches(config.routes, extractWarmupHostFromRoute));
  }
  if (Array.isArray(config.custom_domains)) {
    hosts.push(
      ...collectMatches(config.custom_domains, (domain) =>
        typeof domain === "string" ? routePatternToWarmupHost(domain) : null,
      ),
    );
  }
  return dedupeHosts(hosts);
}

/** A host attached both as a route and a Custom Domain is still one cache-key origin. */
function dedupeHosts(hosts: readonly string[]): string[] {
  return [...new Set(hosts)];
}

/**
 * True when any enabled production attachment cannot be reduced to a concrete
 * host-wide origin (path-scoped or wildcard-host patterns). Such a route's
 * cache partition is unreachable to warmup, so its presence must veto any
 * "confirmed warm" claim even when every concrete origin succeeds.
 */
function extractHasUnwarmableRoute(config: Record<string, unknown>): boolean {
  if (isUnwarmableRoute(config.route)) return true;
  if (Array.isArray(config.routes) && config.routes.some(isUnwarmableRoute)) return true;
  return (
    Array.isArray(config.custom_domains) &&
    config.custom_domains.some(
      (domain) => typeof domain === "string" && patternIsUnwarmable(domain),
    )
  );
}

function isUnwarmableRoute(route: unknown): boolean {
  if (isUnknownRecord(route) && route.enabled === false) return false;
  const pattern = typeof route === "string" ? route : isUnknownRecord(route) ? route.pattern : null;
  return typeof pattern === "string" && patternIsUnwarmable(pattern);
}

/** The pattern attaches production traffic but yields no warmable host-wide origin. */
function patternIsUnwarmable(pattern: string): boolean {
  const host = cleanDomain(pattern);
  if (!host || host.includes("workers.dev")) return false;
  return routePatternToWarmupHost(pattern) === null;
}

/**
 * A route array can mix host-wide and path-scoped (or workers.dev) entries;
 * a disqualified earlier entry must not hide a valid later one. Returns the
 * first non-null result of `fn`, or null if none qualify.
 */
function firstMatch<T, R>(items: Iterable<T>, fn: (item: T) => R | null): R | null {
  for (const item of items) {
    const result = fn(item);
    if (result !== null) return result;
  }
  return null;
}

/** Every non-null result of `fn`, preserving input order. */
function collectMatches<T, R>(items: Iterable<T>, fn: (item: T) => R | null): R[] {
  const results: R[] = [];
  for (const item of items) {
    const result = fn(item);
    if (result !== null) results.push(result);
  }
  return results;
}

function extractWarmupHostFromRoute(route: unknown): string | null {
  if (isUnknownRecord(route) && route.enabled === false) return null;
  const pattern = typeof route === "string" ? route : isUnknownRecord(route) ? route.pattern : null;
  return typeof pattern === "string" ? routePatternToWarmupHost(pattern) : null;
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

function routePatternToWarmupHost(pattern: string): string | null {
  const withoutProtocol = pattern.replace(/^https?:\/\//, "");
  const pathStart = withoutProtocol.indexOf("/");
  const routePath = pathStart === -1 ? "" : withoutProtocol.slice(pathStart);
  if (routePath !== "" && routePath !== "/*") return null;
  const host = cleanDomain(pattern);
  return host && !host.includes("*") && !host.includes("workers.dev") ? host : null;
}
