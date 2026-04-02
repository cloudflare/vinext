import { test, expect } from "@playwright/test";

const BASE = "http://localhost:4174";

/**
 * Wait for the RSC browser entry to hydrate.
 */
async function waitForHydration(page: import("@playwright/test").Page) {
  await expect(async () => {
    const ready = await page.evaluate(() => "__VINEXT_RSC_ROOT__" in window);
    expect(ready).toBe(true);
  }).toPass({ timeout: 10_000 });
}

// ---------------------------------------------------------------------------
// 1. Layout persistence — navigate between sibling routes, prove the layout
//    DOM survives and client state in it persists.
// ---------------------------------------------------------------------------

test.describe("Layout persistence", () => {
  test("dashboard layout counter survives sibling navigation", async ({ page }) => {
    await page.goto(`${BASE}/dashboard`);
    await expect(page.locator("h1")).toHaveText("Dashboard");
    await waitForHydration(page);

    // Increment the counter in the dashboard layout
    await page.click('[data-testid="layout-increment"]');
    await page.click('[data-testid="layout-increment"]');
    await page.click('[data-testid="layout-increment"]');
    await expect(page.locator('[data-testid="layout-count"]')).toHaveText("Layout count: 3");

    // Navigate to settings (sibling route under same layout)
    await page.click('[data-testid="dash-settings-link"]');
    await expect(page.locator("h1")).toHaveText("Settings");

    // Layout counter should still be 3 — the layout was NOT remounted
    await expect(page.locator('[data-testid="layout-count"]')).toHaveText("Layout count: 3");

    // Navigate back to dashboard home
    await page.click('[data-testid="dash-home-link"]');
    await expect(page.locator("h1")).toHaveText("Dashboard");

    // Counter should still be 3
    await expect(page.locator('[data-testid="layout-count"]')).toHaveText("Layout count: 3");
  });

  test("layout counter resets on hard navigation", async ({ page }) => {
    await page.goto(`${BASE}/dashboard`);
    await waitForHydration(page);

    // Increment counter
    await page.click('[data-testid="layout-increment"]');
    await expect(page.locator('[data-testid="layout-count"]')).toHaveText("Layout count: 1");

    // Hard navigation (full page load) should reset everything
    await page.goto(`${BASE}/dashboard`);
    await waitForHydration(page);

    await expect(page.locator('[data-testid="layout-count"]')).toHaveText("Layout count: 0");
  });
});

// ---------------------------------------------------------------------------
// 2. Template remount — prove template state resets on segment boundary
//    change but persists on search param change.
// ---------------------------------------------------------------------------

test.describe("Template remount", () => {
  test("root template counter resets when navigating between top-level segments", async ({
    page,
  }) => {
    await page.goto(`${BASE}/`);
    await expect(page.locator("h1")).toHaveText("Welcome to App Router");
    await waitForHydration(page);

    // Increment the template counter
    await page.click('[data-testid="template-increment"]');
    await page.click('[data-testid="template-increment"]');
    await expect(page.locator('[data-testid="template-count"]')).toHaveText("Template count: 2");

    // Navigate to /about — this changes the root segment from "" to "about",
    // so the root template should remount and the counter should reset.
    await page.click('a[href="/about"]');
    await expect(page.locator("h1")).toHaveText("About");

    await expect(page.locator('[data-testid="template-count"]')).toHaveText("Template count: 0");
  });

  test("root template counter persists within same top-level segment", async ({ page }) => {
    await page.goto(`${BASE}/dashboard`);
    await expect(page.locator("h1")).toHaveText("Dashboard");
    await waitForHydration(page);

    // Increment the template counter
    await page.click('[data-testid="template-increment"]');
    await page.click('[data-testid="template-increment"]');
    await expect(page.locator('[data-testid="template-count"]')).toHaveText("Template count: 2");

    // Navigate to /dashboard/settings — this is still under the "dashboard"
    // top-level segment, so the root template should NOT remount.
    await page.click('[data-testid="dash-settings-link"]');
    await expect(page.locator("h1")).toHaveText("Settings");

    await expect(page.locator('[data-testid="template-count"]')).toHaveText("Template count: 2");
  });
});

// ---------------------------------------------------------------------------
// 3. Error recovery — trigger an error, navigate away via client nav,
//    navigate back, prove the error is gone and normal content renders.
// ---------------------------------------------------------------------------

