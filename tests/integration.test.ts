import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type ViteDevServer } from "vite";
import path from "node:path";
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
