import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { waitForAppRouterHydration } from "../helpers";

// Runs against the dedicated app-bfcache fixture (cacheComponents: true), where
// inactive segment entries stay mounted as hidden Activity DOM. Locators here are
// intentionally :visible-scoped because duplicate hidden DOM is expected.
const ROUTE = "/nextjs-compat/back-forward-cache/page";
const NESTED_ROUTE = "/nextjs-compat/back-forward-cache/nested";

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

function nestedCounter(page: Page, id: string) {
  return page.locator(`#counter-${id}:visible`).first();
}

function nestedIncrementButton(page: Page, id: string) {
  return page.locator(`#increment-${id}:visible`).first();
}

async function clickNestedLink(page: Page, section: string, id: string) {
  const href = `${NESTED_ROUTE}/${section}/item/${id}`;
  await page.locator(`a[href="${href}"]:visible`).first().click();
  await expect(page.locator("h3:visible").first()).toHaveText(`Item ${id} in section ${section}`);
}

async function clickNestedUntilCount(page: Page, id: string, target: number) {
  const button = nestedIncrementButton(page, id);
  await expect(button).toBeVisible();

  for (let count = 1; count <= target; count++) {
    await button.click();
    await expect(nestedCounter(page, id)).toHaveText(`Count: ${count}`);
  }
}

test.describe("Next.js compat: back/forward cache", () => {
  // Ported from Next.js: test/e2e/app-dir/back-forward-cache/back-forward-cache.test.ts
  // https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-dir/back-forward-cache/back-forward-cache.test.ts
  test("preserves React state when navigating with browser back and forward", async ({ page }) => {
    await page.goto(`${ROUTE}/1`);
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
    await page.goto(`${ROUTE}/1`);
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
    await page.goto(`${ROUTE}/1`);
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
    await page.goto(`${ROUTE}/1`);
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

  test("keeps Activity state separate from fresh bfcacheId identity", async ({ page }) => {
    await page.goto(`${ROUTE}/1`);
    await waitForAppRouterHydration(page);
    await expectPage(page, 1);

    const firstId = await page.locator(`[data-testid="leaf-bfcache-id"]:visible`).textContent();

    await clickUntilCount(page, 1, 2);

    await clickPageLink(page, 2);
    const secondId = await page.locator(`[data-testid="leaf-bfcache-id"]:visible`).textContent();
    expect(secondId).not.toBe(firstId);

    await clickPageLink(page, 1);

    // Activity state is restored.
    await expect(counter(page, 1)).toHaveText("Count: 2");

    // But a fresh link navigation still gets fresh history-entry identity.
    const returnedId = await page.locator(`[data-testid="leaf-bfcache-id"]:visible`).textContent();
    expect(returnedId).toMatch(/^_b_\d+_$/);
    expect(returnedId).not.toBe(firstId);
  });

  test("preserves nested layout and page state across segment navigations", async ({ page }) => {
    await page.goto(`${NESTED_ROUTE}/a/item/1`);
    await waitForAppRouterHydration(page);
    await expect(page.locator("h2:visible").first()).toHaveText("Section a");
    await expect(page.locator("h3:visible").first()).toHaveText("Item 1 in section a");

    // Section layout counter = 2, page counter = 5
    await clickNestedUntilCount(page, "section-a", 2);
    await clickNestedUntilCount(page, "page-a-1", 5);

    // Navigate to /b/item/2
    await clickNestedLink(page, "b", "2");
    await expect(page.locator("h2:visible").first()).toHaveText("Section b");
    await expect(page.locator("h3:visible").first()).toHaveText("Item 2 in section b");

    // Section layout counter = 7, page counter = 9
    await clickNestedUntilCount(page, "section-b", 7);
    await clickNestedUntilCount(page, "page-b-2", 9);

    // Navigate back to /a/item/1
    await clickNestedLink(page, "a", "1");
    await expect(page.locator("h2:visible").first()).toHaveText("Section a");
    await expect(page.locator("h3:visible").first()).toHaveText("Item 1 in section a");

    // Both layout and page counters must be preserved from the first visit
    await expect(nestedCounter(page, "section-a")).toHaveText("Count: 2");
    await expect(nestedCounter(page, "page-a-1")).toHaveText("Count: 5");

    // Navigate back to /b/item/2
    await clickNestedLink(page, "b", "2");
    await expect(page.locator("h2:visible").first()).toHaveText("Section b");
    await expect(page.locator("h3:visible").first()).toHaveText("Item 2 in section b");

    // Both layout and page counters must be preserved from the second visit
    await expect(nestedCounter(page, "section-b")).toHaveText("Count: 7");
    await expect(nestedCounter(page, "page-b-2")).toHaveText("Count: 9");
  });
});
