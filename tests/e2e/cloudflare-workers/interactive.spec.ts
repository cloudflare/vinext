import { test, expect } from "@playwright/test";

const BASE = "http://localhost:4176";

test.describe("App Router interactive behavior on Cloudflare Workers", () => {
  test("counter increments on multiple clicks", async ({ page }) => {
    await page.goto(`${BASE}/`);
    await expect(page.locator("h1")).toHaveText("vinext on Cloudflare Workers");

    // Wait for hydration by polling counter clicks
    await expect(async () => {
      await page.click('[data-testid="increment"]');
      const text = await page.locator('[data-testid="count"]').textContent();
      expect(text).not.toBe("Count: 0");
    }).toPass({ timeout: 10_000 });

    // Click more
    await page.click('[data-testid="increment"]');
    await page.click('[data-testid="increment"]');

    // Count should be at least 3 (may be higher if polling clicked extra)
    const text = await page.locator('[data-testid="count"]').textContent();
    const count = parseInt(text!.replace("Count: ", ""), 10);
    expect(count).toBeGreaterThanOrEqual(3);
  });

  test("clicking link to About navigates correctly", async ({ page }) => {
    await page.goto(`${BASE}/`);
    await expect(page.locator("h1")).toHaveText("vinext on Cloudflare Workers");

    // Click About link
    await page.click('a[href="/about"]');
    await expect(page.locator("h1")).toHaveText("About");
    await expect(page.locator("p:first-of-type")).toContainText(
      "vinext app deployed on Cloudflare Workers",
    );
    expect(page.url()).toBe(`${BASE}/about`);
  });

  test("clicking back link returns to home", async ({ page }) => {
    await page.goto(`${BASE}/about`);
    await expect(page.locator("h1")).toHaveText("About");

    // Click back link
    await page.click('a[href="/"]');
    await expect(page.locator("h1")).toHaveText("vinext on Cloudflare Workers");
    expect(page.url()).toBe(`${BASE}/`);
  });

  test("browser back button works after navigation", async ({ page }) => {
    await page.goto(`${BASE}/`);
    await expect(page.locator("h1")).toHaveText("vinext on Cloudflare Workers");

    // Navigate to about
    await page.click('a[href="/about"]');
    await expect(page.locator("h1")).toHaveText("About");

    // Browser back
    await page.goBack();
    await expect(page.locator("h1")).toHaveText("vinext on Cloudflare Workers");
    expect(page.url()).toBe(`${BASE}/`);

    // Browser forward
    await page.goForward();
    await expect(page.locator("h1")).toHaveText("About");
    expect(page.url()).toBe(`${BASE}/about`);
  });

  test("server component timestamp changes on each request", async ({ page }) => {
    await page.goto(`${BASE}/`);
    const ts1 = await page.locator('[data-testid="timestamp"]').textContent();

    await page.waitForTimeout(100);
    await page.goto(`${BASE}/`);
    const ts2 = await page.locator('[data-testid="timestamp"]').textContent();

    // Each request should produce a different timestamp (server rendering)
    expect(ts1).not.toBe(ts2);
  });

  test("counter state resets on full page navigation", async ({ page }) => {
    await page.goto(`${BASE}/`);
    await expect(page.locator("h1")).toHaveText("vinext on Cloudflare Workers");

    // Wait for hydration and increment counter
    await expect(async () => {
      await page.click('[data-testid="increment"]');
      const text = await page.locator('[data-testid="count"]').textContent();
      expect(text).not.toBe("Count: 0");
    }).toPass({ timeout: 10_000 });

    // Full page reload
    await page.goto(`${BASE}/`);

    // Counter should be back to 0
    await expect(page.locator('[data-testid="count"]')).toHaveText("Count: 0");
  });
});

test.describe("App Router dynamic routes on Cloudflare Workers", () => {
  test("renders blog post with dynamic slug", async ({ page }) => {
    await page.goto(`${BASE}/blog/hello-world`);
    await expect(page.locator('[data-testid="blog-title"]')).toHaveText("Blog: hello-world");
    await expect(page.locator('[data-testid="blog-slug"]')).toHaveText("Slug: hello-world");
  });

  test("different slugs render different content", async ({ page }) => {
    await page.goto(`${BASE}/blog/first-post`);
    await expect(page.locator('[data-testid="blog-title"]')).toHaveText("Blog: first-post");

    await page.goto(`${BASE}/blog/second-post`);
    await expect(page.locator('[data-testid="blog-title"]')).toHaveText("Blog: second-post");
  });

  test("blog page has back link to home", async ({ page }) => {
    await page.goto(`${BASE}/blog/test`);
    await expect(page.locator('[data-testid="blog-title"]')).toHaveText("Blog: test");

    await page.click('a[href="/"]');
    await expect(page.locator("h1")).toHaveText("vinext on Cloudflare Workers");
  });
});

test.describe("App Router API routes on Workers — extended", () => {
  test("API returns Cloudflare Workers runtime", async ({ request }) => {
    const response = await request.get(`${BASE}/api/hello`);
    const body = await response.json();
    expect(body.runtime).toContain("Cloudflare-Workers");
  });

  test("API response is valid JSON with correct headers", async ({ request }) => {
    const response = await request.get(`${BASE}/api/hello`);
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("application/json");
    const body = await response.json();
    expect(body.message).toBeTruthy();
  });
});
