import { test, expect } from "@playwright/test";

/**
 * Zone routing is deliberately simple: URLs may carry one optional leading
 * zone segment. The home zone (us) is hidden from public URLs — spelling it
 * out redirects to the canonical form; zoneless paths are rewritten into the
 * home zone; other zones pass straight through to the `[zone]` route.
 */
test.describe("zone routing middleware", () => {
  test("serves the front door at / via rewrite and tags the zone header", async ({ request }) => {
    const response = await request.get("/", { maxRedirects: 0 });
    expect(response.status()).toBe(200);
    expect(response.headers()["x-zone"]).toBe("us");
    expect(await response.text()).toContain('data-testid="front-heading"');
  });

  test("redirects spelled-out home-zone URLs to the canonical form", async ({ request }) => {
    const response = await request.get("/us/journal", { maxRedirects: 0 });
    expect([307, 308]).toContain(response.status());
    expect(new URL(response.headers()["location"], "http://x").pathname).toBe("/journal");
  });

  test("passes non-home zone URLs straight through", async ({ request }) => {
    const response = await request.get("/ca/journal", { maxRedirects: 0 });
    expect(response.status()).toBe(200);
    expect(response.headers()["x-zone"]).toBe("ca");
  });

  test("zone changes server-rendered data", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator('[data-testid="front-heading"]')).toHaveText(
      "Welcome to the us atlas",
    );

    await page.goto("/ca");
    await expect(page.locator('[data-testid="front-heading"]')).toHaveText(
      "Welcome to the ca atlas",
    );
  });

  test("exempt paths skip zone routing", async ({ request }) => {
    const response = await request.get("/api/status", { maxRedirects: 0 });
    expect(response.status()).toBe(200);
    expect(response.headers()["x-zone"]).toBeUndefined();
  });
});
