/**
 * Next.js compat: metadata-suspense
 *
 * Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/metadata-suspense/index.test.ts
 *
 * Tests that metadata renders correctly in <head> when the root layout
 * wraps children in <Suspense>.
 */
import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";
import {
  startFixtureServer,
  APP_FIXTURE_DIR,
  fetchHtml,
  type TestServerResult,
} from "../helpers.js";

let ctx: TestServerResult;

describe("Next.js compat: metadata-suspense", () => {
  beforeAll(async () => {
    ctx = await startFixtureServer(APP_FIXTURE_DIR, { appRouter: true });
  });

  afterAll(async () => {
    await ctx.server.close();
  });

  it("should render metadata in head when layout is wrapped with Suspense", async () => {
    const { html } = await fetchHtml(ctx.baseUrl, "/nextjs-compat/metadata-suspense-test");

    // Title should be present
    expect(html).toContain("<title>Suspense Metadata Title</title>");

    // Application name meta tag
    expect(html).toMatch(/<meta\s+name="application-name"\s+content="suspense-app"/);

    // Description meta tag
    expect(html).toMatch(
      /<meta\s+name="description"\s+content="Testing metadata in suspense layout"/,
    );
  });

  // Regression test: the shared app-basic root layout used to hardcode
  // <title>App Basic</title>, which made metadata routes appear to emit
  // duplicate titles. Keep this assertion live so metadata fixtures rely on
  // the Metadata API rather than manual <head> tags.
  it("should not produce duplicate title tags with Suspense layout", async () => {
    const { html } = await fetchHtml(ctx.baseUrl, "/nextjs-compat/metadata-suspense-test");
    const titleMatches = html.match(/<title>/g);
    expect(titleMatches).toHaveLength(1);
  });

  it("should render page content inside Suspense boundary", async () => {
    const { html } = await fetchHtml(ctx.baseUrl, "/nextjs-compat/metadata-suspense-test");

    // Page content should be rendered (not loading fallback)
    expect(html).toContain("Suspense Metadata Page");
  });
});
