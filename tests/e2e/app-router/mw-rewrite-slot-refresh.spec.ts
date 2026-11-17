// A refresh of a page that middleware rewrote must not refetch the rewritten
// (internal) path for the page's own active parallel slots. Next.js sends one
// request, to the visible URL.

import { test, expect, type Page } from "@playwright/test";
import { waitForAppRouterHydration } from "../helpers";

const BASE = "http://localhost:4174";
const VISIBLE_PATH = "/mw-rewrite-slot-refresh/p/shoe";
const REWRITTEN_PATH = "/mw-rewrite-slot-refresh/v1/p/shoe";

async function openAndRecordRequests(page: Page): Promise<string[]> {
  await page.goto(`${BASE}${VISIBLE_PATH}`);
  await waitForAppRouterHydration(page);
  await expect(page.locator("#mw-rewrite-slot-refresh-info")).toHaveText("info shoe");

  const requests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === VISIBLE_PATH || url.pathname === REWRITTEN_PATH) {
      requests.push(`${request.method()} ${url.pathname}`);
    }
  });
  return requests;
}

test.describe("refresh of a middleware-rewritten page with parallel slots", () => {
  test("router.refresh() sends one RSC request, to the visible URL", async ({ page }) => {
    const requests = await openAndRecordRequests(page);

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
});
