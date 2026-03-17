/**
 * Next.js Compatibility Tests: not-found-default
 *
 * Ported from: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/not-found-default/index.test.ts
 *
 * HTTP-testable subset only:
 * - non-existent routes render the default 404 inside the root layout
 * - /_not-found returns HTTP 404
 * - grouped routes without their own not-found.tsx fall back to the default 404
 */

import path from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";
import type { ViteDevServer } from "vite-plus";
import { fetchDom, fetchHtml, startFixtureServer } from "../helpers.js";

const FIXTURE_DIR = path.resolve(import.meta.dirname, "../fixtures/app-not-found-default");

describe("Next.js compat: not-found-default", () => {
  let server: ViteDevServer;
  let baseUrl: string;

  beforeAll(async () => {
    ({ server, baseUrl } = await startFixtureServer(FIXTURE_DIR, {
      appRouter: true,
    }));
    await fetch(`${baseUrl}/`);
  }, 60_000);

  afterAll(async () => {
    await server?.close();
  });

  // Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/not-found-default/index.test.ts
  it("should render default 404 with root layout for non-existent page", async () => {
    const { res, $ } = await fetchDom(baseUrl, "/non-existent");

    expect(res.status).toBe(404);
    expect($("html").attr("class")).toBe("root-layout-html");
    expect($("h1").text()).toContain("404");
    expect($.text()).toContain("This page could not be found.");
  });

  it("should return 404 status code for default not-found page", async () => {
    const { res } = await fetchHtml(baseUrl, "/_not-found");
    expect(res.status).toBe(404);
  });

  it("should render default not found for group routes if not found is not defined", async () => {
    const ok = await fetchDom(baseUrl, "/group-dynamic/123");
    expect(ok.res.status).toBe(200);
    expect(ok.$("#page").text()).toBe("group-dynamic [id]");

    const missing = await fetchDom(baseUrl, "/group-dynamic/404");
    expect(missing.res.status).toBe(404);
    expect(missing.$(".group-root-layout").length).toBe(1);
    expect(missing.$("h1").text()).toContain("404");
    expect(missing.$.text()).toContain("This page could not be found.");
  });
});
