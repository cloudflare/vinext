/**
 * Build-time precompression for hashed static assets.
 *
 * Generates .br (brotli quality 11) and .gz (gzip level 9) files alongside
 * compressible assets in dist/client/assets/. These are served directly by
 * the production server — no per-request compression needed for immutable
 * build output.
 *
 * Only targets assets/ (hashed, immutable) — public directory files use
 * on-the-fly compression since they may change between deploys.
 */
import fsp from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { promisify } from "node:util";

const brotliCompress = promisify(zlib.brotliCompress);
const gzip = promisify(zlib.gzip);
const zstdCompress = promisify(zlib.zstdCompress);

/** File extensions worth compressing (text-based, not already compressed). */
const COMPRESSIBLE_EXTENSIONS = new Set([
  ".js",
  ".mjs",
  ".css",
  ".html",
  ".json",
  ".xml",
  ".svg",
  ".txt",
  ".map",
  ".wasm",
]);

/** Below this size, compression overhead exceeds savings. */
const MIN_SIZE = 1024;

export interface PrecompressResult {
  filesCompressed: number;
  totalOriginalBytes: number;
  /** Smallest compressed variant per file (brotli, since it always wins). */
  totalCompressedBytes: number;
}

/**
 * Walk a directory recursively, yielding relative paths for regular files.
 */
async function* walkFiles(dir: string, base: string = dir): AsyncGenerator<string> {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return; // directory doesn't exist
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkFiles(fullPath, base);
    } else if (entry.isFile()) {
      yield path.relative(base, fullPath);
    }
  }
}

/**
 * Precompress all compressible hashed assets under `clientDir/assets/`.
 *
 * Writes `.br`, `.gz`, and `.zst` files alongside each original. Idempotent —
 * skips files that already have compressed variants, and never compresses
 * `.br`, `.gz`, or `.zst` files themselves.
 */
export async function precompressAssets(clientDir: string): Promise<PrecompressResult> {
  const assetsDir = path.join(clientDir, "assets");
  const result: PrecompressResult = {
    filesCompressed: 0,
    totalOriginalBytes: 0,
    totalCompressedBytes: 0,
  };

  const compressionWork: Promise<void>[] = [];

  for await (const relativePath of walkFiles(assetsDir)) {
    const ext = path.extname(relativePath).toLowerCase();

    // Skip non-compressible types and already-compressed variants
    if (!COMPRESSIBLE_EXTENSIONS.has(ext)) continue;
    if (
      relativePath.endsWith(".br") ||
      relativePath.endsWith(".gz") ||
      relativePath.endsWith(".zst")
    )
      continue;

    const fullPath = path.join(assetsDir, relativePath);
    const content = await fsp.readFile(fullPath);

    if (content.length < MIN_SIZE) continue;

    result.filesCompressed++;
    result.totalOriginalBytes += content.length;

    // Compress all three variants concurrently
    compressionWork.push(
      (async () => {
        const [brContent, gzContent, zstdContent] = await Promise.all([
          brotliCompress(content, {
            params: {
              [zlib.constants.BROTLI_PARAM_QUALITY]: zlib.constants.BROTLI_MAX_QUALITY,
            },
          }),
          gzip(content, { level: zlib.constants.Z_BEST_COMPRESSION }),
          zstdCompress(content, {
            params: {
              [zlib.constants.ZSTD_c_compressionLevel]: 19, // High compression (1-22, 19 is a good max)
            },
          }),
        ]);

        await Promise.all([
          fsp.writeFile(fullPath + ".br", brContent),
          fsp.writeFile(fullPath + ".gz", gzContent),
          fsp.writeFile(fullPath + ".zst", zstdContent),
        ]);

        // Track brotli size (typically the smallest variant)
        result.totalCompressedBytes += brContent.length;
      })(),
    );
  }

  await Promise.all(compressionWork);
  return result;
}
