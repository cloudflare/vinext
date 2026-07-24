import { test, expect } from "@playwright/test";

const redirectPath = (headers: Record<string, string>) =>
  new URL(headers["location"], "http://x").pathname;

/**
 * URL hygiene on the gallery catch-all: dedupe redirects, character
 * scrubbing, deep-trail collapses, and static siblings that must win
 * precedence over the catch-all.
 */
test.describe("catch-all guards and precedence", () => {
  test("repeated facet segments bounce to the deduplicated wall", async ({ request }) => {
    const response = await request.get("/gallery/skies/skies", {
      maxRedirects: 0,
    });
    expect(response.status()).toBe(307);
    expect(redirectPath(response.headers())).toBe("/gallery/skies");
  });

  test.fixme("uppercase wall paths are scrubbed to the public canonical form", async ({
    request,
  }) => {
    const response = await request.get("/gallery/SKIES", { maxRedirects: 0 });
    expect(response.status()).toBe(307);
    // The destination must be the public URL — no internal zone prefix.
    expect(redirectPath(response.headers())).toBe("/gallery/skies");
    // Scrub redirects are deliberately uncacheable at the surrogate tier.
    expect(response.headers()["surrogate-control"]).toBe("no-store, delta=noop");
  });

  test("overly deep facet trails collapse permanently", async ({ request }) => {
    const response = await request.get("/gallery/skies/clips/extra", {
      maxRedirects: 0,
    });
    expect(response.status()).toBe(308);
    expect(redirectPath(response.headers())).toBe("/gallery/skies/clips");
  });

  test("static siblings beat the gallery catch-all", async ({ page }) => {
    await page.goto("/gallery/curated/first");
    await expect(page.locator('[data-testid="curated-wall"]')).toHaveAttribute("data-rank", "1");
    await expect(page.locator('[data-testid="gallery-wall"]')).toHaveCount(0);
  });

  test("unknown walls are 404s", async ({ request }) => {
    const response = await request.get("/gallery/unknown-wall");
    expect(response.status()).toBe(404);
  });

  test("lookup without a term is a 404", async ({ request }) => {
    const response = await request.get("/lookup");
    expect(response.status()).toBe(404);
  });

  test("lookup renders matches for a term", async ({ page }) => {
    await page.goto("/lookup?term=owl");
    await expect(page.locator('[data-testid="lookup-results"]')).toHaveAttribute(
      "data-term",
      "owl",
    );
    await expect(page.locator('[data-testid="lookup-results"] li').first()).toContainText("(owl)");
  });
});
