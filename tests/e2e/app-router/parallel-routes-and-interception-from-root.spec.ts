// Ported from Next.js: test/e2e/app-dir/parallel-routes-and-interception-from-root/parallel-routes-and-interception-from-root.test.ts
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/parallel-routes-and-interception-from-root/parallel-routes-and-interception-from-root.test.ts

import { test, expect } from "@playwright/test";
import { waitForAppRouterHydration } from "../helpers";

const BASE = "http://localhost:4174";
const EXAMPLE = `${BASE}/interception-from-root/en/example`;

test.describe("parallel-routes-and-interception-from-root", () => {
  test("(...) interceptor interpolates [locale] correctly", async ({ page }) => {
    // The interception resolves from the app root and has no direct destination
    // page, matching Next.js' parallel-routes-and-interception-from-root fixture.
    // It lives at:
    //   [locale]/example/@modal/(...)interception-from-root/[locale]/intercepted
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

  test("direct visit to interception-only URL returns not found", async ({ page }) => {
    const response = await page.goto(`${BASE}/interception-from-root/en/intercepted`);
    expect(response?.status()).toBe(404);
  });

  test("back navigation after interception returns to example page", async ({ page }) => {
    await page.goto(EXAMPLE);
    await waitForAppRouterHydration(page);

    await page.click("#intercept-link");
    await expect(page.locator("h2")).toHaveText("Page intercepted from root");

    await page.goBack();
    await expect(page.locator("h1")).toHaveText("Example Page");
    await expect(page.locator("#locale-label")).toHaveText("Locale: en");
  });
});
