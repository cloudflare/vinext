/**
 * Production server for vinext.
 *
 * Serves the built output from `vinext build`. Handles:
 * - Static asset serving from client build output
 * - Pages Router: SSR rendering + API route handling
 * - App Router: RSC/SSR rendering, route handlers, server actions
 * - Gzip/Brotli compression for text-based responses
 * - Streaming SSR for App Router
 *
 * Build output for Pages Router:
 * - dist/client/  — static assets (JS, CSS, images) + .vite/ssr-manifest.json
 * - dist/server/entry.js — SSR entry point (virtual:vinext-server-entry)
 *
 * Build output for App Router:
 * - dist/client/  — static assets (JS, CSS, images)
 * - dist/rsc/index.js — RSC entry (default export: handler(Request) → Response)
 * - dist/ssr/index.js — SSR entry (imported by RSC entry at runtime)
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable, pipeline } from "node:stream";
import { pathToFileURL } from "node:url";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

/** Convert a Node.js IncomingMessage into a ReadableStream for Web Request body. */
function readNodeStream(req: IncomingMessage): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      req.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
      req.on("end", () => controller.close());
      req.on("error", (err) => controller.error(err));
    },
  });
}

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

/** Content-type lookup for static assets. */
const CONTENT_TYPES: Record<string, string> = {
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

/**
 * Try to serve a static file from the client build directory.
 * Returns true if the file was served, false otherwise.
 */
function tryServeStatic(
  req: IncomingMessage,
  res: ServerResponse,
  clientDir: string,
  pathname: string,
  compress: boolean,
): boolean {
  // Resolve the path and guard against directory traversal (e.g. /../../../etc/passwd)
  const resolvedClient = path.resolve(clientDir);
  const staticFile = path.resolve(clientDir, "." + decodeURIComponent(pathname));
  if (!staticFile.startsWith(resolvedClient + path.sep) && staticFile !== resolvedClient) {
    return false;
  }
  if (
    pathname === "/" ||
    !fs.existsSync(staticFile) ||
    !fs.statSync(staticFile).isFile()
  ) {
    return false;
  }

  const ext = path.extname(staticFile);
  const ct = CONTENT_TYPES[ext] ?? "application/octet-stream";
  const isHashed = pathname.startsWith("/assets/");
  const cacheControl = isHashed
    ? "public, max-age=31536000, immutable"
    : "public, max-age=3600";

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
      return true;
    }
  }

  res.writeHead(200, {
    "Content-Type": ct,
    "Cache-Control": cacheControl,
  });
  fs.createReadStream(staticFile).pipe(res);
  return true;
}

/**
 * Convert a Node.js IncomingMessage to a Web Request object.
 */
function nodeToWebRequest(req: IncomingMessage): Request {
  const proto = (req.headers["x-forwarded-proto"] as string)?.split(",")[0]?.trim() || "http";
  const host = (req.headers["x-forwarded-host"] as string) || req.headers.host || "localhost";
  const origin = `${proto}://${host}`;
  const url = new URL(req.url ?? "/", origin);

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) headers.append(key, v);
    } else {
      headers.set(key, value);
    }
  }

  const method = req.method ?? "GET";
  const hasBody = method !== "GET" && method !== "HEAD";

  const init: RequestInit & { duplex?: string } = {
    method,
    headers,
  };

  if (hasBody) {
    // Convert Node.js readable stream to Web ReadableStream for request body.
    // Readable.toWeb() is available since Node.js 17.
    init.body = Readable.toWeb(req) as ReadableStream;
    init.duplex = "half"; // Required for streaming request bodies
  }

  return new Request(url, init);
}

/**
 * Stream a Web Response back to a Node.js ServerResponse.
 * Supports streaming compression for SSR responses.
 */
