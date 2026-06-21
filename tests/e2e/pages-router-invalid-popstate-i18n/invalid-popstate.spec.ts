import { expect, test } from "@playwright/test";
import { waitForHydration } from "../helpers";

type RouterHistoryState = {
  url: string;
  as: string;
  options: { locale: string };
  __N: true;
  key: string;
};

async function dispatchPopState(page: import("@playwright/test").Page, state: RouterHistoryState) {
  await page.evaluate((historyState) => {
    window.dispatchEvent(new PopStateEvent("popstate", { state: historyState }));
  }, state);
}

test.describe("invalid first popstate with i18n", () => {
  for (const search of ["", "?param=1"]) {
    test(`ignores the first stale event for the active locale ${search || "without query"}`, async ({
      page,
    }) => {
      await page.goto(`/sv/static${search}`);
      await waitForHydration(page);

      const state: RouterHistoryState = {
        url: `/[dynamic]${search}`,
        as: `/static${search}`,
        options: { locale: "sv" },
        __N: true,
        key: "",
      };

      await expect(page.locator("#page-type")).toHaveText("static");
      await dispatchPopState(page, state);
      await page.waitForTimeout(100);
      await expect(page.locator("#page-type")).toHaveText("static");

      await dispatchPopState(page, state);
      await expect(page.locator("#page-type")).toHaveText("dynamic");
    });
  }

  test("does not ignore a stale event for another locale", async ({ page }) => {
    await page.goto("/sv/static?param=1");
    await waitForHydration(page);

    await dispatchPopState(page, {
      url: "/[dynamic]?param=1",
      as: "/static?param=1",
      options: { locale: "en" },
      __N: true,
      key: "",
    });

    await expect(page.locator("#page-type")).toHaveText("dynamic");
  });
});
