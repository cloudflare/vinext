import { expect, test } from "@playwright/test";
import { waitForAppRouterHydration } from "../../helpers";

const BASE = "http://localhost:4174";

test.describe("useLinkStatus navigation ownership", () => {
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
