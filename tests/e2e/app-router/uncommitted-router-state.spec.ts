import { expect, test } from "@playwright/test";
import { waitForAppRouterHydration } from "../helpers";

const BASE = "http://localhost:4174";

for (const navigation of ["hash", "back", "pushState", "replaceState"] as const) {
  test(`${navigation} discards a suspended render without a refresh`, async ({ page }) => {
    await page.goto(`${BASE}/commit-race/start`);
    await waitForAppRouterHydration(page);
    if (navigation === "back") await page.getByTestId("link-start-hash").click();
    await page.getByTestId("link-group-a").click();
    await page.waitForFunction(() => "__commitRaceLayoutRelease" in window);

    if (navigation === "hash") await page.getByTestId("link-start-hash").click();
    else if (navigation === "back") await page.goBack();
    else await page.evaluate((method) => window.history[method](null, "", "#top"), navigation);

    await page.evaluate(async () => {
      const holdWindow = window as Window & {
        __commitRaceLayoutHold?: Promise<string>;
        __commitRaceLayoutRelease?: (value: string) => void;
      };
      holdWindow.__commitRaceLayoutRelease?.("released");
      await holdWindow.__commitRaceLayoutHold;
      // Let React process the now-ready old tree before asserting it was discarded.
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
    });
    await expect(page.locator("h1")).toHaveText("Commit race start");
    await expect(page.getByTestId("group-a")).toHaveCount(0);
    await expect(page).toHaveURL(`${BASE}/commit-race/start${navigation === "back" ? "" : "#top"}`);
  });
}

// A navigation that renders and then suspends must not become the base of the
// next one. Group A suspends in its layout before commit. Group B's payload
// renders that same layout as ready. Preserving the uncommitted Group A layout
// keeps the page on the start route. Publication is a useInsertionEffect so a
// child useLayoutEffect that navigates still sees this commit. This spec does
// not mount that child.
// https://github.com/cloudflare/vinext/issues/3543
test("a suspended navigation does not seed the next commit", async ({ page }) => {
  await page.goto(`${BASE}/commit-race/start`);
  await expect(page.locator("h1")).toHaveText("Commit race start");
  await waitForAppRouterHydration(page);

  await page.getByTestId("link-group-a").click();
  await page.waitForFunction(() => {
    const hold = (window as Window & { __commitRaceLayoutHold?: unknown }).__commitRaceLayoutHold;
    return hold instanceof Promise;
  });
  await expect(page).toHaveURL(`${BASE}/commit-race/start`);
  await expect(page.locator("h1")).toHaveText("Commit race start");

  await page.evaluate(() => {
    document.cookie = "commit-race-mode=ready; path=/";
  });
  await page.getByTestId("link-group-b").click();

  await expect(page).toHaveURL(`${BASE}/commit-race/group/b`);
  await expect(page.getByTestId("group-b")).toHaveText("Group B");
  await expect(page.getByTestId("layout-hold")).toHaveText("ready");
  await expect(page.getByTestId("group-a")).toHaveCount(0);
  await expect(page.getByTestId("commit-race-error")).toHaveCount(0);
});