test.describe("Error recovery across navigation", () => {
  test("navigating away from error and back clears the error", async ({ page }) => {
    await page.goto(`${BASE}/error-test`);
    await expect(page.locator('[data-testid="error-content"]')).toBeVisible();
    await waitForHydration(page);

    // Trigger error
    await expect(async () => {
      await page.click('[data-testid="trigger-error"]');
      await expect(page.locator("#error-boundary")).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 15_000 });

    // Error boundary should be visible
    await expect(page.locator("#error-boundary")).toBeVisible();

    // Client-navigate away to home via the link in the error boundary
    await page.click('[data-testid="error-go-home"]');
    await expect(page.locator("h1")).toHaveText("Welcome to App Router");

    // Client-navigate back to error-test via link on home page
    await page.click('[data-testid="error-test-link"]');

    // Error should be gone — fresh page renders normally
    await expect(page.locator('[data-testid="error-content"]')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator("#error-boundary")).not.toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// 4. Back/forward — navigate through a sequence, go back, prove layout
//    state survived the round trip.
// ---------------------------------------------------------------------------

test.describe("Back/forward with layout state", () => {
  test("browser back preserves layout counter across navigation history", async ({ page }) => {
    await page.goto(`${BASE}/dashboard`);
    await expect(page.locator("h1")).toHaveText("Dashboard");
    await waitForHydration(page);

    // Increment layout counter to 2
    await page.click('[data-testid="layout-increment"]');
    await page.click('[data-testid="layout-increment"]');
    await expect(page.locator('[data-testid="layout-count"]')).toHaveText("Layout count: 2");

    // Navigate: dashboard → settings
    await page.click('[data-testid="dash-settings-link"]');
    await expect(page.locator("h1")).toHaveText("Settings");

    // Counter should still be 2 (layout persisted)
    await expect(page.locator('[data-testid="layout-count"]')).toHaveText("Layout count: 2");

    // Increment once more while on settings
    await page.click('[data-testid="layout-increment"]');
    await expect(page.locator('[data-testid="layout-count"]')).toHaveText("Layout count: 3");

    // Go back to dashboard
    await page.goBack();
    await expect(page.locator("h1")).toHaveText("Dashboard");

    // Counter should still be 3 — back/forward doesn't remount the layout
    await expect(page.locator('[data-testid="layout-count"]')).toHaveText("Layout count: 3");

    // Go forward to settings
    await page.goForward();
    await expect(page.locator("h1")).toHaveText("Settings");

    // Counter should still be 3
    await expect(page.locator('[data-testid="layout-count"]')).toHaveText("Layout count: 3");
  });
});

// ---------------------------------------------------------------------------
// 5. Parallel slots — soft nav keeps slot content; hard load shows default.
// ---------------------------------------------------------------------------

test.describe("Parallel slot persistence", () => {
  test("parallel slot content persists on soft navigation to child route", async ({ page }) => {
    // Load /dashboard — parallel slots @team and @analytics have page.tsx
    await page.goto(`${BASE}/dashboard`);
    await expect(page.locator("h1")).toHaveText("Dashboard");
    await waitForHydration(page);

    // Verify slot content is visible
    await expect(page.locator('[data-testid="team-panel"]')).toBeVisible();
    await expect(page.locator('[data-testid="analytics-panel"]')).toBeVisible();
    await expect(page.locator('[data-testid="team-slot"]')).toBeVisible();
    await expect(page.locator('[data-testid="analytics-slot"]')).toBeVisible();

    // Soft navigate to /dashboard/settings
    await page.click('[data-testid="dash-settings-link"]');
    await expect(page.locator("h1")).toHaveText("Settings");

    // Parallel slot content should persist from the soft nav —
    // the slots don't have a page.tsx for /settings, so the previous
    // slot content is retained (absent key = persisted from prior soft nav).
    await expect(page.locator('[data-testid="team-panel"]')).toBeVisible();
    await expect(page.locator('[data-testid="analytics-panel"]')).toBeVisible();
  });

  test("parallel slots show default.tsx on hard navigation to child route", async ({ page }) => {
    // Hard-load /dashboard/settings directly — slots should show default.tsx
    await page.goto(`${BASE}/dashboard/settings`);
    await expect(page.locator("h1")).toHaveText("Settings");
    await waitForHydration(page);

    // On hard load, slots should render their default.tsx content
    await expect(page.locator('[data-testid="team-panel"]')).toBeVisible();
    await expect(page.locator('[data-testid="analytics-panel"]')).toBeVisible();
    await expect(page.locator('[data-testid="team-default"]')).toBeVisible();
    await expect(page.locator('[data-testid="analytics-default"]')).toBeVisible();

    // The page-specific slot content should NOT be visible
    await expect(page.locator('[data-testid="team-slot"]')).not.toBeVisible();
    await expect(page.locator('[data-testid="analytics-slot"]')).not.toBeVisible();
  });
});