async function sendWebResponse(
  webResponse: Response,
  req: IncomingMessage,
  res: ServerResponse,
  compress: boolean,
): Promise<void> {
  const status = webResponse.status;

  // Collect headers, handling multi-value headers (e.g. Set-Cookie)
  const nodeHeaders: Record<string, string | string[]> = {};
  webResponse.headers.forEach((value, key) => {
    const existing = nodeHeaders[key];
    if (existing !== undefined) {
      nodeHeaders[key] = Array.isArray(existing)
        ? [...existing, value]
        : [existing, value];
    } else {
      nodeHeaders[key] = value;
    }
  });

  if (!webResponse.body) {
    res.writeHead(status, nodeHeaders);
    res.end();
    return;
  }

  // Check if we should compress the response.
  // Skip if the upstream already compressed (avoid double-compression).
  const alreadyEncoded = webResponse.headers.has("content-encoding");
  const contentType = webResponse.headers.get("content-type") ?? "";
  const baseType = contentType.split(";")[0].trim();
  const encoding = (compress && !alreadyEncoded) ? negotiateEncoding(req) : null;
  const shouldCompress = !!(encoding && COMPRESSIBLE_TYPES.has(baseType));

  if (shouldCompress) {
    delete nodeHeaders["content-length"];
    delete nodeHeaders["Content-Length"];
    nodeHeaders["Content-Encoding"] = encoding!;
    nodeHeaders["Vary"] = "Accept-Encoding";
  }

  res.writeHead(status, nodeHeaders);

  // HEAD requests: send headers only, skip the body
  if (req.method === "HEAD") {
    res.end();
    return;
  }

  // Convert Web ReadableStream to Node.js Readable and pipe to response.
  // Readable.fromWeb() is available since Node.js 17.
  const nodeStream = Readable.fromWeb(webResponse.body as import("stream/web").ReadableStream);

  if (shouldCompress) {
    const compressor = createCompressor(encoding!);
    pipeline(nodeStream, compressor, res, () => { /* ignore pipeline errors on closed connections */ });
  } else {
    pipeline(nodeStream, res, () => { /* ignore pipeline errors on closed connections */ });
  }
}

/**
 * Start the production server.
 *
 * Automatically detects whether the build is App Router (dist/rsc/) or
 * Pages Router (dist/server/) and configures the appropriate handler.
 */
export async function startProdServer(options: ProdServerOptions = {}) {
  const {
    port = process.env.PORT ? parseInt(process.env.PORT) : 3000,
    host = "0.0.0.0",
    outDir = path.resolve("dist"),
    noCompression = false,
  } = options;

  const compress = !noCompression;
  // Always resolve outDir to absolute to ensure dynamic import() works
  const resolvedOutDir = path.resolve(outDir);
  const clientDir = path.join(resolvedOutDir, "client");

  // Detect build type
  const rscEntryPath = path.join(resolvedOutDir, "rsc", "index.js");
  const serverEntryPath = path.join(resolvedOutDir, "server", "entry.js");
  const isAppRouter = fs.existsSync(rscEntryPath);

  if (!isAppRouter && !fs.existsSync(serverEntryPath)) {
    console.error(`[vinext] No build output found in ${outDir}`);
    console.error("Run `vinext build` first.");
    process.exit(1);
  }

  if (isAppRouter) {
    return startAppRouterServer({ port, host, clientDir, rscEntryPath, compress });
  }

  return startPagesRouterServer({ port, host, clientDir, serverEntryPath, compress });
}

// ─── App Router Production Server ─────────────────────────────────────────────

interface AppRouterServerOptions {
  port: number;
  host: string;
  clientDir: string;
  rscEntryPath: string;
  compress: boolean;
}

/**
 * Start the App Router production server.
 *
 * The RSC entry (dist/rsc/index.js) exports a default handler function:
 *   handler(request: Request) → Promise<Response>
 *
 * This handler already does everything: route matching, RSC rendering,
 * SSR HTML generation (via import("../ssr/index.js")), route handlers,
 * server actions, ISR caching, 404s, redirects, etc.
 *
 * The production server's job is simply to:
 * 1. Serve static assets from dist/client/
 * 2. Convert Node.js IncomingMessage → Web Request
 * 3. Call the RSC handler
 * 4. Stream the Web Response back (with optional compression)
 */
