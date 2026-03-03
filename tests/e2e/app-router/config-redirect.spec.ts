/**
 * OpenNext Compat: next.config.js redirects, rewrites, and custom headers.
 *
 * Ported from:
 *   https://github.com/opennextjs/opennextjs-cloudflare/blob/main/examples/e2e/app-router/e2e/config.redirect.test.ts
 *   https://github.com/opennextjs/opennextjs-cloudflare/blob/main/examples/e2e/app-router/e2e/headers.test.ts
 * Tests: ON-12, ON-15 in TRACKING.md
 */
import { test, expect } from "@playwright/test";

const BASE = "http://localhost:4174";

test.describe("Config Redirects (OpenNext compat)", () => {
  // Ref: opennextjs-cloudflare config.redirect.test.ts — simple redirect
  test("simple redirect from config source to destination", async ({
    page,
  }) => {
    await page.goto(`${BASE}/config-redirect-source`);
    await page.waitForURL(/\/about$/);

    const el = page.getByText("About", { exact: true });
    await expect(el).toBeVisible();
  });

  // Ref: opennextjs-cloudflare config.redirect.test.ts — permanent redirect status
  test("permanent redirect returns 308", async ({ request }) => {
    const res = await request.get(`${BASE}/config-redirect-source`, {
      maxRedirects: 0,
    });
    expect(res.status()).toBe(308);
    expect(res.headers()["location"]).toMatch(/\/about$/);
  });

  // Ref: opennextjs-cloudflare config.redirect.test.ts — temporary redirect
  test("non-permanent redirect returns 307", async ({ request }) => {
    const res = await request.get(`${BASE}/config-redirect-query`, {
      maxRedirects: 0,
    });
    expect(res.status()).toBe(307);
    expect(res.headers()["location"]).toContain("/about?from=config");
  });

  // Ref: opennextjs-cloudflare config.redirect.test.ts — parameterized redirect
  test("parameterized redirect preserves slug", async ({ request }) => {
    const res = await request.get(`${BASE}/old-blog/hello-world`, {
      maxRedirects: 0,
    });
    // permanent: false → 307
    expect(res.status()).toBe(307);
    expect(res.headers()["location"]).toMatch(/\/blog\/hello-world$/);
  });

  // Ref: opennextjs-cloudflare config.redirect.test.ts — cookie conditions
  test("redirect with has cookie condition only fires when cookie present", async ({ request }) => {
    // Without the cookie — should NOT redirect (200 or 404, not 3xx)
    const noRedirect = await request.get(`${BASE}/has-cookie-redirect`, {
      maxRedirects: 0,
    });
    // Should NOT be a redirect (no cookie present)
    expect(noRedirect.status()).not.toBe(307);
    expect(noRedirect.status()).not.toBe(308);

    // With the cookie — should redirect
    const withRedirect = await request.get(`${BASE}/has-cookie-redirect`, {
      maxRedirects: 0,
      headers: { Cookie: "redirect-me=1" },
    });
    expect(withRedirect.status()).toBe(307);
    expect(withRedirect.headers()["location"]).toMatch(/\/about$/);
  });

  test("redirect with missing cookie condition only fires when cookie absent", async ({ request }) => {
    // Without the cookie — should redirect (cookie is missing → condition met)
    const shouldRedirect = await request.get(`${BASE}/missing-cookie-redirect`, {
      maxRedirects: 0,
    });
    expect(shouldRedirect.status()).toBe(307);
    expect(shouldRedirect.headers()["location"]).toMatch(/\/about$/);

    // With the cookie — should NOT redirect (cookie is present → missing condition fails)
    const noRedirect = await request.get(`${BASE}/missing-cookie-redirect`, {
      maxRedirects: 0,
      headers: { Cookie: "stay-here=1" },
    });
    expect(noRedirect.status()).not.toBe(307);
    expect(noRedirect.status()).not.toBe(308);
  });
});

test.describe("Config Rewrites (OpenNext compat)", () => {
  // Config rewrite: /config-rewrite → / (URL stays, content from /)
  test("config rewrite serves / content at /config-rewrite URL", async ({
    page,
  }) => {
    await page.goto(`${BASE}/config-rewrite`);

    // URL should stay as /config-rewrite
    expect(page.url()).toMatch(/\/config-rewrite$/);

    // Content should be from / (home page)
    const el = page.getByText("Welcome to App Router", { exact: true });
    await expect(el).toBeVisible();
  });
});

