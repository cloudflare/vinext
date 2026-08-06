import { expect, test } from "@playwright/test";

const BASE_URL = process.env.PAGES_ROUTER_PROD_BASE_URL ?? "http://127.0.0.1:4175";

test("starts an ESM Pages bundle with top-level await and CommonJS globals", async ({ page }) => {
  await page.goto(`${BASE_URL}/cjs-dependency-globals`);

  await expect(page.locator("#runtime-path")).toHaveText(/dist\/server\/runtime\.js$/);
});
