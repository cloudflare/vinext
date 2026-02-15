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
    {
      name: "cloudflare-pages-router",
      testDir: "./tests/e2e/cloudflare-pages-router",
    },
    {
      name: "pages-router-prod",
      testDir: "./tests/e2e/pages-router-prod",
    },
    {
      name: "cloudflare-workers",
      testDir: "./tests/e2e/cloudflare-workers",
    },
  ],
  // Build the plugin, then start dev servers, production server, and Workers
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
    {
      command: "npx vite build && npx wrangler dev --port 4177",
      cwd: "./fixtures/cloudflare-pages",
      port: 4177,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    {
      // Use node to invoke the CLI directly — npx vinext may not be on PATH
      // in fixture subdirectories since vinext is a workspace dependency.
      command:
        "npx tsc -p ../../packages/vinext/tsconfig.json && node ../../packages/vinext/dist/cli.js build && node ../../packages/vinext/dist/cli.js start --port 4175",
      cwd: "./fixtures/pages-basic",
      port: 4175,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      // Build cloudflare-app with Vite, then serve with wrangler dev (miniflare)
      command:
        "npx vite build && npx wrangler dev --config dist/vinext_cloudflare_app/wrangler.json --port 4176",
      cwd: "./fixtures/cloudflare-app",
      port: 4176,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  ],
});
