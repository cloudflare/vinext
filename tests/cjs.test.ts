import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { ViteDevServer } from "vite";
import { APP_FIXTURE_DIR, PAGES_FIXTURE_DIR, startFixtureServer, fetchHtml } from "./helpers.js";

describe("CJS interop (App Router)", () => {
  let server: ViteDevServer;
  let baseUrl: string;

  beforeAll(async () => {
    ({ server, baseUrl } = await startFixtureServer(APP_FIXTURE_DIR, { appRouter: true }));
  }, 30000);

  afterAll(async () => {
    await server?.close();
  });

  it("renders page that uses CJS require() and module.exports", async () => {
    const { res, html } = await fetchHtml(baseUrl, "/cjs/basic");
    expect(res.status).toBe(200);
    expect(html).toContain("cjs-basic");
    // React SSR may insert comment nodes between text and expressions
    // (e.g. "Random: <!-- -->4"), so use a regex.
    expect(html).toMatch(/Random:.*4/);
  });

  it("renders page that uses CJS require('server-only')", async () => {
    const { res, html } = await fetchHtml(baseUrl, "/cjs/server-only");
    expect(res.status).toBe(200);
    expect(html).toContain("cjs-server-only");
    expect(html).toContain("This page uses CJS require");
  });
});

describe("CJS interop (Pages Router)", () => {
  let server: ViteDevServer;
  let baseUrl: string;

  beforeAll(async () => {
    ({ server, baseUrl } = await startFixtureServer(PAGES_FIXTURE_DIR));
  }, 30000);

  afterAll(async () => {
    await server?.close();
  });

  it("renders page that uses CJS require() and module.exports", async () => {
    const { res, html } = await fetchHtml(baseUrl, "/cjs/basic");
    expect(res.status).toBe(200);
    expect(html).toContain("cjs-basic");
    // Pages Router SSR inserts React comment nodes between text and
    // expressions (e.g. "Random: <!-- -->4"), so use a regex.
    expect(html).toMatch(/Random:.*4/);
  });
});
