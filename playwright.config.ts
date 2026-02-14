import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  retries: 1,
  use: {
    headless: true,
    // Use chromium only — fast and sufficient for our tests
    browserName: "chromium",
  },
  projects: [
    {
      name: "pages-router",
      testDir: "./tests/e2e/pages-router",
    },
    {
      name: "app-router",
      testDir: "./tests/e2e/app-router",
    },
  ],
  // Build the plugin, then start both Vite dev servers
  webServer: [
    {
      command:
        "npx tsc -p ../../packages/vinext/tsconfig.json && npx vite --port 4173",
      cwd: "./fixtures/pages-basic",
      port: 4173,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    {
      command: "npx vite --port 4174",
      cwd: "./fixtures/app-basic",
      port: 4174,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
  ],
});
