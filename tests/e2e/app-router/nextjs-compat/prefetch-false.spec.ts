import { expect, test, type Page, type Request } from "@playwright/test";
import { waitForAppRouterHydration } from "../../helpers";

const ROOT = "/nextjs-compat/prefetch-false";
const LOADING_ROOT = "/nextjs-compat/prefetch-false-loading";
const FALLBACK_BASE_URL = "http://localhost:4174";

type PrefetchFalseLoadingWindow = Window & {
  __VINEXT_PREFETCH_FALSE_LOADING_OBSERVED__?: boolean;
  __VINEXT_PREFETCH_FALSE_LOADING_OBSERVER__?: MutationObserver;
};

function pathnameOf(url: string): string {
  return new URL(url).pathname;
}

function appUrl(baseURL: string | undefined, pathname: string): string {
  return `${baseURL ?? FALLBACK_BASE_URL}${pathname}`;
}

async function createRequestsListener(page: Page): Promise<{
  getRequests(): Array<[string, boolean]>;
}> {
  await page.waitForLoadState("networkidle");

  const requests: Array<[string, boolean]> = [];
  page.on("request", (request: Request) => {
    requests.push([request.url(), request.headers()["next-router-prefetch"] !== undefined]);
  });

  await page.reload();
  await waitForAppRouterHydration(page);

  return {
    getRequests: () => requests,
  };
}

test.describe("Next.js compat: app-prefetch-false", () => {
  // Ported from Next.js:
  // test/e2e/app-dir/app-prefetch-false/app-prefetch-false.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/app-prefetch-false/app-prefetch-false.test.ts
  test("avoids double-fetching when optimistic navigation fails", async ({ page, baseURL }) => {
    await page.goto(appUrl(baseURL, `${ROOT}/foo`));
    await waitForAppRouterHydration(page);
    const requestsListener = await createRequestsListener(page);

    await page.click(`[href="${ROOT}/foo"]`, { noWaitAfter: true });
    await Promise.all([
      page.waitForRequest((request) => pathnameOf(request.url()) === `${ROOT}/foo/bar`),
      page.click(`[href="${ROOT}/foo/bar"]`),
    ]);

    expect(
      requestsListener
        .getRequests()
        .filter(([requestUrl]) => pathnameOf(requestUrl) === `${ROOT}/foo/bar`).length,
    ).toBe(1);
  });

  // Ported from Next.js:
  // test/e2e/app-dir/app-prefetch-false-loading/app-prefetch-false-loading.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/app-prefetch-false-loading/app-prefetch-false-loading.test.ts
  test("does not re-trigger loading or remount shared dynamic layout", async ({
    page,
    baseURL,
  }) => {
    const sourcePath = `${LOADING_ROOT}/en/testing`;
    const targetPath = `${sourcePath}/test`;

    await page.goto(appUrl(baseURL, sourcePath));
    await waitForAppRouterHydration(page);
    await expect(page.locator("#shared-layout-mount-id")).toHaveText("1");

    const initialRenderCount = await page.locator("#random-number").textContent();
    const initialMountId = await page.locator("#shared-layout-mount-id").textContent();

    await page.evaluate(() => {
      const testWindow = window as PrefetchFalseLoadingWindow;
      testWindow.__VINEXT_PREFETCH_FALSE_LOADING_OBSERVED__ = Boolean(
        document.querySelector("#prefetch-false-loading"),
      );
      testWindow.__VINEXT_PREFETCH_FALSE_LOADING_OBSERVER__?.disconnect();
      testWindow.__VINEXT_PREFETCH_FALSE_LOADING_OBSERVER__ = new MutationObserver(() => {
        if (document.querySelector("#prefetch-false-loading")) {
          testWindow.__VINEXT_PREFETCH_FALSE_LOADING_OBSERVED__ = true;
        }
      });
      testWindow.__VINEXT_PREFETCH_FALSE_LOADING_OBSERVER__.observe(document.documentElement, {
        childList: true,
        subtree: true,
      });
    });

    await page.locator(`[href="${targetPath}"]`).click();

    await expect(page.locator("#nested-testing-page")).toBeVisible();
    expect(
      await page.evaluate(
        () => (window as PrefetchFalseLoadingWindow).__VINEXT_PREFETCH_FALSE_LOADING_OBSERVED__,
      ),
    ).toBe(false);
    await page.evaluate(() => {
      const testWindow = window as PrefetchFalseLoadingWindow;
      testWindow.__VINEXT_PREFETCH_FALSE_LOADING_OBSERVER__?.disconnect();
      delete testWindow.__VINEXT_PREFETCH_FALSE_LOADING_OBSERVER__;
    });
    await expect(page.locator("#random-number")).toHaveText(initialRenderCount ?? "");
    await expect(page.locator("#shared-layout-mount-id")).toHaveText(initialMountId ?? "");
  });
});
