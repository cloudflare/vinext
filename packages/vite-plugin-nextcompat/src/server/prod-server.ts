/**
 * Production server for nextcompat.
 *
 * Serves the built output from `nextcompat build`. Handles:
 * - Static asset serving from client build output
 * - SSR rendering for page routes
 * - API route handling
 *
 * The build output is expected to have:
 * - dist/client/  — static assets (JS, CSS, images) + .vite/ssr-manifest.json
 * - dist/server/entry.js — SSR entry point (virtual:nextcompat-server-entry)
 */
import { createServer } from "node:http";
import fs from "node:fs";
import path from "node:path";

export interface ProdServerOptions {
  /** Port to listen on */
  port?: number;
  /** Host to bind to */
  host?: string;
  /** Path to the build output directory */
  outDir?: string;
}

/**
 * Start the production server.
 */
export async function startProdServer(options: ProdServerOptions = {}) {
  const {
    port = process.env.PORT ? parseInt(process.env.PORT) : 3000,
    host = "0.0.0.0",
    outDir = path.resolve("dist"),
  } = options;

  const clientDir = path.join(outDir, "client");
  const serverEntryPath = path.join(outDir, "server", "entry.js");

  if (!fs.existsSync(serverEntryPath)) {
    console.error(`[nextcompat] Server entry not found at ${serverEntryPath}`);
    console.error("Run `nextcompat build` first.");
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
      res.writeHead(200, {
        "Content-Type": ct,
        "Cache-Control": isHashed
          ? "public, max-age=31536000, immutable"
          : "public, max-age=3600",
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
        await renderPage(req, res, url, ssrManifest);
        return;
      }

      res.writeHead(404);
      res.end("404 - Not found");
    } catch (e) {
      console.error("[nextcompat] Server error:", e);
      res.writeHead(500);
      res.end("Internal Server Error");
    }
  });

  server.listen(port, host, () => {
    console.log(`[nextcompat] Production server running at http://${host}:${port}`);
  });

  return server;
}
