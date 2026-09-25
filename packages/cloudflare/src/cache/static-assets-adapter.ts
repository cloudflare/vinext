import { fileURLToPath } from "node:url";
import { finalizeStaticAssetsPrerenderOutput } from "./static-assets-adapter.build.js";

export type StaticAssetsAdapterOptions = {
  /** Workers Static Assets binding name. @default "ASSETS" */
  binding?: string;
};

/**
 * Read-only page cache backed by Workers Static Assets.
 *
 * Locally prerendered App Router HTML, RSC, and metadata responses are copied
 * into `dist/client` after the build. Runtime cache writes and invalidations are
 * intentionally no-ops; a new deployment replaces the cache contents.
 */
export function staticAssetsAdapter(options?: StaticAssetsAdapterOptions) {
  if (
    options?.binding !== undefined &&
    (typeof options.binding !== "string" || options.binding.length === 0)
  ) {
    throw new TypeError(
      "[vinext] staticAssetsAdapter({ binding }) must be a non-empty string binding name.",
    );
  }
  return {
    adapter: fileURLToPath(import.meta.resolve("./static-assets-adapter.runtime.js")),
    options,
    output: {
      finalizePrerenderOutput({ root, clientOutDir }: { root: string; clientOutDir: string }) {
        finalizeStaticAssetsPrerenderOutput(root, { clientOutDir });
      },
    },
    capabilities: {
      buildIdentity: "response-header" as const,
      warmup: "data-cache" as const,
    },
  };
}
