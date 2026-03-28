import { test, expect } from "@playwright/test";

const BASE = "http://localhost:4174";

test.describe("Loading boundaries (loading.tsx)", () => {
  test("slow page eventually renders content", async ({ page }) => {
    await page.goto(`${BASE}/slow`);
    // The page should render — loading.tsx should resolve to the actual page
    await expect(page.locator("h1")).toHaveText("Slow Page", {
      timeout: 10_000,
    });
    await expect(page.locator("main > p")).toHaveText("This page has a loading boundary.");
  });

  test("slow page serves HTML response", async ({ page }) => {
    const response = await page.goto(`${BASE}/slow`);
    expect(response?.status()).toBe(200);
    expect(response?.headers()["content-type"]).toContain("text/html");
  });

  /**
   * OpenNext Compat: loading.tsx Suspense visibility timing
   *
   * Ported from: https://github.com/opennextjs/opennextjs-cloudflare/blob/main/examples/e2e/app-router/e2e/ssr.test.ts
   *
   * OpenNext verifies that loading.tsx boundary is visible BEFORE the page content
   * resolves. This confirms Suspense streaming works correctly — the loading state
   * is sent immediately in the initial HTML shell, then replaced by the resolved content.
   *
   * The slow page has a 2s async delay. The loading.tsx fallback should appear in
   * the initial streamed HTML shell before the page component resolves.
   */
  test("loading boundary is visible before content resolves", async ({ page }) => {
    // Ref: opennextjs-cloudflare ssr.test.ts "Server Side Render and loading.tsx"

    // Navigate to slow page — loading.tsx should show first due to 2s server delay
    void page.goto(`${BASE}/slow`);

    // loading.tsx fallback should appear quickly in the streamed shell
    const loading = page.locator("#loading-fallback");
    await expect(loading).toBeVisible({ timeout: 5_000 });

    // Then the actual page content should resolve
    await expect(page.locator("h1")).toHaveText("Slow Page", {
      timeout: 10_000,
    });
  });
});
