import { test, expect } from "@playwright/test";

// tests/fixtures/pages-router-nitro built with `vite build` and served by
// Nitro's Node server.

test.describe("Pages Router on Nitro (node server)", () => {
  test("renders a page", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("h1")).toHaveText("Pages Router on Nitro");
  });

  test("serves a public file that a rewrite resolves to", async ({ request }) => {
    const response = await request.get("/rewrite-to-public");
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("text/plain");
    expect(response.headers()["x-vinext-proxy"]).toBe("active");
    expect(await response.text()).toBe("Hello from public/\n");
  });

  test("answers HEAD for a public file that a rewrite resolves to", async ({ request }) => {
    const response = await request.head("/rewrite-to-public");
    expect(response.status()).toBe(200);
    expect(response.headers()["content-length"]).toBe("19");
    expect(await response.text()).toBe("");
  });

  test("serves a public image from the image endpoint", async ({ request }) => {
    const response = await request.get("/_next/image?url=%2Fpixel.png&w=64&q=75");
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toBe("image/png");
    expect((await response.body()).subarray(1, 4).toString()).toBe("PNG");
  });
});
