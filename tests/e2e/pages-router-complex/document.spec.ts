import { test, expect } from "@playwright/test";

/**
 * The class-based _document computes a palette from the raw request URL in
 * its own getInitialProps, sets <html lang> from the zone, injects
 * beforeInteractive scripts, and stamps raw inline <script> effects onto
 * <body>.
 */
test.describe("custom _document", () => {
  test("derives the body palette from the request path", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("body")).toHaveAttribute("data-palette", "base");

    await page.goto("/journal");
    await expect(page.locator("body")).toHaveAttribute("data-palette", "story");

    await page.goto("/detail-tools/client-flags");
    await expect(page.locator("body")).toHaveAttribute("data-palette", "service");
  });

  test("palette derivation survives internally rewritten URLs", async ({ page }) => {
    // /ca/journal passes through with an explicit zone segment; the palette
    // logic must still see "journal" behind the prefix.
    await page.goto("/ca/journal");
    await expect(page.locator("body")).toHaveAttribute("data-palette", "story");
  });

  test("sets html lang and body data attributes", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page.locator("body")).toHaveAttribute("data-stack", "atlas");
    // The raw inline <script> runs during parsing, before hydration.
    await expect(page.locator("body")).toHaveAttribute("data-scripted", "true");
  });

  test("request data containing the Main marker name stays inside the Document attribute", async ({
    page,
  }) => {
    // The Document echoes ctx.asPath into <body data-route> before <Main />.
    // The page must still be spliced at <Main />, not into that attribute.
    await page.goto("/lookup?probe=__NEXT_MAIN__&term=owl");

    const body = page.locator("body");
    await expect(body).toHaveAttribute("data-route", /\/lookup\?probe=__NEXT_MAIN__&term=owl$/);
    // Page attributes must not leak onto <body> through a broken data-route.
    await expect(body).not.toHaveAttribute("data-testid");
    await expect(body).not.toHaveAttribute("data-nav-minted-at");
    await expect(page.locator('#__next [data-testid="frame-masthead"]')).toHaveCount(1);
    await expect(page.locator('#__next [data-testid="lookup-results"]')).toHaveAttribute(
      "data-term",
      "owl",
    );
  });

  test("server HTML carries the beforeInteractive bootstrap and preconnects", async ({
    request,
  }) => {
    const html = await (await request.get("/")).text();
    expect(html).toContain("__ATLAS_TRIALS_SDK_KEY__");
    expect(html).toContain('rel="preconnect"');
    expect(html).toContain("https://cdn.atlas-fixture.test");
    // Typeface preload links from the shared component.
    expect(html).toContain("atlas-grotesk-regular.woff2");
  });

  test("_error page carries the classic status-code contract", async ({ page }) => {
    const response = await page.goto("/venues/not-a-venue-id");
    expect(response?.status()).toBe(404);
    await expect(page.locator('[data-testid="fault-screen-404"]')).toBeVisible();
  });
});
