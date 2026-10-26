/**
 * Next.js Compat E2E: metadata
 *
 * Ported from: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/metadata/metadata.test.ts
 *
 * Browser-level tests for metadata behavior:
 * - generateMetadata errors activate local/global boundaries after hydration
 * - document.title updates on client-side navigation
 * - Meta tags present in the DOM after hydration
 * - Title template applied in browser
 */

import { test, expect } from "@playwright/test";
import { waitForAppRouterHydration } from "../../helpers";

const BASE = "http://localhost:4174";

test.describe("Next.js compat: metadata (browser)", () => {
  // Next.js: global-error/basic metadata error coverage
  // Source: https://github.com/vercel/next.js/blob/v16.2.7/test/e2e/app-dir/global-error/basic/index.test.ts#L135-L176
  test("generateMetadata error activates the local error boundary after hydration", async ({
    page,
  }) => {
    const response = await page.goto(`${BASE}/nextjs-compat/metadata-error-with-boundary`);

    expect(response?.status()).toBe(200);
    await expect(page.locator("#error")).toHaveText("Local error boundary");
    await expect(page.getByTestId("global-error")).toHaveCount(0);
  });

  test("generateMetadata error activates the local boundary during client navigation", async ({
    page,
  }) => {
    await page.goto(`${BASE}/`);
    await waitForAppRouterHydration(page);
    await page.getByTestId("metadata-error-with-boundary-link").click();

    await expect(page).toHaveURL(`${BASE}/nextjs-compat/metadata-error-with-boundary`);
    await expect(page.locator("#error")).toHaveText("Local error boundary");
    await expect(page.getByTestId("global-error")).toHaveCount(0);
  });

  test("generateMetadata error activates global-error after hydration", async ({ page }) => {
    const response = await page.goto(`${BASE}/nextjs-compat/metadata-error-without-boundary`);

    expect(response?.status()).toBe(200);
    await expect(page.getByTestId("global-error")).toBeVisible();
    await expect(page.getByTestId("global-error-message")).toContainText(
      "Sensitive metadata error detail",
    );
  });

  test("layout generateMetadata error activates the local error boundary after hydration", async ({
    page,
  }) => {
    const response = await page.goto(`${BASE}/nextjs-compat/layout-metadata-error-with-boundary`);

    expect(response?.status()).toBe(200);
    await expect(page.locator("#error")).toHaveText("Local layout metadata error boundary");
    await expect(page.getByTestId("global-error")).toHaveCount(0);
  });

  test("layout generateMetadata error activates global-error after hydration", async ({ page }) => {
    const response = await page.goto(
      `${BASE}/nextjs-compat/layout-metadata-error-without-boundary`,
    );

    expect(response?.status()).toBe(200);
    await expect(page.getByTestId("global-error")).toBeVisible();
    await expect(page.getByTestId("global-error-message")).toContainText("Layout metadata error");
  });

  test("layout generateViewport error activates the local error boundary after hydration", async ({
    page,
  }) => {
    const response = await page.goto(`${BASE}/nextjs-compat/layout-viewport-error-with-boundary`);

    expect(response?.status()).toBe(200);
    await expect(page.locator("#error")).toHaveText("Local layout viewport error boundary");
    await expect(page.getByTestId("global-error")).toHaveCount(0);
  });

  test("layout generateViewport error activates global-error after hydration", async ({ page }) => {
    const response = await page.goto(
      `${BASE}/nextjs-compat/layout-viewport-error-without-boundary`,
    );

    expect(response?.status()).toBe(200);
    await expect(page.getByTestId("global-error")).toBeVisible();
    await expect(page.getByTestId("global-error-message")).toContainText("Layout viewport error");
  });

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
  // Source: https://github.com/vercel/next.js/blob/v16.2.7/test/e2e/app-dir/metadata/metadata.test.ts#L36-L40
  test("title template skips the page beside its layout", async ({ page }) => {
    await page.goto(`${BASE}/nextjs-compat/metadata-title-template`);
    await expect(page).toHaveTitle("Page");
  });

  test("title template applies to child page", async ({ page }) => {
    await page.goto(`${BASE}/nextjs-compat/metadata-title-template/child`);
    await expect(page).toHaveTitle("Extra Page | Layout");
  });

  // Next.js: 'should support stashed title in one layer of page and layout'
  // Source: https://github.com/vercel/next.js/blob/v16.2.7/test/e2e/app-dir/metadata/metadata.test.ts#L42-L46
  test("stashed title in one layer of page and layout", async ({ page }) => {
    await page.goto(`${BASE}/nextjs-compat/metadata-title-template/extra`);
    await expect(page).toHaveTitle("Extra Page | Layout");
  });

  // Next.js: 'should support stashed title in two layers of page and layout'
  // Source: https://github.com/vercel/next.js/blob/v16.2.7/test/e2e/app-dir/metadata/metadata.test.ts#L55-L61
  test("stashed title in two layers of page and layout", async ({ page }) => {
    await page.goto(`${BASE}/nextjs-compat/metadata-title-template/extra/inner`);
    await expect(page).toHaveTitle("Inner Page | Extra Layout");
    await page.goto(`${BASE}/nextjs-compat/metadata-title-template/extra/inner/deep`);
    await expect(page).toHaveTitle("extra layout default | Layout");
  });

  test("a plain-string layout title clears the template", async ({ page }) => {
    // Next.js 16.2.7 titles this "Leaf Page".
    await page.goto(`${BASE}/nextjs-compat/metadata-title-template/plain/leaf`);
    await expect(page).toHaveTitle("Leaf Page");
  });

  test("an intercepting layout beside its page keeps the template for it", async ({ page }) => {
    // Next.js 16.2.7 titles these "Photo | Layout" and "Framed": only a
    // layout above the intercepting page clears the template.
    await page.goto(`${BASE}/nextjs-compat/metadata-title-template/intercept`);
    await waitForAppRouterHydration(page);
    await page.getByRole("link", { name: "Photo 1" }).click();
    await expect(page.locator("#title-template-intercept-photo")).toBeVisible();
    await expect(page).toHaveTitle("Photo | Layout");

    await page.goto(`${BASE}/nextjs-compat/metadata-title-template/intercept`);
    await waitForAppRouterHydration(page);
    await page.getByRole("link", { name: "Framed 1" }).click();
    await expect(page.locator("#title-template-intercept-framed")).toBeVisible();
    await expect(page).toHaveTitle("Framed");
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
    await waitForAppRouterHydration(page);

    // Navigate to the title page via Link
    await page.click("#link-to-title");

    // Title should update to the metadata-title page's title
    await expect(async () => {
      const title = await page.evaluate(() => document.title);
      expect(title).toBe("this is the page title");
    }).toPass({ timeout: 10_000 });
  });

  // Next.js resolves metadata inside the page's Flight render, so a React
  // cache() loader that generateMetadata() and the page both call runs once.
  // The fetch() half of these tests is omitted: the fixture runs offline.
  test.describe("react cache", () => {
    // Next.js: 'should have same title and page value on initial load'
    // Source: https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-dir/metadata/metadata.test.ts#L815-L829
    test("should have same title and page value on initial load", async ({ page }) => {
      await page.goto(`${BASE}/nextjs-compat/metadata-cache-deduping`);
      const value = await page.locator("#value").textContent();
      // Value in the title should match what's shown on the page component
      const title = JSON.parse(await page.title()) as { val: string };
      expect(title.val).toBe(value);
    });

    // Next.js: 'should have same title and page value when navigating'
    // Source: https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-dir/metadata/metadata.test.ts#L831-L855
    test("should have same title and page value when navigating", async ({ page }) => {
      await page.goto(`${BASE}/nextjs-compat/metadata-cache-deduping/navigating`);
      await waitForAppRouterHydration(page);
      await page.click("#link-to-deduping-page");
      const value = await page.locator("#value").textContent();
      // Dynamic metadata streams in async
      await expect(page).toHaveTitle(/"page":"cache-deduping"/);
      // Value in the title should match what's shown on the page component
      const title = JSON.parse(await page.title()) as { val: string };
      expect(title.val).toBe(value);
    });
  });
});
