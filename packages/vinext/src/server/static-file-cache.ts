/**
 * Startup metadata cache for static file serving.
 *
 * Walks dist/client/ once at server boot, pre-computes response headers for
 * every file variant (original, brotli, gzip, zstd), and caches everything
 * in memory. The per-request hot path is just: Map.get() → string compare
 * (ETag) → writeHead(precomputed) → pipe.
 *
 * Modeled after sirv's production mode. Key insight from sirv: pre-compute
 * ALL response headers at startup — Content-Type, Content-Length, ETag,
 * Cache-Control, Content-Encoding, Vary — as reusable objects. The common
 * per-request path (no extraHeaders) does zero object allocation for headers.
 */
import fsp from "node:fs/promises";
import path from "node:path";

/** Content-type lookup for static assets. Shared with prod-server.ts. */
export const CONTENT_TYPES: Record<string, string> = {
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".css": "text/css",
  ".html": "text/html",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".eot": "application/vnd.ms-fontobject",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".map": "application/json",
  ".rsc": "text/x-component",
};

/**
 * Files below this size are buffered in memory at startup for zero-syscall
 * serving via res.end(buffer). Above this, files stream via createReadStream.
 * 64KB covers virtually all precompressed assets (a 200KB JS bundle compresses
 * to ~50KB with brotli q5).
 */
const BUFFER_THRESHOLD = 64 * 1024;

/** A servable file variant with pre-computed response headers. */
export interface FileVariant {
  /** Absolute file path (used for streaming large files). */
  path: string;
  /** Pre-computed response headers. */
  headers: Record<string, string>;
  /** In-memory buffer for small files (below BUFFER_THRESHOLD). */
  buffer?: Buffer;
}

export interface StaticFileEntry {
  /** Weak ETag for conditional request matching. */
  etag: string;
  /** Pre-computed headers for 304 Not Modified response. */
  notModifiedHeaders: Record<string, string>;
  /** Original file variant (uncompressed). */
  original: FileVariant;
  /** Brotli precompressed variant, if .br file exists. */
  br?: FileVariant;
  /** Gzip precompressed variant, if .gz file exists. */
  gz?: FileVariant;
  /** Zstandard precompressed variant, if .zst file exists. */
  zst?: FileVariant;
}

/**
 * In-memory cache of static file metadata, populated once at server startup.
 *
 * Usage:
 *   const cache = await StaticFileCache.create(clientDir);
 *   const entry = cache.lookup("/assets/app-abc123.js");
 *   // entry.br?.headers, entry.original.headers, etc.
 */
export class StaticFileCache {
  private readonly entries: Map<string, StaticFileEntry>;

  private constructor(entries: Map<string, StaticFileEntry>) {
    this.entries = entries;
  }

