/**
 * Test: JSX in plain .js files
 *
 * Next.js allows JSX syntax in .js files (Babel/SWC handle it transparently).
 * Vite 8's OXC transform defaults exclude .js files (include: /\.(m?ts|[jt]sx)$/,
 * exclude: /\.js$/). vinext overrides these defaults to match Next.js behavior.
 *
 * Without the fix, .js files containing JSX would fail with:
 *   "Unexpected JSX expression" (OXC parse error)
 */

import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";
import type { ViteDevServer } from "vite-plus";
import { APP_FIXTURE_DIR, startFixtureServer, fetchHtml } from "./helpers.js";

describe("JSX in plain .js files", () => {
  let server: ViteDevServer;
  let baseUrl: string;

  beforeAll(async () => {
    ({ server, baseUrl } = await startFixtureServer(APP_FIXTURE_DIR, {
      appRouter: true,
    }));
    // Warm up
    await fetch(`${baseUrl}/`).catch(() => {});
  }, 60_000);

  afterAll(async () => {
    await server?.close();
  });

  it("should render a page component defined in a .js file with JSX", async () => {
    const { res, html } = await fetchHtml(baseUrl, "/nextjs-compat/jsx-in-js");
    expect(res.status).toBe(200);
    expect(html).toContain("Hello JSX in JS");
    expect(html).toContain("jsx-in-js");
  });

  it("should not produce 'Unexpected JSX expression' errors for .js files", async () => {
    const { res, html } = await fetchHtml(baseUrl, "/nextjs-compat/jsx-in-js");
    // If OXC fails to parse JSX in .js, the response would contain an error message
    expect(html).not.toContain("Unexpected");
    expect(html).not.toContain("PARSE_ERROR");
    expect(res.status).toBe(200);
  });
});
