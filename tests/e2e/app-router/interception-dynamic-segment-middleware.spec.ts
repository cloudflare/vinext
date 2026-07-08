// Ported from Next.js: test/e2e/app-dir/interception-dynamic-segment-middleware/interception-dynamic-segment-middleware.test.ts
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/interception-dynamic-segment-middleware/interception-dynamic-segment-middleware.test.ts

import { test, expect } from "@playwright/test";
import { waitForAppRouterHydration } from "../helpers";

const BASE = "http://localhost:4174";
const HOME = `${BASE}/interception-mw`;

test.describe("interception-dynamic-segment-middleware", () => {
  test("intercepts dynamic route when middleware rewrites add locale prefix", async ({ page }) => {
    await page.goto(HOME);
    await waitForAppRouterHydration(page);

    // Click the link that points to /interception-mw/foo/p/1 (no locale).
    // Middleware rewrites it to /interception-mw/en/foo/p/1, triggering interception.
    await page.click("#link-foo-p-1");

    await expect(page.locator("#modal")).toContainText("intercepted");
  });

  test("refresh after interception shows non-intercepted page", async ({ page }) => {
    await page.goto(HOME);
    await waitForAppRouterHydration(page);

    await page.click("#link-foo-p-1");
    await expect(page.locator("#modal")).toContainText("intercepted");

    // Hard refresh — modal slot falls back to default, children shows full page
    await page.reload();

    await expect(page.locator("#modal")).toContainText("default");
    await expect(page.locator("#children")).toContainText("not intercepted");
  });

  test("back/forward navigation preserves intercepted state with middleware active", async ({
    page,
  }) => {
    await page.goto(HOME);
    await waitForAppRouterHydration(page);

    await page.click("#link-foo-p-1");
    await expect(page.locator("#modal")).toContainText("intercepted");

    await page.goBack();
    await expect(page).toHaveURL(HOME);

    await page.goForward();
    await expect(page.locator("#modal")).toContainText("intercepted");
  });

  test("repeated interceptions with middleware work consistently", async ({ page }) => {
    for (let i = 0; i < 2; i++) {
      await page.goto(HOME);
      await waitForAppRouterHydration(page);

      await page.click("#link-foo-p-1");
      await expect(page.locator("#modal")).toContainText("intercepted");
    }
  });
});
