import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { waitForAppRouterHydration } from "../../helpers";

const BASE = "http://localhost:4174";
const ROUTE_BASE = `${BASE}/nextjs-compat/router-disable-smooth-scroll`;
const START_Y = 1000;
const MISSING_DATA_ATTRIBUTE_WARNING =
  "Detected `scroll-behavior: smooth` on the `<html>` element.";

declare global {
  // oxlint-disable-next-line typescript/consistent-type-definitions -- Window augmentation requires interface merging.
  interface Window {
    __vinextSmoothScrollSamples?: number[];
  }
}

async function enableSmoothScroll(page: Page, options: { dataAttribute: boolean }) {
  await page.evaluate(({ dataAttribute }) => {
    const style = document.createElement("style");
    style.textContent = "html { scroll-behavior: smooth; }";
    document.head.appendChild(style);
    if (dataAttribute) {
      document.documentElement.dataset.scrollBehavior = "smooth";
    }
  }, options);
  await expect
    .poll(() => page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior))
    .toBe("smooth");
}

async function scrollToStart(page: Page) {
  await page.evaluate((y) => {
    document.documentElement.style.scrollBehavior = "auto";
    window.scrollTo(0, y);
    document.documentElement.style.scrollBehavior = "";
  }, START_Y);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollTop)).toBe(START_Y);
}

async function recordScrollSamples(page: Page) {
  await page.evaluate(() => {
    const samples: number[] = [];
    window.__vinextSmoothScrollSamples = samples;
    window.addEventListener("scroll", () => {
      samples.push(document.documentElement.scrollTop);
    });
  });
}

async function navigate(page: Page) {
  // Playwright's click() first scrolls the link into view instantly. The link
  // sits at the top of page 1, so that pre-scroll alone would reach y=0 and
  // leave the router nothing to animate. Click from the page instead.
  await page.locator("#to-page2").evaluate((link: HTMLElement) => link.click());
  await expect(page.locator("#smooth-scroll-page")).toHaveText("Page 2");
}

function readSamples(page: Page) {
  return page.evaluate(() => window.__vinextSmoothScrollSamples ?? []);
}

function collectConsoleMessages(page: Page) {
  const messages: string[] = [];
  page.on("console", (message) => messages.push(message.text()));
  return messages;
}

// Ported from Next.js:
// test/e2e/app-dir/router-disable-smooth-scroll/router-disable-smooth-scroll.optimized.test.ts
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/router-disable-smooth-scroll/router-disable-smooth-scroll.optimized.test.ts
// Upstream only asserts the final position, which a smooth animation also
// reaches. These tests sample every scroll event so an animated scroll fails.
// The app-router project runs the dev server, so the missing-attribute
// warning is expected (upstream: `shouldWarn = isNextDev`).
test.describe("Next.js compat: router smooth scroll override", () => {
  test('jumps to the top without animating when <html data-scroll-behavior="smooth">', async ({
    page,
  }) => {
    const consoleMessages = collectConsoleMessages(page);
    await page.goto(`${ROUTE_BASE}/page1`);
    await waitForAppRouterHydration(page);
    await enableSmoothScroll(page, { dataAttribute: true });
    await scrollToStart(page);
    await recordScrollSamples(page);

    await navigate(page);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollTop)).toBe(0);

    expect((await readSamples(page)).filter((y) => y > 0 && y < START_Y)).toEqual([]);
    expect(
      await page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior),
    ).toBe("smooth");
    expect(consoleMessages.some((text) => text.includes(MISSING_DATA_ATTRIBUTE_WARNING))).toBe(
      false,
    );
  });

  test("keeps the smooth animation without the data attribute (Next.js 16 default)", async ({
    page,
  }) => {
    const consoleMessages = collectConsoleMessages(page);
    await page.goto(`${ROUTE_BASE}/page1`);
    await waitForAppRouterHydration(page);
    await enableSmoothScroll(page, { dataAttribute: false });
    await scrollToStart(page);
    await recordScrollSamples(page);

    await navigate(page);

    await expect
      .poll(async () => (await readSamples(page)).some((y) => y > 0 && y < START_Y))
      .toBe(true);
    await expect
      .poll(() => consoleMessages.some((text) => text.includes(MISSING_DATA_ATTRIBUTE_WARNING)))
      .toBe(true);
  });
});
