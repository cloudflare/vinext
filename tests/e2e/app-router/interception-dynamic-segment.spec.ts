// Ported from Next.js: test/e2e/app-dir/interception-dynamic-segment/interception-dynamic-segment.test.ts
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/interception-dynamic-segment/interception-dynamic-segment.test.ts

import { test, expect } from "@playwright/test";
import { waitForAppRouterHydration } from "../helpers";

const BASE = "http://localhost:4174";
const ROOT = `${BASE}/interception-dyn-seg`;

test.describe("interception-dynamic-segment", () => {
  test("intercepts dynamic [username]/[id] route with (.) from home", async ({ page }) => {
    await page.goto(ROOT);
    await waitForAppRouterHydration(page);

    await page.click("#link-foo-1");

    // Client navigation — modal slot should show intercepted content
    await expect(page.locator("#modal")).toContainText("intercepted");
    // The catch-all fallback should NOT be visible during interception
    await expect(page.locator("#modal")).not.toContainText("catch-all");
  });

  test("refresh after interception shows full page (not intercepted)", async ({ page }) => {
    await page.goto(ROOT);
    await waitForAppRouterHydration(page);

    await page.click("#link-foo-1");
    await expect(page.locator("#modal")).toContainText("intercepted");

    // Hard refresh should serve the direct (non-intercepted) response
    await page.reload();

    await expect(page.locator("#modal")).toContainText("catch-all");
    await expect(page.locator("#children")).toContainText("not intercepted");
  });

  test("back/forward navigation preserves intercepted state", async ({ page }) => {
    await page.goto(ROOT);
    await waitForAppRouterHydration(page);

    await page.click("#link-foo-1");
    await expect(page.locator("#modal")).toContainText("intercepted");

    await page.goBack();
    await expect(page).toHaveURL(ROOT);

    await page.goForward();
    await expect(page.locator("#modal")).toContainText("intercepted");
  });

  test("repeated interceptions from home work consistently", async ({ page }) => {
    await page.goto(ROOT);
    await waitForAppRouterHydration(page);

    for (let i = 0; i < 2; i++) {
      await page.goto(ROOT);
      await waitForAppRouterHydration(page);

      await page.click("#link-foo-1");
      await expect(page.locator("#modal")).toContainText("intercepted");
    }
  });

  test("intercepts (.)test-nested with @sidebar parallel route", async ({ page }) => {
    await page.goto(ROOT);
    await waitForAppRouterHydration(page);

    await page.click("#link-test-nested");

    // Modal slot shows intercepted sidebar content
    await expect(page.locator("#modal")).toContainText("Intercepted test-nested sidebar");
    // Children slot should still contain the home page content
    await expect(page.locator("#children")).toContainText("CHILDREN SLOT");
  });

  test("direct visit to test-nested shows actual page (not intercepted)", async ({ page }) => {
    await page.goto(`${ROOT}/test-nested`);

    await expect(page.locator("body")).toContainText("Actual test-nested page");
    await expect(page.locator("body")).toContainText("Actual test-nested sidebar");
  });
});
