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

  test("client component importing CJS require('server-only') module is rejected", async ({
    page,
  }) => {
    await page.goto(`${BASE}/cjs/server-only-violation`);

    // The RSC plugin enforces server-only boundaries — a "use client" component
    // that imports a module using require("server-only") triggers the global
    // error boundary with a descriptive error message.
    await expect(page.getByTestId("global-error-message")).toContainText(
      "'server-only' cannot be imported in client build",
    );
    await expect(page.getByTestId("global-error-message")).toContainText(
      "server-lib.ts",
    );
  });
});
