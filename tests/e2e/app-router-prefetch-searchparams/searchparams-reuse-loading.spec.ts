import { expect, test } from "@playwright/test";

const targetPath = "/searchparams-reuse-loading";

// Ported from Next.js: test/e2e/app-dir/searchparams-reuse-loading/searchparams-reuse-loading.test.ts
// https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-dir/searchparams-reuse-loading/searchparams-reuse-loading.test.ts
for (const testCase of [
  { expected: "{}", name: "param-full to param-less", version: "version-1" },
  { expected: '{"id":"1"}', name: "param-less to param-full", version: "version-2" },
  {
    expected: '{"id":"2"}',
    name: "param-full to different param-full",
    version: "version-3",
  },
]) {
  test(`reuses a full prefetch loading shell across search params: ${testCase.name}`, async ({
    page,
  }) => {
    let releaseNavigation: (() => void) | undefined;
    let navigationRequestSeen = false;
    let interceptNavigation = false;

    await page.route(`**${targetPath}*`, async (route) => {
      const request = route.request();
      const headers = request.headers();
      const url = new URL(request.url());
      if (
        interceptNavigation &&
        url.pathname === targetPath &&
        headers.rsc === "1" &&
        headers["next-router-prefetch"] === undefined
      ) {
        navigationRequestSeen = true;
        await new Promise<void>((resolve) => {
          releaseNavigation = resolve;
        });
      }
      await route.continue();
    });

    await page.goto(`/searchparams-reuse-loading-navs/${testCase.version}`);
    await page.waitForLoadState("networkidle");
    interceptNavigation = true;
    await page.getByRole("button", { name: /^Navigate/ }).click();

    await expect(page.locator("#loading")).toHaveText("Loading...");
    await expect.poll(() => navigationRequestSeen).toBe(true);
    releaseNavigation?.();
    await expect(page.locator("#params")).toHaveText(testCase.expected);
  });
}
