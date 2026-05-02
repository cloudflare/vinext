import type { Page } from "@playwright/test";
import { test, expect } from "@playwright/test";
import { waitForAppRouterHydration } from "../../helpers";

const BASE = "http://localhost:4174";

test.describe("Next.js compat: hash popstate scroll", () => {
  async function expectScrollY(page: Page, expected: number) {
    await expect(async () => {
      const scrollY = await page.evaluate(() => window.scrollY);
      expect(scrollY).toBe(expected);
    }).toPass();
  }

  async function expectHashForwardTraversal(
    page: Page,
    linkSelector: string,
    hash: string,
    targetSelector: string,
  ) {
    await page.goto(`${BASE}/nextjs-compat/hash-popstate-scroll`);
    await waitForAppRouterHydration(page);
    await expect(page.locator("h1")).toHaveText("Hash Popstate Scroll");

    await page.click(linkSelector);
    await expect(page).toHaveURL(`${BASE}/nextjs-compat/hash-popstate-scroll${hash}`);

    await page.goBack();
    await expect(page).toHaveURL(`${BASE}/nextjs-compat/hash-popstate-scroll`);
    await expectScrollY(page, 0);

    await page.goForward();
    await expect(page).toHaveURL(`${BASE}/nextjs-compat/hash-popstate-scroll${hash}`);
    await expect(page.locator(targetSelector)).toBeInViewport();
  }

  // Ported from the App Router hash-scroll behavior covered by:
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/navigation/navigation.test.ts
  // Next.js stores hash scroll intent in focusAndScrollRef and layout-router
  // consumes it after navigation commits.
  test("forward traversal to a hash-only Link entry scrolls the anchor into view", async ({
    page,
  }) => {
    await page.goto(`${BASE}/nextjs-compat/hash-popstate-scroll`);
    await waitForAppRouterHydration(page);
    await expect(page.locator("h1")).toHaveText("Hash Popstate Scroll");

    await page.click("#hash-link");
    await expect(page).toHaveURL(`${BASE}/nextjs-compat/hash-popstate-scroll#content`);
    await expect(page.locator("#content")).toBeInViewport();

    await page.goBack();
    await expect(page).toHaveURL(`${BASE}/nextjs-compat/hash-popstate-scroll`);
    await expectScrollY(page, 0);

    await page.goForward();
    await expect(page).toHaveURL(`${BASE}/nextjs-compat/hash-popstate-scroll#content`);
    await expect(page.locator("#content")).toBeInViewport();
  });

  test("forward traversal decodes non-latin hash fragments", async ({ page }) => {
    await expectHashForwardTraversal(page, "#encoded-link", "#caf%C3%A9", '[id="café"]');
  });

  test("forward traversal falls back to named anchors", async ({ page }) => {
    await expectHashForwardTraversal(
      page,
      "#name-link",
      "#legacy-anchor",
      '[name="legacy-anchor"]',
    );
  });

  test("forward traversal to #top scrolls to the top", async ({ page }) => {
    await page.goto(`${BASE}/nextjs-compat/hash-popstate-scroll`);
    await waitForAppRouterHydration(page);

    await page.click("#hash-link");
    await expect(page).toHaveURL(`${BASE}/nextjs-compat/hash-popstate-scroll#content`);
    await expect(page.locator("#content")).toBeInViewport();

    await page.evaluate(() => document.getElementById("top-link")?.click());
    await expect(page).toHaveURL(`${BASE}/nextjs-compat/hash-popstate-scroll#top`);

    await page.goBack();
    await expect(page).toHaveURL(`${BASE}/nextjs-compat/hash-popstate-scroll#content`);
    await expect(page.locator("#content")).toBeInViewport();

    await page.goForward();
    await expect(page).toHaveURL(`${BASE}/nextjs-compat/hash-popstate-scroll#top`);
    await expectScrollY(page, 0);
  });
});
