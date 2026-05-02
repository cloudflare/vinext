import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";

/**
 * Wait for Pages Router hydration to complete.
 * Checks for window.__VINEXT_ROOT__.
 */
export async function waitForHydration(page: Page): Promise<void> {
  await page.waitForFunction(() => Boolean(window.__VINEXT_ROOT__));
}

/**
 * Wait for App Router (RSC) hydration to complete.
 * Checks for window.__VINEXT_RSC_ROOT__.
 *
 * Uses expect().toPass() for better error messages on timeout.
 * 10 second timeout matches Next.js hydration expectations.
 */
export async function waitForAppRouterHydration(page: Page): Promise<void> {
  await expect(async () => {
    const ready = await page.evaluate(
      () =>
        Boolean(window.__VINEXT_RSC_ROOT__) && typeof window.__VINEXT_RSC_NAVIGATE__ === "function",
    );
    expect(ready).toBe(true);
  }).toPass({ timeout: 10_000 });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
}
