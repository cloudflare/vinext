import { test, expect } from "@playwright/test";

/**
 * Standalone output E2E tests.
 *
 * These tests run against `vinext build` output with `output: "standalone"`,
 * started via `node dist/standalone/server.js`. The production server runs
 * on port 4182 via the webServer config in playwright.config.ts.
 */
const BASE = "http://localhost:4182";

test.describe("Standalone Output", () => {
  test("index page renders with correct content", async ({ page }) => {
    const response = await page.goto(`${BASE}/`);
    expect(response?.status()).toBe(200);
    await expect(page.locator("h1")).toHaveText("Hello, standalone!");
    await expect(page.locator("body")).toContainText("output: standalone mode");
  });

  test("about page renders", async ({ page }) => {
    const response = await page.goto(`${BASE}/about`);
    expect(response?.status()).toBe(200);
    await expect(page.locator("h1")).toHaveText("About Standalone");
  });

  test("navigation via Link works", async ({ page }) => {
    await page.goto(`${BASE}/`);
    await expect(page.locator("h1")).toHaveText("Hello, standalone!");

    await page.click('a[href="/about"]');
    await expect(page.locator("h1")).toHaveText("About Standalone");
    expect(page.url()).toBe(`${BASE}/about`);

    await page.click('a[href="/"]');
    await expect(page.locator("h1")).toHaveText("Hello, standalone!");
    expect(page.url()).toBe(`${BASE}/`);
  });

  test("browser back button works", async ({ page }) => {
    await page.goto(`${BASE}/`);
    await page.click('a[href="/about"]');
    await expect(page.locator("h1")).toHaveText("About Standalone");

    await page.goBack();
    await expect(page.locator("h1")).toHaveText("Hello, standalone!");
  });

  test("API route returns JSON", async ({ request }) => {
    const response = await request.get(`${BASE}/api/hello`);
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("application/json");
    const data = await response.json();
    expect(data).toEqual({ message: "Hello from standalone API!" });
  });

  test("404 page for non-existent route", async ({ page }) => {
    const response = await page.goto(`${BASE}/nonexistent`);
    expect(response?.status()).toBe(404);
  });

  test("prod server responds with HTTP 200", async ({ page }) => {
    const response = await page.goto(`${BASE}/`);
    expect(response?.status()).toBe(200);
  });
});
