import { test, expect } from "@playwright/test";

const BASE = "http://localhost:4174";

test.describe("Static Metadata", () => {
  test("metadata export renders <title>", async ({ page }) => {
    await page.goto(`${BASE}/metadata-test`);

    await expect(page).toHaveTitle("Metadata Test Page");
  });

  test("metadata export renders <meta name='description'>", async ({ page }) => {
    await page.goto(`${BASE}/metadata-test`);

    const description = page.locator('meta[name="description"]');
    await expect(description).toHaveAttribute("content", "A page to test the metadata API");
  });

  test("metadata export renders <meta name='keywords'>", async ({ page }) => {
    await page.goto(`${BASE}/metadata-test`);

    const keywords = page.locator('meta[name="keywords"]');
    await expect(keywords).toHaveAttribute("content", "test,metadata,vinext");
  });

  test("metadata export renders OpenGraph tags", async ({ page }) => {
    await page.goto(`${BASE}/metadata-test`);

    const ogTitle = page.locator('meta[property="og:title"]');
    await expect(ogTitle).toHaveAttribute("content", "OG Title");

    const ogDescription = page.locator('meta[property="og:description"]');
    await expect(ogDescription).toHaveAttribute("content", "OG Description");

    const ogType = page.locator('meta[property="og:type"]');
    await expect(ogType).toHaveAttribute("content", "website");
  });

  test("viewport export renders theme-color and color-scheme", async ({ page }) => {
    await page.goto(`${BASE}/metadata-test`);

    const themeColor = page.locator('meta[name="theme-color"]');
    await expect(themeColor).toHaveAttribute("content", "#0070f3");

    const colorScheme = page.locator('meta[name="color-scheme"]');
    await expect(colorScheme).toHaveAttribute("content", "light dark");
  });
});

test.describe("Dynamic Metadata (generateMetadata)", () => {
  test("generateMetadata renders <title>", async ({ page }) => {
    await page.goto(`${BASE}/metadata-dynamic-test`);

    await expect(page).toHaveTitle("Dynamic Metadata Page");
    await expect(page.locator('[data-testid="dynamic-metadata-heading"]')).toBeVisible();
  });

  test("generateMetadata renders description", async ({ page }) => {
    await page.goto(`${BASE}/metadata-dynamic-test`);

    const description = page.locator('meta[name="description"]');
    await expect(description).toHaveAttribute(
      "content",
      "Generated dynamically via generateMetadata",
    );
  });

  test("generateMetadata renders OpenGraph tags", async ({ page }) => {
    await page.goto(`${BASE}/metadata-dynamic-test`);

    const ogTitle = page.locator('meta[property="og:title"]');
    await expect(ogTitle).toHaveAttribute("content", "Dynamic OG Title");

    const ogDescription = page.locator('meta[property="og:description"]');
    await expect(ogDescription).toHaveAttribute("content", "Dynamic OG Description");
  });
});

test.describe("Metadata Routes", () => {
  test("robots.ts returns valid robots.txt", async ({ request }) => {
    const response = await request.get(`${BASE}/robots.txt`);
    expect(response.status()).toBe(200);
    const text = await response.text();
    expect(text).toContain("User-Agent");
  });

  test("sitemap.ts returns valid XML sitemap", async ({ request }) => {
    const response = await request.get(`${BASE}/sitemap.xml`);
    expect(response.status()).toBe(200);
    const text = await response.text();
    expect(text).toContain("<?xml");
    expect(text).toContain("<urlset");
  });

  test("manifest.ts returns valid web manifest", async ({ request }) => {
    const response = await request.get(`${BASE}/manifest.webmanifest`);
    expect(response.status()).toBe(200);
    const json = await response.json();
    expect(json).toHaveProperty("name");
  });
});

test.describe("Streaming metadata icons", () => {
  test("moves streamed icons into head and replaces them on navigation", async ({ page }) => {
    // Ported from Next.js: test/e2e/app-dir/metadata-icons/metadata-icons.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/metadata-icons/metadata-icons.test.ts
    const html = await (await page.request.get(`${BASE}/metadata-icons-stream`)).text();
    expect(html).toContain(
      `document.querySelectorAll('body link[rel="icon"], body link[rel="apple-touch-icon"]')`,
    );
    expect(html).toContain("data-vinext-relocated-metadata-icon");
    expect(html).not.toContain("«nxt-icon»");

    await page.goto(`${BASE}/metadata-icons-stream`);

    await expect(page.locator('body link[rel="icon"]')).toHaveCount(0);
    await expect(page.locator('head link[rel="icon"][href^="/heart.png"]')).toHaveCount(1);

    await page.locator("#metadata-icons-sub-link").click();
    await expect(page).toHaveURL(/\/metadata-icons-stream\/sub$/);
    await expect(page.locator('body link[rel="icon"]')).toHaveCount(0);
    await expect(page.locator('head link[rel="icon"][href^="/star.png"]')).toHaveCount(1);
    await expect(page.locator('head link[rel="icon"][href^="/heart.png"]')).toHaveCount(0);
  });

  test("preserves manual icons and clears managed icons across empty routes and history", async ({
    page,
  }) => {
    await page.goto(`${BASE}/metadata-icons-stream`);
    await expect(page.locator('head link[rel="icon"][href^="/heart.png"]')).toHaveCount(1);
    const layoutIcon = page.locator('head link[data-testid="manual-layout-icon"]');
    await expect(layoutIcon).toHaveCount(1);

    await page.locator("#metadata-icons-none-link").click();
    await expect(page).toHaveURL(/\/metadata-icons-stream\/no-icon$/);
    await expect(page.locator('head link[rel="icon"][href^="/heart.png"]')).toHaveCount(0);
    await expect(layoutIcon).toHaveCount(1);

    await page.goBack();
    await expect(page).toHaveURL(/\/metadata-icons-stream$/);
    await expect(page.locator('head link[rel="icon"][href^="/heart.png"]')).toHaveCount(1);
    await expect(layoutIcon).toHaveCount(1);

    await page.goForward();
    await expect(page).toHaveURL(/\/metadata-icons-stream\/no-icon$/);
    await expect(page.locator('head link[rel="icon"][href^="/heart.png"]')).toHaveCount(0);
    await expect(layoutIcon).toHaveCount(1);
  });
});
