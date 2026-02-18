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
  // NOTE: vinext does not yet implement has/missing conditions on redirects.
  // See: matchRedirect() in config-matchers.ts — only checks source pattern.
  test.fixme(
    "redirect with has/missing cookie conditions",
    async () => {
      // Would test: redirect only when cookie is present/missing
      // Needs has/missing support in matchRedirect()
    },
  );
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
});
