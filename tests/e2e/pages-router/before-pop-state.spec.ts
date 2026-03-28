import { test, expect } from "@playwright/test";

const BASE = "http://localhost:4173";

test.describe("router.beforePopState (Pages Router)", () => {
  test("blocking callback prevents route change on back navigation", async ({ page }) => {
    await page.goto(`${BASE}/before-pop-state-test`);
    await page.waitForFunction(() => (window as any).__VINEXT_ROOT__);

    // Enable blocking BEFORE navigating away
    await page.click('[data-testid="enable-blocking"]');
    await expect(page.locator('[data-testid="toggle-blocking"]')).toHaveText("Blocking: ON");

    // Navigate to about (this is a client-side navigation via Link, not popstate)
    await page.click('[data-testid="link-about"]');
    await expect(page.locator("h1")).toHaveText("About");

    // Now go back — popstate fires, beforePopState returns false
    // The router should NOT process the navigation, so the page content
    // should still show "About" (the router didn't render the new page)
    await page.goBack();

    // Wait a moment for the popstate event to fire and be handled
    await page.waitForTimeout(500);

    // The page should still show About content because the router blocked it
    // The URL may have changed but the React tree was not updated
    await expect(page.locator("h1")).toHaveText("About");

    // Verify the block counter was incremented via window global
    const blocked = await page.evaluate(() => (window as any).__popBlocked);
    expect(blocked).toBeGreaterThanOrEqual(1);
  });

  test("blocking callback still prevents route change when destination mounts useRouter", async ({
    page,
  }) => {
    await page.goto(`${BASE}/before-pop-state-test`);
    await page.waitForFunction(() => (window as any).__VINEXT_ROOT__);

    await page.click('[data-testid="enable-blocking"]');
    await expect(page.locator('[data-testid="toggle-blocking"]')).toHaveText("Blocking: ON");

    await page.click('[data-testid="link-destination"]');
    await expect(page.locator("h1")).toHaveText("Before Pop State Destination");
    await expect(page.locator('[data-testid="destination-path"]')).toHaveText(
      "/before-pop-state-destination",
    );

    await page.goBack();
    await page.waitForTimeout(500);

    await expect(page.locator("h1")).toHaveText("Before Pop State Destination");
    await expect(page.locator('[data-testid="destination-path"]')).toHaveText(
      "/before-pop-state-destination",
    );

    const blocked = await page.evaluate(() => (window as any).__popBlocked);
    expect(blocked).toBeGreaterThanOrEqual(1);
  });

  test("allowing callback permits back navigation", async ({ page }) => {
    await page.goto(`${BASE}/before-pop-state-test`);
    await page.waitForFunction(() => (window as any).__VINEXT_ROOT__);

    // Blocking is OFF by default — verify
    await expect(page.locator('[data-testid="toggle-blocking"]')).toHaveText("Blocking: OFF");

    // Navigate to about
    await page.click('[data-testid="link-about"]');
    await expect(page.locator("h1")).toHaveText("About");

    // Go back — should be allowed (beforePopState returns true)
    await page.goBack();
    await expect(page.locator("h1")).toHaveText("Before Pop State Test");
    await expect(page.locator('[data-testid="current-path"]')).toHaveText("/before-pop-state-test");
  });

  test("allowing callback permits back navigation when destination mounts useRouter", async ({
    page,
  }) => {
    await page.goto(`${BASE}/before-pop-state-test`);
    await page.waitForFunction(() => (window as any).__VINEXT_ROOT__);

    await expect(page.locator('[data-testid="toggle-blocking"]')).toHaveText("Blocking: OFF");

    await page.click('[data-testid="link-destination"]');
    await expect(page.locator("h1")).toHaveText("Before Pop State Destination");
    await expect(page.locator('[data-testid="destination-path"]')).toHaveText(
      "/before-pop-state-destination",
    );

    await page.goBack();
    await expect(page.locator("h1")).toHaveText("Before Pop State Test");
    await expect(page.locator('[data-testid="current-path"]')).toHaveText("/before-pop-state-test");
  });
});
