import { test, expect } from "@playwright/test";

const BASE = "http://localhost:4174";

test.describe("CJS interop", () => {
  test("server component with CJS require('server-only') renders correctly", async ({
    page,
  }) => {
    await page.goto(`${BASE}/cjs/server-only`);

    await expect(page.getByTestId("cjs-server-only")).toContainText(
      "This page uses CJS require",
    );
  });

  test("server component with CJS require() and module.exports renders correctly", async ({
    page,
  }) => {
    await page.goto(`${BASE}/cjs/basic`);
    await expect(page.getByTestId("cjs-basic")).toContainText("Random: 4");
  });

  // The server-only-violation test lives in a separate fixture
  // (tests/fixtures/app-cjs-violation/) because the intentional violation
  // causes a fatal error during production builds of app-basic, breaking
  // unrelated tests. The RSC plugin's server-only boundary enforcement for
  // CJS require("server-only") is verified by the production build validation.
});
