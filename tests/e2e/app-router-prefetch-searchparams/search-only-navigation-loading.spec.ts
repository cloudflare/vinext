import { expect, test, type Page } from "@playwright/test";

const ROUTE = "/search-tab-loading";

async function recordReplacedPage(page: Page) {
  await page.evaluate(() => {
    const record = () => {
      if (document.querySelector("#search-tab-loading")) {
        document.documentElement.dataset.searchTabLoading = "shown";
      }
      if (!document.querySelector("#item-header")) {
        document.documentElement.dataset.searchTabHeader = "lost";
      }
    };
    record();
    new MutationObserver(record).observe(document.body, { childList: true, subtree: true });
  });
}

async function expectPageKept(page: Page) {
  await expect(page.locator("html")).not.toHaveAttribute("data-search-tab-loading", "shown");
  await expect(page.locator("html")).not.toHaveAttribute("data-search-tab-header", "lost");
  await page.locator("html").evaluate((element) => {
    delete element.dataset.searchTabLoading;
    delete element.dataset.searchTabHeader;
  });
}

// Next.js keys segment boundaries without the page's search params
// (createRouterCacheKey(segment, true) in layout-router), so a navigation that
// keeps the pathname suspends inside the mounted loading boundary and the
// transition keeps the current page until the new one commits. That holds even
// when the route's loading shell was prefetched.
// Ref: https://github.com/cloudflare/vinext/issues/4533
test("a same-pathname navigation keeps the page mounted after its loading shell is prefetched", async ({
  page,
}) => {
  let holdNavigation = false;
  let navigationRequests = 0;
  const heldNavigations: Array<() => void> = [];
  let resolveShellPrefetch: (() => void) | undefined;
  const shellPrefetched = new Promise<void>((resolve) => {
    resolveShellPrefetch = resolve;
  });

  await page.route(`**${ROUTE}*`, async (route) => {
    const request = route.request();
    const headers = request.headers();
    if (headers.rsc !== "1") return route.continue();
    const url = new URL(request.url());
    const renderMode = headers["x-vinext-rsc-render-mode"];
    if (renderMode !== undefined) {
      const response = await route.fetch();
      await route.fulfill({ response });
      if (renderMode === "prefetch-loading-shell" && url.searchParams.get("tab") === "b") {
        resolveShellPrefetch?.();
      }
      return;
    }
    if (holdNavigation && headers["next-router-prefetch"] === undefined) {
      navigationRequests += 1;
      await new Promise<void>((resolve) => heldNavigations.push(resolve));
    }
    await route.continue();
  });

  await page.goto(`${ROUTE}?tab=a`);
  // A search-string Link prefetches its loading shell on hover.
  await page.locator("#tab-b").hover();
  await shellPrefetched;
  await recordReplacedPage(page);
  holdNavigation = true;

  // Search change.
  await page.locator("#tab-b").click();
  await expect.poll(() => navigationRequests).toBe(1);
  await expect(page.locator("#item-header")).toBeVisible();
  await expect(page.locator("#search-tab-loading")).toHaveCount(0);
  await expect(page.locator("#tab-body")).toHaveText("tab a");
  await expect(page).toHaveURL(`${ROUTE}?tab=a`);
  heldNavigations.shift()?.();
  await expect(page.locator("#tab-body")).toHaveText("tab b");
  await expect(page).toHaveURL(`${ROUTE}?tab=b`);
  await expectPageKept(page);

  // A Link to the exact current URL.
  await page.locator("#tab-b").click();
  await expect.poll(() => navigationRequests).toBe(2);
  await expect(page.locator("#item-header")).toBeVisible();
  await expect(page.locator("#search-tab-loading")).toHaveCount(0);
  const refreshed = page.waitForResponse(
    (response) =>
      response.request().headers().rsc === "1" &&
      response.request().headers()["x-vinext-rsc-render-mode"] === undefined,
  );
  heldNavigations.shift()?.();
  await refreshed;

  await expect(page.locator("#tab-body")).toHaveText("tab b");
  await expectPageKept(page);
});
