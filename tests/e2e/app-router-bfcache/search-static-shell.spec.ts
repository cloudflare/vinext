import { expect, test } from "@playwright/test";
import { waitForAppRouterHydration } from "../helpers";

// Ported from Next.js:
// test/e2e/app-dir/segment-cache/search-params/segment-cache-search-params.test.ts
// Like Next.js's PPR shell, a page's static shell never renders search params,
// so a prefetch of another query string reuses it without a request.
test("reuses a page's static shell for another query string", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "app-router-bfcache-prod", "prefetching is production-only");
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  const target = "/search-prefetch/target";
  const shellPrefetches: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      url.pathname === target &&
      request.headers()["x-vinext-rsc-render-mode"] === "prefetch-static-shell"
    ) {
      shellPrefetches.push(url.searchParams.get("q") ?? "");
    }
  });
  const shellPrefetch = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === target &&
      response.request().headers()["x-vinext-rsc-render-mode"] === "prefetch-static-shell",
  );
  await page.goto("/search-prefetch");
  await waitForAppRouterHydration(page);
  const shell = await shellPrefetch;
  expect(shell.status()).toBe(200);
  expect(await shell.text()).not.toContain("Query:");

  await page.click("#reveal-b");
  await expect(page.locator("#link-b")).toBeVisible();
  // Give the revealed Link's prefetch its chance to run.
  await page.waitForTimeout(500);
  expect(shellPrefetches).toEqual(["a"]);

  // Hold the navigation's own request, so only the reused shell can show.
  let releaseNavigation!: () => void;
  const navigationHeld = new Promise<void>((resolve) => {
    releaseNavigation = resolve;
  });
  await page.route("**/*", async (route) => {
    const headers = route.request().headers();
    if (headers.rsc === "1" && headers["next-router-prefetch"] === undefined) {
      await navigationHeld;
    }
    await route.continue();
  });

  await page.click("#link-b");
  await expect(page).toHaveURL(`${target}?q=b`);
  await expect(page.locator("#route-content")).toBeVisible({ timeout: 2_000 });
  await expect(page.locator("#query-loading")).toBeVisible();
  releaseNavigation();
  await expect(page.locator("#query")).toHaveText("Query: b");
  expect(consoleErrors).toEqual([]);
});

// Like Next.js's segment cache, which keys a pending static prefetch without
// its search string, links to two query strings shown together share one
// request.
test("shares one static shell request between query strings shown together", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "app-router-bfcache-prod", "prefetching is production-only");
  const target = "/search-prefetch/target";
  const shellPrefetches: string[] = [];
  // Hold each shell response, so both Links prefetch while it's pending.
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (
      url.pathname === target &&
      request.headers()["x-vinext-rsc-render-mode"] === "prefetch-static-shell"
    ) {
      shellPrefetches.push(url.searchParams.get("q") ?? "");
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    await route.continue();
  });

  await page.goto("/search-prefetch/together");
  await waitForAppRouterHydration(page);
  await expect.poll(() => shellPrefetches.length).toBe(1);
  // Give the other Link's prefetch its chance to run once the shell settles.
  await page.waitForTimeout(1_000);
  expect(shellPrefetches).toHaveLength(1);

  await page.route("**/*", async (route) => {
    const headers = route.request().headers();
    if (headers.rsc === "1" && headers["next-router-prefetch"] === undefined) {
      await new Promise(() => {});
    }
    await route.continue();
  });
  const other = shellPrefetches[0] === "c" ? "d" : "c";
  await page.click(`#link-${other}`);
  await expect(page).toHaveURL(`${target}?q=${other}`);
  await expect(page.locator("#route-content")).toBeVisible({ timeout: 2_000 });
  await expect(page.locator("#query-loading")).toBeVisible();
});
