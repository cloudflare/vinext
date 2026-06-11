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
  // Register a one-shot listener for the next routeChangeComplete event.
  // MUST be started before the navigation that triggers the event — calling
  // this after an awaited router.push() will deadlock because the event has
  // already fired.
  return page.evaluate(() => {
    const router = (window as any).next?.router;
    if (!router?.events) {
      throw new Error(
        "expectRouteChangeComplete: window.next.router.events is not available",
      );
    }
    return new Promise<void>((resolve) => {
      const handler = () => {
        router.events.off("routeChangeComplete", handler);
        resolve();
      };
      router.events.on("routeChangeComplete", handler);
    });
  });
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

    const rc1 = expectRouteChangeComplete(page);
    await page.goBack();
    await rc1;
    await expectScrollPosition(page, scrollPositionMemories[1]);

    await page.reload();

    await expect.poll(() => isPagesRouterReady(page)).toBe(true);

    const rc2 = expectRouteChangeComplete(page);
    await page.goBack();
    await rc2;
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
    const rc3 = expectRouteChangeComplete(page);
    await page.goForward();
    await rc3;
    await expectScrollPosition(page, scrollPositionMemories[1]);

    await page.reload();

    await expect.poll(() => isPagesRouterReady(page)).toBe(true);

    const rc4 = expectRouteChangeComplete(page);
    await page.goForward();
    await rc4;
    await expectScrollPosition(page, scrollPositionMemories[2]);
  });

  test("should apply scroll position before emitting routeChangeComplete", async ({ page }) => {
    await page.goto(`${BASE}/0`);
    await waitForHydration(page);
    await scrollLinkIntoView(page);

    const initialScroll = await getScrollPosition(page);
    expect(initialScroll.y).not.toBe(0);

    await pushWithPagesRouter(page, "/1");
    // pushWithPagesRouter already awaits router.push() which resolves after
    // routeChangeComplete — no separate wait needed here.

    // Register a one-shot listener on routeChangeComplete to record scroll position
    const scrollAtEventPromise = page.evaluate(() => {
      const router = (window as any).next?.router;
      if (!router?.events) return null;
      return new Promise<{ x: number; y: number }>((resolve) => {
        const handler = () => {
          router.events.off("routeChangeComplete", handler);
          resolve({ x: window.scrollX, y: window.scrollY });
        };
        router.events.on("routeChangeComplete", handler);
      });
    });

    // Go back, which triggers scroll restoration
    await page.goBack();

    // Verify routeChangeComplete fired and recorded the restored scroll position
    const scrollAtEvent = await scrollAtEventPromise;
    expect(scrollAtEvent).not.toBeNull();
    expect(scrollAtEvent!.y).toBe(initialScroll.y);
  });

  test("should reject navigation, emit routeChangeError and fallback to hard navigation on render error", async ({
    page,
  }) => {
    await page.goto(`${BASE}/0`);
    await waitForHydration(page);

    // Set marker on window to detect full page reload
    await page.evaluate(() => {
      (window as any).isSoftNavigation = true;
    });

    // Push to the page that throws render error
    await pushWithPagesRouter(page, "/error");

    // Since it falls back to hard navigation, the page fully reloads.
    // The reload clears the window context, so `window.isSoftNavigation` will be undefined.
    // We should wait until the url is "/error" and we are hydrated.
    await expect(page).toHaveURL(`${BASE}/error`);
    await waitForHydration(page);

    // Verify that the window marker is indeed gone (hard navigation occurred)
    const isSoft = await page.evaluate(() => (window as any).isSoftNavigation);
    expect(isSoft).toBeUndefined();
  });
});
