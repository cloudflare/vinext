/**
 * Config-driven Cloudflare KV data cache adapter.
 *
 * Point `cache.data.adapter` at this module to register a KV-backed data cache
 * (fetch / `"use cache"` / `unstable_cache`) without writing a custom worker
 * entry or calling `setDataCacheHandler()` yourself:
 *
 *   import vinext from "vinext";
 *   export default defineConfig({
 *     plugins: [
 *       vinext({
 *         cache: {
 *           data: { adapter: require.resolve("vinext/cloudflare/cache/kv-data-adapter") },
 *         },
 *       }),
 *     ],
 *   });
 *
 * Requires a `VINEXT_CACHE` KV namespace binding in wrangler.jsonc:
 *
 *   { "kv_namespaces": [{ "binding": "VINEXT_CACHE", "id": "<your-kv-namespace-id>" }] }
 */

import type { DataCacheAdapterFactory } from "vinext/shims/cache-adapter";
import { KVCacheHandler } from "../kv-cache-handler.js";

/** KV namespace binding name read from the Worker `env`. */
const KV_BINDING = "VINEXT_CACHE";

const createKvDataCacheAdapter: DataCacheAdapterFactory = ({ env }) => {
  const namespace = env?.[KV_BINDING];
  if (!namespace) {
    throw new Error(
      `[vinext] The KV data cache adapter requires a \`${KV_BINDING}\` KV namespace binding.\n` +
        `  Add it to wrangler.jsonc:\n` +
        `    "kv_namespaces": [{ "binding": "${KV_BINDING}", "id": "<your-kv-namespace-id>" }]`,
    );
  }
  return new KVCacheHandler(namespace as ConstructorParameters<typeof KVCacheHandler>[0]);
};

export default createKvDataCacheAdapter;
