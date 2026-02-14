import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, build, type ViteDevServer } from "vite";
import path from "node:path";
import fs from "node:fs";
import nextcompat from "../packages/vite-plugin-nextcompat/src/index.js";

const FIXTURE_DIR = path.resolve(
  import.meta.dirname,
  "../fixtures/pages-basic",
);

describe("Pages Router integration", () => {
  let server: ViteDevServer;
  let baseUrl: string;

  beforeAll(async () => {
    // Start a Vite dev server with our plugin against the fixture.
    // configFile: false prevents loading the fixture's vite.config.ts
    // (which also registers the plugin, causing duplicate/conflict).
    server = await createServer({
      root: FIXTURE_DIR,
      configFile: false,
      plugins: [nextcompat()],
      server: { port: 0 }, // random port
      logLevel: "silent",
    });

    await server.listen();
    const address = server.httpServer?.address();
    if (address && typeof address === "object") {
      baseUrl = `http://localhost:${address.port}`;
    }
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
