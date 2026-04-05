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
    expect(entry!.original.headers["Content-Type"]).toBe("application/javascript");
    expect(entry!.original.headers["Content-Length"]).toBe("12"); // "const x = 1;"
    expect(entry!.original.path).toBe(path.join(clientDir, "assets/index-abc123.js"));
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

    expect(entry!.original.headers["Cache-Control"]).toBe("public, max-age=31536000, immutable");
  });

  it("sets short cache-control for non-hashed files", async () => {
    await writeFile(clientDir, "favicon.ico", "icon-data");

    const cache = await StaticFileCache.create(clientDir);
    const entry = cache.lookup("/favicon.ico");

    expect(entry!.original.headers["Cache-Control"]).toBe("public, max-age=3600");
  });

  it("generates weak etag from filename hash for hashed assets", async () => {
    await writeFile(clientDir, "assets/app-abc123.css", ".body { margin: 0; }");

    const cache = await StaticFileCache.create(clientDir);
    const entry = cache.lookup("/assets/app-abc123.css");

    // Hashed assets use the content hash from the filename
    expect(entry!.etag).toBe('W/"abc123"');
  });

  it("falls back to mtime etag for non-hashed files", async () => {
    await writeFile(clientDir, "favicon.ico", "icon");

    const cache = await StaticFileCache.create(clientDir);
    const entry = cache.lookup("/favicon.ico");

    expect(entry!.etag).toMatch(/^W\/"\d+-\d+"$/);
  });

  it("falls back to mtime etag for assets without hash suffix", async () => {
    await writeFile(clientDir, "assets/logo.svg", "<svg></svg>");

    const cache = await StaticFileCache.create(clientDir);
    const entry = cache.lookup("/assets/logo.svg");

    // No hash in filename — falls back to mtime-based ETag
    expect(entry!.etag).toMatch(/^W\/"\d+-\d+"$/);
  });

  it("does not treat non-hash suffixes as hashed asset etags", async () => {
    await writeFile(clientDir, "assets/my-library-v2.0.0.js", "export {};");

    const cache = await StaticFileCache.create(clientDir);
    const entry = cache.lookup("/assets/my-library-v2.0.0.js");

    expect(entry!.etag).toMatch(/^W\/"\d+-\d+"$/);
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

    expect(entry!.br?.path).toBe(path.join(clientDir, "assets/app-abc123.js.br"));
    expect(entry!.br?.headers["Content-Length"]).toBe(String(brContent.length));
  });

  it("detects gzip precompressed variant", async () => {
    const content = "body { margin: 0; }\n".repeat(200);
    await writeFile(clientDir, "assets/styles-def456.css", content);
    const gzContent = zlib.gzipSync(Buffer.from(content));
    await writeFile(clientDir, "assets/styles-def456.css.gz", gzContent);

    const cache = await StaticFileCache.create(clientDir);
    const entry = cache.lookup("/assets/styles-def456.css");

    expect(entry!.gz?.path).toBe(path.join(clientDir, "assets/styles-def456.css.gz"));
    expect(entry!.gz?.headers["Content-Length"]).toBe(String(gzContent.length));
  });

  it("detects zstandard precompressed variant", async () => {
    const content = "const zstd = true;\n".repeat(200);
    await writeFile(clientDir, "assets/app-zstd.js", content);
    const zstdContent = zlib.zstdCompressSync(Buffer.from(content));
    await writeFile(clientDir, "assets/app-zstd.js.zst", zstdContent);

    const cache = await StaticFileCache.create(clientDir);
    const entry = cache.lookup("/assets/app-zstd.js");

    expect(entry!.zst?.path).toBe(path.join(clientDir, "assets/app-zstd.js.zst"));
    expect(entry!.zst?.headers["Content-Length"]).toBe(String(zstdContent.length));
  });

  it("sets Vary: Accept-Encoding on original variant when compressed siblings exist", async () => {
    const content = "const x = 1;\n".repeat(200);
    await writeFile(clientDir, "assets/app-abc123.js", content);
    await writeFile(
      clientDir,
      "assets/app-abc123.js.br",
      zlib.brotliCompressSync(Buffer.from(content)),
    );

    const cache = await StaticFileCache.create(clientDir);
    const entry = cache.lookup("/assets/app-abc123.js");

    expect(entry!.original.headers["Vary"]).toBe("Accept-Encoding");
  });

  it("omits Vary on original variant when no compressed siblings exist", async () => {
    await writeFile(clientDir, "favicon.ico", "icon-data");

    const cache = await StaticFileCache.create(clientDir);
    const entry = cache.lookup("/favicon.ico");

    expect(entry!.original.headers["Vary"]).toBeUndefined();
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
    expect(entry!.original.path).toBe(path.join(clientDir, "about.html"));
    expect(entry!.original.headers["Content-Type"]).toBe("text/html");
  });

  it("resolves /index.html fallback for directory paths", async () => {
    await writeFile(clientDir, "blog/index.html", "<html>Blog</html>");

    const cache = await StaticFileCache.create(clientDir);
    const entry = cache.lookup("/blog");

    expect(entry).toBeDefined();
    expect(entry!.original.path).toBe(path.join(clientDir, "blog/index.html"));
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

    expect(cache.lookup("/assets/style-aaa.css")!.original.headers["Content-Type"]).toBe(
      "text/css",
    );
    expect(cache.lookup("/assets/data-bbb.json")!.original.headers["Content-Type"]).toBe(
      "application/json",
    );
    expect(cache.lookup("/logo.svg")!.original.headers["Content-Type"]).toBe("image/svg+xml");
    expect(cache.lookup("/photo.webp")!.original.headers["Content-Type"]).toBe("image/webp");
  });

  it("falls back to application/octet-stream for unknown extensions", async () => {
    await writeFile(clientDir, "assets/data-ccc.xyz", "unknown-data");

    const cache = await StaticFileCache.create(clientDir);

    expect(cache.lookup("/assets/data-ccc.xyz")!.original.headers["Content-Type"]).toBe(
      "application/octet-stream",
    );
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
