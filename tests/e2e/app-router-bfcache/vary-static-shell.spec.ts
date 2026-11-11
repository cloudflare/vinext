import { expect, test } from "@playwright/test";
import { waitForAppRouterHydration } from "../helpers";

// Like Next.js's segment cache with `varyParams`, a navigation to a URL with
// no prefetch of its own shows another URL's settled static shell at once,
// when they agree on the params the shell's render read.
test("shows another URL's static shell on a navigation with no prefetch", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "app-router-bfcache-prod", "prefetching is production-only");
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  const shellPrefetch = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/vary-prefetch/shoes/a" &&
      response.request().headers()["x-vinext-rsc-render-mode"] === "prefetch-static-shell",
  );
  await page.goto("/vary-prefetch");
  await waitForAppRouterHydration(page);
  const shell = await shellPrefetch;
  expect(shell.status()).toBe(200);
  expect(await shell.text()).not.toContain("Item:");

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
  await expect(page).toHaveURL("/vary-prefetch/shoes/b");
  await expect(page.locator("#category")).toHaveText("Category: shoes", { timeout: 2_000 });
  await expect(page.locator("#item-loading")).toBeVisible();
  releaseNavigation();
  await expect(page.locator("#item")).toHaveText("Item: b");
  expect(consoleErrors).toEqual([]);
});
