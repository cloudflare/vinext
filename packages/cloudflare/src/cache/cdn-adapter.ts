import { fileURLToPath } from "node:url";

/**
 * Cloudflare CDN cache adapter - page-level ISR backed by the configured data
 * cache and Cloudflare Workers Cache.
 *
 * Fresh streaming responses are admitted to the data cache only after the
 * completed render proves static. A later request promotes that exact artifact
 * to Cloudflare's edge cache. Configure a durable data cache for promotion;
 * without one, fresh responses remain private and render again.
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
