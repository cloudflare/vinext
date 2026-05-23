import { test, expect } from "@playwright/test";
import { waitForAppRouterHydration } from "../../helpers";

const BASE = "http://localhost:4174";
const ROUTE = "/nextjs-compat/server-actions-relative-redirect";

test.describe("Next.js compat: server-actions-relative-redirect", () => {
  // Ported from Next.js: test/e2e/app-dir/server-actions-relative-redirect/server-actions-relative-redirect.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/server-actions-relative-redirect/server-actions-relative-redirect.test.ts
  test("should work with relative redirect", async ({ page }) => {
    await page.goto(`${BASE}${ROUTE}`);
    await waitForAppRouterHydration(page);

    await page.locator("#relative-redirect").click();

    await expect(page.locator("#page-loaded")).toHaveText("hello nested page");
    await expect(page).toHaveURL(`${BASE}${ROUTE}/subpage`);
  });

  // Ported from Next.js: test/e2e/app-dir/server-actions-relative-redirect/server-actions-relative-redirect.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/server-actions-relative-redirect/server-actions-relative-redirect.test.ts
  test("should work with absolute redirect", async ({ page }) => {
    await page.goto(`${BASE}${ROUTE}`);
    await waitForAppRouterHydration(page);

    await page.locator("#absolute-redirect").click();

    await expect(page.locator("#page-loaded")).toHaveText("hello nested page");
    await expect(page).toHaveURL(`${BASE}${ROUTE}/subpage`);
  });

  // Ported from Next.js: test/e2e/app-dir/server-actions-relative-redirect/server-actions-relative-redirect.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/server-actions-relative-redirect/server-actions-relative-redirect.test.ts
  test("should work with relative redirect from subdir", async ({ page }) => {
    await page.goto(`${BASE}${ROUTE}/subdir`);
    await waitForAppRouterHydration(page);

    await page.locator("#relative-subdir-redirect").click();

    await expect(page.locator("#page-loaded")).toHaveText("hello subdir nested page");
    await expect(page).toHaveURL(`${BASE}${ROUTE}/subdir/subpage`);
  });

  // Ported from Next.js: test/e2e/app-dir/server-actions-relative-redirect/server-actions-relative-redirect.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/server-actions-relative-redirect/server-actions-relative-redirect.test.ts
  test("should work with absolute redirect from subdir", async ({ page }) => {
    await page.goto(`${BASE}${ROUTE}/subdir`);
    await waitForAppRouterHydration(page);

    await page.locator("#absolute-subdir-redirect").click();

    await expect(page.locator("#page-loaded")).toHaveText("hello nested page");
    await expect(page).toHaveURL(`${BASE}${ROUTE}/subpage`);
  });

  // Ported from Next.js: test/e2e/app-dir/server-actions-relative-redirect/server-actions-relative-redirect.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/server-actions-relative-redirect/server-actions-relative-redirect.test.ts
  test("should work with multi-level relative redirect from subdir without a document reload", async ({
    page,
  }) => {
    await page.goto(`${BASE}${ROUTE}/subdir`);
    await waitForAppRouterHydration(page);
    await page.evaluate(() => {
      Reflect.set(window, "notReloaded", true);
    });

    await page.locator("#multi-relative-subdir-redirect").click();

    await expect(page.locator("#page-loaded")).toHaveText("hello nested page");
    await expect(page).toHaveURL(`${BASE}${ROUTE}/subpage`);
    await expect.poll(() => page.evaluate(() => Reflect.get(window, "notReloaded"))).toBe(true);
  });

  test("default push redirects scroll to top and restore previous scroll on back", async ({
    page,
  }) => {
    await page.goto(`${BASE}${ROUTE}/scroll`);
    await waitForAppRouterHydration(page);
    await expect(page.locator("#page-loaded")).toHaveText("checkout page");
    await page.evaluate(() => window.scrollTo(0, 900));
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(800);

    await page.click("#default-push-redirect");
    await expect(page).toHaveURL(`${BASE}${ROUTE}/receipt`);
    await expect(page.locator("#page-loaded")).toHaveText("receipt page");
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);

    await page.goBack();
    await expect(page).toHaveURL(`${BASE}${ROUTE}/scroll`);
    await expect(page.locator("#page-loaded")).toHaveText("checkout page");
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(800);
  });
});
