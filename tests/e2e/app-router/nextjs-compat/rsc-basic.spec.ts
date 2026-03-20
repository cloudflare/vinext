/**
 * Next.js Compat E2E: rsc-basic
 * Ported from: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/rsc-basic/rsc-basic.test.ts
 */

import { test, expect } from "@playwright/test";

const BASE = "http://localhost:4174";

async function waitForHydration(page: import("@playwright/test").Page) {
  await expect(async () => {
    const ready = await page.evaluate(() => !!(window as any).__VINEXT_RSC_ROOT__);
    expect(ready).toBe(true);
  }).toPass({ timeout: 10_000 });
}

test.describe("Next.js compat: rsc-basic (browser)", () => {
  // Server component renders and hydrates
  test("server component renders and hydrates correctly", async ({ page }) => {
    await page.goto(`${BASE}/nextjs-compat/rsc-server`);
    await waitForHydration(page);

    await expect(page.locator("#server-rendered")).toHaveText("Server Component");
    await expect(page.locator("#server-message")).toHaveText("from server");
  });

  // Client component receives props from server and is interactive
  test("client component receives props from server and is interactive", async ({ page }) => {
    await page.goto(`${BASE}/nextjs-compat/rsc-server`);
    await waitForHydration(page);

    await expect(page.locator("#server-greeting")).toHaveText("hello from server");
    await expect(page.locator("#click-count")).toHaveText("0");

    await page.click("#increment-btn");
    await expect(page.locator("#click-count")).toHaveText("1");
  });

  // Client component state persists across clicks
  test("client component state persists across clicks", async ({ page }) => {
    await page.goto(`${BASE}/nextjs-compat/rsc-server`);
    await waitForHydration(page);

    await expect(page.locator("#click-count")).toHaveText("0");

    await page.click("#increment-btn");
    await expect(page.locator("#click-count")).toHaveText("1");

    await page.click("#increment-btn");
    await page.click("#increment-btn");
    await expect(page.locator("#click-count")).toHaveText("3");
  });

  // Page returning null renders without crashing
  test("page returning null renders without crashing", async ({ page }) => {
    const response = await page.goto(`${BASE}/nextjs-compat/rsc-null`);
    expect(response?.status()).toBe(200);
  });

  // Async server component renders in browser
  test("async server component renders in browser", async ({ page }) => {
    await page.goto(`${BASE}/nextjs-compat/rsc-async`);

    await expect(page.locator("#async-page")).toHaveText("Async Server Component", {
      timeout: 10_000,
    });
  });
});
