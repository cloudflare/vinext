/**
 * Next.js Compat E2E: actions-revalidate-remount + revalidatetag-rsc
 *
 * Sources:
 * - https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/actions-revalidate-remount/actions-revalidate-remount.test.ts
 * - https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/revalidatetag-rsc/revalidatetag-rsc.test.ts
 *
 * Tests that revalidatePath via server action refreshes page data,
 * and that router.refresh() re-renders the page with fresh data.
 */

import { test, expect, type Page } from "@playwright/test";
import { isAppRouterServerActionRequestForPath, waitForAppRouterHydration } from "../../helpers";

const BASE = "http://localhost:4174";

test.describe("Next.js compat: actions-revalidate (browser)", () => {
  function waitForActionDiscardingResponse(page: Page) {
    return page.waitForResponse((response) =>
      isAppRouterServerActionRequestForPath(response.request(), "/nextjs-compat/action-discarding"),
    );
  }

  async function expectActionRefreshPreservesLoading(page: Page, buttonSelector: string) {
    const loadingLogs: string[] = [];
    page.on("console", (message) => {
      if (message.text() === "Action refresh loading mounted") {
        loadingLogs.push(message.text());
      }
    });

    await page.goto(`${BASE}/nextjs-compat/action-refresh-no-rerender`);
    await waitForAppRouterHydration(page);
    loadingLogs.length = 0;

    const initialValue = await page.locator("#flag-value").textContent();

    await page.click(buttonSelector);

    await expect(async () => {
      const nextValue = await page.locator("#flag-value").textContent();
      expect(nextValue).toBeTruthy();
      expect(nextValue).not.toBe(initialValue);
    }).toPass({ timeout: 10_000 });

    expect(await page.locator("#action-refresh-loading").count()).toBe(0);
    expect(loadingLogs).toEqual([]);
  }

  test("server action followed by router.refresh does not mount route loading", async ({
    page,
  }) => {
    await expectActionRefreshPreservesLoading(page, "#action-refresh");
  });

  test("refresh() inside server action does not mount route loading", async ({ page }) => {
    await expectActionRefreshPreservesLoading(page, "#action-refresh-from-server");
  });

  // Ported from Next.js: test/e2e/app-dir/actions/app-action.test.ts
  // "action discarding" coverage. Vinext uses a local counter instead of a
  // remote fetch cache so the assertion is deterministic.
  test("discarded server action without revalidation does not refresh current route", async ({
    page,
  }) => {
    await page.goto(`${BASE}/nextjs-compat/action-discarding`);
    await waitForAppRouterHydration(page);

    const initialValue = await page.locator("#discarded-action-value").textContent();
    if (!initialValue) {
      throw new Error("Expected initial discarded action value");
    }

    const actionResponse = waitForActionDiscardingResponse(page);
    await page.click("#slow-action");
    await page.click("#navigate-discard-destination");
    await expect(page.locator("#discard-destination")).toBeVisible();
    await actionResponse;

    await expect(page.locator("#discarded-action-value")).toHaveText(initialValue);
  });

  // Ported from Next.js: test/e2e/app-dir/actions/app-action.test.ts
  // "should trigger a refresh for a server action that gets discarded due to
  // a navigation (with revalidation)".
  test("discarded server action with revalidation refreshes current route", async ({ page }) => {
    await page.goto(`${BASE}/nextjs-compat/action-discarding`);
    await waitForAppRouterHydration(page);

    const initialValue = await page.locator("#discarded-action-value").textContent();
    if (!initialValue) {
      throw new Error("Expected initial discarded action value");
    }

    const actionResponse = waitForActionDiscardingResponse(page);
    await page.click("#slow-action-refresh");
    await page.click("#navigate-discard-destination");
    await expect(page.locator("#discard-destination")).toBeVisible();
    await actionResponse;

    await expect(page.locator("#discarded-action-value")).not.toHaveText(initialValue, {
      timeout: 10_000,
    });
  });

  // Next.js: 'should not remount the page + loading component when revalidating'
  // Adapted: Verify that clicking revalidate button updates the timestamp
  test("revalidating server actions update page and layout output", async ({ page }) => {
    await page.goto(`${BASE}/nextjs-compat/action-revalidate`);
    await waitForAppRouterHydration(page);

    // Read initial timestamp
    const time1 = await page.locator("#time").textContent();
    const layoutVersion1 = await page.locator("#layout-version").textContent();
    expect(time1).toBeTruthy();
    expect(layoutVersion1).toBeTruthy();

    // Click revalidate button (triggers server action with revalidatePath)
    await page.click("#revalidate");

    // Wait for timestamp to change (page should re-render with fresh data)
    await expect(async () => {
      const time2 = await page.locator("#time").textContent();
      expect(time2).toBeTruthy();
      expect(time2).not.toBe(time1);
    }).toPass({ timeout: 10_000 });

    await expect(page.locator("#layout-version")).not.toHaveText(layoutVersion1!);

    const layoutVersion2 = await page.locator("#layout-version").textContent();
    expect(layoutVersion2).toBeTruthy();

    await page.click("#revalidate-tag");
    await expect(page.locator("#layout-version")).not.toHaveText(layoutVersion2!);
  });

  // Test router.refresh() re-renders with fresh data
  test("router.refresh() updates page data", async ({ page }) => {
    await page.goto(`${BASE}/nextjs-compat/refresh-test`);
    await waitForAppRouterHydration(page);

    // Read initial timestamp
    const time1 = await page.locator("#time").textContent();
    expect(time1).toBeTruthy();

    // Click refresh button (calls router.refresh())
    await page.click("#refresh");

    // Wait for timestamp to change
    await expect(async () => {
      const time2 = await page.locator("#time").textContent();
      expect(time2).toBeTruthy();
      expect(time2).not.toBe(time1);
    }).toPass({ timeout: 10_000 });
  });
});
