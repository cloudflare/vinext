import { test, expect } from "@playwright/test";
import { waitForAppRouterHydration } from "../helpers";

/**
 * Static export E2E tests for the App Router.
 *
 * These tests run against a `vinext build` output served as static files.
 * The static export fixture uses `output: "export"` in next.config.mjs,
 * so no server-side rendering is involved — all pages are pre-rendered
 * HTML files served by a lightweight HTTP server on port 4180.
 */
const BASE = process.env.VINEXT_E2E_BASE_URL ?? "http://localhost:4180";

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
    const response = await page.goto(`${BASE}/about/`);
    expect(response?.status()).toBe(200);
    await expect(page.locator("h1")).toHaveText("About");
    await expect(page.locator("body")).toContainText(
      "A static App Router page with no dynamic data.",
    );
  });

  test("blog/hello-world renders", async ({ page }) => {
    const response = await page.goto(`${BASE}/blog/hello-world/`);
    expect(response?.status()).toBe(200);
    await expect(page.locator("h1")).toHaveText("Blog Post");
    await expect(page.locator("body")).toContainText("Slug: hello-world");
  });

  test("blog/getting-started renders", async ({ page }) => {
    const response = await page.goto(`${BASE}/blog/getting-started/`);
    expect(response?.status()).toBe(200);
    await expect(page.locator("h1")).toHaveText("Blog Post");
    await expect(page.locator("body")).toContainText("Slug: getting-started");
  });

  test("blog/advanced-guide renders", async ({ page }) => {
    const response = await page.goto(`${BASE}/blog/advanced-guide/`);
    expect(response?.status()).toBe(200);
    await expect(page.locator("h1")).toHaveText("Blog Post");
    await expect(page.locator("body")).toContainText("Slug: advanced-guide");
  });

  test("blog page includes dynamic metadata in title", async ({ page }) => {
    await page.goto(`${BASE}/blog/hello-world/`);
    await expect(page).toHaveTitle("Blog: hello-world");
  });

  test("home page navigation links are present", async ({ page }) => {
    await page.goto(`${BASE}/`);
    const nav = page.locator("nav");
    await expect(nav.locator('a[href="/about/"]')).toBeVisible();
    await expect(nav.locator('a[href="/blog/hello-world/"]')).toBeVisible();
    await expect(nav.locator('a[href="/blog/getting-started/"]')).toBeVisible();
    await expect(nav.locator('a[href="/old-school/"]')).toBeVisible();
    await expect(nav.locator('a[href="/products/widget/"]')).toBeVisible();
  });

  test("client-side navigation works between pages", async ({ page }) => {
    await page.goto(`${BASE}/`);
    await page.locator('a[href="/about/"]').click();
    await page.waitForURL(`${BASE}/about/`);
    await expect(page.locator("h1")).toHaveText("About");
  });

  // Ported from Next.js: test/e2e/app-dir/app-static/app-static.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/app-static/app-static.test.ts
  test("useSearchParams reads the browser query after hydration", async ({ page }) => {
    let rscRequests = 0;
    page.on("request", (request) => {
      if (request.headers().rsc === "1") rscRequests++;
    });
    const response = await page.goto(`${BASE}/search-params/?value=expected`);
    expect(response?.status()).toBe(200);
    await waitForAppRouterHydration(page);
    await expect(page.getByTestId("query-value")).toHaveText("expected");
    expect(page.url()).toBe(`${BASE}/search-params/?value=expected`);
    expect(rscRequests).toBe(0);
  });

  test("useSearchParams reads the query after static-host navigation fallback", async ({
    page,
  }) => {
    await page.goto(`${BASE}/`);
    await page.evaluate(() => Reflect.set(window, "__staticExportSoftNavigation", true));
    await page.locator('a[href="/search-params/?value=navigated"]').click();
    await page.waitForURL(`${BASE}/search-params/?value=navigated`);
    await expect(page.getByTestId("query-value")).toHaveText("navigated");
    expect(
      await page.evaluate(() => Reflect.get(window, "__staticExportSoftNavigation")),
    ).toBeUndefined();
  });

  test("root layout metadata is applied", async ({ page }) => {
    await page.goto(`${BASE}/`);
    await expect(page).toHaveTitle("Static Export Fixture");
  });

  test("404 page for non-existent route", async ({ page }) => {
    const response = await page.goto(`${BASE}/nonexistent-page/`);
    expect(response?.status()).toBe(404);
  });
});
