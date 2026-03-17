/**
 * Next.js Compatibility Tests: app-catch-all-optional
 *
 * Ported from: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/app-catch-all-optional/app-catch-all-optional.test.ts
 *
 * Tests optional catch-all route matching: [lang]/[flags]/[[...rest]]
 * - With rest params: /en/flags/the/rest → rest = ["the", "rest"]
 * - Without rest params: /en/flags → rest = undefined/[]
 */

import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";
import type { ViteDevServer } from "vite-plus";
import { APP_FIXTURE_DIR, startFixtureServer, fetchHtml } from "../helpers.js";

describe("Next.js compat: app-catch-all-optional", () => {
  let server: ViteDevServer;
  let baseUrl: string;

  beforeAll(async () => {
    ({ server, baseUrl } = await startFixtureServer(APP_FIXTURE_DIR, {
      appRouter: true,
    }));
    await fetchHtml(baseUrl, "/nextjs-compat/catch-all-optional/en/flags");
  }, 60_000);

  afterAll(async () => {
    await server?.close();
  });

  // Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/app-catch-all-optional/app-catch-all-optional.test.ts
  // "should handle optional catchall"
  it("should handle optional catchall with rest params", async () => {
    const { html, res } = await fetchHtml(
      baseUrl,
      "/nextjs-compat/catch-all-optional/en/flags/the/rest",
    );
    expect(res.status).toBe(200);
    expect(html).toContain('data-lang="en"');
    expect(html).toContain('data-flags="flags"');
    expect(html).toContain('data-rest="the/rest"');
  });

  // Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/app-catch-all-optional/app-catch-all-optional.test.ts
  // "should handle optional catchall with no params"
  it("should handle optional catchall with no rest params", async () => {
    const { html, res } = await fetchHtml(baseUrl, "/nextjs-compat/catch-all-optional/en/flags");
    expect(res.status).toBe(200);
    expect(html).toContain('data-lang="en"');
    expect(html).toContain('data-flags="flags"');
    expect(html).toContain('data-rest=""');
  });

  // Additional edge case: single rest param
  it("should handle optional catchall with single rest param", async () => {
    const { html, res } = await fetchHtml(
      baseUrl,
      "/nextjs-compat/catch-all-optional/fr/banner/home",
    );
    expect(res.status).toBe(200);
    expect(html).toContain('data-lang="fr"');
    expect(html).toContain('data-flags="banner"');
    expect(html).toContain('data-rest="home"');
  });
});
