/**
 * Next.js Compatibility Tests: forbidden
 *
 * Ported from: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/forbidden/basic/forbidden-basic.test.ts
 *
 * Tests forbidden() boundary behavior at the HTTP/SSR level:
 * - forbidden() in a dynamic route triggers the scoped forbidden.tsx boundary
 * - Normal dynamic route params render correctly
 * - When no local forbidden boundary exists, escalates to root forbidden
 * - Response status is 403 for forbidden pages
 */

import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";
import type { ViteDevServer } from "vite-plus";
import { APP_FIXTURE_DIR, startFixtureServer, fetchHtml } from "../helpers.js";

describe("Next.js compat: forbidden", () => {
  let server: ViteDevServer;
  let baseUrl: string;

  beforeAll(async () => {
    ({ server, baseUrl } = await startFixtureServer(APP_FIXTURE_DIR, {
      appRouter: true,
    }));
    await fetchHtml(baseUrl, "/nextjs-compat/forbidden-basic");
  }, 60_000);

  afterAll(async () => {
    await server?.close();
  });

  // ── Dynamic route with scoped forbidden boundary ──────────

  // Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/forbidden/basic/forbidden-basic.test.ts
  // "should match dynamic route forbidden boundary correctly" — /dynamic renders normally
  it("dynamic route index renders correctly", async () => {
    const { html, res } = await fetchHtml(baseUrl, "/nextjs-compat/forbidden-basic/dynamic");
    expect(res.status).toBe(200);
    expect(html).toContain("dynamic");
  });

  // "should match dynamic route forbidden boundary correctly" — /dynamic/123 renders page
  it("dynamic route with valid id renders page", async () => {
    const { html, res } = await fetchHtml(baseUrl, "/nextjs-compat/forbidden-basic/dynamic/123");
    expect(res.status).toBe(200);
    expect(html).toContain("dynamic [id]");
  });

  // "should match dynamic route forbidden boundary correctly" — /dynamic/403 triggers scoped boundary
  it("forbidden() triggers scoped forbidden boundary", async () => {
    const { html, res } = await fetchHtml(baseUrl, "/nextjs-compat/forbidden-basic/dynamic/403");
    expect(res.status).toBe(403);
    expect(html).toContain("dynamic/[id] forbidden");
  });

  // ── Escalation to root forbidden boundary ──────────────────

  // Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/forbidden/basic/forbidden-basic.test.ts
  // "should escalate forbidden to parent layout if no forbidden boundary present in current layer"
  it("escalates to root forbidden when no local boundary exists", async () => {
    const { html, res } = await fetchHtml(
      baseUrl,
      "/nextjs-compat/forbidden-basic/dynamic-no-boundary/403",
    );
    expect(res.status).toBe(403);
    expect(html).toContain("Root Forbidden");
  });

  // Normal page in dynamic-no-boundary layout renders correctly
  it("dynamic route without forbidden boundary renders normally for valid id", async () => {
    const { html, res } = await fetchHtml(
      baseUrl,
      "/nextjs-compat/forbidden-basic/dynamic-no-boundary/200",
    );
    expect(res.status).toBe(200);
    expect(html).toContain("dynamic-no-boundary [id]");
  });
});
