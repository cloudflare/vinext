/**
 * Next.js Compat E2E: useRouter().bfcacheId
 * Ported from: https://github.com/vercel/next.js/blob/56d95137fd6d84f4bc1e5ef2bb31e0136d5fad9c/test/e2e/app-dir/use-router-bfcache-id/use-router-bfcache-id.test.ts
 */

import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { waitForAppRouterHydration } from "../../helpers";

const BASE = "http://localhost:4174";
const ROUTE = "/nextjs-compat/use-router-bfcache-id";

async function revealAndClick(page: Page, href: string) {
  await page.locator(`input[data-link-accordion="${href}"]`).first().check();
  await page.locator(`a[href="${href}"]`).first().click();
}

test.describe("Next.js compat: useRouter().bfcacheId", () => {
  test("mints bfcacheIds for fresh leaf navigations and restores them on history traversal", async ({
    page,
  }) => {
    await page.goto(`${BASE}${ROUTE}/x/1`);
    await waitForAppRouterHydration(page);

    await expect(page.getByTestId("leaf-bfcache-id")).toHaveText("0");

    await revealAndClick(page, `${ROUTE}/x/2`);
    await expect(page.getByTestId("pathname")).toHaveText(`${ROUTE}/x/2`);
    const x2BfcacheId = await page.getByTestId("leaf-bfcache-id").textContent();
    expect(x2BfcacheId).toMatch(/^_b_\d+_$/);

    await revealAndClick(page, `${ROUTE}/x/1`);
    await expect(page.getByTestId("pathname")).toHaveText(`${ROUTE}/x/1`);
    const freshX1BfcacheId = await page.getByTestId("leaf-bfcache-id").textContent();
    expect(freshX1BfcacheId).toMatch(/^_b_\d+_$/);
    expect(freshX1BfcacheId).not.toBe(x2BfcacheId);

    await page.goBack();
    await expect(page.getByTestId("pathname")).toHaveText(`${ROUTE}/x/2`);
    await expect(page.getByTestId("leaf-bfcache-id")).toHaveText(x2BfcacheId ?? "");
  });

  test("resets leaf form state when re-entering a route via fresh push", async ({ page }) => {
    await page.goto(`${BASE}${ROUTE}/x/1`);
    await waitForAppRouterHydration(page);

    await page.getByTestId("leaf-input").fill("hello");
    await revealAndClick(page, `${ROUTE}/x/2`);
    await expect(page.getByTestId("pathname")).toHaveText(`${ROUTE}/x/2`);

    await revealAndClick(page, `${ROUTE}/x/1`);
    await expect(page.getByTestId("leaf-input")).toHaveValue("");
  });

  test("preserves shared layout state across sibling leaf navigations", async ({ page }) => {
    await page.goto(`${BASE}${ROUTE}/x/1`);
    await waitForAppRouterHydration(page);

    await page.getByTestId("layout-input").fill("layout");
    const xLayoutBfcacheId = await page.getByTestId("layout-bfcache-id").textContent();

    await revealAndClick(page, `${ROUTE}/x/2`);
    await expect(page.getByTestId("pathname")).toHaveText(`${ROUTE}/x/2`);
    await expect(page.getByTestId("layout-input")).toHaveValue("layout");
    await expect(page.getByTestId("layout-bfcache-id")).toHaveText(xLayoutBfcacheId ?? "");
  });

  test("resets shared layout state when navigating across dynamic groups", async ({ page }) => {
    await page.goto(`${BASE}${ROUTE}/x/1`);
    await waitForAppRouterHydration(page);

    await page.getByTestId("layout-input").fill("layout");
    const xLayoutBfcacheId = await page.getByTestId("layout-bfcache-id").textContent();

    await revealAndClick(page, `${ROUTE}/y/1`);
    await expect(page.getByTestId("pathname")).toHaveText(`${ROUTE}/y/1`);
    await expect(page.getByTestId("layout-input")).toHaveValue("");
    const yLayoutBfcacheId = await page.getByTestId("layout-bfcache-id").textContent();
    expect(yLayoutBfcacheId).not.toBe(xLayoutBfcacheId);
  });

  test("preserves bfcacheId across hash/search-param navigation and refresh", async ({ page }) => {
    await page.goto(`${BASE}${ROUTE}/x/1`);
    await waitForAppRouterHydration(page);

    const initialBfcacheId = await page.getByTestId("leaf-bfcache-id").textContent();
    await revealAndClick(page, `${ROUTE}/x/1#section`);
    await expect(page.getByTestId("leaf-bfcache-id")).toHaveText(initialBfcacheId ?? "");

    await revealAndClick(page, `${ROUTE}/x/1?q=2`);
    await expect(page.getByTestId("search")).toHaveAttribute("data-value", "q=2");
    await expect(page.getByTestId("leaf-bfcache-id")).toHaveText(initialBfcacheId ?? "");

    await page.getByTestId("refresh").click();
    await expect(page.getByTestId("leaf-bfcache-id")).toHaveText(initialBfcacheId ?? "");
  });

  test("mints bfcacheIds for programmatic push and replace", async ({ page }) => {
    await page.goto(`${BASE}${ROUTE}/x/1`);
    await waitForAppRouterHydration(page);

    const pushInitialBfcacheId = await page.getByTestId("leaf-bfcache-id").textContent();
    await page.getByTestId("router-push-x-2").click();
    await expect(page.getByTestId("pathname")).toHaveText(`${ROUTE}/x/2`);
    const pushedBfcacheId = await page.getByTestId("leaf-bfcache-id").textContent();
    expect(pushedBfcacheId).toMatch(/^_b_\d+_$/);
    expect(pushedBfcacheId).not.toBe(pushInitialBfcacheId);

    await page.goto(`${BASE}${ROUTE}/x/1`);
    await waitForAppRouterHydration(page);

    const replaceInitialBfcacheId = await page.getByTestId("leaf-bfcache-id").textContent();
    await page.getByTestId("router-replace-x-2").click();
    await expect(page.getByTestId("pathname")).toHaveText(`${ROUTE}/x/2`);
    const replacedBfcacheId = await page.getByTestId("leaf-bfcache-id").textContent();
    expect(replacedBfcacheId).toMatch(/^_b_\d+_$/);
    expect(replacedBfcacheId).not.toBe(replaceInitialBfcacheId);
  });
});
