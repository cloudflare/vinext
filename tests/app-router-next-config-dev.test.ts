import { type ViteDevServer } from "vite";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { APP_FIXTURE_DIR, fetchHtml, startFixtureServer } from "./helpers.js";

describe("App Router next.config.js features (dev server integration)", () => {
  let server: ViteDevServer;
  let baseUrl: string;

  beforeAll(async () => {
    // Uses the permanent next.config.ts in the app-basic fixture.
    // That config includes redirects, rewrites, and headers needed by
    // both these Vitest tests and the Playwright E2E tests.
    ({ server, baseUrl } = await startFixtureServer(APP_FIXTURE_DIR, { appRouter: true }));
  }, 30000);

  afterAll(async () => {
    await server?.close();
  });

  it("applies redirects from next.config.js (permanent)", async () => {
    const res = await fetch(`${baseUrl}/old-about`, { redirect: "manual" });
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toContain("/about");
  });

  it("applies redirects with dynamic params", async () => {
    const res = await fetch(`${baseUrl}/old-blog/hello`, { redirect: "manual" });
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/blog/hello");
  });

  it("applies redirects with repeated dynamic params in the destination", async () => {
    const res = await fetch(`${baseUrl}/repeat-redirect/hello`, { redirect: "manual" });
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/blog/hello/hello");
  });

  it("applies beforeFiles rewrites from next.config.js", async () => {
    const res = await fetch(`${baseUrl}/rewrite-about`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("About");
  });

  it("applies rewrites with repeated dynamic params in the destination", async () => {
    const res = await fetch(`${baseUrl}/repeat-rewrite/hello`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("hello/hello");
    expect(html).toMatch(/Segments:.*2/);
  });

  it("applies afterFiles rewrites from next.config.js", async () => {
    const res = await fetch(`${baseUrl}/after-rewrite-about`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("About");
  });

  // In App Router execution order, beforeFiles rewrites run after middleware.
  // has/missing conditions on beforeFiles rules should therefore evaluate against
  // middleware-modified headers/cookies, not the original pre-middleware request.
  it("beforeFiles rewrite has/missing conditions see middleware-injected cookies", async () => {
    // Without ?mw-auth, middleware does NOT inject mw-before-user=1.
    // The has:[cookie:mw-before-user] beforeFiles rule should NOT match → no rewrite.
    const noAuthRes = await fetch(`${baseUrl}/mw-gated-before`);
    expect(noAuthRes.status).toBe(404);

    // With ?mw-auth, middleware injects mw-before-user=1 into request cookies.
    // The has:[cookie:mw-before-user] beforeFiles rule SHOULD match → rewrite to /about.
    const authRes = await fetch(`${baseUrl}/mw-gated-before?mw-auth`);
    expect(authRes.status).toBe(200);
    const html = await authRes.text();
    expect(html).toContain("About");
  });

  // Fallback rewrites run after middleware and after a 404 from route matching.
  // has/missing conditions on fallback rules should evaluate against
  // middleware-modified headers/cookies, not the original pre-middleware request.
  it("fallback rewrite has/missing conditions see middleware-injected cookies", async () => {
    // Without ?mw-auth, middleware does NOT inject mw-fallback-user=1.
    // The has:[cookie:mw-fallback-user] fallback rule should NOT match → 404.
    const noAuthRes = await fetch(`${baseUrl}/mw-gated-fallback`);
    expect(noAuthRes.status).toBe(404);

    // With ?mw-auth, middleware injects mw-fallback-user=1 into request cookies.
    // The has:[cookie:mw-fallback-user] fallback rule SHOULD match → rewrite to /about.
    const authRes = await fetch(`${baseUrl}/mw-gated-fallback?mw-auth`);
    expect(authRes.status).toBe(200);
    const html = await authRes.text();
    expect(html).toContain("About");
  });

  it("fallback rewrites targeting Pages routes still work in mixed app/pages projects", async () => {
    const noAuthRes = await fetch(`${baseUrl}/mw-gated-fallback-pages`);
    expect(noAuthRes.status).toBe(404);

    const { res, html } = await fetchHtml(`${baseUrl}`, "/mw-gated-fallback-pages?mw-auth", {
      headers: {
        authorization: "Bearer secret",
        cookie: "a=1; b=2",
      },
    });

    expect(res.status).toBe(200);
    expect(html).toContain("Pages Header Override Delete");
    expect(html).toContain('"page":"/pages-header-override-delete"');
  });

  it("applies custom headers from next.config.js on API routes", async () => {
    const res = await fetch(`${baseUrl}/api/hello`);
    expect(res.headers.get("x-custom-header")).toBe("vinext-app");
  });

  it("applies custom headers from next.config.js on page routes", async () => {
    const res = await fetch(`${baseUrl}/about`);
    expect(res.headers.get("x-page-header")).toBe("about-page");
  });

  it("does not redirect for non-matching paths", async () => {
    const res = await fetch(`${baseUrl}/about`);
    expect(res.status).toBe(200);
    expect(res.redirected).toBe(false);
  });

  // ── Percent-encoded paths should be decoded before config matching ──

  it("percent-encoded redirect path is decoded before config matching", async () => {
    // /%6Fld-%61bout decodes to /old-about → /about (permanent redirect)
    const res = await fetch(`${baseUrl}/%6Fld-%61bout`, { redirect: "manual" });
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toContain("/about");
  });

  it("percent-encoded header path is decoded before config matching", async () => {
    // /%61bout decodes to /about → X-Page-Header: about-page
    const res = await fetch(`${baseUrl}/%61bout`);
    expect(res.headers.get("x-page-header")).toBe("about-page");
  });

  it("encoded slashes stay within a single segment for config header matching", async () => {
    const res = await fetch(`${baseUrl}/api%2Fhello`);
    expect(res.headers.get("x-custom-header")).toBeNull();
  });

  it("percent-encoded rewrite path is decoded before config matching", async () => {
    // /rewrite-%61bout decodes to /rewrite-about → /about (beforeFiles rewrite)
    const res = await fetch(`${baseUrl}/rewrite-%61bout`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("About");
  });
});
