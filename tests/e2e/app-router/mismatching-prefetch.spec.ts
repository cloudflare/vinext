import { expect, test } from "@playwright/test";
import { waitForAppRouterHydration } from "../helpers";

const BASE = "http://localhost:4174";

// Ported from Next.js:
// test/e2e/app-dir/concurrent-navigations/mismatching-prefetch.test.ts
// https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-dir/concurrent-navigations/mismatching-prefetch.test.ts
test("recovers when navigation middleware rewrites away from the prefetched route", async ({
  page,
}) => {
  await page.goto(`${BASE}/nextjs-compat/mismatching-prefetch`);
  await waitForAppRouterHydration(page);

  const prefetchResponse = page.waitForResponse((response) => {
    const request = response.request();
    return (
      request.headers()["x-vinext-rsc-render-mode"] === "prefetch-loading-shell" &&
      response.url().includes("/nextjs-compat/mismatching-prefetch/dynamic-page/a?")
    );
  });
  await page.click("#reveal-mismatching-prefetch");
  await expect(page.locator("#mismatching-prefetch-link")).toBeVisible();
  await page.hover("#mismatching-prefetch-link");
  expect((await prefetchResponse).ok()).toBe(true);

  await page.evaluate(() => {
    (window as Window & { __MISMATCH_PREFETCH_MARKER__?: boolean }).__MISMATCH_PREFETCH_MARKER__ =
      true;
  });

  const documentRequests: string[] = [];
  page.on("request", (request) => {
    if (request.isNavigationRequest() && request.resourceType() === "document") {
      documentRequests.push(request.url());
    }
  });

  await page.click("#mismatching-prefetch-link");

  await expect(page.locator("#dynamic-page-loading-a")).toHaveText("Loading a...");
  await expect(page.locator("#dynamic-page-content-b")).toHaveText("Dynamic page b");
  expect(new URL(page.url()).pathname).toBe("/nextjs-compat/mismatching-prefetch/dynamic-page/a");
  expect(new URL(page.url()).search).toBe("?mismatch-rewrite=./b");
  expect(documentRequests).toEqual([]);
  expect(
    await page.evaluate(
      () =>
        (window as Window & { __MISMATCH_PREFETCH_MARKER__?: boolean })
          .__MISMATCH_PREFETCH_MARKER__,
    ),
  ).toBe(true);
});
