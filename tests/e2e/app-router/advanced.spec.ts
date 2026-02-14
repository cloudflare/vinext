import { test, expect } from "@playwright/test";

const BASE = "http://localhost:4174";

test.describe("Parallel Routes", () => {
  test("dashboard renders all parallel slot content", async ({ page }) => {
    await page.goto(`${BASE}/dashboard`);

    // Dashboard layout
    await expect(page.locator("#dashboard-layout")).toBeVisible();
    await expect(page.locator("#dashboard-layout nav span")).toHaveText(
      "Dashboard Nav",
    );

    // Main children
    await expect(page.locator("h1")).toHaveText("Dashboard");

    // @team parallel slot
    await expect(page.locator('[data-testid="team-panel"]')).toBeVisible();
    await expect(page.locator('[data-testid="team-slot"]')).toBeVisible();

    // @analytics parallel slot
    await expect(page.locator('[data-testid="analytics-panel"]')).toBeVisible();
    await expect(page.locator('[data-testid="analytics-slot"]')).toBeVisible();
  });

  test("child route renders default.tsx fallbacks for inherited slots", async ({
    page,
  }) => {
    await page.goto(`${BASE}/dashboard/settings`);

    // Dashboard layout should still be present
    await expect(page.locator("#dashboard-layout")).toBeVisible();
    await expect(page.locator("h1")).toHaveText("Settings");

    // Parallel slots should render their default.tsx components
    await expect(page.locator('[data-testid="team-default"]')).toBeVisible();
    await expect(page.locator('[data-testid="analytics-default"]')).toBeVisible();

    // Should NOT contain the slot page.tsx content
    await expect(page.locator('[data-testid="team-slot"]')).not.toBeVisible();
    await expect(page.locator('[data-testid="analytics-slot"]')).not.toBeVisible();
  });

  test("slot directories are not accessible as direct routes", async ({
    page,
  }) => {
    const response = await page.goto(`${BASE}/dashboard/team`);
    expect(response?.status()).toBe(404);
  });
});

test.describe("Intercepting Routes", () => {
  test("direct navigation to photo shows full page", async ({ page }) => {
    await page.goto(`${BASE}/photos/42`);

    await expect(page.locator('[data-testid="photo-page"]')).toBeVisible();
    await expect(page.locator("h1")).toContainText("Photo");
    await expect(page.locator('[data-testid="photo-page"]')).toContainText(
      "Full photo view",
    );
    // Should NOT contain modal
    await expect(page.locator('[data-testid="photo-modal"]')).not.toBeVisible();
  });

  test("RSC client navigation intercepts to show modal", async ({ page }) => {
    // Start on the feed page
    await page.goto(`${BASE}/feed`);

    // Wait for hydration
    await page.waitForFunction(
      () => typeof (window as any).__NEXTCOMPAT_RSC_NAVIGATE__ === "function",
      null,
      { timeout: 10000 },
    );

    // Click a photo link — this should be intercepted and show a modal
    await page.click('a[href="/photos/1"]');

    // Wait for RSC navigation to complete
    await page.waitForTimeout(1000);

    // The modal version of the photo should appear
    await expect(page.locator('[data-testid="photo-modal"]')).toBeVisible({
      timeout: 5000,
    });
  });
});

test.describe("Route Segment Config", () => {
  test("force-dynamic page returns no-store Cache-Control", async ({
    page,
  }) => {
    const response = await page.goto(`${BASE}/dynamic-test`);
    const headers = response?.headers();
    expect(headers?.["cache-control"]).toContain("no-store");
    await expect(page.locator('[data-testid="dynamic-test-page"]')).toBeVisible();
  });

  test("dynamicParams=false returns 404 for unknown params", async ({
    page,
  }) => {
    const response = await page.goto(`${BASE}/products/999`);
    expect(response?.status()).toBe(404);
  });

  test("dynamicParams=false allows known params", async ({ page }) => {
    await page.goto(`${BASE}/products/1`);
    await expect(page.locator('[data-testid="product-page"]')).toBeVisible();
  });
});

test.describe("Template", () => {
  test("root template wraps all pages", async ({ page }) => {
    await page.goto(`${BASE}/`);
    await expect(page.locator('[data-testid="root-template"]')).toBeVisible();
  });

  test("root template is present on sub-pages", async ({ page }) => {
    await page.goto(`${BASE}/about`);
    await expect(page.locator('[data-testid="root-template"]')).toBeVisible();
  });
});

test.describe("Viewport Metadata", () => {
  test("viewport exports render as meta tags", async ({ page }) => {
    await page.goto(`${BASE}/metadata-test`);

    // Theme color should be rendered
    const themeColor = page.locator('meta[name="theme-color"]');
    await expect(themeColor).toHaveAttribute("content", "#0070f3");

    // Color scheme should be rendered
    const colorScheme = page.locator('meta[name="color-scheme"]');
    await expect(colorScheme).toHaveAttribute("content", "light dark");
  });
});
