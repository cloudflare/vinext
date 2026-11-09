// Ported from Next.js:
// test/e2e/app-dir/segment-cache/client-params/client-params.test.ts
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/segment-cache/client-params/client-params.test.ts
//
// Next.js runs this test with Cache Components, where the client segments are
// fully prefetched and the click sends no request. app-basic doesn't enable
// Cache Components. Without it, Next.js renders this route dynamically (a
// dynamic segment without generateStaticParams), so its automatic prefetch
// never renders the page and the click fetches it.

import { expect, test, type Page, type Request } from "@playwright/test";
import { waitForAppRouterHydration } from "../../helpers";

const ROOT = "/nextjs-compat/segment-cache-client-params";

type RscRequest = {
  partial: boolean;
  pathname: string;
};

function trackRscRequests(page: Page): RscRequest[] {
  const requests: RscRequest[] = [];
  page.on("request", (request: Request) => {
    const url = new URL(request.url());
    if (!url.searchParams.has("_rsc") || request.headers()["rsc"] !== "1") return;
    requests.push({
      partial: request.headers()["x-vinext-rsc-render-mode"] === "prefetch-loading-shell",
      pathname: url.pathname,
    });
  });
  return requests;
}

function requestsFor(requests: RscRequest[], pathname: string): RscRequest[] {
  return requests.filter((request) => request.pathname === pathname);
}

test.describe("Next.js compat: segment-cache client params", () => {
  test("client segments that access dynamic params render them after a shell prefetch", async ({
    page,
  }) => {
    const targetPath = `${ROOT}/clothing/1`;
    const requests = trackRscRequests(page);

    await page.goto(ROOT);
    await waitForAppRouterHydration(page);
    await expect(page.locator("#segment-cache-client-params-home")).toBeVisible();

    await page.locator(`input[data-link-accordion="${targetPath}"]`).click();
    await page.locator(`a[href="${targetPath}"]`).hover();
    await expect.poll(() => requestsFor(requests, targetPath).length).toBeGreaterThan(0);
    await page.waitForTimeout(500);
    expect(requestsFor(requests, targetPath).every((request) => request.partial)).toBe(true);

    requests.length = 0;
    await page.locator(`a[href="${targetPath}"]`).click();
    await expect(page.locator("#category-header")).toHaveText("Category: clothing");
    await expect(page.locator("#product")).toHaveText("Product: 1");
    expect(requestsFor(requests, targetPath)).toEqual([{ partial: false, pathname: targetPath }]);
  });
});
