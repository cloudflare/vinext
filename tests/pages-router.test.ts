import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createServer, build, type ViteDevServer } from "vite";
import path from "node:path";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
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

  it("resolves tsconfig path aliases (@/ imports)", async () => {
    const res = await fetch(`${baseUrl}/alias-test`);
    expect(res.status).toBe(200);

    const html = await res.text();
    expect(html).toContain("Pages Alias Test");
    // Component imported via @/components/heavy
    expect(html).toContain("Loaded via alias");
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

  // ── Percent-encoded paths should be decoded before config matching ──

  it("percent-encoded redirect path is decoded before config matching (dev)", async () => {
    // /%6Fld-%61bout decodes to /old-about → /about (permanent redirect)
    const res = await fetch(`${baseUrl}/%6Fld-%61bout`, { redirect: "manual" });
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe("/about");
  });

  it("percent-encoded header path is decoded before config matching (dev)", async () => {
    // /%61pi/hello decodes to /api/hello → X-Custom-Header: vinext
    const res = await fetch(`${baseUrl}/%61pi/hello`);
    expect(res.headers.get("x-custom-header")).toBe("vinext");
  });

  it("percent-encoded rewrite path is decoded before config matching (dev)", async () => {
    // /%62efore-rewrite decodes to /before-rewrite → /about
    const res = await fetch(`${baseUrl}/%62efore-rewrite`);
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
    expect(res.headers.get("x-custom-middleware")).toBe("active");
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
    // With progressive streaming SSR (onShellReady), if the Suspense
    // content resolves before the shell finishes, React inlines it
    // directly (no fallback in the wire HTML). If it resolves after,
    // the fallback appears with streaming replacement scripts.
    // Our lazy component resolves synchronously in tests.
    const res = await fetch(`${baseUrl}/suspense-test`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Suspense Test");
    // The lazy component's content should be in the response
    expect(html).toContain("Hello from lazy component");
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

  // ── Cross-origin request protection ─────────────────────────────────
  it("blocks page requests with cross-origin Origin header", async () => {
    const res = await fetch(`${baseUrl}/`, {
      headers: {
        "Origin": "https://evil.com",
        "Host": new URL(baseUrl).host,
      },
    });
    expect(res.status).toBe(403);
    const text = await res.text();
    expect(text).toBe("Forbidden");
  });

  it("blocks API requests with cross-origin Origin header", async () => {
    const res = await fetch(`${baseUrl}/api/hello`, {
      headers: {
        "Origin": "https://external.io",
        "Host": new URL(baseUrl).host,
      },
    });
    expect(res.status).toBe(403);
  });

  it("blocks requests with cross-site Sec-Fetch headers", async () => {
    // Node.js fetch overrides Sec-Fetch-* headers (they're forbidden headers
    // in the Fetch spec). Use raw HTTP to simulate browser behavior.
    const http = await import("node:http");
    const url = new URL(baseUrl);
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request({
        hostname: url.hostname,
        port: url.port,
        path: "/",
        method: "GET",
        headers: {
          "sec-fetch-site": "cross-site",
          "sec-fetch-mode": "no-cors",
        },
      }, (res) => resolve(res.statusCode ?? 0));
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(403);
  });

  it("allows page requests from localhost origin", async () => {
    const res = await fetch(`${baseUrl}/`, {
      headers: {
        "Origin": baseUrl,
        "Host": new URL(baseUrl).host,
      },
    });
    expect(res.status).toBe(200);
  });

  it("allows page requests without Origin header", async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
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

  it("client entry uses Next.js bracket format for dynamic route keys", async () => {
    // The client entry generates a pageLoaders map keyed by route pattern.
    // These keys MUST match __NEXT_DATA__.page (which uses Next.js bracket
    // format like "/posts/[id]"), not the internal Express-style ":id" format.
    // A mismatch prevents client-side hydration for dynamic route pages.
    const testServer = await createServer({
      root: FIXTURE_DIR,
      configFile: false,
      plugins: [vinext()],
      server: { port: 0 },
      logLevel: "silent",
    });

    try {
      const resolved = await testServer.pluginContainer.resolveId("virtual:vinext-client-entry");
      expect(resolved).toBeTruthy();
      const loaded = await testServer.pluginContainer.load(resolved!.id);
      expect(loaded).toBeTruthy();
      const code = typeof loaded === "string" ? loaded : (loaded as any)?.code ?? "";

      // Dynamic routes should use [param] format, not :param
      // The fixture has pages/posts/[id].tsx
      expect(code).toContain('"/posts/[id]"');
      // Catch-all routes: pages/docs/[...slug].tsx
      expect(code).toContain('"/docs/[...slug]"');
      // Should NOT contain Express-style :param patterns for any route
      expect(code).not.toMatch(/["']\/(posts|blog|articles|docs|products)\/:[\w]+["']/);
      expect(code).not.toContain(":slug+");
      expect(code).not.toContain(":slug*");
    } finally {
      await testServer.close();
    }
  });
});

describe("Plugin config", () => {
  it("adds resolve.dedupe for React packages to prevent dual instance errors", async () => {
    const plugins = vinext() as any[];
    const configPlugin = plugins.find((p) => p.name === "vinext:config");
    expect(configPlugin).toBeDefined();

    // Call the config hook with a minimal config
    const result = await configPlugin.config({ root: FIXTURE_DIR, plugins: [] });

    expect(result.resolve).toBeDefined();
    expect(result.resolve.dedupe).toBeDefined();
    expect(result.resolve.dedupe).toContain("react");
    expect(result.resolve.dedupe).toContain("react-dom");
    expect(result.resolve.dedupe).toContain("react/jsx-runtime");
    expect(result.resolve.dedupe).toContain("react/jsx-dev-runtime");
  });

  it("suppresses MODULE_LEVEL_DIRECTIVE warnings from Rollup", async () => {
    const plugins = vinext() as any[];
    const configPlugin = plugins.find((p) => p.name === "vinext:config");
    expect(configPlugin).toBeDefined();

    const result = await configPlugin.config({ root: FIXTURE_DIR, plugins: [] });

    expect(result.build).toBeDefined();
    expect(result.build.rollupOptions).toBeDefined();
    expect(result.build.rollupOptions.onwarn).toBeDefined();

    const defaultHandler = vi.fn();

    // "use client" MODULE_LEVEL_DIRECTIVE warnings should be silenced
    result.build.rollupOptions.onwarn(
      { code: "MODULE_LEVEL_DIRECTIVE", message: '"use client" was ignored' },
      defaultHandler,
    );
    expect(defaultHandler).not.toHaveBeenCalled();

    // "use server" MODULE_LEVEL_DIRECTIVE warnings should be silenced
    result.build.rollupOptions.onwarn(
      { code: "MODULE_LEVEL_DIRECTIVE", message: '"use server" was ignored' },
      defaultHandler,
    );
    expect(defaultHandler).not.toHaveBeenCalled();

    // MODULE_LEVEL_DIRECTIVE warnings for other directives should pass through
    const otherDirectiveWarning = {
      code: "MODULE_LEVEL_DIRECTIVE",
      message: '"use strict" was ignored',
    };
    result.build.rollupOptions.onwarn(otherDirectiveWarning, defaultHandler);
    expect(defaultHandler).toHaveBeenCalledWith(otherDirectiveWarning);

    // Other warning codes should pass through to the default handler
    defaultHandler.mockClear();
    const otherWarning = { code: "CIRCULAR_DEPENDENCY", message: "circular" };
    result.build.rollupOptions.onwarn(otherWarning, defaultHandler);
    expect(defaultHandler).toHaveBeenCalledWith(otherWarning);
  });

  it("preserves user-supplied build.rollupOptions.onwarn", async () => {
    const plugins = vinext() as any[];
    const configPlugin = plugins.find((p) => p.name === "vinext:config");
    expect(configPlugin).toBeDefined();

    const userOnwarn = vi.fn();
    const result = await configPlugin.config({
      root: FIXTURE_DIR,
      plugins: [],
      build: { rollupOptions: { onwarn: userOnwarn } },
    });

    const defaultHandler = vi.fn();

    // "use client" should still be suppressed (user handler NOT called)
    result.build.rollupOptions.onwarn(
      { code: "MODULE_LEVEL_DIRECTIVE", message: '"use client" was ignored' },
      defaultHandler,
    );
    expect(userOnwarn).not.toHaveBeenCalled();
    expect(defaultHandler).not.toHaveBeenCalled();

    // Other warnings should be forwarded to the user's handler
    const otherWarning = { code: "CIRCULAR_DEPENDENCY", message: "circular" };
    result.build.rollupOptions.onwarn(otherWarning, defaultHandler);
    expect(userOnwarn).toHaveBeenCalledWith(otherWarning, defaultHandler);
    expect(defaultHandler).not.toHaveBeenCalled();
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
        manifest: true,
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

    // Verify build manifest was also produced (needed for lazy chunk computation)
    const buildManifestPath = path.join(outDir, "client", ".vite", "manifest.json");
    expect(fs.existsSync(buildManifestPath)).toBe(true);

    // There should be JS files in the assets directory
    const assets = fs.readdirSync(assetsDir);
    const jsFiles = assets.filter((f: string) => f.endsWith(".js"));
    expect(jsFiles.length).toBeGreaterThan(0);

    // Client bundle should be code-split: framework (React/ReactDOM) in its
    // own chunk, vinext runtime in another, and the entry bootstrap should be
    // small (not a monolithic bundle containing all vendor code).
    const frameworkChunk = jsFiles.find((f: string) => f.startsWith("framework-"));
    const vinextChunk = jsFiles.find((f: string) => f.startsWith("vinext-"));
    const entryChunk = jsFiles.find((f: string) => f.includes("vinext-client-entry"));
    expect(frameworkChunk).toBeDefined();
    expect(vinextChunk).toBeDefined();
    expect(entryChunk).toBeDefined();

    // The entry chunk should be small (just the hydration bootstrap, not the
    // entire React framework). Before code-splitting this was ~200KB+.
    if (entryChunk) {
      const entrySize = fs.statSync(path.join(assetsDir, entryChunk)).size;
      expect(entrySize).toBeLessThan(20 * 1024); // < 20 KB
    }
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
          manifest: true,
          ssrManifest: true,
          rollupOptions: { input: "virtual:vinext-client-entry" },
        },
      });
    }

    // Import the server entry
    const serverEntry = await import(pathToFileURL(serverEntryPath).href);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));

    // Create a minimal HTTP server using the built entry.
    // The server entry uses Web-standard Request/Response, so we bridge
    // from Node.js HTTP objects.
    const { createServer: createHttpServer } = await import("node:http");
    const httpServer = createHttpServer(async (req, res) => {
      const url = req.url ?? "/";
      const pathname = url.split("?")[0];

      // Convert Node.js req to Web Request
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (v) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
      }
      const host = req.headers.host ?? "localhost";
      const webRequest = new Request(`http://${host}${url}`, {
        method: req.method,
        headers,
      });

      let response: Response;
      if (pathname.startsWith("/api/") || pathname === "/api") {
        response = await serverEntry.handleApiRoute(webRequest, url);
      } else {
        response = await serverEntry.renderPage(webRequest, url, manifest);
      }

      // Pipe Web Response back to Node.js res
      const body = await response.text();
      const resHeaders: Record<string, string> = {};
      response.headers.forEach((v: string, k: string) => { resHeaders[k] = v; });
      res.writeHead(response.status, resHeaders);
      res.end(body);
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

  it("server entry exports runMiddleware function", async () => {
    const serverEntryPath = path.join(outDir, "server", "entry.js");
    const serverEntry = await import(pathToFileURL(serverEntryPath).href);
    expect(typeof serverEntry.runMiddleware).toBe("function");
  });

  it("runMiddleware skips non-matching paths", async () => {
    const serverEntryPath = path.join(outDir, "server", "entry.js");
    const serverEntry = await import(pathToFileURL(serverEntryPath).href);
    // The middleware matcher is /((?!api|_next|favicon\.ico).*) so /api should not match
    const request = new Request("http://localhost/api/hello");
    const result = await serverEntry.runMiddleware(request);
    expect(result.continue).toBe(true);
    expect(result.redirectUrl).toBeUndefined();
  });

  it("runMiddleware handles redirect (/old-page -> /about)", async () => {
    const serverEntryPath = path.join(outDir, "server", "entry.js");
    const serverEntry = await import(pathToFileURL(serverEntryPath).href);
    const request = new Request("http://localhost/old-page");
    const result = await serverEntry.runMiddleware(request);
    expect(result.continue).toBe(false);
    expect(result.redirectUrl).toContain("/about");
    expect(result.redirectStatus).toBe(307);
  });

  it("runMiddleware handles rewrite (/rewritten -> /ssr)", async () => {
    const serverEntryPath = path.join(outDir, "server", "entry.js");
    const serverEntry = await import(pathToFileURL(serverEntryPath).href);
    const request = new Request("http://localhost/rewritten");
    const result = await serverEntry.runMiddleware(request);
    expect(result.continue).toBe(true);
    expect(result.rewriteUrl).toContain("/ssr");
  });

  it("runMiddleware handles block (/blocked -> 403)", async () => {
    const serverEntryPath = path.join(outDir, "server", "entry.js");
    const serverEntry = await import(pathToFileURL(serverEntryPath).href);
    const request = new Request("http://localhost/blocked");
    const result = await serverEntry.runMiddleware(request);
    expect(result.continue).toBe(false);
    expect(result.response).toBeInstanceOf(Response);
    expect(result.response.status).toBe(403);
  });

  it("runMiddleware sets x-custom-middleware header on matched paths", async () => {
    const serverEntryPath = path.join(outDir, "server", "entry.js");
    const serverEntry = await import(pathToFileURL(serverEntryPath).href);
    // /about matches the middleware but doesn't redirect/rewrite/block
    const request = new Request("http://localhost/about");
    const result = await serverEntry.runMiddleware(request);
    expect(result.continue).toBe(true);
    expect(result.responseHeaders).toBeDefined();
    expect(result.responseHeaders.get("x-custom-middleware")).toBe("active");
  });

  it("runMiddleware returns 500 when middleware throws", async () => {
    const serverEntryPath = path.join(outDir, "server", "entry.js");
    const serverEntry = await import(pathToFileURL(serverEntryPath).href);
    const request = new Request("http://localhost/middleware-throw");
    const result = await serverEntry.runMiddleware(request);
    expect(result.continue).toBe(false);
    expect(result.response).toBeInstanceOf(Response);
    expect(result.response.status).toBe(500);
  });
});

describe("Production server middleware (Pages Router)", () => {
  const outDir = path.resolve(FIXTURE_DIR, "dist");
  let prodServer: import("node:http").Server;
  let prodUrl: string;

  beforeAll(async () => {
    const serverEntryPath = path.join(outDir, "server", "entry.js");
    const manifestPath = path.join(outDir, "client", ".vite", "ssr-manifest.json");

    // Build if needed (tests may run in isolation)
    if (!fs.existsSync(serverEntryPath) || !fs.existsSync(manifestPath)) {
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
          manifest: true,
          ssrManifest: true,
          rollupOptions: { input: "virtual:vinext-client-entry" },
        },
      });
    }

    const { startProdServer } = await import(
      "../packages/vinext/src/server/prod-server.js"
    );
    prodServer = await startProdServer({
      port: 0,
      host: "127.0.0.1",
      outDir,
    });
    const addr = prodServer.address() as { port: number };
    prodUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    if (prodServer) {
      await new Promise<void>((resolve) => prodServer.close(() => resolve()));
    }
  });

  it("redirects /old-page to /about via middleware", async () => {
    const res = await fetch(`${prodUrl}/old-page`, { redirect: "manual" });
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/about");
  });

  it("rewrites /rewritten to render /ssr content", async () => {
    const res = await fetch(`${prodUrl}/rewritten`);
    expect(res.status).toBe(200);
    const html = await res.text();
    // /rewritten should serve the content of /ssr page
    expect(html).toContain("Server-Side Rendered");
  });

  it("blocks /blocked with 403 via middleware", async () => {
    const res = await fetch(`${prodUrl}/blocked`);
    expect(res.status).toBe(403);
    const text = await res.text();
    expect(text).toContain("Access Denied");
  });

  it("returns 500 when middleware throws", async () => {
    const res = await fetch(`${prodUrl}/middleware-throw`);
    expect(res.status).toBe(500);
  });

  it("sets x-custom-middleware header on matched requests", async () => {
    const res = await fetch(`${prodUrl}/about`);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-custom-middleware")).toBe("active");
  });

  it("does not run middleware on /api routes", async () => {
    const res = await fetch(`${prodUrl}/api/hello`);
    expect(res.status).toBe(200);
    // Middleware matcher excludes /api, so no x-custom-middleware header
    expect(res.headers.get("x-custom-middleware")).toBeNull();
  });

  it("preserves binary API response bytes", async () => {
    const res = await fetch(`${prodUrl}/api/binary`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/octet-stream");

    const body = Buffer.from(await res.arrayBuffer());
    // Must match exactly: invalid UTF-8-leading bytes + null + ASCII tail.
    // This catches any accidental text() decode/re-encode in prod-server.
    expect(body.equals(Buffer.from([0xff, 0xfe, 0xfd, 0x00, 0x61, 0x62, 0x63]))).toBe(true);
  });

  it("serves normal pages without middleware interference", async () => {
    const res = await fetch(`${prodUrl}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Hello, vinext!");
  });

  it("returns 400 for malformed percent-encoded path (not crash)", async () => {
    const res = await fetch(`${prodUrl}/%E0%A4%A`);
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain("Bad Request");
  });

  it("returns 400 for bare percent sign in path (not crash)", async () => {
    const res = await fetch(`${prodUrl}/%`);
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain("Bad Request");
  });
});

describe("Production server next.config.js features (Pages Router)", () => {
  const outDir = path.resolve(FIXTURE_DIR, "dist");
  let prodServer: import("node:http").Server;
  let prodUrl: string;

  beforeAll(async () => {
    const serverEntryPath = path.join(outDir, "server", "entry.js");
    const manifestPath = path.join(outDir, "client", ".vite", "ssr-manifest.json");

    // Build if needed (tests may run in isolation)
    if (!fs.existsSync(serverEntryPath) || !fs.existsSync(manifestPath)) {
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
          manifest: true,
          ssrManifest: true,
          rollupOptions: { input: "virtual:vinext-client-entry" },
        },
      });
    }

    const { startProdServer } = await import(
      "../packages/vinext/src/server/prod-server.js"
    );
    prodServer = await startProdServer({
      port: 0,
      host: "127.0.0.1",
      outDir,
    });
    const addr = prodServer.address() as { port: number };
    prodUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    if (prodServer) {
      await new Promise<void>((resolve) => prodServer.close(() => resolve()));
    }
  });

  it("server entry exports vinextConfig with correct shape", async () => {
    const serverEntryPath = path.join(outDir, "server", "entry.js");
    const serverEntry = await import(pathToFileURL(serverEntryPath).href);
    expect(serverEntry.vinextConfig).toBeDefined();
    expect(serverEntry.vinextConfig.redirects).toBeInstanceOf(Array);
    expect(serverEntry.vinextConfig.rewrites).toBeDefined();
    expect(serverEntry.vinextConfig.headers).toBeInstanceOf(Array);
    expect(typeof serverEntry.vinextConfig.basePath).toBe("string");
    expect(typeof serverEntry.vinextConfig.trailingSlash).toBe("boolean");
  });

  it("applies redirects from next.config.js (/old-about -> /about)", async () => {
    const res = await fetch(`${prodUrl}/old-about`, { redirect: "manual" });
    expect(res.status).toBe(308); // permanent redirect
    expect(res.headers.get("location")).toContain("/about");
  });

  it("applies beforeFiles rewrites from next.config.js (/before-rewrite -> /about)", async () => {
    const res = await fetch(`${prodUrl}/before-rewrite`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("About");
  });

  it("applies afterFiles rewrites from next.config.js (/after-rewrite -> /about)", async () => {
    const res = await fetch(`${prodUrl}/after-rewrite`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("About");
  });

  it("applies custom headers from next.config.js on /api routes", async () => {
    const res = await fetch(`${prodUrl}/api/hello`);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-custom-header")).toBe("vinext");
  });

  it("serves normal pages unaffected by config rules", async () => {
    const res = await fetch(`${prodUrl}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Hello, vinext!");
  });

  // ── Percent-encoded paths should be decoded before config matching ──
  // Config matchers must receive decoded paths so that encoded variants
  // like /%6Fld-%61bout still match the /old-about redirect rule.

  it("percent-encoded redirect path is decoded before config matching (prod)", async () => {
    // /old-about → /about (permanent redirect). /%6Fld-%61bout decodes to /old-about.
    const res = await fetch(`${prodUrl}/%6Fld-%61bout`, { redirect: "manual" });
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toContain("/about");
  });

  it("percent-encoded header path is decoded before config matching (prod)", async () => {
    // /api/(.*) should receive X-Custom-Header: vinext.
    // /%61pi/hello decodes to /api/hello.
    const res = await fetch(`${prodUrl}/%61pi/hello`);
    expect(res.headers.get("x-custom-header")).toBe("vinext");
  });

  it("percent-encoded rewrite path is decoded before config matching (prod)", async () => {
    // /before-rewrite → /about (beforeFiles rewrite).
    // /%62efore-rewrite decodes to /before-rewrite.
    const res = await fetch(`${prodUrl}/%62efore-rewrite`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("About");
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

  it("escapes meta refresh URL to prevent HTML injection", async () => {
    expect(fs.existsSync(path.join(exportDir, "redirect-xss.html"))).toBe(true);
    const html = fs.readFileSync(
      path.join(exportDir, "redirect-xss.html"),
      "utf-8",
    );
    expect(html).toContain('content="0;url=foo&quot; /&gt;&lt;script&gt;alert(1)&lt;/script&gt;&lt;meta x=&quot;"');
    expect(html).not.toContain('<script>alert(1)</script>');
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
