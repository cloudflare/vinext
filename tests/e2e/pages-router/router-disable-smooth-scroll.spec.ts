import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

const BASE = "http://localhost:4173";
const START_Y = 1000;

declare global {
  // oxlint-disable-next-line typescript/consistent-type-definitions -- Window augmentation requires interface merging.
  interface Window {
    __vinextSmoothScrollSamples?: number[];
  }
}

async function waitForHydration(page: Page) {
  await expect(async () => {
    const ready = await page.evaluate(() => !!(window as any).__VINEXT_ROOT__);
    expect(ready).toBe(true);
  }).toPass({ timeout: 10_000 });
}

async function setUpSmoothScrollPage(page: Page, options: { dataAttribute: boolean }) {
  await page.goto(`${BASE}/shallow-test`);
  await waitForHydration(page);
  await page.evaluate(
    ({ dataAttribute, startY }) => {
      const style = document.createElement("style");
      style.textContent = "html { scroll-behavior: smooth; }";
      document.head.appendChild(style);
      const spacer = document.createElement("div");
      spacer.style.height = "4000px";
      document.body.appendChild(spacer);
      if (dataAttribute) {
        document.documentElement.dataset.scrollBehavior = "smooth";
      }
      document.documentElement.style.scrollBehavior = "auto";
      window.scrollTo(0, startY);
      document.documentElement.style.scrollBehavior = "";
    },
    { dataAttribute: options.dataAttribute, startY: START_Y },
  );
  await expect
    .poll(() => page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior))
    .toBe("smooth");
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollTop)).toBe(START_Y);
  await page.evaluate(() => {
    const samples: number[] = [];
    window.__vinextSmoothScrollSamples = samples;
    window.addEventListener("scroll", () => {
      samples.push(document.documentElement.scrollTop);
    });
  });
}

async function shallowPushWithScroll(page: Page) {
  await page.evaluate(() =>
    (window as any).next.router.push("/shallow-test?tab=smooth", undefined, {
      shallow: true,
      scroll: true,
    }),
  );
  await expect(page).toHaveURL(`${BASE}/shallow-test?tab=smooth`);
}

function readSamples(page: Page) {
  return page.evaluate(() => window.__vinextSmoothScrollSamples ?? []);
}

// Next.js has no Pages Router e2e test for this. Its shallow scroll reset runs
// through Router.set() -> client/index.tsx, which wraps window.scrollTo in
// disableSmoothScrollDuringRouteTransition:
// https://github.com/vercel/next.js/blob/v16.2.7/packages/next/src/client/index.tsx
// next@16.2.7 jumps instantly with the data attribute and animates without it.
test.describe("Pages Router shallow scroll honours data-scroll-behavior", () => {
  test('shallow push with scroll jumps to the top without animating when <html data-scroll-behavior="smooth">', async ({
    page,
  }) => {
    await setUpSmoothScrollPage(page, { dataAttribute: true });

    await shallowPushWithScroll(page);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollTop)).toBe(0);

    expect((await readSamples(page)).filter((y) => y > 0 && y < START_Y)).toEqual([]);
    expect(
      await page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior),
    ).toBe("smooth");
  });

  test("shallow push with scroll keeps the smooth animation without the data attribute", async ({
    page,
  }) => {
    await setUpSmoothScrollPage(page, { dataAttribute: false });

    await shallowPushWithScroll(page);

    await expect
      .poll(async () => (await readSamples(page)).some((y) => y > 0 && y < START_Y))
      .toBe(true);
  });
});
