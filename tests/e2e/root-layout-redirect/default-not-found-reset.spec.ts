/**
 * An app with no not-found file gets the built-in not-found boundary at the
 * root layout. When a page calls notFound() during client navigation, that
 * boundary shows the built-in 404. Next.js clears it on any pathname change,
 * so navigating on to a sibling page renders that page.
 * https://github.com/vercel/next.js/blob/canary/packages/next/src/client/components/http-access-fallback/error-boundary.tsx
 *
 * This fixture has no not-found file anywhere, unlike app-basic.
 */

import { expect, test, type Page } from "@playwright/test";
import { waitForAppRouterHydration } from "../helpers";

const ROOT = "/default-not-found-reset";

async function push(page: Page, href: string): Promise<void> {
  await page.evaluate((target) => {
    const router = window.next?.router;
    if (!router) throw new Error("window.next.router is not installed");
    void router.push(target);
  }, href);
}

test("the built-in not-found clears when the next page is a sibling below the same segment", async ({
  page,
}) => {
  await page.goto(`${ROOT}/first`);
  await waitForAppRouterHydration(page);
  await expect(page.locator("#default-not-found-reset-page")).toHaveText("Page: first");
  await page.evaluate(() => {
    (window as { __defaultNotFoundResetDocument?: boolean }).__defaultNotFoundResetDocument = true;
  });

  await push(page, `${ROOT}/missing`);
  await expect(page.locator("h2")).toHaveText("This page could not be found.");
  await expect(page.locator("#default-not-found-reset-layout")).toHaveCount(0);

  await push(page, `${ROOT}/present`);
  await expect(page.locator("#default-not-found-reset-page")).toHaveText("Page: present");
  await expect(page.locator("h2")).toHaveCount(0);

  expect(
    await page.evaluate(
      () =>
        (window as { __defaultNotFoundResetDocument?: boolean }).__defaultNotFoundResetDocument ===
        true,
    ),
  ).toBe(true);
});

test("the built-in not-found stays on a search-only change that rewrites to another page", async ({
  page,
}) => {
  // next.config.ts rewrites /default-not-found-reset/alias?slug=X to
  // /default-not-found-reset/X. Next.js resets the boundary on the visible
  // pathname only, so it stays caught while the pathname stays /alias.
  await page.goto(`${ROOT}/first`);
  await waitForAppRouterHydration(page);

  await push(page, `${ROOT}/alias?slug=missing`);
  await expect(page.locator("h2")).toHaveText("This page could not be found.");

  await push(page, `${ROOT}/alias?slug=present`);
  await expect(page).toHaveURL(/\/alias\?slug=present$/);
  // The 404 was already on screen, so wait for the navigation to render
  // before checking that it stayed.
  await expect(page.locator("#default-not-found-reset-search")).toHaveText("present");
  await expect(page.locator("h2")).toHaveText("This page could not be found.");
  await expect(page.locator("#default-not-found-reset-page")).toHaveCount(0);

  await push(page, `${ROOT}/present`);
  await expect(page.locator("#default-not-found-reset-page")).toHaveText("Page: present");
});
