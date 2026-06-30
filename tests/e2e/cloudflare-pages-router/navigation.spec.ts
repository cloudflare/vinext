import { test, expect } from "@playwright/test";

const BASE = "http://localhost:4177";

test.describe("Pages Router navigation on Cloudflare Workers", () => {
  test("Link components render as anchor tags", async ({ page }) => {
    await page.goto(BASE + "/");
    const aboutLink = page.locator('a[href="/about"]');
    await expect(aboutLink).toBeVisible();
    await expect(aboutLink).toHaveText("About");
  });

  test("clicking a link navigates to the target page", async ({ page }) => {
    await page.goto(BASE + "/");
    // Wait for hydration before clicking
    await page.waitForTimeout(2000);
    await page.click('a[href="/about"]');
    await page.waitForURL("**/about");
    await expect(page.locator("h1")).toHaveText("About");
  });

  test("direct navigation to different pages works", async ({ page }) => {
    // Navigate directly to about
    await page.goto(BASE + "/about");
    await expect(page.locator("h1")).toHaveText("About");

    // Navigate directly to home
    await page.goto(BASE + "/");
    await expect(page.locator("h1")).toHaveText("Hello from Pages Router on Workers!");
  });

  test("concrete page wins before afterFiles rewrites in the built Worker", async ({ page }) => {
    await page.goto(BASE + "/nav-test");
    await expect(page.locator("h1")).toHaveText("Navigation Test");
    await expect(page.locator("body")).not.toContainText("This is the about page");
  });

  test("each page has correct __NEXT_DATA__.page value", async ({ page }) => {
    // Home
    let res = await page.goto(BASE + "/");
    let html = await res!.text();
    expect(html).toContain('"page":"/"');

    // About
    res = await page.goto(BASE + "/about");
    html = await res!.text();
    expect(html).toContain('"page":"/about"');

    // SSR
    res = await page.goto(BASE + "/ssr");
    html = await res!.text();
    expect(html).toContain('"page":"/ssr"');
  });

  // Regression guard for PR #1412: a Link click on a hydrated Pages Router app
  // must fetch /_next/data/<buildId>/<page>.json (the JSON data endpoint) and
  // re-render in place — no document reload. If the build pipeline regresses
  // and stops exposing __VINEXT_PAGE_LOADERS__, navigateClient() silently falls
  // back to the HTML extraction path; the URL changes and the new page renders,
  // so every other navigation test still passes, but the JSON-path optimisation
  // is gone. This test fails loudly in that scenario by asserting (a) the data
  // URL was fetched or reused from prefetch, and (b) a window-scoped sentinel
  // installed before the click survives — a document reload would wipe globals,
  // an in-place re-render preserves them.
  test("Link click uses /_next/data JSON, not full HTML", async ({ page }) => {
    const dataRequests: string[] = [];
    page.on("request", (req) => {
      const url = req.url();
      if (url.includes("/_next/data/") && url.endsWith("/ssr.json")) {
        dataRequests.push(url);
      }
    });

    await page.goto(BASE + "/");
    // Wait for hydration to expose the loader manifest.
    await page.waitForFunction(() => (window as any).__VINEXT_HYDRATED_AT !== undefined);

    const buildId = await page.evaluate(() => (window as any).__NEXT_DATA__.buildId);
    expect(buildId).toBeTruthy();

    // Install a sentinel on window. A document reload wipes the global object;
    // an in-place re-render via the JSON path leaves it untouched.
    await page.evaluate(() => {
      (window as any).__navTestSentinel = "alive";
    });

    await page.hover('a[href="/ssr"]');
    await expect.poll(() => dataRequests.length).toBe(1);
    expect(dataRequests[0]).toContain(`/_next/data/${buildId}/ssr.json`);

    await page.click('a[href="/ssr"]');
    await page.waitForURL("**/ssr");
    await expect(page.locator("h1")).toHaveText("Server-Side Rendered on Workers");

    // The JSON endpoint must have been hit once by prefetch and then reused for navigation.
    expect(dataRequests).toHaveLength(1);
    // No document reload — sentinel survived the navigation.
    const sentinel = await page.evaluate(() => (window as any).__navTestSentinel);
    expect(sentinel).toBe("alive");
  });
});
