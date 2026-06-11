// Regression test ported from the Next.js deploy suite:
// .nextjs-ref/test/e2e/app-dir/pages-to-app-routing/pages-to-app-routing.test.ts
//   → "should work using browser"
//
// In a hybrid build (app/ + pages/), clicking a Next.js <Link> on a Pages
// Router page that points to an App Router destination must result in a hard
// navigation to the App Router page — not an in-place SPA swap that the Pages
// Router client cannot complete.
//
// The mechanism: when the Pages Router <Link> component runs its prefetch
// for /about it detects (via __VINEXT_LINK_PREFETCH_ROUTES__) that /about is
// an App Router route and records  `router.components["/about"] = {
// __appRouter: true }`. On click, performNavigation() checks for that marker
// and immediately calls window.location.assign/replace rather than attempting
// a Pages Router fetch cycle.
//
// Fixture:
//   tests/fixtures/app-basic/pages/pages-to-app/[slug].tsx  (Pages Router, GSSP)
//   tests/fixtures/app-basic/app/about/page.tsx             (App Router)
import { test, expect } from "@playwright/test";
import { waitForHydration, waitForAppRouterHydration } from "../helpers";

const BASE = "http://localhost:4174";

test.describe("pages-to-app-routing: navigate from Pages Router to App Router via Link", () => {
  test("renders GSSP params on the Pages Router page", async ({ page }) => {
    await page.goto(`${BASE}/pages-to-app/hello`);
    await waitForHydration(page);

    await expect(page.locator("#params")).toHaveText('Params: {"slug":"hello"}');
  });

  test("clicking Link navigates to the App Router /about page", async ({ page }) => {
    await page.goto(`${BASE}/pages-to-app/abc`);
    await waitForHydration(page);

    await expect(page.locator("#params")).toHaveText('Params: {"slug":"abc"}');

    // Clicking the link must navigate to the App Router /about page.
    // Because /about is an App Router route, a hard navigation is triggered;
    // wait for App Router hydration to make the App Router landing explicit
    // rather than only asserting on the new DOM.
    await page.click("#to-about-link");
    await waitForAppRouterHydration(page);
    await expect(page.locator("#app-page")).toHaveText("About");
    expect(page.url()).toContain("/about");
  });
});
