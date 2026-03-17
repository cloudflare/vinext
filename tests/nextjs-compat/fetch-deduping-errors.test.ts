/**
 * Next.js Compatibility Tests: app-fetch-deduping-errors
 *
 * Ported from: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/app-fetch-deduping-errors/app-fetch-deduping-errors.test.ts
 *
 * Tests that the page still renders successfully when a fetch request
 * with cache options errors (e.g. connection refused). The fetch error
 * is caught in a try/catch — the page should not crash.
 *
 * Original test uses Playwright (browser.elementByCss), but the core
 * behavior is testable at the HTTP/SSR level.
 */

import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";
import type { ViteDevServer } from "vite-plus";
import { APP_FIXTURE_DIR, startFixtureServer, fetchHtml } from "../helpers.js";

describe("Next.js compat: app-fetch-deduping-errors", () => {
  let server: ViteDevServer;
  let baseUrl: string;

  beforeAll(async () => {
    ({ server, baseUrl } = await startFixtureServer(APP_FIXTURE_DIR, {
      appRouter: true,
    }));
    await fetchHtml(baseUrl, "/nextjs-compat/fetch-deduping-errors/1");
  }, 60_000);

  afterAll(async () => {
    await server?.close();
  });

  // Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/app-fetch-deduping-errors/app-fetch-deduping-errors.test.ts
  // "should still successfully render when a fetch request that acquires a cache lock errors"
  it("should render page despite fetch error with cache options", async () => {
    const { html, res } = await fetchHtml(baseUrl, "/nextjs-compat/fetch-deduping-errors/1");
    expect(res.status).toBe(200);
    // React SSR may insert comment nodes between text and dynamic values
    expect(html).toContain("Hello World");
    expect(html).toContain("1");
  });

  it("should render with different dynamic params despite fetch error", async () => {
    const { html, res } = await fetchHtml(baseUrl, "/nextjs-compat/fetch-deduping-errors/42");
    expect(res.status).toBe(200);
    expect(html).toContain("Hello World");
    expect(html).toContain("42");
  });

  it("should generate metadata despite fetch error in generateMetadata", async () => {
    const { html } = await fetchHtml(baseUrl, "/nextjs-compat/fetch-deduping-errors/1");
    // Metadata should still be generated even though fetch failed
    expect(html).toContain("<title>");
    expect(html).toContain("Page 1");
  });
});
