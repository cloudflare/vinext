import { expect, test, type Page, type Request } from "@playwright/test";
import { waitForAppRouterHydration } from "../helpers";

const BASE = "http://localhost:4174";
const ROUTE = "/search-transition-suspense";

async function navigateWhileArchivedModuleIsHeld(
  page: Page,
  options: { control: string; expectedUrl: string; pendingWhileHeld: boolean },
) {
  // Hold the archived view's client module so the RSC response ends while the
  // payload is still resolving, as when React has not committed it yet.
  let releaseArchivedModule!: () => void;
  const archivedModuleReleased = new Promise<void>((resolve) => {
    releaseArchivedModule = resolve;
  });
  let archivedModuleRequested!: () => void;
  const archivedModuleRequest = new Promise<void>((resolve) => {
    archivedModuleRequested = resolve;
  });
  let rscResponseFinished!: () => void;
  const rscResponseFinish = new Promise<void>((resolve) => {
    rscResponseFinished = resolve;
  });
  await page.route(/archived-items/, async (route) => {
    archivedModuleRequested();
    await archivedModuleReleased;
    await route.continue();
  });
  const onRscRequestEnd = (request: Request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith(ROUTE) && url.searchParams.get("archived") === "1") {
      rscResponseFinished();
    }
  };
  page.on("requestfinished", onRscRequestEnd);
  // Chromium sometimes reports this response as failed (net::ERR_ABORTED)
  // even though the page received all of it and the navigation commits, so
  // requestfinished never fires. The assertions below still catch a response
  // that really was cut short.
  page.on("requestfailed", onRscRequestEnd);

  await page.goto(`${BASE}${ROUTE}`);
  await waitForAppRouterHydration(page);
  await expect(page.getByTestId("search-transition-view")).toHaveText("active");
  await expect(page.locator("html")).toHaveAttribute("data-search-transition-ref-attachments", "1");
  await page.evaluate(() => {
    const recordFallback = () => {
      if (document.querySelector('[data-testid="search-transition-layout-fallback"]')) {
        document.documentElement.dataset.searchTransitionFallback = "shown";
      }
    };
    new MutationObserver(recordFallback).observe(document.body, {
      childList: true,
      subtree: true,
    });
  });

  const documentRequests: string[] = [];
  page.on("request", (request) => {
    if (request.resourceType() === "document") documentRequests.push(request.url());
  });

  await page.getByTestId(options.control).click();
  await archivedModuleRequest;
  await rscResponseFinish;
  // Give the browser time to act on the completed response.
  await page.waitForTimeout(500);
  await expect(page.getByTestId("search-transition-view")).toHaveText("active");
  await expect(page.getByTestId("search-transition-view")).toBeVisible();
  await expect(page).toHaveURL(`${BASE}${ROUTE}`);
  await expect(page.getByTestId("search-transition-pending")).toHaveText(
    String(options.pendingWhileHeld),
  );
  releaseArchivedModule();

  await expect(page).toHaveURL(options.expectedUrl);
  await expect(page.getByTestId("search-transition-archived-items")).toBeVisible();
  await expect(page.getByTestId("search-transition-view")).toHaveText("archived");
  await expect(page.getByTestId("search-transition-pending")).toHaveText("false");
  await expect(page.locator("html")).not.toHaveAttribute(
    "data-search-transition-fallback",
    "shown",
  );
  await expect(page.locator("html")).toHaveAttribute("data-search-transition-ref-attachments", "1");
  // The navigation stayed on the client instead of loading a new document.
  expect(documentRequests).toEqual([]);
}

// Regression for https://github.com/cloudflare/vinext/issues/4093.
test.describe("search-only transition navigation", () => {
  test("keeps the page on screen while a completed response is still resolving", async ({
    page,
  }) => {
    await navigateWhileArchivedModuleIsHeld(page, {
      control: "search-transition-archived-tab",
      expectedUrl: `${BASE}${ROUTE}?archived=1`,
      pendingWhileHeld: true,
    });
  });

  test("keeps the page on screen for a search and hash router.replace", async ({ page }) => {
    await navigateWhileArchivedModuleIsHeld(page, {
      control: "search-transition-archived-hash-tab",
      expectedUrl: `${BASE}${ROUTE}?archived=1#archived-items`,
      pendingWhileHeld: true,
    });
  });

  test("keeps the page on screen for a search and hash Link", async ({ page }) => {
    await navigateWhileArchivedModuleIsHeld(page, {
      control: "search-transition-archived-hash-link",
      expectedUrl: `${BASE}${ROUTE}?archived=1#archived-items`,
      // A Link navigation does not run inside the tabs' useTransition.
      pendingWhileHeld: false,
    });
  });
});
