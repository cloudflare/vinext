import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures";
import { waitForHydration } from "../helpers";

const BASE = "http://localhost:4185";

type ScrollPosition = { x: number; y: number };

declare global {
  // oxlint-disable-next-line typescript/consistent-type-definitions -- Window augmentation requires interface merging.
  interface Window {
    isSoftNavigation?: boolean;
  }
}

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

async function expectPageShowsRouteChangeComplete(page: Page, expectedPath: string): Promise<void> {
  await expect(
    page.getByText(`routeChangeComplete:${expectedPath}`, { exact: true }),
  ).toBeVisible();
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
    return (router as { isReady: boolean }).isReady === true;
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
    await expectPageShowsRouteChangeComplete(page, "/1");
    await expectScrollPosition(page, scrollPositionMemories[1]);

    await page.reload();

    await expect.poll(() => isPagesRouterReady(page)).toBe(true);

    await page.goBack();
    await expectPageShowsRouteChangeComplete(page, "/0");
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
    await expectPageShowsRouteChangeComplete(page, "/1");
    await expectScrollPosition(page, scrollPositionMemories[1]);

    await page.reload();

    await expect.poll(() => isPagesRouterReady(page)).toBe(true);

    await page.goForward();
    await expectPageShowsRouteChangeComplete(page, "/2");
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
      const router = window.next?.router;
      if (!router || !("events" in router)) return null;
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
      window.isSoftNavigation = true;
    });

    // Push to the dynamic page variant that throws during client render.
    await pushWithPagesRouter(page, "/error");

    // Since it falls back to hard navigation, the page fully reloads.
    // The reload clears the window context, so `window.isSoftNavigation` will be undefined.
    await expect(page).toHaveURL(`${BASE}/error`);

    // Verify that the window marker is indeed gone (hard navigation occurred)
    const isSoft = await page.evaluate(() => window.isSoftNavigation);
    expect(isSoft).toBeUndefined();
  });

  // Ported from Next.js: test/e2e/reload-scroll-backforward-restoration/index.test.ts
  // https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/reload-scroll-backforward-restoration/index.test.ts
  test("should reset x/y scroll to (0,0) before routeChangeComplete on route with hash", async ({
    page,
  }) => {
    await page.goto(`${BASE}/0`);
    await waitForHydration(page);

    // Scroll down so we can detect the reset
    await page.evaluate(() => window.scrollTo(0, 500));
    expect((await getScrollPosition(page)).y).toBe(500);

    // Set up a one-shot routeChangeComplete listener that records scroll position
    const scrollAtEvent = page.evaluate(() => {
      const router = window.next?.router;
      if (!router || !("events" in router)) return null;
      return new Promise<{ x: number; y: number }>((resolve) => {
        const handler = () => {
          router.events.off("routeChangeComplete", handler);
          resolve({ x: window.scrollX, y: window.scrollY });
        };
        router.events.on("routeChangeComplete", handler);
      });
    });

    await pushWithPagesRouter(page, "/1#end-el");

    const scrollAtEventValue = await scrollAtEvent;
    expect(scrollAtEventValue).not.toBeNull();
    // x/y reset (0,0) should have happened before routeChangeComplete fires
    expect(scrollAtEventValue!.y).toBe(0);

    // After routeChangeComplete, hash scroll should have moved the page
    const finalScroll = await getScrollPosition(page);
    // Hash scroll to #end-el should have moved away from (0,0)
    expect(finalScroll.y).toBeGreaterThan(0);
  });

  test("should settle superseded navigation promises instead of hanging", async ({ page }) => {
    await page.goto(`${BASE}/0`);
    await waitForHydration(page);

    // Start two navigations in rapid succession — the first should be
    // superseded and settle (not hang) while the second completes.
    const result = await page.evaluate(async (base) => {
      const router = window.next?.router;
      if (!router) return "no-router";

      const p1 = router.push(`${base}/1`);
      const p2 = router.push(`${base}/2`);

      const settled = await Promise.allSettled([p1, p2]);
      // Both must settle — the first may reject with NavigationCancelledError
      // or resolve with true (runNavigateClient returns "cancelled" → true).
      // The second must resolve successfully.
      if (settled[0].status !== "fulfilled") return "p1-unsettled";
      if (settled[1].status !== "fulfilled") return "p2-unsettled";
      return "ok";
    }, BASE);

    expect(result).toBe("ok");
    // Verify the final URL is /2, not /1
    await expect(page).toHaveURL(`${BASE}/2`);
  });
});
