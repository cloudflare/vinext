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

type WranglerConfig = {
  accountId?: string;
  cache?: WranglerCacheConfig;
  kvNamespaceId?: string;
  customDomain?: string;
  name?: string;
  legacyEnv?: boolean;
  targetEnvironment?: string;
  userConfigPath?: string;
  versionMetadataBinding?: string;
  env?: Record<string, WranglerEnvironmentConfig>;
};

export type WranglerEnvironmentConfig = {
  cache?: WranglerCacheConfig;
  customDomain?: string;
  name?: string;
  versionMetadataBinding?: string;
};

export type WranglerCacheConfig = {
  crossVersionCache?: boolean;
  enabled?: boolean;
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
  // Wrangler accepts UTF-8 BOM-prefixed JSON/JSONC configs. Keep this
  // preflight parser aligned so a valid config cannot bypass deploy guards.
  const source = str.charCodeAt(0) === 0xfeff ? str.slice(1) : str;
  let result = "";
  let inString = false;
  let inSingleLine = false;
  let inMultiLine = false;
  let escapeNext = false;

  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];

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

    if (!inString && ch === "," && isJsonTrailingComma(source, i + 1)) {
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

  if (typeof config.targetEnvironment === "string" && config.targetEnvironment.length > 0) {
    result.targetEnvironment = config.targetEnvironment;
  }

  if (typeof config.userConfigPath === "string" && config.userConfigPath.length > 0) {
    result.userConfigPath = config.userConfigPath;
  }

  // account_id
  if (typeof config.account_id === "string") {
    result.accountId = config.account_id;
  }

  const cache = extractCacheConfig(config.cache);
  if (cache) result.cache = cache;
  const versionMetadataBinding = extractVersionMetadataBinding(config.version_metadata);
  if (versionMetadataBinding) result.versionMetadataBinding = versionMetadataBinding;

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

  // Custom domain — check singular route, routes[], and custom_domains[].
  const domain =
    extractDomainFromRoute(config.route) ??
    extractDomainFromRoutes(config.routes) ??
    extractDomainFromCustomDomains(config);
  if (domain) result.customDomain = domain;

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
      envConfig.customDomain ||
      envConfig.cache ||
      envConfig.versionMetadataBinding
    ) {
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
    extractDomainFromRoute(config.route) ??
    extractDomainFromRoutes(config.routes) ??
    extractDomainFromCustomDomains(config);
  if (domain) result.customDomain = domain;
  const cache = extractCacheConfig(config.cache);
  if (cache) result.cache = cache;
  const versionMetadataBinding = extractVersionMetadataBinding(config.version_metadata);
  if (versionMetadataBinding) result.versionMetadataBinding = versionMetadataBinding;
  return result;
}

function extractVersionMetadataBinding(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const binding = (value as Record<string, unknown>).binding;
  return typeof binding === "string" && binding.length > 0 ? binding : undefined;
}

