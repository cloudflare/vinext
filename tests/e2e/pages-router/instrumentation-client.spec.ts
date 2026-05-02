// Ported from Next.js:
// test/e2e/instrumentation-client-hook/instrumentation-client-hook.test.ts
// https://github.com/vercel/next.js/blob/canary/test/e2e/instrumentation-client-hook/instrumentation-client-hook.test.ts

import { test, expect } from "@playwright/test";

test("executes instrumentation-client before hydration in Pages Router", async ({ page }) => {
  await page.goto("/instrumentation-client");
  await page.waitForFunction(() => {
    const win = window as Window & {
      __INSTRUMENTATION_CLIENT_EXECUTED_AT?: number;
      __VINEXT_HYDRATED_AT?: number;
    };
    return (
      win.__INSTRUMENTATION_CLIENT_EXECUTED_AT !== undefined &&
      win.__VINEXT_HYDRATED_AT !== undefined
    );
  });

  const timing = await page.evaluate(() => {
    const win = window as Window & {
      __INSTRUMENTATION_CLIENT_EXECUTED_AT?: number;
      __VINEXT_HYDRATED_AT?: number;
    };
    return {
      instrumentation: win.__INSTRUMENTATION_CLIENT_EXECUTED_AT,
      hydration: win.__VINEXT_HYDRATED_AT,
    };
  });

  expect(timing.instrumentation).toBeDefined();
  expect(timing.hydration).toBeDefined();
  if (timing.instrumentation === undefined || timing.hydration === undefined) {
    throw new Error("Instrumentation or hydration timing marker was not recorded");
  }
  expect(timing.instrumentation).toBeLessThan(timing.hydration);
  await expect(page.locator("#pages-instrumentation-client")).toBeVisible();
});
