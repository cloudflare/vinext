import { expect, test, type Page } from "@playwright/test";
import { waitForAppRouterHydration } from "../helpers";

const BASE = "http://localhost:4174/parallel-slot-owner-params";

// Next.js 16.2.7 (webpack and Turbopack) keeps what a slot shows while its
// layout renders for the same params, and renders the slot's default afresh
// when a navigation changes them.
async function navigate(page: Page, link: string, pathname: string) {
  await page.getByRole("link", { name: link, exact: true }).click();
  await expect(page).toHaveURL(`${BASE}${pathname}`);
}

test.describe("a slot's default below a layout whose params change", () => {
  test("renders the default for the new params", async ({ page }) => {
    await page.goto(`${BASE}/1`);
    await waitForAppRouterHydration(page);
    const aside = page.getByTestId("owner-params-aside");
    await expect(aside).toHaveText("aside default 1");

    await navigate(page, "One info", "/1/info");
    await expect(page.getByTestId("owner-params-children")).toHaveText("info 1");
    await expect(aside).toHaveText("aside default 1");

    await navigate(page, "Two", "/2");
    await expect(page.getByTestId("owner-params-children")).toHaveText("page 2");
    await expect(aside).toHaveText("aside default 2");

    await navigate(page, "One", "/1");
    await expect(page.getByTestId("owner-params-children")).toHaveText("page 1");
    await expect(aside).toHaveText("aside default 1");
  });

  test("keeps a slot page for the same params and replaces it for others", async ({ page }) => {
    await page.goto(`${BASE}/1/stats`);
    await waitForAppRouterHydration(page);
    const aside = page.getByTestId("owner-params-aside");
    const asideSegment = page.getByTestId("owner-params-aside-segment");
    await expect(aside).toHaveText("aside stats 1");
    await expect(asideSegment).toHaveText("stats");

    await navigate(page, "One info", "/1/info");
    await expect(page.getByTestId("owner-params-children")).toHaveText("info 1");
    await expect(aside).toHaveText("aside stats 1");
    await expect(asideSegment).toHaveText("stats");

    await navigate(page, "Two info", "/2/info");
    await expect(page.getByTestId("owner-params-children")).toHaveText("info 2");
    await expect(aside).toHaveText("aside default 2");
    await expect(asideSegment).toHaveText("null");
  });
});