async function startAppRouterServer(options: AppRouterServerOptions) {
  const { port, host, clientDir, rscEntryPath, compress } = options;

  // Import the RSC handler (use file:// URL for reliable dynamic import)
  const rscModule = await import(pathToFileURL(rscEntryPath).href);
  const rscHandler: (request: Request) => Promise<Response> = rscModule.default;

  if (typeof rscHandler !== "function") {
    console.error("[vinext] RSC entry does not export a default handler function");
    process.exit(1);
  }

  const server = createServer(async (req, res) => {
    const url = req.url ?? "/";
    const pathname = url.split("?")[0];

    // Serve static assets from client build
    if (pathname !== "/" && tryServeStatic(req, res, clientDir, pathname, compress)) {
      return;
    }

    try {
      // Convert Node.js request to Web Request and call the RSC handler
      const request = nodeToWebRequest(req);
      const response = await rscHandler(request);

      // Stream the Web Response back to the Node.js response
      await sendWebResponse(response, req, res, compress);
    } catch (e) {
      console.error("[vinext] Server error:", e);
      if (!res.headersSent) {
        res.writeHead(500);
        res.end("Internal Server Error");
      }
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(port, host, () => {
      const addr = server.address();
      const actualPort = typeof addr === "object" && addr ? addr.port : port;
      console.log(`[vinext] Production server running at http://${host}:${actualPort}`);
      resolve();
    });
  });

  return server;
}

// ─── Pages Router Production Server ───────────────────────────────────────────

interface PagesRouterServerOptions {
  port: number;
  host: string;
  clientDir: string;
  serverEntryPath: string;
  compress: boolean;
}

/**
 * Start the Pages Router production server.
 *
 * Uses the server entry (dist/server/entry.js) which exports:
 * - renderPage(req, res, url, manifest) — SSR rendering
 * - handleApiRoute(req, res, url) — API route handling
 */
async function startPagesRouterServer(options: PagesRouterServerOptions) {
  const { port, host, clientDir, serverEntryPath, compress } = options;

  // Load the SSR manifest (maps module URLs to client asset URLs)
  let ssrManifest: Record<string, string[]> = {};
  const manifestPath = path.join(clientDir, ".vite", "ssr-manifest.json");
  if (fs.existsSync(manifestPath)) {
    ssrManifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
  }

  // Import the server entry module (use file:// URL for reliable dynamic import)
  const serverEntry = await import(pathToFileURL(serverEntryPath).href);
  const { renderPage, handleApiRoute: handleApi, runMiddleware } = serverEntry;

  const server = createServer(async (req, res) => {
    const url = req.url ?? "/";
    const pathname = url.split("?")[0];

    // Serve static assets from client build
    if (
      pathname !== "/" &&
      !pathname.startsWith("/api/") &&
      tryServeStatic(req, res, clientDir, pathname, compress)
    ) {
      return;
    }

    try {
      // Convert Node.js req to Web Request for the server entry
      const protocol = (req.headers["x-forwarded-proto"] as string)?.split(",")[0]?.trim() || "http";
      const hostHeader = (req.headers["x-forwarded-host"] as string) || req.headers.host || `${host}:${port}`;
      const reqHeaders = Object.entries(req.headers).reduce((h, [k, v]) => {
        if (v) h.set(k, Array.isArray(v) ? v.join(", ") : v);
        return h;
      }, new Headers());
      const method = req.method ?? "GET";
      const hasBody = method !== "GET" && method !== "HEAD";
      const webRequest = new Request(`${protocol}://${hostHeader}${url}`, {
        method,
        headers: reqHeaders,
        body: hasBody ? readNodeStream(req) : undefined,
        // @ts-expect-error — duplex needed for streaming request bodies
        duplex: hasBody ? "half" : undefined,
      });

      // Run middleware before routing
      let resolvedUrl = url;
      const middlewareHeaders: Record<string, string> = {};
      if (typeof runMiddleware === "function") {
        const result = await runMiddleware(webRequest);

        if (!result.continue) {
          if (result.redirectUrl) {
            res.writeHead(result.redirectStatus ?? 307, {
              Location: result.redirectUrl,
            });
            res.end();
            return;
          }
          if (result.response) {
            // Use arrayBuffer() to handle binary response bodies correctly
            const body = Buffer.from(await result.response.arrayBuffer());
            res.writeHead(result.response.status, Object.fromEntries(result.response.headers));
            res.end(body);
            return;
          }
        }

        // Collect middleware response headers to merge into final response
        if (result.responseHeaders) {
          for (const [key, value] of result.responseHeaders) {
            middlewareHeaders[key] = value;
          }
        }

        // Apply middleware rewrite
        if (result.rewriteUrl) {
          resolvedUrl = result.rewriteUrl;
        }
      }

      const resolvedPathname = resolvedUrl.split("?")[0];
      let response: Response | undefined;

      // API routes
      if (resolvedPathname.startsWith("/api/") || resolvedPathname === "/api") {
        if (typeof handleApi === "function") {
          response = await handleApi(webRequest, resolvedUrl);
        } else {
          response = new Response("404 - API route not found", { status: 404 });
        }
      } else if (typeof renderPage === "function") {
        // SSR page rendering
        response = await renderPage(webRequest, resolvedUrl, ssrManifest);
      }

      if (!response) {
        res.writeHead(404);
        res.end("404 - Not found");
        return;
      }

      // Merge middleware headers into the response
      const responseBody = await response.text();
      const ct = response.headers.get("content-type") ?? "text/html";
      const responseHeaders: Record<string, string> = { ...middlewareHeaders };
      response.headers.forEach((v, k) => { responseHeaders[k] = v; });

      sendCompressed(req, res, responseBody, ct, response.status, responseHeaders, compress);
    } catch (e) {
      console.error("[vinext] Server error:", e);
      res.writeHead(500);
      res.end("Internal Server Error");
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(port, host, () => {
      const addr = server.address();
      const actualPort = typeof addr === "object" && addr ? addr.port : port;
      console.log(`[vinext] Production server running at http://${host}:${actualPort}`);
      resolve();
    });
  });

  return server;
}

// Export helpers for testing
export { sendCompressed, negotiateEncoding, COMPRESSIBLE_TYPES, COMPRESS_THRESHOLD };
