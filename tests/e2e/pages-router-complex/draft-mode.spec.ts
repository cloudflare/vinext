import { test, expect } from "@playwright/test";

/**
 * Draft mode is entered through the gateway API route (which resolves a
 * landing path), surfaces as a badge plus draft-flavoured data, and is
 * force-entered by the middleware when the editor header is present.
 */
test.describe("draft mode", () => {
  test("gateway sets the bypass cookie and redirects to the landing path", async ({ request }) => {
    const response = await request.get("/api/draft?draft=on&landing=/journal/about", {
      maxRedirects: 0,
    });
    expect(response.status()).toBe(307);
    expect(response.headers()["location"]).toBe("/journal/about");
    expect(response.headers()["set-cookie"]).toContain("__prerender_bypass");
  });

  test("draft kind/ref resolution picks the right landing", async ({ request }) => {
    const story = await request.get("/api/draft?kind=story&ref=about", {
      maxRedirects: 0,
    });
    expect(story.status()).toBe(307);
    expect(story.headers()["location"]).toBe("/journal/about");

    const wall = await request.get("/api/draft?kind=wall&ref=skies", {
      maxRedirects: 0,
    });
    expect(wall.status()).toBe(307);
    expect(wall.headers()["location"]).toBe("/gallery/skies");
  });

  test("protocol-relative landings are rejected", async ({ request }) => {
    const response = await request.get("/api/draft?landing=//evil.example.test/x", {
      maxRedirects: 0,
    });
    expect(response.status()).toBe(400);
  });

  test("draft mode shows the badge and draft-flavoured page data", async ({ page }) => {
    await page.goto("/api/draft?draft=on&landing=/journal/about");
    await page.waitForURL("**/journal/about");
    await expect(page.locator('[data-testid="draft-badge"]')).toBeVisible();
    await expect(page.locator("h1")).toHaveText("About the atlas (draft)");

    // Leaving draft mode drops the badge and the draft flavour.
    await page.goto("/api/draft?draft=off&landing=/journal/about");
    await page.waitForURL("**/journal/about");
    await expect(page.locator('[data-testid="draft-badge"]')).toHaveCount(0);
    await expect(page.locator("h1")).toHaveText("About the atlas");
  });

  test("editor header without a bypass cookie forces the draft gateway", async ({ request }) => {
    const response = await request.get("/journal/about", {
      maxRedirects: 0,
      headers: { "x-editor-draft": "true" },
    });
    expect(response.status()).toBe(307);
    const location = response.headers()["location"];
    expect(location).toContain("/api/draft?draft=on&landing=");
  });

  test("draft cookies are scrubbed from API-route requests", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto("/api/draft?draft=on&landing=/journal/about");
    await page.waitForURL("**/journal/about");

    // The API route must not see (and therefore not reset) the draft cookies.
    const status = await page.evaluate(async () => {
      const response = await fetch("/api/status");
      return response.status;
    });
    expect(status).toBe(200);

    // The draft cookie survives API traffic — the page is still in draft.
    await page.goto("/journal/about");
    await expect(page.locator('[data-testid="draft-badge"]')).toBeVisible();
    await context.close();
  });
});
