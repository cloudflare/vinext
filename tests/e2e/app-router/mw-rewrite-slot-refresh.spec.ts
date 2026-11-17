// A refresh of a page that middleware rewrote must not refetch the rewritten
// (internal) path for the page's own active parallel slots. Next.js sends one
// request, to the visible URL.

import { test, expect, type Page } from "@playwright/test";
import { waitForAppRouterHydration } from "../helpers";

const BASE = "http://localhost:4174";
const VISIBLE_PATH = "/mw-rewrite-slot-refresh/p/shoe";

async function openAndRecordRequests(page: Page, visiblePath = VISIBLE_PATH): Promise<string[]> {
  await page.goto(`${BASE}${visiblePath}`);
  await waitForAppRouterHydration(page);
  await expect(page.locator("#mw-rewrite-slot-refresh-info")).toBeVisible();

  const requests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/mw-rewrite-slot-refresh/")) {
      requests.push(`${request.method()} ${url.pathname}`);
    }
  });
  return requests;
}

test.describe("refresh of a middleware-rewritten page with parallel slots", () => {
  test("router.refresh() sends one RSC request, to the visible URL", async ({ page }) => {
    const requests = await openAndRecordRequests(page);
    await expect(page.locator("#mw-rewrite-slot-refresh-info")).toHaveText("info shoe");

    await page.locator("#mw-rewrite-slot-refresh-button").click();
    await expect.poll(() => requests).toContain(`GET ${VISIBLE_PATH}`);
    // Leave time for any supplemental refresh the client would send.
    await page.waitForTimeout(1500);

    expect(requests).toEqual([`GET ${VISIBLE_PATH}`]);
  });

  test("a revalidating server action sends one POST, to the visible URL", async ({ page }) => {
    const requests = await openAndRecordRequests(page);

    await page.locator("#mw-rewrite-slot-refresh-action").click();
    await expect.poll(() => requests).toContain(`POST ${VISIBLE_PATH}`);
    // Leave time for any supplemental refresh the client would send.
    await page.waitForTimeout(1500);

    expect(requests).toEqual([`POST ${VISIBLE_PATH}`]);
    await expect(page.locator("#mw-rewrite-slot-refresh-info")).toHaveText("info shoe");
  });

  // The rewrite percent-encodes a non-ASCII segment in the matched path, while
  // the page's route id holds it decoded. They are still the same route.
  test("router.refresh() of a rewritten non-ASCII path sends one RSC request", async ({ page }) => {
    const visiblePath = "/mw-rewrite-slot-refresh/p/caf%C3%A9";
    const requests = await openAndRecordRequests(page, visiblePath);

    await page.locator("#mw-rewrite-slot-refresh-button").click();
    await expect.poll(() => requests).toContain(`GET ${visiblePath}`);
    // Leave time for any supplemental refresh the client would send.
    await page.waitForTimeout(1500);

    expect(requests).toEqual([`GET ${visiblePath}`]);
  });
});
