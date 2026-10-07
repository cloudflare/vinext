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

  test("preserves source client state when middleware rewrites the matched pathname", async ({
    page,
  }) => {
    await page.goto(HOME);
    await waitForAppRouterHydration(page);
    await page.locator("#interception-mw-source-increment").click();
    await expect(page.locator("#interception-mw-source-count")).toHaveText("1");

    await page.click("#link-foo-p-1");
    await expect(page.locator("#modal")).toContainText("intercepted");
    await expect(page.locator("#interception-mw-source-count")).toHaveText("1");
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

// Extends the upstream test with a dynamic source below the locale root, so
// the source itself is rewritten. Next.js keeps App Router params encoded as
// they appear in the URL, except that an escaped ASCII character renders
// unescaped (`%61` as `a`, `%7e` as `~`), and opens the modal from each of these
// sources.
test.describe("interception-dynamic-segment-middleware from an encoded source", () => {
  for (const [segment, tag] of [
    ["plain", "plain"],
    ["caf%C3%A9", "caf%C3%A9"],
    ["a%2Fb", "a%2Fb"],
    ["%2561", "%2561"],
    ["%252561", "%252561"],
    ["100%25", "100%25"],
    ["%61", "a"],
    ["%7e", "~"],
  ]) {
    test(`intercepts from /interception-mw/tags/${segment}`, async ({ page }) => {
      await page.goto(`${HOME}/tags/${segment}`);
      await waitForAppRouterHydration(page);
      await expect(page.locator("#tag-param")).toHaveText(tag);

      await page.click("#link-foo-p-1");

      await expect(page.locator("#modal")).toContainText("intercepted");
      await expect(page).toHaveURL(`${HOME}/foo/p/1`);
      // The source page stays mounted under the modal with its params intact.
      await expect(page.locator("#tag-param")).toHaveText(tag);
    });
  }
});
