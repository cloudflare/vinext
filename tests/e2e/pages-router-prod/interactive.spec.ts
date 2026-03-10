import { test, expect } from "@playwright/test";

const BASE = "http://localhost:4175";

test.describe("Pages Router Production — Interactive", () => {
  // NOTE: Pages Router production build (vinext build + vinext start) does not
  // currently hydrate client components — interactive useState/onClick don't work.
  // The SSR HTML renders correctly, but client JS bundles aren't loaded.
  // This is a known gap — production hydration only works on Cloudflare Workers
  // (via the vinext:cloudflare-build client environment). Phase 9 DX work should
  // add production hydration for the Node.js server too.
  test("counter page SSR renders correctly in production", async ({ page }) => {
    await page.goto(`${BASE}/counter`);
    // SSR content is present
    await expect(page.locator('[data-testid="count"]')).toHaveText("Count: 0");
    await expect(page.locator('[data-testid="increment"]')).toBeVisible();
    await expect(page.locator('[data-testid="decrement"]')).toBeVisible();
  });

  test("Link click navigates to correct page", async ({ page }) => {
    await page.goto(`${BASE}/`);
    await expect(page.locator("h1")).toHaveText("Hello, vinext!");

    await page.click('a[href="/about"]');
    await expect(page.locator("h1")).toHaveText("About");
    expect(page.url()).toBe(`${BASE}/about`);
  });

  test("browser back button works after navigation", async ({ page }) => {
    await page.goto(`${BASE}/`);
    await expect(page.locator("h1")).toHaveText("Hello, vinext!");

    await page.click('a[href="/about"]');
    await expect(page.locator("h1")).toHaveText("About");

    await page.goBack();
    await expect(page.locator("h1")).toHaveText("Hello, vinext!");
    expect(page.url()).toBe(`${BASE}/`);
  });

  test("SSR page has fresh data on each request", async ({ page }) => {
    await page.goto(`${BASE}/ssr`);
    const ts1 = await page.locator('[data-testid="timestamp"]').textContent();

    await page.waitForTimeout(100);
    await page.goto(`${BASE}/ssr`);
    const ts2 = await page.locator('[data-testid="timestamp"]').textContent();

    expect(ts1).not.toBe(ts2);
  });

  test("middleware redirect works in production", async ({ page }) => {
    await page.goto(`${BASE}/old-page`);
    // Middleware redirects /old-page to /about
    expect(page.url()).toBe(`${BASE}/about`);
    await expect(page.locator("h1")).toHaveText("About");
  });

  test("middleware rewrite works in production", async ({ page }) => {
    await page.goto(`${BASE}/rewritten`);
    // Middleware rewrites /rewritten to /ssr
    await expect(page.locator("h1")).toHaveText("Server-Side Rendered");
    await expect(page.locator('[data-testid="message"]')).toHaveText(
      "Hello from getServerSideProps",
    );
  });

  test("dynamic route renders with params in production", async ({ page }) => {
    await page.goto(`${BASE}/posts/42`);
    await expect(page.locator('[data-testid="post-title"]')).toHaveText("Post: 42");
  });

  test("catch-all route renders in production", async ({ page }) => {
    await page.goto(`${BASE}/docs/guides/setup`);
    await expect(page.locator('[data-testid="docs-title"]')).toHaveText("Docs");
    await expect(page.locator('[data-testid="docs-slug"]')).toHaveText("Path: guides/setup");
  });

  test("navigating between pages preserves _app wrapper", async ({ page }) => {
    await page.goto(`${BASE}/`);
    await expect(page.locator('[data-testid="app-wrapper"]')).toBeVisible();

    await page.click('a[href="/about"]');
    await expect(page.locator("h1")).toHaveText("About");
    await expect(page.locator('[data-testid="app-wrapper"]')).toBeVisible();

    await page.click('a[href="/"]');
    await expect(page.locator("h1")).toHaveText("Hello, vinext!");
    await expect(page.locator('[data-testid="app-wrapper"]')).toBeVisible();
  });
});

test.describe("Pages Router Production — API", () => {
  test("dynamic API route returns user data", async ({ request }) => {
    const response = await request.get(`${BASE}/api/users/42`);
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ user: { id: "42", name: "User 42" } });
  });

  test("API route with different id", async ({ request }) => {
    const response = await request.get(`${BASE}/api/users/alice`);
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ user: { id: "alice", name: "User alice" } });
  });
});
