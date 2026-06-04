/**
 * Runtime factory for the Cloudflare KV data cache adapter.
 *
 * This is the module the generated `virtual:vinext-cache-adapters` registration
 * imports (its default export). It runs on the Worker at request time: it reads
 * the KV namespace from `env[binding]` and constructs a {@link KVCacheHandler}.
 *
 * Configure it from vite.config via the {@link kvDataAdapter} builder in
 * `./kv-data-adapter.ts` — that builder `require.resolve`s this file, so the
 * descriptor carries an absolute path here and you never reference `.runtime`
 * directly.
 */

import type { DataCacheAdapterFactory } from "vinext/shims/cache-adapter";
import { KVCacheHandler } from "../kv-cache-handler.js";
import type { KvDataAdapterOptions } from "./kv-data-adapter.js";

/** Default KV namespace binding name read from the Worker `env`. */
const DEFAULT_BINDING = "VINEXT_CACHE";

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
