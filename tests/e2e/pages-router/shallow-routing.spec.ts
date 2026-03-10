import { test, expect } from "@playwright/test";

const BASE = "http://localhost:4173";

/**
 * Wait for the Pages Router to hydrate (the __VINEXT_ROOT__ is set).
 */
async function waitForHydration(page: import("@playwright/test").Page) {
  await expect(async () => {
    const ready = await page.evaluate(() => !!(window as any).__VINEXT_ROOT__);
    expect(ready).toBe(true);
  }).toPass({ timeout: 10_000 });
}

test.describe("Shallow routing (Pages Router)", () => {
  test("shallow push updates URL without refetching GSSP", async ({ page }) => {
    await page.goto(`${BASE}/shallow-test`);
    await expect(page.locator("h1")).toHaveText("Shallow Routing Test");
    await waitForHydration(page);

    // Record the initial GSSP call ID
    const initialCallId = await page.locator('[data-testid="gssp-call-id"]').textContent();
    expect(initialCallId).toMatch(/^gssp:\d+$/);

    // Set marker to detect full page reload
    await page.evaluate(() => {
      (window as any).__SHALLOW_MARKER__ = true;
    });

    // Click the shallow push button
    await page.click('[data-testid="shallow-push"]');

    // URL should update
    await expect(page).toHaveURL(`${BASE}/shallow-test?tab=settings`);

    // GSSP call ID should NOT change (no server re-fetch)
    const afterCallId = await page.locator('[data-testid="gssp-call-id"]').textContent();
    expect(afterCallId).toBe(initialCallId);

    // router.query should reflect the new query params
    const routerQuery = await page.locator('[data-testid="router-query"]').textContent();
    expect(JSON.parse(routerQuery!)).toEqual({ tab: "settings" });

    // No full page reload
    const marker = await page.evaluate(() => (window as any).__SHALLOW_MARKER__);
    expect(marker).toBe(true);
  });

  test("deep push (non-shallow) refetches GSSP", async ({ page }) => {
    await page.goto(`${BASE}/shallow-test`);
    await expect(page.locator("h1")).toHaveText("Shallow Routing Test");
    await waitForHydration(page);

    const initialCallId = await page.locator('[data-testid="gssp-call-id"]').textContent();

    // Click the deep push button (no shallow option)
    await page.click('[data-testid="deep-push"]');

    // URL should update
    await expect(page).toHaveURL(`${BASE}/shallow-test?tab=profile`);

    // GSSP call ID SHOULD change (server re-fetch occurred)
    await expect(async () => {
      const afterCallId = await page.locator('[data-testid="gssp-call-id"]').textContent();
      expect(afterCallId).not.toBe(initialCallId);
    }).toPass({ timeout: 5_000 });
  });

  test("shallow replace updates URL without adding history entry", async ({ page }) => {
    await page.goto(`${BASE}/shallow-test`);
    await expect(page.locator("h1")).toHaveText("Shallow Routing Test");
    await waitForHydration(page);

    const initialCallId = await page.locator('[data-testid="gssp-call-id"]').textContent();

    await page.evaluate(() => {
      (window as any).__SHALLOW_MARKER__ = true;
    });

    // Click shallow replace
    await page.click('[data-testid="shallow-replace"]');

    // URL should update
    await expect(page).toHaveURL(`${BASE}/shallow-test?view=grid`);

    // GSSP call ID should NOT change
    const afterCallId = await page.locator('[data-testid="gssp-call-id"]').textContent();
    expect(afterCallId).toBe(initialCallId);

    // router.query should update
    const routerQuery = await page.locator('[data-testid="router-query"]').textContent();
    expect(JSON.parse(routerQuery!)).toEqual({ view: "grid" });

    // No full page reload
    const marker = await page.evaluate(() => (window as any).__SHALLOW_MARKER__);
    expect(marker).toBe(true);

    // Going back should go to the page BEFORE shallow-test (not the pre-replace state)
    // because replaceState doesn't add a history entry
    await page.goBack();
    // Should have left shallow-test entirely
    await expect(page).not.toHaveURL(/shallow-test/);
  });

  test("shallow push followed by deep push re-fetches with current query", async ({ page }) => {
    await page.goto(`${BASE}/shallow-test`);
    await expect(page.locator("h1")).toHaveText("Shallow Routing Test");
    await waitForHydration(page);

    const initialCallId = await page.locator('[data-testid="gssp-call-id"]').textContent();

    // Shallow push first
    await page.click('[data-testid="shallow-push"]');
    await expect(page).toHaveURL(`${BASE}/shallow-test?tab=settings`);

    // GSSP unchanged after shallow
    const afterShallowCallId = await page.locator('[data-testid="gssp-call-id"]').textContent();
    expect(afterShallowCallId).toBe(initialCallId);

    // Now do a deep push
    await page.click('[data-testid="deep-push"]');
    await expect(page).toHaveURL(`${BASE}/shallow-test?tab=profile`);

    // GSSP should now have been called again
    await expect(async () => {
      const afterDeepCallId = await page.locator('[data-testid="gssp-call-id"]').textContent();
      expect(afterDeepCallId).not.toBe(initialCallId);
    }).toPass({ timeout: 5_000 });
  });

  test("router.asPath updates on shallow push", async ({ page }) => {
    await page.goto(`${BASE}/shallow-test`);
    await expect(page.locator("h1")).toHaveText("Shallow Routing Test");
    await waitForHydration(page);

    // Initial asPath
    const initialAsPath = await page.locator('[data-testid="router-asPath"]').textContent();
    expect(initialAsPath).toBe("/shallow-test");

    // Shallow push
    await page.click('[data-testid="shallow-push"]');

    // asPath should update to include query
    await expect(page.locator('[data-testid="router-asPath"]')).toHaveText(
      "/shallow-test?tab=settings",
    );
  });
});
