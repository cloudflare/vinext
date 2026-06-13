import type { Page, Request } from "@playwright/test";
import { expect, test } from "../fixtures";
import { waitForAppRouterHydration } from "../helpers";

const BASE = "http://localhost:4186";

function isRscRequest(request: Request, pathname?: string): boolean {
  const url = new URL(request.url());
  return request.headers()["rsc"] === "1" && (pathname === undefined || url.pathname === pathname);
}

async function waitForRscResponseContaining(page: Page, text: string) {
  return page.waitForResponse(
    async (response) => {
      if (!isRscRequest(response.request())) return false;
      return (await response.text()).includes(text);
    },
    { timeout: 10_000 },
  );
}

test.describe("max prefetch inlining", () => {
  // Ported from Next.js:
  // test/e2e/app-dir/segment-cache/max-prefetch-inlining/max-prefetch-inlining.test.ts
  // https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-dir/segment-cache/max-prefetch-inlining/max-prefetch-inlining.test.ts
  test("bundles all route data into a bounded number of RSC prefetch requests", async ({
    page,
  }) => {
    let rscRequestCount = 0;
    page.on("request", (request) => {
      if (isRscRequest(request)) {
        rscRequestCount++;
      }
    });

    await page.goto(`${BASE}/`);
    await waitForAppRouterHydration(page);

    const firstPrefetch = waitForRscResponseContaining(page, "Page C");
    await page.locator('input[data-link-accordion="/shared/a/b/c"]').click();
    await firstPrefetch;

    const countBeforeSecondPrefetch = rscRequestCount;
    const secondPrefetch = waitForRscResponseContaining(page, "Page E");
    await page.locator('input[data-link-accordion="/shared/a/d/e"]').click();
    await secondPrefetch;

    const delta = rscRequestCount - countBeforeSecondPrefetch;
    expect(delta).toBeLessThanOrEqual(2);

    const countBeforeNavigation = rscRequestCount;
    await page.locator('a[href="/shared/a/d/e"]').click();
    await expect(page.locator("#page-e")).toHaveText("Page E");
    expect(rscRequestCount).toBe(countBeforeNavigation);
  });

  test("works with dynamic routes", async ({ page }) => {
    await page.goto(`${BASE}/dynamic/hello`);
    await expect(page.locator("#dynamic-page")).toHaveText("hello");
  });

  test("deduplicates inlined prefetch requests for the same route", async ({ page }) => {
    const firstPrefetchBlocker: { release?: () => void } = {};
    let rscRequestCount = 0;

    await page.route("**/*", async (route) => {
      const request = route.request();
      if (isRscRequest(request, "/shared/a/b/c")) {
        rscRequestCount++;
        if (firstPrefetchBlocker.release === undefined) {
          await new Promise<void>((resolve) => {
            firstPrefetchBlocker.release = resolve;
          });
        }
      }
      await route.continue();
    });

    await page.goto(`${BASE}/`);
    await waitForAppRouterHydration(page);

    const firstPrefetch = waitForRscResponseContaining(page, "Page C");
    await page.locator('input[data-link-accordion="/shared/a/b/c"]').click();
    await expect.poll(() => rscRequestCount).toBe(1);

    await page.locator('input[data-link-accordion="duplicate-a"]').click();
    await page.waitForTimeout(250);
    expect(rscRequestCount).toBe(1);

    const release = firstPrefetchBlocker.release;
    if (release === undefined) {
      throw new Error("Expected the first prefetch request to be blocked");
    }
    release();
    await firstPrefetch;

    const countBeforeNavigation = rscRequestCount;
    await page.locator('a[href="/shared/a/b/c"]').first().click();
    await expect(page.locator("#page-c")).toHaveText("Page C");
    expect(rscRequestCount).toBe(countBeforeNavigation);
  });
});
