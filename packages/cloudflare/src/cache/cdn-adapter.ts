import { fileURLToPath } from "node:url";

export type CloudflareCdnAdapterOptions = {
  /**
   * Keep rendered page artifacts in vinext's data cache while still letting
   * this adapter own Cloudflare-specific response headers.
   * @default "workers-cache"
   */
  mode?: "workers-cache" | "data-cache";
};

/**
 * Cloudflare CDN cache adapter.
 *
 * By default, page-level ISR is edge-managed through Cloudflare Workers Cache.
 * Use `mode: "data-cache"` to retain vinext's origin-managed page storage while
 * still delegating Cloudflare-specific response-header handling to this adapter.
 *
 * Workers Cache must be enabled in your Wrangler config when using the default
 * `"workers-cache"` mode.
 * ```jsonc
 * // wrangler.jsonc
 * {
 *   "cache": {
 *     "enabled": true,
 *   },
 * }
 * ```
 */
export function cdnAdapter(options?: CloudflareCdnAdapterOptions) {
  if (
    options?.mode !== undefined &&
    options.mode !== "workers-cache" &&
    options.mode !== "data-cache"
  ) {
    throw new TypeError('cdnAdapter() mode must be "workers-cache" or "data-cache".');
  }
  return {
    adapter: fileURLToPath(import.meta.resolve("./cdn-adapter.runtime.js")),
    options,
  };
}
