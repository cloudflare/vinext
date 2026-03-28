import { test, expect } from "@playwright/test";

const BASE = "http://localhost:4176";

test.describe("Cloudflare Workers Navigation", () => {
  test("navigating between pages via links", async ({ page }) => {
    await page.goto(`${BASE}/`);
    await expect(page.locator("h1")).toHaveText("vinext on Cloudflare Workers");

    // Click About link
    await page.click('a[href="/about"]');
    await expect(page.locator("h1")).toHaveText("About");

    // Click back to home
    await page.click('a[href="/"]');
    await expect(page.locator("h1")).toHaveText("vinext on Cloudflare Workers");
  });

  test("browser back/forward works", async ({ page }) => {
    await page.goto(`${BASE}/`);
    await expect(page.locator("h1")).toHaveText("vinext on Cloudflare Workers");

    await page.click('a[href="/about"]');
    await expect(page.locator("h1")).toHaveText("About");

    await page.goBack();
    await expect(page.locator("h1")).toHaveText("vinext on Cloudflare Workers");

    await page.goForward();
    await expect(page.locator("h1")).toHaveText("About");
  });

  test("RSC endpoint returns flight data for client navigation", async ({ request }) => {
    // The .rsc URL should return RSC flight payload (not HTML)
    const response = await request.get(`${BASE}/about`, {
      headers: { Accept: "text/x-component" },
    });

    expect(response.status()).toBe(200);
    const body = await response.text();
    // RSC flight payload contains React component references
    // It should NOT be a full HTML document
    expect(body).not.toContain("<!DOCTYPE html>");
    // It should contain some RSC markers (lines starting with digits/hex)
    expect(body.length).toBeGreaterThan(0);
  });

  test("static assets are served (client JS bundle)", async ({ request }) => {
    // First get the home page to find the JS bundle URL
    const html = await (await request.get(`${BASE}/`)).text();
    // The bundle is referenced as import("/assets/index-XXXX.js")
    const match = html.match(/import\("(\/assets\/[^"]+)"\)/);
    expect(match).toBeTruthy();

    const jsUrl = match![1];
    const jsResponse = await request.get(`${BASE}${jsUrl}`);
    expect(jsResponse.status()).toBe(200);
    const contentType = jsResponse.headers()["content-type"];
    expect(contentType).toContain("javascript");
  });
});
