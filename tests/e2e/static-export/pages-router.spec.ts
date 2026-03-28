import { test, expect } from "@playwright/test";

/**
 * Static export E2E tests for the Pages Router.
 *
 * These tests run against a `vinext build` output served as static files.
 * The fixture uses `output: "export"` with Pages Router pages that use
 * getStaticProps and getStaticPaths for pre-rendering.
 */
const BASE = "http://localhost:4180";

test.describe("Static Export — Pages Router", () => {
  test("old-school page renders with correct content", async ({ page }) => {
    const response = await page.goto(`${BASE}/old-school`);
    expect(response?.status()).toBe(200);
    await expect(page.locator("h1")).toHaveText("Old-school Page (Pages Router)");
    await expect(page.locator("body")).toContainText(
      "A static Pages Router page rendered with getStaticProps.",
    );
  });

  test("product widget renders with getStaticProps data", async ({ page }) => {
    const response = await page.goto(`${BASE}/products/widget`);
    expect(response?.status()).toBe(200);
    await expect(page.locator("h1")).toHaveText("The Widget");
    await expect(page.locator("body")).toContainText("Product ID: widget");
  });

  test("product gadget renders with getStaticProps data", async ({ page }) => {
    const response = await page.goto(`${BASE}/products/gadget`);
    expect(response?.status()).toBe(200);
    await expect(page.locator("h1")).toHaveText("The Gadget");
    await expect(page.locator("body")).toContainText("Product ID: gadget");
  });

  test("product doohickey renders with getStaticProps data", async ({ page }) => {
    const response = await page.goto(`${BASE}/products/doohickey`);
    expect(response?.status()).toBe(200);
    await expect(page.locator("h1")).toHaveText("The Doohickey");
    await expect(page.locator("body")).toContainText("Product ID: doohickey");
  });

  test("__NEXT_DATA__ is present in Pages Router output", async ({ page }) => {
    await page.goto(`${BASE}/old-school`);
    const nextData = await page.evaluate(() => (window as any).__NEXT_DATA__);
    expect(nextData).toBeDefined();
    expect(nextData.props).toBeDefined();
    expect(nextData.props.pageProps).toBeDefined();
  });

  test("product page __NEXT_DATA__ contains props from getStaticProps", async ({ page }) => {
    await page.goto(`${BASE}/products/widget`);
    const nextData = await page.evaluate(() => (window as any).__NEXT_DATA__);
    expect(nextData).toBeDefined();
    expect(nextData.props).toBeDefined();
    expect(nextData.props.pageProps).toBeDefined();
    expect(nextData.props.pageProps.id).toBe("widget");
    expect(nextData.props.pageProps.name).toBe("The Widget");
  });

  test("non-pre-rendered dynamic route returns 404", async ({ page }) => {
    // getStaticPaths uses fallback: false, so unknown IDs should 404
    const response = await page.goto(`${BASE}/products/unknown`);
    expect(response?.status()).toBe(404);
  });
});
