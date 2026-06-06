// Ported from Next.js: test/e2e/app-dir/interception-segments-two-levels-above/interception-segments-two-levels-above.test.ts
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/interception-segments-two-levels-above/interception-segments-two-levels-above.test.ts

import { test, expect } from "@playwright/test";
import { waitForAppRouterHydration } from "../helpers";

const BASE = "http://localhost:4174";
const FOO_BAR = `${BASE}/interception-segments-two-levels-above/foo/bar`;
const HOGE = `${BASE}/interception-segments-two-levels-above/hoge`;

test.describe("interception-segments-two-levels-above", () => {
  test("intercepts /hoge with (..)(..) from /foo/bar on soft-nav", async ({ page }) => {
    await page.goto(FOO_BAR);
    await waitForAppRouterHydration(page);

    await page.click("#link-hoge");

    await expect(page.locator("#intercepted")).toBeVisible();
    await expect(page.locator("#hoge")).not.toBeVisible();
  });

  test("hard-nav to /hoge shows real target page (no interception)", async ({ page }) => {
    await page.goto(HOGE);

    await expect(page.locator("#hoge")).toBeVisible();
    await expect(page.locator("#intercepted")).not.toBeVisible();
  });

  test("back navigation after interception returns to /foo/bar", async ({ page }) => {
    await page.goto(FOO_BAR);
    await waitForAppRouterHydration(page);

    await page.click("#link-hoge");
    await expect(page.locator("#intercepted")).toBeVisible();

    await page.goBack();
    await expect(page).toHaveURL(FOO_BAR);
    await expect(page.locator("#foo-bar-page")).toBeVisible();
  });

  test("forward navigation after back restores intercepted view", async ({ page }) => {
    await page.goto(FOO_BAR);
    await waitForAppRouterHydration(page);

    await page.click("#link-hoge");
    await expect(page.locator("#intercepted")).toBeVisible();

    await page.goBack();
    await page.goForward();

    await expect(page.locator("#intercepted")).toBeVisible();
  });

  test("repeated interceptions work consistently", async ({ page }) => {
    for (let i = 0; i < 2; i++) {
      await page.goto(FOO_BAR);
      await waitForAppRouterHydration(page);

      await page.click("#link-hoge");
      await expect(page.locator("#intercepted")).toBeVisible();
    }
  });
});
