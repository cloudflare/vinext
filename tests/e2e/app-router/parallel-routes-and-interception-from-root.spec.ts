// Ported from Next.js: test/e2e/app-dir/parallel-routes-and-interception-from-root/parallel-routes-and-interception-from-root.test.ts
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/parallel-routes-and-interception-from-root/parallel-routes-and-interception-from-root.test.ts

import { test, expect } from "@playwright/test";
import { waitForAppRouterHydration } from "../helpers";

const BASE = "http://localhost:4174";
const EXAMPLE = `${BASE}/interception-from-root/en/example`;

test.describe("parallel-routes-and-interception-from-root", () => {
  test("(...)[[locale]] interceptor interpolates [locale] correctly", async ({ page }) => {
    // TODO(#1364 Part C): (...) root interception doesn't fire; navigates to the full page instead of modal.
    test.fail();
    // Tests that the (...)[locale]/intercepted pattern matches the locale
    // segment dynamically. The interception lives at:
    //   [locale]/example/@modal/(...)[locale]/intercepted
    // which should intercept navigation to /en/intercepted from anywhere.
    await page.goto(EXAMPLE);
    await waitForAppRouterHydration(page);

    await expect(page.locator("h1")).toHaveText("Example Page");
    // Locale label rendered by the root layout
    await expect(page.locator("#locale-label")).toHaveText("Locale: en");

    await page.click("#intercept-link");

    // The @modal slot shows the intercepted page
    await expect(page.locator("h2")).toHaveText("Page intercepted from root");
    // Locale label is still correct — root layout was not torn down
    await expect(page.locator("#locale-label")).toHaveText("Locale: en");
  });

  test("direct visit to intercepted URL shows full page (not modal)", async ({ page }) => {
    // Direct navigation bypasses the interception — full page renders instead of modal
    await page.goto(`${BASE}/interception-from-root/en/intercepted`);

    await expect(page.locator("h2")).toHaveText("Full intercepted page for locale en");
    // The example page h1 should NOT be present
    await expect(page.locator("h1")).not.toBeVisible();
  });

  test("back navigation after interception returns to example page", async ({ page }) => {
    // TODO(#1364 Part C): depends on (...) interception firing (see test above).
    test.fail();
    await page.goto(EXAMPLE);
    await waitForAppRouterHydration(page);

    await page.click("#intercept-link");
    await expect(page.locator("h2")).toHaveText("Page intercepted from root");

    await page.goBack();
    await expect(page.locator("h1")).toHaveText("Example Page");
    await expect(page.locator("#locale-label")).toHaveText("Locale: en");
  });
});
