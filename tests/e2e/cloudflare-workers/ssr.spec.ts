import { test, expect } from "@playwright/test";

const BASE = "http://localhost:4176";

test.describe("Cloudflare Workers SSR", () => {
  test("home page renders server-side HTML", async ({ page }) => {
    await page.goto(`${BASE}/`);

    await expect(page.locator("h1")).toHaveText("vinext on Cloudflare Workers");
    await expect(page.locator("p").first()).toContainText("server-rendered by vinext");
  });

  test("SSR HTML is present without JavaScript", async ({ page }) => {
    // Block all JS to verify SSR output
    await page.route("**/*.js", (route) => route.abort());

    await page.goto(`${BASE}/`);

    await expect(page.locator("h1")).toHaveText("vinext on Cloudflare Workers");
    // Counter should show initial state from SSR
    await expect(page.locator('[data-testid="count"]')).toHaveText("Count: 0");
    // Timestamp should be present (server-rendered)
    const timestamp = await page.textContent('[data-testid="timestamp"]');
    expect(timestamp).toContain("Rendered at:");
  });

  test("about page renders correctly", async ({ page }) => {
    await page.goto(`${BASE}/about`);

    await expect(page.locator("h1")).toHaveText("About");
    await expect(page.locator("p").first()).toContainText(
      "vinext app deployed on Cloudflare Workers",
    );
  });

  test("each request gets a fresh server render (dynamic timestamp)", async ({ page }) => {
    await page.goto(`${BASE}/`);
    const ts1 = await page.textContent('[data-testid="timestamp"]');

    // Small delay to ensure different timestamp
    await page.waitForTimeout(50);
    await page.goto(`${BASE}/`);
    const ts2 = await page.textContent('[data-testid="timestamp"]');

    // Timestamps should be different (not cached/static)
    expect(ts1).not.toBe(ts2);
  });

  test("unknown routes return 404", async ({ page }) => {
    const response = await page.goto(`${BASE}/nonexistent-page`);
    expect(response?.status()).toBe(404);
  });

  test("root layout wraps pages with html/head/body", async ({ page }) => {
    await page.goto(`${BASE}/`);

    // Check html tag has lang
    const lang = await page.getAttribute("html", "lang");
    expect(lang).toBe("en");

    // Check title is set
    const title = await page.title();
    expect(title).toBe("vinext on Cloudflare Workers");

    // Check meta viewport
    const viewport = await page.getAttribute('meta[name="viewport"]', "content");
    expect(viewport).toBe("width=device-width, initial-scale=1");
  });
});