  /**
   * Scan the client directory and build the cache.
   *
   * Gracefully handles non-existent directories (returns an empty cache).
   */
  static async create(clientDir: string): Promise<StaticFileCache> {
    const entries = new Map<string, StaticFileEntry>();

    // First pass: collect all regular files with their metadata
    const allFiles = new Map<string, { fullPath: string; size: number; mtimeMs: number }>();

    for await (const { relativePath, fullPath, stat } of walkFilesWithStats(clientDir)) {
      allFiles.set(relativePath, { fullPath, size: stat.size, mtimeMs: stat.mtimeMs });
    }

    // Second pass: build cache entries with pre-computed headers per variant
    for (const [relativePath, fileInfo] of allFiles) {
      // Skip precompressed variants — they're linked to their originals
      if (
        relativePath.endsWith(".br") ||
        relativePath.endsWith(".gz") ||
        relativePath.endsWith(".zst")
      )
        continue;

      // Skip .vite/ internal directory
      if (relativePath.startsWith(".vite/") || relativePath === ".vite") continue;

      const ext = path.extname(relativePath);
      const contentType = CONTENT_TYPES[ext] ?? "application/octet-stream";
      const isHashed = relativePath.startsWith("assets/");
      const cacheControl = isHashed
        ? "public, max-age=31536000, immutable"
        : "public, max-age=3600";
      const etag = `W/"${fileInfo.size}-${fileInfo.mtimeMs}"`;

      // Base headers shared by all variants (Content-Type, Cache-Control, ETag)
      const baseHeaders = {
        "Content-Type": contentType,
        "Cache-Control": cacheControl,
        ETag: etag,
      };

      // Pre-compute original variant headers
      const original: FileVariant = {
        path: fileInfo.fullPath,
        headers: { ...baseHeaders, "Content-Length": String(fileInfo.size) },
      };

      const entry: StaticFileEntry = {
        etag,
        notModifiedHeaders: { ETag: etag, "Cache-Control": cacheControl },
        original,
      };

      // Pre-compute compressed variant headers (with Content-Encoding, Vary, correct Content-Length)
      const brInfo = allFiles.get(relativePath + ".br");
      if (brInfo) {
        entry.br = buildVariant(brInfo, baseHeaders, "br");
      }

      const gzInfo = allFiles.get(relativePath + ".gz");
      if (gzInfo) {
        entry.gz = buildVariant(gzInfo, baseHeaders, "gzip");
      }

      const zstInfo = allFiles.get(relativePath + ".zst");
      if (zstInfo) {
        entry.zst = buildVariant(zstInfo, baseHeaders, "zstd");
      }

      // When compressed variants exist, the original needs Vary too so
      // shared caches don't serve uncompressed to compression-capable clients.
      if (entry.br || entry.gz || entry.zst) {
        original.headers["Vary"] = "Accept-Encoding";
        entry.notModifiedHeaders["Vary"] = "Accept-Encoding";
      }

      // Register under the URL pathname (leading /)
      const pathname = "/" + relativePath;
      entries.set(pathname, entry);

      // Register HTML fallback aliases
      if (ext === ".html") {
        if (relativePath.endsWith("/index.html")) {
          const dirPath = "/" + relativePath.slice(0, -"/index.html".length);
          if (dirPath !== "/") {
            entries.set(dirPath, entry);
          }
        } else {
          const withoutExt = "/" + relativePath.slice(0, -ext.length);
          entries.set(withoutExt, entry);
        }
      }
    }

    // Third pass: buffer small files in memory for zero-syscall serving.
    // For small compressed variants (e.g. a 50KB JS bundle → ~15KB brotli),
    // res.end(buffer) is ~2x faster than createReadStream().pipe() because
    // it skips fd open/close and stream plumbing overhead.
    const bufferReads: Promise<void>[] = [];
    const bufferedPaths = new Set<string>();
    for (const entry of entries.values()) {
      for (const variant of [entry.original, entry.br, entry.gz, entry.zst]) {
        if (!variant || bufferedPaths.has(variant.path)) continue;
        bufferedPaths.add(variant.path);
        const size = parseInt(variant.headers["Content-Length"], 10);
        if (size <= BUFFER_THRESHOLD) {
          bufferReads.push(
            fsp.readFile(variant.path).then((buf) => {
              variant.buffer = buf;
            }),
          );
        }
      }
    }
    await Promise.all(bufferReads);

    return new StaticFileCache(entries);
  }

  /**
   * Look up cached metadata for a URL pathname.
   *
   * Returns undefined if the file is not in the cache. The root path "/"
   * always returns undefined — index.html is served by SSR/RSC.
   */
  lookup(pathname: string): StaticFileEntry | undefined {
    if (pathname === "/") return undefined;

    // Block .vite/ access (including encoded variants that were decoded before lookup)
    if (pathname.startsWith("/.vite/") || pathname === "/.vite") return undefined;

    return this.entries.get(pathname);
  }
}

function buildVariant(
  info: { fullPath: string; size: number },
  baseHeaders: Record<string, string>,
  encoding: string,
): FileVariant {
  return {
    path: info.fullPath,
    headers: {
      ...baseHeaders,
      "Content-Encoding": encoding,
      "Content-Length": String(info.size),
      Vary: "Accept-Encoding",
    },
  };
}

/** Batch size for concurrent stat() calls during directory walk. */
const STAT_BATCH_SIZE = 64;

/**
 * Walk a directory recursively, yielding file paths and stats.
 *
 * Batches stat() calls per directory to avoid sequential syscall overhead
 * for large dist/client/ directories.
 */
async function* walkFilesWithStats(
  dir: string,
  base: string = dir,
): AsyncGenerator<{
  relativePath: string;
  fullPath: string;
  stat: { size: number; mtimeMs: number };
}> {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return; // directory doesn't exist or unreadable
  }

  // Recurse into subdirectories first (they yield their own batched stats)
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkFilesWithStats(fullPath, base);
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }

  // Batch stat() calls for files in this directory
  for (let i = 0; i < files.length; i += STAT_BATCH_SIZE) {
    const batch = files.slice(i, i + STAT_BATCH_SIZE);
    const stats = await Promise.all(batch.map((f) => fsp.stat(f)));
    for (let j = 0; j < batch.length; j++) {
      yield {
        relativePath: path.relative(base, batch[j]),
        fullPath: batch[j],
        stat: { size: stats[j].size, mtimeMs: stats[j].mtimeMs },
      };
    }
  }
}
