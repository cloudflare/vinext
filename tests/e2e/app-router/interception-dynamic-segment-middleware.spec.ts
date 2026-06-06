// Ported from Next.js: test/e2e/app-dir/interception-dynamic-segment-middleware/interception-dynamic-segment-middleware.test.ts
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/interception-dynamic-segment-middleware/interception-dynamic-segment-middleware.test.ts

import { test, expect } from "@playwright/test";
import { waitForAppRouterHydration } from "../helpers";

const BASE = "http://localhost:4174";
// Middleware rewrites /interception-mw/foo/p/1 → /interception-mw/en/foo/p/1
// so the app sees /en as the [locale] segment and [username]=foo, [id]=1.
const LOCALE_HOME = `${BASE}/interception-mw/en`;

test.describe("interception-dynamic-segment-middleware", () => {
  test("intercepts dynamic route when middleware rewrites add locale prefix", async ({ page }) => {
    // TODO(#1364 Part C): interception doesn't fire when middleware rewrites add a locale prefix.
    test.fail();
    await page.goto(LOCALE_HOME);
    await waitForAppRouterHydration(page);

    // Click the link that points to /interception-mw/foo/p/1 (no locale).
    // Middleware rewrites it to /interception-mw/en/foo/p/1, triggering interception.
    await page.click("#link-foo-p-1");

    await expect(page.locator("#modal")).toContainText("intercepted");
  });

  test("refresh after interception shows non-intercepted page", async ({ page }) => {
    // TODO(#1364 Part C): depends on interception firing (see test above).
    test.fail();
    await page.goto(LOCALE_HOME);
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
    // TODO(#1364 Part C): depends on interception firing (see test above).
    test.fail();
    await page.goto(LOCALE_HOME);
    await waitForAppRouterHydration(page);

    await page.click("#link-foo-p-1");
    await expect(page.locator("#modal")).toContainText("intercepted");

    await page.goBack();
    await expect(page).toHaveURL(LOCALE_HOME);

    await page.goForward();
    await expect(page.locator("#modal")).toContainText("intercepted");
  });

  test("repeated interceptions with middleware work consistently", async ({ page }) => {
    // TODO(#1364 Part C): depends on interception firing (see test above).
    test.fail();
    for (let i = 0; i < 2; i++) {
      await page.goto(LOCALE_HOME);
      await waitForAppRouterHydration(page);

      await page.click("#link-foo-p-1");
      await expect(page.locator("#modal")).toContainText("intercepted");
    }
  });
});
