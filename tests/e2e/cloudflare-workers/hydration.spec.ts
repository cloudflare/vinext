import { test, expect } from "../fixtures";

const BASE = "http://localhost:4176";

test.describe("Cloudflare Workers Hydration", () => {
  // The consoleErrors fixture automatically fails tests if any console errors occur.
  // This catches React hydration mismatches (error #418), runtime errors, etc.

  test("client component hydrates and becomes interactive", async ({ page, consoleErrors }) => {
    await page.goto(`${BASE}/`);

    // SSR should show initial count
    await expect(page.locator('[data-testid="count"]')).toHaveText("Count: 0");

    // After hydration, clicking should work
    await page.click('[data-testid="increment"]');
    await expect(page.locator('[data-testid="count"]')).toHaveText("Count: 1");

    await page.click('[data-testid="increment"]');
    await expect(page.locator('[data-testid="count"]')).toHaveText("Count: 2");

    void consoleErrors;
  });

  test("page with timestamp hydrates without mismatch", async ({ page, consoleErrors }) => {
    // This test specifically verifies the fix for GitHub issue #61.
    // The home page has a timestamp that would cause hydration mismatch
    // if the browser fetched a new RSC payload instead of using embedded data.
    await page.goto(`${BASE}/`);

    // Wait for the client JS bundle to load and hydrate
    await page.waitForFunction(() => document.querySelector('[data-testid="increment"]') !== null);

    // Verify hydration completes and component becomes interactive
    await page.click('[data-testid="increment"]');
    await expect(page.locator('[data-testid="count"]')).toHaveText("Count: 1");

    // The timestamp element should exist and have content
    await expect(page.locator('[data-testid="timestamp"]')).toContainText("Rendered at:");

    // consoleErrors fixture will fail this test if any hydration errors occurred
    void consoleErrors;
  });
});
