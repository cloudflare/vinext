/**
 * OpenNext Compat: Middleware redirect, rewrite, and block behavior.
 *
 * Ported from:
 *   https://github.com/opennextjs/opennextjs-cloudflare/blob/main/examples/e2e/app-router/e2e/middleware.redirect.test.ts
 *   https://github.com/opennextjs/opennextjs-cloudflare/blob/main/examples/e2e/app-router/e2e/middleware.rewrite.test.ts
 * Tests: ON-11 in TRACKING.md
 */
import { test, expect } from "@playwright/test";

const BASE = "http://localhost:4174";

test.describe("Middleware Redirect (OpenNext compat)", () => {
  // Ref: opennextjs-cloudflare middleware.redirect.test.ts — "Middleware Redirect"
  test("navigating to /middleware-redirect lands on /about", async ({
    page,
  }) => {
    await page.goto(`${BASE}/middleware-redirect`);
    await page.waitForURL(/\/about$/);

    const el = page.getByText("About", { exact: true });
    await expect(el).toBeVisible();
  });

  // Ref: opennextjs-cloudflare middleware.redirect.test.ts — cookie set on redirect
  test("redirect sets a cookie", async ({ page, context }) => {
    await page.goto(`${BASE}/middleware-redirect`);
    await page.waitForURL(/\/about$/);

    const cookies = await context.cookies();
    const mwCookie = cookies.find(
      (c) => c.name === "middleware-redirect",
    );
    expect(mwCookie?.value).toBe("success");
  });

  // Ref: opennextjs-cloudflare middleware.redirect.test.ts — direct load also redirects
  test("direct load of /middleware-redirect redirects", async ({
    request,
  }) => {
    const res = await request.get(`${BASE}/middleware-redirect`, {
      maxRedirects: 0,
    });
    // Should be a 307 redirect (Next.js default for temporary redirect)
    expect([301, 302, 307, 308]).toContain(res.status());
    expect(res.headers()["location"]).toMatch(/\/about$/);
  });
});

test.describe("Middleware Rewrite (OpenNext compat)", () => {
  // Ref: opennextjs-cloudflare middleware.rewrite.test.ts — "Middleware Rewrite"
  test("rewrite serves / content at /middleware-rewrite URL", async ({
    page,
  }) => {
    await page.goto(`${BASE}/middleware-rewrite`);

    // URL should stay as /middleware-rewrite (rewrite, not redirect)
    expect(page.url()).toMatch(/\/middleware-rewrite$/);

    // Content should be from / (home page)
    const el = page.getByText("Welcome to App Router", { exact: true });
    await expect(el).toBeVisible();
  });

  // Ref: opennextjs-cloudflare middleware.rewrite.test.ts — "Middleware Rewrite Status Code"
  test(
    "rewrite with custom status code returns 403",
    async ({ page }) => {
      const statusPromise = new Promise<number>((resolve) => {
        page.on("response", (response) => {
          if (
            new URL(response.url()).pathname === "/middleware-rewrite-status"
          ) {
            resolve(response.status());
          }
        });
      });

      await page.goto(`${BASE}/middleware-rewrite-status`);

      // Content should be from / (home page) despite 403 status
      const el = page.getByText("Welcome to App Router", { exact: true });
      await expect(el).toBeVisible();

      expect(await statusPromise).toBe(403);
    },
  );
});

test.describe("Middleware Block (OpenNext compat)", () => {
  test("blocked route returns 403", async ({ request }) => {
    const res = await request.get(`${BASE}/middleware-blocked`);
    expect(res.status()).toBe(403);

    const body = await res.text();
    expect(body).toContain("Blocked by middleware");
  });
});
