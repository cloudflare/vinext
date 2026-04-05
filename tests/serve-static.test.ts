/**
 * Tests for the refactored tryServeStatic that uses StaticFileCache
 * and serves precompressed assets without runtime compression overhead.
 */
import { describe, it, expect, beforeEach, afterEach } from "vite-plus/test";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import zlib from "node:zlib";
import { StaticFileCache } from "../packages/vinext/src/server/static-file-cache.js";
import { tryServeStatic } from "../packages/vinext/src/server/prod-server.js";
import type { IncomingMessage, ServerResponse } from "node:http";

async function writeFile(
  clientDir: string,
  relativePath: string,
  content: string | Buffer,
): Promise<void> {
  const fullPath = path.join(clientDir, relativePath);
  await fsp.mkdir(path.dirname(fullPath), { recursive: true });
  await fsp.writeFile(fullPath, content);
}

/**
 * Create a mock request with optional headers and method.
 */
function mockReq(
  acceptEncoding?: string,
  extraHeaders?: Record<string, string>,
  method: string = "GET",
): IncomingMessage {
  const headers: Record<string, string> = { ...extraHeaders };
  if (acceptEncoding) headers["accept-encoding"] = acceptEncoding;
  return { headers, method } as unknown as IncomingMessage;
}

type CapturedResponse = {
  status: number;
  headers: Record<string, string | string[]>;
  body: Buffer;
  ended: Promise<void>;
};

/**
 * Create a mock response that captures writeHead + streamed/ended body data.
 */
function mockRes(): { res: ServerResponse; captured: CapturedResponse } {
  const chunks: Buffer[] = [];
  let resolveEnded: () => void;
  const ended = new Promise<void>((r) => {
    resolveEnded = r;
  });

  const captured: CapturedResponse = {
    status: 0,
    headers: {},
    body: Buffer.alloc(0),
    ended,
  };

  const res = {
    writeHead(status: number, headers: Record<string, string | string[]>) {
      captured.status = status;
      captured.headers = headers;
    },
    write(chunk: Buffer | string) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      return true;
    },
    end(chunk?: Buffer | string) {
      if (chunk) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      captured.body = Buffer.concat(chunks);
      resolveEnded!();
    },
    on(_event: string, _handler: (...args: unknown[]) => void) {
      return res;
    },
    once(_event: string, _handler: (...args: unknown[]) => void) {
      return res;
    },
    emit() {
      return false;
    },
    removeListener() {
      return res;
    },
  } as unknown as ServerResponse;

  return { res, captured };
}

