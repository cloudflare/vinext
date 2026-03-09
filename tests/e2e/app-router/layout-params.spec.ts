import { test, expect } from "@playwright/test";

/**
 * Regression: layout components receive correct `params` in renderHTTPAccessFallbackPage.
 *
 * When the page calls notFound(), renderHTTPAccessFallbackPage re-renders the
 * layout tree wrapping the not-found boundary. Before the fix, layouts received
 * `{}` instead of the real matched params — so `await params` gave `{}`, slug
 * was undefined, and the wrapper rendered with data-slug="" (or crashed).
 *
 * Fixture: app/nextjs-compat/layout-params-notfound/[slug]/
 *
 *   layout.tsx    — always renders; reads `await params` and sets data-slug on
 *                   the wrapper div. With the fix, data-slug="bad-slug". Without
 *                   it, data-slug="" (slug is undefined because params was {}).
 *   page.tsx      — calls notFound() for slugs not in VALID_SLUGS, so
 *                   renderHTTPAccessFallbackPage is always invoked for invalid slugs.
 *   not-found.tsx — renders #layout-params-notfound-boundary inside the layout
 *                   wrapper, so both the boundary and the wrapper are in the DOM.
 *
 * The key assertion is:
 *   #layout-params-notfound-wrapper[data-slug="bad-slug"] is visible
 *
 * This can only be true if renderHTTPAccessFallbackPage passed the real matched
 * params to the layout. If it passed {}, data-slug would be "" or "undefined".
 */

const BASE = "http://localhost:4174";

async function waitForHydration(page: import("@playwright/test").Page) {
  await expect(async () => {
    const ready = await page.evaluate(() => !!(window as any).__VINEXT_RSC_ROOT__);
    expect(ready).toBe(true);
  }).toPass({ timeout: 10_000 });
}

test.describe("layout params in fallback render (renderHTTPAccessFallbackPage)", () => {
  /**
   * Baseline: valid slug — layout renders, page renders, params are correct.
   */
  test("valid slug: layout renders with correct data-slug", async ({ page }) => {
    await page.goto(`${BASE}/nextjs-compat/layout-params-notfound/hello`);
    await waitForHydration(page);

    await expect(page.locator("#layout-params-notfound-wrapper")).toHaveAttribute(
      "data-slug",
      "hello",
    );
    await expect(page.locator("#layout-params-notfound-page")).toHaveText(
      "Page content for: hello",
    );
  });

  /**
   * Regression: page calls notFound() for an invalid slug. renderHTTPAccessFallbackPage
   * must re-render the layout with the real params. The data-slug attribute on the
   * wrapper proves the layout received { slug: "bad-slug" }, not {}.
   */
  test("invalid slug: layout wrapper has correct data-slug in not-found render", async ({
    page,
  }) => {
    await page.goto(`${BASE}/nextjs-compat/layout-params-notfound/bad-slug`);

    // Not-found boundary must be rendered
    await expect(page.locator("#layout-params-notfound-boundary")).toBeVisible({ timeout: 10_000 });

    // The layout wrapper must have data-slug="bad-slug" — proves renderHTTPAccessFallbackPage
    // forwarded the real matched params to the layout, not {}.
    await expect(page.locator("#layout-params-notfound-wrapper")).toHaveAttribute(
      "data-slug",
      "bad-slug",
    );
  });

  /**
   * Different invalid slug — confirms the actual param value is forwarded,
   * not just that some truthy object was passed.
   */
  test("another invalid slug: wrapper has correct data-slug", async ({ page }) => {
    await page.goto(`${BASE}/nextjs-compat/layout-params-notfound/nope`);

    await expect(page.locator("#layout-params-notfound-boundary")).toBeVisible({ timeout: 10_000 });

    await expect(page.locator("#layout-params-notfound-wrapper")).toHaveAttribute(
      "data-slug",
      "nope",
    );
  });

  /**
   * Client-side navigation from valid to invalid slug — the RSC fetch path
   * also goes through renderHTTPAccessFallbackPage for notFound().
   */
  test("client-side navigation to invalid slug: wrapper has correct data-slug", async ({
    page,
  }) => {
    await page.goto(`${BASE}/nextjs-compat/layout-params-notfound/hello`);
    await waitForHydration(page);

    await expect(page.locator("#layout-params-notfound-wrapper")).toHaveAttribute(
      "data-slug",
      "hello",
    );

    await page.goto(`${BASE}/nextjs-compat/layout-params-notfound/bad-slug`);

    await expect(page.locator("#layout-params-notfound-boundary")).toBeVisible({ timeout: 10_000 });

    await expect(page.locator("#layout-params-notfound-wrapper")).toHaveAttribute(
      "data-slug",
      "bad-slug",
    );
  });
});
