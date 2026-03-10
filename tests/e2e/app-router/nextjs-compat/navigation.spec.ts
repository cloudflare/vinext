/**
 * Next.js Compat E2E: navigation
 *
 * Ported from: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/navigation/navigation.test.ts
 *
 * Browser-level tests for navigation behavior:
 * - Client-side redirect via router.push()
 * - Client-side notFound() trigger via button
 * - Link-based client-side navigation
 * - Server-side redirect follows through in browser
 * - Server-side notFound renders not-found component in browser
 */

import { test, expect } from "@playwright/test";

const BASE = "http://localhost:4174";

async function waitForHydration(page: import("@playwright/test").Page) {
  await expect(async () => {
    const ready = await page.evaluate(() => !!(window as any).__VINEXT_RSC_ROOT__);
    expect(ready).toBe(true);
  }).toPass({ timeout: 10_000 });
}

test.describe("Next.js compat: navigation (browser)", () => {
  // Next.js: 'should redirect in a server component'
  // Source: navigation.test.ts#L168-L174
  test("server component redirect lands on result page", async ({ page }) => {
    // The server redirect should be followed by the browser
    await page.goto(`${BASE}/nextjs-compat/nav-redirect-server`);
    await expect(page.locator("#result-page")).toHaveText("Result Page");
    expect(page.url()).toContain("/nextjs-compat/nav-redirect-result");
  });

  // Next.js: 'should redirect client-side'
  // Source: navigation.test.ts#L184-L191
  test("client-side redirect via router.push()", async ({ page }) => {
    await page.goto(`${BASE}/nextjs-compat/nav-client-redirect`);
    await waitForHydration(page);

    await page.click("#redirect-btn");
    await expect(page.locator("#result-page")).toHaveText("Result Page", {
      timeout: 10_000,
    });
    expect(page.url()).toContain("/nextjs-compat/nav-redirect-result");
  });

  // Next.js: 'should trigger not-found in a server component'
  // Source: navigation.test.ts#L136-L146
  test("server component notFound() renders not-found component", async ({ page }) => {
    const response = await page.goto(`${BASE}/nextjs-compat/nav-notfound-server`);
    expect(response?.status()).toBe(404);
    // Should render the root not-found.tsx content
    await expect(page.locator("body")).toContainText("404");
  });

  // Next.js: 'should trigger not-found client-side'
  // Source: navigation.test.ts#L155-L165
  test("client-side notFound() trigger renders not-found component", async ({ page }) => {
    await page.goto(`${BASE}/nextjs-compat/nav-client-notfound`);
    await waitForHydration(page);

    // Verify the page loaded correctly first
    await expect(page.locator("#notfound-trigger-page")).toHaveText("Not Found Trigger Page");

    // Click button to trigger notFound()
    await page.click("#trigger-notfound");

    // Should render the not-found component
    await expect(async () => {
      const text = await page.locator("body").textContent();
      expect(text).toContain("404");
    }).toPass({ timeout: 10_000 });
  });

  // Next.js: Link-based client-side navigation
  test("Link navigates client-side without full reload", async ({ page }) => {
    await page.goto(`${BASE}/nextjs-compat/nav-link-test`);
    await waitForHydration(page);

    // Set marker for reload detection
    await page.evaluate(() => {
      (window as any).__NAV_MARKER__ = true;
    });

    // Click Link to result page
    await page.click("#link-to-result");
    await expect(page.locator("#result-page")).toHaveText("Result Page", {
      timeout: 10_000,
    });

    // Verify no full reload
    const marker = await page.evaluate(() => (window as any).__NAV_MARKER__);
    expect(marker).toBe(true);
    expect(page.url()).toContain("/nextjs-compat/nav-redirect-result");
  });

  // Client-side navigation to a non-existent route should render not-found
  // This is the core bug from the issue: clicking a Link to a page that doesn't
  // exist should render the not-found.tsx boundary, not a blank white page.
  test("Link to non-existent route renders not-found via client navigation", async ({ page }) => {
    await page.goto(`${BASE}/nextjs-compat/nav-link-test`);
    await waitForHydration(page);

    // Set marker to verify it's a client-side navigation (no full reload)
    await page.evaluate(() => {
      (window as any).__NAV_MARKER__ = true;
    });

    // Click Link to a non-existent page
    await page.click("#link-to-nonexistent");

    // Should render the not-found.tsx content (not a blank page)
    await expect(page.locator("body")).toContainText("404", {
      timeout: 10_000,
    });
    expect(page.url()).toContain("/this-route-does-not-exist");
  });

  // Client-side navigation to a page that calls notFound() should render not-found
  test("Link to page calling notFound() renders not-found via client navigation", async ({
    page,
  }) => {
    await page.goto(`${BASE}/nextjs-compat/nav-link-test`);
    await waitForHydration(page);

    // Click Link to a page that calls notFound()
    await page.click("#link-to-notfound-page");

    // Should render the not-found.tsx content (not a blank page)
    await expect(page.locator("body")).toContainText("404", {
      timeout: 10_000,
    });
    expect(page.url()).toContain("/notfound-test");
  });

  // Back/forward navigation
  test("browser back button works after client navigation", async ({ page }) => {
    await page.goto(`${BASE}/nextjs-compat/nav-link-test`);
    await waitForHydration(page);

    // Navigate to result page
    await page.click("#link-to-result");
    await expect(page.locator("#result-page")).toHaveText("Result Page", {
      timeout: 10_000,
    });

    // Go back
    await page.goBack();
    await expect(page.locator("#link-test-page")).toHaveText("Link Test Page", { timeout: 10_000 });
  });
});
