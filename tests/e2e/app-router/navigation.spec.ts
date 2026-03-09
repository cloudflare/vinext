import { test, expect } from "@playwright/test";

const BASE = "http://localhost:4174";

/**
 * Wait for the RSC browser entry to hydrate. The browser entry sets
 * window.__VINEXT_RSC_ROOT__ after hydration completes.
 */
async function waitForHydration(page: import("@playwright/test").Page) {
  await expect(async () => {
    const ready = await page.evaluate(() => !!(window as any).__VINEXT_RSC_ROOT__);
    expect(ready).toBe(true);
  }).toPass({ timeout: 10_000 });
}

test.describe("App Router Client-side Navigation", () => {
  test("Link click navigates without full page reload", async ({ page }) => {
    await page.goto(`${BASE}/`);
    await expect(page.locator("h1")).toHaveText("Welcome to App Router");
    await waitForHydration(page);

    // Set marker to detect full page reload
    await page.evaluate(() => {
      (window as any).__NAV_MARKER__ = true;
    });

    // Click the Link to About
    await page.click('a[href="/about"]');

    // Wait for the About content to appear
    await expect(page.locator("h1")).toHaveText("About");
    await expect(page.locator("main > p")).toContainText("This is the about page.");

    // Verify no full reload (marker should survive)
    const marker = await page.evaluate(() => (window as any).__NAV_MARKER__);
    expect(marker).toBe(true);

    // URL should have changed
    expect(page.url()).toBe(`${BASE}/about`);
  });

  test("Link navigates back from about to home", async ({ page }) => {
    await page.goto(`${BASE}/about`);
    await expect(page.locator("h1")).toHaveText("About");
    await waitForHydration(page);

    await page.evaluate(() => {
      (window as any).__NAV_MARKER__ = true;
    });

    await page.click('a[href="/"]');
    await expect(page.locator("h1")).toHaveText("Welcome to App Router");

    const marker = await page.evaluate(() => (window as any).__NAV_MARKER__);
    expect(marker).toBe(true);
    expect(page.url()).toBe(`${BASE}/`);
  });

  test("browser back/forward buttons work after client navigation", async ({ page }) => {
    await page.goto(`${BASE}/`);
    await expect(page.locator("h1")).toHaveText("Welcome to App Router");
    await waitForHydration(page);

    // Navigate: Home -> About via link
    await page.click('a[href="/about"]');
    await expect(page.locator("h1")).toHaveText("About");

    // Go back
    await page.goBack();
    await expect(page.locator("h1")).toHaveText("Welcome to App Router");
    expect(page.url()).toBe(`${BASE}/`);

    // Go forward
    await page.goForward();
    await expect(page.locator("h1")).toHaveText("About");
    expect(page.url()).toBe(`${BASE}/about`);
  });

  test("multiple sequential navigations work without reload", async ({ page }) => {
    await page.goto(`${BASE}/`);
    await expect(page.locator("h1")).toHaveText("Welcome to App Router");
    await waitForHydration(page);

    await page.evaluate(() => {
      (window as any).__NAV_MARKER__ = true;
    });

    // Home -> About
    await page.click('a[href="/about"]');
    await expect(page.locator("h1")).toHaveText("About");

    // About -> Home
    await page.click('a[href="/"]');
    await expect(page.locator("h1")).toHaveText("Welcome to App Router");

    // Home -> Blog
    await page.click('a[href="/blog/hello-world"]');
    await expect(page.locator("h1")).toHaveText("Blog Post");
    await expect(page.locator("main > p")).toContainText("Slug: hello-world");

    // All without full reload
    const marker = await page.evaluate(() => (window as any).__NAV_MARKER__);
    expect(marker).toBe(true);
  });

  test("navigation to dynamic route renders correct params", async ({ page }) => {
    await page.goto(`${BASE}/`);
    await expect(page.locator("h1")).toHaveText("Welcome to App Router");
    await waitForHydration(page);

    await page.click('a[href="/blog/hello-world"]');
    await expect(page.locator("h1")).toHaveText("Blog Post");
    await expect(page.locator("main > p")).toContainText("Slug: hello-world");
    expect(page.url()).toBe(`${BASE}/blog/hello-world`);
  });

  test("navigation to dashboard preserves nested layout", async ({ page }) => {
    await page.goto(`${BASE}/`);
    await expect(page.locator("h1")).toHaveText("Welcome to App Router");
    await waitForHydration(page);

    await page.click('a[href="/dashboard"]');
    await expect(page.locator("h1")).toHaveText("Dashboard");
    await expect(page.locator("#dashboard-layout")).toBeVisible();
    await expect(page.locator("#dashboard-layout > nav span")).toHaveText("Dashboard Nav");
  });

  test("scroll-to-top happens after new content renders", async ({ page }) => {
    await page.goto(`${BASE}/`);
    await expect(page.locator("h1")).toHaveText("Welcome to App Router");
    await waitForHydration(page);

    // Make the page scrollable and scroll down
    await page.evaluate(() => {
      document.body.style.minHeight = "3000px";
      window.scrollTo(0, 1500);
    });

    // Verify we actually scrolled
    const scrollBefore = await page.evaluate(() => window.scrollY);
    expect(scrollBefore).toBeGreaterThan(0);

    // Navigate via Link
    await page.click('a[href="/about"]');
    await expect(page.locator("h1")).toHaveText("About");

    // Verify we're at the top after the new content rendered
    const scrollAfter = await page.evaluate(() => window.scrollY);
    expect(scrollAfter).toBe(0);
  });
});