test.describe("Config Custom Headers (OpenNext compat)", () => {
  // Ref: opennextjs-cloudflare headers.test.ts — "Headers"
  test("custom header from next.config headers() is present on pages", async ({
    request,
  }) => {
    const res = await request.get(`${BASE}/about`);
    expect(res.status()).toBe(200);
    // The /(.*) catch-all header applies to all routes
    expect(res.headers()["x-e2e-header"]).toBe("vinext-e2e");
    // The /about-specific header also applies
    expect(res.headers()["x-page-header"]).toBe("about-page");
  });

  test("custom header applied to API routes", async ({ request }) => {
    const res = await request.get(`${BASE}/api/hello`);
    expect(res.status()).toBe(200);
    // The /api/(.*) header
    expect(res.headers()["x-custom-header"]).toBe("vinext-app");
    // The /(.*) catch-all header
    expect(res.headers()["x-e2e-header"]).toBe("vinext-e2e");
  });

  // Ref: opennextjs-cloudflare headers.test.ts — "x-powered-by should be absent"
  // vinext never sends X-Powered-By (matching Next.js poweredByHeader: false behavior).
  // Tests: ON-6 #7, ON-8 #3 in TRACKING.md
  test("x-powered-by header is absent from responses", async ({ request }) => {
    const pageRes = await request.get(`${BASE}/about`);
    expect(pageRes.headers()["x-powered-by"]).toBeUndefined();

    const apiRes = await request.get(`${BASE}/api/hello`);
    expect(apiRes.headers()["x-powered-by"]).toBeUndefined();
  });

  // Ref: opennextjs-cloudflare headers.test.ts — "Middleware headers override next.config.js headers"
  // In Next.js, `dangerous.middlewareHeadersOverrideNextConfigHeaders` lets middleware
  // overwrite config headers for the same key. vinext does not implement this config flag.
  // Tests: ON-8 #2 in TRACKING.md
  test.fixme(
    "middleware headers override config headers for same key",
    async () => {
      // Would test: middleware sets e2e-headers=middleware, config sets e2e-headers=next.config.js
      // With dangerous.middlewareHeadersOverrideNextConfigHeaders enabled, middleware wins.
      // Needs: config flag support + fixture with conflicting header keys
    },
  );

  // Ref: opennextjs-cloudflare headers.test.ts — has/missing conditions
  test("config headers with has/missing conditions", async ({ request }) => {
    const baseline = await request.get(`${BASE}/about`);
    expect(baseline.status()).toBe(200);
    expect(baseline.headers()["x-conditional-header"]).toBeUndefined();
    expect(baseline.headers()["x-preview-header"]).toBeUndefined();

    // has(header) + missing(cookie) => header should be applied
    const withRequiredHeader = await request.get(`${BASE}/about`, {
      headers: { "x-user-tier": "pro" },
    });
    expect(withRequiredHeader.status()).toBe(200);
    expect(withRequiredHeader.headers()["x-conditional-header"]).toBe("enabled");

    // same request + cookie that must be missing => header should not be applied
    const blockedByMissingCondition = await request.get(`${BASE}/about`, {
      headers: {
        "x-user-tier": "pro",
        "cookie": "no-config-header=1",
      },
    });
    expect(blockedByMissingCondition.status()).toBe(200);
    expect(blockedByMissingCondition.headers()["x-conditional-header"]).toBeUndefined();

    // has(query) => header should be applied
    const withPreviewQuery = await request.get(`${BASE}/about?preview=1`);
    expect(withPreviewQuery.status()).toBe(200);
    expect(withPreviewQuery.headers()["x-preview-header"]).toBe("true");

    // unmatched query => header should not be applied
    const withoutPreviewQuery = await request.get(`${BASE}/about?preview=0`);
    expect(withoutPreviewQuery.status()).toBe(200);
    expect(withoutPreviewQuery.headers()["x-preview-header"]).toBeUndefined();
  });
});
