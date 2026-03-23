/**
 * Build-time precompression for hashed static assets.
 *
 * Generates .br (brotli q5), .gz (gzip l9), and .zst (zstd l22) files
 * alongside compressible assets in dist/client/assets/. Served directly by
 * the production server — no per-request compression needed for immutable
 * build output.
 *
 * Only targets assets/ (hashed, immutable) — public directory files use
 * on-the-fly compression since they may change between deploys.
 */
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { promisify } from "node:util";

const brotliCompress = promisify(zlib.brotliCompress);
const gzip = promisify(zlib.gzip);
const zstdCompress = typeof zlib.zstdCompress === "function" ? promisify(zlib.zstdCompress) : null;

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

/** Max files to compress concurrently (avoids memory spikes). */
const CONCURRENCY = Math.min(os.availableParallelism(), 16);

export interface PrecompressResult {
  filesCompressed: number;
  totalOriginalBytes: number;
  /** Sum of brotli-compressed sizes (used for compression ratio reporting). */
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

  // Collect compressible files first, then process in bounded chunks
  const files: { fullPath: string; content: Buffer }[] = [];

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

    files.push({ fullPath, content });
    result.filesCompressed++;
    result.totalOriginalBytes += content.length;
  }

  // Process in chunks to bound concurrent CPU-heavy compressions
  for (let i = 0; i < files.length; i += CONCURRENCY) {
    const chunk = files.slice(i, i + CONCURRENCY);
    await Promise.all(
      chunk.map(async ({ fullPath, content }) => {
        // Compress all variants concurrently within each file
        const compressions: Promise<Buffer>[] = [
          brotliCompress(content, {
            params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 },
          }),
          gzip(content, { level: zlib.constants.Z_BEST_COMPRESSION }),
        ];
        if (zstdCompress) {
          compressions.push(
            zstdCompress(content, {
              params: { [zlib.constants.ZSTD_c_compressionLevel]: 22 },
            }),
          );
        }

        const results = await Promise.all(compressions);
        const [brContent, gzContent, zstdContent] = results;

        const writes = [
          fsp.writeFile(fullPath + ".br", brContent),
          fsp.writeFile(fullPath + ".gz", gzContent),
        ];
        if (zstdContent) {
          writes.push(fsp.writeFile(fullPath + ".zst", zstdContent));
        }
        await Promise.all(writes);

        result.totalCompressedBytes += brContent.length;
      }),
    );
  }

  return result;
}
