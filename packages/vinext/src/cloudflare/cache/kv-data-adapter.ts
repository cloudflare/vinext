/**
 * Cloudflare KV data cache adapter — config-time builder.
 *
 * Configure the data cache (fetch / `"use cache"` / `unstable_cache`) from your
 * vite config without writing a custom worker entry or calling
 * `setDataCacheHandler()` yourself:
 *
 *   import vinext from "vinext";
 *   import { kvDataAdapter } from "vinext/cloudflare/cache/kv-data-adapter";
 *
 *   export default defineConfig({
 *     plugins: [
 *       vinext({
 *         cache: { data: kvDataAdapter({ binding: "MY_KV" }) },
 *       }),
 *     ],
 *   });
 *
 * `kvDataAdapter(...)` runs at config time and only returns a serializable
 * descriptor — it never touches the Workers runtime. It `require.resolve`s the
 * sibling runtime factory (`./kv-data-adapter.runtime.js`) to an absolute path,
 * which the generated registration imports and invokes on the first request to
 * resolve `env[binding]` (default `VINEXT_CACHE`) and build the KV handler.
 */

import { fileURLToPath } from "node:url";
import type { CacheAdapterDescriptor } from "vinext/shims/cache-adapter";

/** Options accepted by {@link kvDataAdapter}, forwarded to the runtime factory. */
export type KvDataAdapterOptions = {
  /** KV namespace binding name on the Worker `env`. @default "VINEXT_CACHE" */
  binding?: string;
  /** Namespace prefix for cache keys (isolates multiple apps in one namespace). */
  appPrefix?: string;
  /** Default KV `expirationTtl` in seconds. @default 2592000 (30 days) */
  ttlSeconds?: number;
  /** TTL in milliseconds for the in-memory tag-invalidation cache. @default 5000 */
  tagCacheTtlMs?: number;
};

/**
 * Config-time builder: returns a serializable descriptor whose `adapter` is the
 * absolute path to the runtime factory. Safe to call from vite.config — it
 * never instantiates the KV handler or reads a binding.
 */
export function kvDataAdapter(
  options?: KvDataAdapterOptions,
): CacheAdapterDescriptor<KvDataAdapterOptions> {
  if (options?.binding !== undefined && typeof options.binding !== "string") {
    throw new TypeError("[vinext] kvDataAdapter({ binding }) must be a string KV binding name.");
  }
  return {
    adapter: fileURLToPath(import.meta.resolve("./kv-data-adapter.runtime.js")),
    options,
  };
}
