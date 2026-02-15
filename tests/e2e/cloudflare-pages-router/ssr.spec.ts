import { test, expect } from "@playwright/test";

const BASE = "http://localhost:4177";

test.describe("Pages Router SSR on Cloudflare Workers", () => {
  test("renders the home page with correct content", async ({ page }) => {
    await page.goto(BASE + "/");
    await expect(page.locator("h1")).toHaveText("Hello from Pages Router on Workers!");
  });

  test("home page includes __NEXT_DATA__ script", async ({ page }) => {
    const res = await page.goto(BASE + "/");
    const html = await res!.text();
    expect(html).toContain("__NEXT_DATA__");
    expect(html).toContain('"page":"/"');
  });

  test("home page renders Head title tag", async ({ page }) => {
    await page.goto(BASE + "/");
    await expect(page).toHaveTitle("Cloudflare Pages Router");
  });

  test("renders the about page", async ({ page }) => {
    await page.goto(BASE + "/about");
    await expect(page.locator("h1")).toHaveText("About");
    const html = await page.content();
    expect(html).toContain("Cloudflare Workers");
  });

  test("renders SSR page with getServerSideProps data", async ({ page }) => {
    await page.goto(BASE + "/ssr");
    await expect(page.locator("h1")).toHaveText("Server-Side Rendered on Workers");
    // The timestamp should be present (proving GSSP ran on the server)
    const content = await page.textContent("body");
    expect(content).toContain("Generated at:");
  });

  test("returns 404 for non-existent routes", async ({ page }) => {
    const res = await page.goto(BASE + "/nonexistent");
    expect(res!.status()).toBe(404);
    const html = await res!.text();
    expect(html).toContain("404");
  });
});
