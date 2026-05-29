import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { waitForAppRouterHydration } from "../../helpers";

const BASE = "http://localhost:4174";
const ROUTE_BASE = `${BASE}/nextjs-compat/router-autoscroll`;

type RouterAutoscrollControls = {
  push: (href: string) => void;
  pushThenRefresh: (href: string) => void;
  pushNoScroll: (href: string) => void;
  refresh: () => void;
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
          pushThenRefresh: typeof controls?.pushThenRefresh,
          pushNoScroll: typeof controls?.pushNoScroll,
          refresh: typeof controls?.refresh,
        };
      }),
    )
    .toEqual({
      push: "function",
      pushThenRefresh: "function",
      pushNoScroll: "function",
      refresh: "function",
    });
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

async function expectActiveElementId(page: Page, id: string) {
  await expect.poll(() => page.evaluate(() => document.activeElement?.id ?? null)).toBe(id);
}

async function expectActiveElementTestId(page: Page, testId: string) {
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? null))
    .toBe(testId);
}

async function expectActiveElementHref(page: Page, href: string) {
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.getAttribute("href") ?? null))
    .toBe(href);
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

  // Ported from Next.js:
  // test/e2e/app-dir/router-autoscroll/router-autoscroll.test.ts
  test("router.refresh() keeps the current scroll position when called alone", async ({ page }) => {
    await page.goto(`${ROUTE_BASE}/10/10000/100/1000/page1`);
    await waitForControls(page);

    await scrollTo(page, { x: 0, y: 12000 });
    await page.evaluate(() => {
      const controls = window.__vinextRouterAutoscroll;
      if (!controls) {
        throw new Error("router autoscroll controls are not installed");
      }
      controls.refresh();
    });
    await expectScroll(page, { x: 0, y: 12000 });
  });

  // Ported from Next.js:
  // test/e2e/app-dir/router-autoscroll/router-autoscroll.test.ts
  test("router.refresh() does not stop router.push() from scrolling", async ({ page }) => {
    await page.goto(`${ROUTE_BASE}/10/10000/100/1000/page1`);
    await waitForControls(page);
    const pageDocumentTop = await readElementDocumentTop(page, "#page");

    await scrollTo(page, { x: 0, y: 12000 });
    await page.evaluate(() => {
      const controls = window.__vinextRouterAutoscroll;
      if (!controls) {
        throw new Error("router autoscroll controls are not installed");
      }
      controls.pushThenRefresh("/nextjs-compat/router-autoscroll/10/10000/100/1000/page2");
    });
    await expect(page.locator("#page")).toHaveText("page2");
    await expectScroll(page, { x: 0, y: pageDocumentTop });
  });

  // Ported from Next.js:
  // test/e2e/app-dir/router-autoscroll/router-autoscroll.test.ts
  test("server action refresh keeps the current scroll position", async ({ page }) => {
    await page.goto(`${ROUTE_BASE}/server-action-refresh`);
    await waitForControls(page);
    const initialTimestamp = await page.locator("#server-timestamp").textContent();

    await scrollTo(page, { x: 0, y: 1000 });
    await page.locator("#refresh-button").click();

    await expect
      .poll(() => page.locator("#server-timestamp").textContent())
      .not.toBe(initialTimestamp);
    await expectScroll(page, { x: 0, y: 1000 });
  });

  // Ported from Next.js:
  // test/e2e/app-dir/router-autoscroll/router-autoscroll.test.ts
  for (const [kind, label] of [
    ["display-none", "display: none"],
    ["fixed", "position: fixed"],
    ["sticky", "position: sticky"],
  ] as const) {
    test(`skips first child ${label} and targets the first renderable sibling`, async ({
      page,
    }) => {
      await page.goto(`${ROUTE_BASE}`);
      await waitForControls(page);

      await scrollTo(page, { x: 1000, y: 500 });
      await push(page, `/nextjs-compat/router-autoscroll/skipped-target/${kind}`);
      await expect(page.locator('[data-testid="selected-scroll-target"]')).toHaveText(
        `Selected target: ${kind}`,
      );
      await expectScroll(page, { x: 1000, y: 0 });
      await expectActiveElementTestId(page, "selected-scroll-target");
    });
  }

  // Ported from Next.js:
  // test/e2e/app-dir/router-autoscroll/router-autoscroll.test.ts
  test("applies scroll when loading commits and keeps it stable for final content", async ({
    page,
  }) => {
    await page.goto(`${ROUTE_BASE}`);
    await waitForControls(page);

    await scrollTo(page, { x: 1000, y: 500 });
    await page.evaluate(() => {
      const controls = window.__vinextRouterAutoscroll;
      if (!controls) {
        throw new Error("router autoscroll controls are not installed");
      }
      controls.push("/nextjs-compat/router-autoscroll/loading-scroll");
    });
    await expectScroll(page, { x: 1000, y: 500 });

    await expect(page.locator("#loading-component")).toBeVisible();
    await expectScroll(page, { x: 1000, y: 0 });

    await expect(page.locator("#content-that-is-visible")).toBeVisible();
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
  // test/e2e/app-dir/router-autoscroll/router-autoscroll.test.ts
  test("scrolls on same-page search param changes while preserving scroll false", async ({
    page,
  }) => {
    await page.goto(`${ROUTE_BASE}/loading-scroll?skipSleep=1`);
    await waitForControls(page);
    await expect(page.locator("#content-that-is-visible")).toBeVisible();

    await page.locator("#pages").scrollIntoViewIfNeeded();
    const samePageScrollY = await page.evaluate(() => Math.round(window.scrollY));
    expect(samePageScrollY).toBeGreaterThan(0);

    await push(page, "/nextjs-compat/router-autoscroll/loading-scroll?page=2&skipSleep=1");
    await expect(page.locator("#current-page")).toHaveText("2");
    await expectScroll(page, { x: 0, y: 0 });

    await page.locator("#pages").scrollIntoViewIfNeeded();
    const noScrollY = await page.evaluate(() => Math.round(window.scrollY));
    expect(noScrollY).toBeGreaterThan(0);

    await push(page, "/nextjs-compat/router-autoscroll/loading-scroll?page=3&skipSleep=1", {
      scroll: false,
    });
    await expect(page.locator("#current-page")).toHaveText("3");
    await expectScroll(page, { x: 0, y: noScrollY });
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

  // Ported from Next.js:
  // test/e2e/app-dir/navigation-focus/navigation-focus.test.ts
  test("focuses a scrollable navigated segment", async ({ page }) => {
    await page.goto(`${ROUTE_BASE}`);
    await waitForControls(page);

    await page.locator("#to-scrollable-segment").click();
    await expect(page.locator('[data-testid="segment-container"]')).toBeVisible();
    await expectActiveElementTestId(page, "segment-container");
  });

  // Ported from Next.js:
  // test/e2e/app-dir/navigation-focus/navigation-focus.test.ts
  test("keeps focus on the source link for a segment with a focusable descendant", async ({
    page,
  }) => {
    await page.goto(`${ROUTE_BASE}`);
    await waitForControls(page);

    await page.locator("#to-focusable-descendant").click();
    await expect(page.locator('[data-testid="focusable-descendant"]')).toBeVisible();
    await expectActiveElementHref(
      page,
      "/nextjs-compat/router-autoscroll/segment-with-focusable-descendant",
    );
  });

  // Ported from Next.js:
  // test/e2e/app-dir/navigation-focus/navigation-focus.test.ts
  test("keeps focus on the source link for fragment navigation to a new segment", async ({
    page,
  }) => {
    await page.goto(`${ROUTE_BASE}`);
    await waitForControls(page);

    await page.locator("#to-uri-fragment").click();
    await expect(page).toHaveURL(`${ROUTE_BASE}/uri-fragments#section-2`);
    await expectActiveElementHref(page, "/nextjs-compat/router-autoscroll/uri-fragments#section-2");
  });

  // Ported from Next.js:
  // test/e2e/app-dir/navigation-focus/navigation-focus.test.ts
  test("keeps focus on the source link for same-page fragment navigation", async ({ page }) => {
    await page.goto(`${ROUTE_BASE}/uri-fragments`);
    await waitForControls(page);

    await page.locator("#to-section-1").click();
    await expect(page).toHaveURL(`${ROUTE_BASE}/uri-fragments#section-1`);
    await expectActiveElementHref(page, "#section-1");
  });

  // Ported from Next.js:
  // test/e2e/app-dir/router-autoscroll/router-autoscroll.test.ts
  test("scrolls to top when navigating to a page with new metadata", async ({ page }) => {
    await page.goto(`${ROUTE_BASE}`);
    await waitForControls(page);

    await page.evaluate(() => {
      window.scrollTo(0, document.documentElement.scrollHeight);
    });
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);

    await page.locator("#to-new-metadata").click();
    await expect(page.locator("#new-metadata-page")).toBeVisible();
    await expectScroll(page, { x: 0, y: 0 });
  });

  // Ported from Next.js:
  // test/e2e/app-dir/router-autoscroll/router-autoscroll.test.ts
  test("scrolls to top even if React hoists children", async ({ page }) => {
    await page.goto(`${ROUTE_BASE}`);
    await waitForControls(page);

    await page.evaluate(() => {
      window.scrollTo(0, document.documentElement.scrollHeight);
    });
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);

    await page.locator("#to-hoisted").click();
    await expect(page.locator("#hoisted-page")).toBeVisible();
    await expectScroll(page, { x: 0, y: 0 });
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

  // Ported from Next.js:
  // test/e2e/app-dir/navigation-focus/navigation-focus.test.ts
  test("does not steal focus for a non-focusable selected target", async ({ page }) => {
    await page.goto(`${ROUTE_BASE}`);
    await waitForControls(page);

    await scrollTo(page, { x: 0, y: 500 });
    await page.click("#to-non-focusable");
    await expect(page.locator('[data-testid="non-focusable-target"]')).toBeVisible();
    await expectScroll(page, { x: 0, y: 0 });
    await expectActiveElementId(page, "to-non-focusable");
  });

  test("only the latest rapid navigation consumes the scroll intent", async ({ page }) => {
    await page.goto(`${ROUTE_BASE}`);
    await waitForControls(page);

    await scrollTo(page, { x: 1000, y: 500 });
    await page.evaluate(() => {
      const controls = window.__vinextRouterAutoscroll;
      if (!controls) {
        throw new Error("router autoscroll controls are not installed");
      }
      controls.push("/nextjs-compat/router-autoscroll/race/a");
      controls.push("/nextjs-compat/router-autoscroll/race/b");
      controls.push("/nextjs-compat/router-autoscroll/race/c");
    });

    await expect(page.locator('[data-testid="race-target"]')).toHaveText("Race target c");
    await expectScroll(page, { x: 1000, y: 0 });
    await expectActiveElementTestId(page, "race-target");

    await expect.poll(() => page.url(), { timeout: 1500 }).toBe(`${ROUTE_BASE}/race/c`);
    await expect(page.locator('[data-testid="race-target"]')).toHaveText("Race target c");
    await expectScroll(page, { x: 1000, y: 0 });
    await expectActiveElementTestId(page, "race-target");
  });
});
