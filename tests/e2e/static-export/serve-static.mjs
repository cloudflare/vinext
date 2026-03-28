/**
 * Lightweight static file server for the static export E2E tests.
 *
 * Serves pre-built HTML files from dist/client/ with correct MIME types
 * and 404 handling. Used by the Playwright webServer config to serve
 * the static export output without requiring external dependencies.
 *
 * Usage: node serve-static.mjs <root-dir> <port>
 */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, extname, resolve, sep } from "node:path";

const rawRoot = process.argv[2];
const rawPort = process.argv[3];

if (!rawRoot || !rawPort) {
  console.error("Usage: node serve-static.mjs <root-dir> <port>");
  process.exit(1);
}

const rootDir = resolve(rawRoot);
const rootPrefix = rootDir.endsWith(sep) ? rootDir : rootDir + sep;
const port = parseInt(rawPort, 10);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`Invalid port: "${rawPort}". Must be an integer between 1 and 65535.`);
  process.exit(1);
}

// Verify root directory exists and is readable before starting the server
try {
  const rootStat = await stat(rootDir);
  if (!rootStat.isDirectory()) {
    console.error(`Root path is not a directory: ${rootDir}`);
    process.exit(1);
  }
} catch (err) {
  if (err.code === "ENOENT") {
    console.error(`Root directory does not exist: ${rootDir}`);
    console.error("Did the build step complete successfully?");
  } else if (err.code === "EACCES") {
    console.error(`Root directory is not accessible (permission denied): ${rootDir}`);
  } else {
    console.error(`Cannot access root directory ${rootDir}:`, err);
  }
  process.exit(1);
}

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".rsc": "text/x-component",
};

async function tryFile(filePath) {
  try {
    const s = await stat(filePath);
    if (!s.isFile()) return null;
    return await readFile(filePath);
  } catch (err) {
    if (err.code === "ENOENT" || err.code === "ENOTDIR" || err.code === "ERR_INVALID_ARG_VALUE")
      return null;
    throw err;
  }
}

function isInsideRoot(filePath) {
  return filePath === rootDir || filePath.startsWith(rootPrefix);
}

const server = createServer(async (req, res) => {
  try {
    const parsed = new URL(req.url ?? "/", "http://localhost");
    let pathname = decodeURIComponent(parsed.pathname);

    // Directory index
    if (pathname.endsWith("/")) pathname += "index.html";

    // Resolve file path — try exact match, then .html extension
    let filePath = resolve(join(rootDir, pathname));

    // Prevent path traversal
    if (!isInsideRoot(filePath)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }

    let content = await tryFile(filePath);
    if (!content && !extname(filePath)) {
      const htmlPath = filePath + ".html";
      if (isInsideRoot(htmlPath)) {
        content = await tryFile(htmlPath);
        if (content) filePath = htmlPath;
      }
    }

    if (!content) {
      const notFoundPath = join(rootDir, "404.html");
      const notFoundContent = await tryFile(notFoundPath);
      if (notFoundContent) {
        res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
        res.end(notFoundContent);
      } else {
        res.writeHead(404);
        res.end("Not Found");
      }
      return;
    }

    const ext = extname(filePath);
    const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
    res.writeHead(200, { "Content-Type": contentType });
    res.end(content);
  } catch (err) {
    console.error(`Request handler error for ${req.url}:`, err);
    if (!res.headersSent) {
      res.writeHead(500);
      res.end("Internal Server Error");
    }
  }
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `Port ${port} is already in use. Kill the existing process or choose a different port.`,
    );
  } else {
    console.error("Server failed to start:", err);
  }
  process.exit(1);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Static server listening on http://localhost:${port}`);
});
