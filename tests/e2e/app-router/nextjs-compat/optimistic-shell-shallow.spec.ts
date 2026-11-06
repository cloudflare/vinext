import { expect, test, type Page } from "@playwright/test";
import { waitForAppRouterHydration } from "../../helpers";

const BASE = "http://localhost:4174";
const ROOT = "/nextjs-compat/optimistic-shell-shallow";

// Learns the route's shell template, then holds the response for the given
// sibling URL so its navigation commits the optimistic shell first.
async function prepareOptimisticShell(page: Page, id: string): Promise<() => void> {
  await page.goto(`${BASE}${ROOT}`);
  await waitForAppRouterHydration(page);
  await expect(page.locator("#optimistic-shell-home")).toBeVisible();

  // Settle a loading-shell prefetch for a sibling URL so the route's shell
  // template is learned. Dev links do not prefetch on viewport entry.
  const prefetchResponse = page.waitForResponse(
    (response) => response.url().includes(`${ROOT}/slow/1`) && response.url().includes("_rsc"),
  );
  await page.evaluate((href) => {
    const router = Reflect.get(window, "next") as { router: { prefetch(href: string): void } };
    router.router.prefetch(href);
  }, `${ROOT}/slow/1`);
  await (await prefetchResponse).finished();
  // The template is learned once the prefetch cache entry settles.
  await page.waitForTimeout(500);

  // Hold the navigation's response so the shell is visible before it lands.
  let releaseNavigation!: () => void;
  const navigationGate = new Promise<void>((resolve) => {
    releaseNavigation = resolve;
  });
  await page.route(`**${ROOT}/slow/${id}?_rsc*`, async (route) => {
    await navigationGate;
    await route.continue();
  });
  return releaseNavigation;
}

test.describe("shallow history write during an optimistic shell", () => {
  test("keeps the shallow URL while the navigation's content fills in", async ({ page }) => {
    const releaseNavigation = await prepareOptimisticShell(page, "2");

    const historyLength = await page.evaluate(() => history.length);
    await page.evaluate(() => {
      const state = window as unknown as { __debugRemoved?: boolean; __debugSeen?: boolean };
      new MutationObserver(() => {
        const present = document.querySelector('[data-testid="debug-mode"]') !== null;
        if (present) state.__debugSeen = true;
        else if (state.__debugSeen) state.__debugRemoved = true;
      }).observe(document.body, { childList: true, subtree: true });
    });

    await page.click("#slow-2-link");
    await expect(page.locator("#slow-loading")).toBeVisible();
    await expect(page.locator("#slow-2-page")).toHaveCount(0);

    await page.click("#enable-debug-btn");
    await expect(page).toHaveURL(`${BASE}${ROOT}/slow/2?debug=1`);
    await expect(page.getByTestId("debug-mode")).toBeVisible();

    releaseNavigation();
    await expect(page.locator("#slow-2-page")).toBeVisible({ timeout: 10_000 });
    await expect(page).toHaveURL(`${BASE}${ROOT}/slow/2?debug=1`);
    await expect(page.getByTestId("debug-mode")).toBeVisible();
    // Give a late URL write a chance to land before asserting it never did.
    await page.waitForTimeout(500);
    await expect(page).toHaveURL(`${BASE}${ROOT}/slow/2?debug=1`);
    expect(await page.evaluate(() => Reflect.get(window, "__debugRemoved") === true)).toBe(false);
    // The navigation's entry plus the shallow entry, as in Next.js.
    expect(await page.evaluate(() => history.length)).toBe(historyLength + 2);

    // The entry the shell committed to restores the completed page.
    await page.goBack();
    await expect(page).toHaveURL(`${BASE}${ROOT}/slow/2`);
    await expect(page.locator("#slow-2-page")).toBeVisible();
    await expect(page.locator("#slow-loading")).toHaveCount(0);

    await page.goForward();
    await expect(page).toHaveURL(`${BASE}${ROOT}/slow/2?debug=1`);
    await expect(page.locator("#slow-2-page")).toBeVisible();
    await expect(page.getByTestId("debug-mode")).toBeVisible();
  });

  test("a redirect the navigation follows still replaces the shallow URL", async ({ page }) => {
    // Matches Next.js: the shallow write retires only the navigation's own
    // URL, so the redirect target the content lands on becomes visible.
    const releaseNavigation = await prepareOptimisticShell(page, "redirect");

    await page.click("#slow-redirect-link");
    await expect(page.locator("#slow-loading")).toBeVisible();
    await page.click("#enable-debug-btn");
    await expect(page).toHaveURL(`${BASE}${ROOT}/slow/redirect?debug=1`);

    releaseNavigation();
    await expect(page.locator("#slow-3-page")).toBeVisible({ timeout: 10_000 });
    await expect(page).toHaveURL(`${BASE}${ROOT}/slow/3`);
    await expect(page.getByTestId("debug-mode")).toHaveCount(0);
  });
});
