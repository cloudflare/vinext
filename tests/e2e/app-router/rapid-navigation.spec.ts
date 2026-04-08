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
  test("A→B→C rapid navigation completes smoothly without full page reload", async ({ page }) => {
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

    // Click B then immediately click C (before B fully commits)
    // Use a single page.evaluate() to click both links atomically.
    // This avoids React re-render issues and prevents "execution context destroyed" errors in CI.
    await page.evaluate(() => {
      const linkB = document.querySelector('[data-testid="page-a-link-to-b"]') as HTMLElement;
      const linkC = document.querySelector('[data-testid="page-a-link-to-c"]') as HTMLElement;
      if (linkB) linkB.click();
      if (linkC) linkC.click();
    });

    // Use toHaveURL (polling) instead of waitForURL (navigation event) because
    // rapid back-to-back client-side navigations abort the first navigation,
    // causing waitForURL to fail with ERR_ABORTED.
    await expect(page).toHaveURL(`${BASE}/nav-rapid/page-c`, { timeout: 10_000 });
    await expect(page.locator("h1")).toHaveText("Page C");

    // Verify no full page reload happened (marker should survive)
    const marker = await page.evaluate(() => (window as any).__NAV_MARKER__);
    expect(marker).toBe("started-at-a");

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

    // Navigate to B then immediately change query param (same-route nav)
    // Use a single page.evaluate() to click both links atomically.
    //
    // Why isSameRoute === true for the second navigation:
    // Both clicks run synchronously in the same microtask. The first click calls
    // setPendingPathname('/nav-rapid/page-b', navId=1), storing the pending target.
    // The second click then reads pendingPathname (which is '/nav-rapid/page-b'),
    // compares it to its own target pathname (also '/nav-rapid/page-b'), and sees
    // they match — so isSameRoute is true. This is correct behavior: the second
    // navigation is a same-route query-param change, not a cross-route navigation.
    await page.evaluate(() => {
      const linkB = document.querySelector('[data-testid="page-a-link-to-b"]') as HTMLElement;
      const linkFilter = document.querySelector(
        '[data-testid="page-a-link-to-b-filter"]',
      ) as HTMLElement;
      if (linkB) linkB.click();
      if (linkFilter) linkFilter.click();
    });

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
    await page.click('[data-testid="page-a-link-to-b"]');
    await expect(page.locator("h1")).toHaveText("Page B");

    // Navigate B -> C
    await page.click('[data-testid="link-to-c"]');
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
});
