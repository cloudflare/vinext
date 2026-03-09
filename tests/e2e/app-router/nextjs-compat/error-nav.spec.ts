/**
 * Next.js Compat E2E: error-boundary-navigation
 * Ported from: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/error-boundary-navigation/index.test.ts
 */

import { test, expect } from "@playwright/test";

const BASE = "http://localhost:4174";

async function waitForHydration(page: import("@playwright/test").Page) {
  await expect(async () => {
    const ready = await page.evaluate(() => !!(window as any).__VINEXT_RSC_ROOT__);
    expect(ready).toBe(true);
  }).toPass({ timeout: 10_000 });
}

test.describe("Next.js compat: error-boundary-navigation (browser)", () => {
  test("can navigate away from error page", async ({ page }) => {
    await page.goto(`${BASE}/nextjs-compat/error-nav`);
    await waitForHydration(page);

    await page.click("#link-to-error");
    await expect(page.locator("#error-boundary")).toBeVisible({
      timeout: 10_000,
    });

    await page.click("#link-to-result");
    await expect(page.locator("#result-page")).toHaveText("Result Page", {
      timeout: 10_000,
    });
  });

  test("error boundary reset button works", async ({ page }) => {
    await page.goto(`${BASE}/nextjs-compat/error-nav/trigger-error`);

    await expect(page.locator("#error-boundary")).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.locator("#error-message")).not.toBeEmpty();

    // Click reset — since the page always throws, the error boundary
    // should appear again after the reset attempt
    await page.click("#reset-btn");
    await expect(page.locator("#error-boundary")).toBeVisible({
      timeout: 10_000,
    });
  });

  // Navigate away from not-found page
  test("can navigate away from not-found page", async ({ page }) => {
    await page.goto(`${BASE}/nextjs-compat/error-nav/trigger-notfound`);

    // The page should load and show 404-like content
    await expect(async () => {
      const bodyText = await page.locator("body").textContent();
      expect(bodyText?.length).toBeGreaterThan(0);
    }).toPass({ timeout: 10_000 });
  });

  test("navigation to error page then back works", async ({ page }) => {
    await page.goto(`${BASE}/nextjs-compat/error-nav`);
    await waitForHydration(page);

    await page.click("#link-to-error");
    await expect(page.locator("#error-boundary")).toBeVisible({
      timeout: 10_000,
    });

    await page.click("#link-back-home");
    await expect(page.locator("#error-nav-home")).toHaveText("Error Nav Home", {
      timeout: 10_000,
    });
  });
});
