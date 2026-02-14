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
  // Build the plugin, then start the Vite dev server for the fixture
  webServer: {
    command:
      "npx tsc -p ../../packages/vite-plugin-nextcompat/tsconfig.json && npx vite --port 4173",
    cwd: "./fixtures/pages-basic",
    port: 4173,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
