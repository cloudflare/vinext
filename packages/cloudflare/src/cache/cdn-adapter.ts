import { fileURLToPath } from "node:url";

export const DEFAULT_CDN_VERSION_METADATA_BINDING = "CF_VERSION_METADATA";

/** Options accepted by {@link cdnAdapter}, forwarded to the runtime factory. */
export type CdnAdapterOptions = {
  /** Version metadata binding used to verify version-overridden requests. */
  versionMetadataBinding?: string;
};

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
 *   "version_metadata": {
 *     "binding": "CF_VERSION_METADATA"
 *   }
 * }
 * ```
 * Wrangler does not inherit `version_metadata` into named environments. Repeat
 * the binding in every `env.<name>` used for CDN warmup.
 */
export function cdnAdapter(options?: CdnAdapterOptions) {
  if (
    options?.versionMetadataBinding !== undefined &&
    (typeof options.versionMetadataBinding !== "string" ||
      options.versionMetadataBinding.length === 0)
  ) {
    throw new TypeError(
      "[vinext] cdnAdapter({ versionMetadataBinding }) must be a non-empty string binding name.",
    );
  }
  return {
    adapter: fileURLToPath(import.meta.resolve("./cdn-adapter.runtime.js")),
    options,
    capabilities: {
      buildIdentity: "response-header" as const,
      responseVary: "verbatim" as const,
    },
  };
}
