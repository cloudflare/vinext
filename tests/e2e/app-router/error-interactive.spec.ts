import { test, expect } from "@playwright/test";
import { disableDevErrorOverlay } from "../helpers";

const BASE = "http://localhost:4174";

/**
 * Trigger an error by clicking the button, using polling to handle hydration timing.
 */
async function triggerError(page: import("@playwright/test").Page) {
  await disableDevErrorOverlay(page);

  await expect(page.locator('[data-testid="trigger-error"]')).toBeVisible({
    timeout: 10_000,
  });

  await expect(async () => {
    await page.locator('[data-testid="trigger-error"]').click({ noWaitAfter: true });
    await expect(page.locator("#error-boundary")).toBeVisible({
      timeout: 10_000,
    });
  }).toPass({ timeout: 20_000 });
}

test.describe("Error boundary interactive behavior", () => {
  test("clicking Try Again resets the error boundary", async ({ page }) => {
    await page.goto(`${BASE}/error-test`);
    await expect(page.locator('[data-testid="error-content"]')).toBeVisible();

    // Trigger error (polls until button is interactive)
    await triggerError(page);
    await expect(page.locator("#error-boundary p")).toContainText(
      "Test error from client component",
    );

    // Click "Try again" — should reset the error boundary and re-render the page
    await page.click("#error-boundary button");

    await disableDevErrorOverlay(page);

    await expect(page.locator("#error-boundary")).not.toBeVisible({
      timeout: 10_000,
    });

    // The page content should re-appear (component remounts with shouldThrow=false)
    await expect(page.locator('[data-testid="error-content"]')).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.locator('[data-testid="trigger-error"]')).toBeVisible();
  });

  test("can trigger error again after reset", async ({ page }) => {
    await page.goto(`${BASE}/error-test`);
    await expect(page.locator('[data-testid="error-content"]')).toBeVisible();

    // First error cycle
    await triggerError(page);

    // Reset
    await page.click("#error-boundary button");
    await expect(page.locator('[data-testid="trigger-error"]')).toBeVisible({
      timeout: 10_000,
    });

    // Second error cycle — should work the same
    await triggerError(page);
    await expect(page.locator("#error-boundary p")).toContainText(
      "Test error from client component",
    );
  });

  test("error boundary catches error without crashing the page", async ({ page }) => {
    await page.goto(`${BASE}/error-test`);
    await expect(page.locator('[data-testid="error-content"]')).toBeVisible();

    // Trigger the error
    await triggerError(page);

    // The page should still be functional (not a white screen)
    // Root layout should still be present
    await expect(page.locator("html")).toBeVisible();
    await expect(page.locator("body")).toBeVisible();
  });

  test("navigating away from error page works", async ({ page }) => {
    await page.goto(`${BASE}/error-test`);
    await expect(page.locator('[data-testid="error-content"]')).toBeVisible();

    // Trigger error
    await triggerError(page);

    // Navigate to home
    await page.goto(`${BASE}/`);
    await expect(page.locator("h1")).toHaveText("Welcome to App Router");
  });
});
