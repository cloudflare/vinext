import { test, expect } from "@playwright/test";

const BASE = "http://localhost:4174";

test.describe("App Router SSR", () => {
  test("home page renders SSR HTML without JavaScript", async ({ page }) => {
    // Block all JS to verify SSR-only content
    await page.route("**/*.js", (route) => route.abort());
    await page.route("**/*.mjs", (route) => route.abort());

    await page.goto(`${BASE}/`);

    await expect(page.locator("h1")).toHaveText("Welcome to App Router");
    await expect(page.locator("p")).toContainText(
      "This is the home page rendered as a Server Component.",
    );
  });

  test("root layout wraps the page with html/head/body", async ({ page }) => {
    await page.goto(`${BASE}/`);

    // Root layout provides <html lang="en">
    const html = page.locator("html");
    await expect(html).toHaveAttribute("lang", "en");

    // Head should contain charset and title
    const title = await page.title();
    expect(title).toBe("App Basic");
  });

  test("about page renders server component content", async ({ page }) => {
    await page.goto(`${BASE}/about`);

    await expect(page.locator("h1")).toHaveText("About");
    await expect(page.locator("p")).toContainText("This is the about page.");
  });

  test("dynamic route renders with params", async ({ page }) => {
    await page.goto(`${BASE}/blog/hello-world`);

    await expect(page.locator("h1")).toHaveText("Blog Post");
    await expect(page.locator("p")).toContainText("Slug: hello-world");
  });

  test("nested layout wraps dashboard pages", async ({ page }) => {
    await page.goto(`${BASE}/dashboard`);

    // Dashboard layout should be present
    await expect(page.locator("#dashboard-layout")).toBeVisible();
    await expect(page.locator("#dashboard-layout > nav span")).toHaveText(
      "Dashboard Nav",
    );
    await expect(page.locator("h1")).toHaveText("Dashboard");
  });

  test("nested layout persists for sub-pages", async ({ page }) => {
    await page.goto(`${BASE}/dashboard/settings`);

    // Same dashboard layout should wrap settings page
    await expect(page.locator("#dashboard-layout")).toBeVisible();
    await expect(page.locator("#dashboard-layout > nav span")).toHaveText(
      "Dashboard Nav",
    );
    await expect(page.locator("h1")).toHaveText("Settings");
  });

  test("interactive page SSR includes client component HTML", async ({
    page,
  }) => {
    // Block JS to verify the "use client" Counter still renders HTML via SSR
    await page.route("**/*.js", (route) => route.abort());
    await page.route("**/*.mjs", (route) => route.abort());

    await page.goto(`${BASE}/interactive`);

    await expect(page.locator("h1")).toHaveText("Interactive Page");
    // Counter should be SSR-rendered with initial count
    await expect(page.locator('[data-testid="count"]')).toContainText(
      "Count:",
    );
  });

  test("custom 404 page renders for unknown routes", async ({ page }) => {
    const response = await page.goto(`${BASE}/nonexistent-page`);

    expect(response?.status()).toBe(404);
    await expect(page.locator("h1")).toHaveText("404 - Page Not Found");
  });
});
