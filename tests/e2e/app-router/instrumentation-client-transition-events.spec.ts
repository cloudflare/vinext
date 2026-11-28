// Ported from Next.js:
// test/e2e/instrumentation-client-hook/instrumentation-client-hook.test.ts
// ("router transition start context")
// https://github.com/vercel/next.js/blob/v16.4.6/test/e2e/instrumentation-client-hook/instrumentation-client-hook.test.ts
//
// app-basic enables experimental.instrumentationClientRouterTransitionEvents,
// so onRouterTransitionStart receives a start event as its third argument.

import { test, expect, type Page } from "@playwright/test";
import { waitForAppRouterHydration } from "../helpers";

const BASE = "/instrumentation-client/transition-events";

type TransitionStart = {
  url: string;
  navigationType: string;
  event: {
    id: string;
    timestamp: number;
    fromRoutes: string[];
    prefetchIntent: string | null;
  } | null;
};

async function open(page: Page, pathname: string): Promise<void> {
  await page.goto(`${BASE}${pathname}`);
  await waitForAppRouterHydration(page);
}

async function getTransitionEvents(page: Page): Promise<TransitionStart[]> {
  return page.evaluate(
    () =>
      (window as Window & { __ROUTER_TRANSITION_EVENTS?: TransitionStart[] })
        .__ROUTER_TRANSITION_EVENTS ?? [],
  );
}

async function lastFromRoutes(page: Page): Promise<string[] | undefined> {
  return (await getTransitionEvents(page)).at(-1)?.event?.fromRoutes;
}

test.describe("instrumentation-client router transition start event", () => {
  test("reports transition metadata, source routes, and prefetch intent", async ({ page }) => {
    await open(page, "");
    await page.locator(`a[href="${BASE}/some-page"]`).click();
    await expect(page.locator("#some-page")).toBeVisible();

    const [start] = await getTransitionEvents(page);
    expect(start.url).toBe(`${BASE}/some-page`);
    expect(start.navigationType).toBe("push");
    expect(typeof start.event?.id).toBe("string");
    expect(start.event?.timestamp).toBeGreaterThan(0);
    expect(start.event?.fromRoutes).toEqual([BASE]);
    expect(start.event?.prefetchIntent).toBe("full");
  });

  test("reports a null prefetch intent for programmatic navigation", async ({ page }) => {
    await open(page, "");
    await page.locator("#push-some-page").click();
    await expect(page.locator("#some-page")).toBeVisible();

    const [start] = await getTransitionEvents(page);
    expect(start.url).toBe(`${BASE}/some-page`);
    expect(start.navigationType).toBe("push");
    expect(start.event?.prefetchIntent).toBe(null);
  });

  test("uses route patterns and puts the primary source route first", async ({ page }) => {
    await open(page, "");
    await page.locator(`a[href="${BASE}/blog/hello"]`).click();
    await expect(page.locator("#blog-post")).toBeVisible();
    await page.locator(`a[href="${BASE}"]`).click();
    await expect(page.locator("#home")).toBeVisible();

    expect(await lastFromRoutes(page)).toEqual([`${BASE}/blog/[slug]`]);
    expect((await getTransitionEvents(page)).at(-1)?.event?.prefetchIntent).toBe("auto");

    await page.locator(`a[href="${BASE}/dashboard"]`).click();
    await expect(page.locator("#dashboard")).toBeVisible();
    await expect(page.locator("#analytics")).toBeVisible();
    await page.locator(`a[href="${BASE}"]`).click();
    await expect(page.locator("#home")).toBeVisible();

    expect(await lastFromRoutes(page)).toEqual([
      `${BASE}/dashboard`,
      `${BASE}/dashboard/@analytics`,
    ]);
  });

  test("omits route groups from fromRoutes", async ({ page }) => {
    await open(page, "/about");
    await page.locator(`a[href="${BASE}"]`).click();
    await expect(page.locator("#home")).toBeVisible();

    expect(await lastFromRoutes(page)).toEqual([`${BASE}/about`]);
  });

  test("reports default and intercepted slot routes in fromRoutes", async ({ page }) => {
    await open(page, "/gallery");
    await page.locator(`a[href="${BASE}/gallery/photos/1"]`).click();
    await expect(page.locator("#photo-modal")).toBeVisible();

    // The gallery's @modal slot showed its default before the interception.
    expect(await lastFromRoutes(page)).toEqual([
      `${BASE}/gallery`,
      `${BASE}/gallery/@modal/default`,
    ]);

    await page.locator(`a[href="${BASE}"]`).click();
    await expect(page.locator("#home")).toBeVisible();

    expect(await lastFromRoutes(page)).toEqual([
      `${BASE}/gallery`,
      `${BASE}/gallery/@modal/(.)photos/[id]`,
    ]);
  });

  test("reports a null prefetch intent for back/forward navigation", async ({ page }) => {
    await open(page, "");
    await page.locator(`a[href="${BASE}/blog/hello"]`).click();
    await expect(page.locator("#blog-post")).toBeVisible();
    await page.goBack();
    await expect(page.locator("#home")).toBeVisible();

    const start = (await getTransitionEvents(page)).at(-1);
    expect(start?.navigationType).toBe("traverse");
    expect(start?.event?.prefetchIntent).toBe(null);
    expect(start?.event?.fromRoutes).toEqual([`${BASE}/blog/[slug]`]);
  });
});
