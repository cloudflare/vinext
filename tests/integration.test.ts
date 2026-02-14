import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, build, createBuilder, type ViteDevServer } from "vite";
import path from "node:path";
import fs from "node:fs";
import nextcompat from "../packages/vite-plugin-nextcompat/src/index.js";
import {
  PAGES_FIXTURE_DIR,
  APP_FIXTURE_DIR,
  RSC_ENTRIES,
  startFixtureServer,
  fetchHtml,
} from "./helpers.js";

const FIXTURE_DIR = PAGES_FIXTURE_DIR;

describe("Pages Router integration", () => {
  let server: ViteDevServer;
  let baseUrl: string;

  beforeAll(async () => {
    ({ server, baseUrl } = await startFixtureServer(FIXTURE_DIR));
  });

  afterAll(async () => {
    await server?.close();
  });

  it("renders the index page with correct HTML", async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");

    const html = await res.text();
    expect(html).toContain("Hello, nextcompat!");
    expect(html).toContain("This is a Pages Router app running on Vite.");
    expect(html).toContain("Go to About");
  });

  it("renders the about page", async () => {
    const res = await fetch(`${baseUrl}/about`);
    expect(res.status).toBe(200);

    const html = await res.text();
    expect(html).toContain("About");
    expect(html).toContain("This is the about page.");
  });

  it("renders the SSR page with getServerSideProps data", async () => {
    const res = await fetch(`${baseUrl}/ssr`);
    expect(res.status).toBe(200);

    const html = await res.text();
    expect(html).toContain("Server-Side Rendered");
    expect(html).toContain("Hello from getServerSideProps");
    // Should have a timestamp
    expect(html).toContain("Rendered at:");
  });

  it("renders dynamic routes with params", async () => {
    const res = await fetch(`${baseUrl}/posts/42`);
    expect(res.status).toBe(200);

    const html = await res.text();
    // React SSR inserts comment nodes between text and expressions:
    // "Post: <!-- -->42" — so we match with a regex instead
    expect(html).toMatch(/Post:\s*(<!--\s*-->)?\s*42/);
    expect(html).toContain("post-title");
    // Router should have correct pathname and query during SSR
    expect(html).toMatch(/Pathname:\s*(<!--\s*-->)?\s*\/posts\/42/);
    expect(html).toMatch(/Query ID:\s*(<!--\s*-->)?\s*42/);
  });

  it("returns 404 with custom 404 page for non-existent routes", async () => {
    const res = await fetch(`${baseUrl}/nonexistent`);
    expect(res.status).toBe(404);
    const html = await res.text();
    // Should render the custom 404 page
    expect(html).toContain("404 - Page Not Found");
    expect(html).toContain("does not exist");
  });

  it("renders next/head tags in SSR HTML <head>", async () => {
    const res = await fetch(`${baseUrl}/`);
    const html = await res.text();
    // Index page has <Head><title>Hello nextcompat</title></Head>
    // This should appear in the actual <head> of the HTML
    expect(html).toContain("<title");
    expect(html).toContain("Hello nextcompat");
    // The title tag should be in <head>, not in <body>
    const headSection = html.split("</head>")[0];
    expect(headSection).toContain("Hello nextcompat");
  });

  it("includes __NEXT_DATA__ script tag", async () => {
    const res = await fetch(`${baseUrl}/`);
    const html = await res.text();
    expect(html).toContain("__NEXT_DATA__");
  });

  it("includes the Vite client script for HMR", async () => {
    const res = await fetch(`${baseUrl}/`);
    const html = await res.text();
    expect(html).toContain("@vite/client");
  });

  it("wraps pages with custom _app.tsx", async () => {
    const res = await fetch(`${baseUrl}/`);
    const html = await res.text();
    // _app.tsx wraps with an #app-wrapper div and a global nav
    expect(html).toContain("app-wrapper");
    expect(html).toContain("My App");
  });

  it("_app.tsx wrapping works on all pages", async () => {
    const res = await fetch(`${baseUrl}/about`);
    const html = await res.text();
    expect(html).toContain("app-wrapper");
    expect(html).toContain("About");
  });

  it("uses custom _document.tsx for HTML shell", async () => {
    const res = await fetch(`${baseUrl}/`);
    const html = await res.text();
    // Custom _document sets lang="en" on <html>
    expect(html).toContain('lang="en"');
    // Custom _document adds a meta description
    expect(html).toContain("A nextcompat test app");
    // Custom _document sets className on body
    expect(html).toContain("custom-body");
  });

  // --- API Routes ---

  it("handles API routes returning JSON", async () => {
    const res = await fetch(`${baseUrl}/api/hello`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");

    const data = await res.json();
    expect(data).toEqual({ message: "Hello from API!" });
  });

  it("handles dynamic API routes with query params", async () => {
    const res = await fetch(`${baseUrl}/api/users/123`);
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data).toEqual({ user: { id: "123", name: "User 123" } });
  });

  it("returns 404 for non-existent API routes", async () => {
    const res = await fetch(`${baseUrl}/api/nonexistent`);
    expect(res.status).toBe(404);
  });

  // --- Client Hydration ---

  it("includes hydration script for client-side rendering", async () => {
    const res = await fetch(`${baseUrl}/`);
    const html = await res.text();
    // Vite extracts inline module scripts into html-proxy modules.
    // The hydration script becomes a <script type="module" src="...html-proxy...">
    expect(html).toMatch(/html-proxy.*\.js/);
  });

  // --- Catch-all Routes ---

  it("renders catch-all routes with multiple segments", async () => {
    const res = await fetch(`${baseUrl}/docs/getting-started/install`);
    expect(res.status).toBe(200);

    const html = await res.text();
    expect(html).toContain("Docs");
    expect(html).toMatch(/Path:\s*(<!--\s*-->)?\s*getting-started\/install/);
  });

  it("renders catch-all routes with single segment", async () => {
    const res = await fetch(`${baseUrl}/docs/intro`);
    expect(res.status).toBe(200);

    const html = await res.text();
    expect(html).toMatch(/Path:\s*(<!--\s*-->)?\s*intro/);
  });

  // --- Hydration ---

  // --- next.config.js ---

  it("applies redirects from next.config.js", async () => {
    const res = await fetch(`${baseUrl}/old-about`, { redirect: "manual" });
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe("/about");
  });

  it("applies custom headers from next.config.js", async () => {
    const res = await fetch(`${baseUrl}/api/hello`);
    expect(res.headers.get("x-custom-header")).toBe("nextcompat");
  });

  it("applies beforeFiles rewrites from next.config.js", async () => {
    const res = await fetch(`${baseUrl}/before-rewrite`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("About");
  });

  it("applies afterFiles rewrites from next.config.js", async () => {
    const res = await fetch(`${baseUrl}/after-rewrite`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("About");
  });

  it("applies fallback rewrites from next.config.js", async () => {
    const res = await fetch(`${baseUrl}/fallback-rewrite`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("About");
  });

  // --- getStaticPaths ---

  it("renders pages with getStaticPaths + getStaticProps", async () => {
    const res = await fetch(`${baseUrl}/blog/hello-world`);
    expect(res.status).toBe(200);

    const html = await res.text();
    expect(html).toContain("Hello World");
    expect(html).toContain("Blog post slug:");
    expect(html).toMatch(/slug:\s*(<!--\s*-->)?\s*hello-world/);
  });

  it("returns 404 for paths not in getStaticPaths when fallback is false", async () => {
    const res = await fetch(`${baseUrl}/blog/nonexistent-post`);
    expect(res.status).toBe(404);
  });

  // --- next/dynamic ---

  it("renders dynamically imported components during SSR", async () => {
    const res = await fetch(`${baseUrl}/dynamic-page`);
    expect(res.status).toBe(200);

    const html = await res.text();
    expect(html).toContain("Dynamic Import Page");
    // The heavy component should be rendered server-side (ssr: true by default)
    expect(html).toContain("Heavy Component");
    expect(html).toContain("Loaded dynamically");
  });

  // --- Hydration ---

  // --- next/config ---

  it("renders pages that use next/config getConfig()", async () => {
    const res = await fetch(`${baseUrl}/config-test`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Config Test");
    // publicRuntimeConfig is empty by default, so it should show the fallback
    // React SSR inserts <!-- --> between text and expressions
    expect(html).toMatch(/App:.*default-app/);
  });

  // --- next/script ---

  it("renders Script with beforeInteractive strategy as <script> tag in SSR", async () => {
    const res = await fetch(`${baseUrl}/script-test`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Script Test");
    expect(html).toContain("Page with scripts");
    // beforeInteractive should render a <script> tag in the SSR output
    expect(html).toContain('src="https://example.com/analytics.js"');
  });

  // --- next/server ---

  it("resolves next/server imports in API routes", async () => {
    const res = await fetch(`${baseUrl}/api/middleware-test`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({ ok: true, message: "middleware-test works" });
  });

  // --- Middleware ---

  it("middleware adds custom headers to responses", async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-middleware-test")).toBe("active");
  });

  it("middleware redirects /old-page to /about", async () => {
    const res = await fetch(`${baseUrl}/old-page`, { redirect: "manual" });
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/about");
  });

  it("middleware rewrites /rewritten to /ssr", async () => {
    const res = await fetch(`${baseUrl}/rewritten`);
    expect(res.status).toBe(200);
    const html = await res.text();
    // Should get the SSR page content (rewritten from /rewritten to /ssr)
    expect(html).toContain("Server-Side Rendered");
  });

  it("middleware blocks /blocked with 403", async () => {
    const res = await fetch(`${baseUrl}/blocked`);
    expect(res.status).toBe(403);
    const text = await res.text();
    expect(text).toContain("Access Denied");
  });

  // --- Hydration ---

  it("hydration proxy script is fetchable", async () => {
    // Fetch the index page, find the proxy script URL, fetch it,
    // and verify it contains our hydration code
    const res = await fetch(`${baseUrl}/`);
    const html = await res.text();
    const proxyMatch = html.match(/src="([^"]*html-proxy[^"]*)"/);
    expect(proxyMatch).toBeTruthy();

    const scriptRes = await fetch(`${baseUrl}${proxyMatch![1]}`);
    expect(scriptRes.status).toBe(200);
    const scriptContent = await scriptRes.text();
    // The proxy module should contain our hydration imports
    expect(scriptContent).toContain("hydrateRoot");
    expect(scriptContent).toContain("__NEXT_DATA__");
  });

  it("renders Suspense + React.lazy content via streaming SSR", async () => {
    // renderToPipeableStream waits for lazy components to resolve,
    // so the final HTML should contain the lazy component's content
    // (not just the Suspense fallback).
    const res = await fetch(`${baseUrl}/suspense-test`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Suspense Test");
    // The lazy component should have resolved and rendered its content
    expect(html).toContain("Hello from lazy component");
    // The loading fallback should NOT be in the final HTML
    expect(html).not.toContain("Loading...");
  });
});

describe("Virtual server entry generation", () => {
  it("generates valid JavaScript for the server entry", async () => {
    // Create a minimal server just to access the plugin's virtual module
    const testServer = await createServer({
      root: FIXTURE_DIR,
      configFile: false,
      plugins: [nextcompat()],
      server: { port: 0 },
      logLevel: "silent",
    });

    try {
      // Load the virtual module through Vite's SSR pipeline
      const entry = await testServer.ssrLoadModule("virtual:nextcompat-server-entry");

      // Verify it exports the expected functions
      expect(typeof entry.renderPage).toBe("function");
      expect(typeof entry.handleApiRoute).toBe("function");
    } finally {
      await testServer.close();
    }
  });
});

describe("Production build", () => {
  const outDir = path.resolve(FIXTURE_DIR, "dist");

  afterAll(() => {
    // Clean up build output
    fs.rmSync(outDir, { recursive: true, force: true });
  });

  it("produces SSR server entry via vite build --ssr", async () => {
    // Build the SSR bundle using the virtual server entry
    await build({
      root: FIXTURE_DIR,
      configFile: false,
      plugins: [nextcompat()],
      logLevel: "silent",
      build: {
        outDir: path.join(outDir, "server"),
        ssr: "virtual:nextcompat-server-entry",
        rollupOptions: {
          output: {
            entryFileNames: "entry.js",
          },
        },
      },
    });

    // Verify the server entry was produced
    const entryPath = path.join(outDir, "server", "entry.js");
    expect(fs.existsSync(entryPath)).toBe(true);

    const entryContent = fs.readFileSync(entryPath, "utf-8");
    // Should export renderPage and handleApiRoute
    expect(entryContent).toContain("renderPage");
    expect(entryContent).toContain("handleApiRoute");
    // Should contain route patterns from our fixture pages
    expect(entryContent).toContain("/about");
    expect(entryContent).toContain("/ssr");
  });

  it("produces client bundle with page chunks and SSR manifest", async () => {
    // Build the client bundle
    await build({
      root: FIXTURE_DIR,
      configFile: false,
      plugins: [nextcompat()],
      logLevel: "silent",
      build: {
        outDir: path.join(outDir, "client"),
        ssrManifest: true,
        rollupOptions: {
          input: "virtual:nextcompat-client-entry",
        },
      },
    });

    // Verify client output exists
    const assetsDir = path.join(outDir, "client", "assets");
    expect(fs.existsSync(assetsDir)).toBe(true);

    // Verify SSR manifest was produced
    const manifestPath = path.join(outDir, "client", ".vite", "ssr-manifest.json");
    expect(fs.existsSync(manifestPath)).toBe(true);

    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    // Manifest should have entries (module IDs -> asset URLs)
    expect(Object.keys(manifest).length).toBeGreaterThan(0);

    // There should be JS files in the assets directory
    const assets = fs.readdirSync(assetsDir);
    const jsFiles = assets.filter((f: string) => f.endsWith(".js"));
    expect(jsFiles.length).toBeGreaterThan(0);
  });

  it("serves pages from production build end-to-end", async () => {
    const serverEntryPath = path.join(outDir, "server", "entry.js");
    const manifestPath = path.join(outDir, "client", ".vite", "ssr-manifest.json");

    // Both should exist from prior tests
    if (!fs.existsSync(serverEntryPath) || !fs.existsSync(manifestPath)) {
      // Build if needed (tests may run in isolation)
      await build({
        root: FIXTURE_DIR,
        configFile: false,
        plugins: [nextcompat()],
        logLevel: "silent",
        build: {
          outDir: path.join(outDir, "server"),
          ssr: "virtual:nextcompat-server-entry",
          rollupOptions: { output: { entryFileNames: "entry.js" } },
        },
      });
      await build({
        root: FIXTURE_DIR,
        configFile: false,
        plugins: [nextcompat()],
        logLevel: "silent",
        build: {
          outDir: path.join(outDir, "client"),
          ssrManifest: true,
          rollupOptions: { input: "virtual:nextcompat-client-entry" },
        },
      });
    }

    // Import the server entry
    const serverEntry = await import(serverEntryPath);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));

    // Create a minimal HTTP server using the built entry
    const { createServer: createHttpServer } = await import("node:http");
    const httpServer = createHttpServer(async (req, res) => {
      const url = req.url ?? "/";
      const pathname = url.split("?")[0];

      if (pathname.startsWith("/api/") || pathname === "/api") {
        await serverEntry.handleApiRoute(req, res, url);
        return;
      }

      await serverEntry.renderPage(req, res, url, manifest);
    });

    // Start on a random port
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const addr = httpServer.address() as { port: number };
    const prodUrl = `http://localhost:${addr.port}`;

    try {
      // Test: index page renders
      const indexRes = await fetch(`${prodUrl}/`);
      expect(indexRes.status).toBe(200);
      const indexHtml = await indexRes.text();
      expect(indexHtml).toContain("Hello, nextcompat!");
      expect(indexHtml).toContain("__NEXT_DATA__");

      // Test: about page renders
      const aboutRes = await fetch(`${prodUrl}/about`);
      expect(aboutRes.status).toBe(200);
      const aboutHtml = await aboutRes.text();
      expect(aboutHtml).toContain("About");

      // Test: SSR page with getServerSideProps
      const ssrRes = await fetch(`${prodUrl}/ssr`);
      expect(ssrRes.status).toBe(200);
      const ssrHtml = await ssrRes.text();
      expect(ssrHtml).toContain("Server-Side Rendered");

      // Test: API route
      const apiRes = await fetch(`${prodUrl}/api/hello`);
      expect(apiRes.status).toBe(200);
      const apiData = await apiRes.json();
      expect(apiData).toEqual({ message: "Hello from API!" });

      // Test: 404 for unknown route
      const notFoundRes = await fetch(`${prodUrl}/nonexistent`);
      expect(notFoundRes.status).toBe(404);
    } finally {
      httpServer.close();
    }
  });
});

// ---------------------------------------------------------------
// Static export (output: 'export') tests
// ---------------------------------------------------------------

describe("Static export (Pages Router)", () => {
  let server: ViteDevServer;
  const exportDir = path.resolve(FIXTURE_DIR, "out");

  beforeAll(async () => {
    server = await createServer({
      root: FIXTURE_DIR,
      configFile: false,
      plugins: [nextcompat()],
      server: { port: 0 },
      logLevel: "silent",
    });
    // Don't need to listen — just need the SSR module loader
  });

  afterAll(async () => {
    await server.close();
    fs.rmSync(exportDir, { recursive: true, force: true });
  });

  it("exports static pages to HTML files", async () => {
    const { staticExportPages } = await import(
      "../packages/vite-plugin-nextcompat/src/build/static-export.js"
    );
    const { pagesRouter, apiRouter } = await import(
      "../packages/vite-plugin-nextcompat/src/routing/pages-router.js"
    );
    const { resolveNextConfig } = await import(
      "../packages/vite-plugin-nextcompat/src/config/next-config.js"
    );

    const pagesDir = path.resolve(FIXTURE_DIR, "pages");
    const routes = await pagesRouter(pagesDir);
    const apiRoutes = await apiRouter(pagesDir);
    const config = await resolveNextConfig({ output: "export" });

    const result = await staticExportPages({
      server,
      routes,
      apiRoutes,
      pagesDir,
      outDir: exportDir,
      config,
    });

    // Should have generated HTML files
    expect(result.pageCount).toBeGreaterThan(0);

    // Index page
    expect(result.files).toContain("index.html");
    const indexHtml = fs.readFileSync(
      path.join(exportDir, "index.html"),
      "utf-8",
    );
    expect(indexHtml).toContain("<!DOCTYPE html>");
    expect(indexHtml).toContain("Hello, nextcompat!");

    // About page
    expect(result.files).toContain("about.html");
    const aboutHtml = fs.readFileSync(
      path.join(exportDir, "about.html"),
      "utf-8",
    );
    expect(aboutHtml).toContain("About");
  });

  it("pre-renders dynamic routes from getStaticPaths", async () => {
    // blog/[slug] has getStaticPaths returning hello-world and getting-started
    expect(
      fs.existsSync(path.join(exportDir, "blog", "hello-world.html")),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(exportDir, "blog", "getting-started.html")),
    ).toBe(true);

    const blogHtml = fs.readFileSync(
      path.join(exportDir, "blog", "hello-world.html"),
      "utf-8",
    );
    expect(blogHtml).toContain("Hello World");
    expect(blogHtml).toContain("hello-world");
  });

  it("generates 404.html", async () => {
    expect(fs.existsSync(path.join(exportDir, "404.html"))).toBe(true);
    const html404 = fs.readFileSync(
      path.join(exportDir, "404.html"),
      "utf-8",
    );
    expect(html404).toContain("404");
  });

  it("reports errors for pages using getServerSideProps", async () => {
    // The result from the first test should have errors for SSR-only pages
    const { staticExportPages } = await import(
      "../packages/vite-plugin-nextcompat/src/build/static-export.js"
    );
    const { pagesRouter, apiRouter } = await import(
      "../packages/vite-plugin-nextcompat/src/routing/pages-router.js"
    );
    const { resolveNextConfig } = await import(
      "../packages/vite-plugin-nextcompat/src/config/next-config.js"
    );

    const pagesDir = path.resolve(FIXTURE_DIR, "pages");
    const routes = await pagesRouter(pagesDir);
    const apiRoutes = await apiRouter(pagesDir);
    const config = await resolveNextConfig({ output: "export" });

    const tempDir = path.resolve(FIXTURE_DIR, "out-temp");
    try {
      const result = await staticExportPages({
        server,
        routes,
        apiRoutes,
        pagesDir,
        outDir: tempDir,
        config,
      });

      // Should report errors for getServerSideProps pages
      const ssrErrors = result.errors.filter((e) =>
        e.error.includes("getServerSideProps"),
      );
      expect(ssrErrors.length).toBeGreaterThan(0);

      // Should warn about API routes
      expect(result.warnings.some((w) => w.includes("API route"))).toBe(true);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("includes __NEXT_DATA__ in exported HTML", async () => {
    const indexHtml = fs.readFileSync(
      path.join(exportDir, "index.html"),
      "utf-8",
    );
    expect(indexHtml).toContain("__NEXT_DATA__");
  });

  it("respects trailingSlash config", async () => {
    const { staticExportPages } = await import(
      "../packages/vite-plugin-nextcompat/src/build/static-export.js"
    );
    const { pagesRouter, apiRouter } = await import(
      "../packages/vite-plugin-nextcompat/src/routing/pages-router.js"
    );
    const { resolveNextConfig } = await import(
      "../packages/vite-plugin-nextcompat/src/config/next-config.js"
    );

    const pagesDir = path.resolve(FIXTURE_DIR, "pages");
    const routes = await pagesRouter(pagesDir);
    const apiRoutes = await apiRouter(pagesDir);
    const config = await resolveNextConfig({
      output: "export",
      trailingSlash: true,
    });

    const trailingDir = path.resolve(FIXTURE_DIR, "out-trailing");
    try {
      const result = await staticExportPages({
        server,
        routes,
        apiRoutes,
        pagesDir,
        outDir: trailingDir,
        config,
      });

      // With trailingSlash, about → about/index.html
      expect(result.files).toContain("about/index.html");
      expect(
        fs.existsSync(path.join(trailingDir, "about", "index.html")),
      ).toBe(true);
    } finally {
      fs.rmSync(trailingDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------
// App Router integration tests
// ---------------------------------------------------------------

describe("App Router integration", () => {
  let server: ViteDevServer;
  let baseUrl: string;

  beforeAll(async () => {
    ({ server, baseUrl } = await startFixtureServer(APP_FIXTURE_DIR, { appRouter: true }));
  }, 30000);

  afterAll(async () => {
    await server?.close();
  });

  it("renders the home page with root layout", async () => {
    const { res, html } = await fetchHtml(baseUrl, "/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(html).toContain("<html");
    expect(html).toContain("Welcome to App Router");
    expect(html).toContain("Server Component");
  });

  it("renders the about page", async () => {
    const res = await fetch(`${baseUrl}/about`);
    expect(res.status).toBe(200);

    const html = await res.text();
    expect(html).toContain("About");
    expect(html).toContain("This is the about page.");
  });

  it("renders dynamic routes with params", async () => {
    const res = await fetch(`${baseUrl}/blog/hello-world`);
    expect(res.status).toBe(200);

    const html = await res.text();
    expect(html).toContain("Blog Post");
    expect(html).toContain("hello-world");
  });

  it("handles GET API route handlers", async () => {
    const res = await fetch(`${baseUrl}/api/hello`);
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data).toEqual({ message: "Hello from App Router API" });
  });

  it("handles POST API route handlers", async () => {
    const res = await fetch(`${baseUrl}/api/hello`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ test: true }),
    });
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data).toEqual({ echo: { test: true } });
  });

  it("returns 404 for non-existent routes", async () => {
    const res = await fetch(`${baseUrl}/nonexistent`);
    expect(res.status).toBe(404);
  });

  it("returns RSC stream for .rsc requests", async () => {
    const res = await fetch(`${baseUrl}/.rsc`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/x-component");

    const text = await res.text();
    // RSC stream should contain serialized React tree
    expect(text.length).toBeGreaterThan(0);
  });

  it("wraps pages in the root layout", async () => {
    const res = await fetch(`${baseUrl}/about`);
    const html = await res.text();

    // Should have the <html> tag from root layout
    expect(html).toContain('<html lang="en">');
    expect(html).toContain("<title>App Basic</title>");
    expect(html).toContain("</body></html>");
  });

  it("SSR renders 'use client' components with initial state", async () => {
    const res = await fetch(`${baseUrl}/interactive`);
    expect(res.status).toBe(200);

    const html = await res.text();
    // Server-side renders the client component with initial state
    expect(html).toContain("Interactive Page");
    expect(html).toContain("Count:");
    expect(html).toContain("0");
    expect(html).toContain("Increment");
  });

  it("applies nested layouts (dashboard layout wraps dashboard pages)", async () => {
    const res = await fetch(`${baseUrl}/dashboard`);
    expect(res.status).toBe(200);

    const html = await res.text();
    // Should have both root layout and dashboard layout
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('id="dashboard-layout"');
    expect(html).toContain("Dashboard Nav");
    expect(html).toContain("Welcome to your dashboard.");
  });

  it("nested layouts persist across child pages", async () => {
    const res = await fetch(`${baseUrl}/dashboard/settings`);
    expect(res.status).toBe(200);

    const html = await res.text();
    // Dashboard layout should also wrap the settings page
    expect(html).toContain('id="dashboard-layout"');
    expect(html).toContain("Dashboard Nav");
    expect(html).toContain("Settings");
    expect(html).toContain("Configure your dashboard settings.");
  });

  it("returns Method Not Allowed for unsupported HTTP methods on route handlers", async () => {
    const res = await fetch(`${baseUrl}/api/hello`, { method: "DELETE" });
    expect(res.status).toBe(405);
  });

  it("renders custom not-found.tsx for unmatched routes", async () => {
    const res = await fetch(`${baseUrl}/does-not-exist`);
    expect(res.status).toBe(404);

    const html = await res.text();
    // Should render our custom not-found page within the root layout
    expect(html).toContain("404 - Page Not Found");
    expect(html).toContain("does not exist");
    expect(html).toContain('<html lang="en">');
  });

  it("renders error boundary wrapper for routes with error.tsx", async () => {
    const res = await fetch(`${baseUrl}/error-test`);
    expect(res.status).toBe(200);

    const html = await res.text();
    // The page should render normally (error boundary is in the tree but inactive)
    expect(html).toContain("Error Test Page");
    expect(html).toContain("This page has an error boundary");
  });

  it("renders loading.tsx Suspense wrapper for routes with loading.tsx", async () => {
    const res = await fetch(`${baseUrl}/slow`);
    expect(res.status).toBe(200);

    const html = await res.text();
    // The Suspense boundary markers should be present
    expect(html).toContain("Slow Page");
    // Content should render (not the loading fallback, since nothing is async)
    expect(html).toContain("This page has a loading boundary");
  });

  it("route groups are transparent in URL (app/(marketing)/features -> /features)", async () => {
    const res = await fetch(`${baseUrl}/features`);
    expect(res.status).toBe(200);

    const html = await res.text();
    expect(html).toContain("Features");
    expect(html).toContain("route group");
  });

  it("renders next/link as <a> tags with correct hrefs", async () => {
    const res = await fetch(`${baseUrl}/`);
    const html = await res.text();

    // Links should be rendered as <a> tags
    expect(html).toMatch(/<a\s[^>]*href="\/about"[^>]*>Go to About<\/a>/);
    expect(html).toMatch(/<a\s[^>]*href="\/blog\/hello-world"[^>]*>Go to Blog<\/a>/);
    expect(html).toMatch(/<a\s[^>]*href="\/dashboard"[^>]*>Go to Dashboard<\/a>/);
  });

  it("renders dynamic metadata from generateMetadata()", async () => {
    const res = await fetch(`${baseUrl}/blog/my-post`);
    expect(res.status).toBe(200);

    const html = await res.text();
    // Title from generateMetadata should use the dynamic slug
    expect(html).toContain("<title>Blog: my-post</title>");
    expect(html).toMatch(/name="description".*content="Read about my-post"/);
  });

  it("renders catch-all routes with multiple segments", async () => {
    const res = await fetch(`${baseUrl}/docs/getting-started/install`);
    expect(res.status).toBe(200);

    const html = await res.text();
    expect(html).toContain("Documentation");
    expect(html).toContain("getting-started/install");
    // React SSR inserts <!-- --> between text and expressions
    expect(html).toMatch(/Segments:.*2/);
  });

  it("renders optional catch-all with zero segments", async () => {
    const res = await fetch(`${baseUrl}/optional`);
    expect(res.status).toBe(200);

    const html = await res.text();
    expect(html).toContain("Optional Catch-All");
    expect(html).toContain("(root)");
    expect(html).toMatch(/Segments:.*0/);
  });

  it("renders optional catch-all with segments", async () => {
    const res = await fetch(`${baseUrl}/optional/x/y`);
    expect(res.status).toBe(200);

    const html = await res.text();
    expect(html).toContain("x/y");
    expect(html).toMatch(/Segments:.*2/);
  });

  it("renders static metadata (export const metadata) as head elements", async () => {
    const res = await fetch(`${baseUrl}/metadata-test`);
    expect(res.status).toBe(200);

    const html = await res.text();
    expect(html).toContain("Metadata Test");
    // Title from metadata should be rendered
    expect(html).toContain("<title>Metadata Test Page</title>");
    // Description meta tag
    expect(html).toMatch(/name="description".*content="A page to test the metadata API"/);
    // Keywords meta tag
    expect(html).toMatch(/name="keywords".*content="test, metadata, nextcompat"/);
    // Open Graph tags
    expect(html).toMatch(/property="og:title".*content="OG Title"/);
    expect(html).toMatch(/property="og:type".*content="website"/);
  });

  it("renders dynamic page with generateStaticParams export", async () => {
    // generateStaticParams is a no-op in dev mode — the page should
    // render on-demand with any slug, including ones not in the static params list.
    const res = await fetch(`${baseUrl}/blog/any-arbitrary-slug`);
    expect(res.status).toBe(200);

    const html = await res.text();
    expect(html).toContain("Blog Post");
    expect(html).toContain("any-arbitrary-slug");
  });

  it("renders server actions page with 'use client' components", async () => {
    const res = await fetch(`${baseUrl}/actions`);
    expect(res.status).toBe(200);

    const html = await res.text();
    expect(html).toContain("Server Actions");
    expect(html).toContain("Like Button");
    expect(html).toContain("Message Form");
    // Client components should be SSR-rendered
    expect(html).toContain('data-testid="likes"');
    expect(html).toContain('data-testid="like-btn"');
    expect(html).toContain('data-testid="message-input"');
  });

  it("renders template.tsx wrapper around page content", async () => {
    const { html } = await fetchHtml(baseUrl, "/");
    expect(html).toContain('data-testid="root-template"');
    expect(html).toContain("Template Active");
  });

  it("renders template.tsx inside layout (layout > template > page)", async () => {
    const { html } = await fetchHtml(baseUrl, "/about");
    // Template should be present
    expect(html).toContain('data-testid="root-template"');
    // Layout wraps template, so layout HTML should appear before template
    // (Both should be present in the output)
    expect(html).toContain("<html");
    expect(html).toContain("Template Active");
  });

  it("global-error.tsx is discovered and does not interfere with normal rendering", async () => {
    // When global-error.tsx exists, normal pages should still render fine
    // The global error boundary only activates when the root layout throws
    const { res, html } = await fetchHtml(baseUrl, "/");
    expect(res.status).toBe(200);
    expect(html).toContain("Welcome to App Router");
    // global-error content should NOT appear in normal rendering
    expect(html).not.toContain("Something went wrong!");
  });
});

describe("App Router Production build", () => {
  const outDir = path.resolve(APP_FIXTURE_DIR, "dist");

  afterAll(() => {
    fs.rmSync(outDir, { recursive: true, force: true });
  });

  it("produces RSC/SSR/client bundles via vite build", async () => {
    const rsc = (await import("@vitejs/plugin-rsc")).default;

    const builder = await createBuilder({
      root: APP_FIXTURE_DIR,
      configFile: false,
      plugins: [
        nextcompat(),
        rsc({ entries: RSC_ENTRIES }),
      ],
      logLevel: "silent",
    });
    await builder.buildApp();

    // RSC entry should exist
    expect(fs.existsSync(path.join(outDir, "rsc", "index.js"))).toBe(true);
    // SSR entry should exist
    expect(fs.existsSync(path.join(outDir, "ssr", "index.js"))).toBe(true);
    // Client bundle should exist
    expect(fs.existsSync(path.join(outDir, "client"))).toBe(true);

    // Client should have hashed JS assets
    const clientAssets = fs.readdirSync(path.join(outDir, "client", "assets"));
    expect(clientAssets.some((f: string) => f.endsWith(".js"))).toBe(true);

    // RSC bundle should contain route handling code
    const rscEntry = fs.readFileSync(
      path.join(outDir, "rsc", "index.js"),
      "utf-8",
    );
    expect(rscEntry).toContain("handler");

    // Asset manifest should be generated
    expect(
      fs.existsSync(
        path.join(outDir, "rsc", "__vite_rsc_assets_manifest.js"),
      ),
    ).toBe(true);
  }, 30000);

  it("serves production build via preview server", async () => {
    const { preview } = await import("vite");
    const rsc = (await import("@vitejs/plugin-rsc")).default;

    const previewServer = await preview({
      root: APP_FIXTURE_DIR,
      configFile: false,
      plugins: [
        nextcompat(),
        rsc({ entries: RSC_ENTRIES }),
      ],
      preview: { port: 0 },
      logLevel: "silent",
    });

    const addr = previewServer.httpServer.address();
    const previewUrl =
      addr && typeof addr === "object"
        ? `http://localhost:${addr.port}`
        : null;
    expect(previewUrl).not.toBeNull();

    try {
      // Home page renders SSR HTML
      const homeRes = await fetch(`${previewUrl}/`);
      expect(homeRes.status).toBe(200);
      const homeHtml = await homeRes.text();
      expect(homeHtml).toContain("Welcome to App Router");
      expect(homeHtml).toContain("<script");
      // Production bootstrap should reference hashed assets
      expect(homeHtml).toMatch(/import\("\/assets\/[^"]+\.js"\)/);

      // Dynamic route works
      const blogRes = await fetch(`${previewUrl}/blog/test-post`);
      expect(blogRes.status).toBe(200);
      const blogHtml = await blogRes.text();
      expect(blogHtml).toContain("Blog Post");
      expect(blogHtml).toContain("test-post");

      // Nested layout works
      const dashRes = await fetch(`${previewUrl}/dashboard`);
      expect(dashRes.status).toBe(200);
      const dashHtml = await dashRes.text();
      expect(dashHtml).toContain("Dashboard");
      expect(dashHtml).toContain("dashboard-layout");

      // 404 for nonexistent routes
      const notFoundRes = await fetch(`${previewUrl}/no-such-page`);
      expect(notFoundRes.status).toBe(404);

      // RSC endpoint works
      const rscRes = await fetch(`${previewUrl}/about.rsc`);
      expect(rscRes.status).toBe(200);
      expect(rscRes.headers.get("content-type")).toContain("text/x-component");
    } finally {
      previewServer.httpServer.close();
    }
  }, 30000);
});

describe("App Router Static export", () => {
  let server: ViteDevServer;
  let baseUrl: string;
  const exportDir = path.resolve(APP_FIXTURE_DIR, "out");

  beforeAll(async () => {
    ({ server, baseUrl } = await startFixtureServer(APP_FIXTURE_DIR, { appRouter: true }));
  });

  afterAll(async () => {
    await server.close();
    fs.rmSync(exportDir, { recursive: true, force: true });
  });

  it("exports static App Router pages to HTML files", async () => {
    const { staticExportApp } = await import(
      "../packages/vite-plugin-nextcompat/src/build/static-export.js"
    );
    const { appRouter } = await import(
      "../packages/vite-plugin-nextcompat/src/routing/app-router.js"
    );
    const { resolveNextConfig } = await import(
      "../packages/vite-plugin-nextcompat/src/config/next-config.js"
    );

    const appDir = path.resolve(APP_FIXTURE_DIR, "app");
    const routes = await appRouter(appDir);
    const config = await resolveNextConfig({ output: "export" });

    const result = await staticExportApp({
      baseUrl,
      routes,
      appDir,
      server,
      outDir: exportDir,
      config,
    });

    // Should have generated HTML files
    expect(result.pageCount).toBeGreaterThan(0);

    // Index page
    expect(result.files).toContain("index.html");
    const indexHtml = fs.readFileSync(
      path.join(exportDir, "index.html"),
      "utf-8",
    );
    expect(indexHtml).toContain("Welcome to App Router");

    // About page
    expect(result.files).toContain("about.html");
    const aboutHtml = fs.readFileSync(
      path.join(exportDir, "about.html"),
      "utf-8",
    );
    expect(aboutHtml).toContain("About");
  });

  it("pre-renders dynamic routes from generateStaticParams", async () => {
    // blog/[slug] has generateStaticParams returning hello-world and getting-started
    expect(
      fs.existsSync(path.join(exportDir, "blog", "hello-world.html")),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(exportDir, "blog", "getting-started.html")),
    ).toBe(true);

    const blogHtml = fs.readFileSync(
      path.join(exportDir, "blog", "hello-world.html"),
      "utf-8",
    );
    expect(blogHtml).toContain("hello-world");
  });

  it("generates 404.html for App Router", async () => {
    expect(fs.existsSync(path.join(exportDir, "404.html"))).toBe(true);
    const html404 = fs.readFileSync(
      path.join(exportDir, "404.html"),
      "utf-8",
    );
    // Custom not-found.tsx should be rendered
    expect(html404).toContain("Page Not Found");
  });

  it("reports errors for dynamic routes without generateStaticParams", async () => {
    const { staticExportApp } = await import(
      "../packages/vite-plugin-nextcompat/src/build/static-export.js"
    );
    const { resolveNextConfig } = await import(
      "../packages/vite-plugin-nextcompat/src/config/next-config.js"
    );

    // Create a fake route with isDynamic but no generateStaticParams
    const fakeRoutes = [
      {
        pattern: "/fake/:id",
        pagePath: path.resolve(APP_FIXTURE_DIR, "app", "page.tsx"),
        routePath: null,
        layouts: [],
        templates: [],
        loadingPath: null,
        errorPath: null,
        notFoundPath: null,
        isDynamic: true,
        params: ["id"],
      },
    ];
    const config = await resolveNextConfig({ output: "export" });
    const tempDir = path.resolve(APP_FIXTURE_DIR, "out-temp-app");

    try {
      const result = await staticExportApp({
        baseUrl,
        routes: fakeRoutes,
        appDir: path.resolve(APP_FIXTURE_DIR, "app"),
        server,
        outDir: tempDir,
        config,
      });

      // Should have an error about missing generateStaticParams
      expect(
        result.errors.some((e) => e.error.includes("generateStaticParams")),
      ).toBe(true);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("skips route handlers with warning", async () => {
    const { staticExportApp } = await import(
      "../packages/vite-plugin-nextcompat/src/build/static-export.js"
    );
    const { resolveNextConfig } = await import(
      "../packages/vite-plugin-nextcompat/src/config/next-config.js"
    );

    // Create a fake API route
    const fakeRoutes = [
      {
        pattern: "/api/test",
        pagePath: null,
        routePath: path.resolve(APP_FIXTURE_DIR, "app", "api", "hello", "route.ts"),
        layouts: [],
        templates: [],
        loadingPath: null,
        errorPath: null,
        notFoundPath: null,
        isDynamic: false,
        params: [],
      },
    ];
    const config = await resolveNextConfig({ output: "export" });
    const tempDir = path.resolve(APP_FIXTURE_DIR, "out-temp-api");

    try {
      const result = await staticExportApp({
        baseUrl,
        routes: fakeRoutes,
        appDir: path.resolve(APP_FIXTURE_DIR, "app"),
        server,
        outDir: tempDir,
        config,
      });

      expect(result.warnings.some((w) => w.includes("API route"))).toBe(true);
      // Only the 404 page should be generated, no regular pages
      expect(result.files.filter((f) => f !== "404.html")).toHaveLength(0);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("next/navigation shim", () => {
  it("exports usePathname, useSearchParams, useParams, useRouter", async () => {
    const nav = await import(
      "../packages/vite-plugin-nextcompat/src/shims/navigation.js"
    );
    expect(typeof nav.usePathname).toBe("function");
    expect(typeof nav.useSearchParams).toBe("function");
    expect(typeof nav.useParams).toBe("function");
    expect(typeof nav.useRouter).toBe("function");
  });

  it("exports redirect, notFound, permanentRedirect", async () => {
    const nav = await import(
      "../packages/vite-plugin-nextcompat/src/shims/navigation.js"
    );
    expect(typeof nav.redirect).toBe("function");
    expect(typeof nav.notFound).toBe("function");
    expect(typeof nav.permanentRedirect).toBe("function");
  });

  it("redirect() throws with correct digest", async () => {
    const { redirect } = await import(
      "../packages/vite-plugin-nextcompat/src/shims/navigation.js"
    );
    try {
      redirect("/login");
      expect.unreachable("should have thrown");
    } catch (e: any) {
      expect(e.digest).toContain("NEXT_REDIRECT");
      expect(e.digest).toContain("/login");
    }
  });

  it("notFound() throws with correct digest", async () => {
    const { notFound } = await import(
      "../packages/vite-plugin-nextcompat/src/shims/navigation.js"
    );
    try {
      notFound();
      expect.unreachable("should have thrown");
    } catch (e: any) {
      expect(e.digest).toBe("NEXT_NOT_FOUND");
    }
  });

  it("setNavigationContext / useParams works on server side", async () => {
    const { setNavigationContext, useParams } = await import(
      "../packages/vite-plugin-nextcompat/src/shims/navigation.js"
    );
    setNavigationContext({
      pathname: "/blog/test",
      searchParams: new URLSearchParams(""),
      params: { slug: "test" },
    });
    const params = useParams();
    expect(params).toEqual({ slug: "test" });
    setNavigationContext(null);
  });
});

describe("next/headers shim", () => {
  it("exports cookies, headers, draftMode", async () => {
    const mod = await import(
      "../packages/vite-plugin-nextcompat/src/shims/headers.js"
    );
    expect(typeof mod.cookies).toBe("function");
    expect(typeof mod.headers).toBe("function");
    expect(typeof mod.draftMode).toBe("function");
  });

  it("headers() returns request headers from context", async () => {
    const { setHeadersContext, headers } = await import(
      "../packages/vite-plugin-nextcompat/src/shims/headers.js"
    );
    const reqHeaders = new Headers({ "x-custom": "test-value" });
    setHeadersContext({
      headers: reqHeaders,
      cookies: new Map(),
    });

    const h = await headers();
    expect(h.get("x-custom")).toBe("test-value");
    setHeadersContext(null);
  });

  it("cookies() returns parsed cookies from context", async () => {
    const { setHeadersContext, cookies } = await import(
      "../packages/vite-plugin-nextcompat/src/shims/headers.js"
    );
    setHeadersContext({
      headers: new Headers(),
      cookies: new Map([
        ["session", "abc123"],
        ["theme", "dark"],
      ]),
    });

    const c = await cookies();
    expect(c.get("session")).toEqual({ name: "session", value: "abc123" });
    expect(c.get("theme")).toEqual({ name: "theme", value: "dark" });
    expect(c.has("session")).toBe(true);
    expect(c.has("missing")).toBe(false);
    expect(c.size).toBe(2);
    setHeadersContext(null);
  });

  it("headersContextFromRequest parses cookies from Request", async () => {
    const { headersContextFromRequest } = await import(
      "../packages/vite-plugin-nextcompat/src/shims/headers.js"
    );
    const req = new Request("https://example.com", {
      headers: { cookie: "a=1; b=2" },
    });
    const ctx = headersContextFromRequest(req);

    expect(ctx.cookies.get("a")).toBe("1");
    expect(ctx.cookies.get("b")).toBe("2");
    expect(ctx.headers.get("cookie")).toBe("a=1; b=2");
  });

  it("throws when called outside request context", async () => {
    const { headers, cookies } = await import(
      "../packages/vite-plugin-nextcompat/src/shims/headers.js"
    );
    // Ensure context is cleared
    const { setHeadersContext } = await import(
      "../packages/vite-plugin-nextcompat/src/shims/headers.js"
    );
    setHeadersContext(null);

    await expect(headers()).rejects.toThrow("Server Component");
    await expect(cookies()).rejects.toThrow("Server Component");
  });
});

describe("next/server shim", () => {
  it("NextRequest wraps a standard Request with nextUrl and cookies", async () => {
    const { NextRequest } = await import(
      "../packages/vite-plugin-nextcompat/src/shims/server.js"
    );
    const req = new NextRequest("https://example.com/blog?page=2", {
      headers: { cookie: "session=abc123; theme=dark" },
    });

    expect(req.nextUrl.pathname).toBe("/blog");
    expect(req.nextUrl.searchParams.get("page")).toBe("2");
    expect(req.cookies.get("session")).toEqual({ name: "session", value: "abc123" });
    expect(req.cookies.get("theme")).toEqual({ name: "theme", value: "dark" });
    expect(req.cookies.has("session")).toBe(true);
    expect(req.cookies.has("missing")).toBe(false);
  });

  it("NextResponse.json() creates a JSON response", async () => {
    const { NextResponse } = await import(
      "../packages/vite-plugin-nextcompat/src/shims/server.js"
    );
    const res = NextResponse.json({ message: "hello" }, { status: 201 });

    expect(res.status).toBe(201);
    expect(res.headers.get("content-type")).toBe("application/json");
    const body = await res.json();
    expect(body).toEqual({ message: "hello" });
  });

  it("NextResponse.redirect() creates a redirect response", async () => {
    const { NextResponse } = await import(
      "../packages/vite-plugin-nextcompat/src/shims/server.js"
    );
    const res = NextResponse.redirect("https://example.com/new", 308);

    expect(res.status).toBe(308);
    expect(res.headers.get("Location")).toBe("https://example.com/new");
  });

  it("NextResponse.rewrite() sets x-middleware-rewrite header", async () => {
    const { NextResponse } = await import(
      "../packages/vite-plugin-nextcompat/src/shims/server.js"
    );
    const res = NextResponse.rewrite("https://example.com/internal");

    expect(res.headers.get("x-middleware-rewrite")).toBe("https://example.com/internal");
  });

  it("NextResponse.next() sets x-middleware-next header", async () => {
    const { NextResponse } = await import(
      "../packages/vite-plugin-nextcompat/src/shims/server.js"
    );
    const res = NextResponse.next();

    expect(res.headers.get("x-middleware-next")).toBe("1");
  });

  it("ResponseCookies set/get/delete work", async () => {
    const { NextResponse } = await import(
      "../packages/vite-plugin-nextcompat/src/shims/server.js"
    );
    const res = new NextResponse();
    res.cookies.set("token", "xyz", { path: "/", httpOnly: true });

    const cookie = res.cookies.get("token");
    expect(cookie).toBeTruthy();
    expect(cookie!.value).toBe("xyz");

    // Verify the Set-Cookie header was set
    const setCookie = res.headers.getSetCookie();
    expect(setCookie.length).toBeGreaterThan(0);
    expect(setCookie[0]).toContain("token=xyz");
    expect(setCookie[0]).toContain("HttpOnly");
  });

  it("userAgentFromString detects bots", async () => {
    const { userAgentFromString } = await import(
      "../packages/vite-plugin-nextcompat/src/shims/server.js"
    );
    const bot = userAgentFromString("Googlebot/2.1");
    expect(bot.isBot).toBe(true);

    const human = userAgentFromString("Mozilla/5.0");
    expect(human.isBot).toBe(false);
  });
});

describe("next/config shim", () => {
  it("getConfig returns default empty config", async () => {
    const { default: getConfig } = await import(
      "../packages/vite-plugin-nextcompat/src/shims/config.js"
    );
    const config = getConfig();
    expect(config).toEqual({
      serverRuntimeConfig: {},
      publicRuntimeConfig: {},
    });
  });

  it("setConfig updates the runtime config", async () => {
    const { default: getConfig, setConfig } = await import(
      "../packages/vite-plugin-nextcompat/src/shims/config.js"
    );
    setConfig({
      serverRuntimeConfig: { secret: "s3cr3t" },
      publicRuntimeConfig: { appName: "test-app" },
    });
    const config = getConfig();
    expect(config.serverRuntimeConfig.secret).toBe("s3cr3t");
    expect(config.publicRuntimeConfig.appName).toBe("test-app");

    // Reset for other tests
    setConfig({ serverRuntimeConfig: {}, publicRuntimeConfig: {} });
  });
});

describe("next/cache shim", () => {
  it("exports revalidateTag, revalidatePath, unstable_cache", async () => {
    const mod = await import(
      "../packages/vite-plugin-nextcompat/src/shims/cache.js"
    );
    expect(typeof mod.revalidateTag).toBe("function");
    expect(typeof mod.revalidatePath).toBe("function");
    expect(typeof mod.unstable_cache).toBe("function");
  });

  it("exports setCacheHandler and getCacheHandler", async () => {
    const mod = await import(
      "../packages/vite-plugin-nextcompat/src/shims/cache.js"
    );
    expect(typeof mod.setCacheHandler).toBe("function");
    expect(typeof mod.getCacheHandler).toBe("function");
  });

  it("default handler is MemoryCacheHandler", async () => {
    const { getCacheHandler, MemoryCacheHandler } = await import(
      "../packages/vite-plugin-nextcompat/src/shims/cache.js"
    );
    const handler = getCacheHandler();
    expect(handler).toBeInstanceOf(MemoryCacheHandler);
  });

  it("unstable_cache caches function results", async () => {
    const { unstable_cache, setCacheHandler, MemoryCacheHandler } =
      await import("../packages/vite-plugin-nextcompat/src/shims/cache.js");

    // Fresh handler for isolation
    setCacheHandler(new MemoryCacheHandler());

    let callCount = 0;
    const expensive = async (x: number) => {
      callCount++;
      return x * 2;
    };

    const cached = unstable_cache(expensive, ["test-fn"], {
      tags: ["test-tag"],
    });

    const r1 = await cached(5);
    expect(r1).toBe(10);
    expect(callCount).toBe(1);

    const r2 = await cached(5);
    expect(r2).toBe(10);
    expect(callCount).toBe(1); // Should NOT call the function again

    const r3 = await cached(10);
    expect(r3).toBe(20);
    expect(callCount).toBe(2); // Different args = different cache key

    // Reset
    setCacheHandler(new MemoryCacheHandler());
  });

  it("revalidateTag invalidates cached entries", async () => {
    const {
      unstable_cache,
      revalidateTag,
      setCacheHandler,
      MemoryCacheHandler,
    } = await import("../packages/vite-plugin-nextcompat/src/shims/cache.js");

    setCacheHandler(new MemoryCacheHandler());

    let callCount = 0;
    const fn = async () => {
      callCount++;
      return "result-" + callCount;
    };

    const cached = unstable_cache(fn, ["revalidate-test"], {
      tags: ["my-tag"],
    });

    const r1 = await cached();
    expect(r1).toBe("result-1");
    expect(callCount).toBe(1);

    // Revalidate the tag
    await revalidateTag("my-tag");

    // Next call should re-execute the function
    const r2 = await cached();
    expect(r2).toBe("result-2");
    expect(callCount).toBe(2);

    // Reset
    setCacheHandler(new MemoryCacheHandler());
  });

  it("setCacheHandler swaps the active handler", async () => {
    const { setCacheHandler, getCacheHandler, unstable_cache } = await import(
      "../packages/vite-plugin-nextcompat/src/shims/cache.js"
    );

    // Create a custom handler that tracks calls
    const calls: string[] = [];
    const customHandler = {
      async get(key: string) {
        calls.push(`get:${key}`);
        return null;
      },
      async set(key: string) {
        calls.push(`set:${key}`);
      },
      async revalidateTag(tags: string | string[]) {
        const tagList = Array.isArray(tags) ? tags : [tags];
        calls.push(`revalidateTag:${tagList.join(",")}`);
      },
      resetRequestCache() {
        calls.push("reset");
      },
    };

    const originalHandler = getCacheHandler();
    setCacheHandler(customHandler);

    const cached = unstable_cache(async () => 42, ["custom-test"]);
    await cached();

    expect(calls.some((c) => c.startsWith("get:"))).toBe(true);
    expect(calls.some((c) => c.startsWith("set:"))).toBe(true);

    // Restore
    setCacheHandler(originalHandler);
  });

  it("MemoryCacheHandler.get/set round-trips values", async () => {
    const { MemoryCacheHandler } = await import(
      "../packages/vite-plugin-nextcompat/src/shims/cache.js"
    );

    const handler = new MemoryCacheHandler();

    await handler.set("test-key", {
      kind: "FETCH",
      data: { headers: {}, body: '{"x":1}', url: "test" },
      tags: ["t1"],
      revalidate: 3600,
    });

    const result = await handler.get("test-key");
    expect(result).not.toBeNull();
    expect(result!.value).not.toBeNull();
    expect(result!.value!.kind).toBe("FETCH");
    if (result!.value!.kind === "FETCH") {
      expect(result!.value!.data.body).toBe('{"x":1}');
    }
  });

  it("MemoryCacheHandler respects tag invalidation", async () => {
    const { MemoryCacheHandler } = await import(
      "../packages/vite-plugin-nextcompat/src/shims/cache.js"
    );

    const handler = new MemoryCacheHandler();

    await handler.set(
      "tagged-entry",
      {
        kind: "FETCH",
        data: { headers: {}, body: '"cached"', url: "test" },
        tags: ["fresh-tag"],
        revalidate: 3600,
      },
      { tags: ["fresh-tag"] },
    );

    // Should return the entry
    let result = await handler.get("tagged-entry");
    expect(result).not.toBeNull();

    // Invalidate the tag
    await handler.revalidateTag("fresh-tag");

    // Should now return null (invalidated)
    result = await handler.get("tagged-entry");
    expect(result).toBeNull();
  });
});

describe("middleware runner", () => {
  it("findMiddlewareFile finds middleware.ts at project root", async () => {
    const { findMiddlewareFile } = await import(
      "../packages/vite-plugin-nextcompat/src/server/middleware.js"
    );
    // pages-basic fixture has middleware.ts
    const result = findMiddlewareFile(FIXTURE_DIR);
    expect(result).not.toBeNull();
    expect(result).toContain("middleware.ts");
  });

  it("findMiddlewareFile returns null when no middleware exists", async () => {
    const { findMiddlewareFile } = await import(
      "../packages/vite-plugin-nextcompat/src/server/middleware.js"
    );
    const result = findMiddlewareFile("/tmp/nonexistent-dir-" + Date.now());
    expect(result).toBeNull();
  });
});

describe("next/font/google shim", () => {
  it("returns className, style, and variable for a Google Font", async () => {
    const { Inter } = await import(
      "../packages/vite-plugin-nextcompat/src/shims/font-google.js"
    );
    const result = Inter({ subsets: ["latin"], weight: ["400", "700"] });

    expect(result.className).toMatch(/^__font_inter_/);
    expect(result.style.fontFamily).toContain("Inter");
    expect(result.variable).toBe("--font-inter");
  });

  it("Proxy returns font loaders for any family", async () => {
    const mod = await import(
      "../packages/vite-plugin-nextcompat/src/shims/font-google.js"
    );
    const googleFonts = mod.default;
    const loader = googleFonts.Poppins;
    expect(typeof loader).toBe("function");

    const result = loader({ weight: "400" });
    expect(result.className).toMatch(/^__font_poppins_/);
    expect(result.style.fontFamily).toContain("Poppins");
  });

  it("converts PascalCase to font family name", async () => {
    const mod = await import(
      "../packages/vite-plugin-nextcompat/src/shims/font-google.js"
    );
    const googleFonts = mod.default;
    const result = googleFonts.RobotoMono({ weight: "400" });

    expect(result.style.fontFamily).toContain("Roboto Mono");
    expect(result.variable).toBe("--font-roboto-mono");
  });

  it("uses custom variable name when provided", async () => {
    const { Inter } = await import(
      "../packages/vite-plugin-nextcompat/src/shims/font-google.js"
    );
    const result = Inter({ variable: "--custom-font" });
    expect(result.variable).toBe("--custom-font");
  });

  it("uses custom fallback fonts", async () => {
    const { Inter } = await import(
      "../packages/vite-plugin-nextcompat/src/shims/font-google.js"
    );
    const result = Inter({ fallback: ["Helvetica", "Arial", "sans-serif"] });
    expect(result.style.fontFamily).toContain("Helvetica");
    expect(result.style.fontFamily).toContain("Arial");
  });
});

describe("next/font/local shim", () => {
  it("returns className, style for a local font", async () => {
    const { default: localFont } = await import(
      "../packages/vite-plugin-nextcompat/src/shims/font-local.js"
    );
    const result = localFont({ src: "./my-font.woff2" });

    expect(result.className).toMatch(/^__font_local_/);
    expect(result.style.fontFamily).toMatch(/__local_font_/);
  });

  it("includes variable when specified", async () => {
    const { default: localFont } = await import(
      "../packages/vite-plugin-nextcompat/src/shims/font-local.js"
    );
    const result = localFont({
      src: "./my-font.woff2",
      variable: "--font-custom",
    });
    expect(result.variable).toBe("--font-custom");
  });

  it("accepts array of font sources", async () => {
    const { default: localFont } = await import(
      "../packages/vite-plugin-nextcompat/src/shims/font-local.js"
    );
    const result = localFont({
      src: [
        { path: "./regular.woff2", weight: "400" },
        { path: "./bold.woff2", weight: "700" },
      ],
    });

    expect(result.className).toMatch(/^__font_local_/);
    expect(result.style.fontFamily).toBeTruthy();
  });
});

describe("next/og shim", () => {
  it("exports ImageResponse class", async () => {
    const og = await import(
      "../packages/vite-plugin-nextcompat/src/shims/og.js"
    );
    expect(og.ImageResponse).toBeDefined();
    expect(typeof og.ImageResponse).toBe("function");
  });

  it("ImageResponse extends Response", async () => {
    const og = await import(
      "../packages/vite-plugin-nextcompat/src/shims/og.js"
    );
    // Check the prototype chain
    expect(og.ImageResponse.prototype instanceof Response).toBe(true);
  });

  it("generates a PNG image from JSX", async () => {
    const React = await import("react");
    const og = await import(
      "../packages/vite-plugin-nextcompat/src/shims/og.js"
    );

    // Simple colored div — no text so no font needed
    const element = React.createElement(
      "div",
      {
        style: {
          display: "flex",
          width: "100%",
          height: "100%",
          backgroundColor: "#ff6600",
          alignItems: "center",
          justifyContent: "center",
        },
      },
    );

    const response = new og.ImageResponse(element, {
      width: 100,
      height: 100,
    });

    expect(response).toBeInstanceOf(Response);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");

    // Read the response body — should be valid PNG data
    const buffer = await response.arrayBuffer();
    const bytes = new Uint8Array(buffer);

    // PNG magic bytes: 0x89 0x50 0x4E 0x47
    expect(bytes[0]).toBe(0x89);
    expect(bytes[1]).toBe(0x50); // P
    expect(bytes[2]).toBe(0x4e); // N
    expect(bytes[3]).toBe(0x47); // G
  });

  it("respects custom status and headers", async () => {
    const React = await import("react");
    const og = await import(
      "../packages/vite-plugin-nextcompat/src/shims/og.js"
    );

    const element = React.createElement("div", {
      style: { display: "flex", width: "100%", height: "100%", backgroundColor: "blue" },
    });

    const response = new og.ImageResponse(element, {
      width: 50,
      height: 50,
      status: 201,
      headers: { "x-custom": "test-value" },
    });

    expect(response.status).toBe(201);
    expect(response.headers.get("x-custom")).toBe("test-value");
    expect(response.headers.get("content-type")).toBe("image/png");
  });

  it("uses default dimensions of 1200x630", async () => {
    const React = await import("react");
    const og = await import(
      "../packages/vite-plugin-nextcompat/src/shims/og.js"
    );

    const element = React.createElement("div", {
      style: { display: "flex", width: "100%", height: "100%", backgroundColor: "green" },
    });

    // No width/height specified — should use defaults
    const response = new og.ImageResponse(element);
    expect(response).toBeInstanceOf(Response);

    // Verify it produces valid PNG
    const buffer = await response.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    expect(bytes[0]).toBe(0x89); // PNG magic
  });
});

describe("metadata route serializers", () => {
  it("sitemapToXml converts sitemap entries to valid XML", async () => {
    const { sitemapToXml } = await import(
      "../packages/vite-plugin-nextcompat/src/server/metadata-routes.js"
    );
    const xml = sitemapToXml([
      { url: "https://example.com", lastModified: "2025-01-01", priority: 1 },
      { url: "https://example.com/about", changeFrequency: "monthly" as const },
    ]);
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain("<urlset");
    expect(xml).toContain("<loc>https://example.com</loc>");
    expect(xml).toContain("<lastmod>2025-01-01</lastmod>");
    expect(xml).toContain("<priority>1</priority>");
    expect(xml).toContain("<loc>https://example.com/about</loc>");
    expect(xml).toContain("<changefreq>monthly</changefreq>");
  });

  it("sitemapToXml handles Date objects", async () => {
    const { sitemapToXml } = await import(
      "../packages/vite-plugin-nextcompat/src/server/metadata-routes.js"
    );
    const xml = sitemapToXml([
      { url: "https://example.com", lastModified: new Date("2025-06-15") },
    ]);
    expect(xml).toContain("<lastmod>2025-06-15T00:00:00.000Z</lastmod>");
  });

  it("robotsToText converts robots config to text", async () => {
    const { robotsToText } = await import(
      "../packages/vite-plugin-nextcompat/src/server/metadata-routes.js"
    );
    const text = robotsToText({
      rules: { userAgent: "*", allow: "/", disallow: "/private/" },
      sitemap: "https://example.com/sitemap.xml",
    });
    expect(text).toContain("User-Agent: *");
    expect(text).toContain("Allow: /");
    expect(text).toContain("Disallow: /private/");
    expect(text).toContain("Sitemap: https://example.com/sitemap.xml");
  });

  it("robotsToText handles multiple rules", async () => {
    const { robotsToText } = await import(
      "../packages/vite-plugin-nextcompat/src/server/metadata-routes.js"
    );
    const text = robotsToText({
      rules: [
        { userAgent: "Googlebot", allow: "/" },
        { userAgent: "Bingbot", disallow: "/secret" },
      ],
    });
    expect(text).toContain("User-Agent: Googlebot");
    expect(text).toContain("User-Agent: Bingbot");
    expect(text).toContain("Disallow: /secret");
  });

  it("manifestToJson converts manifest config to JSON", async () => {
    const { manifestToJson } = await import(
      "../packages/vite-plugin-nextcompat/src/server/metadata-routes.js"
    );
    const json = manifestToJson({
      name: "Test App",
      short_name: "Test",
      start_url: "/",
      display: "standalone",
    });
    const parsed = JSON.parse(json);
    expect(parsed.name).toBe("Test App");
    expect(parsed.display).toBe("standalone");
  });

  it("scanMetadataFiles discovers metadata files in app directory", async () => {
    const { scanMetadataFiles } = await import(
      "../packages/vite-plugin-nextcompat/src/server/metadata-routes.js"
    );
    const appDir = path.resolve(import.meta.dirname, "../fixtures/app-basic/app");
    const routes = scanMetadataFiles(appDir);

    // Should find our test fixture files
    const types = routes.map((r: { type: string }) => r.type);
    expect(types).toContain("sitemap");
    expect(types).toContain("robots");
    expect(types).toContain("manifest");

    // Sitemap should be dynamic (.ts)
    const sitemap = routes.find((r: { type: string }) => r.type === "sitemap");
    expect(sitemap).toBeDefined();
    expect(sitemap!.isDynamic).toBe(true);
    expect(sitemap!.servedUrl).toBe("/sitemap.xml");
    expect(sitemap!.contentType).toBe("application/xml");
  });
});

describe("metadata routes integration (App Router)", () => {
  // These tests reuse the App Router dev server from the integration tests
  let server: ViteDevServer;
  let baseUrl: string;

  beforeAll(async () => {
    ({ server, baseUrl } = await startFixtureServer(APP_FIXTURE_DIR, { appRouter: true }));
  });

  afterAll(async () => {
    await server.close();
  });

  it("serves /sitemap.xml from dynamic sitemap.ts", async () => {
    const res = await fetch(`${baseUrl}/sitemap.xml`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/xml");
    const xml = await res.text();
    expect(xml).toContain("<urlset");
    expect(xml).toContain("https://example.com");
    expect(xml).toContain("https://example.com/about");
  });

  it("serves /robots.txt from dynamic robots.ts", async () => {
    const res = await fetch(`${baseUrl}/robots.txt`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const text = await res.text();
    expect(text).toContain("User-Agent: *");
    expect(text).toContain("Allow: /");
    expect(text).toContain("Disallow: /private/");
    expect(text).toContain("Sitemap: https://example.com/sitemap.xml");
  });

  it("serves /manifest.webmanifest from dynamic manifest.ts", async () => {
    const res = await fetch(`${baseUrl}/manifest.webmanifest`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/manifest+json");
    const data = await res.json();
    expect(data.name).toBe("App Basic");
    expect(data.display).toBe("standalone");
  });
});

// ---------------------------------------------------------------------------
// ISR (Incremental Static Regeneration) — Pages Router
// ---------------------------------------------------------------------------

describe("ISR (Pages Router)", () => {
  let server: ViteDevServer;
  let baseUrl: string;

  beforeAll(async () => {
    ({ server, baseUrl } = await startFixtureServer(FIXTURE_DIR));
  });

  afterAll(async () => {
    await server?.close();
  });

  it("renders ISR page on first request (cache MISS)", async () => {
    const res = await fetch(`${baseUrl}/isr-test`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("ISR Page");
    expect(html).toContain("Hello from ISR");
    // First request should be a cache miss
    expect(res.headers.get("x-nextcompat-cache")).toBe("MISS");
    expect(res.headers.get("cache-control")).toContain("s-maxage=1");
  });

  it("serves cached ISR page on second request (cache HIT)", async () => {
    // First request populates the cache
    const res1 = await fetch(`${baseUrl}/isr-test`);
    expect(res1.status).toBe(200);
    const html1 = await res1.text();
    const timestamp1Match = html1.match(/data-testid="timestamp">(\d+)</);
    expect(timestamp1Match).toBeTruthy();
    const timestamp1 = timestamp1Match![1];

    // Second request should be a cache hit with same timestamp
    const res2 = await fetch(`${baseUrl}/isr-test`);
    expect(res2.status).toBe(200);
    const html2 = await res2.text();
    expect(res2.headers.get("x-nextcompat-cache")).toBe("HIT");
    const timestamp2Match = html2.match(/data-testid="timestamp">(\d+)</);
    expect(timestamp2Match).toBeTruthy();
    expect(timestamp2Match![1]).toBe(timestamp1);
  });

  it("serves stale content after TTL expires then regenerates", async () => {
    // First request populates cache
    const res1 = await fetch(`${baseUrl}/isr-test`);
    const html1 = await res1.text();
    const timestamp1Match = html1.match(/data-testid="timestamp">(\d+)</);
    const timestamp1 = timestamp1Match![1];

    // Wait for TTL to expire (revalidate: 1 second)
    await new Promise((r) => setTimeout(r, 1200));

    // Request after TTL should get STALE content
    const res2 = await fetch(`${baseUrl}/isr-test`);
    expect(res2.status).toBe(200);
    expect(res2.headers.get("x-nextcompat-cache")).toBe("STALE");
    // Stale content should have the same timestamp as original
    const html2 = await res2.text();
    const timestamp2Match = html2.match(/data-testid="timestamp">(\d+)</);
    expect(timestamp2Match![1]).toBe(timestamp1);

    // Wait a moment for background regeneration to complete
    await new Promise((r) => setTimeout(r, 200));

    // Next request should get fresh content from cache
    const res3 = await fetch(`${baseUrl}/isr-test`);
    expect(res3.status).toBe(200);
    // Should be a HIT now (fresh entry from background regen)
    expect(res3.headers.get("x-nextcompat-cache")).toBe("HIT");
  });

  it("sets Cache-Control header for ISR pages", async () => {
    const res = await fetch(`${baseUrl}/isr-test`);
    const cacheControl = res.headers.get("cache-control");
    expect(cacheControl).toContain("s-maxage=1");
    expect(cacheControl).toContain("stale-while-revalidate");
  });

  it("does not set ISR headers for non-ISR pages", async () => {
    const res = await fetch(`${baseUrl}/about`);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-nextcompat-cache")).toBeNull();
    expect(res.headers.get("cache-control")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ISR cache internals
// ---------------------------------------------------------------------------

describe("ISR cache internals", () => {
  it("MemoryCacheHandler returns stale entries instead of null", async () => {
    const { MemoryCacheHandler } = await import(
      "../packages/vite-plugin-nextcompat/src/shims/cache.js"
    );
    const handler = new MemoryCacheHandler();

    // Set an entry with a very short TTL
    await handler.set("test-stale", { kind: "FETCH", data: { headers: {}, body: "test", url: "" }, tags: [], revalidate: 0 }, { revalidate: 0.001 });

    // Wait for it to expire
    await new Promise((r) => setTimeout(r, 10));

    // Should return the entry with cacheState: "stale"
    const result = await handler.get("test-stale");
    expect(result).not.toBeNull();
    expect(result!.cacheState).toBe("stale");
    expect(result!.value).not.toBeNull();
  });

  it("MemoryCacheHandler returns fresh entries without cacheState", async () => {
    const { MemoryCacheHandler } = await import(
      "../packages/vite-plugin-nextcompat/src/shims/cache.js"
    );
    const handler = new MemoryCacheHandler();

    await handler.set("test-fresh", { kind: "FETCH", data: { headers: {}, body: "test", url: "" }, tags: [], revalidate: 0 }, { revalidate: 60 });

    const result = await handler.get("test-fresh");
    expect(result).not.toBeNull();
    expect(result!.cacheState).toBeUndefined();
  });

  it("MemoryCacheHandler still returns null for tag-invalidated entries", async () => {
    const { MemoryCacheHandler } = await import(
      "../packages/vite-plugin-nextcompat/src/shims/cache.js"
    );
    const handler = new MemoryCacheHandler();

    await handler.set("test-tag", { kind: "FETCH", data: { headers: {}, body: "test", url: "" }, tags: ["mytag"], revalidate: 0 }, { revalidate: 60, tags: ["mytag"] });

    // Invalidate the tag
    await handler.revalidateTag("mytag");

    // Should return null (hard invalidation, not stale)
    const result = await handler.get("test-tag");
    expect(result).toBeNull();
  });
});
