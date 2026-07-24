import { test, expect } from "@playwright/test";

/**
 * next/image with a custom loader (never touching /_next/image), the
 * zone-aware link wrapper, and zone-driven i18next copy.
 */
test.describe("image loader, zoned links, and zone copy", () => {
  test.fixme("fault-screen art uses the media-proxy loader, not /_next/image", async ({ page }) => {
    const optimizerCalls: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/_next/image")) {
        optimizerCalls.push(request.url());
      }
    });

    await page.goto("/this-page-does-not-exist");
    const art = page.locator('[data-testid="screen-art"] img');
    await expect(art).toHaveAttribute(
      "src",
      /^https:\/\/media\.atlas-fixture\.test\/imgproxy\/w_\d+,q_\d+\//,
    );
    // fill-mode images carry a srcset generated through the same loader.
    await expect(art).toHaveAttribute("srcset", /imgproxy\/w_480/);

    expect(optimizerCalls).toHaveLength(0);
  });

  test("masthead links stay unprefixed in the home zone", async ({ page }) => {
    await page.goto("/journal");
    const first = page.locator('[data-testid="frame-masthead"] nav a').first();
    await expect(first).toHaveAttribute("href", "/gallery/skies");
  });

  test("masthead links carry the zone prefix outside the home zone", async ({ page }) => {
    await page.goto("/ca/journal");
    const first = page.locator('[data-testid="frame-masthead"] nav a').first();
    await expect(first).toHaveAttribute("href", "/ca/gallery/skies");
  });

  test("baseboard links are zoned too", async ({ page }) => {
    await page.goto("/ca/journal");
    const link = page.locator('[data-testid="frame-baseboard"] a').first();
    await expect(link).toHaveAttribute("href", "/ca/journal/about");
  });

  test("i18next serves zone-specific copy with fallback to the base bundle", async ({ page }) => {
    // CA overrides the lookup label…
    await page.goto("/ca/journal");
    await expect(page.locator('[data-testid="masthead-lookup"] input')).toHaveAttribute(
      "aria-label",
      "Look something up, eh",
    );
    // …but falls back to en-US for keys it does not define.
    await expect(page.locator('[data-testid="frame-masthead"] a').first()).toHaveText(
      "Skip to primary region",
    );

    await page.goto("/journal");
    await expect(page.locator('[data-testid="masthead-lookup"] input')).toHaveAttribute(
      "aria-label",
      "Look something up",
    );
  });
});
