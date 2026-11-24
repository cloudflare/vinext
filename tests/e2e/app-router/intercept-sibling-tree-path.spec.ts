import { expect, test } from "@playwright/test";
import { waitForAppRouterHydration } from "../helpers";

const BASE = "http://localhost:4174/nextjs-compat/intercept-sibling-tree-path";

type MarkedWindow = Window & { __interceptSiblingTreePathMarker?: boolean };

// Next.js 16.2.7 sends a sibling intercept's tree path, /shop here, as the
// Next-Url of navigations from it, and intercepts again whether or not that
// path is a page of its own.
test("opens the next item intercepted from a sibling intercept whose owner has no page", async ({
  page,
}) => {
  await page.goto(`${BASE}/shop/list`);
  await waitForAppRouterHydration(page);
  await page.evaluate(() => {
    (window as MarkedWindow).__interceptSiblingTreePathMarker = true;
  });

  await page.click("#intercept-sibling-tree-path-item-1-link");
  await expect(page).toHaveURL(`${BASE}/shop/item/1`);
  await expect(page.locator("#intercept-sibling-tree-path-intercepted-item")).toContainText(
    "Intercepted item 1",
  );

  await page.click("#intercept-sibling-tree-path-next-item-link");
  await expect(page).toHaveURL(`${BASE}/shop/item/2`);
  await expect(page.locator("#intercept-sibling-tree-path-intercepted-item")).toContainText(
    "Intercepted item 2",
  );
  await expect(page.locator("#intercept-sibling-tree-path-item-page")).toHaveCount(0);
  expect(await page.evaluate(() => (window as MarkedWindow).__interceptSiblingTreePathMarker)).toBe(
    true,
  );
});
