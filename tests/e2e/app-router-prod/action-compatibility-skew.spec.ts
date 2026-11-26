import { expect, test, type Page } from "@playwright/test";
import { isAppRouterServerActionRequestForPath, waitForAppRouterHydration } from "../helpers";

// A tab rendered by one deployment calls a server action after a newer one is
// live. The action ran, so its caller gets its outcome, as in Next.js'
// server-action-reducer (a build ID mismatch only discards the flight data,
// and a redirect rejects with the redirect error), before the page reloads.
const PAGE = "/action-compatibility-skew";
const RESULT_STORAGE_KEY = "action-compatibility-skew-result";
const DOCUMENT_MARKER = "__VINEXT_ACTION_COMPATIBILITY_SKEW_DOCUMENT__";

async function skewActionResponses(page: Page): Promise<() => number> {
  let skewedResponses = 0;
  await page.route(
    (url) => url.pathname === PAGE,
    async (route) => {
      if (!isAppRouterServerActionRequestForPath(route.request(), PAGE)) return route.continue();
      const response = await route.fetch();
      skewedResponses++;
      return route.fulfill({
        response,
        headers: { ...response.headers(), "x-vinext-rsc-compatibility-id": "another-deployment" },
      });
    },
  );
  return () => skewedResponses;
}

async function runSkewedAction(page: Page, button: string): Promise<string | null> {
  const skewedResponses = await skewActionResponses(page);
  await page.goto(PAGE);
  await waitForAppRouterHydration(page);
  await page.evaluate((marker) => {
    sessionStorage.clear();
    Reflect.set(window, marker, true);
  }, DOCUMENT_MARKER);

  const reloaded = page.waitForEvent("load");
  await page.click(button);
  await reloaded;
  expect(skewedResponses()).toBe(1);
  await waitForAppRouterHydration(page);
  // The action's response was not committed in place: the page was reloaded.
  await expect(
    page.evaluate((marker) => Reflect.get(window, marker) === true, DOCUMENT_MARKER),
  ).resolves.toBe(false);
  return page.evaluate((key) => sessionStorage.getItem(key), RESULT_STORAGE_KEY);
}

test("resolves a skewed action with its return value before reloading", async ({ page }) => {
  await expect(runSkewedAction(page, "#save")).resolves.toBe("resolved:true");
  await expect(page).toHaveURL(new RegExp(`${PAGE}$`));
});

test("resolves a skewed revalidating action with its return value", async ({ page }) => {
  await expect(runSkewedAction(page, "#save-revalidate")).resolves.toBe("resolved:true");
  await expect(page).toHaveURL(new RegExp(`${PAGE}$`));
});

test("rejects a skewed redirecting action with the redirect error", async ({ page }) => {
  await expect(runSkewedAction(page, "#save-redirect")).resolves.toBe(
    "rejected:NEXT_REDIRECT;push;/about;307;",
  );
  await expect(page).toHaveURL(/\/about$/);
  await expect(page.locator("h1")).toHaveText("About");
});
