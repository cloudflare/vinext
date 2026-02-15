import { test, expect } from "@playwright/test";

const BASE = "http://localhost:4177";

test.describe("Pages Router navigation on Cloudflare Workers", () => {
  test("Link components render as anchor tags", async ({ page }) => {
    await page.goto(BASE + "/");
    const aboutLink = page.locator('a[href="/about"]');
    await expect(aboutLink).toBeVisible();
    await expect(aboutLink).toHaveText("About");
  });

  test("clicking a link navigates to the target page", async ({ page }) => {
    await page.goto(BASE + "/");
    // Wait for hydration before clicking
    await page.waitForTimeout(2000);
    await page.click('a[href="/about"]');
    await page.waitForURL("**/about");
    await expect(page.locator("h1")).toHaveText("About");
  });

  test("direct navigation to different pages works", async ({ page }) => {
    // Navigate directly to about
    await page.goto(BASE + "/about");
    await expect(page.locator("h1")).toHaveText("About");

    // Navigate directly to home
    await page.goto(BASE + "/");
    await expect(page.locator("h1")).toHaveText("Hello from Pages Router on Workers!");
  });

  test("each page has correct __NEXT_DATA__.page value", async ({ page }) => {
    // Home
    let res = await page.goto(BASE + "/");
    let html = await res!.text();
    expect(html).toContain('"page":"/"');

    // About
    res = await page.goto(BASE + "/about");
    html = await res!.text();
    expect(html).toContain('"page":"/about"');

    // SSR
    res = await page.goto(BASE + "/ssr");
    html = await res!.text();
    expect(html).toContain('"page":"/ssr"');
  });
});
