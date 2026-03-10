/**
 * Next.js compat: app-prefetch (HTTP-testable parts)
 *
 * Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/app-prefetch/prefetching.test.ts
 *
 * Tests RSC prefetch endpoint behavior. Most prefetch tests are browser-only;
 * these test the server-side RSC response behavior.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  startFixtureServer,
  APP_FIXTURE_DIR,
  fetchHtml,
  type TestServerResult,
} from "../helpers.js";

let ctx: TestServerResult;

describe("Next.js compat: prefetch", () => {
  beforeAll(async () => {
    ctx = await startFixtureServer(APP_FIXTURE_DIR, { appRouter: true });
  });

  afterAll(async () => {
    await ctx.server.close();
  });

  it("should serve RSC payload at .rsc endpoint", async () => {
    const res = await fetch(`${ctx.baseUrl}/nextjs-compat/prefetch-test/target.rsc`, {
      headers: { Accept: "text/x-component" },
    });
    expect(res.status).toBe(200);
    const contentType = res.headers.get("content-type");
    expect(contentType).toContain("text/x-component");
  });

  it("should render prefetch page with links", async () => {
    const { html } = await fetchHtml(ctx.baseUrl, "/nextjs-compat/prefetch-test");
    expect(html).toContain("Prefetch Test Home");
    expect(html).toContain('id="prefetch-link"');
    expect(html).toContain('id="no-prefetch-link"');
  });

  it("should navigate to target page (prefetch=true)", async () => {
    const { html } = await fetchHtml(ctx.baseUrl, "/nextjs-compat/prefetch-test/target");
    expect(html).toContain("Prefetch Target Page");
  });

  it("should navigate to target page (prefetch=false)", async () => {
    const { html } = await fetchHtml(ctx.baseUrl, "/nextjs-compat/prefetch-test/no-prefetch");
    expect(html).toContain("No Prefetch Target Page");
  });
});
