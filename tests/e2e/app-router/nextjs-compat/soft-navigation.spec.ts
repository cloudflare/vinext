import { expect, test } from "@playwright/test";
import { waitForAppRouterHydration } from "../../helpers";

const BASE = "http://localhost:4174";

// Ported from Next.js: test/e2e/app-dir/app/index.test.ts
// https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-dir/app/index.test.ts
test.describe("soft Link navigation", () => {
  test("a new push after back does not replay the departed page response", async ({ page }) => {
    await page.goto(`${BASE}/nextjs-compat/link-soft-push`);
    await waitForAppRouterHydration(page);
    await page.evaluate(() => {
      (window as Window & { __vinextSoftPushTest?: number }).__vinextSoftPushTest = 1;
    });

    await page.getByTestId("soft-push-link").click();
    const firstId = await page.getByTestId("soft-push-render-id").textContent();
    expect(firstId).toBeTruthy();

    await page.goBack();
    await page.getByTestId("soft-push-link").click();
    await expect(page.getByTestId("soft-push-render-id")).not.toHaveText(firstId!);
    expect(
      await page.evaluate(
        () => (window as Window & { __vinextSoftPushTest?: number }).__vinextSoftPushTest,
      ),
    ).toBe(1);
  });

  test("an identical replace fetches fresh page output without adding history", async ({
    page,
  }) => {
    await page.goto(`${BASE}/nextjs-compat/link-soft-replace`);
    await waitForAppRouterHydration(page);

    const firstId = await page.getByTestId("soft-replace-render-id").textContent();
    const historyLength = await page.evaluate(() => window.history.length);
    expect(firstId).toBeTruthy();

    await page.getByTestId("soft-replace-link").click();
    await expect(page.getByTestId("soft-replace-render-id")).not.toHaveText(firstId!);
    expect(await page.evaluate(() => window.history.length)).toBe(historyLength);
  });

  test("an identical non-empty hash bypasses a reusable route response", async ({ page }) => {
    const pathname = "/nextjs-compat/link-soft-hash-cacheable";
    await page.goto(`${BASE}${pathname}#section`);
    await waitForAppRouterHydration(page);

    const rscRequests: string[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (
        url.pathname === pathname &&
        url.searchParams.has("_rsc") &&
        request.headers()["rsc"] === "1"
      ) {
        rscRequests.push(url.href);
      }
    });

    await page.getByTestId("soft-hash-cacheable-link").click();

    await expect.poll(() => rscRequests.length).toBe(1);
    expect(page.url()).toBe(`${BASE}${pathname}#section`);
  });
});
