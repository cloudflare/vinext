import { test, expect } from "@playwright/test";

const BASE = "http://localhost:4173";

test.describe("next/dynamic with ssr: false (Pages Router)", () => {
  test("SSR HTML does not contain client-only component content", async ({ page }) => {
    // Disable JavaScript so we see only SSR HTML
    await page.route("**/*.js", (route) => route.abort());

    await page.goto(`${BASE}/dynamic-ssr-false`);

    // The page title should be SSR'd
    await expect(page.locator("h1")).toHaveText("Dynamic SSR False Test");

    // The client-only component should NOT be in the SSR HTML
    const clientOnly = page.locator('[data-testid="client-only"]');
    await expect(clientOnly).toHaveCount(0);
  });

  test("loading component is shown in SSR HTML when provided", async ({ page }) => {
    // Disable JavaScript so we see only SSR HTML
    await page.route("**/*.js", (route) => route.abort());

    await page.goto(`${BASE}/dynamic-ssr-false`);

    // The loading placeholder should be rendered in SSR for the component with loading prop
    const loading = page.locator('[data-testid="loading"]');
    await expect(loading).toBeVisible();
    await expect(loading).toHaveText("Loading client component...");
  });

  test("client-only component appears after hydration", async ({ page }) => {
    await page.goto(`${BASE}/dynamic-ssr-false`);

    // Wait for hydration
    await page.waitForFunction(() => (window as any).__VINEXT_ROOT__);

    // The client-only component should now be visible in both containers
    const withLoading = page.locator('[data-testid="with-loading"] [data-testid="client-only"]');
    await expect(withLoading).toBeVisible();

    const withoutLoading = page.locator(
      '[data-testid="without-loading"] [data-testid="client-only"]',
    );
    await expect(withoutLoading).toBeVisible();

    // Loading placeholder should be gone
    const loading = page.locator('[data-testid="loading"]');
    await expect(loading).toHaveCount(0);
  });

  test("client-only component is interactive after hydration", async ({ page }) => {
    await page.goto(`${BASE}/dynamic-ssr-false`);
    await page.waitForFunction(() => (window as any).__VINEXT_ROOT__);

    // Find the first counter button
    const counter = page
      .locator('[data-testid="with-loading"]')
      .locator('[data-testid="client-counter"]');
    await expect(counter).toHaveText("Count: 0");

    await counter.click();
    await expect(counter).toHaveText("Count: 1");

    await counter.click();
    await expect(counter).toHaveText("Count: 2");
  });
});
