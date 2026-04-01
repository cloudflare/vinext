import { test, expect } from "@playwright/test";

// Hardcoded BASE URL matches the convention used in all other E2E test files in
// this directory (navigation.spec.ts, server-client-only.spec.ts, after.spec.ts,
// etc.). Port 4174 is the vite preview default for the app-basic fixture.
const BASE = "http://localhost:4174";

async function waitForHydration(page: import("@playwright/test").Page) {
  await expect(async () => {
    const ready = await page.evaluate(() => !!(window as any).__VINEXT_RSC_ROOT__);
    expect(ready).toBe(true);
  }).toPass({ timeout: 10_000 });
}

test.describe("Navigation regression tests (#652 Firefox hang fix)", () => {
  test("cross-route navigation completes without hanging", async ({ page }) => {
    await page.goto(`${BASE}/nav-flash/link-sync`);
    await waitForHydration(page);
    await expect(page.locator("#page-title")).toHaveText("All Items");

    // Set a marker to verify no full page reload
    await page.evaluate(() => {
      (window as any).__NAV_MARKER__ = true;
    });

    // Navigate to a different route (cross-route)
    await page.click("#link-list");
    await expect(page.locator("#list-title")).toHaveText("Nav Flash List", { timeout: 10_000 });

    // Verify URL changed
    expect(page.url()).toBe(`${BASE}/nav-flash/list`);

    // Verify no full page reload
    const marker = await page.evaluate(() => (window as any).__NAV_MARKER__);
    expect(marker).toBe(true);
  });

  test("same-route navigation (search param change) works", async ({ page }) => {
    await page.goto(`${BASE}/nav-flash/link-sync`);
    await waitForHydration(page);
    await expect(page.locator("#page-title")).toHaveText("All Items");

    await page.evaluate(() => {
      (window as any).__NAV_MARKER__ = true;
    });

    // Navigate within the same route (search param change)
    await page.click("#link-active");
    await expect(page.locator("#page-title")).toHaveText("Filtered: active", { timeout: 10_000 });
    expect(page.url()).toContain("filter=active");

    // Hook values should be in sync
    await expect(page.locator("#hook-filter")).toHaveText("filter: active");

    // No full page reload
    const marker = await page.evaluate(() => (window as any).__NAV_MARKER__);
    expect(marker).toBe(true);
  });

  test("back/forward navigation works after cross-route nav", async ({ page }) => {
    await page.goto(`${BASE}/nav-flash/link-sync`);
    await waitForHydration(page);
    await expect(page.locator("#page-title")).toHaveText("All Items");

    // Navigate to list page
    await page.click("#link-list");
    await expect(page.locator("#list-title")).toHaveText("Nav Flash List", { timeout: 10_000 });

    // Go back
    await page.goBack();
    await expect(page.locator("#page-title")).toHaveText("All Items", { timeout: 10_000 });
    expect(page.url()).toBe(`${BASE}/nav-flash/link-sync`);

    // Go forward
    await page.goForward();
    await expect(page.locator("#list-title")).toHaveText("Nav Flash List", { timeout: 10_000 });
    expect(page.url()).toBe(`${BASE}/nav-flash/list`);
  });

  test("rapid same-route navigation settles correctly", async ({ page }) => {
    await page.goto(`${BASE}/nav-flash/link-sync`);
    await waitForHydration(page);
    await expect(page.locator("#page-title")).toHaveText("All Items");

    // Rapidly click between filters
    await page.click("#link-active");
    await page.click("#link-completed");

    // The final state should reflect the last click
    await expect(page.locator("#page-title")).toHaveText("Filtered: completed", {
      timeout: 10_000,
    });
    expect(page.url()).toContain("filter=completed");
    await expect(page.locator("#hook-filter")).toHaveText("filter: completed");
  });

  test("cross-route then same-route navigation works", async ({ page }) => {
    await page.goto(`${BASE}/nav-flash/list`);
    await waitForHydration(page);
    await expect(page.locator("#list-title")).toHaveText("Nav Flash List");

    // Cross-route: list -> query-sync
    await page.click("#to-query-sync");
    await expect(page.locator("#query-title")).toHaveText("Search", { timeout: 10_000 });

    // Same-route: change query param
    await page.click("#link-react");
    await expect(page.locator("#query-title")).toHaveText("Search: react", { timeout: 10_000 });
    await expect(page.locator("#hook-query")).toHaveText("q: react");
    expect(page.url()).toContain("q=react");
  });

  test("usePathname reflects correct value during cross-route navigation", async ({ page }) => {
    await page.goto(`${BASE}/nav-flash/link-sync`);
    await waitForHydration(page);

    await expect(page.locator("#hook-pathname")).toHaveText("pathname: /nav-flash/link-sync");

    // Navigate to query-sync page via list
    await page.click("#link-list");
    await expect(page.locator("#list-title")).toHaveText("Nav Flash List", { timeout: 10_000 });

    // Navigate to query-sync
    await page.click("#to-query-sync");
    await expect(page.locator("#hook-pathname")).toHaveText("pathname: /nav-flash/query-sync", {
      timeout: 10_000,
    });
  });

  test("useParams reflects correct value after param change", async ({ page }) => {
    await page.goto(`${BASE}/nav-flash/param-sync/active`);
    await waitForHydration(page);

    await expect(page.locator("#param-title")).toHaveText("Filter: active");
    await expect(page.locator("#hook-params")).toHaveText("params.filter: active");

    // Navigate to different param value
    await page.click("#link-completed");
    await expect(page.locator("#param-title")).toHaveText("Filter: completed", { timeout: 10_000 });
    await expect(page.locator("#hook-params")).toHaveText("params.filter: completed");
  });

  test("navigation from home page to nav-flash routes", async ({ page }) => {
    await page.goto(`${BASE}/`);
    await waitForHydration(page);
    await expect(page.locator("h1")).toHaveText("Welcome to App Router");

    // Navigate to nav-flash test
    await page.click('[data-testid="nav-flash-link"]');
    await expect(page.locator("#page-title")).toHaveText("All Items", { timeout: 10_000 });

    // Verify the page rendered fully
    await expect(page.locator("#filter-links")).toBeVisible();
  });

  test("cross-route round trip preserves SPA state", async ({ page }) => {
    await page.goto(`${BASE}/nav-flash/link-sync`);
    await waitForHydration(page);

    await page.evaluate(() => {
      (window as any).__ROUND_TRIP_MARKER__ = "alive";
    });

    // Go to list
    await page.click("#link-list");
    await expect(page.locator("#list-title")).toHaveText("Nav Flash List", { timeout: 10_000 });

    // Come back
    await page.click("#back-to-sync");
    await expect(page.locator("#page-title")).toHaveText("All Items", { timeout: 10_000 });

    // Marker should survive (no full reload)
    const marker = await page.evaluate(() => (window as any).__ROUND_TRIP_MARKER__);
    expect(marker).toBe("alive");
  });

  test("provider page cross-route navigation between dynamic params", async ({ page }) => {
    await page.goto(`${BASE}/nav-flash/provider/1`);
    await waitForHydration(page);
    await expect(page.locator("#provider-title")).toHaveText("Provider 1");

    // Navigate to provider 2 (cross-route: different dynamic param)
    await page.click("#link-p2");
    await expect(page.locator("#provider-title")).toHaveText("Provider 2", { timeout: 10_000 });
    expect(page.url()).toBe(`${BASE}/nav-flash/provider/2`);

    // Navigate to list (different route entirely)
    await page.click("#link-list");
    await expect(page.locator("#list-title")).toHaveText("Nav Flash List", { timeout: 10_000 });
  });

  test("cancelled slow navigation does not leak params to committed route", async ({ page }) => {
    // This test verifies the fix for: stale navigation bailout leaving staged params
    // that could be committed by the next navigation.
    await page.goto(`${BASE}/nav-flash/slow-route/slow-value`);
    await waitForHydration(page);
    await expect(page.locator("#slow-param")).toHaveText("Param: slow-value");

    // Set marker to detect full page reload
    await page.evaluate(() => {
      (window as any).__CANCELLED_NAV_MARKER__ = "active";
    });

    // Verify the element exists before clicking — if the fixture is renamed,
    // we want a clear failure instead of silently skipping the superseded click.
    await expect(page.locator("#link-superseded")).toBeVisible();

    // Start a slow navigation to a different param value
    // This will be superseded before it completes
    const _slowNavPromise = page.click("#link-superseded", { timeout: 100 }).catch(() => {
      // Click may not complete if navigation is superseded — expected in this test.
      // NB: This depends on the slow-route fixture delay (500ms) being > this timeout (100ms).
      // If the fixture delay is reduced below 100ms, the click will complete normally
      // and the superseded-navigation scenario won't actually be tested.
    });

    // Immediately navigate to a different route entirely (list)
    // This should supersede the slow navigation
    await page.click("#link-list");

    // Wait for list to render
    await expect(page.locator("#list-title")).toHaveText("Nav Flash List", { timeout: 10_000 });

    // Verify we're on the list page
    expect(page.url()).toBe(`${BASE}/nav-flash/list`);

    // The list page doesn't use params, so there should be no leaked params
    // Go back to a param-sync page to verify params state is clean
    await page.click("#to-param-sync");
    await expect(page.locator("#param-title")).toHaveText("Filter: active", { timeout: 10_000 });

    // Verify the param reflects the route we navigated to, not the cancelled one
    await expect(page.locator("#hook-params")).toHaveText("params.filter: active");

    // No full page reload occurred
    const marker = await page.evaluate(() => (window as any).__CANCELLED_NAV_MARKER__);
    expect(marker).toBe("active");
  });
});
