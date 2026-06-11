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
import { manifestFileWithBase, manifestFileWithAssetPrefix } from "./manifest-paths.js";
import { resolveAssetsDir } from "./asset-prefix.js";

type ClientRuntimeMetadata = {
  clientEntryFile?: string;
  lazyChunks?: string[];
  dynamicPreloads?: Record<string, string[]>;
};

/**
 * Read the client build manifest and compute runtime metadata used by
 * Cloudflare worker entry injection and Node production server startup.
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

  // `lazyChunks` and `dynamicPreloads` live in DIFFERENT key-spaces and must be
  // normalised differently:
  //
  // - `lazyChunks` is consumed by `pages-asset-tags.ts`, which decides whether a
  //   chunk should get a `<link rel="modulepreload">` by membership test against
  //   the (base-relative, leading-slash-stripped) SSR-manifest values. So these
  //   must stay in the SSR-manifest key-space: basePath only, NEVER assetPrefix.
  //   Applying an absolute-URL assetPrefix here breaks the membership test and
  //   lets lazy chunks leak back into modulepreload hints.
  // - `dynamicPreloads` is consumed by `DynamicPreloadChunks` during SSR, which
  //   renders real `<link>` hrefs, so these DO need the full assetPrefix.
  const lazyChunks = computeLazyChunks(buildManifest).map((file) =>
    manifestFileWithBase(file, opts.assetBase),
  );
  if (lazyChunks.length > 0) metadata.lazyChunks = lazyChunks;

  const dynamicPreloads = dynamicImportPreloadsWithBase(
    computeDynamicImportPreloads(buildManifest),
    (file) => manifestFileWithAssetPrefix(file, opts.assetBase, opts.assetPrefix),
  );
  if (Object.keys(dynamicPreloads).length > 0) {
    metadata.dynamicPreloads = dynamicPreloads;
  }

  return metadata;
}

/**
 * Serialize runtime metadata into the `globalThis.__VINEXT_*` assignment script
 * that the Cloudflare `closeBundle` hook prepends to the worker entry. Returns
 * `""` when there is nothing to inject.
 *
 * Both the App Router and Pages Router closeBundle paths call this (and the
 * deploy tests mirror it), so the injection shape stays in one place. The caller
 * decides which fields to pass — e.g. App Router only forwards `clientEntryFile`
 * for mixed app+pages builds (where `computeClientRuntimeMetadata` was asked for
 * the Pages client entry); pure App Router leaves it undefined.
 */
export function buildRuntimeGlobalsScript(input: {
  clientEntryFile?: string | null;
  ssrManifest?: Record<string, string[]> | null;
  lazyChunks?: string[] | null;
  dynamicPreloads?: Record<string, string[]> | null;
}): string {
  // Guard on actual content, not just truthiness: `[]` and `{}` are truthy, so a
  // caller passing an empty collection would otherwise emit a useless (and
  // misleading) `globalThis.__VINEXT_… = []`. `computeClientRuntimeMetadata`
  // already returns `undefined` for empties, but this keeps the helper correct
  // for any caller.
  const globals: string[] = [];
  if (input.clientEntryFile) {
    globals.push(`globalThis.__VINEXT_CLIENT_ENTRY__ = ${JSON.stringify(input.clientEntryFile)};`);
  }
  if (input.ssrManifest && Object.keys(input.ssrManifest).length > 0) {
    globals.push(`globalThis.__VINEXT_SSR_MANIFEST__ = ${JSON.stringify(input.ssrManifest)};`);
  }
  if (input.lazyChunks && input.lazyChunks.length > 0) {
    globals.push(`globalThis.__VINEXT_LAZY_CHUNKS__ = ${JSON.stringify(input.lazyChunks)};`);
  }
  if (input.dynamicPreloads && Object.keys(input.dynamicPreloads).length > 0) {
    globals.push(
      `globalThis.__VINEXT_DYNAMIC_PRELOADS__ = ${JSON.stringify(input.dynamicPreloads)};`,
    );
  }
  return globals.join("\n");
}
