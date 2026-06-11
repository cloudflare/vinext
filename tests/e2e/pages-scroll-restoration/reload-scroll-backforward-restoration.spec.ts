import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures";
import { waitForHydration } from "../helpers";

const BASE = "http://localhost:4185";

type ScrollPosition = { x: number; y: number };

async function scrollLinkIntoView(page: Page): Promise<void> {
  await page.evaluate(() => document.querySelector("#link")?.scrollIntoView());
}

async function getScrollPosition(page: Page): Promise<ScrollPosition> {
  return page.evaluate(() => ({
    x: Math.floor(window.scrollX),
    y: Math.floor(window.scrollY),
  }));
}

async function expectScrollPosition(page: Page, expected: ScrollPosition) {
  await expect.poll(() => getScrollPosition(page)).toEqual(expected);
}

async function expectRouteChangeComplete(page: Page): Promise<void> {
  await expect(page.locator("html")).toContainText("routeChangeComplete");
}

async function pushWithPagesRouter(page: Page, href: string): Promise<void> {
  await page.evaluate(async (target) => {
    const router = window.next?.router;
    if (!router) {
      throw new Error("window.next.router is not installed");
    }
    await Promise.resolve(router.push(target));
  }, href);
}

async function isPagesRouterReady(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const router = window.next?.router;
    if (!router || !("isReady" in router)) return false;
    return router.isReady === true;
  });
}

test.describe("reload-scroll-back-restoration", () => {
  // Ported from Next.js: test/e2e/reload-scroll-backforward-restoration/index.test.ts
  // https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/reload-scroll-backforward-restoration/index.test.ts
  test("should restore the scroll position on navigating back", async ({ page }) => {
    await page.goto(`${BASE}/0`);
    await waitForHydration(page);
    await scrollLinkIntoView(page);

    const scrollRestoration = await page.evaluate(() => window.history.scrollRestoration);
    expect(scrollRestoration).toBe("manual");

    const scrollPositionMemories: ScrollPosition[] = [];
    scrollPositionMemories.push(await getScrollPosition(page));

    expect(scrollPositionMemories[0].x).not.toBe(0);
    expect(scrollPositionMemories[0].y).not.toBe(0);

    await pushWithPagesRouter(page, "/1");
    await scrollLinkIntoView(page);
    scrollPositionMemories.push(await getScrollPosition(page));
    await pushWithPagesRouter(page, "/2");

    await page.goBack();
    await expectRouteChangeComplete(page);
    await expectScrollPosition(page, scrollPositionMemories[1]);

    await page.reload();

    await expect.poll(() => isPagesRouterReady(page)).toBe(true);

    await page.goBack();
    await expectRouteChangeComplete(page);
    await expectScrollPosition(page, scrollPositionMemories[0]);
  });

  test("should restore the scroll position on navigating forward", async ({ page }) => {
    await page.goto(`${BASE}/0`);
    await waitForHydration(page);
    await scrollLinkIntoView(page);

    const scrollRestoration = await page.evaluate(() => window.history.scrollRestoration);
    expect(scrollRestoration).toBe("manual");

    const scrollPositionMemories: ScrollPosition[] = [];
    scrollPositionMemories.push(await getScrollPosition(page));

    expect(scrollPositionMemories[0].x).not.toBe(0);
    expect(scrollPositionMemories[0].y).not.toBe(0);

    await pushWithPagesRouter(page, "/1");
    await scrollLinkIntoView(page);
    scrollPositionMemories.push(await getScrollPosition(page));
    await pushWithPagesRouter(page, "/2");
    await scrollLinkIntoView(page);
    scrollPositionMemories.push(await getScrollPosition(page));

    await page.goBack();
    await page.goBack();
    await page.goForward();
    await expectRouteChangeComplete(page);
    await expectScrollPosition(page, scrollPositionMemories[1]);

    await page.reload();

    await expect.poll(() => isPagesRouterReady(page)).toBe(true);

    await page.goForward();
    await expectRouteChangeComplete(page);
    await expectScrollPosition(page, scrollPositionMemories[2]);
  });
});
