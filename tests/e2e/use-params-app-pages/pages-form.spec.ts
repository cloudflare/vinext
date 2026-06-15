// Ported from Next.js: test/e2e/next-form/default/pages-dir.test.ts
// https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/next-form/default/pages-dir.test.ts
import { expect, test } from "@playwright/test";

async function installPageLoadCounter(page: import("@playwright/test").Page) {
  await page.addInitScript(() => {
    const count = Number(window.sessionStorage.getItem("form-page-loads") ?? "0") + 1;
    window.sessionStorage.setItem("form-page-loads", String(count));
  });
}

test.describe("next/form on a hybrid Pages route", () => {
  test("soft-navigates a cross-route GSSP submission", async ({ page, baseURL }) => {
    await installPageLoadCounter(page);
    await page.goto(`${baseURL}/form-source`);
    await page.locator("#basic-form button").click();

    await expect(page.locator("#search-query")).toHaveText("basic");
    await expect(page).toHaveURL(/\/form-search\?query=basic$/);
    expect(await page.evaluate(() => sessionStorage.getItem("form-page-loads"))).toBe("1");
  });

  test("honors submitter formAction and name/value", async ({ page, baseURL }) => {
    await installPageLoadCounter(page);
    await page.goto(`${baseURL}/form-source`);
    await page.locator("#submitter-form button").click();

    await expect(page.locator("#search-query")).toHaveText("submitter");
    await expect(page.locator("#search-source")).toHaveText("button");
    await expect(page).toHaveURL(/\/form-search\?query=submitter&source=button$/);
    expect(await page.evaluate(() => sessionStorage.getItem("form-page-loads"))).toBe("1");
  });

  test("replace preserves history length", async ({ page, baseURL }) => {
    await installPageLoadCounter(page);
    await page.goto(`${baseURL}/form-source`);
    const historyLength = await page.evaluate(() => history.length);
    await page.locator("#replace-form button").click();

    await expect(page.locator("#search-query")).toHaveText("replace");
    expect(await page.evaluate(() => history.length)).toBe(historyLength);
    expect(await page.evaluate(() => sessionStorage.getItem("form-page-loads"))).toBe("1");
  });

  test("scroll=false preserves scroll position", async ({ page, baseURL }) => {
    await page.goto(`${baseURL}/form-source`);
    await page.evaluate(() => window.scrollTo(0, 900));
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
    await page.locator("#no-scroll-form button").click();

    await expect(page.locator("#search-query")).toHaveText("no-scroll");
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  });

  test("unsupported submitter attributes retain native semantics", async ({ page, baseURL }) => {
    await page.goto(`${baseURL}/form-source`);
    const url = page.url();
    await page.locator("#native-form button").click();

    expect(page.url()).toBe(url);
    expect(
      await page.evaluate(() => sessionStorage.getItem("native-submit-default-prevented")),
    ).toBe("false");
  });
});
