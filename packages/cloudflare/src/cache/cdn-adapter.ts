import { fileURLToPath } from "node:url";

/**
 * Cloudflare CDN cache adapter - edge-managed page-level ISR backed by the
 * Cloudflare Workers Cache.
 *
 * Unlike the data adapter (which stores cache entries in a durable store and
 * serves HIT/STALE itself), this adapter delegates serving to Cloudflare's
 * edge cache.
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
