import { fileURLToPath } from "node:url";

export const DEFAULT_KV_DATA_CACHE_BINDING = "VINEXT_KV_CACHE";

/** Options accepted by {@link kvDataAdapter}, forwarded to the runtime factory. */
export type KvDataAdapterOptions = {
  /** KV namespace binding name on the Worker `env`. @default "VINEXT_KV_CACHE" */
  binding?: string;
  /** Namespace prefix for cache keys (isolates multiple apps in one namespace). */
  appPrefix?: string;
  /** Default KV `expirationTtl` in seconds. @default 2592000 (30 days) */
  ttlSeconds?: number;
  /** TTL in milliseconds for the in-memory tag-invalidation cache. @default 5000 */
  tagCacheTtlMs?: number;
};

/**
 * Cloudflare KV data cache.
 *
 * A KV namespace must be configured in your Wrangler config for this to work.
 * ```jsonc
 * // wrangler.jsonc
 * {
 *   "kv_namespaces": [
 *     { "binding": "VINEXT_KV_CACHE", "id": "<your-kv-namespace-id>" }
 *   ]
 * }
 * ```
 */
export function kvDataAdapter(options?: KvDataAdapterOptions) {
  if (options?.binding !== undefined && typeof options.binding !== "string") {
    throw new TypeError("[vinext] kvDataAdapter({ binding }) must be a string KV binding name.");
  }
  return {
    adapter: fileURLToPath(import.meta.resolve("./kv-data-adapter.runtime.js")),
    options,
  };
}
