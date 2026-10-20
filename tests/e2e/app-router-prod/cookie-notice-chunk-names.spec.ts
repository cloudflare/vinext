import { expect, test } from "@playwright/test";
import { waitForAppRouterHydration } from "../helpers";

// Cookie-notice blockers match first-party URLs by source-like names: EasyList
// Cookie List blocks `/consent-banner-`, which used to match a `consent-banner`
// client component's `_next/static/chunks/consent-banner-<hash>.js` and break
// hydration of the whole page. Production client JS and CSS are hash-only, so
// a filter on the component's source names blocks nothing.
// Chunk loading checks follow Next.js's
// test/e2e/app-dir/dynamic-chunk-dedupe/dynamic-chunk-dedupe.test.ts
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/dynamic-chunk-dedupe/dynamic-chunk-dedupe.test.ts
test("hydrates and loads dynamic chunks with cookie-notice URL filters enabled", async ({
  page,
}) => {
  const errors: string[] = [];
  const blocked: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route(/\/_next\/static\//, async (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname.includes("consent-banner") || pathname.includes("cookie-banner")) {
      blocked.push(pathname);
      await route.abort("blockedbyclient");
    } else {
      await route.continue();
    }
  });

  await page.goto("/cookie-notice-chunks");
  await waitForAppRouterHydration(page);

  const banner = page.getByTestId("consent-banner");
  await expect(banner).toHaveCSS("border-top-color", "rgb(12, 34, 56)");
  await page.getByRole("button", { name: "Accept cookies", exact: true }).click();
  await expect(page.getByRole("button", { name: "Accepted", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Load details", exact: true }).click();
  await expect(page.getByTestId("cookie-details")).toHaveText("Cookie details loaded");

  // Client navigation keeps the document (no reload through a failed chunk).
  await page.evaluate(() => {
    document.documentElement.dataset.navigationMarker = "preserved";
  });
  await page.getByRole("link", { name: "Other page", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Other page loaded" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-navigation-marker", "preserved");

  expect(blocked).toEqual([]);
  expect(errors).toEqual([]);
});
