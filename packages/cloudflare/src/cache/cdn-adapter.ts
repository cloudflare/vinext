import { fileURLToPath } from "node:url";
import { finalizeWorkersCacheBuildOutput } from "./cdn-adapter-config.js";

export const DEFAULT_CDN_VERSION_METADATA_BINDING = "CF_VERSION_METADATA";

const CLOUDFLARE_WORKER_ENTRY_ID = "virtual:cloudflare/worker-entry";

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
 * serves HIT/STALE itself), this adapter delegates serving to Workers Cache on
 * a named Worker entrypoint. The default entrypoint always runs middleware and
 * request-time routing before dispatching the cacheable response stage.
 *
 * The emitted Wrangler configuration enables Workers Cache only for that
 * response-stage export, so cache hits do not start the application stage.
 * Version metadata is still required for cache warming:
 * ```jsonc
 * // wrangler.jsonc
 * {
 *   "version_metadata": {
 *     "binding": "CF_VERSION_METADATA"
 *   }
 * }
 * ```
 * Wrangler does not inherit `version_metadata` into named environments. Repeat
 * the binding in every `env.<name>` used for CDN warmup.
 *
 * Cache Rules must preserve the full query string in the incoming cache key.
 * Two-stage admission certifies exact pathname + search identities, while an
 * edge HIT is served before the Worker can reject a differently keyed request.
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
  const workerEntry = fileURLToPath(import.meta.resolve("./cdn-adapter.worker.js"));
  return {
    adapter: fileURLToPath(import.meta.resolve("./cdn-adapter.runtime.js")),
    options,
    output: {
      entry: workerEntry,
      matchesBuild({ plugins }: { plugins: readonly { name?: string }[] }) {
        return plugins.some(
          ({ name }) =>
            name === "vite-plugin-cloudflare" || name?.startsWith("vite-plugin-cloudflare:"),
        );
      },
      transformHostEntry({ code, id }: { code: string; id: string }) {
        const cleanId = id.charCodeAt(0) === 0 ? id.slice(1) : id;
        if (cleanId !== CLOUDFLARE_WORKER_ENTRY_ID) {
          return null;
        }
        return `${code}\nexport { VinextCachedResponse } from ${JSON.stringify(workerEntry)};\n`;
      },
      finalizeBuildOutput: finalizeWorkersCacheBuildOutput,
      type: "multi-stage" as const,
    },
    capabilities: {
      buildIdentity: "response-header" as const,
      responsePolicyHeaderNames: ["CDN-Cache-Control", "Cloudflare-CDN-Cache-Control"] as const,
      responseVary: "verbatim" as const,
      routeCacheability: "probe-manifest" as const,
    },
  };
}
