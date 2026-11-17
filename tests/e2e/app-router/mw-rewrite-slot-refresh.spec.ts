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

// The client queues a supplemental refresh only once the primary response has
// arrived, so the grace period starts from that response, not its request.
async function triggerAndWaitForPrimaryResponse(
  page: Page,
  trigger: string,
  method: string,
  visiblePath: string,
): Promise<void> {
  const primaryResponse = page.waitForResponse(
    (response) =>
      response.request().method() === method && new URL(response.url()).pathname === visiblePath,
  );
  await page.locator(trigger).click();
  await primaryResponse;
  // Leave time for any supplemental refresh the client would send.
  await page.waitForTimeout(1500);
}

test.describe("refresh of a middleware-rewritten page with parallel slots", () => {
  test("router.refresh() sends one RSC request, to the visible URL", async ({ page }) => {
    const requests = await openAndRecordRequests(page);
    await expect(page.locator("#mw-rewrite-slot-refresh-info")).toHaveText("info shoe");

    await triggerAndWaitForPrimaryResponse(
      page,
      "#mw-rewrite-slot-refresh-button",
      "GET",
      VISIBLE_PATH,
    );

    expect(requests).toEqual([`GET ${VISIBLE_PATH}`]);
  });

  test("a revalidating server action sends one POST, to the visible URL", async ({ page }) => {
    const requests = await openAndRecordRequests(page);

    await triggerAndWaitForPrimaryResponse(
      page,
      "#mw-rewrite-slot-refresh-action",
      "POST",
      VISIBLE_PATH,
    );

    expect(requests).toEqual([`POST ${VISIBLE_PATH}`]);
    await expect(page.locator("#mw-rewrite-slot-refresh-info")).toHaveText("info shoe");
  });

  // The page's route id holds the matched path decoded once, while a named
  // slot's route id holds it as the rewrite encoded it. A non-ASCII segment
  // and a literal percent sign are both still the page's own route.
  for (const visiblePath of [
    "/mw-rewrite-slot-refresh/p/caf%C3%A9",
    "/mw-rewrite-slot-refresh/p/%25C3%25A9",
  ]) {
    test(`router.refresh() of rewritten ${visiblePath} sends one RSC request`, async ({ page }) => {
      const requests = await openAndRecordRequests(page, visiblePath);

      await triggerAndWaitForPrimaryResponse(
        page,
        "#mw-rewrite-slot-refresh-button",
        "GET",
        visiblePath,
      );

      expect(requests).toEqual([`GET ${visiblePath}`]);
    });
  }
});
