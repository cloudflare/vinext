/**
 * Tests for build-time precompression of hashed static assets.
 *
 * precompressAssets() runs after `vinext build` and generates .br (brotli) and
 * .gz (gzip) files alongside compressible hashed assets in dist/client/assets/.
 * This eliminates per-request compression overhead for immutable build output.
 */
import { describe, it, expect, beforeEach, afterEach } from "vite-plus/test";
import fsp from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import zlib from "node:zlib";
import { precompressAssets } from "../packages/vinext/src/build/precompress.js";

/** Write a file with repeated content to ensure it exceeds compression threshold. */
async function writeAsset(clientDir: string, relativePath: string, content: string): Promise<void> {
  const fullPath = path.join(clientDir, relativePath);
  await fsp.mkdir(path.dirname(fullPath), { recursive: true });
  await fsp.writeFile(fullPath, content);
}

describe("precompressAssets", () => {
  let clientDir: string;

  beforeEach(async () => {
    clientDir = path.join(
      os.tmpdir(),
      `vinext-precompress-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await fsp.mkdir(clientDir, { recursive: true });
  });

  afterEach(async () => {
    await fsp.rm(clientDir, { recursive: true, force: true });
  });

  it("generates .br and .gz files for compressible hashed assets", async () => {
    const jsContent = "const x = 1;\n".repeat(200); // well above 1KB threshold
    await writeAsset(clientDir, "assets/index-abc123.js", jsContent);

    const result = await precompressAssets(clientDir);

    // Both compressed variants should exist on disk
    expect(fs.existsSync(path.join(clientDir, "assets/index-abc123.js.br"))).toBe(true);
    expect(fs.existsSync(path.join(clientDir, "assets/index-abc123.js.gz"))).toBe(true);

    // Result should report what was compressed
    expect(result.filesCompressed).toBe(1);
  });

  it("brotli output decompresses to original content", async () => {
    const jsContent = "export function hello() { return 'world'; }\n".repeat(100);
    await writeAsset(clientDir, "assets/hello-def456.js", jsContent);

    await precompressAssets(clientDir);

    const brBuffer = await fsp.readFile(path.join(clientDir, "assets/hello-def456.js.br"));
    const decompressed = zlib.brotliDecompressSync(brBuffer).toString();
    expect(decompressed).toBe(jsContent);
  });

  it("gzip output decompresses to original content", async () => {
    const cssContent = ".container { display: flex; }\n".repeat(100);
    await writeAsset(clientDir, "assets/styles-789abc.css", cssContent);

    await precompressAssets(clientDir);

    const gzBuffer = await fsp.readFile(path.join(clientDir, "assets/styles-789abc.css.gz"));
    const decompressed = zlib.gunzipSync(gzBuffer).toString();
    expect(decompressed).toBe(cssContent);
  });

  it("skips files below the compression threshold", async () => {
    // Tiny file — not worth compressing
    await writeAsset(clientDir, "assets/tiny-aaa111.js", "const x = 1;");

    const result = await precompressAssets(clientDir);

    expect(fs.existsSync(path.join(clientDir, "assets/tiny-aaa111.js.br"))).toBe(false);
    expect(fs.existsSync(path.join(clientDir, "assets/tiny-aaa111.js.gz"))).toBe(false);
    expect(result.filesCompressed).toBe(0);
  });

  it("skips non-compressible file types (images, fonts)", async () => {
    // PNG file (binary, already compressed)
    const pngHeader = Buffer.alloc(2048, 0x89); // fake PNG data, above threshold
    await writeAsset(clientDir, "assets/logo-bbb222.png", pngHeader.toString("binary"));

    // WOFF2 font (already compressed)
    const fontData = Buffer.alloc(2048, 0x77);
    await writeAsset(clientDir, "assets/font-ccc333.woff2", fontData.toString("binary"));

    const result = await precompressAssets(clientDir);

    expect(fs.existsSync(path.join(clientDir, "assets/logo-bbb222.png.br"))).toBe(false);
    expect(fs.existsSync(path.join(clientDir, "assets/font-ccc333.woff2.br"))).toBe(false);
    expect(result.filesCompressed).toBe(0);
  });

  it("returns empty result for missing assets/ directory", async () => {
    // clientDir exists but has no assets/ subdirectory
    const result = await precompressAssets(clientDir);

    expect(result.filesCompressed).toBe(0);
    expect(result.totalOriginalBytes).toBe(0);
    expect(result.totalBrotliBytes).toBe(0);
  });

  it("compresses CSS files alongside JS", async () => {
    const jsContent = "function render() {}\n".repeat(200);
    const cssContent = "body { margin: 0; }\n".repeat(200);
    await writeAsset(clientDir, "assets/app-aaa111.js", jsContent);
    await writeAsset(clientDir, "assets/app-bbb222.css", cssContent);

    const result = await precompressAssets(clientDir);

    expect(result.filesCompressed).toBe(2);
    expect(fs.existsSync(path.join(clientDir, "assets/app-aaa111.js.br"))).toBe(true);
    expect(fs.existsSync(path.join(clientDir, "assets/app-bbb222.css.br"))).toBe(true);
  });

  it("does not re-compress existing .br or .gz files", async () => {
    const jsContent = "const x = 1;\n".repeat(200);
    await writeAsset(clientDir, "assets/index-abc123.js", jsContent);

    // Run twice — should not create .br.br or .gz.gz
    await precompressAssets(clientDir);
    await precompressAssets(clientDir);

    expect(fs.existsSync(path.join(clientDir, "assets/index-abc123.js.br.br"))).toBe(false);
    expect(fs.existsSync(path.join(clientDir, "assets/index-abc123.js.gz.gz"))).toBe(false);
  });

  it("handles nested directories under assets/", async () => {
    const jsContent = "export default {}\n".repeat(200);
    await writeAsset(clientDir, "assets/chunks/vendor-ddd444.js", jsContent);

    const result = await precompressAssets(clientDir);

    expect(result.filesCompressed).toBe(1);
    expect(fs.existsSync(path.join(clientDir, "assets/chunks/vendor-ddd444.js.br"))).toBe(true);
    expect(fs.existsSync(path.join(clientDir, "assets/chunks/vendor-ddd444.js.gz"))).toBe(true);
  });

  it("only compresses files inside assets/ not other client files", async () => {
    const htmlContent = "<html><body>hello</body></html>\n".repeat(100);
    const jsContent = "const x = 1;\n".repeat(200);
    // This file is in client root, not in assets/ — should not be compressed
    await writeAsset(clientDir, "index.html", htmlContent);
    // This one is in assets/ — should be compressed
    await writeAsset(clientDir, "assets/main-eee555.js", jsContent);

    const result = await precompressAssets(clientDir);

    expect(result.filesCompressed).toBe(1);
    expect(fs.existsSync(path.join(clientDir, "index.html.br"))).toBe(false);
    expect(fs.existsSync(path.join(clientDir, "assets/main-eee555.js.br"))).toBe(true);
  });

  it("generates .zst files alongside .br and .gz", async () => {
    const jsContent = "const x = 1;\n".repeat(200);
    await writeAsset(clientDir, "assets/zstd-aaa111.js", jsContent);

    const result = await precompressAssets(clientDir);

    expect(fs.existsSync(path.join(clientDir, "assets/zstd-aaa111.js.zst"))).toBe(true);
    expect(fs.existsSync(path.join(clientDir, "assets/zstd-aaa111.js.br"))).toBe(true);
    expect(fs.existsSync(path.join(clientDir, "assets/zstd-aaa111.js.gz"))).toBe(true);
    expect(result.filesCompressed).toBe(1);
  });

  it("zstd output decompresses to original content", async () => {
    const jsContent = "export function hello() { return 'world'; }\n".repeat(100);
    await writeAsset(clientDir, "assets/hello-zstd.js", jsContent);

    await precompressAssets(clientDir);

    const zstdBuffer = await fsp.readFile(path.join(clientDir, "assets/hello-zstd.js.zst"));
    const decompressed = zlib.zstdDecompressSync(zstdBuffer).toString();
    expect(decompressed).toBe(jsContent);
  });

  it("reports total original and compressed byte sizes", async () => {
    const jsContent = "const x = 1;\n".repeat(500);
    await writeAsset(clientDir, "assets/big-fff666.js", jsContent);

    const result = await precompressAssets(clientDir);

    expect(result.totalOriginalBytes).toBe(jsContent.length);
    // Compressed should be smaller than original for repetitive content
    expect(result.totalBrotliBytes).toBeGreaterThan(0);
    expect(result.totalBrotliBytes).toBeLessThan(result.totalOriginalBytes);
  });
});
