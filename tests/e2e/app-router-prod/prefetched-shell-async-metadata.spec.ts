import { expect, test } from "@playwright/test";
import { waitForAppRouterHydration } from "../helpers";

const ROUTE = "/nextjs-compat/nav-async-metadata";
const TARGET = `${ROUTE}/nested`;
// The target's generateMetadata() resolves after 4 seconds.
const BEFORE_METADATA_MS = 2500;

// Link prefetching only runs in production. A loading-shell prefetch carries
// the target's streamed metadata, so the click commits it with the loading
// fallback. The page must then render as it streams, without waiting for the
// navigation's own metadata, while the prefetched title stays in place.
test("renders the page before its metadata after a completed loading-shell prefetch", async ({
  page,
}) => {
  const prefetchResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === TARGET && url.searchParams.has("_rsc");
  });
  await page.goto(ROUTE);
  await waitForAppRouterHydration(page);
  await (await prefetchResponse).finished();

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
