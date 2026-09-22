/**
 * Next.js compat: layout state across search param changes.
 *
 * Based on Next.js: test/e2e/app-dir/search-params-react-key/layout-params.test.ts
 * https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/search-params-react-key/layout-params.test.ts
 *
 * Extends the same expectation to a parent client layout rendered by a server layout:
 * query-only push/replace should not remount that layout.
 */

import { expect, test } from "@playwright/test";
import { waitForAppRouterHydration } from "../../helpers";

const BASE = "http://localhost:4174";

test.describe("Next.js compat: layout state across search param changes", () => {
  test("router.push() keeps parent client layout mounted on query-only navigation", async ({
    page,
  }) => {
    await page.goto(`${BASE}/nextjs-compat/layout-search-params/demo`);
    await waitForAppRouterHydration(page);

    await page.click("#layout-increment");
    await page.click("#layout-increment");
    await expect(page.locator("#layout-count")).toHaveText("2");
    await expect(page.locator("#layout-mount-count")).toHaveText("1");

    await page.click("#layout-push");

    await expect(async () => {
      expect(page.url()).toContain("foo=bar");
    }).toPass({ timeout: 10_000 });

    await expect(page.locator("#search-params")).toContainText('"foo":"bar"');
    await expect(page.locator("#layout-count")).toHaveText("2");
    await expect(page.locator("#layout-mount-count")).toHaveText("1");
  });

  test("router.replace() keeps parent client layout mounted on query-only navigation", async ({
    page,
  }) => {
    await page.goto(`${BASE}/nextjs-compat/layout-search-params/demo`);
    await waitForAppRouterHydration(page);

    await page.click("#layout-increment");
    await page.click("#layout-increment");
    await expect(page.locator("#layout-count")).toHaveText("2");
    await expect(page.locator("#layout-mount-count")).toHaveText("1");

    await page.click("#layout-replace");

    await expect(async () => {
      expect(page.url()).toContain("foo=baz");
    }).toPass({ timeout: 10_000 });

    await expect(page.locator("#search-params")).toContainText('"foo":"baz"');
    await expect(page.locator("#layout-count")).toHaveText("2");
    await expect(page.locator("#layout-mount-count")).toHaveText("1");
  });
});
