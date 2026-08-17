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

test("an unchanged hash refreshes while a changed hash only scrolls", async ({ page }) => {
  // Ported from Next.js: test/e2e/app-dir/segment-cache/basic/segment-cache-basic.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/segment-cache/basic/segment-cache-basic.test.ts
  await page.goto(`${BASE_URL}/docs/nextjs-compat/link-soft-replace#section`);
  await waitForAppRouterHydration(page);

  const firstId = await page.getByTestId("soft-replace-render-id").textContent();
  expect(firstId).toBeTruthy();

  await page.getByTestId("soft-replace-section-link").click();
  await expect(page.getByTestId("soft-replace-render-id")).not.toHaveText(firstId!);

  const refreshedId = await page.getByTestId("soft-replace-render-id").textContent();
  await page.getByTestId("soft-replace-other-link").click();
  await expect(page).toHaveURL(/#other$/);
  await expect(page.getByTestId("soft-replace-render-id")).toHaveText(refreshedId!);
});

test("removing a hash does not fetch RSC or rerender the page", async ({ page }) => {
  await page.goto(`${BASE_URL}/docs/nextjs-compat/link-soft-replace#section`);
  await waitForAppRouterHydration(page);

  const renderId = await page.getByTestId("soft-replace-render-id").textContent();
  let rscRequests = 0;
  page.on("request", (request) => {
    if (request.headers().rsc === "1") rscRequests++;
  });

  await page.getByTestId("soft-replace-link").click();
  await expect(page).toHaveURL(/\/docs\/nextjs-compat\/link-soft-replace$/);
  await expect(page.getByTestId("soft-replace-render-id")).toHaveText(renderId!);
  await page.waitForTimeout(200);
  expect(rscRequests).toBe(0);
});

test("an exact encoded query preserves raw URL identity", async ({ page }) => {
  await page.goto(`${BASE_URL}/docs/nextjs-compat/link-soft-replace?q=%20`);
  await waitForAppRouterHydration(page);

  const firstId = await page.getByTestId("soft-replace-render-id").textContent();
  expect(firstId).toBeTruthy();

  await page.getByTestId("soft-replace-encoded-link").click();
  await expect(page.getByTestId("soft-replace-render-id")).not.toHaveText(firstId!);
  expect(new URL(page.url()).search).toBe("?q=%20");
});

test("an app-relative route beginning with basePath is not stripped twice", async ({ page }) => {
  await page.goto(`${BASE_URL}/docs/docs/foo`);
  await waitForAppRouterHydration(page);

  const firstId = await page.getByTestId("prefix-collision-render-id").textContent();
  expect(firstId).toBeTruthy();

  await page.getByTestId("prefix-collision-link").click();
  await expect(page.getByTestId("prefix-collision-render-id")).not.toHaveText(firstId!);
  await expect(page).toHaveURL(/\/docs\/docs\/foo$/);
});
