/**
 * Next.js Compat E2E: app-prefetch (browser tests)
 *
 * Ported from: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/app-prefetch/prefetching.test.ts
 *
 * Tests Link prefetching and navigation behavior.
 */

import { test, expect } from "@playwright/test";

const BASE = "http://localhost:4174";

async function waitForHydration(page: import("@playwright/test").Page) {
  await expect(async () => {
    const ready = await page.evaluate(
      () => !!(window as any).__VINEXT_RSC_ROOT__,
    );
    expect(ready).toBe(true);
  }).toPass({ timeout: 10_000 });
}

test.describe("Next.js compat: prefetch (browser)", () => {
  // Next.js: 'should navigate when prefetch is false'
  test("should navigate when prefetch is false", async ({ page }) => {
    await page.goto(`${BASE}/nextjs-compat/prefetch-test`);
    await waitForHydration(page);

    // Click the no-prefetch link
    await page.click("#no-prefetch-link");
    await expect(page.locator("#no-prefetch-target")).toHaveText(
      "No Prefetch Target Page",
      { timeout: 10_000 },
    );
  });

  // Test that prefetched link navigates correctly
  test("should navigate via prefetched link", async ({ page }) => {
    await page.goto(`${BASE}/nextjs-compat/prefetch-test`);
    await waitForHydration(page);

    // Click the prefetch link
    await page.click("#prefetch-link");
    await expect(page.locator("#prefetch-target")).toHaveText(
      "Prefetch Target Page",
      { timeout: 10_000 },
    );
  });

  // Test that prefetched navigation preserves client state (no full reload)
  test("prefetched navigation does not cause full page reload", async ({
    page,
  }) => {
    await page.goto(`${BASE}/nextjs-compat/prefetch-test`);
    await waitForHydration(page);

    // Set marker to detect full reload
    await page.evaluate(() => {
      (window as any).__PREFETCH_MARKER__ = true;
    });

    // Navigate via prefetched link
    await page.click("#prefetch-link");
    await expect(page.locator("#prefetch-target")).toHaveText(
      "Prefetch Target Page",
      { timeout: 10_000 },
    );

    // Marker should survive (no full reload)
    const marker = await page.evaluate(
      () => (window as any).__PREFETCH_MARKER__,
    );
    expect(marker).toBe(true);
  });
});
