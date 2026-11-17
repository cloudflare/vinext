import { expect, test } from "@playwright/test";
import { waitForAppRouterHydration } from "../../helpers";

const BASE = "http://localhost:4174";

test.describe("useLinkStatus navigation ownership", () => {
  test("server action redirect clears a pending link navigation", async ({ page }) => {
    // Ported from Next.js: test/e2e/use-link-status/index.test.ts
    // https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/use-link-status/index.test.ts
    await page.goto(`${BASE}/nextjs-compat/use-link-status/post/1`);
    await waitForAppRouterHydration(page);
    await expect(page.locator("#post-1-page")).toBeVisible();

    // The post page takes 1.5s to render, so the link's navigation is still
    // pending in React when the server action redirects to the home page. As
    // in Next.js, whose action queue holds an action until the navigation's
    // response arrives, the link's response itself is not held: the action
    // runs on the navigation's state while its page is still rendering.
    await page.locator("#post-2-link").click({ noWaitAfter: true });
    await expect(page.locator("#post-2-loading")).toHaveText("(Loading)");
    const actionRequest = page.waitForRequest((request) => request.method() === "POST");
    const actionResponse = page.waitForResponse(
      (response) => response.request().method() === "POST",
    );
    await page.locator("#server-action-home-btn").click();
    await actionRequest;
    // The action is sent while the link's navigation is still pending.
    expect(await page.locator("#post-2-page").count()).toBe(0);
    await expect(page.locator("#post-2-loading")).toHaveText("(Loading)");
    await actionResponse;
    await expect(page.locator("#post-2-loading")).toHaveCount(0, { timeout: 1_000 });
    await expect(page.locator("#use-link-status-home")).toBeVisible();
    await expect(page.locator("#post-2-page")).toHaveCount(0);
    // The link's navigation must not land after the redirect.
    await page.waitForTimeout(2_000);
    await expect(page.locator("#use-link-status-home")).toBeVisible();
    await expect(page.locator("#post-2-page")).toHaveCount(0);
    expect(new URL(page.url()).pathname).toBe("/nextjs-compat/use-link-status");
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

  test("shallow routing discards a pending link navigation", async ({ page }) => {
    // Ported from Next.js: test/e2e/use-link-status/index.test.ts
    // https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/use-link-status/index.test.ts
    await page.goto(`${BASE}/nextjs-compat/use-link-status`);
    await waitForAppRouterHydration(page);

    // The post page streams its response right away but takes 1.5s to render,
    // so the navigation is still pending in React when pushState runs.
    await page.locator("#post-1-link").click({ noWaitAfter: true });
    await expect(page.locator("#post-1-loading")).toHaveText("(Loading)");

    await page.locator("#enable-debug-btn").click();
    await expect(page.locator('[data-testid="debug-mode"]')).toHaveText("Debug Mode Enabled");
    await expect(page.locator("#post-1-loading")).toHaveCount(0);

    // Next.js discards the pending navigation, so the post page never commits
    // and the URL keeps the shallow update.
    await page.waitForTimeout(2_500);
    await expect(page.locator("#post-1-page")).toHaveCount(0);
    expect(new URL(page.url()).pathname).toBe("/nextjs-compat/use-link-status");
    expect(new URL(page.url()).search).toBe("?debug=1");
  });
});
