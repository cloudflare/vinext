import { test, expect, type Page } from "@playwright/test";
import { waitForAppRouterHydration } from "../helpers";

const BASE = "http://localhost:4174";
const MOUNTED_LAYOUTS_HEADER = "x-vinext-mounted-layouts";

// Next.js renders only the segments below where a navigation diverges from the
// client's router state, so a shared layout doesn't run again on a sibling
// navigation (https://nextjs.org/docs/app/getting-started/linking-and-navigating#client-side-transitions).
// vinext does so for a render that's never stored, as this force-dynamic one.

async function readLayoutRender(page: Page): Promise<string> {
  const text = await page.getByTestId("partial-layout-render").textContent();
  if (!text) throw new Error("Missing layout render id");
  return text;
}

function waitForNavigationRequest(page: Page, pathname: string) {
  return page.waitForRequest(
    (request) =>
      new URL(request.url()).pathname.startsWith(pathname) &&
      request.headers()["rsc"] === "1" &&
      request.headers()["next-router-prefetch"] === undefined,
  );
}

test.describe("partial layout render", () => {
  test("keeps a dynamic shared layout on a sibling navigation", async ({ page }) => {
    await page.goto(`${BASE}/partial-layout/a`);
    await waitForAppRouterHydration(page);
    const layoutRender = await readLayoutRender(page);

    const request = waitForNavigationRequest(page, "/partial-layout/b");
    await page.getByRole("link", { name: "Page B" }).click();
    expect((await request).headers()[MOUNTED_LAYOUTS_HEADER]).toBeTruthy();

    await expect(page.getByTestId("partial-layout-page")).toHaveText("Page B");
    expect(await readLayoutRender(page)).toBe(layoutRender);

    await page.getByRole("link", { name: "Page A" }).click();
    await expect(page.getByTestId("partial-layout-page")).toHaveText("Page A");
    expect(await readLayoutRender(page)).toBe(layoutRender);
  });

  test("renders again from the layout whose params changed", async ({ page }) => {
    await page.goto(`${BASE}/partial-layout/items/1`);
    await waitForAppRouterHydration(page);
    const layoutRender = await readLayoutRender(page);
    const itemLayout = page.getByTestId("partial-item-layout");
    await expect(itemLayout).toContainText("Item layout 1:");
    const firstItemLayout = await itemLayout.textContent();

    await page.getByRole("link", { name: "Item 2" }).click();

    await expect(page.getByTestId("partial-layout-page")).toHaveText("Item 2");
    await expect(itemLayout).toContainText("Item layout 2:");
    expect(await itemLayout.textContent()).not.toBe(firstItemLayout);
    expect(await readLayoutRender(page)).toBe(layoutRender);
  });

  test("renders every layout again on router.refresh()", async ({ page }) => {
    await page.goto(`${BASE}/partial-layout/a`);
    await waitForAppRouterHydration(page);
    await page.getByRole("link", { name: "Page B" }).click();
    await expect(page.getByTestId("partial-layout-page")).toHaveText("Page B");
    const layoutRender = await readLayoutRender(page);

    const request = waitForNavigationRequest(page, "/partial-layout/b");
    await page.getByTestId("partial-layout-refresh").click();
    expect((await request).headers()[MOUNTED_LAYOUTS_HEADER]).toBeUndefined();

    await expect(page.getByTestId("partial-layout-render")).not.toHaveText(layoutRender);
    await expect(page.getByTestId("partial-layout-page")).toHaveText("Page B");
  });

  test("restores a partially rendered page from history", async ({ page }) => {
    await page.goto(`${BASE}/partial-layout/a`);
    await waitForAppRouterHydration(page);
    await page.getByRole("link", { name: "Page B" }).click();
    await expect(page.getByTestId("partial-layout-page")).toHaveText("Page B");
    await page.getByRole("link", { name: "Item 1" }).click();
    await expect(page.getByTestId("partial-layout-page")).toHaveText("Item 1");

    await page.goBack();
    await expect(page.getByTestId("partial-layout-page")).toHaveText("Page B");
    await page.goBack();
    await expect(page.getByTestId("partial-layout-page")).toHaveText("Page A");
    await page.goForward();
    await expect(page.getByTestId("partial-layout-page")).toHaveText("Page B");
    // The page a partial payload rendered keeps the layout it merged into.
    await expect(page.getByTestId("partial-layout-render")).toBeVisible();
    await expect(page.getByTestId("partial-item-layout")).toHaveCount(0);
  });
});
