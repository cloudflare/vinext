/** Narrow Wrangler config projection shared by deploy-time features. */

import fs from "node:fs";
import path from "node:path";

type WranglerConfig = {
  accountId?: string;
  kvNamespaceId?: string;
  customDomain?: string;
  name?: string;
  legacyEnv?: boolean;
  env?: Record<string, WranglerEnvironmentConfig>;
};

type WranglerEnvironmentConfig = {
  customDomain?: string;
  name?: string;
};

// ─── Wrangler Config Parsing ─────────────────────────────────────────────────

/**
 * Parse the Wrangler fields used by TPR and staged CDN warming.
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

  if (typeof config.account_id === "string") {
    result.accountId = config.account_id;
  }

  if (Array.isArray(config.kv_namespaces)) {
    const namespace = config.kv_namespaces.find(
      (value: Record<string, unknown>) =>
        value &&
        typeof value === "object" &&
        (value.binding === "VINEXT_KV_CACHE" || value.binding === "VINEXT_CACHE"),
    );
    if (
      namespace &&
      typeof namespace.id === "string" &&
      namespace.id !== "<your-kv-namespace-id>"
    ) {
      result.kvNamespaceId = namespace.id;
    }
  }

  // Custom domain — check routes[] and custom_domains[]
  const domain = extractDomainFromRoutes(config.routes) ?? extractDomainFromCustomDomains(config);
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

  const nameMatch = content.match(/^name\s*=\s*"([^"]+)"/m);
  if (nameMatch) result.name = nameMatch[1];

  const legacyEnvMatch = content.match(/^legacy_env\s*=\s*(true|false)\s*$/m);
  if (legacyEnvMatch) result.legacyEnv = legacyEnvMatch[1] === "true";

  const accountMatch = content.match(/^account_id\s*=\s*"([^"]+)"/m);
  if (accountMatch) result.accountId = accountMatch[1];

  for (const block of content.split(/\[\[kv_namespaces\]\]/).slice(1)) {
    const section = block.split(/\[\[/)[0];
    const binding = section.match(/binding\s*=\s*"([^"]+)"/)?.[1];
    const id = section.match(/\bid\s*=\s*"([^"]+)"/)?.[1];
    if (
      (binding === "VINEXT_KV_CACHE" || binding === "VINEXT_CACHE") &&
      id &&
      id !== "<your-kv-namespace-id>"
    ) {
      result.kvNamespaceId = id;
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
  const patternMatch =
    section.match(/^pattern\s*=\s*"([^"]+)"/m) ?? section.match(/^zone_name\s*=\s*"([^"]+)"/m);
  if (!patternMatch) return null;
  const domain = cleanDomain(patternMatch[1]);
  return domain && !domain.includes("workers.dev") ? domain : null;
}