describe("tryServeStatic (with StaticFileCache)", () => {
  let clientDir: string;

  beforeEach(async () => {
    clientDir = path.join(
      os.tmpdir(),
      `vinext-serve-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await fsp.mkdir(clientDir, { recursive: true });
  });

  afterEach(async () => {
    await fsp.rm(clientDir, { recursive: true, force: true });
  });

  // ── Precompressed serving ──────────────────────────────────────

  it("serves precompressed brotli for hashed assets when client accepts br", async () => {
    const jsContent = "const app = () => {};\n".repeat(200);
    await writeFile(clientDir, "assets/app-abc123.js", jsContent);
    const brContent = zlib.brotliCompressSync(Buffer.from(jsContent));
    await writeFile(clientDir, "assets/app-abc123.js.br", brContent);

    const cache = await StaticFileCache.create(clientDir);
    const req = mockReq("gzip, deflate, br");
    const { res, captured } = mockRes();

    const served = await tryServeStatic(req, res, clientDir, "/assets/app-abc123.js", true, cache);

    await captured.ended;
    expect(served).toBe(true);
    expect(captured.headers["Content-Encoding"]).toBe("br");
    expect(captured.headers["Content-Length"]).toBe(String(brContent.length));
    expect(captured.headers["Content-Type"]).toBe("application/javascript");
    // Body should be the precompressed brotli content
    const decompressed = zlib.brotliDecompressSync(captured.body).toString();
    expect(decompressed).toBe(jsContent);
  });

  it("serves precompressed gzip when client accepts gzip but not br", async () => {
    const cssContent = ".app { display: flex; }\n".repeat(200);
    await writeFile(clientDir, "assets/styles-def456.css", cssContent);
    const gzContent = zlib.gzipSync(Buffer.from(cssContent));
    await writeFile(clientDir, "assets/styles-def456.css.gz", gzContent);

    const cache = await StaticFileCache.create(clientDir);
    const req = mockReq("gzip, deflate");
    const { res, captured } = mockRes();

    const served = await tryServeStatic(
      req,
      res,
      clientDir,
      "/assets/styles-def456.css",
      true,
      cache,
    );

    await captured.ended;
    expect(served).toBe(true);
    expect(captured.headers["Content-Encoding"]).toBe("gzip");
    expect(captured.headers["Content-Length"]).toBe(String(gzContent.length));
  });

  it("serves original file with Content-Length when no encoding accepted", async () => {
    const jsContent = "const x = 1;\n".repeat(200);
    await writeFile(clientDir, "assets/plain-ghi789.js", jsContent);

    const cache = await StaticFileCache.create(clientDir);
    const req = mockReq(); // no Accept-Encoding
    const { res, captured } = mockRes();

    const served = await tryServeStatic(
      req,
      res,
      clientDir,
      "/assets/plain-ghi789.js",
      true,
      cache,
    );

    await captured.ended;
    expect(served).toBe(true);
    expect(captured.headers["Content-Encoding"]).toBeUndefined();
    expect(captured.headers["Content-Length"]).toBe(String(jsContent.length));
  });

  it("preserves a non-200 status override for cached static files", async () => {
    const jsContent = "export const blocked = true;\n";
    await writeFile(clientDir, "assets/status-override-abc123.js", jsContent);

    const cache = await StaticFileCache.create(clientDir);
    const req = mockReq(undefined, { "if-none-match": 'W/"abc123"' });
    const { res, captured } = mockRes();

    const served = await tryServeStatic(
      req,
      res,
      clientDir,
      "/assets/status-override-abc123.js",
      true,
      cache,
      { "x-middleware": "blocked" },
      403,
    );

    await captured.ended;
    expect(served).toBe(true);
    expect(captured.status).toBe(403);
    expect(captured.headers["x-middleware"]).toBe("blocked");
    expect(captured.headers["ETag"]).toBe('W/"abc123"');
    expect(captured.body.toString()).toBe(jsContent);
  });

  // ── Cache miss / non-existent ──────────────────────────────────

  it("returns false for non-existent files", async () => {
    const cache = await StaticFileCache.create(clientDir);
    const req = mockReq("br");
    const { res } = mockRes();

    const served = await tryServeStatic(req, res, clientDir, "/assets/nope-xxx999.js", true, cache);

    expect(served).toBe(false);
  });

  // ── immutable cache-control on hashed assets ───────────────────

  it("sets immutable cache-control for /assets/ files", async () => {
    await writeFile(clientDir, "assets/chunk-aaa111.js", "code".repeat(100));

    const cache = await StaticFileCache.create(clientDir);
    const req = mockReq();
    const { res, captured } = mockRes();

    await tryServeStatic(req, res, clientDir, "/assets/chunk-aaa111.js", true, cache);

    await captured.ended;
    expect(captured.headers["Cache-Control"]).toBe("public, max-age=31536000, immutable");
  });

  // ── Extra headers merging ──────────────────────────────────────

  it("merges extra headers into the response", async () => {
    await writeFile(clientDir, "photo.jpg", Buffer.alloc(100));

    const cache = await StaticFileCache.create(clientDir);
    const req = mockReq();
    const { res, captured } = mockRes();

    const extraHeaders = { "X-Custom": "value", "Content-Security-Policy": "default-src 'self'" };
    await tryServeStatic(req, res, clientDir, "/photo.jpg", false, cache, extraHeaders);

    await captured.ended;
    expect(captured.headers["X-Custom"]).toBe("value");
    expect(captured.headers["Content-Security-Policy"]).toBe("default-src 'self'");
  });

  // ── Vary header ────────────────────────────────────────────────

  it("sets Vary: Accept-Encoding when serving precompressed content", async () => {
    const jsContent = "code\n".repeat(500);
    await writeFile(clientDir, "assets/vary-bbb222.js", jsContent);
    await writeFile(
      clientDir,
      "assets/vary-bbb222.js.br",
      zlib.brotliCompressSync(Buffer.from(jsContent)),
    );

    const cache = await StaticFileCache.create(clientDir);
    const req = mockReq("br");
    const { res, captured } = mockRes();

    await tryServeStatic(req, res, clientDir, "/assets/vary-bbb222.js", true, cache);

    await captured.ended;
    expect(captured.headers["Vary"]).toBe("Accept-Encoding");
  });

  // ── Directory traversal protection ─────────────────────────────

  it("blocks directory traversal attempts", async () => {
    await writeFile(clientDir, "assets/safe-ccc333.js", "safe");

    const cache = await StaticFileCache.create(clientDir);
    const req = mockReq();
    const { res } = mockRes();

    const served = await tryServeStatic(req, res, clientDir, "/../../../etc/passwd", true, cache);

    expect(served).toBe(false);
  });

  it("blocks .vite/ internal directory access", async () => {
    await writeFile(clientDir, ".vite/manifest.json", "{}");

    const cache = await StaticFileCache.create(clientDir);
    const req = mockReq();
    const { res } = mockRes();

    const served = await tryServeStatic(req, res, clientDir, "/.vite/manifest.json", true, cache);

    expect(served).toBe(false);
  });

  // ── Async operation (no event loop blocking) ───────────────────

  it("returns a Promise (async function)", async () => {
    const cache = await StaticFileCache.create(clientDir);
    const req = mockReq();
    const { res } = mockRes();

    const result = tryServeStatic(req, res, clientDir, "/nope", true, cache);

    // Must return a Promise, not a boolean
    expect(result).toBeInstanceOf(Promise);
  });

  // ── 304 Not Modified (conditional requests) ────────────────────

  it("returns 304 when If-None-Match matches the ETag", async () => {
    await writeFile(clientDir, "assets/cached-aaa111.js", "cached content");

    const cache = await StaticFileCache.create(clientDir);
    const entry = cache.lookup("/assets/cached-aaa111.js");
    const etag = entry!.etag;

    const req = mockReq(undefined, { "if-none-match": etag });
    const { res, captured } = mockRes();

    const served = await tryServeStatic(
      req,
      res,
      clientDir,
      "/assets/cached-aaa111.js",
      true,
      cache,
    );

    await captured.ended;
    expect(served).toBe(true);
    expect(captured.status).toBe(304);
    expect(captured.body.length).toBe(0); // no body on 304
  });

  it("returns 304 when If-None-Match contains the ETag in a comma-separated list", async () => {
    await writeFile(clientDir, "assets/cached-list-aaa111.js", "cached content");

    const cache = await StaticFileCache.create(clientDir);
    const entry = cache.lookup("/assets/cached-list-aaa111.js");
    const etag = entry!.etag;

    const req = mockReq(undefined, {
      "if-none-match": `W/"other", ${etag}, W/"another"`,
    });
    const { res, captured } = mockRes();

    const served = await tryServeStatic(
      req,
      res,
      clientDir,
      "/assets/cached-list-aaa111.js",
      true,
      cache,
    );

    await captured.ended;
    expect(served).toBe(true);
    expect(captured.status).toBe(304);
    expect(captured.body.length).toBe(0);
  });

  it("returns 200 when If-None-Match does not match", async () => {
    await writeFile(clientDir, "assets/stale-bbb222.js", "new content");

    const cache = await StaticFileCache.create(clientDir);
    const req = mockReq(undefined, { "if-none-match": 'W/"999-0"' });
    const { res, captured } = mockRes();

    const served = await tryServeStatic(
      req,
      res,
      clientDir,
      "/assets/stale-bbb222.js",
      true,
      cache,
    );

    await captured.ended;
    expect(served).toBe(true);
    expect(captured.status).toBe(200);
    expect(captured.body.length).toBeGreaterThan(0);
  });

  it("returns 200 when no If-None-Match header is present", async () => {
    await writeFile(clientDir, "assets/fresh-ccc333.js", "fresh content");

    const cache = await StaticFileCache.create(clientDir);
    const req = mockReq();
    const { res, captured } = mockRes();

    await tryServeStatic(req, res, clientDir, "/assets/fresh-ccc333.js", true, cache);

    await captured.ended;
    expect(captured.status).toBe(200);
  });

  it("304 response excludes Content-Type per RFC 9110", async () => {
    await writeFile(clientDir, "assets/rfc-aaa111.js", "rfc content");

    const cache = await StaticFileCache.create(clientDir);
    const entry = cache.lookup("/assets/rfc-aaa111.js");

    const req = mockReq(undefined, { "if-none-match": entry!.etag });
    const { res, captured } = mockRes();

    await tryServeStatic(req, res, clientDir, "/assets/rfc-aaa111.js", true, cache);

    await captured.ended;
    expect(captured.status).toBe(304);
    expect(captured.headers["Content-Type"]).toBeUndefined();
  });

  it("304 response includes ETag and Cache-Control but no Content-Length", async () => {
    await writeFile(clientDir, "assets/headers-ddd444.js", "header test content");

    const cache = await StaticFileCache.create(clientDir);
    const entry = cache.lookup("/assets/headers-ddd444.js");

    const req = mockReq(undefined, { "if-none-match": entry!.etag });
    const { res, captured } = mockRes();

    await tryServeStatic(req, res, clientDir, "/assets/headers-ddd444.js", true, cache);

    await captured.ended;
    expect(captured.status).toBe(304);
    expect(captured.headers["ETag"]).toBe(entry!.etag);
    expect(captured.headers["Cache-Control"]).toBe("public, max-age=31536000, immutable");
    expect(captured.headers["Content-Length"]).toBeUndefined();
  });

  // ── HEAD request optimization ──────────────────────────────────

  it("HEAD request returns headers without streaming body", async () => {
    const jsContent = "const x = 1;\n".repeat(200);
    await writeFile(clientDir, "assets/head-eee555.js", jsContent);

    const cache = await StaticFileCache.create(clientDir);
    const req = mockReq(undefined, undefined, "HEAD");
    const { res, captured } = mockRes();

    const served = await tryServeStatic(req, res, clientDir, "/assets/head-eee555.js", true, cache);

    await captured.ended;
    expect(served).toBe(true);
    expect(captured.status).toBe(200);
    expect(captured.headers["Content-Type"]).toBe("application/javascript");
    expect(captured.headers["Content-Length"]).toBe(String(jsContent.length));
    expect(captured.body.length).toBe(0); // no body for HEAD
  });

  it("HEAD request includes compressed Content-Length when precompressed variant exists", async () => {
    const jsContent = "const app = () => {};\n".repeat(200);
    await writeFile(clientDir, "assets/head-br-fff666.js", jsContent);
    const brContent = zlib.brotliCompressSync(Buffer.from(jsContent));
    await writeFile(clientDir, "assets/head-br-fff666.js.br", brContent);

    const cache = await StaticFileCache.create(clientDir);
    const req = mockReq("br", undefined, "HEAD");
    const { res, captured } = mockRes();

    await tryServeStatic(req, res, clientDir, "/assets/head-br-fff666.js", true, cache);

    await captured.ended;
    expect(captured.status).toBe(200);
    expect(captured.headers["Content-Encoding"]).toBe("br");
    expect(captured.headers["Content-Length"]).toBe(String(brContent.length));
    expect(captured.body.length).toBe(0);
  });

  // ── Zstandard precompressed serving ────────────────────────────

  it("serves precompressed zstd when client accepts zstd", async () => {
    const jsContent = "const zstd = true;\n".repeat(200);
    await writeFile(clientDir, "assets/zstd-ggg777.js", jsContent);
    const zstdContent = zlib.zstdCompressSync(Buffer.from(jsContent));
    await writeFile(clientDir, "assets/zstd-ggg777.js.zst", zstdContent);

    const cache = await StaticFileCache.create(clientDir);
    const req = mockReq("zstd, br, gzip");
    const { res, captured } = mockRes();

    const served = await tryServeStatic(req, res, clientDir, "/assets/zstd-ggg777.js", true, cache);

    await captured.ended;
    expect(served).toBe(true);
    expect(captured.headers["Content-Encoding"]).toBe("zstd");
    expect(captured.headers["Content-Length"]).toBe(String(zstdContent.length));
    // Verify content decompresses correctly
    const decompressed = zlib.zstdDecompressSync(captured.body).toString();
    expect(decompressed).toBe(jsContent);
  });

  it("prefers zstd over br when both accepted and available", async () => {
    const jsContent = "const priority = true;\n".repeat(200);
    await writeFile(clientDir, "assets/priority-hhh888.js", jsContent);
    await writeFile(
      clientDir,
      "assets/priority-hhh888.js.zst",
      zlib.zstdCompressSync(Buffer.from(jsContent)),
    );
    await writeFile(
      clientDir,
      "assets/priority-hhh888.js.br",
      zlib.brotliCompressSync(Buffer.from(jsContent)),
    );

    const cache = await StaticFileCache.create(clientDir);
    const req = mockReq("zstd, br, gzip");
    const { res, captured } = mockRes();

    await tryServeStatic(req, res, clientDir, "/assets/priority-hhh888.js", true, cache);

    await captured.ended;
    expect(captured.headers["Content-Encoding"]).toBe("zstd");
  });

  it("falls back to br when zstd accepted but no .zst file exists", async () => {
    const jsContent = "const fallback = true;\n".repeat(200);
    await writeFile(clientDir, "assets/fallback-iii999.js", jsContent);
    await writeFile(
      clientDir,
      "assets/fallback-iii999.js.br",
      zlib.brotliCompressSync(Buffer.from(jsContent)),
    );
    // No .zst file

    const cache = await StaticFileCache.create(clientDir);
    const req = mockReq("zstd, br, gzip");
    const { res, captured } = mockRes();

    await tryServeStatic(req, res, clientDir, "/assets/fallback-iii999.js", true, cache);

    await captured.ended;
    expect(captured.headers["Content-Encoding"]).toBe("br");
  });

  // ── Slow path (no cache) ───────────────────────────────────────

  it("slow path serves static file without cache", async () => {
    await writeFile(clientDir, "assets/nocache-aaa111.js", "slow path content");

    const req = mockReq();
    const { res, captured } = mockRes();

    const served = await tryServeStatic(req, res, clientDir, "/assets/nocache-aaa111.js", false);

    await captured.ended;
    expect(served).toBe(true);
    expect(captured.status).toBe(200);
    expect(captured.headers["Content-Type"]).toBe("application/javascript");
    expect(captured.body.toString()).toBe("slow path content");
  });

  it("slow path returns false for non-existent files", async () => {
    const req = mockReq();
    const { res } = mockRes();

    const served = await tryServeStatic(req, res, clientDir, "/nope.js", false);

    expect(served).toBe(false);
  });

  it("slow path serves HEAD without body", async () => {
    await writeFile(clientDir, "assets/head-slow-bbb222.js", "head content");

    const req = mockReq(undefined, undefined, "HEAD");
    const { res, captured } = mockRes();

    const served = await tryServeStatic(req, res, clientDir, "/assets/head-slow-bbb222.js", false);

    await captured.ended;
    expect(served).toBe(true);
    expect(captured.status).toBe(200);
    expect(captured.headers["Content-Length"]).toBe(String("head content".length));
    expect(captured.body.length).toBe(0);
  });

  it("slow path serves HEAD without body for compressed response", async () => {
    await writeFile(clientDir, "assets/head-slow-comp-ccc333.js", "compress me");

    const req = mockReq("br", undefined, "HEAD");
    const { res, captured } = mockRes();

    const served = await tryServeStatic(
      req,
      res,
      clientDir,
      "/assets/head-slow-comp-ccc333.js",
      true,
    );

    await captured.ended;
    expect(served).toBe(true);
    expect(captured.status).toBe(200);
    expect(captured.headers["Content-Encoding"]).toBe("br");
    expect(captured.body.length).toBe(0);
  });

  // ── Malformed pathname handling ─────────────────────────────────

  it("returns false for malformed percent-encoded pathname", async () => {
    await writeFile(clientDir, "assets/safe-ddd444.js", "safe");

    const cache = await StaticFileCache.create(clientDir);
    const req = mockReq();
    const { res } = mockRes();

    const served = await tryServeStatic(req, res, clientDir, "/%E0%A4%A", true, cache);

    expect(served).toBe(false);
  });

  it("slow path returns false for malformed percent-encoded pathname", async () => {
    const req = mockReq();
    const { res } = mockRes();

    const served = await tryServeStatic(req, res, clientDir, "/%E0%A4%A", false);

    expect(served).toBe(false);
  });

  // ── Slow path 304 (conditional requests) ───────────────────────

  it("slow path returns 304 for hashed asset with matching filename-hash ETag", async () => {
    await writeFile(clientDir, "assets/etag-slow-abc123.js", "etag content");

    // The slow path computes a filename-hash ETag for /assets/* files.
    // Derive the expected ETag the same way etagFromFilenameHash does.
    const req = mockReq(undefined, { "if-none-match": 'W/"abc123"' });
    const { res, captured } = mockRes();

    const served = await tryServeStatic(req, res, clientDir, "/assets/etag-slow-abc123.js", true);

    await captured.ended;
    expect(served).toBe(true);
    expect(captured.status).toBe(304);
    expect(captured.body.length).toBe(0);
    expect(captured.headers["ETag"]).toBe('W/"abc123"');
    expect(captured.headers["Cache-Control"]).toBe("public, max-age=31536000, immutable");
  });

  it("slow path returns 200 when ETag does not match", async () => {
    await writeFile(clientDir, "assets/etag-slow-miss-xyz999.js", "fresh content");

    const req = mockReq(undefined, { "if-none-match": 'W/"stale-etag"' });
    const { res, captured } = mockRes();

    const served = await tryServeStatic(
      req,
      res,
      clientDir,
      "/assets/etag-slow-miss-xyz999.js",
      true,
    );

    await captured.ended;
    expect(served).toBe(true);
    expect(captured.status).toBe(200);
    expect(captured.body.length).toBeGreaterThan(0);
  });

  it("slow path 304 includes Vary: Accept-Encoding for compressible content", async () => {
    await writeFile(clientDir, "assets/vary-slow-abc123.js", "vary content");

    const req = mockReq(undefined, { "if-none-match": 'W/"abc123"' });
    const { res, captured } = mockRes();

    await tryServeStatic(req, res, clientDir, "/assets/vary-slow-abc123.js", true);

    await captured.ended;
    expect(captured.status).toBe(304);
    expect(captured.headers["Vary"]).toBe("Accept-Encoding");
  });

  it("slow path 304 omits Vary for non-compressible content (compress=false)", async () => {
    await writeFile(clientDir, "photo.jpg", Buffer.alloc(100, 0xff));

    // jpg mtime-based etag — we need to stat the file to get the right etag
    const stat = await fsp.stat(path.join(clientDir, "photo.jpg"));
    const etag = `W/"${stat.size}-${Math.floor(stat.mtimeMs / 1000)}"`;

    const req = mockReq(undefined, { "if-none-match": etag });
    const { res, captured } = mockRes();

    await tryServeStatic(req, res, clientDir, "/photo.jpg", false);

    await captured.ended;
    expect(captured.status).toBe(304);
    expect(captured.headers["Vary"]).toBeUndefined();
  });
});
