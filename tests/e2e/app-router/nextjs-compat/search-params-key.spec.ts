/**
 * Next.js Compat E2E: search-params-react-key
 *
 * Ported from: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/search-params-react-key/layout-params.test.ts
 *
 * Tests that changing search params via router.push/replace does NOT
 * remount the component tree (client state persists).
 */

import { test, expect } from "@playwright/test";

const BASE = "http://localhost:4174";

async function waitForHydration(page: import("@playwright/test").Page) {
  await expect(async () => {
    const ready = await page.evaluate(() => !!(window as any).__VINEXT_RSC_ROOT__);
    expect(ready).toBe(true);
  }).toPass({ timeout: 10_000 });
}

test.describe("Next.js compat: search-params-react-key (browser)", () => {
  // Next.js: 'should keep the React router instance the same when changing the search params'
  test("component state persists across search param changes via router.push", async ({ page }) => {
    await page.goto(`${BASE}/nextjs-compat/search-params-key`);
    await waitForHydration(page);

    // Initial state: count=0
    await expect(page.locator("#count")).toHaveText("0");

    // Increment twice: count=2
    await page.click("#increment");
    await page.click("#increment");
    await expect(page.locator("#count")).toHaveText("2");

    // Push search params: ?foo=bar
    await page.click("#push-foo-bar");

    // Wait for URL to update (client-side navigation)
    await expect(async () => {
      expect(page.url()).toContain("foo=bar");
    }).toPass({ timeout: 10_000 });

    // Count should still be 2 (component was NOT remounted)
    await expect(page.locator("#count")).toHaveText("2");
  });

  test("component state persists across search param changes via router.replace", async ({
    page,
  }) => {
    await page.goto(`${BASE}/nextjs-compat/search-params-key`);
    await waitForHydration(page);

    // Increment twice: count=2
    await page.click("#increment");
    await page.click("#increment");
    await expect(page.locator("#count")).toHaveText("2");

    // Replace search params: ?foo=baz
    await page.click("#replace-foo-baz");

    // Wait for URL to update
    await expect(async () => {
      expect(page.url()).toContain("foo=baz");
    }).toPass({ timeout: 10_000 });

    // Count should still be 2
    await expect(page.locator("#count")).toHaveText("2");
  });
});
