import { test, expect } from "@playwright/test";

const BASE = "http://localhost:4176";

test.describe("Cloudflare Workers Hydration", () => {
  test("client component hydrates and becomes interactive", async ({
    page,
  }) => {
    await page.goto(`${BASE}/`);

    // SSR should show initial count
    await expect(page.locator('[data-testid="count"]')).toHaveText("Count: 0");

    // After hydration, clicking should work
    await page.click('[data-testid="increment"]');
    await expect(page.locator('[data-testid="count"]')).toHaveText("Count: 1");

    await page.click('[data-testid="increment"]');
    await expect(page.locator('[data-testid="count"]')).toHaveText("Count: 2");
  });

  test("no hydration mismatch errors in console", async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        errors.push(msg.text());
      }
    });

    await page.goto(`${BASE}/`);
    // Wait for the client JS bundle to load and hydrate
    await page.waitForFunction(
      () => document.querySelector('[data-testid="increment"]') !== null,
    );
    // Give hydration a moment to complete
    await page.waitForTimeout(500);
    await page.click('[data-testid="increment"]');
    await expect(page.locator('[data-testid="count"]')).toHaveText("Count: 1");

    // Filter for hydration-specific errors
    const hydrationErrors = errors.filter(
      (e) =>
        e.includes("Hydration") ||
        e.includes("hydrat") ||
        e.includes("did not match"),
    );
    expect(hydrationErrors).toHaveLength(0);
  });
});
