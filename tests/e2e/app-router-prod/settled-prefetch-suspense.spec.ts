import { expect, test } from "@playwright/test";
import { waitForAppRouterHydration } from "../helpers";

const ROUTE = "/search-transition-suspense";
const PREFETCHED_ROUTE = `${ROUTE}/prefetched`;
const PREFETCHED_MODULE_MARKER = "search-transition-prefetched-items";

// Link prefetching only runs in production. A click that reuses a settled
// prefetch must commit like any other navigation transition: while the target
// still waits on a client module, the current page stays on screen instead of
// the layout's Suspense fallback.
test("keeps the page on screen when a settled prefetch is still resolving", async ({ page }) => {
  // Hold the client chunk that only the prefetched page renders. The prefetch
  // decodes its payload before the click, so the click arrives while the
  // module is still loading.
  let releasePrefetchedModule!: () => void;
  const prefetchedModuleReleased = new Promise<void>((resolve) => {
    releasePrefetchedModule = resolve;
  });
  let prefetchedModuleRequested!: () => void;
  const prefetchedModuleRequest = new Promise<void>((resolve) => {
    prefetchedModuleRequested = resolve;
  });
  await page.route(/\.js(\?|$)/, async (route) => {
    const response = await route.fetch();
    const body = await response.text();
    if (body.includes(PREFETCHED_MODULE_MARKER)) {
      prefetchedModuleRequested();
      await prefetchedModuleReleased;
    }
    await route.fulfill({ response, body });
  });
  const prefetchResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname.startsWith(PREFETCHED_ROUTE) && url.searchParams.has("_rsc");
  });

  await page.goto(ROUTE);
  await waitForAppRouterHydration(page);
  await (await prefetchResponse).finished();
  await prefetchedModuleRequest;
  // Preparation is CPU-local once the prefetch body settles.
  await page.waitForTimeout(50);
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
  const navigationRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith(PREFETCHED_ROUTE)) navigationRequests.push(request.url());
  });

  await page.getByTestId("search-transition-prefetched-link").click();
  await page.waitForTimeout(500);
  await expect(page.getByTestId("search-transition-view")).toBeVisible();
  await expect(page).toHaveURL(ROUTE);
  releasePrefetchedModule();

  await expect(page).toHaveURL(PREFETCHED_ROUTE);
  await expect(page.getByTestId("search-transition-prefetched-items")).toBeVisible();
  await expect(page.locator("html")).not.toHaveAttribute(
    "data-search-transition-fallback",
    "shown",
  );
  // The click reused the prefetch instead of fetching the page again.
  expect(navigationRequests).toEqual([]);
});
