/**
 * Next.js builds `Next-Url` from the rendered router tree, not the browser
 * URL. An unmatched URL renders /_not-found, which no interception beneath the
 * root owns, so a navigation from its not-found page renders the target page
 * directly instead of opening a modal.
 */
import { test, expect, type Page, type Request } from "@playwright/test";
import { waitForAppRouterHydration } from "../helpers";

const BASE = "http://localhost:4174";
const ROOT = "/nextjs-compat/intercept-from-not-found";
const PHOTO_PATH = `${ROOT}/photo/1`;

type MarkerWindow = Window & {
  __clientNavMarker?: boolean;
  next?: { router?: { push(href: string): void } };
};

function capturePhotoRscRequests(page: Page): Request[] {
  const requests: Request[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      url.pathname.startsWith(PHOTO_PATH) &&
      url.searchParams.has("_rsc") &&
      request.headers()["rsc"] === "1"
    ) {
      requests.push(request);
    }
  });
  return requests;
}

async function setClientNavMarker(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as MarkerWindow).__clientNavMarker = true;
  });
}

async function readClientNavMarker(page: Page): Promise<boolean | undefined> {
  return page.evaluate(() => (window as MarkerWindow).__clientNavMarker);
}

test.describe("interception from an unmatched URL's not-found page", () => {
  test("renders the target page directly without an interception context", async ({ page }) => {
    const response = await page.goto(`${BASE}${ROOT}/missing/deeper`);
    expect(response?.status()).toBe(404);
    await waitForAppRouterHydration(page);
    await expect(page.getByRole("heading", { name: "404 - Page Not Found" })).toBeVisible();
    // The root not-found renders without the modal slot's layout.
    await expect(page.locator("#intercept-from-not-found-layout")).toHaveCount(0);
    await setClientNavMarker(page);
    const photoRscRequests = capturePhotoRscRequests(page);

    await page.evaluate((href) => {
      const router = (window as MarkerWindow).next?.router;
      if (!router) throw new Error("window.next.router is not installed");
      void router.push(href);
    }, PHOTO_PATH);

    await expect(page).toHaveURL(new RegExp(`${PHOTO_PATH}$`));
    await expect(page.locator("#intercept-from-not-found-photo")).toHaveText("Photo page: 1");
    await expect(page.locator("#intercept-from-not-found-modal")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "404 - Page Not Found" })).toHaveCount(0);
    expect(await readClientNavMarker(page)).toBe(true);

    expect(photoRscRequests.length).toBeGreaterThan(0);
    for (const request of photoRscRequests) {
      expect(request.headers()["x-vinext-interception-context"]).toBeUndefined();
    }
  });

  test("opens the modal from the layout's own page", async ({ page }) => {
    await page.goto(`${BASE}${ROOT}`);
    await waitForAppRouterHydration(page);
    await setClientNavMarker(page);
    const photoRscRequests = capturePhotoRscRequests(page);

    await page.getByRole("link", { name: "Photo 1" }).click();

    await expect(page).toHaveURL(new RegExp(`${PHOTO_PATH}$`));
    await expect(page.locator("#intercept-from-not-found-modal")).toHaveText("Photo modal: 1");
    await expect(page.locator("#intercept-from-not-found-home")).toBeVisible();
    await expect(page.locator("#intercept-from-not-found-photo")).toHaveCount(0);
    expect(await readClientNavMarker(page)).toBe(true);

    expect(
      photoRscRequests.map((request) => request.headers()["x-vinext-interception-context"]),
    ).toContain(ROOT);
  });
});