function extractCacheConfig(value: unknown): WranglerCacheConfig | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const result: WranglerCacheConfig = {};
  if (typeof raw.enabled === "boolean") result.enabled = raw.enabled;
  if (typeof raw.cross_version_cache === "boolean") {
    result.crossVersionCache = raw.cross_version_cache;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function extractDomainFromRoutes(routes: unknown): string | null {
  if (!Array.isArray(routes)) return null;

  for (const route of routes) {
    const domain = extractDomainFromRoute(route);
    if (domain) return domain;
  }
  return null;
}

function extractDomainFromRoute(route: unknown): string | null {
  const pattern =
    typeof route === "string"
      ? route
      : route &&
          typeof route === "object" &&
          typeof (route as Record<string, unknown>).pattern === "string"
        ? ((route as Record<string, unknown>).pattern as string)
        : null;
  if (!pattern) return null;
  const domain = cleanDomain(pattern);
  return domain && !domain.includes("workers.dev") ? domain : null;
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
  return cleaned && !cleaned.includes("*") ? cleaned : null;
}

/**
 * Simple extraction of specific fields from wrangler.toml content.
 * Not a full TOML parser — just enough for the fields we need.
 */
function extractFromTOML(content: string): WranglerConfig {
  const result: WranglerConfig = {};
  const rootBody = getTomlRootBody(content);

  const name = findTomlStringAssignment(rootBody, "name");
  if (name) result.name = name;

  const legacyEnvAssignment = parseTomlAssignments(rootBody).find(
    (assignment) => assignment.keyPath.length === 1 && assignment.keyPath[0] === "legacy_env",
  );
  if (legacyEnvAssignment && /^(?:true|false)$/.test(legacyEnvAssignment.value.trim())) {
    result.legacyEnv = legacyEnvAssignment.value.trim() === "true";
  }

  // account_id = "..."
  const accountId = findTomlStringAssignment(rootBody, "account_id");
  if (accountId) result.accountId = accountId;

  // KV namespace with binding = "VINEXT_KV_CACHE"
  // Look for [[kv_namespaces]] blocks
  const kvBlocks = content.split(/\[\[kv_namespaces\]\]/);
  for (let i = 1; i < kvBlocks.length; i++) {
    const block = kvBlocks[i].split(/\[\[/)[0]; // Take until next section
    const binding = findTomlStringAssignment(block, "binding");
    const id = findTomlStringAssignment(block, "id");
    if (
      (binding === "VINEXT_KV_CACHE" || binding === "VINEXT_CACHE") &&
      id &&
      id !== "<your-kv-namespace-id>"
    ) {
      result.kvNamespaceId = id;
    }
  }

  // Root routes only. Environment sections must not become the production
  // warmup origin.
  result.customDomain =
    extractTomlRouteDomain(rootBody) ?? extractTomlRoutesArrayDomain(rootBody) ?? undefined;

  // [[routes]] blocks
  if (!result.customDomain) {
    for (const section of getTomlSections(content)) {
      if (section.header !== "route" && section.header !== "routes") continue;
      const domain = extractTomlRouteBlockDomain(section.body);
      if (domain) {
        result.customDomain = domain;
        break;
      }
    }
  }

  const env = extractEnvConfigsFromTOML(content);
  if (env) result.env = env;

  const versionMetadataSection = getTomlSections(content).find((section) =>
    isTomlSectionPath(section.header, "version_metadata"),
  );
  const inlineVersionMetadata = extractTomlInlineTable(rootBody, "version_metadata");
  const versionMetadataBinding = versionMetadataSection
    ? extractTomlVersionMetadataBinding(versionMetadataSection.body)
    : inlineVersionMetadata
      ? extractTomlVersionMetadataBinding(inlineVersionMetadata)
      : extractTomlDottedVersionMetadataBinding(rootBody);
  if (versionMetadataBinding) result.versionMetadataBinding = versionMetadataBinding;

  const cacheSection = getTomlSections(content).find((section) =>
    isTomlSectionPath(section.header, "cache"),
  );
  const inlineCache = extractTomlInlineTable(rootBody, "cache");
  const cache = cacheSection
    ? extractTomlCacheConfig(cacheSection.body)
    : inlineCache
      ? extractTomlCacheConfig(inlineCache)
      : extractTomlDottedCacheConfig(rootBody);
  if (cache) result.cache = cache;

  // This reader intentionally extracts only the small Wrangler subset used by
  // deploy. If a valid TOML shape is newer or more exotic than the forms above,
  // fail closed: a false positive merely postpones warming until promotion,
  // while a false negative can write old content into a cross-version cache.
  if (!result.cache?.crossVersionCache && /\bcross_version_cache\s*=\s*true\b/.test(rootBody)) {
    result.cache = { ...result.cache, crossVersionCache: true };
  }

  return result;
}

function applyTomlEnvironmentAssignment(
  result: Record<string, WranglerEnvironmentConfig>,
  envName: string,
  fieldPath: string[],
  value: string,
): void {
  const envConfig = result[envName] ?? {};
  let changed = false;

  if (fieldPath.length === 0) {
    const inlineEnv = unwrapTomlInlineTable(value);
    if (inlineEnv) {
      const name = findTomlStringAssignment(inlineEnv, "name");
      const customDomain =
        extractTomlRouteDomain(inlineEnv) ?? extractTomlRoutesArrayDomain(inlineEnv) ?? undefined;
      const inlineCache = extractTomlInlineTable(inlineEnv, "cache");
      const cache = inlineCache ? extractTomlCacheConfig(inlineCache) : undefined;
      const inlineVersionMetadata = extractTomlInlineTable(inlineEnv, "version_metadata");
      const versionMetadataBinding = inlineVersionMetadata
        ? extractTomlVersionMetadataBinding(inlineVersionMetadata)
        : undefined;
      if (name) envConfig.name = name;
      if (customDomain) envConfig.customDomain = customDomain;
      if (cache) envConfig.cache = { ...envConfig.cache, ...cache };
      if (versionMetadataBinding) envConfig.versionMetadataBinding = versionMetadataBinding;
      changed = Boolean(name || customDomain || cache || versionMetadataBinding);
    }
  } else if (fieldPath.length === 1 && fieldPath[0] === "name") {
    const name = parseTomlString(value);
    if (name) {
      envConfig.name = name;
      changed = true;
    }
  } else if (fieldPath.length === 1 && (fieldPath[0] === "route" || fieldPath[0] === "routes")) {
    const customDomain =
      fieldPath[0] === "route"
        ? extractTomlRouteDomain(`route = ${value}`)
        : extractTomlRoutesArrayDomain(`routes = ${value}`);
    if (customDomain) {
      envConfig.customDomain = customDomain;
      changed = true;
    }
  } else if (fieldPath.length === 1 && fieldPath[0] === "cache") {
    const inlineCache = unwrapTomlInlineTable(value);
    const cache = inlineCache ? extractTomlCacheConfig(inlineCache) : undefined;
    if (cache) {
      envConfig.cache = { ...envConfig.cache, ...cache };
      changed = true;
    }
  } else if (
    fieldPath.length === 2 &&
    fieldPath[0] === "cache" &&
    (fieldPath[1] === "enabled" || fieldPath[1] === "cross_version_cache")
  ) {
    const booleanValue = value.trim();
    if (/^(?:true|false)$/.test(booleanValue)) {
      envConfig.cache = {
        ...envConfig.cache,
        ...(fieldPath[1] === "enabled" ? { enabled: booleanValue === "true" } : {}),
        ...(fieldPath[1] === "cross_version_cache"
          ? { crossVersionCache: booleanValue === "true" }
          : {}),
      };
      changed = true;
    }
  } else if (fieldPath.length === 1 && fieldPath[0] === "version_metadata") {
    const inlineVersionMetadata = unwrapTomlInlineTable(value);
    const binding = inlineVersionMetadata
      ? extractTomlVersionMetadataBinding(inlineVersionMetadata)
      : undefined;
    if (binding) {
      envConfig.versionMetadataBinding = binding;
      changed = true;
    }
  } else if (
    fieldPath.length === 2 &&
    fieldPath[0] === "version_metadata" &&
    fieldPath[1] === "binding"
  ) {
    const binding = parseTomlString(value);
    if (binding) {
      envConfig.versionMetadataBinding = binding;
      changed = true;
    }
  }

  if (changed) result[envName] = envConfig;
}

function extractEnvConfigsFromTOML(
  content: string,
): Record<string, WranglerEnvironmentConfig> | undefined {
  const result: Record<string, WranglerEnvironmentConfig> = {};

  // TOML dotted keys can declare named environments without an `[env]`
  // table, for example `env."staging.eu".name = "worker"`.
  for (const assignment of parseTomlAssignments(getTomlRootBody(content))) {
    if (assignment.keyPath[0] !== "env" || assignment.keyPath.length < 2) continue;
    const envName = assignment.keyPath[1];
    if (!envName) continue;
    applyTomlEnvironmentAssignment(result, envName, assignment.keyPath.slice(2), assignment.value);
  }

  for (const section of getTomlSections(content)) {
    const headerPath = parseTomlDottedKey(section.header);
    const envName = headerPath.length === 2 && headerPath[0] === "env" ? headerPath[1] : undefined;
    if (envName) {
      const envConfig = result[envName] ?? {};
      const name = findTomlStringAssignment(section.body, "name");
      if (name) envConfig.name = name;
      const domain =
        extractTomlRouteDomain(section.body) ?? extractTomlRoutesArrayDomain(section.body);
      if (domain) envConfig.customDomain = domain;
      const inlineCache = extractTomlInlineTable(section.body, "cache");
      const cache = inlineCache
        ? extractTomlCacheConfig(inlineCache)
        : extractTomlDottedCacheConfig(section.body);
      if (cache) envConfig.cache = cache;
      const inlineVersionMetadata = extractTomlInlineTable(section.body, "version_metadata");
      envConfig.versionMetadataBinding = inlineVersionMetadata
        ? extractTomlVersionMetadataBinding(inlineVersionMetadata)
        : extractTomlDottedVersionMetadataBinding(section.body);
      if (
        envConfig.name ||
        envConfig.customDomain ||
        envConfig.cache ||
        envConfig.versionMetadataBinding
      ) {
        result[envName] = envConfig;
      }
      continue;
    }

    const routesEnvName =
      headerPath.length === 3 &&
      headerPath[0] === "env" &&
      (headerPath[2] === "route" || headerPath[2] === "routes")
        ? headerPath[1]
        : undefined;
    if (routesEnvName) {
      const envConfig = result[routesEnvName] ?? {};
      const domain = extractTomlRouteBlockDomain(section.body);
      if (domain) envConfig.customDomain = domain;
      if (envConfig.name || envConfig.customDomain) {
        result[routesEnvName] = envConfig;
      }
    }

    const cacheEnvName =
      headerPath.length === 3 && headerPath[0] === "env" && headerPath[2] === "cache"
        ? headerPath[1]
        : undefined;
    if (cacheEnvName) {
      const envConfig = result[cacheEnvName] ?? {};
      const cache = extractTomlCacheConfig(section.body);
      if (cache) envConfig.cache = cache;
      if (envConfig.name || envConfig.customDomain || envConfig.cache) {
        result[cacheEnvName] = envConfig;
      }
    }

    const versionMetadataEnvName =
      headerPath.length === 3 && headerPath[0] === "env" && headerPath[2] === "version_metadata"
        ? headerPath[1]
        : undefined;
    if (versionMetadataEnvName) {
      const envConfig = result[versionMetadataEnvName] ?? {};
      envConfig.versionMetadataBinding = extractTomlVersionMetadataBinding(section.body);
      if (envConfig.versionMetadataBinding) result[versionMetadataEnvName] = envConfig;
    }

    if (headerPath.length === 1 && headerPath[0] === "env") {
      for (const assignment of parseTomlAssignments(section.body)) {
        const assignmentPath = assignment.keyPath;
        if (
          assignmentPath.length === 3 &&
          assignmentPath[1] === "cache" &&
          (assignmentPath[2] === "enabled" || assignmentPath[2] === "cross_version_cache")
        ) {
          const value = assignment.value.trim();
          if (/^(?:true|false)$/.test(value)) {
            const envName = assignmentPath[0]!;
            const envConfig = result[envName] ?? {};
            envConfig.cache = {
              ...envConfig.cache,
              ...(assignmentPath[2] === "enabled" ? { enabled: value === "true" } : {}),
              ...(assignmentPath[2] === "cross_version_cache"
                ? { crossVersionCache: value === "true" }
                : {}),
            };
            result[envName] = envConfig;
          }
          continue;
        }
        if (
          assignmentPath.length === 3 &&
          assignmentPath[1] === "version_metadata" &&
          assignmentPath[2] === "binding"
        ) {
          const binding = parseTomlString(assignment.value);
          if (binding) {
            const envName = assignmentPath[0]!;
            result[envName] = {
              ...result[envName],
              versionMetadataBinding: binding,
            };
          }
          continue;
        }
        const inlineEnv = unwrapTomlInlineTable(assignment.value);
        if (!inlineEnv) continue;
        const inlineCache = extractTomlInlineTable(inlineEnv, "cache");
        const cache = inlineCache ? extractTomlCacheConfig(inlineCache) : undefined;
        const inlineVersionMetadata = extractTomlInlineTable(inlineEnv, "version_metadata");
        const versionMetadataBinding = inlineVersionMetadata
          ? extractTomlVersionMetadataBinding(inlineVersionMetadata)
          : undefined;
        const nameAssignment = parseTomlAssignments(inlineEnv).find(
          (candidate) => candidate.key === "name",
        );
        const name = nameAssignment ? parseTomlString(nameAssignment.value) : null;
        const customDomain =
          extractTomlRouteDomain(inlineEnv) ?? extractTomlRoutesArrayDomain(inlineEnv) ?? undefined;
        if (!name && !customDomain && !cache && !versionMetadataBinding) continue;
        const envName = assignmentPath[0]!;
        result[envName] = {
          ...result[envName],
          ...(name ? { name } : {}),
          ...(customDomain ? { customDomain } : {}),
          ...(cache ? { cache } : {}),
          ...(versionMetadataBinding ? { versionMetadataBinding } : {}),
        };
      }
    }
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

function extractTomlVersionMetadataBinding(section: string): string | undefined {
  for (const assignment of parseTomlAssignments(section)) {
    if (assignment.key !== "binding") continue;
    const value = parseTomlString(assignment.value);
    if (value) return value;
  }
  return undefined;
}

function extractTomlDottedVersionMetadataBinding(section: string): string | undefined {
  const assignment = parseTomlAssignments(section).find(
    (candidate) => candidate.key === "version_metadata.binding",
  );
  return assignment ? (parseTomlString(assignment.value) ?? undefined) : undefined;
}

function extractTomlCacheConfig(section: string): WranglerCacheConfig | undefined {
  const result: WranglerCacheConfig = {};
  for (const assignment of parseTomlAssignments(section)) {
    const value = assignment.value.trim();
    if (assignment.key === "enabled" && /^(?:true|false)$/.test(value)) {
      result.enabled = value === "true";
    }
    if (assignment.key === "cross_version_cache" && /^(?:true|false)$/.test(value)) {
      result.crossVersionCache = value === "true";
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function extractTomlDottedCacheConfig(section: string): WranglerCacheConfig | undefined {
  const result: WranglerCacheConfig = {};
  for (const assignment of parseTomlAssignments(section)) {
    const value = assignment.value.trim();
    if (assignment.key === "cache.enabled" && /^(?:true|false)$/.test(value)) {
      result.enabled = value === "true";
    }
    if (assignment.key === "cache.cross_version_cache" && /^(?:true|false)$/.test(value)) {
      result.crossVersionCache = value === "true";
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function getTomlRootBody(content: string): string {
  const rootLines: string[] = [];
  for (const line of content.split("\n")) {
    if (parseTomlSectionHeader(line)) break;
    rootLines.push(line);
  }
  return rootLines.join("\n");
}

function parseTomlDottedKey(value: string): string[] {
  const result: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (const character of value.trim()) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (quote === '"' && character === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      else current += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
    } else if (character === ".") {
      result.push(current.trim());
      current = "";
    } else {
      current += character;
    }
  }
  result.push(current.trim());
  return result.filter(Boolean);
}

function isTomlSectionPath(header: string, ...expected: string[]): boolean {
  const path = parseTomlDottedKey(header);
  return path.length === expected.length && path.every((part, index) => part === expected[index]);
}

function parseTomlAssignments(
  source: string,
): Array<{ key: string; keyPath: string[]; value: string }> {
  const statements: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let escaped = false;
  let comment = false;
  let depth = 0;

  for (const character of source) {
    if (comment) {
      if (character === "\n") {
        comment = false;
        if (depth === 0 && current.trim()) {
          statements.push(current.trim());
          current = "";
        }
      }
      continue;
    }
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (quote === '"' && character === "\\") {
      current += character;
      escaped = true;
      continue;
    }
    if (quote) {
      current += character;
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      current += character;
      continue;
    }
    if (character === "#") {
      comment = true;
      continue;
    }
    if (character === "{" || character === "[") depth++;
    if (character === "}" || character === "]") depth = Math.max(0, depth - 1);
    if ((character === "\n" || character === ",") && depth === 0) {
      if (current.trim()) statements.push(current.trim());
      current = "";
      continue;
    }
    current += character;
  }
  if (current.trim()) statements.push(current.trim());

  return statements.flatMap((statement) => {
    const equals = statement.indexOf("=");
    if (equals === -1) return [];
    const keyPath = parseTomlDottedKey(statement.slice(0, equals));
    const key = keyPath.length > 0 ? keyPath.join(".") : null;
    const value = statement.slice(equals + 1).trim();
    return key && value ? [{ key, keyPath, value }] : [];
  });
}

function unwrapTomlInlineTable(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.startsWith("{") && trimmed.endsWith("}") ? trimmed.slice(1, -1) : null;
}

function parseTomlString(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length < 2) return null;
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }
  if (!trimmed.startsWith('"') || !trimmed.endsWith('"')) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return typeof parsed === "string" ? parsed : null;
  } catch {
    return null;
  }
}

function findTomlStringAssignment(source: string, key: string): string | null {
  const assignment = parseTomlAssignments(source).find((candidate) => candidate.key === key);
  return assignment ? parseTomlString(assignment.value) : null;
}

function extractTomlInlineTable(source: string, key: string): string | null {
  const assignment = parseTomlAssignments(source).find((candidate) => candidate.key === key);
  return assignment ? unwrapTomlInlineTable(assignment.value) : null;
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
  if (!trimmed.startsWith("[")) return null;
  const isArrayHeader = trimmed.startsWith("[[");
  const start = isArrayHeader ? 2 : 1;
  const closing = isArrayHeader ? "]]" : "]";
  const end = trimmed.indexOf(closing, start);
  if (end === -1 || !/^\s*(?:#.*)?$/.test(trimmed.slice(end + closing.length))) return null;
  const header = trimmed.slice(start, end).trim();
  return header.length > 0 ? header : null;
}

function extractTomlRouteDomain(section: string): string | null {
  const assignment = parseTomlAssignments(section).find((candidate) => candidate.key === "route");
  if (!assignment) return null;
  const scalar = parseTomlString(assignment.value);
  const inline = unwrapTomlInlineTable(assignment.value);
  const pattern = scalar ?? (inline ? findTomlStringAssignment(inline, "pattern") : null);
  if (!pattern) return null;
  const domain = cleanDomain(pattern);
  return domain && !domain.includes("workers.dev") ? domain : null;
}

function extractTomlRoutesArrayDomain(section: string): string | null {
  const assignment = parseTomlAssignments(section).find((candidate) => candidate.key === "routes");
  if (!assignment) return null;
  const value = assignment.value.trim();
  if (!value.startsWith("[") || !value.endsWith("]")) return null;
  for (const item of splitTomlTopLevelItems(value.slice(1, -1))) {
    const inline = unwrapTomlInlineTable(item);
    const pattern = inline
      ? (findTomlStringAssignment(inline, "pattern") ??
        findTomlStringAssignment(inline, "zone_name"))
      : parseTomlString(item);
    if (!pattern) continue;
    const domain = cleanDomain(pattern);
    if (domain && !domain.includes("workers.dev")) return domain;
  }
  return null;
}

function extractTomlRouteBlockDomain(section: string): string | null {
  const pattern =
    findTomlStringAssignment(section, "pattern") ?? findTomlStringAssignment(section, "zone_name");
  if (!pattern) return null;
  const domain = cleanDomain(pattern);
  return domain && !domain.includes("workers.dev") ? domain : null;
}

function splitTomlTopLevelItems(source: string): string[] {
  const items: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let escaped = false;
  let depth = 0;
  for (const character of source) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (quote === '"' && character === "\\") {
      current += character;
      escaped = true;
      continue;
    }
    if (quote) {
      current += character;
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      current += character;
      continue;
    }
    if (character === "{" || character === "[") depth++;
    if (character === "}" || character === "]") depth = Math.max(0, depth - 1);
    if (character === "," && depth === 0) {
      if (current.trim()) items.push(current.trim());
      current = "";
      continue;
    }
    current += character;
  }
  if (current.trim()) items.push(current.trim());
  return items;
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
