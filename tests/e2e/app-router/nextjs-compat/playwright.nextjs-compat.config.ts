import { defineConfig } from "@playwright/test";

const browserSpecificTests = "*.browser.spec.ts";

/**
 * Minimal Playwright config for running nextjs-compat tests only.
 * Assumes the app-basic dev server is already running on port 4174.
 *
 * Usage: npx playwright test -c tests/e2e/app-router/nextjs-compat/playwright.nextjs-compat.config.ts
 */
export default defineConfig({
  testDir: ".",
  timeout: 30_000,
  retries: 0,
  use: {
    headless: true,
  },
  projects: [
    {
      name: "chromium",
      testIgnore: browserSpecificTests,
      use: { browserName: "chromium" },
    },
    {
      name: "chrome-browser-specific",
      testMatch: browserSpecificTests,
      use: { browserName: "chromium", channel: "chrome" },
    },
    {
      name: "webkit-browser-specific",
      testMatch: browserSpecificTests,
      use: { browserName: "webkit" },
    },
  ],
});
