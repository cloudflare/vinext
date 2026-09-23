import { expect, test } from "@playwright/test";

const BASE_URL = process.env.PAGES_ROUTER_PROD_BASE_URL ?? "http://127.0.0.1:4175";

test("starts an ESM Pages bundle with top-level await and CommonJS globals", async ({ page }) => {
  await page.goto(`${BASE_URL}/cjs-dependency-globals`);

  // instrumentation.ts completes before the lazy user-module graph evaluates,
  // so these dependencies correctly report their emitted lazy-chunk identity.
  await expect(page.locator("#runtime-path")).toHaveText(
    /dist\/server\/_next\/static\/chunks\/runtime\.js$/,
  );
  await expect(page.locator("#project-runtime-path")).toHaveText(
    /dist\/server\/_next\/static\/chunks\/project-runtime\.js$/,
  );
  await expect(page.locator("#identity-types")).toHaveText("string:string");
  await expect(page.locator("#identity-consistent")).toHaveText("true");
  await expect(page.locator("#local-runtime-path")).toHaveText(
    /dist\/server\/_next\/static\/chunks\/local-runtime\.js$/,
  );
  await expect(page.locator("#local-identity-types")).toHaveText("string:string");
  await expect(page.locator("#shadowed-process")).toHaveText("local-process");
  await expect(page.locator("#shadowed-global-this")).toHaveText("local-globalThis");
  await expect(page.locator("#filename-readable")).toHaveText("true");
  await expect(page.locator("#concatenated-path")).toHaveText(
    /dist\/server\/_next\/static\/chunks\/concatenated\.js$/,
  );
  await expect(page.locator("#user-marker-types")).toHaveText("undefined:undefined");
});

test("prerenders the same CommonJS dependency and module identity", async ({ page }) => {
  await page.goto(`${BASE_URL}/cjs-dependency-globals-static`);

  // Prerendering loads the same post-instrumentation user-module chunks.
  await expect(page.locator("#runtime-path")).toHaveText(
    /dist\/server\/_next\/static\/chunks\/runtime\.js$/,
  );
  await expect(page.locator("#identity-types")).toHaveText("string:string");
  await expect(page.locator("#identity-consistent")).toHaveText("true");
  await expect(page.locator("#local-runtime-path")).toHaveText(
    /dist\/server\/_next\/static\/chunks\/local-runtime\.js$/,
  );
  await expect(page.locator("#shadowed-process")).toHaveText("local-process");
  await expect(page.locator("#shadowed-global-this")).toHaveText("local-globalThis");
  await expect(page.locator("#filename-readable")).toHaveText("true");
  await expect(page.locator("#concatenated-path")).toHaveText(
    /dist\/server\/_next\/static\/chunks\/concatenated\.js$/,
  );
  await expect(page.locator("#user-marker-types")).toHaveText("undefined:undefined");
});
