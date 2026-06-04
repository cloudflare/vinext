import path from "node:path";
import {
  readClientBuildManifest,
  findClientEntryFile,
  findPagesClientEntryFile,
} from "./client-build-manifest.js";
import {
  readClientEntryManifest,
  findClientEntryFileFromVinextManifest,
  findPagesClientEntryFileFromVinextManifest,
} from "./client-entry-manifest.js";
import {
  computeLazyChunks,
  computeDynamicImportPreloads,
  dynamicImportPreloadsWithBase,
} from "./lazy-chunks.js";
import { manifestFileWithAssetPrefix } from "./manifest-paths.js";
import { resolveAssetsDir } from "./asset-prefix.js";

type ClientRuntimeMetadata = {
  clientEntryFile?: string;
  lazyChunks?: string[];
  dynamicPreloads?: Record<string, string[]>;
};

/**
 * Read the client build manifest (`.vite/manifest.json`) and compute runtime
 * metadata used by the Cloudflare worker entry (build time) and the Pages
 * Router production server (startup time).
 *
 * - `lazyChunks` — chunks only reachable through dynamic `import()`, excluded
 *   from modulepreload hints.
 * - `dynamicPreloads` — per-module JS/CSS files for rendered `next/dynamic()`
 *   boundaries, injected as preload links during SSR.
 * - `clientEntryFile` — the client entry chunk filename (optional, only
 *   needed for Pages Router).
 *
 * All file paths are normalised with the configured `assetBase` (basePath)
 * and `assetPrefix`.
 */
export function computeClientRuntimeMetadata(opts: {
  clientDir: string;
  assetBase: string;
  assetPrefix: string;
  includeClientEntry?: boolean | "pages-client-entry";
}): ClientRuntimeMetadata {
  const buildManifestPath = path.join(opts.clientDir, ".vite", "manifest.json");
  const buildManifest = readClientBuildManifest(buildManifestPath);

  const metadata: ClientRuntimeMetadata = {};

  if (opts.includeClientEntry) {
    const clientEntryManifest = readClientEntryManifest(opts.clientDir);
    const entryOptions = {
      buildManifest,
      clientDir: opts.clientDir,
      assetsSubdir: resolveAssetsDir(opts.assetPrefix),
      assetBase: opts.assetBase,
    };
    const entry =
      opts.includeClientEntry === "pages-client-entry"
        ? (findPagesClientEntryFileFromVinextManifest(clientEntryManifest, opts.assetBase) ??
           findPagesClientEntryFile(entryOptions))
        : (findClientEntryFileFromVinextManifest(clientEntryManifest, opts.assetBase) ??
           findClientEntryFile(entryOptions));
    if (entry) metadata.clientEntryFile = entry;
  }

  if (!buildManifest) return metadata;

  const applyAssetPrefix = (file: string) =>
    manifestFileWithAssetPrefix(file, opts.assetBase, opts.assetPrefix);

  const lazyChunks = computeLazyChunks(buildManifest).map(applyAssetPrefix);
  if (lazyChunks.length > 0) metadata.lazyChunks = lazyChunks;

  const dynamicPreloads = dynamicImportPreloadsWithBase(
    computeDynamicImportPreloads(buildManifest),
    applyAssetPrefix,
  );
  if (Object.keys(dynamicPreloads).length > 0) {
    metadata.dynamicPreloads = dynamicPreloads;
  }

  return metadata;
}
