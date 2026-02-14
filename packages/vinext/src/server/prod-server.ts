/**
 * Production server for vinext.
 *
 * Serves the built output from `vinext build`. Handles:
 * - Static asset serving from client build output
 * - SSR rendering for page routes
 * - API route handling
 * - Gzip/Brotli compression for text-based responses
 *
 * The build output is expected to have:
 * - dist/client/  — static assets (JS, CSS, images) + .vite/ssr-manifest.json
 * - dist/server/entry.js — SSR entry point (virtual:vinext-server-entry)
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { pipeline } from "node:stream";

export interface ProdServerOptions {
  /** Port to listen on */
  port?: number;
  /** Host to bind to */
  host?: string;
  /** Path to the build output directory */
  outDir?: string;
  /** Disable compression (default: false) */
  noCompression?: boolean;
}

/** Content types that benefit from compression. */
const COMPRESSIBLE_TYPES = new Set([
  "text/html",
  "text/css",
  "text/plain",
  "text/xml",
  "text/javascript",
  "application/javascript",
  "application/json",
  "application/xml",
  "application/xhtml+xml",
  "application/rss+xml",
  "application/atom+xml",
  "image/svg+xml",
  "application/manifest+json",
  "application/wasm",
]);

/** Minimum size threshold for compression (in bytes). Below this, compression overhead isn't worth it. */
const COMPRESS_THRESHOLD = 1024;

/**
 * Parse the Accept-Encoding header and return the best supported encoding.
 * Preference order: br > gzip > deflate > identity.
 */
function negotiateEncoding(req: IncomingMessage): "br" | "gzip" | "deflate" | null {
  const accept = req.headers["accept-encoding"];
  if (!accept || typeof accept !== "string") return null;
  const lower = accept.toLowerCase();
  if (lower.includes("br")) return "br";
  if (lower.includes("gzip")) return "gzip";
  if (lower.includes("deflate")) return "deflate";
  return null;
}

/**
 * Create a compression stream for the given encoding.
 */
function createCompressor(encoding: "br" | "gzip" | "deflate"): zlib.BrotliCompress | zlib.Gzip | zlib.Deflate {
  switch (encoding) {
    case "br":
      return zlib.createBrotliCompress({
        params: {
          [zlib.constants.BROTLI_PARAM_QUALITY]: 4, // Fast compression (1-11, 4 is a good balance)
        },
      });
    case "gzip":
      return zlib.createGzip({ level: 6 }); // Default level, good balance
    case "deflate":
      return zlib.createDeflate({ level: 6 });
  }
}

/**
 * Send a compressed response if the content type is compressible and the
 * client supports compression. Otherwise send uncompressed.
 */
function sendCompressed(
  req: IncomingMessage,
  res: ServerResponse,
  body: string | Buffer,
  contentType: string,
  statusCode: number,
  extraHeaders: Record<string, string> = {},
  compress: boolean = true,
): void {
  const buf = typeof body === "string" ? Buffer.from(body) : body;
  const baseType = contentType.split(";")[0].trim();
  const encoding = compress ? negotiateEncoding(req) : null;

  if (encoding && COMPRESSIBLE_TYPES.has(baseType) && buf.length >= COMPRESS_THRESHOLD) {
    const compressor = createCompressor(encoding);
    res.writeHead(statusCode, {
      ...extraHeaders,
      "Content-Type": contentType,
      "Content-Encoding": encoding,
      Vary: "Accept-Encoding",
    });
    compressor.end(buf);
    pipeline(compressor, res, () => { /* ignore pipeline errors on closed connections */ });
  } else {
    res.writeHead(statusCode, {
      ...extraHeaders,
      "Content-Type": contentType,
      "Content-Length": String(buf.length),
    });
    res.end(buf);
  }
}

/**
 * Start the production server.
 */
