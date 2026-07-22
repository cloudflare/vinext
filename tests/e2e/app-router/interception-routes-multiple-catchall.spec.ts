// Ported from Next.js: test/e2e/app-dir/interception-routes-multiple-catchall/interception-routes-multiple-catchall.test.ts
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/interception-routes-multiple-catchall/interception-routes-multiple-catchall.test.ts

import { test, expect } from "@playwright/test";
import { waitForAppRouterHydration } from "../helpers";

const BASE = "http://localhost:4174";
const TEMPLATES_MULTI = `${BASE}/interception-routes-multiple-catchall/templates/multi/slug`;

test.describe("interception-routes-multiple-catchall", () => {
  test("soft-nav from templates to showcase shows intercepting page", async ({ page }) => {
    await page.goto(TEMPLATES_MULTI);
    await waitForAppRouterHydration(page);

    await page.click("#to-showcase-catchall");

    await expect(page.locator("#intercepting-page")).toBeVisible();
    await expect(page.locator("#root-catchall")).not.toBeVisible();
  });

  test("soft-nav to showcase/single from templates shows intercepting page", async ({ page }) => {
    await page.goto(TEMPLATES_MULTI);
    await waitForAppRouterHydration(page);

    await page.click("#to-showcase-single");

    await expect(page.locator("#intercepting-page")).toBeVisible();
  });

  test("soft-nav to showcase/another/slug from templates shows intercepting page", async ({
    page,
  }) => {
    await page.goto(TEMPLATES_MULTI);
    await waitForAppRouterHydration(page);

    await page.click("#to-showcase-another");

    await expect(page.locator("#intercepting-page")).toBeVisible();
  });

  test("hard-nav to showcase URL shows root catch-all (no interception)", async ({ page }) => {
    await page.goto(`${BASE}/interception-routes-multiple-catchall/showcase/new`);

    await expect(page.locator("#root-catchall")).toBeVisible();
    await expect(page.locator("#intercepting-page")).not.toBeVisible();
  });
});
