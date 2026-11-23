import { expect, test } from "@playwright/test";
import { waitForAppRouterHydration } from "../helpers";

// Ported from Next.js:
// test/e2e/app-dir/parallel-route-navigations/parallel-route-navigations.test.ts
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/parallel-route-navigations/parallel-route-navigations.test.ts
// Like Next.js, a Cache Components Link to a dynamic route with parallel slots
// prefetches its static shell, so a navigation shows the page and the slot
// with the target's params. Next.js prefetches the route's fallback shell, so
// its navigation makes one request for the params' holes. Vinext prefetches
// the path's own shell, as Next.js does once it has prerendered the path. The
// shell holds the whole page, so the navigation makes no request.
test("shows the prefetched static shell of a dynamic route with parallel slots", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "app-router-bfcache-prod", "prefetching is production-only");
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  const target = "/slot-prefetch/vercel/sub/other-folder";
  const shellPrefetch = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === target &&
      response.request().headers()["x-vinext-rsc-render-mode"] === "prefetch-static-shell",
  );
  await page.goto("/slot-prefetch/vercel/sub/folder");
  await waitForAppRouterHydration(page);
  const shellResponse = await shellPrefetch;
  expect(shellResponse.status()).toBe(200);
  expect(shellResponse.headers()["x-vinext-static-shell"]).toBe("complete");

  // Hold any request the navigation makes, so only the prefetch can show.
  let releaseNavigation!: () => void;
  const navigationHeld = new Promise<void>((resolve) => {
    releaseNavigation = resolve;
  });
  let heldNavigations = 0;
  await page.route("**/*", async (route) => {
    const headers = route.request().headers();
    if (headers.rsc === "1" && headers["next-router-prefetch"] === undefined) {
      heldNavigations++;
      await navigationHeld;
    }
    await route.continue();
  });

  // BFCache keeps the previous slot page, hidden.
  const slotClientParams = page.locator(
    '[data-client-file="/[teamID]/@slot/[...catchAll]/page.tsx"][data-client-params]:visible',
  );
  // A document navigation would drop this, and load the page without the prefetch.
  await page.evaluate(() => {
    (window as Window & { __NAV_MARKER__?: boolean }).__NAV_MARKER__ = true;
  });
  await page.click(`a[href="${target}"]`);
  await expect(page.locator('[data-file="/[teamID]/sub/other-folder/page.tsx"]')).toBeVisible({
    timeout: 2_000,
  });
  expect(JSON.parse((await slotClientParams.getAttribute("data-client-params"))!)).toEqual({
    teamID: "vercel",
    catchAll: ["sub", "other-folder"],
  });

  await expect(
    page.locator(
      '[data-server-file="/[teamID]/@slot/[...catchAll]/page.tsx"][data-server-params]:visible',
    ),
  ).toHaveAttribute(
    "data-server-params",
    JSON.stringify({ teamID: "vercel", catchAll: ["sub", "other-folder"] }),
  );
  // Keep holding for a while, so a late or duplicate request is counted.
  await page.waitForTimeout(1_000);
  expect(heldNavigations).toBe(0);
  expect(
    await page.evaluate(() => (window as Window & { __NAV_MARKER__?: boolean }).__NAV_MARKER__),
  ).toBe(true);
  releaseNavigation();
  expect(consoleErrors).toEqual([]);
});
