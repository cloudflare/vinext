import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { waitForAppRouterHydration } from "../../helpers";

const BASE = "http://localhost:4174";
const ROUTE_BASE = `${BASE}/nextjs-compat/router-autoscroll`;

type RouterAutoscrollControls = {
  push: (href: string) => void;
  pushNoScroll: (href: string) => void;
};

declare global {
  // oxlint-disable-next-line typescript/consistent-type-definitions -- Window augmentation requires interface merging.
  interface Window {
    __vinextRouterAutoscroll?: RouterAutoscrollControls;
  }
}

async function waitForControls(page: Page) {
  await waitForAppRouterHydration(page);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const controls = window.__vinextRouterAutoscroll;
        return {
          push: typeof controls?.push,
          pushNoScroll: typeof controls?.pushNoScroll,
        };
      }),
    )
    .toEqual({ push: "function", pushNoScroll: "function" });
}

async function push(page: Page, href: string, options: { scroll?: boolean } = {}) {
  await page.evaluate(
    ({ href: targetHref, scroll }) => {
      const controls = window.__vinextRouterAutoscroll;
      if (!controls) {
        throw new Error("router autoscroll controls are not installed");
      }
      if (scroll === false) {
        controls.pushNoScroll(targetHref);
      } else {
        controls.push(targetHref);
      }
    },
    { href, scroll: options.scroll },
  );
}

async function scrollTo(page: Page, position: { x: number; y: number }) {
  await page.evaluate(({ x, y }) => {
    window.scrollTo(x, y);
  }, position);
  await expectScroll(page, position);
}

async function expectScroll(page: Page, position: { x: number; y: number }) {
  await expect
    .poll(() =>
      page.evaluate(() => ({
        x: document.documentElement.scrollLeft,
        y: document.documentElement.scrollTop,
      })),
    )
    .toEqual(position);
}

async function readElementDocumentTop(page: Page, selector: string) {
  return page
    .locator(selector)
    .evaluate((element) => Math.round(element.getBoundingClientRect().top + window.scrollY));
}

test.describe("Next.js compat: App Router autoscroll", () => {
  // Ported from Next.js:
  // test/e2e/app-dir/router-autoscroll/router-autoscroll.test.ts
  test("scrolls to top of document when navigating between pages without layout offset", async ({
    page,
  }) => {
    await page.goto(`${ROUTE_BASE}/0/0/100/10000/page1`);
    await waitForControls(page);

    await scrollTo(page, { x: 0, y: 1000 });
    await push(page, "/nextjs-compat/router-autoscroll/0/0/100/10000/page2");
    await expect(page.locator("#page")).toHaveText("page2");
    await expectScroll(page, { x: 0, y: 0 });
  });

  test("scrolls down to the navigated page when it is below the viewport", async ({ page }) => {
    await page.goto(`${ROUTE_BASE}/0/1000/100/1000/page1`);
    await waitForControls(page);
    await expectScroll(page, { x: 0, y: 0 });
    const pageDocumentTop = await readElementDocumentTop(page, "#page");

    await push(page, "/nextjs-compat/router-autoscroll/0/1000/100/1000/page2");
    await expect(page.locator("#page")).toHaveText("page2");
    await expectScroll(page, { x: 0, y: pageDocumentTop });
  });

  test("does not scroll when the navigated page top is already in the viewport", async ({
    page,
  }) => {
    await page.goto(`${ROUTE_BASE}/10/1000/100/1000/page1`);
    await waitForControls(page);

    await scrollTo(page, { x: 0, y: 800 });
    await push(page, "/nextjs-compat/router-autoscroll/10/1000/100/1000/page2");
    await expect(page.locator("#page")).toHaveText("page2");
    await expectScroll(page, { x: 0, y: 800 });
  });

  test("preserves horizontal scroll while vertically autoscrolling", async ({ page }) => {
    await page.goto(`${ROUTE_BASE}/0/0/10000/10000/page1`);
    await waitForControls(page);

    await scrollTo(page, { x: 1000, y: 1000 });
    await push(page, "/nextjs-compat/router-autoscroll/0/0/10000/10000/page2");
    await expect(page.locator("#page")).toHaveText("page2");
    await expectScroll(page, { x: 1000, y: 0 });
  });

  test("does not scroll when scroll is false", async ({ page }) => {
    await page.goto(`${ROUTE_BASE}/0/0/100/10000/page1`);
    await waitForControls(page);

    await scrollTo(page, { x: 0, y: 1000 });
    await push(page, "/nextjs-compat/router-autoscroll/0/0/100/10000/page2", {
      scroll: false,
    });
    await expect(page.locator("#page")).toHaveText("page2");
    await expectScroll(page, { x: 0, y: 1000 });
  });

  // Ported from Next.js:
  // test/e2e/app-dir/navigation-focus/navigation-focus.test.ts
  test("focuses the interactive navigated segment", async ({ page }) => {
    await page.goto(`${ROUTE_BASE}`);
    await waitForControls(page);

    await push(page, "/nextjs-compat/router-autoscroll/focus-target");
    await expect(page.locator('[data-testid="segment-container"]')).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? null))
      .toBe("segment-container");
  });

  test("preserves horizontal scroll when focusing the navigated segment", async ({ page }) => {
    // Next's horizontal autoscroll coverage uses a non-focusable route root, so it
    // misses the second browser scroll caused by focusing an offscreen target.
    // Vinext intentionally prevents that extra focus scroll.
    await page.goto(`${ROUTE_BASE}/0/0/10000/10000/page1`);
    await waitForControls(page);

    await scrollTo(page, { x: 1000, y: 1000 });
    await push(page, "/nextjs-compat/router-autoscroll/focus-target");
    await expect(page.locator('[data-testid="segment-container"]')).toHaveCount(1);
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? null))
      .toBe("segment-container");
    await expectScroll(page, { x: 1000, y: 0 });
  });
});
