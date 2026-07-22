import fs from "node:fs";
import path from "node:path";
import type { VinextCacheConfig } from "vinext/internal/cache-adapters";
import { findViteConfigPath } from "vinext/internal/utils/project";
import {
  DEFAULT_KV_DATA_CACHE_BINDING,
  type KvDataAdapterOptions,
} from "./cache/kv-data-adapter.js";

function escapeRegExp(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

/**
 * Check whether an existing vite.config file already imports and uses the
 * Cloudflare Vite plugin. This is a heuristic text scan — it doesn't execute
 * the config — so it may produce false negatives for unusual configurations.
 *
 * Returns true when the config both imports the package and invokes
 * `cloudflare(...)` in the plugin list.
 */
export function viteConfigHasCloudflarePlugin(root: string): boolean {
  const configPath = findViteConfigPath(root);
  if (!configPath) return false;

  try {
    const content = fs
      .readFileSync(configPath, "utf-8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    const requireBinding = content.match(
      /(?:const|let|var)\s*{([^}]*)}\s*=\s*require\s*\(\s*["']@cloudflare\/vite-plugin["']\s*\)/,
    )?.[1];
    if (requireBinding) {
      const requireMatch = requireBinding.match(
        /(?:^|,)\s*cloudflare\s*(?::\s*([A-Za-z_$][\w$]*))?\s*(?:,|$)/,
      );
      if (requireMatch) {
        const binding = requireMatch[1] ?? "cloudflare";
        return new RegExp(`\\b${escapeRegExp(binding)}\\s*\\(`).test(content);
      }
    }
    const namedImports = content.match(
      /import\s*{([^}]*)}\s*from\s*["']@cloudflare\/vite-plugin["']/,
    )?.[1];
    if (!namedImports) return false;
    const importMatch = namedImports.match(
      /(?:^|,)\s*cloudflare\s*(?:as\s+([A-Za-z_$][\w$]*))?\s*(?:,|$)/,
    );
    if (!importMatch) return false;
    const binding = importMatch[1] ?? "cloudflare";
    return new RegExp(`\\b${escapeRegExp(binding)}\\s*\\(`).test(content);
  } catch {
    return false;
  }
}

/**
 * Extract the object-literal text of the `cache:` key (the `{ ... }` passed as
 * `vinext({ cache })`) from a Vite config source, via brace matching. Returns
 * null if there is no `cache:` object literal.
 */
function extractCacheBlock(content: string): string | null {
  const m = /\bcache\s*:\s*\{/.exec(content);
  if (!m) return null;
  const open = m.index + m[0].length - 1; // index of the `{`
  let depth = 0;
  for (let i = open; i < content.length; i++) {
    const ch = content[i];
    if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return content.slice(open, i + 1);
  }
  return null;
}

/**
 * Whether a `cdn` / `data` field inside the cache object is assigned a real
 * value (not absent, `undefined`, or `null`). Reads the value up to the next
 * comma / closing brace / newline, which is enough to tell an assignment like
 * `data: kvDataAdapter()` from `data: undefined`.
 */
function cacheFieldAssigned(cacheBlock: string, field: "cdn" | "data"): boolean {
  const m = new RegExp(`\\b${field}\\s*:\\s*([^,}\\n]+)`).exec(cacheBlock);
  if (!m) return false;
  const value = m[1].trim();
  return value.length > 0 && value !== "undefined" && value !== "null";
}

/**
 * Detect whether the Vite config assigns a CDN or data cache adapter — i.e. the
 * `cdn` or `data` field of the `vinext({ cache })` option is given a value.
 * This is a source-level check on those exact object fields, not a fuzzy scan
 * for adapter names. Mirrors {@link viteConfigHasCloudflarePlugin}'s leniency:
 * an unreadable or absent config is treated as configured so a deploy is never
 * blocked on a false negative.
 */
export function viteConfigHasCacheAdapter(root: string): boolean {
  const configPath = findViteConfigPath(root);
  if (!configPath) return true;

  let content: string;
  try {
    content = fs.readFileSync(configPath, "utf-8");
  } catch {
    // unreadable — assume it might be fine
    return true;
  }
  const block = extractCacheBlock(content);
  if (!block) return false; // no cache config at all
  return cacheFieldAssigned(block, "cdn") || cacheFieldAssigned(block, "data");
}

export type ResolvedKvDataAdapterConfig = {
  binding: string;
  appPrefix?: string;
  ttlSeconds?: number;
};

function isCloudflareKvDataAdapterPath(adapter: string): boolean {
  const normalized = adapter.replace(/\\/g, "/");
  return (
    normalized === "@vinext/cloudflare/cache/kv-data-adapter.runtime" ||
    normalized === "@vinext/cloudflare/cache/kv-data-adapter.runtime.js" ||
    normalized.endsWith("/cache/kv-data-adapter.runtime.js")
  );
}

function readPositiveNumberOption(
  options: KvDataAdapterOptions | undefined,
  field: "ttlSeconds",
): number | undefined {
  const value = options?.[field];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

export function resolveKvDataAdapterConfig(
  cache: VinextCacheConfig | null | undefined,
): ResolvedKvDataAdapterConfig | null {
  const data = cache?.data;
  if (!data?.adapter || !isCloudflareKvDataAdapterPath(data.adapter)) return null;

  const options = data.options as KvDataAdapterOptions | undefined;
  return {
    binding:
      typeof options?.binding === "string" && options.binding.length > 0
        ? options.binding
        : DEFAULT_KV_DATA_CACHE_BINDING,
    ...(typeof options?.appPrefix === "string" && options.appPrefix.length > 0
      ? { appPrefix: options.appPrefix }
      : {}),
    ...(readPositiveNumberOption(options, "ttlSeconds") !== undefined
      ? { ttlSeconds: readPositiveNumberOption(options, "ttlSeconds") }
      : {}),
  };
}

export function viteConfigHasImageAdapter(root: string): boolean {
  const configPath = findViteConfigPath(root);
  if (!configPath) return true;

  try {
    const content = fs.readFileSync(configPath, "utf-8");
    const match = /\bimages\s*:\s*\{/.exec(content);
    if (!match) return false;
    const open = match.index + match[0].length - 1;
    let depth = 0;
    for (let index = open; index < content.length; index++) {
      if (content[index] === "{") depth++;
      else if (content[index] === "}" && --depth === 0) {
        const optimizer = /\boptimizer\s*:\s*([^,}\n]+)/.exec(content.slice(open, index + 1))?.[1];
        return Boolean(optimizer && !/^(?:undefined|null)$/.test(optimizer.trim()));
      }
    }
    return false;
  } catch {
    return true;
  }
}

/**
 * Detect whether an existing user-authored Worker entry wires up a cache
 * backend imperatively via one of the `setCacheHandler` / `setDataCacheHandler`
 * / `setCdnCacheAdapter` setters. These setters are deprecated in favour of the
 * declarative `vinext({ cache })` option, but older apps that scaffolded a KV
 * cache handler into their Worker entry must keep working — so a deploy should
 * not be blocked when the Worker entry already configures a backend.
 *
 * This is a heuristic text scan (it doesn't execute the entry), mirroring
 * {@link viteConfigHasCacheAdapter}'s leniency: an unreadable Worker entry is
 * treated as configured so a deploy is never blocked on a false negative. A
 * missing Worker entry returns false (nothing to inspect — defer to other
 * checks).
 */
export function workerEntryHasCacheHandler(root: string): boolean {
  const candidates = [path.join(root, "worker", "index.ts"), path.join(root, "worker", "index.js")];
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    let content: string;
    try {
      content = fs.readFileSync(candidate, "utf-8");
    } catch {
      // unreadable — assume it might be fine
      return true;
    }
    return /\b(?:setCacheHandler|setDataCacheHandler|setCdnCacheAdapter)\s*\(/.test(content);
  }
  // No Worker entry on disk — nothing to inspect here.
  return false;
}

/**
 * Build the error thrown when an ISR/cached app is deployed without a cache
 * adapter configured in the Vite config. Production deployments need a
 * persistent cache backend; vinext no longer scaffolds one into the Worker
 * entry, so it must be declared via `vinext({ cache })`.
 */
export function formatMissingCacheAdapterError(options: { configFile?: string }): string {
  const configRef = options.configFile ? options.configFile : "your Vite config";
  return (
    `[vinext] This app uses ISR / caching but no cache adapter is configured in ${configRef}.\n\n` +
    `  Production deployments need a persistent cache backend. Declare one on the\n` +
    `  vinext() plugin in ${configRef}:\n\n` +
    `    import { kvDataAdapter } from "@vinext/cloudflare/cache/kv-data-adapter";\n\n` +
    `    export default defineConfig({\n` +
    `      plugins: [\n` +
    `        vinext({\n` +
    `          cache: {\n` +
    `            data: kvDataAdapter(), // KV-backed data cache (binding: VINEXT_KV_CACHE)\n` +
    `          },\n` +
    `        }),\n` +
    `        cloudflare(),\n` +
    `      ],\n` +
    `    });\n\n` +
    `  The VINEXT_KV_CACHE namespace binding is added to wrangler.jsonc for you.\n` +
    `  Create the namespace with:\n\n` +
    `    npx wrangler kv namespace create VINEXT_KV_CACHE`
  );
}

export function formatImageOptimizationHint(): string {
  return (
    `  [vinext] next/image is served unoptimized. To enable edge image\n` +
    `  optimization via Cloudflare Images, run:\n\n` +
    `    vinext init --platform=cloudflare --image-optimization=cloudflare-images\n\n` +
    `  This adds the imagesOptimizer() option to your Vite config and the matching\n` +
    `  IMAGES binding to your Wrangler config without replacing existing settings.`
  );
}
