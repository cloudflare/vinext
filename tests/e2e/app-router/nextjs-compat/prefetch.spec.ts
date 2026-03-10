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
    const ready = await page.evaluate(() => !!(window as any).__VINEXT_RSC_ROOT__);
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
    await expect(page.locator("#no-prefetch-target")).toHaveText("No Prefetch Target Page", {
      timeout: 10_000,
    });
  });

  // Test that prefetched link navigates correctly
  test("should navigate via prefetched link", async ({ page }) => {
    await page.goto(`${BASE}/nextjs-compat/prefetch-test`);
    await waitForHydration(page);

    // Click the prefetch link
    await page.click("#prefetch-link");
    await expect(page.locator("#prefetch-target")).toHaveText("Prefetch Target Page", {
      timeout: 10_000,
    });
  });

  // Test that prefetched navigation preserves client state (no full reload)
  test("prefetched navigation does not cause full page reload", async ({ page }) => {
    await page.goto(`${BASE}/nextjs-compat/prefetch-test`);
    await waitForHydration(page);

    // Set marker to detect full reload
    await page.evaluate(() => {
      (window as any).__PREFETCH_MARKER__ = true;
    });

    // Navigate via prefetched link
    await page.click("#prefetch-link");
    await expect(page.locator("#prefetch-target")).toHaveText("Prefetch Target Page", {
      timeout: 10_000,
    });

    // Marker should survive (no full reload)
    const marker = await page.evaluate(() => (window as any).__PREFETCH_MARKER__);
    expect(marker).toBe(true);
  });

  // Test that prefetch populates the in-memory RSC cache
  test("visible Link prefetches RSC payload into in-memory cache", async ({ page }) => {
    await page.goto(`${BASE}/nextjs-compat/prefetch-test`);
    await waitForHydration(page);

    // Wait for prefetch to complete (requestIdleCallback + fetch)
    await expect(async () => {
      const cacheSize = await page.evaluate(() => {
        const cache = (window as any).__VINEXT_RSC_PREFETCH_CACHE__;
        return cache ? cache.size : 0;
      });
      // The prefetch-enabled link should have populated the cache
      // (the prefetch={false} link should not)
      expect(cacheSize).toBeGreaterThanOrEqual(1);
    }).toPass({ timeout: 10_000 });

    // Verify the cached URL is for the prefetch target
    const cachedUrls = await page.evaluate(() => {
      const cache = (window as any).__VINEXT_RSC_PREFETCH_CACHE__;
      return cache ? Array.from(cache.keys()) : [];
    });
    expect((cachedUrls as string[]).some((url) => url.includes("prefetch-test/target.rsc"))).toBe(
      true,
    );
  });

  // Test that prefetch={false} does NOT populate the cache
  test("Link with prefetch={false} does not prefetch RSC payload", async ({ page }) => {
    await page.goto(`${BASE}/nextjs-compat/prefetch-test`);
    await waitForHydration(page);

    // Wait for the prefetch-enabled link to populate the cache, then check
    // that the no-prefetch target is NOT in the cache.
    await expect(async () => {
      const cacheSize = await page.evaluate(() => {
        const cache = (window as any).__VINEXT_RSC_PREFETCH_CACHE__;
        return cache ? cache.size : 0;
      });
      // The prefetch-enabled link should have populated the cache by now
      expect(cacheSize).toBeGreaterThanOrEqual(1);
    }).toPass({ timeout: 10_000 });

    // Verify the no-prefetch target is NOT in the cache
    const hasNoPrefetchCached = await page.evaluate(() => {
      const cache = (window as any).__VINEXT_RSC_PREFETCH_CACHE__;
      if (!cache) return false;
      for (const key of cache.keys()) {
        if (key.includes("no-prefetch.rsc")) return true;
      }
      return false;
    });
    expect(hasNoPrefetchCached).toBe(false);
  });

  // Test that navigating to a prefetched link uses the cache (no extra fetch)
  test("navigation to prefetched link uses cached RSC payload", async ({ page }) => {
    await page.goto(`${BASE}/nextjs-compat/prefetch-test`);
    await waitForHydration(page);

    // Wait for prefetch to populate the cache
    await expect(async () => {
      const cacheSize = await page.evaluate(() => {
        const cache = (window as any).__VINEXT_RSC_PREFETCH_CACHE__;
        return cache ? cache.size : 0;
      });
      expect(cacheSize).toBeGreaterThanOrEqual(1);
    }).toPass({ timeout: 10_000 });

    // Start monitoring network requests for .rsc fetches
    const rscRequests: string[] = [];
    page.on("request", (req) => {
      if (req.url().includes("target.rsc")) {
        rscRequests.push(req.url());
      }
    });

    // Navigate via the prefetched link
    await page.click("#prefetch-link");
    await expect(page.locator("#prefetch-target")).toHaveText("Prefetch Target Page", {
      timeout: 10_000,
    });

    // The cache should have been consumed (no extra network request for the .rsc)
    // The prefetch fetch already happened, but __VINEXT_RSC_NAVIGATE__ should
    // NOT have made an additional fetch — it used the cached response.
    expect(rscRequests.length).toBe(0);

    // The cache entry should have been consumed (deleted after use)
    const cacheHasTarget = await page.evaluate(() => {
      const cache = (window as any).__VINEXT_RSC_PREFETCH_CACHE__;
      if (!cache) return false;
      for (const key of cache.keys()) {
        if (key.includes("target.rsc")) return true;
      }
      return false;
    });
    expect(cacheHasTarget).toBe(false);
  });
});
