import { expect, test } from "@playwright/test";

const targetPath = "/searchparams-reuse-loading";

// Ported from Next.js: test/e2e/app-dir/searchparams-reuse-loading/searchparams-reuse-loading.test.ts
// https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-dir/searchparams-reuse-loading/searchparams-reuse-loading.test.ts
for (const testCase of [
  {
    expected: "{}",
    linkName: "Prefetch with query",
    name: "param-full to param-less",
    prefetchedExpected: '{"id":"1"}',
    version: "version-1",
  },
  {
    expected: '{"id":"1"}',
    linkName: "Prefetch without query",
    name: "param-less to param-full",
    prefetchedExpected: "{}",
    version: "version-2",
  },
  {
    expected: '{"id":"2"}',
    linkName: "Prefetch first query",
    name: "param-full to different param-full",
    prefetchedExpected: '{"id":"1"}',
    version: "version-3",
  },
]) {
  test(`reuses a full prefetch loading shell across search params: ${testCase.name}`, async ({
    page,
  }) => {
    let releaseNavigation: (() => void) | undefined;
    let exactPrefetchedUrlRequests = 0;
    let navigationRequestSeen = false;
    let interceptNavigation = false;
    let verifyExactPrefetchedUrl = false;
    let resolveFullPrefetch: (() => void) | undefined;
    const fullPrefetchComplete = new Promise<void>((resolve) => {
      resolveFullPrefetch = resolve;
    });

    await page.route(`**${targetPath}*`, async (route) => {
      const request = route.request();
      const headers = request.headers();
      const url = new URL(request.url());
      const isFullPrefetch =
        !interceptNavigation &&
        url.pathname === targetPath &&
        headers.rsc === "1" &&
        headers["x-vinext-rsc-render-mode"] === undefined;
      if (isFullPrefetch) {
        const response = await route.fetch();
        await route.fulfill({ response });
        resolveFullPrefetch?.();
        return;
      }
      if (
        interceptNavigation &&
        url.pathname === targetPath &&
        headers.rsc === "1" &&
        headers["next-router-prefetch"] === undefined
      ) {
        if (verifyExactPrefetchedUrl) {
          exactPrefetchedUrlRequests += 1;
          await route.abort();
          return;
        }
        navigationRequestSeen = true;
        await new Promise<void>((resolve) => {
          releaseNavigation = resolve;
        });
      }
      await route.continue();
    });

    await page.goto(`/searchparams-reuse-loading-navs/${testCase.version}`);
    await fullPrefetchComplete;
    interceptNavigation = true;
    await page.getByRole("button", { name: /^Navigate/ }).click();

    await expect(page.locator("#loading")).toHaveText("Loading...");
    await expect.poll(() => navigationRequestSeen).toBe(true);
    releaseNavigation?.();
    await expect(page.locator("#params")).toHaveText(testCase.expected);

    await page.goBack();
    await expect(page.getByRole("link", { name: testCase.linkName })).toBeVisible();
    verifyExactPrefetchedUrl = true;
    const requestsBeforeClick = exactPrefetchedUrlRequests;
    await page.getByRole("link", { name: testCase.linkName }).click();

    expect(await page.locator("#params").textContent()).toBe(testCase.prefetchedExpected);
    expect(await page.locator("#loading").count()).toBe(0);
    expect(exactPrefetchedUrlRequests).toBe(requestsBeforeClick);
  });
}
