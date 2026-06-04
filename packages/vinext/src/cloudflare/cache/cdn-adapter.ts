/**
 * Cloudflare edge CDN cache adapter — config-time builder.
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
 * `cdnAdapter()` runs at config time and only returns a serializable descriptor
 * — it never touches the Workers runtime. It `require.resolve`s the sibling
 * runtime factory (`./cdn-adapter.runtime.js`). Requires the Workers Cache to be
 * enabled in wrangler.jsonc (`[cache] enabled = true`) so `ctx.cache` is present
 * at request time; registering it opts in regardless of the
 * `VINEXT_CDN_CACHE_AUTO_DETECT` flag.
 */

import { fileURLToPath } from "node:url";

/** Options accepted by {@link cdnAdapter}. (None today — reserved for future use.) */
export type CdnAdapterOptions = Record<string, never>;

/**
 * Config-time builder: returns a serializable descriptor whose `adapter` is the
 * absolute path to the runtime factory. Safe to call from vite.config — it
 * never instantiates the adapter.
 */
export function cdnAdapter(options?: CdnAdapterOptions): {
  adapter: string;
  options?: CdnAdapterOptions;
} {
  return {
    adapter: fileURLToPath(import.meta.resolve("./cdn-adapter.runtime.js")),
    options,
  };
}
