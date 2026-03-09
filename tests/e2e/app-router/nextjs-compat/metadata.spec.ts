/**
 * Next.js Compat E2E: metadata
 *
 * Ported from: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/metadata/metadata.test.ts
 *
 * Browser-level tests for metadata behavior:
 * - document.title updates on client-side navigation
 * - Meta tags present in the DOM after hydration
 * - Title template applied in browser
 */

import { test, expect } from "@playwright/test";

const BASE = "http://localhost:4174";

async function waitForHydration(page: import("@playwright/test").Page) {
  await expect(async () => {
    const ready = await page.evaluate(() => !!(window as any).__VINEXT_RSC_ROOT__);
    expect(ready).toBe(true);
  }).toPass({ timeout: 10_000 });
}

test.describe("Next.js compat: metadata (browser)", () => {
  // Next.js: 'should support title and description'
  // Source: metadata.test.ts#L25-L32
  test("document.title matches metadata export", async ({ page }) => {
    await page.goto(`${BASE}/nextjs-compat/metadata-title`);
    await expect(page).toHaveTitle("this is the page title");
  });

  test("description meta tag is present in DOM", async ({ page }) => {
    await page.goto(`${BASE}/nextjs-compat/metadata-title`);
    const content = await page.locator('meta[name="description"]').getAttribute("content");
    expect(content).toBe("this is the layout description");
  });

  // Next.js: 'should support title template'
  // Source: metadata.test.ts#L34-L38
  test("title template applies correctly", async ({ page }) => {
    await page.goto(`${BASE}/nextjs-compat/metadata-title-template`);
    await expect(page).toHaveTitle("Page | Layout");
  });

  test("title template applies to child page", async ({ page }) => {
    await page.goto(`${BASE}/nextjs-compat/metadata-title-template/child`);
    await expect(page).toHaveTitle("Extra Page | Layout");
  });

  // Next.js: 'should support opengraph tags'
  // Source: metadata.test.ts#L175-L211
  test("OpenGraph meta tags present in DOM", async ({ page }) => {
    await page.goto(`${BASE}/nextjs-compat/metadata-opengraph`);
    const ogTitle = await page.locator('meta[property="og:title"]').getAttribute("content");
    expect(ogTitle).toBe("My custom title");

    const ogDesc = await page.locator('meta[property="og:description"]').getAttribute("content");
    expect(ogDesc).toBe("My custom description");

    const ogType = await page.locator('meta[property="og:type"]').getAttribute("content");
    expect(ogType).toBe("website");
  });

  // Next.js: 'should support twitter card'
  // Source: metadata.test.ts#L308-L323
  test("Twitter card meta tags present in DOM", async ({ page }) => {
    await page.goto(`${BASE}/nextjs-compat/metadata-twitter`);
    const card = await page.locator('meta[name="twitter:card"]').getAttribute("content");
    expect(card).toBe("summary_large_image");

    const title = await page.locator('meta[name="twitter:title"]').getAttribute("content");
    expect(title).toBe("Twitter Title");
  });

  // Next.js: 'should support generateMetadata dynamic props'
  // Source: metadata.test.ts#L174-L184
  test("generateMetadata renders correct title for dynamic route", async ({ page }) => {
    await page.goto(`${BASE}/nextjs-compat/metadata-generate/my-slug`);
    await expect(page).toHaveTitle("params - my-slug");
  });

  // Next.js: 'should apply metadata when navigating client-side'
  // Source: metadata.test.ts#L130-L149
  test("title updates on client-side navigation", async ({ page }) => {
    await page.goto(`${BASE}/nextjs-compat/nav-link-test`);
    await waitForHydration(page);

    // Navigate to the title page via Link
    await page.click("#link-to-title");

    // Title should update to the metadata-title page's title
    await expect(async () => {
      const title = await page.evaluate(() => document.title);
      expect(title).toBe("this is the page title");
    }).toPass({ timeout: 10_000 });
  });
});
