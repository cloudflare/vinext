/**
 * Production server for nextcompat.
 *
 * Serves the built output from `vite build`. Handles:
 * - Static asset serving from client build output
 * - SSR rendering for page routes
 * - API route handling
 * - next.config.js redirects/rewrites/headers
 */
import { createServer } from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
 *
 * The build output is expected to have:
 * - client/ — static assets (JS, CSS, images)
 * - server/ — SSR entry point
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

  // Import the server entry module
  const serverEntry = await import(fileURLToPath(new URL(`file://${serverEntryPath}`)));
  const { renderPage, handleApiRoute: handleApi } = serverEntry;

  const server = createServer(async (req, res) => {
    const url = req.url ?? "/";
    const pathname = url.split("?")[0];

    // Serve static assets from client build
    if (pathname.startsWith("/assets/") || pathname === "/favicon.ico") {
      const filePath = path.join(clientDir, pathname);
      if (fs.existsSync(filePath)) {
        const ext = path.extname(filePath);
        const contentTypes: Record<string, string> = {
          ".js": "application/javascript",
          ".css": "text/css",
          ".html": "text/html",
          ".json": "application/json",
          ".png": "image/png",
          ".jpg": "image/jpeg",
          ".svg": "image/svg+xml",
          ".ico": "image/x-icon",
          ".woff": "font/woff",
          ".woff2": "font/woff2",
        };
        res.writeHead(200, {
          "Content-Type": contentTypes[ext] ?? "application/octet-stream",
          "Cache-Control": "public, max-age=31536000, immutable",
        });
        fs.createReadStream(filePath).pipe(res);
        return;
      }
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
        await renderPage(req, res, url);
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
