import { expect, test } from "@playwright/test";

const BASE = process.env.CLOUDFLARE_PAGES_ROUTER_BASE_URL ?? "http://localhost:4177";

async function expectFunctionalIdentity(page: import("@playwright/test").Page) {
  await expect(page.locator("#identity-types")).toHaveText("string:string");
  await expect(page.locator("#identity-consistent")).toHaveText("true");
  await expect(page.locator("#local-identity-types")).toHaveText("string:string");
  await expect(page.locator("#shadowed-process")).toHaveText("local-process");
  await expect(page.locator("#shadowed-global-this")).toHaveText("local-globalThis");
  await expect(page.locator("#filename-readable")).toHaveText("true");
  await expect(page.locator("#user-marker-types")).toHaveText("undefined:undefined");
}

test.describe("Pages Router bundled CommonJS globals on Cloudflare Workers", () => {
  test("uses emitted Worker identity for getServerSideProps", async ({ page }) => {
    const response = await page.goto(`${BASE}/cjs-dependency-globals`);
    expect(response?.status()).toBe(200);

    await expect(page.locator("#runtime-path")).toHaveText("/bundle/runtime.js");
    await expect(page.locator("#project-runtime-path")).toHaveText("/bundle/project-runtime.js");
    await expect(page.locator("#local-runtime-path")).toHaveText("/bundle/local-runtime.js");
    await expect(page.locator("#concatenated-path")).toHaveText("/bundle/concatenated.js");
    await expectFunctionalIdentity(page);
  });

  test("prerenders the same CommonJS dependency and module identity", async ({ page }) => {
    const response = await page.goto(`${BASE}/cjs-dependency-globals-static`);
    expect(response?.status()).toBe(200);

    await expectFunctionalIdentity(page);
  });
});
