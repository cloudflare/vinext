/**
 * Next.js Compatibility Tests: static-generation-status
 *
 * Ported from: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/static-generation-status/index.test.ts
 *
 * Tests HTTP status codes from notFound(), redirect(), and permanentRedirect():
 * - notFound() → 404
 * - redirect() → 307
 * - redirect() from client component (SSR) → 307
 * - permanentRedirect() → 308
 * - Non-existent route → 404
 */

import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";
import type { ViteDevServer } from "vite-plus";
import { APP_FIXTURE_DIR, startFixtureServer } from "../helpers.js";

describe("Next.js compat: static-generation-status", () => {
  let server: ViteDevServer;
  let baseUrl: string;

  beforeAll(async () => {
    ({ server, baseUrl } = await startFixtureServer(APP_FIXTURE_DIR, {
      appRouter: true,
    }));
    // Warm up
    await fetch(`${baseUrl}/`);
  }, 60_000);

  afterAll(async () => {
    await server?.close();
  });

  // Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/static-generation-status/index.test.ts
  it("should render the page using notFound with status 404", async () => {
    const res = await fetch(`${baseUrl}/nextjs-compat/status-not-found`);
    expect(res.status).toBe(404);
  });

  it("should render the page using redirect with status 307", async () => {
    const res = await fetch(`${baseUrl}/nextjs-compat/status-redirect`, { redirect: "manual" });
    expect(res.status).toBe(307);
  });

  it("should render the client page using redirect with status 307", async () => {
    const res = await fetch(`${baseUrl}/nextjs-compat/status-redirect-client`, {
      redirect: "manual",
    });
    expect(res.status).toBe(307);
  });

  it("should respond with 308 status code if permanent flag is set", async () => {
    const res = await fetch(`${baseUrl}/nextjs-compat/status-redirect-permanent`, {
      redirect: "manual",
    });
    expect(res.status).toBe(308);
  });

  it("should render the non existed route redirect with status 404", async () => {
    const res = await fetch(`${baseUrl}/does-not-exist-at-all`);
    expect(res.status).toBe(404);
  });
});
