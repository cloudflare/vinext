import { expect, test } from "@playwright/test";
import { waitForAppRouterHydration } from "../../helpers";

const BASE = "http://localhost:4174";

test.describe("useLinkStatus navigation ownership", () => {
  test("queued server action redirect settles a pending link navigation", async ({ page }) => {
    // Ported from Next.js: test/e2e/use-link-status/index.test.ts
    // https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/use-link-status/index.test.ts
    await page.goto(`${BASE}/nextjs-compat/use-link-status/post/1`);
    await waitForAppRouterHydration(page);
    await expect(page.locator("#post-1-page")).toBeVisible();

    // Next queues Server Actions behind the navigation's accepted router state.
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/actions-discarded-navigation-revert/actions-discarded-navigation-revert.test.ts
    // Hold the root response to verify the action waits while the Link is pending.
    let releaseNavigation!: () => void;
    const navigationGate = new Promise<void>((resolve) => {
      releaseNavigation = resolve;
    });
    await page.route("**/use-link-status/post/2*", async (route) => {
      await navigationGate;
      await route.continue().catch(() => {});
    });

    try {
      await page.locator("#post-2-link").click({ noWaitAfter: true });
      await expect(page.locator("#post-2-loading")).toHaveText("(Loading)");
      const actionRequests: string[] = [];
      page.on("request", (request) => {
        if (request.method() === "POST") actionRequests.push(request.url());
      });
      const actionResponse = page.waitForResponse(
        (response) => response.request().method() === "POST",
      );
      await page.locator("#server-action-home-btn").click();
      await page.waitForTimeout(200);
      expect(actionRequests).toEqual([]);
      await expect(page.locator("#post-2-loading")).toHaveText("(Loading)");
      releaseNavigation();
      await actionResponse;
      await expect(page.locator("#post-2-loading")).toHaveCount(0, { timeout: 1_000 });
      await expect(page.locator("#use-link-status-home")).toBeVisible();
    } finally {
      releaseNavigation();
    }
  });

  test("imperative navigation clears link-owned pending state", async ({ page }) => {
    // Ported from Next.js: test/e2e/use-link-status/index.test.ts
    // https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/use-link-status/index.test.ts
    await page.goto(`${BASE}/nextjs-compat/use-link-status`);
    await waitForAppRouterHydration(page);

    await page.locator("#post-1-link").click({ noWaitAfter: true });
    await expect(page.locator("#post-1-loading")).toHaveText("(Loading)");

    await page.locator("#router-push-2-btn").click({ noWaitAfter: true });
    await expect(page.locator("#post-1-loading")).toHaveCount(0);
    await expect(page.locator("#post-2-page")).toBeVisible({ timeout: 10_000 });
  });

  test("only the last rapidly clicked link stays pending and settles", async ({ page }) => {
    // Ported from Next.js: test/e2e/use-link-status/index.test.ts
    // https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/use-link-status/index.test.ts
    await page.goto(`${BASE}/nextjs-compat/use-link-status`);
    await waitForAppRouterHydration(page);

    await page.locator("#post-1-link").click({ noWaitAfter: true });
    await expect(page.locator("#post-1-loading")).toHaveText("(Loading)");
    await page.locator("#post-2-link").click({ noWaitAfter: true });

    await expect(page.locator("#post-1-loading")).toHaveCount(0);
    await expect(page.locator("#post-2-loading")).toHaveText("(Loading)");
    await expect(page.locator("#post-2-page")).toBeVisible({ timeout: 10_000 });
  });
});
