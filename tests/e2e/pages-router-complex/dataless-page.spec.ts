import { test, expect } from "@playwright/test";

/**
 * A routed page with no data-fetching function of any kind — it still
 * server-renders through the app shell's getInitialProps and hydrates into a
 * purely client-side cookie-toggling tool.
 */
test.describe("data-function-less page", () => {
  test("renders with full chrome despite having no page data function", async ({ page }) => {
    await page.goto("/detail-tools/client-flags");
    await expect(page.locator('[data-testid="client-flags"]')).toBeVisible();
    // The app-shell GIP still ran: chrome is present.
    await expect(page.locator('[data-testid="frame-masthead"]')).toBeVisible();
  });

  test.fixme("radio toggles pin and clear the backend cookie", async ({ page }) => {
    await page.goto("/detail-tools/client-flags");

    await page.getByLabel("canary").check();
    await expect(page.locator('[data-testid="pinned-backend"]')).toHaveAttribute(
      "data-pin",
      "CANARY",
    );
    expect(await page.evaluate(() => document.cookie)).toContain("ATLAS-BACKEND-PIN=CANARY");

    // Initial state is read back from the cookie on a fresh load.
    await page.reload();
    await expect(page.locator('[data-testid="pinned-backend"]')).toHaveAttribute(
      "data-pin",
      "CANARY",
    );

    await page.getByLabel("unpinned").check();
    expect(await page.evaluate(() => document.cookie)).not.toContain("ATLAS-BACKEND-PIN");
  });
});
