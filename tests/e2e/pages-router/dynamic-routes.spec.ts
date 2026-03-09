import { test, expect } from "@playwright/test";

const BASE = "http://localhost:4173";

test.describe("Dynamic routes with getServerSideProps", () => {
  test("renders post page with dynamic id from GSSP", async ({ page }) => {
    await page.goto(`${BASE}/posts/123`);
    await expect(page.locator('[data-testid="post-title"]')).toHaveText("Post: 123");
    // vinext returns the resolved pathname (not the route pattern)
    await expect(page.locator('[data-testid="pathname"]')).toHaveText("Pathname: /posts/123");
    await expect(page.locator('[data-testid="query"]')).toHaveText("Query ID: 123");
  });

  test("renders with different dynamic id", async ({ page }) => {
    await page.goto(`${BASE}/posts/456`);
    await expect(page.locator('[data-testid="post-title"]')).toHaveText("Post: 456");
    await expect(page.locator('[data-testid="query"]')).toHaveText("Query ID: 456");
  });

  test("GSSP provides data for each unique id", async ({ page }) => {
    // First request
    await page.goto(`${BASE}/posts/abc`);
    await expect(page.locator('[data-testid="post-title"]')).toHaveText("Post: abc");

    // Navigate to different post via client navigation
    await page.evaluate(() => {
      (window as any).__NAV_MARKER__ = true;
    });

    // Use router to navigate
    await page.evaluate(() => {
      const router = (window as any).__NEXT_DATA__ && (window as any).next?.router;
      if (router) router.push("/posts/xyz");
      else window.location.href = "/posts/xyz";
    });

    await expect(page.locator('[data-testid="post-title"]')).toHaveText("Post: xyz");
  });
});

test.describe("Catch-all routes with getServerSideProps", () => {
  test("renders with single segment", async ({ page }) => {
    await page.goto(`${BASE}/docs/intro`);
    await expect(page.locator('[data-testid="docs-title"]')).toHaveText("Docs");
    await expect(page.locator('[data-testid="docs-slug"]')).toHaveText("Path: intro");
  });

  test("renders with multiple segments", async ({ page }) => {
    await page.goto(`${BASE}/docs/api/v2/users`);
    await expect(page.locator('[data-testid="docs-title"]')).toHaveText("Docs");
    await expect(page.locator('[data-testid="docs-slug"]')).toHaveText("Path: api/v2/users");
  });

  test("renders with two segments", async ({ page }) => {
    await page.goto(`${BASE}/docs/getting-started/installation`);
    await expect(page.locator('[data-testid="docs-slug"]')).toHaveText(
      "Path: getting-started/installation",
    );
  });
});

test.describe("Dynamic API routes", () => {
  test("GET /api/users/[id] returns user data", async ({ request }) => {
    const response = await request.get(`${BASE}/api/users/42`);
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ user: { id: "42", name: "User 42" } });
  });

  test("GET /api/users/[id] with string id", async ({ request }) => {
    const response = await request.get(`${BASE}/api/users/alice`);
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ user: { id: "alice", name: "User alice" } });
  });
});
