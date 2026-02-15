import { test, expect } from "@playwright/test";

const BASE = "http://localhost:4174";

test.describe("Error Boundaries", () => {
  test("error.tsx catches client component error on button click", async ({
    page,
  }) => {
    await page.goto(`${BASE}/error-test`);

    // Page renders normally first
    await expect(page.locator('[data-testid="error-content"]')).toBeVisible();

    // Wait for hydration — the button must be interactive
    const button = page.locator('[data-testid="trigger-error"]');
    await expect(button).toBeVisible();
    await page.waitForTimeout(1000); // Give React time to hydrate

    // Click the button that triggers an error
    await button.click();

    // Error boundary should render
    await expect(page.locator("#error-boundary")).toBeVisible({
      timeout: 5000,
    });
    await expect(page.locator("#error-boundary p")).toContainText(
      "Test error from client component",
    );
  });

  test("error.tsx renders reset button", async ({ page }) => {
    await page.goto(`${BASE}/error-test`);

    const button = page.locator('[data-testid="trigger-error"]');
    await expect(button).toBeVisible();
    await page.waitForTimeout(1000);

    // Trigger error
    await button.click();

    // Error boundary shows reset button
    await expect(page.locator("#error-boundary")).toBeVisible({
      timeout: 5000,
    });
    const resetButton = page.locator("#error-boundary button");
    await expect(resetButton).toHaveText("Try again");
  });

  // NOTE: Server component errors currently return 500 because RSC rendering
  // errors propagate past "use client" error boundaries (they only run in SSR/client).
  // This is a known gap — Next.js handles this with custom RSC error injection.
  // TODO: Implement RSC-level error catching so error.tsx works for server errors.
  test("server component error returns 500", async ({ page }) => {
    const response = await page.goto(`${BASE}/error-server-test`);
    // Currently returns 500 — when RSC error boundaries are implemented,
    // this should be 200 with the error boundary rendered.
    expect(response?.status()).toBe(500);
  });

  test("nested server component error returns 500", async ({ page }) => {
    const response = await page.goto(`${BASE}/error-nested-test/child`);
    expect(response?.status()).toBe(500);
  });

  test("parent route without error renders normally", async ({ page }) => {
    await page.goto(`${BASE}/error-nested-test`);

    await expect(
      page.locator('[data-testid="error-nested-page"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="outer-error-boundary"]'),
    ).not.toBeVisible();
    await expect(
      page.locator('[data-testid="inner-error-boundary"]'),
    ).not.toBeVisible();
  });
});

test.describe("Not Found", () => {
  test("unknown route returns 404", async ({ page }) => {
    const response = await page.goto(`${BASE}/this-route-does-not-exist`);
    expect(response?.status()).toBe(404);
  });

  test("notFound() renders custom not-found.tsx", async ({ page }) => {
    await page.goto(`${BASE}/notfound-test`);
    // The notfound-test page calls notFound() unconditionally
    const response = await page.goto(`${BASE}/notfound-test`);
    expect(response?.status()).toBe(404);
    await expect(page.locator("h1")).toContainText("404");
  });
});

test.describe("Forbidden & Unauthorized", () => {
  test("forbidden() returns 403 status", async ({ page }) => {
    const response = await page.goto(`${BASE}/forbidden-test`);
    expect(response?.status()).toBe(403);
  });

  test("unauthorized() returns 401 status", async ({ page }) => {
    const response = await page.goto(`${BASE}/unauthorized-test`);
    expect(response?.status()).toBe(401);
  });
});
