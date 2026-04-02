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

test.describe("rapid navigation", () => {
  test("A→B→C rapid navigation completes smoothly", async ({ page }) => {
    // Collect console errors during the test
    const errors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        errors.push(msg.text());
      }
    });

    // Start at page A
    await page.goto(`${BASE}/nav-rapid/page-a`);
    await expect(page.locator("h1")).toHaveText("Page A");
    await waitForHydration(page);

    // Click B then immediately click C (before B fully commits)
    await page.click('a[href="/nav-rapid/page-b"]');
    await page.click('a[href="/nav-rapid/page-c"]');

    // Wait for navigation to settle on page C
    await page.waitForURL(`${BASE}/nav-rapid/page-c`);
    await expect(page.locator("h1")).toHaveText("Page C");

    // Verify no console errors about navigation or vinext
    const navigationErrors = errors.filter(
      (e) => e.includes("navigation") || e.includes("vinext") || e.includes("router"),
    );
    expect(navigationErrors).toHaveLength(0);
  });

  test("same-route query change during cross-route navigation", async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        errors.push(msg.text());
      }
    });

    // Start at page A
    await page.goto(`${BASE}/nav-rapid/page-a`);
    await expect(page.locator("h1")).toHaveText("Page A");
    await waitForHydration(page);

    // Navigate to B with query param
    await page.click('a[href="/nav-rapid/page-b"]');

    // Immediately change query param (same-route navigation to B with query)
    await page.goto(`${BASE}/nav-rapid/page-b?filter=test`);

    // Should settle on B with query param
    await expect(page.locator("h1")).toHaveText("Page B");
    await expect(page).toHaveURL(`${BASE}/nav-rapid/page-b?filter=test`);

    // Verify no navigation-related errors
    const navigationErrors = errors.filter(
      (e) => e.includes("navigation") || e.includes("vinext") || e.includes("router"),
    );
    expect(navigationErrors).toHaveLength(0);
  });

  test("rapid back-forward navigation maintains state consistency", async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        errors.push(msg.text());
      }
    });

    // Start at page A
    await page.goto(`${BASE}/nav-rapid/page-a`);
    await expect(page.locator("h1")).toHaveText("Page A");
    await waitForHydration(page);

    // Navigate A -> B
    await page.click('a[href="/nav-rapid/page-b"]');
    await expect(page.locator("h1")).toHaveText("Page B");

    // Navigate B -> C
    await page.click('a[href="/nav-rapid/page-c"]');
    await expect(page.locator("h1")).toHaveText("Page C");

    // Rapid back navigation
    await page.goBack();
    await page.goBack();

    // Should be back at A
    await expect(page.locator("h1")).toHaveText("Page A");
    await expect(page).toHaveURL(`${BASE}/nav-rapid/page-a`);

    // Rapid forward navigation
    await page.goForward();
    await page.goForward();

    // Should be back at C
    await expect(page.locator("h1")).toHaveText("Page C");
    await expect(page).toHaveURL(`${BASE}/nav-rapid/page-c`);

    // Verify no navigation-related errors
    const navigationErrors = errors.filter(
      (e) => e.includes("navigation") || e.includes("vinext") || e.includes("router"),
    );
    expect(navigationErrors).toHaveLength(0);
  });

  test("interrupted navigation does not leave partial state", async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        errors.push(msg.text());
      }
    });

    // Start at page A
    await page.goto(`${BASE}/nav-rapid/page-a`);
    await expect(page.locator("h1")).toHaveText("Page A");
    await waitForHydration(page);

    // Set marker to detect full page reload
    await page.evaluate(() => {
      (window as any).__NAV_MARKER__ = "started-at-a";
    });

    // Start navigation to B but immediately interrupt with navigation to C
    await page.click('a[href="/nav-rapid/page-b"]');
    await page.click('a[href="/nav-rapid/page-c"]');

    // Wait for navigation to settle
    await page.waitForURL(`${BASE}/nav-rapid/page-c`);
    await expect(page.locator("h1")).toHaveText("Page C");

    // Verify no full page reload happened (marker should survive)
    const marker = await page.evaluate(() => (window as any).__NAV_MARKER__);
    expect(marker).toBe("started-at-a");

    // Verify we're on the correct final URL
    await expect(page).toHaveURL(`${BASE}/nav-rapid/page-c`);

    // Verify no navigation-related errors
    const navigationErrors = errors.filter(
      (e) => e.includes("navigation") || e.includes("vinext") || e.includes("router"),
    );
    expect(navigationErrors).toHaveLength(0);
  });
});
