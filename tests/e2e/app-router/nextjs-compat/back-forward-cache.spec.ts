import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { waitForAppRouterHydration } from "../../helpers";

const BASE = "http://localhost:4174";
const ROUTE = "/nextjs-compat/back-forward-cache/page";

function counter(page: Page, n: number) {
  return page.locator(`#counter-display-${n}:visible`).first();
}

function incrementButton(page: Page, n: number) {
  return page.locator(`#increment-button-${n}:visible`).first();
}

async function expectPage(page: Page, n: number) {
  await expect(page.locator("h2:visible").first()).toHaveText(`Page ${n}`);
}

async function clickPageLink(page: Page, n: number) {
  await page.locator(`a[href="${ROUTE}/${n}"]:visible`).first().click();
  await expectPage(page, n);
}

async function clickUntilCount(page: Page, n: number, target: number) {
  const button = incrementButton(page, n);
  await expect(button).toBeVisible();

  for (let count = 1; count <= target; count++) {
    await button.click();
    await expect(counter(page, n)).toHaveText(`Count: ${count}`);
  }
}

test.describe("Next.js compat: back/forward cache", () => {
  // Ported from Next.js: test/e2e/app-dir/back-forward-cache/back-forward-cache.test.ts
  // https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-dir/back-forward-cache/back-forward-cache.test.ts
  test("preserves React state when navigating with browser back and forward", async ({ page }) => {
    await page.goto(`${BASE}${ROUTE}/1`);
    await waitForAppRouterHydration(page);
    await expectPage(page, 1);

    await clickUntilCount(page, 1, 2);

    await clickPageLink(page, 2);
    await clickUntilCount(page, 2, 9);

    await page.goBack();
    await expectPage(page, 1);
    await expect(counter(page, 1)).toHaveText("Count: 2");

    await page.goForward();
    await expectPage(page, 2);
    await expect(counter(page, 2)).toHaveText("Count: 9");
  });

  test("preserves React state when returning to a recent segment with links", async ({ page }) => {
    await page.goto(`${BASE}${ROUTE}/1`);
    await waitForAppRouterHydration(page);
    await expectPage(page, 1);

    await clickUntilCount(page, 1, 2);

    await clickPageLink(page, 2);
    await clickUntilCount(page, 2, 9);

    await clickPageLink(page, 1);
    await expect(counter(page, 1)).toHaveText("Count: 2");

    await clickPageLink(page, 2);
    await expect(counter(page, 2)).toHaveText("Count: 9");
  });

  test("preserves only the three most recent segment entries", async ({ page }) => {
    await page.goto(`${BASE}${ROUTE}/1`);
    await waitForAppRouterHydration(page);
    await expectPage(page, 1);

    await clickUntilCount(page, 1, 2);

    await clickPageLink(page, 2);
    await clickUntilCount(page, 2, 9);

    await clickPageLink(page, 3);
    await clickPageLink(page, 4);

    await clickPageLink(page, 2);
    await expect(counter(page, 2)).toHaveText("Count: 9");

    await clickPageLink(page, 1);
    await expect(counter(page, 1)).toHaveText("Count: 0");
  });

  test("reuses cached entries without evicting when repeatedly moving between them", async ({
    page,
  }) => {
    await page.goto(`${BASE}${ROUTE}/1`);
    await waitForAppRouterHydration(page);
    await expectPage(page, 1);

    await clickUntilCount(page, 1, 2);

    await clickPageLink(page, 2);
    await clickUntilCount(page, 2, 9);

    await clickPageLink(page, 1);
    await clickPageLink(page, 2);
    await clickPageLink(page, 1);
    await clickPageLink(page, 2);
    await clickPageLink(page, 1);
    await clickPageLink(page, 2);

    await expect(counter(page, 2)).toHaveText("Count: 9");

    await clickPageLink(page, 1);
    await expect(counter(page, 1)).toHaveText("Count: 2");
  });
});
