import { test, expect } from "@playwright/test";

const BASE = "http://localhost:4173";

test.describe("next/script", () => {
  // Ported from Next.js: packages/next/src/client/script.tsx
  // https://github.com/vercel/next.js/blob/canary/packages/next/src/client/script.tsx
  // Next.js keeps a ScriptCache for in-flight remote scripts so same-src
  // components mounted together only append one DOM script.
  test("deduplicates simultaneous same-src scripts before load completes", async ({ page }) => {
    await page.goto(`${BASE}/script-dedupe`);
    await expect(page.getByRole("heading", { name: "Script Dedupe" })).toBeVisible();

    await expect.poll(() => page.locator('script[src="/dedupe-script.js"]').count()).toBe(1);
    await expect
      .poll(() => page.evaluate(() => Reflect.get(window, "__vinextScriptDedupeExecutions")))
      .toBe(1);
  });
});
