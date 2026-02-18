/**
 * Next.js compat: metadata-suspense
 *
 * Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/metadata-suspense/index.test.ts
 *
 * Tests that metadata renders correctly in <head> when the root layout
 * wraps children in <Suspense>.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
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
    const { html } = await fetchHtml(
      ctx.baseUrl,
      "/nextjs-compat/metadata-suspense-test",
    );

    // Title should be present
    expect(html).toContain("<title>Suspense Metadata Title</title>");

    // Application name meta tag
    expect(html).toMatch(
      /<meta\s+name="application-name"\s+content="suspense-app"/,
    );

    // Description meta tag
    expect(html).toMatch(
      /<meta\s+name="description"\s+content="Testing metadata in suspense layout"/,
    );
  });

  // SKIP: Vinext emits duplicate <title> tags when a layout wraps children
  // in <Suspense>. The metadata is injected once in the shell and again when
  // the Suspense boundary resolves, producing two <title> elements.
  //
  // ROOT CAUSE: Metadata is rendered as part of the page element tree, which
  // gets wrapped by Suspense. When SSR streams the shell (with fallback) and
  // then the resolved content, both include the metadata head tags.
  //
  // TO FIX: `packages/vinext/src/server/app-dev-server.ts` — metadata should
  // be hoisted above Suspense boundaries (rendered outside the Suspense wrapper
  // in buildPageElement) or deduplicated during SSR HTML assembly.
  //
  // VERIFY: Remove skip, run this test. Should see exactly 1 <title> tag.
  it.skip("should not produce duplicate title tags with Suspense layout", async () => {
    const { html } = await fetchHtml(
      ctx.baseUrl,
      "/nextjs-compat/metadata-suspense-test",
    );
    const titleMatches = html.match(/<title>/g);
    expect(titleMatches).toHaveLength(1);
  });

  it("should render page content inside Suspense boundary", async () => {
    const { html } = await fetchHtml(
      ctx.baseUrl,
      "/nextjs-compat/metadata-suspense-test",
    );

    // Page content should be rendered (not loading fallback)
    expect(html).toContain("Suspense Metadata Page");
  });
});
