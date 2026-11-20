// A refresh while a slot shows an intercepted route renders the owner layout
// from the refreshed (target) request, as Next.js does: each segment the
// refresh's own response rendered comes from it, and only the source page it
// left in the children slot comes from the source's render. Opening the modal
// keeps the layout the source rendered.
//
// Middleware hands the owner layout the pathname of the request that rendered
// it, so the layout shows which request it came from. A @sidebar page at the
// source's path gives the source page its own children slot, which the
// refresh takes from the source's render.

import { test, expect } from "@playwright/test";
import { waitForAppRouterHydration } from "../helpers";

const BASE = "http://localhost:4174";
const FEED = "/intercept-refresh-mw/feed";
const PHOTO = "/intercept-refresh-mw/photo/1";

type MarkedWindow = Window & { __interceptRefreshMwMarker?: boolean };

test.describe("router.refresh() in an intercepted state", () => {
  test("renders the owner layout from the refreshed request", async ({ page }) => {
    await page.goto(`${BASE}${FEED}`);
    await waitForAppRouterHydration(page);
    await expect(page.locator("#owner-mw")).toHaveText(`mw=${FEED}`);
    await expect(page.locator("#feed-sidebar")).toBeVisible();
    await page.evaluate(() => {
      (window as MarkedWindow).__interceptRefreshMwMarker = true;
    });

    await page.locator("#feed-photo-link").click();
    await expect(page).toHaveURL(`${BASE}${PHOTO}`);
    await expect(page.locator("#photo-modal")).toHaveText("modal 1");
    await expect(page.locator("#feed-page")).toBeVisible();
    await expect(page.locator("#owner-mw")).toHaveText(`mw=${FEED}`);

    const primaryResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "GET" && new URL(response.url()).pathname === PHOTO,
    );
    await page.locator("#intercept-refresh-mw-button").click();
    await primaryResponse;

    await expect(page.locator("#owner-mw")).toHaveText(`mw=${PHOTO}`);
    await expect(page).toHaveURL(`${BASE}${PHOTO}`);
    await expect(page.locator("#feed-page")).toBeVisible();
    await expect(page.locator("#photo-modal")).toHaveText("modal 1");
    await expect(page.locator("#feed-sidebar")).toBeVisible();
    await expect(page.locator("#photo-page")).toHaveCount(0);
    expect(
      await page.evaluate(() => (window as MarkedWindow).__interceptRefreshMwMarker === true),
    ).toBe(true);
  });
});
