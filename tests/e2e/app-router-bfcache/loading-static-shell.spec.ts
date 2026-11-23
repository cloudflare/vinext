import { expect, test } from "@playwright/test";
import { waitForAppRouterHydration } from "../helpers";

// Like Next.js, a Cache Components Link to a page under loading.tsx prefetches
// the page's static shell, so a navigation shows everything static in the page
// at once: the whole page when it has no holes, without another request.
for (const { link, shown, isComplete } of [
  { link: "static", shown: ["#route-content"], isComplete: true },
  { link: "holed", shown: ["#route-content", "#greeting-loading"], isComplete: false },
  { link: "top", shown: ["#route-loading"], isComplete: false },
]) {
  test(`shows the prefetched static shell of a ${link} page under loading.tsx`, async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "app-router-bfcache-prod",
      "prefetching is production-only",
    );
    const consoleErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    const target = `/loading-prefetch/${link}`;
    const shellPrefetch = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === target &&
        response.request().headers()["x-vinext-rsc-render-mode"] === "prefetch-static-shell",
    );
    await page.goto("/loading-prefetch");
    await waitForAppRouterHydration(page);
    expect((await shellPrefetch).status()).toBe(200);

    // Hold the navigation's own request, so only the prefetch can show.
    let releaseNavigation!: () => void;
    const navigationHeld = new Promise<void>((resolve) => {
      releaseNavigation = resolve;
    });
    let navigationRequests = 0;
    await page.route("**/*", async (route) => {
      const headers = route.request().headers();
      if (headers.rsc === "1" && headers["next-router-prefetch"] === undefined) {
        navigationRequests += 1;
        await navigationHeld;
      }
      await route.continue();
    });

    await page.click(`#link-${link}`);
    await expect(page).toHaveURL(target);
    for (const selector of shown) {
      await expect(page.locator(selector)).toBeVisible({ timeout: 2_000 });
    }
    if (isComplete) {
      await expect(page.locator("#route-loading")).toHaveCount(0);
      expect(navigationRequests).toBe(0);
    } else {
      releaseNavigation();
      await expect(page.locator("#greeting")).toHaveText("hello guest");
    }
    releaseNavigation();
    expect(consoleErrors).toEqual([]);
  });
}

// Like Next.js (`MIN_PREFETCHABLE_STALE`), a static shell leaves out a
// "use cache" function about to go stale, as a hole a navigation fills.
test("leaves a soon-stale cache out of the prefetched static shell", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "app-router-bfcache-prod", "prefetching is production-only");
  const target = "/loading-prefetch/soon-stale";
  const shellPrefetch = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === target &&
      response.request().headers()["x-vinext-rsc-render-mode"] === "prefetch-static-shell",
  );
  await page.goto("/loading-prefetch");
  await waitForAppRouterHydration(page);
  const body = await (await shellPrefetch).text();
  expect(body).toContain("prefetchable cache value");
  expect(body).not.toContain("soon-stale cache value");

  await page.click("#link-soon-stale");
  await expect(page).toHaveURL(target);
  await expect(page.locator("#prefetchable-value")).toBeVisible();
  await expect(page.locator("#soon-stale-value")).toHaveText("soon-stale cache value");
});
