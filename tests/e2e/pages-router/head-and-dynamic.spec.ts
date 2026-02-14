import { test, expect } from "@playwright/test";

const BASE = "http://localhost:4173";

test.describe("next/head client-side updates", () => {
  test("title changes when navigating between pages", async ({ page }) => {
    await page.goto(`${BASE}/`);
    await expect(page).toHaveTitle("Hello vinext");

    // Navigate to about page — title should change
    await page.click('a[href="/about"]');
    await expect(page.locator("h1")).toHaveText("About");
    // After client navigation, the head shim should update document.title
    await expect(page).toHaveTitle("About - vinext");
  });

  test("title is correct on SSR (no JS)", async ({ page }) => {
    // Disable JS — verify the title comes from SSR
    await page.route("**/*.js", (route) => route.abort());
    await page.goto(`${BASE}/`);
    await expect(page).toHaveTitle("Hello vinext");
  });

  test("meta tags are present in SSR head", async ({ page }) => {
    await page.goto(`${BASE}/`);

    // These come from _document or _app or the page itself
    const charset = await page.locator('meta[charSet="utf-8"]').count();
    expect(charset).toBeGreaterThan(0);
  });
});

test.describe("next/dynamic", () => {
  test("dynamically imported component renders on SSR", async ({ page }) => {
    // Disable JS — verify SSR includes the dynamic component
    await page.route("**/*.js", (route) => route.abort());
    await page.goto(`${BASE}/dynamic-page`);

    await expect(page.locator("h1")).toHaveText("Dynamic Import Page");
    // The heavy component should be SSR-rendered (ssr: true by default)
    await expect(page.locator("text=Heavy Component")).toBeVisible();
  });

  test("dynamically imported component is interactive after hydration", async ({ page }) => {
    await page.goto(`${BASE}/dynamic-page`);

    await expect(page.locator("h1")).toHaveText("Dynamic Import Page");
    await expect(page.locator("text=Heavy Component")).toBeVisible();
    await expect(page.locator("text=Loaded dynamically")).toBeVisible();
  });
});
