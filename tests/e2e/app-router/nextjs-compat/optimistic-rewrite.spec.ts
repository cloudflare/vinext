import { expect, test } from "@playwright/test";
import { waitForAppRouterHydration } from "../../helpers";

const BASE = "http://localhost:4174";
// Middleware rewrites `${ROOT}/<path>` to `${ROOT}/ja/<path>`, so the browser
// URLs `${ROOT}/datasets/x` and `${ROOT}/accounts/a/reports` both read as
// `[locale]` + `[...rest]`. The catch-all's loading.tsx makes the browser
// prefetch the first as a loading shell, which the server renders for
// `[locale]/datasets/[id]`.
const ROOT = "/nextjs-compat/optimistic-rewrite";

// Next.js learns no route pattern from a URL that doesn't match the route tree
// it rendered (discoverKnownRoutePart in segment-cache/optimistic-routes.ts).
test("does not show a rewritten prefetch's loading shell for another route", async ({ page }) => {
  await page.goto(`${BASE}${ROOT}/accounts/a`);
  await waitForAppRouterHydration(page);
  await expect(page.locator("#account-page")).toHaveText("Account a");

  // A loading-shell prefetch of the dataset page, which the server renders as
  // `${ROOT}/ja/datasets/x`. Dev links do not prefetch on viewport entry.
  const prefetchResponse = page.waitForResponse(
    (response) => response.url().includes(`${ROOT}/datasets/x`) && response.url().includes("_rsc"),
  );
  await page.evaluate((href) => {
    const router = Reflect.get(window, "next") as { router: { prefetch(href: string): void } };
    router.router.prefetch(href);
  }, `${ROOT}/datasets/x`);
  await (await prefetchResponse).finished();
  // A template would be learned once the prefetch cache entry settles.
  await page.waitForTimeout(500);

  await page.evaluate(() => {
    new MutationObserver(() => {
      if (document.querySelector("#dataset-loading, #dataset-header") !== null) {
        Reflect.set(window, "__datasetShellSeen", true);
      }
    }).observe(document.body, { childList: true, subtree: true });
  });

  // Hold the navigation's response so an optimistic shell would be visible.
  let releaseNavigation!: () => void;
  const navigationGate = new Promise<void>((resolve) => {
    releaseNavigation = resolve;
  });
  await page.route(`**${ROOT}/accounts/a/reports?_rsc*`, async (route) => {
    await navigationGate;
    await route.continue();
  });

  await page.click("#reports-link");
  await page.waitForTimeout(500);
  await expect(page.locator("#dataset-loading")).toHaveCount(0);
  await expect(page.locator("#dataset-header")).toHaveCount(0);

  releaseNavigation();
  await expect(page.locator("#account-reports-page")).toHaveText("Reports for a");
  await expect(page.locator("#account-tabs")).toBeVisible();
  expect(await page.evaluate(() => Reflect.get(window, "__datasetShellSeen") === true)).toBe(false);
});
