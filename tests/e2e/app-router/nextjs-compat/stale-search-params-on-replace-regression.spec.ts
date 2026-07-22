/**
 * Ported from Next.js:
 * test/e2e/app-dir/segment-cache/stale-search-params-on-replace-regression/stale-search-params-on-replace-regression.test.ts
 *
 * Upstream fix:
 * https://github.com/vercel/next.js/commit/a7877d776b8a8cb0a5556d84ec75df99b5bdea70
 */

import { expect, test } from "@playwright/test";
import { waitForAppRouterHydration } from "../../helpers";

const BASE = "http://localhost:4174";
const ROUTE = "/nextjs-compat/stale-search-params-on-replace-regression";

test.describe("Next.js compat: stale search params on replace regression", () => {
  test("router.replace to a clean URL clears the search params from the initial load", async ({
    page,
  }) => {
    await page.goto(`${BASE}${ROUTE}?query=param`);
    await waitForAppRouterHydration(page);
    await expect(page.locator("#home")).toHaveText("Home");
    await expect(page.locator("#search-params")).toHaveText("query=param");

    await page.click("#link-to-dummy-1");
    await expect(page.locator("#dummy-page-1")).toHaveText("Dummy Page 1", {
      timeout: 10_000,
    });

    await page.click("#link-to-dummy-2");
    await expect(page.locator("#dummy-page-2")).toHaveText("Dummy Page 2", {
      timeout: 10_000,
    });

    await page.click("#go-home");
    await expect(page.locator("#home")).toHaveText("Home", { timeout: 10_000 });
    await expect(page.locator("#search-params")).toHaveText("");

    await expect
      .poll(() => {
        const url = new URL(page.url());
        return { pathname: url.pathname, search: url.search };
      })
      .toEqual({ pathname: ROUTE, search: "" });
  });
});
