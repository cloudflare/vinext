import { test, expect } from "@playwright/test";

const BASE = "http://localhost:4174";

test.describe("Route segment configs", () => {
  test("force-static page renders", async ({ page }) => {
    const response = await page.goto(`${BASE}/static-test`);
    expect(response?.status()).toBe(200);
    await expect(page.locator("h1")).toHaveText("Force Static Page");
    await expect(page.locator('[data-testid="timestamp"]')).not.toBeEmpty();
  });

  test("config-test page renders with all configs recognized", async ({ page }) => {
    const response = await page.goto(`${BASE}/config-test`);
    expect(response?.status()).toBe(200);
    await expect(page.locator("h1")).toHaveText("Config Test Page");
    await expect(page.locator("p")).toContainText("All route segment configs");
  });

  test("revalidate-test page renders with ISR config", async ({ page }) => {
    const response = await page.goto(`${BASE}/revalidate-test`);
    expect(response?.status()).toBe(200);
    await expect(page.locator("h1")).toHaveText("ISR Revalidate Page");
    await expect(page.locator('[data-testid="timestamp"]')).not.toBeEmpty();
  });
});
