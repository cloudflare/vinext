import { expect, test } from "@playwright/test";

// Ported from Next.js v16.2.6:
// test/e2e/next-form/default/next-form-prefetch.test.ts
// https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/next-form/default/next-form-prefetch.test.ts

const RSC_RENDER_MODE_HEADER = "x-vinext-rsc-render-mode";
const LOADING_SHELL_MODE = "prefetch-loading-shell";

function isSearchRscRequest(request: import("@playwright/test").Request) {
  const url = new URL(request.url());
  return url.pathname === "/base/search" && request.headers()["rsc"] === "1";
}

test("prefetches a production loading shell and shows it while navigation RSC is blocked", async ({
  page,
  baseURL,
}, testInfo) => {
  test.skip(testInfo.project.name !== "next-form-parity-prod");

  let releaseNavigation!: () => void;
  const navigationBlocked = new Promise<void>((resolve) => {
    releaseNavigation = resolve;
  });
  let sawLoadingShellPrefetch = false;
  let sawBlockedNavigation = false;

  await page.route("**/base/search*", async (route) => {
    const request = route.request();
    if (!isSearchRscRequest(request)) {
      await route.continue();
      return;
    }

    if (request.headers()[RSC_RENDER_MODE_HEADER] === LOADING_SHELL_MODE) {
      sawLoadingShellPrefetch = true;
      await route.continue();
      return;
    }

    sawBlockedNavigation = true;
    await navigationBlocked;
    await route.continue();
  });

  await page.goto(`${baseURL}/base/forms/prefetch`);
  await expect.poll(() => sawLoadingShellPrefetch).toBe(true);

  await page.locator("#prefetch-form button").click({ noWaitAfter: true });
  await expect.poll(() => sawBlockedNavigation).toBe(true);
  await expect(page.locator("#loading")).toHaveText("Loading...");

  releaseNavigation();
  await expect(page.locator("#search-result")).toHaveText("Query: prefetched");
});

test("prefetch=false does not prefetch", async ({ page, baseURL }) => {
  const prefetchRequests: string[] = [];
  page.on("request", (request) => {
    if (
      isSearchRscRequest(request) &&
      request.headers()[RSC_RENDER_MODE_HEADER] === LOADING_SHELL_MODE
    ) {
      prefetchRequests.push(request.url());
    }
  });

  await page.goto(`${baseURL}/base/forms/prefetch-false`);
  await page.waitForTimeout(250);

  expect(prefetchRequests).toEqual([]);
});

test("development does not prefetch forms", async ({ page, baseURL }, testInfo) => {
  test.skip(testInfo.project.name !== "next-form-parity-dev");

  const prefetchRequests: string[] = [];
  page.on("request", (request) => {
    if (isSearchRscRequest(request)) prefetchRequests.push(request.url());
  });

  await page.goto(`${baseURL}/base/forms/prefetch`);
  await page.waitForTimeout(250);

  expect(prefetchRequests).toEqual([]);
});
