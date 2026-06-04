/**
 * Config-driven Cloudflare edge CDN cache adapter.
 *
 * Delegate page-level ISR serving to the Cloudflare Workers Cache (edge-managed)
 * from your vite config without writing a custom worker entry or calling
 * `setCdnCacheAdapter()` yourself:
 *
 *   import vinext from "vinext";
 *   import { cdnAdapter } from "vinext/cloudflare/cache/cdn-adapter";
 *
 *   export default defineConfig({
 *     plugins: [
 *       vinext({
 *         cache: { cdn: cdnAdapter() },
 *       }),
 *     ],
 *   });
 *
 * `cdnAdapter()` returns a plain descriptor at config time — it does not touch
 * the Workers runtime. Requires the Workers Cache to be enabled in
 * wrangler.jsonc (`[cache] enabled = true`) so `ctx.cache` is present at request
 * time. Registering this adapter opts in regardless of the
 * `VINEXT_CDN_CACHE_AUTO_DETECT` flag.
 */

import type { CacheAdapterDescriptor, CdnCacheAdapterFactory } from "vinext/shims/cache-adapter";
import { CloudflareCdnCacheAdapter } from "../cloudflare-cdn-cache.js";

/** Module specifier of this adapter, used by the {@link cdnAdapter} builder. */
const ADAPTER_MODULE = "vinext/cloudflare/cache/cdn-adapter";

/** Options accepted by {@link cdnAdapter}. (None today — reserved for future use.) */
export type CdnAdapterOptions = Record<string, never>;

/**
 * Config-time builder: returns a serializable descriptor pointing at this
 * module. Safe to call from vite.config — it never instantiates the adapter.
 */
export function cdnAdapter(options?: CdnAdapterOptions): CacheAdapterDescriptor<CdnAdapterOptions> {
  return { adapter: ADAPTER_MODULE, options };
}

const createCloudflareCdnCacheAdapter: CdnCacheAdapterFactory = () =>
  new CloudflareCdnCacheAdapter();

export default createCloudflareCdnCacheAdapter;
