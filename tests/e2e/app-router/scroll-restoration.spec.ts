import { expect, test } from "@playwright/test";
import { waitForAppRouterHydration } from "../helpers";

const BASE = "http://localhost:4174";

test.describe("App Router scroll restoration", () => {
  // Ported from Next.js:
  // test/e2e/app-dir/navigation/navigation.test.ts
  // https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-dir/navigation/navigation.test.ts#L706-L735
  test("restores the original scroll position when navigating back", async ({ page }) => {
    await page.goto(`${BASE}/scroll-restoration`);
    await waitForAppRouterHydration(page);

    const body = page.locator("body");
    await expect(body).toContainText("Item 50");
    await page.locator("#load-more").click();
    await page.locator("#load-more").click();
    await page.locator("#load-more").click();
    await expect(body).toContainText("Item 200");

    await page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight);
    });

    const scrollPosition = await page.evaluate(() => window.pageYOffset);
    expect(scrollPosition).toBeGreaterThan(0);

    await page.locator('a[href="/scroll-restoration/other"]').click();
    await expect(page).toHaveURL(`${BASE}/scroll-restoration/other`);
    await expect(page.locator("#back-button")).toBeVisible();
    await page.locator("#back-button").click();
    await expect(page).toHaveURL(`${BASE}/scroll-restoration`);
    await expect(body).toContainText("Item 200");

    await expect.poll(() => page.evaluate(() => window.pageYOffset)).toEqual(scrollPosition);
  });
});
