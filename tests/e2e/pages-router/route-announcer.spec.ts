import { test, expect, type Page } from "@playwright/test";

const BASE = "http://localhost:4173";

// Ported from Next.js's test/development/client-navigation-a11y suite, for the
// Pages Router announcer (packages/next/src/client/route-announcer.tsx): a
// <p id="__next-route-announcer__" aria-live="assertive" role="alert"> in a
// <next-route-announcer> element appended to <body>. After a client
// navigation it holds document.title, else the first h1, else the asPath, and
// it stays empty on first load.
async function openIndex(page: Page, errors: string[]) {
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${BASE}/route-announcer`);
  await page.waitForFunction(() => (window as any).__NEXT_HYDRATED === true);
  await page.evaluate(() => {
    (window as any).__ANNOUNCER_NAV_MARKER__ = true;
  });
}

async function navigateTo(page: Page, id: string) {
  await page.click(`#${id}-link`);
  await page.waitForSelector(`#${id}`);
  // A client navigation keeps the window, so the marker survives.
  expect(await page.evaluate(() => (window as any).__ANNOUNCER_NAV_MARKER__)).toBe(true);
}

function announcer(page: Page) {
  return page.locator("next-route-announcer > #__next-route-announcer__");
}

test.describe("Pages Router route announcer", () => {
  test("does not announce the initial route", async ({ page }) => {
    const errors: string[] = [];
    await openIndex(page, errors);
    await expect(announcer(page)).toHaveAttribute("aria-live", "assertive");
    await expect(announcer(page)).toHaveAttribute("role", "alert");
    await expect(announcer(page)).toHaveText("");
    expect(await page.locator("next-route-announcer").count()).toBe(1);
    expect(errors).toEqual([]);
  });

  test("announces document.title when there is a title but no h1", async ({ page }) => {
    const errors: string[] = [];
    await openIndex(page, errors);
    await navigateTo(page, "page-with-title");
    await expect(page).toHaveTitle("Route Announcer Page With Title");
    await expect(announcer(page)).toHaveText("Route Announcer Page With Title");
    expect(errors).toEqual([]);
  });

  test("announces the h1 when there is no title", async ({ page }) => {
    const errors: string[] = [];
    await openIndex(page, errors);
    await navigateTo(page, "page-with-h1");
    await expect(announcer(page)).toHaveText("Route Announcer Page With H1");
    expect(errors).toEqual([]);
  });

  test("announces document.title when there is a title and an h1", async ({ page }) => {
    const errors: string[] = [];
    await openIndex(page, errors);
    await navigateTo(page, "page-with-h1-and-title");
    await expect(page).toHaveTitle("Route Announcer Page With H1 And Title");
    await expect(announcer(page)).toHaveText("Route Announcer Page With H1 And Title");
    expect(errors).toEqual([]);
  });

  test("announces the pathname when there is no title and no h1", async ({ page }) => {
    const errors: string[] = [];
    await openIndex(page, errors);
    await navigateTo(page, "page-without-h1-or-title");
    await expect(announcer(page)).toHaveText("/route-announcer/page-without-h1-or-title");

    // Navigating back announces the index's h1, through the same single host.
    await page.goBack();
    await page.waitForSelector("#route-announcer-index");
    await expect(announcer(page)).toHaveText("Route Announcer Index");
    expect(await page.locator("next-route-announcer").count()).toBe(1);
    expect(errors).toEqual([]);
  });
});
