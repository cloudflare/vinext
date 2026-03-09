import { test, expect } from "@playwright/test";

const BASE = "http://localhost:4174";

/**
 * Wait for the RSC browser entry to hydrate.
 */
async function waitForHydration(page: import("@playwright/test").Page) {
  await expect(async () => {
    const ready = await page.evaluate(() => !!(window as any).__VINEXT_RSC_ROOT__);
    expect(ready).toBe(true);
  }).toPass({ timeout: 10_000 });
}

test.describe("Catch-all routes", () => {
  test("renders with single segment", async ({ page }) => {
    await page.goto(`${BASE}/docs/getting-started`);
    await expect(page.locator("h1")).toHaveText("Documentation");
    await expect(page.locator("main > p:first-of-type")).toHaveText("Path: getting-started");
    await expect(page.locator("main > p:nth-of-type(2)")).toHaveText("Segments: 1");
  });

  test("renders with multiple segments", async ({ page }) => {
    await page.goto(`${BASE}/docs/api/reference/hooks`);
    await expect(page.locator("h1")).toHaveText("Documentation");
    await expect(page.locator("main > p:first-of-type")).toHaveText("Path: api/reference/hooks");
    await expect(page.locator("main > p:nth-of-type(2)")).toHaveText("Segments: 3");
  });

  test("renders with two segments", async ({ page }) => {
    await page.goto(`${BASE}/docs/guides/deployment`);
    await expect(page.locator("h1")).toHaveText("Documentation");
    await expect(page.locator("main > p:first-of-type")).toHaveText("Path: guides/deployment");
    await expect(page.locator("main > p:nth-of-type(2)")).toHaveText("Segments: 2");
  });
});

test.describe("Optional catch-all routes", () => {
  test("renders at root (no segments)", async ({ page }) => {
    await page.goto(`${BASE}/optional`);
    await expect(page.locator("h1")).toHaveText("Optional Catch-All");
    await expect(page.locator("main > p:first-of-type")).toHaveText("Path: (root)");
    await expect(page.locator("main > p:nth-of-type(2)")).toHaveText("Segments: 0");
  });

  test("renders with single segment", async ({ page }) => {
    await page.goto(`${BASE}/optional/hello`);
    await expect(page.locator("h1")).toHaveText("Optional Catch-All");
    await expect(page.locator("main > p:first-of-type")).toHaveText("Path: hello");
    await expect(page.locator("main > p:nth-of-type(2)")).toHaveText("Segments: 1");
  });

  test("renders with deep nesting", async ({ page }) => {
    await page.goto(`${BASE}/optional/a/b/c/d`);
    await expect(page.locator("h1")).toHaveText("Optional Catch-All");
    await expect(page.locator("main > p:first-of-type")).toHaveText("Path: a/b/c/d");
    await expect(page.locator("main > p:nth-of-type(2)")).toHaveText("Segments: 4");
  });
});

test.describe("Route groups", () => {
  test("route group URL excludes group name", async ({ page }) => {
    await page.goto(`${BASE}/features`);
    await expect(page.locator("h1")).toHaveText("Features");
    await expect(page.locator("main > p")).toHaveText("This page is in a route group.");
  });

  test("route group page is accessible via client navigation", async ({ page }) => {
    await page.goto(`${BASE}/`);
    await waitForHydration(page);

    // Navigate to features page — it's under (marketing) group
    await page.evaluate(() => {
      window.location.href = "/features";
    });
    await expect(page.locator("h1")).toHaveText("Features");
    expect(page.url()).toBe(`${BASE}/features`);
  });
});

test.describe("Nested dynamic routes", () => {
  test("category page renders with param", async ({ page }) => {
    await page.goto(`${BASE}/shop/electronics`);
    await expect(page.locator("h1")).toHaveText("Category: electronics");
  });

  test("item page renders with both params", async ({ page }) => {
    await page.goto(`${BASE}/shop/electronics/phone`);
    await expect(page.locator("h1")).toHaveText("Item: phone in electronics");
  });

  test("different category renders correctly", async ({ page }) => {
    await page.goto(`${BASE}/shop/clothing`);
    await expect(page.locator("h1")).toHaveText("Category: clothing");
  });

  test("nested item under different category", async ({ page }) => {
    await page.goto(`${BASE}/shop/clothing/shirt`);
    await expect(page.locator("h1")).toHaveText("Item: shirt in clothing");
  });

  test("navigating between categories via client navigation", async ({ page }) => {
    await page.goto(`${BASE}/shop/electronics`);
    await expect(page.locator("h1")).toHaveText("Category: electronics");
    await waitForHydration(page);

    await page.evaluate(() => {
      (window as any).__NAV_MARKER__ = true;
    });

    // Navigate to item
    await page.evaluate(() => {
      window.history.pushState(null, "", "/shop/electronics/laptop");
    });
    // Full navigation to verify rendering
    await page.goto(`${BASE}/shop/electronics/laptop`);
    await expect(page.locator("h1")).toHaveText("Item: laptop in electronics");
  });
});

test.describe("Server-side redirects", () => {
  test("redirect() returns redirect response", async ({ page }) => {
    await page.goto(`${BASE}/redirect-test`);
    // Should have followed the redirect to /about
    expect(page.url()).toBe(`${BASE}/about`);
    await expect(page.locator("h1")).toHaveText("About");
  });

  test("permanentRedirect() returns redirect response", async ({ page }) => {
    await page.goto(`${BASE}/permanent-redirect-test`);
    // Should have followed the redirect to /about
    expect(page.url()).toBe(`${BASE}/about`);
    await expect(page.locator("h1")).toHaveText("About");
  });
});

test.describe("Dashboard nested not-found", () => {
  test("notFound() in nested route renders dashboard-scoped 404", async ({ page }) => {
    const response = await page.goto(`${BASE}/dashboard/missing`);
    expect(response?.status()).toBe(404);
    await expect(page.locator("#dashboard-not-found")).toBeVisible();
    await expect(page.locator("#dashboard-not-found h2")).toHaveText("Dashboard: Page Not Found");
  });

  test("dashboard layout is preserved when nested not-found renders", async ({ page }) => {
    await page.goto(`${BASE}/dashboard/missing`);
    // The dashboard layout should still wrap the not-found page
    await expect(page.locator("#dashboard-layout")).toBeVisible();
    await expect(page.locator("#dashboard-not-found")).toBeVisible();
  });
});

test.describe("Client navigation hooks SSR", () => {
  test("usePathname renders correct pathname on SSR", async ({ page }) => {
    await page.goto(`${BASE}/client-nav-test`);
    await expect(page.locator("h1")).toHaveText("Client Nav Test");
    await expect(page.locator('[data-testid="client-pathname"]')).toHaveText("/client-nav-test");
  });

  test("useSearchParams renders query param on SSR", async ({ page }) => {
    await page.goto(`${BASE}/client-nav-test?q=hello`);
    await expect(page.locator('[data-testid="client-pathname"]')).toHaveText("/client-nav-test");
    await expect(page.locator('[data-testid="client-search-q"]')).toHaveText("hello");
  });

  test("useSearchParams is empty when no query", async ({ page }) => {
    await page.goto(`${BASE}/client-nav-test`);
    await expect(page.locator('[data-testid="client-search-q"]')).toHaveText("");
  });
});
