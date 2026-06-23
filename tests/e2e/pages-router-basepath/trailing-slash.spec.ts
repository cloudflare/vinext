// Ported from Next.js: test/e2e/basepath/trailing-slash.test.ts
// https://github.com/vercel/next.js/blob/canary/test/e2e/basepath/trailing-slash.test.ts

import { test, expect } from "@playwright/test";
import { waitForHydration } from "../helpers";

const BASE = "http://localhost:4190";

test.describe("basePath + trailingSlash", () => {
  test("replaces state when same asPath but different url", async ({ page }) => {
    await page.goto(`${BASE}/docs/`);
    await expect(page.locator("#index-page")).toBeVisible({ timeout: 5_000 });
    await waitForHydration(page);

    // Index -> Hello via #hello-link
    await page.locator("#hello-link").click();
    await expect(page.locator("#something-else-link")).toBeVisible({ timeout: 5_000 });

    // Hello -> (navigate to something-else, displayed as /hello) via #something-else-link
    await page.locator("#something-else-link").click();
    await expect(page.locator("#something-else-page")).toBeVisible({ timeout: 5_000 });

    // Go back -> should show index
    await page.goBack();
    await expect(page.locator("#index-page")).toBeVisible({ timeout: 5_000 });

    // Go forward -> should show something-else-page
    await page.goForward();
    await expect(page.locator("#something-else-page")).toBeVisible({ timeout: 5_000 });
  });
});
