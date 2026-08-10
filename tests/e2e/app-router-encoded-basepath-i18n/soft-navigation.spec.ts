import { expect, test } from "@playwright/test";
import { waitForAppRouterHydration } from "../helpers";

const BASE_URL = process.env.VINEXT_BASEPATH_E2E_BASE_URL ?? "";

test("an exact-current Link refreshes page output behind basePath", async ({ page }) => {
  await page.goto(`${BASE_URL}/docs/nextjs-compat/link-soft-replace`);
  await waitForAppRouterHydration(page);

  const firstId = await page.getByTestId("soft-replace-render-id").textContent();
  const historyLength = await page.evaluate(() => window.history.length);
  expect(firstId).toBeTruthy();

  await page.getByTestId("soft-replace-link").click();

  await expect(page.getByTestId("soft-replace-render-id")).not.toHaveText(firstId!);
  await expect(page).toHaveURL(/\/docs\/nextjs-compat\/link-soft-replace$/);
  expect(await page.evaluate(() => window.history.length)).toBe(historyLength);
});
