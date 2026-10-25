import { expect, test, type Page } from "@playwright/test";
import { waitForAppRouterHydration } from "../helpers";

const ROUTE = "/nextjs-compat/nav-async-metadata";
const TARGET = `${ROUTE}/nested`;
const SECOND_TARGET = `${TARGET}?v=2`;
// The target's generateMetadata() resolves after 4 seconds.
const BEFORE_METADATA_MS = 2500;

function waitForPrefetch(page: Page, search: string) {
  return page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname === TARGET &&
      url.searchParams.has("_rsc") &&
      (url.searchParams.get("v") ?? "") === search &&
      response.request().headers()["next-router-prefetch"] === "1"
    );
  });
}

// Link prefetching only runs in production. A loading-shell prefetch carries
// the target's streamed metadata, so the click commits it with the loading
// fallback. The page must then render as it streams, without waiting for the
// navigation's own metadata, while the prefetched title stays in place.
test("renders the page before its metadata after a completed loading-shell prefetch", async ({
  page,
}) => {
  const prefetch = waitForPrefetch(page, "");
  await page.goto(ROUTE);
  await waitForAppRouterHydration(page);
  await (await prefetch).finished();

  await page.click(`a[href="${TARGET}"]`);
  await expect(page.locator("#page-content")).toHaveText("Content", {
    timeout: BEFORE_METADATA_MS,
  });
  expect(await page.locator("title", { hasText: "Async Title" }).count()).toBe(1);
  await expect(page.locator("#loading")).toHaveCount(0);

  // The navigation's metadata replaces the prefetched copy, not adds to it.
  await page.waitForTimeout(4000);
  await expect(page.locator("title", { hasText: "Async Title" })).toHaveCount(1);
});

test("renders the page before its metadata on a second navigation to the route", async ({
  page,
}) => {
  const prefetch = waitForPrefetch(page, "");
  await page.goto(ROUTE);
  await waitForAppRouterHydration(page);
  await (await prefetch).finished();

  const secondPrefetch = waitForPrefetch(page, "2");
  await page.click(`a[href="${TARGET}"]`);
  await expect(page.locator("#version")).toHaveText("1", { timeout: BEFORE_METADATA_MS });
  await (await secondPrefetch).finished();
  // Let the first navigation's metadata reveal in its boundary.
  await expect(page.locator("title", { hasText: "Async Title" })).toHaveCount(1);
  await page.waitForTimeout(500);

  await page.click(`a[href="${SECOND_TARGET}"]`);
  await expect(page.locator("#version")).toHaveText("2", { timeout: BEFORE_METADATA_MS });
  expect(await page.locator("title", { hasText: "Async Title" }).count()).toBe(1);
});
