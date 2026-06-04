/**
 * Config-driven Cloudflare KV data cache adapter.
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
 * `kvDataAdapter(...)` returns a plain descriptor at config time — it does not
 * touch the Workers runtime. The KV namespace is resolved from `env[binding]`
 * on the first request. The default binding name is `VINEXT_CACHE`:
 *
 *   { "kv_namespaces": [{ "binding": "VINEXT_CACHE", "id": "<your-kv-namespace-id>" }] }
 */

import type { CacheAdapterDescriptor, DataCacheAdapterFactory } from "vinext/shims/cache-adapter";
import { KVCacheHandler } from "../kv-cache-handler.js";

/** Module specifier of this adapter, used by the {@link kvDataAdapter} builder. */
const ADAPTER_MODULE = "vinext/cloudflare/cache/kv-data-adapter";

/** Default KV namespace binding name read from the Worker `env`. */
const DEFAULT_BINDING = "VINEXT_CACHE";

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
 * Config-time builder: returns a serializable descriptor pointing at this
 * module, with the given options forwarded to the runtime factory. Safe to call
 * from vite.config — it never instantiates the KV handler.
 */
export function kvDataAdapter(
  options?: KvDataAdapterOptions,
): CacheAdapterDescriptor<KvDataAdapterOptions> {
  if (options?.binding !== undefined && typeof options.binding !== "string") {
    throw new TypeError("[vinext] kvDataAdapter({ binding }) must be a string KV binding name.");
  }
  return { adapter: ADAPTER_MODULE, options };
}

const createKvDataCacheAdapter: DataCacheAdapterFactory<KvDataAdapterOptions> = ({
  env,
  options,
}) => {
  const binding = options?.binding ?? DEFAULT_BINDING;
  const namespace = env?.[binding];
  if (!namespace) {
    throw new Error(
      `[vinext] The KV data cache adapter requires a \`${binding}\` KV namespace binding.\n` +
        `  Add it to wrangler.jsonc:\n` +
        `    "kv_namespaces": [{ "binding": "${binding}", "id": "<your-kv-namespace-id>" }]`,
    );
  }
  return new KVCacheHandler(namespace as ConstructorParameters<typeof KVCacheHandler>[0], {
    appPrefix: options?.appPrefix,
    ttlSeconds: options?.ttlSeconds,
    tagCacheTtlMs: options?.tagCacheTtlMs,
  });
};

export default createKvDataCacheAdapter;
