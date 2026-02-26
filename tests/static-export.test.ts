/**
 * Static export E2E tests — verify exported files work when served via HTTP.
 *
 * Unlike the unit tests in pages-router.test.ts and app-router.test.ts which
 * only check file existence and content, these tests:
 * 1. Run static export for both Pages Router and App Router
 * 2. Serve the exported files with a real HTTP server
 * 3. Make HTTP requests to verify correct responses
 * 4. Check Content-Type, status codes, and asset references
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer as createViteServer, type ViteDevServer } from "vite";
import { createServer, type Server } from "node:http";
import fs from "node:fs";
import path from "node:path";

const PAGES_FIXTURE = path.resolve(import.meta.dirname, "./fixtures/pages-basic");
const APP_FIXTURE = path.resolve(import.meta.dirname, "./fixtures/app-basic");

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Simple static file server for testing. */
function createStaticServer(rootDir: string): Promise<{ server: Server; baseUrl: string }> {
  const MIME_TYPES: Record<string, string> = {
    ".html": "text/html",
    ".js": "application/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".png": "image/png",
    ".svg": "image/svg+xml",
  };

  const rootDirResolved = path.resolve(rootDir);

  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = req.url ?? "/";
      let pathname = url.split("?")[0];

      // Directory index
      if (pathname.endsWith("/")) pathname += "index.html";

      // Normalize and resolve against root directory
      let filePath = path.resolve(rootDirResolved, "." + pathname);

      // Try .html extension for extensionless paths
      if (!fs.existsSync(filePath) && !path.extname(filePath)) {
        filePath = path.resolve(rootDirResolved, "." + pathname + ".html");
      }

      // Ensure the resolved path stays within the root directory
      if (!filePath.startsWith(rootDirResolved + path.sep) && filePath !== rootDirResolved) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
      }

      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        // Serve 404.html if it exists
        const notFoundPath = path.join(rootDirResolved, "404.html");
        if (fs.existsSync(notFoundPath)) {
          const content = fs.readFileSync(notFoundPath);
          res.writeHead(404, { "Content-Type": "text/html" });
          res.end(content);
        } else {
          res.writeHead(404);
          res.end("Not Found");
        }
        return;
      }

      const ext = path.extname(filePath);
      const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
      const content = fs.readFileSync(filePath);
      res.writeHead(200, { "Content-Type": contentType });
      res.end(content);
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

/** Start a Vite dev server for a fixture directory. */
async function startFixtureServer(
  fixtureDir: string,
  _opts?: { appRouter?: boolean },
): Promise<{ server: ViteDevServer; baseUrl: string }> {
  const server = await createViteServer({
    root: fixtureDir,
    configFile: path.join(fixtureDir, "vite.config.ts"),
    server: { port: 0, strictPort: false },
    logLevel: "silent",
  });
  await server.listen();
  const addr = server.httpServer?.address();
  const port = typeof addr === "object" && addr ? addr.port : 4321;
  return { server, baseUrl: `http://localhost:${port}` };
}

// ─── Pages Router Static Export E2E ─────────────────────────────────────────

