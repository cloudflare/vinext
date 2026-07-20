import { fileURLToPath } from "node:url";

/**
 * Cloudflare CDN cache adapter - page-level ISR backed by the configured data
 * cache and Cloudflare Workers Cache.
 *
 * Fresh streaming responses are first admitted through the data cache after
 * rendering proves they are static. A later request promotes the admitted
 * artifact to Cloudflare's edge cache. This preserves streaming without ever
 * exposing request-specific output to a shared cache.
 *
 * Workers Cache must be enabled in your Wrangler config for this to work.
 * ```jsonc
 * // wrangler.jsonc
 * {
 *   "cache": {
 *     "enabled": true,
 *   },
 * }
 * ```
 */
export function cdnAdapter(options?: Record<string, never>) {
  return {
    adapter: fileURLToPath(import.meta.resolve("./cdn-adapter.runtime.js")),
    options,
  };
}
