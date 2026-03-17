/**
 * Next.js Compatibility Tests: unauthorized
 *
 * Ported from: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/unauthorized/basic/unauthorized-basic.test.ts
 *
 * Tests unauthorized() boundary behavior at the HTTP/SSR level:
 * - unauthorized() in a dynamic route triggers the scoped unauthorized.tsx boundary
 * - Normal dynamic route params render correctly
 * - When no local unauthorized boundary exists, escalates to root unauthorized
 * - Response status is 401 for unauthorized pages
 */

import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";
import type { ViteDevServer } from "vite-plus";
import { APP_FIXTURE_DIR, startFixtureServer, fetchHtml } from "../helpers.js";

describe("Next.js compat: unauthorized", () => {
  let server: ViteDevServer;
  let baseUrl: string;

  beforeAll(async () => {
    ({ server, baseUrl } = await startFixtureServer(APP_FIXTURE_DIR, {
      appRouter: true,
    }));
    await fetchHtml(baseUrl, "/nextjs-compat/unauthorized-basic");
  }, 60_000);

  afterAll(async () => {
    await server?.close();
  });

  // ── Dynamic route with scoped unauthorized boundary ──────────

  // Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/unauthorized/basic/unauthorized-basic.test.ts
  it("dynamic route index renders correctly", async () => {
    const { html, res } = await fetchHtml(baseUrl, "/nextjs-compat/unauthorized-basic/dynamic");
    expect(res.status).toBe(200);
    expect(html).toContain("dynamic");
  });

  it("dynamic route with valid id renders page", async () => {
    const { html, res } = await fetchHtml(baseUrl, "/nextjs-compat/unauthorized-basic/dynamic/123");
    expect(res.status).toBe(200);
    expect(html).toContain("dynamic [id]");
  });

  it("unauthorized() triggers scoped unauthorized boundary", async () => {
    const { html, res } = await fetchHtml(baseUrl, "/nextjs-compat/unauthorized-basic/dynamic/401");
    expect(res.status).toBe(401);
    expect(html).toContain("dynamic/[id] unauthorized");
  });

  // ── Escalation to root unauthorized boundary ──────────────────

  it("escalates to root unauthorized when no local boundary exists", async () => {
    const { html, res } = await fetchHtml(
      baseUrl,
      "/nextjs-compat/unauthorized-basic/dynamic-no-boundary/401",
    );
    expect(res.status).toBe(401);
    expect(html).toContain("Root Unauthorized");
  });

  it("dynamic route without unauthorized boundary renders normally for valid id", async () => {
    const { html, res } = await fetchHtml(
      baseUrl,
      "/nextjs-compat/unauthorized-basic/dynamic-no-boundary/200",
    );
    expect(res.status).toBe(200);
    expect(html).toContain("dynamic-no-boundary [id]");
  });
});
