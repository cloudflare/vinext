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
 * Responses whose request-time composition must run on every request (a
 * middleware pathname scope or header/cookie-dependent config rule) cannot be
 * served directly from the edge. Their page artifacts fall back to vinext's
 * data cache instead; configure a durable data adapter such as
 * `kvDataAdapter()` for cross-isolate ISR rather than the in-memory default.
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
