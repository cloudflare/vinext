import { test, expect, type Page } from "@playwright/test";
import { waitForAppRouterHydration } from "../helpers";

const BASE = "http://localhost:4174";

type RecorderWindow = Window & { __PARAMS_HISTORY_RENDERS__?: string[] };

async function resetRenders(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as RecorderWindow).__PARAMS_HISTORY_RENDERS__ = [];
  });
}

async function readRenders(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as RecorderWindow).__PARAMS_HISTORY_RENDERS__ ?? []);
}

// Back/Forward restore a cached tree synchronously. Client params used to stay
// staged until after that render, so the restored page rendered once with the
// previous route's params (here: no `id`) before correcting itself.
test("useParams never shows the previous route's params on Back/Forward", async ({ page }) => {
  await page.goto(`${BASE}/params-history`);
  await waitForAppRouterHydration(page);

  await page.click("#params-history-item");
  await expect(page.locator("#params-history-id")).toHaveText("item-1");

  for (let i = 0; i < 2; i++) {
    await page.goBack();
    await expect(page.locator("#params-history-title")).toHaveText("Params history list");

    await resetRenders(page);
    await page.goForward();
    await expect(page.locator("#params-history-id")).toHaveText("item-1");

    const renders = await readRenders(page);
    expect(renders.length).toBeGreaterThan(0);
    expect(
      renders.every((render) => render === "item-1 /params-history/item-1?"),
      JSON.stringify(renders),
    ).toBe(true);
  }
});

// A history.pushState() entry copies the current tree but shows its own URL.
// Restoring it must pair that URL with the copied tree's params in every
// render, not the copied tree's URL or the previous route's values.
test("Back to a pushState entry renders its own URL and the copied params", async ({ page }) => {
  await page.goto(`${BASE}/params-history/item-1`);
  await waitForAppRouterHydration(page);

  await page.evaluate(() => {
    window.history.pushState(null, "", "/params-history/item-1?tab=shallow");
  });
  await expect(page.locator("#params-history-search")).toHaveText("tab=shallow");

  await page.click("#params-history-next");
  await expect(page.locator("#params-history-id")).toHaveText("item-2");

  await resetRenders(page);
  await page.goBack();
  await expect(page.locator("#params-history-id")).toHaveText("item-1");
  await expect(page.locator("#params-history-search")).toHaveText("tab=shallow");

  const renders = await readRenders(page);
  expect(renders.length).toBeGreaterThan(0);
  expect(
    renders.every((render) => render === "item-1 /params-history/item-1?tab=shallow"),
    JSON.stringify(renders),
  ).toBe(true);
});
