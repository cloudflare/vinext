import { expect, test } from "@playwright/test";

const BASE_URL = process.env.PAGES_ROUTER_PROD_BASE_URL ?? "http://127.0.0.1:4175";

test("starts an ESM Pages bundle with top-level await and CommonJS globals", async ({ page }) => {
  await page.goto(`${BASE_URL}/cjs-dependency-globals`);

  await expect(page.locator("#runtime-path")).toHaveText(/dist\/server\/runtime\.js$/);
  await expect(page.locator("#project-runtime-path")).toHaveText(
    /dist\/server\/project-runtime\.js$/,
  );
  await expect(page.locator("#identity-types")).toHaveText("string:string");
  await expect(page.locator("#identity-consistent")).toHaveText("true");
  await expect(page.locator("#local-runtime-path")).toHaveText(/dist\/server\/local-runtime\.js$/);
  await expect(page.locator("#local-identity-types")).toHaveText("string:string");
  await expect(page.locator("#shadowed-process")).toHaveText("local-process");
  await expect(page.locator("#user-marker-types")).toHaveText("undefined:undefined");
});

test("prerenders the same CommonJS dependency and module identity", async ({ page }) => {
  await page.goto(`${BASE_URL}/cjs-dependency-globals-static`);

  await expect(page.locator("#runtime-path")).toHaveText(/dist\/server\/runtime\.js$/);
  await expect(page.locator("#identity-types")).toHaveText("string:string");
  await expect(page.locator("#identity-consistent")).toHaveText("true");
  await expect(page.locator("#local-runtime-path")).toHaveText(/dist\/server\/local-runtime\.js$/);
  await expect(page.locator("#shadowed-process")).toHaveText("local-process");
  await expect(page.locator("#user-marker-types")).toHaveText("undefined:undefined");
});
