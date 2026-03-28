import { test, expect } from "@playwright/test";

const BASE = "http://localhost:4177";

test.describe("Pages Router interactive behavior on Cloudflare Workers", () => {
  test("counter increments on multiple clicks", async ({ page }) => {
    await page.goto(`${BASE}/`);
    await expect(page.locator("h1")).toContainText("Pages Router on Workers");

    // Wait for hydration, then click increment multiple times
    await expect(async () => {
      await page.click("#increment");
      const text = await page.locator("#count").textContent();
      expect(Number(text)).toBeGreaterThan(0);
    }).toPass({ timeout: 10_000 });

    // Click several more times
    await page.click("#increment");
    await page.click("#increment");
    await expect(page.locator("#count")).toHaveText("3");
  });

  test("Link components enable client-side navigation", async ({ page }) => {
    await page.goto(`${BASE}/`);
    await expect(page.locator("h1")).toContainText("Pages Router on Workers");

    // Click About link
    await page.click('a[href="/about"]');
    await expect(page.locator("h1")).toHaveText("About");
    await expect(page.locator("p")).toContainText("Cloudflare Workers");
    expect(page.url()).toBe(`${BASE}/about`);
  });

  test("navigating back and forth between pages", async ({ page }) => {
    await page.goto(`${BASE}/`);
    await expect(page.locator("h1")).toContainText("Pages Router on Workers");

    // Go to About
    await page.click('a[href="/about"]');
    await expect(page.locator("h1")).toHaveText("About");

    // Go back to Home via link
    await page.click('a[href="/"]');
    await expect(page.locator("h1")).toContainText("Pages Router on Workers");
  });

  test("navigating to SSR page via link shows server data", async ({ page }) => {
    await page.goto(`${BASE}/`);
    await expect(page.locator("h1")).toContainText("Pages Router on Workers");

    // Click SSR link
    await page.click('a[href="/ssr"]');
    await expect(page.locator("h1")).toHaveText("Server-Side Rendered on Workers");
    // Should have timestamp from GSSP
    await expect(page.locator("p")).toContainText("Generated at:");
  });

  test("browser back button works after navigating to SSR page", async ({ page }) => {
    await page.goto(`${BASE}/`);
    await expect(page.locator("h1")).toContainText("Pages Router on Workers");

    // Navigate to SSR page via link
    await page.click('a[href="/ssr"]');
    await expect(page.locator("h1")).toHaveText("Server-Side Rendered on Workers");

    // Press back — should return to home
    await page.goBack();
    await expect(page.locator("h1")).toContainText("Pages Router on Workers");
    expect(page.url()).toBe(`${BASE}/`);
  });

  test("browser back and forward buttons work across pages", async ({ page }) => {
    await page.goto(`${BASE}/`);
    await expect(page.locator("h1")).toContainText("Pages Router on Workers");

    // Home -> About
    await page.click('a[href="/about"]');
    await expect(page.locator("h1")).toHaveText("About");

    // Back to Home
    await page.goBack();
    await expect(page.locator("h1")).toContainText("Pages Router on Workers");
    expect(page.url()).toBe(`${BASE}/`);

    // Forward to About
    await page.goForward();
    await expect(page.locator("h1")).toHaveText("About");
    expect(page.url()).toBe(`${BASE}/about`);
  });

  test("SSR page renders different timestamps on each request", async ({ page }) => {
    // First request
    await page.goto(`${BASE}/ssr`);
    const text1 = await page.locator("p").textContent();

    // Wait a moment and make a second request
    await page.waitForTimeout(100);
    await page.goto(`${BASE}/ssr`);
    const text2 = await page.locator("p").textContent();

    // Timestamps should differ (proving server-side rendering, not caching)
    expect(text1).not.toBe(text2);
  });
});

test.describe("Pages Router dynamic routes on Cloudflare Workers", () => {
  test("dynamic route renders with GSSP data", async ({ page }) => {
    await page.goto(`${BASE}/posts/hello`);
    await expect(page.locator('[data-testid="post-title"]')).toHaveText("Post hello");
    await expect(page.locator('[data-testid="post-id"]')).toHaveText("ID: hello");
  });

  test("different dynamic param renders different content", async ({ page }) => {
    await page.goto(`${BASE}/posts/123`);
    await expect(page.locator('[data-testid="post-title"]')).toHaveText("Post 123");

    await page.goto(`${BASE}/posts/world`);
    await expect(page.locator('[data-testid="post-title"]')).toHaveText("Post world");
  });

  test("dynamic route has working links", async ({ page }) => {
    await page.goto(`${BASE}/posts/first`);
    await expect(page.locator('[data-testid="post-title"]')).toHaveText("Post first");

    // Click link to home
    await page.click('a[href="/"]');
    await expect(page.locator("h1")).toContainText("Pages Router on Workers");
  });
});

test.describe("Pages Router API routes on Workers — extended", () => {
  test("API returns correct runtime identifier", async ({ request }) => {
    const response = await request.get(`${BASE}/api/hello`);
    const body = await response.json();
    expect(body.runtime).toContain("Cloudflare-Workers");
  });

  test("API response has correct content-type", async ({ request }) => {
    const response = await request.get(`${BASE}/api/hello`);
    expect(response.headers()["content-type"]).toContain("application/json");
  });
});
