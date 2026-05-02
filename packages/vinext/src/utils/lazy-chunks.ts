/**
 * Build-manifest chunk metadata used to compute lazy chunks.
 */
type BuildManifestChunk = {
  file: string;
  isEntry?: boolean;
  isDynamicEntry?: boolean;
  imports?: string[];
  dynamicImports?: string[];
  css?: string[];
  assets?: string[];
};

/**
 * Compute the set of chunk filenames that are ONLY reachable through dynamic
 * imports (i.e. behind React.lazy(), next/dynamic, or manual import()).
 *
 * These chunks should NOT be modulepreloaded in the HTML — they will be
 * fetched on demand when the dynamic import executes.
 *
 * Algorithm: Starting from all entry chunks in the build manifest, walk the
 * static `imports` tree (breadth-first). Any chunk file NOT reached by this
 * walk is only reachable through `dynamicImports` and is therefore "lazy".
 *
 * @param buildManifest - Vite's build manifest (manifest.json), which is a
 *   Record<string, ManifestChunk> where each chunk has `file`, `imports`,
 *   `dynamicImports`, `isEntry`, and `isDynamicEntry` fields.
 * @returns Array of chunk filenames (e.g. "assets/mermaid-NOHMQCX5.js") that
 *   should be excluded from modulepreload hints.
 */
export function computeLazyChunks(buildManifest: Record<string, BuildManifestChunk>): string[] {
  // Collect all chunk files that are statically reachable from entries
  const eagerFiles = new Set<string>();
  const visited = new Set<string>();
  const queue: string[] = [];

  // Start BFS from all entry chunks
  for (const key of Object.keys(buildManifest)) {
    const chunk = buildManifest[key];
    if (chunk.isEntry) {
      queue.push(key);
    }
  }

  while (queue.length > 0) {
    const key = queue.shift();
    if (!key || visited.has(key)) continue;
    visited.add(key);

    const chunk = buildManifest[key];
    if (!chunk) continue;

    // Mark this chunk's file as eager
    eagerFiles.add(chunk.file);

    // Also mark its CSS as eager (CSS should always be preloaded to avoid FOUC)
    if (chunk.css) {
      for (const cssFile of chunk.css) {
        eagerFiles.add(cssFile);
      }
    }

    // Follow only static imports — NOT dynamicImports
    if (chunk.imports) {
      for (const imp of chunk.imports) {
        if (!visited.has(imp)) {
          queue.push(imp);
        }
      }
    }
  }

  // Any JS file in the manifest that's NOT in eagerFiles is a lazy chunk
  const lazyChunks: string[] = [];
  const allFiles = new Set<string>();
  for (const key of Object.keys(buildManifest)) {
    const chunk = buildManifest[key];
    if (chunk.file && !allFiles.has(chunk.file)) {
      allFiles.add(chunk.file);
      if (!eagerFiles.has(chunk.file) && chunk.file.endsWith(".js")) {
        lazyChunks.push(chunk.file);
      }
    }
  }

  return lazyChunks;
}
