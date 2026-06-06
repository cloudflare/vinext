// Ported from Next.js: test/e2e/app-dir/interception-dynamic-single-segment/interception-dynamic-single-segment.test.ts
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/interception-dynamic-single-segment/interception-dynamic-single-segment.test.ts

import { test, expect } from "@playwright/test";
import { waitForAppRouterHydration } from "../helpers";

const BASE = "http://localhost:4174";
const GROUPS_123 = `${BASE}/interception-dyn-single/groups/123`;

test.describe("interception-dynamic-single-segment", () => {
  test("intercepts /groups/[id]/new with (.) from /groups/[id]", async ({ page }) => {
    // TODO(#1364 Part C): source page is replaced instead of preserved in #children slot.
    // The modal fires but #children shows the new-item page instead of the group page.
    test.fail();
    // The (.) modifier matches same-level routes. The bug was that
    // [^/]+ only matched single segments, failing when the source had
    // multiple path segments like /groups/123. Fixed by using .+ (any depth).
    await page.goto(GROUPS_123);
    await waitForAppRouterHydration(page);

    await expect(page.locator("#children")).toContainText("Group 123");

    await page.click("#new-link");

    // Modal slot shows the intercepted new-item form
    await expect(page.locator("#modal")).toContainText("Modal: New item for group 123");
    // Children slot still shows the group page
    await expect(page.locator("#children")).toContainText("Group 123");
  });

  test("refresh after interception shows full new-item page", async ({ page }) => {
    await page.goto(GROUPS_123);
    await waitForAppRouterHydration(page);

    await page.click("#new-link");
    await expect(page.locator("#modal")).toContainText("Modal: New item for group 123");

    // Hard refresh — should render the full (non-intercepted) page
    await page.reload();

    await expect(page.locator("#children")).toContainText("New item for group 123");
  });

  test("back/forward navigation preserves intercepted state", async ({ page }) => {
    await page.goto(GROUPS_123);
    await waitForAppRouterHydration(page);

    await page.click("#new-link");
    await expect(page.locator("#modal")).toContainText("Modal: New item for group 123");

    await page.goBack();
    await expect(page.locator("#children")).toContainText("Group 123");

    await page.goForward();
    await expect(page.locator("#modal")).toContainText("Modal: New item for group 123");
  });

  test("repeated interception from same route works consistently", async ({ page }) => {
    for (let i = 0; i < 3; i++) {
      await page.goto(GROUPS_123);
      await waitForAppRouterHydration(page);

      await page.click("#new-link");
      await expect(page.locator("#modal")).toContainText("Modal: New item for group 123");
    }
  });

  test("interception works for different dynamic id values", async ({ page }) => {
    await page.goto(`${BASE}/interception-dyn-single/groups/456`);
    await waitForAppRouterHydration(page);

    await page.click("#new-link");
    await expect(page.locator("#modal")).toContainText("Modal: New item for group 456");
  });
});
