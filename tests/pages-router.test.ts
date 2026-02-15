import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, build, type ViteDevServer } from "vite";
import path from "node:path";
import fs from "node:fs";
import vinext from "../packages/vinext/src/index.js";
import { PAGES_FIXTURE_DIR, startFixtureServer } from "./helpers.js";

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
    expect(html).toContain("Hello, vinext!");
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

  it("getServerSideProps returning notFound renders custom 404 page", async () => {
    const res = await fetch(`${baseUrl}/posts/missing`);
    expect(res.status).toBe(404);
    const html = await res.text();
    // Should render the custom 404 page (pages/404.tsx), not plain text
    expect(html).toContain("Page Not Found");
    // Should be wrapped in the _app layout
    expect(html).toContain("app-wrapper");
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
    // Index page has <Head><title>Hello vinext</title></Head>
    // This should appear in the actual <head> of the HTML
    expect(html).toContain("<title");
    expect(html).toContain("Hello vinext");
    // The title tag should be in <head>, not in <body>
    const headSection = html.split("</head>")[0];
    expect(headSection).toContain("Hello vinext");
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
    expect(html).toContain("A vinext test app");
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
    expect(res.headers.get("x-custom-header")).toBe("vinext");
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

  it("renders pre-listed paths with getStaticPaths fallback: blocking", async () => {
    const res = await fetch(`${baseUrl}/articles/1`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("First Article");
    expect(html).toMatch(/Article ID:\s*(<!--\s*-->)?\s*1/);
  });

  it("renders unlisted paths with getStaticPaths fallback: blocking (on-demand SSR)", async () => {
    // Article 99 is not in getStaticPaths but fallback: blocking allows rendering
    const res = await fetch(`${baseUrl}/articles/99`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Article 99");
    expect(html).toMatch(/Article ID:\s*(<!--\s*-->)?\s*99/);
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

  // --- getStaticPaths tests ---

  it("renders blog post with getStaticPaths fallback: false for listed path", async () => {
    const res = await fetch(`${baseUrl}/blog/hello-world`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Hello World");
    expect(html).toMatch(/Blog post slug:.*hello-world/);
  });

  it("returns 404 for unlisted path with getStaticPaths fallback: false", async () => {
    const res = await fetch(`${baseUrl}/blog/nonexistent`);
    expect(res.status).toBe(404);
  });

  it("renders article with getStaticPaths fallback: 'blocking' for listed path", async () => {
    const res = await fetch(`${baseUrl}/articles/1`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("First Article");
    expect(html).toMatch(/Article ID:.*1/);
  });

  it("SSR renders unlisted path with getStaticPaths fallback: 'blocking'", async () => {
    const res = await fetch(`${baseUrl}/articles/99`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toMatch(/Article\s*(<!-- -->)?\s*99/);
    expect(html).toMatch(/Article ID:.*99/);
  });

  it("renders product with getStaticPaths fallback: true for listed path", async () => {
    const res = await fetch(`${baseUrl}/products/widget`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Super Widget");
    expect(html).toMatch(/Product ID:.*widget/);
    expect(html).toMatch(/isFallback:.*false/);
  });

  it("SSR renders unlisted path with getStaticPaths fallback: true (on-demand)", async () => {
    // In dev/SSR mode, fallback: true still renders fully (same as blocking)
    // because data is always available via on-demand SSR.
    const res = await fetch(`${baseUrl}/products/unknown`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toMatch(/Product\s*(<!-- -->)?\s*unknown/);
    expect(html).toMatch(/Product ID:.*unknown/);
    // isFallback should be false since we always SSR fully
    expect(html).toMatch(/isFallback:.*false/);
  });

  it("includes isFallback: false in __NEXT_DATA__", async () => {
    const res = await fetch(`${baseUrl}/products/widget`);
    const html = await res.text();
    const match = html.match(/__NEXT_DATA__\s*=\s*(\{.*?\})\s*[;<]/);
    expect(match).toBeTruthy();
    const nextData = JSON.parse(match![1]);
    expect(nextData.isFallback).toBe(false);
  });
});

describe("Virtual server entry generation", () => {
  it("generates valid JavaScript for the server entry", async () => {
    // Create a minimal server just to access the plugin's virtual module
    const testServer = await createServer({
      root: FIXTURE_DIR,
      configFile: false,
      plugins: [vinext()],
      server: { port: 0 },
      logLevel: "silent",
    });

    try {
      // Load the virtual module through Vite's SSR pipeline
      const entry = await testServer.ssrLoadModule("virtual:vinext-server-entry");

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
      plugins: [vinext()],
      logLevel: "silent",
      build: {
        outDir: path.join(outDir, "server"),
        ssr: "virtual:vinext-server-entry",
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
      plugins: [vinext()],
      logLevel: "silent",
      build: {
        outDir: path.join(outDir, "client"),
        ssrManifest: true,
        rollupOptions: {
          input: "virtual:vinext-client-entry",
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
        plugins: [vinext()],
        logLevel: "silent",
        build: {
          outDir: path.join(outDir, "server"),
          ssr: "virtual:vinext-server-entry",
          rollupOptions: { output: { entryFileNames: "entry.js" } },
        },
      });
      await build({
        root: FIXTURE_DIR,
        configFile: false,
        plugins: [vinext()],
        logLevel: "silent",
        build: {
          outDir: path.join(outDir, "client"),
          ssrManifest: true,
          rollupOptions: { input: "virtual:vinext-client-entry" },
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
      expect(indexHtml).toContain("Hello, vinext!");
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

describe("Static export (Pages Router)", () => {
  let server: ViteDevServer;
  const exportDir = path.resolve(FIXTURE_DIR, "out");

  beforeAll(async () => {
    server = await createServer({
      root: FIXTURE_DIR,
      configFile: false,
      plugins: [vinext()],
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
      "../packages/vinext/src/build/static-export.js"
    );
    const { pagesRouter, apiRouter } = await import(
      "../packages/vinext/src/routing/pages-router.js"
    );
    const { resolveNextConfig } = await import(
      "../packages/vinext/src/config/next-config.js"
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
    expect(indexHtml).toContain("Hello, vinext!");

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
      "../packages/vinext/src/build/static-export.js"
    );
    const { pagesRouter, apiRouter } = await import(
      "../packages/vinext/src/routing/pages-router.js"
    );
    const { resolveNextConfig } = await import(
      "../packages/vinext/src/config/next-config.js"
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
      "../packages/vinext/src/build/static-export.js"
    );
    const { pagesRouter, apiRouter } = await import(
      "../packages/vinext/src/routing/pages-router.js"
    );
    const { resolveNextConfig } = await import(
      "../packages/vinext/src/config/next-config.js"
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

describe("router __NEXT_DATA__ correctness (Pages Router)", () => {
  let routerServer: ViteDevServer;
  let routerBaseUrl: string;

  beforeAll(async () => {
    ({ server: routerServer, baseUrl: routerBaseUrl } = await startFixtureServer(FIXTURE_DIR));
  });

  afterAll(async () => {
    await routerServer?.close();
  });

  it("dynamic route params are included in __NEXT_DATA__.query", async () => {
    const res = await fetch(`${routerBaseUrl}/blog/hello-world`);
    expect(res.status).toBe(200);
    const html = await res.text();
    const match = html.match(/<script>window\.__NEXT_DATA__\s*=\s*({.*?})<\/script>/);
    expect(match).toBeTruthy();
    const nextData = JSON.parse(match![1]);
    expect(nextData.query).toEqual({ slug: "hello-world" });
    expect(nextData.page).toBe("/blog/[slug]");
  });

  it("__NEXT_DATA__.page is the route pattern, not the actual path", async () => {
    const res = await fetch(`${routerBaseUrl}/posts/hello-world`);
    expect(res.status).toBe(200);
    const html = await res.text();
    const match = html.match(/<script>window\.__NEXT_DATA__\s*=\s*({.*?})<\/script>/);
    const nextData = JSON.parse(match![1]);
    expect(nextData.page).toBe("/posts/[id]");
    expect(nextData.query.id).toBe("hello-world");
  });

  it("catch-all route pattern in __NEXT_DATA__.page", async () => {
    const res = await fetch(`${routerBaseUrl}/docs/a/b/c`);
    expect(res.status).toBe(200);
    const html = await res.text();
    const match = html.match(/<script>window\.__NEXT_DATA__\s*=\s*({.*?})<\/script>/);
    const nextData = JSON.parse(match![1]);
    expect(nextData.page).toBe("/docs/[...slug]");
  });

  it("__NEXT_DATA__ includes isFallback: false", async () => {
    const res = await fetch(`${routerBaseUrl}/blog/hello-world`);
    const html = await res.text();
    const match = html.match(/<script>window\.__NEXT_DATA__\s*=\s*({.*?})<\/script>/);
    const nextData = JSON.parse(match![1]);
    expect(nextData.isFallback).toBe(false);
  });

  it("static page __NEXT_DATA__.page is the pathname", async () => {
    const res = await fetch(`${routerBaseUrl}/about`);
    const html = await res.text();
    const match = html.match(/<script>window\.__NEXT_DATA__\s*=\s*({.*?})<\/script>/);
    const nextData = JSON.parse(match![1]);
    expect(nextData.page).toBe("/about");
  });

  it("shallow-test page returns correct __NEXT_DATA__ with GSSP props", async () => {
    const res = await fetch(`${routerBaseUrl}/shallow-test`);
    expect(res.status).toBe(200);
    const html = await res.text();
    const match = html.match(/<script>window\.__NEXT_DATA__\s*=\s*({.*?})<\/script>/);
    const nextData = JSON.parse(match![1]);
    expect(nextData.page).toBe("/shallow-test");
    expect(nextData.props.pageProps.gsspCallId).toBeGreaterThan(0);
  });
});
