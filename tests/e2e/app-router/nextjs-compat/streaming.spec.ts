/**
 * Next.js Compat E2E: streaming / loading.tsx
 * Ported from: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/app-rendering/rendering.test.ts
 */

import { test, expect } from "@playwright/test";

const BASE = "http://localhost:4174";

test.describe("Next.js compat: streaming / loading.tsx (browser)", () => {
  // Streaming page renders fully
  test("streaming page renders fully in browser", async ({ page }) => {
    await page.goto(`${BASE}/nextjs-compat/streaming-test`);

    await expect(page.locator("#streaming-page")).toHaveText("Streaming Test", {
      timeout: 10_000,
    });

    // Streamed content resolves asynchronously
    await expect(page.locator("#streamed-content")).toHaveText("Streamed content loaded", {
      timeout: 10_000,
    });
  });

  // Nested streaming resolves all boundaries
  test("nested streaming resolves all boundaries", async ({ page }) => {
    await page.goto(`${BASE}/nextjs-compat/streaming-test/nested`);

    await expect(page.locator("#nested-streaming-page")).toBeVisible({
      timeout: 10_000,
    });

    // Both streamed content sections should eventually resolve
    await expect(page.locator("#content-a")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("#content-b")).toBeVisible({ timeout: 10_000 });
  });
});
