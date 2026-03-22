/**
 * Tests for the startup metadata cache used by the production server.
 *
 * StaticFileCache walks dist/client/ once at server startup, caches file
 * metadata (path, size, content-type, cache-control, etag, precompressed
 * variant paths), and serves lookups from memory with zero filesystem calls.
 */
import { describe, it, expect, beforeEach, afterEach } from "vite-plus/test";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import zlib from "node:zlib";
import { StaticFileCache } from "../packages/vinext/src/server/static-file-cache.js";

/** Create a temp directory that mimics dist/client/ structure. */
async function setupClientDir(): Promise<string> {
  const dir = path.join(
    os.tmpdir(),
    `vinext-cache-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

async function writeFile(
  clientDir: string,
  relativePath: string,
  content: string | Buffer,
): Promise<void> {
  const fullPath = path.join(clientDir, relativePath);
  await fsp.mkdir(path.dirname(fullPath), { recursive: true });
  await fsp.writeFile(fullPath, content);
}

describe("StaticFileCache", () => {
  let clientDir: string;

  beforeEach(async () => {
    clientDir = await setupClientDir();
  });

  afterEach(async () => {
    await fsp.rm(clientDir, { recursive: true, force: true });
  });

  // ── Creation and scanning ──────────────────────────────────────

  it("creates a cache by scanning the client directory", async () => {
    await writeFile(clientDir, "assets/app-abc123.js", "const x = 1;");
    const cache = await StaticFileCache.create(clientDir);

    expect(cache).toBeDefined();
  });

  it("handles empty client directory", async () => {
    const cache = await StaticFileCache.create(clientDir);

    expect(cache.lookup("/assets/nope.js")).toBeUndefined();
  });

  it("handles non-existent client directory gracefully", async () => {
    const cache = await StaticFileCache.create(path.join(clientDir, "does-not-exist"));

    expect(cache.lookup("/anything")).toBeUndefined();
  });

  // ── Lookup ─────────────────────────────────────────────────────

  it("returns cached metadata for an existing file", async () => {
    await writeFile(clientDir, "assets/index-abc123.js", "const x = 1;");

    const cache = await StaticFileCache.create(clientDir);
    const entry = cache.lookup("/assets/index-abc123.js");

    expect(entry).toBeDefined();
    expect(entry!.contentType).toBe("application/javascript");
    expect(entry!.size).toBe(12); // "const x = 1;"
    expect(entry!.resolvedPath).toBe(path.join(clientDir, "assets/index-abc123.js"));
  });

  it("returns undefined for non-existent files", async () => {
    await writeFile(clientDir, "assets/real-abc123.js", "x");

    const cache = await StaticFileCache.create(clientDir);

    expect(cache.lookup("/assets/missing-xyz789.js")).toBeUndefined();
  });

  it("sets immutable cache-control for hashed assets under /assets/", async () => {
    await writeFile(clientDir, "assets/bundle-abc123.js", "x".repeat(100));

    const cache = await StaticFileCache.create(clientDir);
    const entry = cache.lookup("/assets/bundle-abc123.js");

    expect(entry!.cacheControl).toBe("public, max-age=31536000, immutable");
  });

  it("sets short cache-control for non-hashed files", async () => {
    await writeFile(clientDir, "favicon.ico", "icon-data");

    const cache = await StaticFileCache.create(clientDir);
    const entry = cache.lookup("/favicon.ico");

    expect(entry!.cacheControl).toBe("public, max-age=3600");
  });

  it("generates weak etag from size and mtime", async () => {
    await writeFile(clientDir, "assets/app-abc123.css", ".body { margin: 0; }");

    const cache = await StaticFileCache.create(clientDir);
    const entry = cache.lookup("/assets/app-abc123.css");

    // Etag should be W/"<size>-<mtime>" format (like sirv)
    expect(entry!.etag).toMatch(/^W\/"\d+-\d+(\.\d+)?"$/);
  });

  // ── Precompressed variants ─────────────────────────────────────

  it("detects brotli precompressed variant", async () => {
    const content = "const x = 1;\n".repeat(200);
    await writeFile(clientDir, "assets/app-abc123.js", content);
    // Simulate build-time precompression
    const brContent = zlib.brotliCompressSync(Buffer.from(content));
    await writeFile(clientDir, "assets/app-abc123.js.br", brContent);

    const cache = await StaticFileCache.create(clientDir);
    const entry = cache.lookup("/assets/app-abc123.js");

    expect(entry!.brPath).toBe(path.join(clientDir, "assets/app-abc123.js.br"));
    expect(entry!.brSize).toBe(brContent.length);
  });

  it("detects gzip precompressed variant", async () => {
    const content = "body { margin: 0; }\n".repeat(200);
    await writeFile(clientDir, "assets/styles-def456.css", content);
    const gzContent = zlib.gzipSync(Buffer.from(content));
    await writeFile(clientDir, "assets/styles-def456.css.gz", gzContent);

    const cache = await StaticFileCache.create(clientDir);
    const entry = cache.lookup("/assets/styles-def456.css");

    expect(entry!.gzPath).toBe(path.join(clientDir, "assets/styles-def456.css.gz"));
    expect(entry!.gzSize).toBe(gzContent.length);
  });

  it("detects zstandard precompressed variant", async () => {
    const content = "const zstd = true;\n".repeat(200);
    await writeFile(clientDir, "assets/app-zstd.js", content);
    const zstdContent = zlib.zstdCompressSync(Buffer.from(content));
    await writeFile(clientDir, "assets/app-zstd.js.zst", zstdContent);

    const cache = await StaticFileCache.create(clientDir);
    const entry = cache.lookup("/assets/app-zstd.js");

    expect(entry!.zstPath).toBe(path.join(clientDir, "assets/app-zstd.js.zst"));
    expect(entry!.zstSize).toBe(zstdContent.length);
  });

  it("does not expose .br/.gz/.zst files as standalone entries", async () => {
    const content = "const x = 1;\n".repeat(200);
    await writeFile(clientDir, "assets/app-abc123.js", content);
    await writeFile(
      clientDir,
      "assets/app-abc123.js.br",
      zlib.brotliCompressSync(Buffer.from(content)),
    );
    await writeFile(clientDir, "assets/app-abc123.js.gz", zlib.gzipSync(Buffer.from(content)));
    await writeFile(
      clientDir,
      "assets/app-abc123.js.zst",
      zlib.zstdCompressSync(Buffer.from(content)),
    );

    const cache = await StaticFileCache.create(clientDir);

    // .br, .gz, .zst should not be independently servable
    expect(cache.lookup("/assets/app-abc123.js.br")).toBeUndefined();
    expect(cache.lookup("/assets/app-abc123.js.gz")).toBeUndefined();
    expect(cache.lookup("/assets/app-abc123.js.zst")).toBeUndefined();
  });

  // ── HTML fallbacks ─────────────────────────────────────────────

  it("resolves .html extension fallback for prerendered pages", async () => {
    await writeFile(clientDir, "about.html", "<html>About</html>");

    const cache = await StaticFileCache.create(clientDir);
    const entry = cache.lookup("/about");

    expect(entry).toBeDefined();
    expect(entry!.resolvedPath).toBe(path.join(clientDir, "about.html"));
    expect(entry!.contentType).toBe("text/html");
  });

  it("resolves /index.html fallback for directory paths", async () => {
    await writeFile(clientDir, "blog/index.html", "<html>Blog</html>");

    const cache = await StaticFileCache.create(clientDir);
    const entry = cache.lookup("/blog");

    expect(entry).toBeDefined();
    expect(entry!.resolvedPath).toBe(path.join(clientDir, "blog/index.html"));
  });

  // ── Directory traversal protection ─────────────────────────────

  it("blocks .vite/ internal directory access", async () => {
    await writeFile(clientDir, ".vite/manifest.json", "{}");

    const cache = await StaticFileCache.create(clientDir);

    expect(cache.lookup("/.vite/manifest.json")).toBeUndefined();
  });

  it("skips root / path", async () => {
    await writeFile(clientDir, "index.html", "<html>Root</html>");

    const cache = await StaticFileCache.create(clientDir);

    // Root index.html is served by SSR/RSC, not static serving
    expect(cache.lookup("/")).toBeUndefined();
  });

  // ── Content type detection ─────────────────────────────────────

  it("detects content types from file extensions", async () => {
    await writeFile(clientDir, "assets/style-aaa.css", "body{}");
    await writeFile(clientDir, "assets/data-bbb.json", "{}");
    await writeFile(clientDir, "logo.svg", "<svg/>");
    await writeFile(clientDir, "photo.webp", "webp-data");

    const cache = await StaticFileCache.create(clientDir);

    expect(cache.lookup("/assets/style-aaa.css")!.contentType).toBe("text/css");
    expect(cache.lookup("/assets/data-bbb.json")!.contentType).toBe("application/json");
    expect(cache.lookup("/logo.svg")!.contentType).toBe("image/svg+xml");
    expect(cache.lookup("/photo.webp")!.contentType).toBe("image/webp");
  });

  it("falls back to application/octet-stream for unknown extensions", async () => {
    await writeFile(clientDir, "assets/data-ccc.xyz", "unknown-data");

    const cache = await StaticFileCache.create(clientDir);

    expect(cache.lookup("/assets/data-ccc.xyz")!.contentType).toBe("application/octet-stream");
  });

  // ── Nested directory scanning ──────────────────────────────────

  it("scans nested directories recursively", async () => {
    await writeFile(clientDir, "assets/chunks/vendor-aaa.js", "vendor code");
    await writeFile(clientDir, "assets/chunks/lazy/page-bbb.js", "page code");

    const cache = await StaticFileCache.create(clientDir);

    expect(cache.lookup("/assets/chunks/vendor-aaa.js")).toBeDefined();
    expect(cache.lookup("/assets/chunks/lazy/page-bbb.js")).toBeDefined();
  });
});
