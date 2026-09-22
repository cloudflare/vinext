import { test, expect } from "@playwright/test";

test("instrumentation can dynamically import a server-only module", async ({ page }) => {
  // Ported from Next.js:
  // test/e2e/rsc-layers-transform/instrumentation.js
  // test/e2e/app-dir/instrumentation-order/instrumentation-order.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/rsc-layers-transform/instrumentation.js
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/instrumentation-order/instrumentation-order.test.ts
  await page.goto("/");

  await expect(page.locator("#app-with-src-home")).toBeVisible();
  await expect(page.locator("#instrumentation-server-only")).toHaveText("true");
});
