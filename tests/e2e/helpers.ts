import type { Page } from "@playwright/test";

export async function waitForHydration(page: Page) {
  await page.waitForFunction(() => Boolean(window.__VINEXT_ROOT__));
}