export async function startProdServer(options: ProdServerOptions = {}) {
  const {
    port = process.env.PORT ? parseInt(process.env.PORT) : 3000,
    host = "0.0.0.0",
    outDir = path.resolve("dist"),
    noCompression = false,
  } = options;

  const compress = !noCompression;
  const clientDir = path.join(outDir, "client");
  const serverEntryPath = path.join(outDir, "server", "entry.js");

  if (!fs.existsSync(serverEntryPath)) {
    console.error(`[vinext] Server entry not found at ${serverEntryPath}`);
    console.error("Run `vinext build` first.");
    process.exit(1);
  }

  // Load the SSR manifest (maps module URLs to client asset URLs)
  let ssrManifest: Record<string, string[]> = {};
  const manifestPath = path.join(clientDir, ".vite", "ssr-manifest.json");
  if (fs.existsSync(manifestPath)) {
    ssrManifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
  }

  // Import the server entry module
  const serverEntry = await import(serverEntryPath);
  const { renderPage, handleApiRoute: handleApi } = serverEntry;

  // Build content-type lookup
  const contentTypes: Record<string, string> = {
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
  };

  const server = createServer(async (req, res) => {
    const url = req.url ?? "/";
    const pathname = url.split("?")[0];

    // Serve static assets from client build
    // Vite puts hashed assets in /assets/ by default
    const staticFile = path.join(clientDir, pathname);
    if (
      pathname !== "/" &&
      !pathname.startsWith("/api/") &&
      fs.existsSync(staticFile) &&
      fs.statSync(staticFile).isFile()
    ) {
      const ext = path.extname(staticFile);
      const ct = contentTypes[ext] ?? "application/octet-stream";
      const isHashed = pathname.startsWith("/assets/");
      const cacheControl = isHashed
        ? "public, max-age=31536000, immutable"
        : "public, max-age=3600";

      // For compressible static files, read into buffer and compress
      const baseType = ct.split(";")[0].trim();
      if (compress && COMPRESSIBLE_TYPES.has(baseType)) {
        const encoding = negotiateEncoding(req);
        if (encoding) {
          const fileStream = fs.createReadStream(staticFile);
          const compressor = createCompressor(encoding);
          res.writeHead(200, {
            "Content-Type": ct,
            "Content-Encoding": encoding,
            "Cache-Control": cacheControl,
            Vary: "Accept-Encoding",
          });
          pipeline(fileStream, compressor, res, () => { /* ignore */ });
          return;
        }
      }

      // Non-compressible or no encoding support — stream directly
      res.writeHead(200, {
        "Content-Type": ct,
        "Cache-Control": cacheControl,
      });
      fs.createReadStream(staticFile).pipe(res);
      return;
    }

    try {
      // API routes
      if (pathname.startsWith("/api/") || pathname === "/api") {
        if (typeof handleApi === "function") {
          await handleApi(req, res, url);
          return;
        }
        res.writeHead(404);
        res.end("404 - API route not found");
        return;
      }

      // SSR page rendering
      if (typeof renderPage === "function") {
        // Wrap res to capture SSR output for compression.
        // renderPage writes directly to res, so we intercept writeHead/write/end.
        if (compress) {
          const origWriteHead = res.writeHead.bind(res);
          const origWrite = res.write.bind(res);
          const origEnd = res.end.bind(res);
          const chunks: Buffer[] = [];
          let statusCode = 200;
          let headers: Record<string, string | string[]> = {};
          let headersSent = false;

          (res as any).writeHead = (code: number, hdrs?: Record<string, string | string[]>) => {
            statusCode = code;
            if (hdrs) headers = { ...headers, ...hdrs };
            return res;
          };

          (res as any).write = (chunk: string | Buffer) => {
            chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
            return true;
          };

          (res as any).end = (chunk?: string | Buffer) => {
            if (chunk) {
              chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
            }
            const body = Buffer.concat(chunks);
            const ct = String(headers["Content-Type"] ?? headers["content-type"] ?? "text/html");
            const baseType = ct.split(";")[0].trim();
            const encoding = negotiateEncoding(req);

            if (encoding && COMPRESSIBLE_TYPES.has(baseType) && body.length >= COMPRESS_THRESHOLD) {
              if (!headersSent) {
                headersSent = true;
                const finalHeaders = { ...headers };
                delete finalHeaders["Content-Length"];
                delete finalHeaders["content-length"];
                (finalHeaders as any)["Content-Encoding"] = encoding;
                (finalHeaders as any)["Vary"] = "Accept-Encoding";
                origWriteHead(statusCode, finalHeaders);
              }
              const compressor = createCompressor(encoding);
              compressor.end(body);
              pipeline(compressor, res as any, () => { /* ignore */ });
              // Restore original methods
              res.writeHead = origWriteHead;
              res.write = origWrite;
              res.end = origEnd;
            } else {
              if (!headersSent) {
                headersSent = true;
                origWriteHead(statusCode, headers);
              }
              origEnd(body);
              // Restore original methods
              res.writeHead = origWriteHead;
              res.write = origWrite;
              res.end = origEnd;
            }
          };

          await renderPage(req, res, url, ssrManifest);
        } else {
          await renderPage(req, res, url, ssrManifest);
        }
        return;
      }

      res.writeHead(404);
      res.end("404 - Not found");
    } catch (e) {
      console.error("[vinext] Server error:", e);
      res.writeHead(500);
      res.end("Internal Server Error");
    }
  });

  server.listen(port, host, () => {
    console.log(`[vinext] Production server running at http://${host}:${port}`);
  });

  return server;
}

// Export helpers for testing
export { sendCompressed, negotiateEncoding, COMPRESSIBLE_TYPES, COMPRESS_THRESHOLD };
