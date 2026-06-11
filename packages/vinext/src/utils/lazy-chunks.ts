/**
 * Build-manifest chunk metadata used to compute lazy chunks.
 */
export type BuildManifestChunk = {
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
 * @returns Array of chunk filenames (e.g. "_next/static/mermaid-NOHMQCX5.js") that
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

function normalizeManifestKey(key: string): string {
  return key.split("?")[0].replace(/\\/g, "/").replace(/^\/+/, "");
}

function addFile(files: string[], seen: Set<string>, file: string | undefined): void {
  if (!file || seen.has(file)) return;
  seen.add(file);
  files.push(file);
}

function collectStaticChunkFiles(
  buildManifest: Record<string, BuildManifestChunk>,
  key: string,
  files: string[],
  seenFiles: Set<string>,
  visitedChunks: Set<string>,
): void {
  if (visitedChunks.has(key)) return;
  visitedChunks.add(key);

  const chunk = buildManifest[key];
  if (!chunk) return;

  if (chunk.file.endsWith(".js")) {
    addFile(files, seenFiles, chunk.file);
  }
  for (const cssFile of chunk.css ?? []) {
    addFile(files, seenFiles, cssFile);
  }

  for (const importedKey of chunk.imports ?? []) {
    collectStaticChunkFiles(buildManifest, importedKey, files, seenFiles, visitedChunks);
  }
}

/**
 * Compute the production preload files for each module referenced by a
 * `next/dynamic()` boundary.
 *
 * Next.js records module IDs during compilation, then resolves those IDs
 * against its react-loadable manifest at render time. Vinext's equivalent
 * source of truth is Vite's build manifest: each chunk lists the modules it
 * reaches through `dynamicImports`, and each dynamic entry lists the JS/CSS
 * files required to evaluate it.
 *
 * Note on shared chunks: a boundary's static-import tree (`collectStaticChunkFiles`)
 * can include chunks that the page entry ALSO loads eagerly (a shared vendor
 * chunk imported by both). Those files are intentionally NOT subtracted here, so
 * a rendered boundary may emit a `<link rel="preload">` / `<link rel="stylesheet">`
 * for a chunk the page already `<link rel="modulepreload">`s. This is harmless —
 * the browser dedupes preloads by URL, `ReactDOM.preload()` dedupes script hints,
 * and React's stylesheet resource model dedupes by href + precedence — and it
 * mirrors Next.js listing a module's full file set in its react-loadable
 * manifest. Subtracting the eager set would couple this to the entry's import
 * closure for no correctness gain.
 *
 * @returns A map keyed by root-relative module ID, with JS/CSS files that
 * should be preloaded when that dynamic boundary is rendered.
 */
export function computeDynamicImportPreloads(
  buildManifest: Record<string, BuildManifestChunk>,
): Record<string, string[]> {
  const preloads: Record<string, string[]> = {};

  for (const chunk of Object.values(buildManifest)) {
    for (const dynamicKey of chunk.dynamicImports ?? []) {
      const files: string[] = [];
      const seenFiles = new Set<string>();
      collectStaticChunkFiles(buildManifest, dynamicKey, files, seenFiles, new Set());
      if (files.length === 0) continue;

      const normalizedKey = normalizeManifestKey(dynamicKey);
      const existing = preloads[normalizedKey] ?? [];
      const merged = new Set(existing);
      for (const file of files) {
        if (merged.has(file)) continue;
        merged.add(file);
        existing.push(file);
      }
      preloads[normalizedKey] = existing;
    }
  }

  return preloads;
}

export function dynamicImportPreloadsWithBase(
  preloads: Record<string, string[]>,
  applyBase: (file: string) => string,
): Record<string, string[]> {
  const withBase: Record<string, string[]> = {};
  for (const [key, files] of Object.entries(preloads)) {
    withBase[key] = files.map(applyBase);
  }
  return withBase;
}
