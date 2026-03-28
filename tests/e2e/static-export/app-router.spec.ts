import { test, expect } from "@playwright/test";

/**
 * Static export E2E tests for the App Router.
 *
 * These tests run against a `vinext build` output served as static files.
 * The static export fixture uses `output: "export"` in next.config.mjs,
 * so no server-side rendering is involved — all pages are pre-rendered
 * HTML files served by a lightweight HTTP server on port 4180.
 */
const BASE = "http://localhost:4180";

test.describe("Static Export — App Router", () => {
  test("home page renders with correct content", async ({ page }) => {
    const response = await page.goto(`${BASE}/`);
    expect(response?.status()).toBe(200);
    await expect(page.locator("h1")).toHaveText("Static Export — App Router");
    await expect(page.locator("body")).toContainText(
      "This page is pre-rendered at build time by the App Router.",
    );
  });

  test("about page renders", async ({ page }) => {
    const response = await page.goto(`${BASE}/about`);
    expect(response?.status()).toBe(200);
    await expect(page.locator("h1")).toHaveText("About");
    await expect(page.locator("body")).toContainText(
      "A static App Router page with no dynamic data.",
    );
  });

  test("blog/hello-world renders", async ({ page }) => {
    const response = await page.goto(`${BASE}/blog/hello-world`);
    expect(response?.status()).toBe(200);
    await expect(page.locator("h1")).toHaveText("Blog Post");
    await expect(page.locator("body")).toContainText("Slug: hello-world");
  });

  test("blog/getting-started renders", async ({ page }) => {
    const response = await page.goto(`${BASE}/blog/getting-started`);
    expect(response?.status()).toBe(200);
    await expect(page.locator("h1")).toHaveText("Blog Post");
    await expect(page.locator("body")).toContainText("Slug: getting-started");
  });

  test("blog/advanced-guide renders", async ({ page }) => {
    const response = await page.goto(`${BASE}/blog/advanced-guide`);
    expect(response?.status()).toBe(200);
    await expect(page.locator("h1")).toHaveText("Blog Post");
    await expect(page.locator("body")).toContainText("Slug: advanced-guide");
  });

  test("blog page includes dynamic metadata in title", async ({ page }) => {
    await page.goto(`${BASE}/blog/hello-world`);
    await expect(page).toHaveTitle("Blog: hello-world");
  });

  test("home page navigation links are present", async ({ page }) => {
    await page.goto(`${BASE}/`);
    const nav = page.locator("nav");
    await expect(nav.locator('a[href="/about"]')).toBeVisible();
    await expect(nav.locator('a[href="/blog/hello-world"]')).toBeVisible();
    await expect(nav.locator('a[href="/blog/getting-started"]')).toBeVisible();
    await expect(nav.locator('a[href="/old-school"]')).toBeVisible();
    await expect(nav.locator('a[href="/products/widget"]')).toBeVisible();
  });

  test("client-side navigation works between pages", async ({ page }) => {
    await page.goto(`${BASE}/`);
    await page.locator('a[href="/about"]').click();
    await page.waitForURL(`${BASE}/about`);
    await expect(page.locator("h1")).toHaveText("About");
  });

  test("root layout metadata is applied", async ({ page }) => {
    await page.goto(`${BASE}/`);
    await expect(page).toHaveTitle("Static Export Fixture");
  });

  test("404 page for non-existent route", async ({ page }) => {
    const response = await page.goto(`${BASE}/nonexistent-page`);
    expect(response?.status()).toBe(404);
  });
});