describe("Static export — Pages Router (served via HTTP)", () => {
  let viteServer: ViteDevServer;
  let staticServer: Server;
  let baseUrl: string;
  const exportDir = path.resolve(PAGES_FIXTURE, "out-e2e");

  beforeAll(async () => {
    // 1. Start Vite dev server for the fixture
    const vite = await startFixtureServer(PAGES_FIXTURE);
    viteServer = vite.server;

    // 2. Run static export
    const { staticExportPages } = await import(
      "../packages/vinext/src/build/static-export.js"
    );
    const { pagesRouter } = await import(
      "../packages/vinext/src/routing/pages-router.js"
    );
    const { resolveNextConfig } = await import(
      "../packages/vinext/src/config/next-config.js"
    );

    const pagesDir = path.resolve(PAGES_FIXTURE, "pages");
    const routes = await pagesRouter(pagesDir);
    const pageRoutes = routes.filter(
      (r: any) => !r.filePath.includes("/api/"),
    );
    const apiRoutes = routes.filter((r: any) =>
      r.filePath.includes("/api/"),
    );
    const config = await resolveNextConfig({ output: "export" });

    await staticExportPages({
      server: viteServer,
      routes: pageRoutes,
      apiRoutes,
      pagesDir,
      outDir: exportDir,
      config,
    });

    // 3. Start a static file server on the exported directory
    const srv = await createStaticServer(exportDir);
    staticServer = srv.server;
    baseUrl = srv.baseUrl;
  }, 30_000);

  afterAll(async () => {
    staticServer?.close();
    await viteServer?.close();
    fs.rmSync(exportDir, { recursive: true, force: true });
  });

  it("serves index.html at / with text/html content type", async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html");
    const html = await res.text();
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("Hello, vinext!");
  });

  it("serves about page", async () => {
    const res = await fetch(`${baseUrl}/about`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("About");
  });

  it("serves pre-rendered dynamic route pages", async () => {
    const res = await fetch(`${baseUrl}/blog/hello-world`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("hello-world");
  });

  it("serves 404.html for missing pages", async () => {
    const res = await fetch(`${baseUrl}/nonexistent-page`);
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain("404");
  });

  it("includes __NEXT_DATA__ in served pages", async () => {
    const res = await fetch(`${baseUrl}/`);
    const html = await res.text();
    expect(html).toContain("__NEXT_DATA__");
    // Verify it's valid JSON inside the script tag
    const match = html.match(
      /window\.__NEXT_DATA__\s*=\s*({[^<]+})/,
    );
    expect(match).toBeTruthy();
    const data = JSON.parse(match![1]);
    expect(data.props).toBeDefined();
    expect(data.page).toBeDefined();
  });

  it("includes HTML document structure", async () => {
    const res = await fetch(`${baseUrl}/`);
    const html = await res.text();
    expect(html).toContain("<html");
    expect(html).toContain("<head>");
    expect(html).toContain("</head>");
    expect(html).toContain("<body");
    expect(html).toContain("</body>");
    expect(html).toContain("</html>");
    expect(html).toContain('<div id="__next">');
  });

  it("getStaticProps pages have correct data in __NEXT_DATA__", async () => {
    const res = await fetch(`${baseUrl}/blog/hello-world`);
    const html = await res.text();
    const match = html.match(
      /window\.__NEXT_DATA__\s*=\s*({[^<]+})/,
    );
    expect(match).toBeTruthy();
    const data = JSON.parse(match![1]);
    expect(data.props.pageProps).toBeDefined();
  });
});

// ─── App Router Static Export E2E ───────────────────────────────────────────

describe("Static export — App Router (served via HTTP)", () => {
  let viteServer: ViteDevServer;
  let viteBaseUrl: string;
  let staticServer: Server;
  let baseUrl: string;
  const exportDir = path.resolve(APP_FIXTURE, "out-e2e");

  beforeAll(async () => {
    // 1. Start Vite dev server for the fixture
    const vite = await startFixtureServer(APP_FIXTURE, { appRouter: true });
    viteServer = vite.server;
    viteBaseUrl = vite.baseUrl;

    // 2. Run static export
    const { staticExportApp } = await import(
      "../packages/vinext/src/build/static-export.js"
    );
    const { appRouter } = await import(
      "../packages/vinext/src/routing/app-router.js"
    );
    const { resolveNextConfig } = await import(
      "../packages/vinext/src/config/next-config.js"
    );

    const appDir = path.resolve(APP_FIXTURE, "app");
    const routes = await appRouter(appDir);
    const config = await resolveNextConfig({ output: "export" });

    await staticExportApp({
      baseUrl: viteBaseUrl,
      routes,
      appDir,
      server: viteServer,
      outDir: exportDir,
      config,
    });

    // 3. Start a static file server on the exported directory
    const srv = await createStaticServer(exportDir);
    staticServer = srv.server;
    baseUrl = srv.baseUrl;
  }, 30_000);

  afterAll(async () => {
    staticServer?.close();
    await viteServer?.close();
    fs.rmSync(exportDir, { recursive: true, force: true });
  });

  it("serves index.html at / with text/html content type", async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html");
    const html = await res.text();
    expect(html).toContain("Welcome to App Router");
  });

  it("serves about page", async () => {
    const res = await fetch(`${baseUrl}/about`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("About");
  });

  it("serves pre-rendered dynamic route pages", async () => {
    const res = await fetch(`${baseUrl}/blog/hello-world`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("hello-world");
  });

  it("serves 404.html for missing pages", async () => {
    const res = await fetch(`${baseUrl}/nonexistent-page`);
    expect(res.status).toBe(404);
    const html = await res.text();
    // App Router 404 page
    expect(html.toLowerCase()).toMatch(/not found|404/);
  });

  it("includes complete HTML document structure", async () => {
    const res = await fetch(`${baseUrl}/`);
    const html = await res.text();
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("<html");
    expect(html).toContain("<head>");
    expect(html).toContain("</head>");
    expect(html).toContain("<body");
    expect(html).toContain("</body>");
  });

  it("HTML contains charset and viewport meta tags", async () => {
    const res = await fetch(`${baseUrl}/`);
    const html = await res.text();
    // React renders charset as charSet in JSX
    expect(html.toLowerCase()).toMatch(/charset/);
    expect(html).toContain("viewport");
  });

  it("multiple exported pages return distinct content", async () => {
    const [indexRes, aboutRes] = await Promise.all([
      fetch(`${baseUrl}/`),
      fetch(`${baseUrl}/about`),
    ]);
    const indexHtml = await indexRes.text();
    const aboutHtml = await aboutRes.text();
    // Pages should have different content
    expect(indexHtml).not.toBe(aboutHtml);
    expect(indexHtml).toContain("Welcome to App Router");
    expect(aboutHtml).toContain("About");
  });
});
