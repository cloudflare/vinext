import type { Page } from "@playwright/test";
import { test, expect } from "@playwright/test";
import { waitForAppRouterHydration } from "../../helpers";

const BASE = "http://localhost:4174";

test.describe("Next.js compat: hash popstate scroll", () => {
  async function readVinextHistoryIndex(page: Page) {
    return page.evaluate(() => {
      const state = window.history.state;
      if (!state || typeof state !== "object") return null;

      const value = (state as Record<string, unknown>).__vinext_historyIndex;
      return typeof value === "number" ? value : null;
    });
  }

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

  test("hash-only Link entries carry vinext traversal metadata", async ({ page }) => {
    await page.goto(`${BASE}/nextjs-compat/hash-popstate-scroll`);
    await waitForAppRouterHydration(page);
    await expect(page.locator("h1")).toHaveText("Hash Popstate Scroll");
    expect(await readVinextHistoryIndex(page)).toBe(0);

    await page.click("#hash-link");
    await expect(page).toHaveURL(`${BASE}/nextjs-compat/hash-popstate-scroll#content`);
    expect(await readVinextHistoryIndex(page)).toBe(1);

    await page.goBack();
    await expect(page).toHaveURL(`${BASE}/nextjs-compat/hash-popstate-scroll`);
    expect(await readVinextHistoryIndex(page)).toBe(0);

    await page.goForward();
    await expect(page).toHaveURL(`${BASE}/nextjs-compat/hash-popstate-scroll#content`);
    expect(await readVinextHistoryIndex(page)).toBe(1);
  });

  test("hash-only replace after back keeps the current traversal index", async ({ page }) => {
    await page.goto(`${BASE}/nextjs-compat/hash-popstate-scroll`);
    await waitForAppRouterHydration(page);

    await page.click("#hash-link");
    await expect(page).toHaveURL(`${BASE}/nextjs-compat/hash-popstate-scroll#content`);
    expect(await readVinextHistoryIndex(page)).toBe(1);

    await page.goBack();
    await expect(page).toHaveURL(`${BASE}/nextjs-compat/hash-popstate-scroll`);
    expect(await readVinextHistoryIndex(page)).toBe(0);

    await page.click("#replace-top");
    await expect(page).toHaveURL(`${BASE}/nextjs-compat/hash-popstate-scroll#top`);
    expect(await readVinextHistoryIndex(page)).toBe(0);
  });

  test("hash-only replace after back restores scroll for the replaced hash target", async ({
    page,
  }) => {
    await page.goto(`${BASE}/nextjs-compat/hash-popstate-scroll`);
    await waitForAppRouterHydration(page);

    await page.click("#hash-link");
    await expect(page).toHaveURL(`${BASE}/nextjs-compat/hash-popstate-scroll#content`);
    expect(await readVinextHistoryIndex(page)).toBe(1);

    await page.goBack();
    await expect(page).toHaveURL(`${BASE}/nextjs-compat/hash-popstate-scroll`);
    await expectScrollY(page, 0);
    expect(await readVinextHistoryIndex(page)).toBe(0);

    await page.click("#replace-content");
    await expect(page).toHaveURL(`${BASE}/nextjs-compat/hash-popstate-scroll#content`);
    await expect(page.locator("#content")).toBeInViewport();
    expect(await readVinextHistoryIndex(page)).toBe(0);

    await page.goForward();
    await expect(page).toHaveURL(`${BASE}/nextjs-compat/hash-popstate-scroll#content`);
    await expect(page.locator("#content")).toBeInViewport();
    expect(await readVinextHistoryIndex(page)).toBe(1);

    await page.goBack();
    await expect(page).toHaveURL(`${BASE}/nextjs-compat/hash-popstate-scroll#content`);
    await expect(page.locator("#content")).toBeInViewport();
    expect(await readVinextHistoryIndex(page)).toBe(0);
  });

  // Next.js App Router handles popstate with ACTION_RESTORE and classifies
  // same-path/search fragment changes as onlyHashChange in segment-cache
  // navigation, avoiding a new RSC payload for hash-only traversal.
  // Source:
  // https://github.com/vercel/next.js/blob/canary/packages/next/src/client/components/app-router.tsx
  // https://github.com/vercel/next.js/blob/canary/packages/next/src/client/components/segment-cache/navigation.ts
  test("back/forward traversal between hash entries skips RSC navigation", async ({ page }) => {
    await page.goto(`${BASE}/nextjs-compat/hash-popstate-scroll`);
    await waitForAppRouterHydration(page);

    await page.click("#hash-link");
    await expect(page).toHaveURL(`${BASE}/nextjs-compat/hash-popstate-scroll#content`);

    await page.evaluate(() => {
      type TestNavigate = (
        href: string,
        redirectDepth?: number,
        navigationKind?: "navigate" | "refresh" | "prefetch",
        historyUpdateMode?: "push" | "replace",
        previousNextUrlOverride?: string | null,
        programmaticTransition?: boolean,
      ) => Promise<unknown>;
      const testWindow = window as Window & { __vinextHashPopstateRscCalls?: number };
      const runtime = Reflect.get(window, Symbol.for("vinext.navigationRuntime")) as
        | { functions?: { navigate?: TestNavigate } }
        | undefined;
      const originalNavigate = runtime?.functions?.navigate ?? null;
      if (typeof originalNavigate !== "function") {
        throw new Error("App Router navigation runtime is not installed");
      }
      if (!runtime?.functions) {
        throw new Error("App Router navigation runtime functions are not installed");
      }
      runtime.functions.navigate = async (...args: Parameters<TestNavigate>) => {
        testWindow.__vinextHashPopstateRscCalls =
          (testWindow.__vinextHashPopstateRscCalls ?? 0) + 1;
        return originalNavigate(...args);
      };
      testWindow.__vinextHashPopstateRscCalls = 0;
    });

    await page.goBack();
    await expect(page).toHaveURL(`${BASE}/nextjs-compat/hash-popstate-scroll`);
    await expectScrollY(page, 0);

    await page.goForward();
    await expect(page).toHaveURL(`${BASE}/nextjs-compat/hash-popstate-scroll#content`);
    await expect(page.locator("#content")).toBeInViewport();

    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as Window & { __vinextHashPopstateRscCalls?: number })
              .__vinextHashPopstateRscCalls ?? 0,
        ),
      )
      .toBe(0);
  });

  // Ported from Next.js: test/e2e/app-dir/navigation/navigation.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/navigation/navigation.test.ts
  test("back navigation restores the saved scroll position before the next assertion frame", async ({
    page,
  }) => {
    await page.goto(`${BASE}/nextjs-compat/hash-popstate-scroll`);
    await waitForAppRouterHydration(page);
    await page.evaluate(() => window.scrollTo(0, 1200));
    await expectScrollY(page, 1200);

    await page.click("#plain-link");
    await expect(page).toHaveURL(`${BASE}/nextjs-compat/hash-popstate-scroll/plain`);

    await page.goBack();
    await expect(page).toHaveURL(`${BASE}/nextjs-compat/hash-popstate-scroll`);
    await expectScrollY(page, 1200);
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
