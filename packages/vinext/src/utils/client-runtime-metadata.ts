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
import { isAbsoluteAssetPrefix, resolveAssetsDir } from "./asset-prefix.js";

type ClientRuntimeMetadata = {
  clientEntryFile?: string;
  appBootstrapPreinitModules?: string[];
  lazyChunks?: string[];
  dynamicPreloads?: Record<string, string[]>;
};

function collectAppBootstrapPreinitModules(
  buildManifest: NonNullable<ReturnType<typeof readClientBuildManifest>>,
  appBrowserEntry: string | undefined,
  applyBase: (file: string) => string,
): string[] | undefined {
  if (!appBrowserEntry) return undefined;

  const entryKey = Object.keys(buildManifest).find(
    (key) => buildManifest[key].file === appBrowserEntry,
  );
  if (!entryKey) return undefined;

  const modules: string[] = [];
  const seenFiles = new Set<string>();
  const visitedChunks = new Set<string>();

  function visit(key: string): void {
    if (visitedChunks.has(key)) return;
    visitedChunks.add(key);

    const chunk = buildManifest[key];
    if (!chunk) return;

    for (const importedKey of chunk.imports ?? []) {
      const importedChunk = buildManifest[importedKey];
      if (importedChunk?.file.endsWith(".js") && !seenFiles.has(importedChunk.file)) {
        seenFiles.add(importedChunk.file);
        modules.push(applyBase(importedChunk.file));
      }
      visit(importedKey);
    }
  }

  visit(entryKey);
  return modules.length > 0 ? modules : undefined;
}

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
  const clientEntryManifest = readClientEntryManifest(opts.clientDir);

  const metadata: ClientRuntimeMetadata = {};

  if (opts.includeClientEntry) {
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

  metadata.appBootstrapPreinitModules = collectAppBootstrapPreinitModules(
    buildManifest,
    clientEntryManifest?.appBrowserEntry,
    (file) => {
      const url = manifestFileWithAssetPrefix(file, opts.assetBase, opts.assetPrefix);
      return isAbsoluteAssetPrefix(opts.assetPrefix) ? url : "/" + url;
    },
  );

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
