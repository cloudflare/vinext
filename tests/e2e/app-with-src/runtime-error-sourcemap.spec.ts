import { test, expect } from "@playwright/test";

const BASE = "http://localhost:4181";
// Keep in sync with the throw in source-mapped-runtime-error.tsx.
const EXPECTED_THROW_LINE = 33;

// Regression for https://github.com/langgenius/dify/issues/37031.
// Next.js reference: dev client bundles remain source-map aware, and App Router
// dev errors request original stack frames through the dev server.
// https://github.com/vercel/next.js/blob/canary/packages/next/src/next-devtools/shared/stack-frame.ts
// https://github.com/vercel/next.js/blob/canary/packages/next/src/server/dev/middleware-webpack.ts
test("maps browser runtime error stack frames back to original TSX source lines", async ({
  page,
}) => {
  await page.goto(`${BASE}/client-runtime-sourcemap`);
  await page.waitForFunction(
    () => (window as Window & { __VINEXT_HYDRATED_AT?: number }).__VINEXT_HYDRATED_AT !== undefined,
  );

  const originalStackTraceRequest = page.waitForRequest((request) => {
    const url = new URL(request.url());
    return url.pathname === "/__vinext_original-stack-trace" && request.method() === "POST";
  });

  await page.getByTestId("trigger-client-runtime-sourcemap-error").click();
  await originalStackTraceRequest;

  await expect(page.getByTestId("vinext-dev-error-message")).toContainText(
    "client-runtime-sourcemap: original TSX throw line",
  );

  await expect(page.getByTestId("vinext-dev-error-stack")).toContainText(
    `client-runtime-sourcemap/source-mapped-runtime-error.tsx:${EXPECTED_THROW_LINE}:`,
  );
});
