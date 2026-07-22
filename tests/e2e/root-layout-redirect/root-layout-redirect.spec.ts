/**
 * Next.js Compat E2E: root-layout-redirect
 *
 * Ported from: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/root-layout-redirect/root-layout-redirect.test.ts
 *
 * Covers redirect() called from a 'use client' root layout (the layout that
 * renders <html>/<body>). The redirect must complete via client-side navigation
 * and must not produce any browser console errors.
 *
 * Part of issue #1830.
 */

import { test, expect } from "@playwright/test";

const BASE = "http://localhost:4184";

test.describe("root-layout-redirect", () => {
  // Next.js: 'should work using browser'
  // Source: root-layout-redirect.test.ts
  test("should work using browser", async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        consoleErrors.push(msg.text());
      }
    });

    await page.goto(`${BASE}/`);

    await page.click("#trigger-redirect");

    await expect(page.locator("#result")).toHaveText("Result Page", {
      timeout: 10_000,
    });

    expect(consoleErrors).toHaveLength(0);
  });
});
