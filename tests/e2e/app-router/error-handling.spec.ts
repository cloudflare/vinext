import { test, expect } from "@playwright/test";

const BASE = "http://localhost:4174";

test.describe("Error Boundaries", () => {
  test("error.tsx catches client component error on button click", async ({ page }) => {
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

  test("error.tsx catches falsy values thrown by client components", async ({ page }) => {
    // Ported from Next.js: test/e2e/app-dir/errors/index.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/errors/index.test.ts
    const cases = [
      ["undefined", "undefined"],
      ["null", "null"],
      ["zero", "0"],
      ["empty-string", ""],
      ["false", "false"],
    ] satisfies readonly (readonly [string, string])[];

    for (const [name, expectedText] of cases) {
      await page.goto(`${BASE}/falsy-error-boundary-test`);
      await expect(page.locator('[data-testid="falsy-error-content"]')).toBeVisible();
      const trigger = page.locator(`[data-testid="throw-${name}"]`);
      await expect(trigger).toBeEnabled();
      await trigger.click();
      await expect(page.locator('[data-testid="falsy-error-boundary"]')).toBeVisible({
        timeout: 5000,
      });
      await expect(page.locator('[data-testid="falsy-error-message"]')).toHaveText(expectedText);
    }
  });

  test("server component error renders error.tsx boundary with 200", async ({ page }) => {
    const response = await page.goto(`${BASE}/error-server-test`);
    // Next.js returns 200 when error.tsx catches an error (it's "handled")
    expect(response?.status()).toBe(200);
    await expect(page.locator('[data-testid="server-error-boundary"]')).toBeVisible();
    await expect(page.locator('[data-testid="server-error-message"]')).toContainText(
      "Server component error",
    );
  });

  test("nested server component error renders child error.tsx boundary", async ({ page }) => {
    const response = await page.goto(`${BASE}/error-nested-test/child`);
    expect(response?.status()).toBe(200);
    // Should render the child's error.tsx, not the parent's
    await expect(page.locator('[data-testid="inner-error-boundary"]')).toBeVisible();
    await expect(page.locator('[data-testid="inner-error-message"]')).toContainText(
      "Nested child error",
    );
  });

  test("parent route without error renders normally", async ({ page }) => {
    await page.goto(`${BASE}/error-nested-test`);

    await expect(page.locator('[data-testid="error-nested-page"]')).toBeVisible();
    await expect(page.locator('[data-testid="outer-error-boundary"]')).not.toBeVisible();
    await expect(page.locator('[data-testid="inner-error-boundary"]')).not.toBeVisible();
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
