/**
 * Config-driven Cloudflare edge CDN cache adapter.
 *
 * Point `cache.cdn.adapter` at this module to delegate page-level ISR serving
 * to the Cloudflare Workers Cache (edge-managed) without writing a custom
 * worker entry or calling `setCdnCacheAdapter()` yourself:
 *
 *   import vinext from "vinext";
 *   export default defineConfig({
 *     plugins: [
 *       vinext({
 *         cache: {
 *           cdn: { adapter: require.resolve("vinext/cloudflare/cache/cdn-adapter") },
 *         },
 *       }),
 *     ],
 *   });
 *
 * Requires the Workers Cache to be enabled in wrangler.jsonc (`[cache] enabled
 * = true`) so `ctx.cache` is present at request time. Registering this adapter
 * explicitly opts in regardless of the `VINEXT_CDN_CACHE_AUTO_DETECT` flag.
 */

import type { CdnCacheAdapterFactory } from "vinext/shims/cache-adapter";
import { CloudflareCdnCacheAdapter } from "../cloudflare-cdn-cache.js";

const createCloudflareCdnCacheAdapter: CdnCacheAdapterFactory = () =>
  new CloudflareCdnCacheAdapter();

export default createCloudflareCdnCacheAdapter;
