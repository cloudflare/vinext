import { defineConfig } from "@playwright/test";

/**
 * Each project maps to a single webServer. When PLAYWRIGHT_PROJECT is set
 * (e.g. in CI matrix jobs), only that project and its server are configured,
 * so each CI runner only starts the one server it needs.
 */
const projectServers = {
  "pages-router": {
    testDir: "./tests/e2e/pages-router",
    server: {
      command:
        "npx tsc -p ../../../packages/vinext/tsconfig.json && npx vite --port 4173",
      cwd: "./tests/fixtures/pages-basic",
      port: 4173,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
  },
  "app-router": {
    testDir: "./tests/e2e/app-router",
    server: {
      command: "npx vite --port 4174",
      cwd: "./tests/fixtures/app-basic",
      port: 4174,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
  },
  "cloudflare-pages-router": {
    testDir: "./tests/e2e/cloudflare-pages-router",
    server: {
      command: "npx vite build && npx wrangler dev --port 4177",
      cwd: "./examples/pages-router-cloudflare",
      port: 4177,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
  },
  "pages-router-prod": {
    testDir: "./tests/e2e/pages-router-prod",
    server: {
      // Use node to invoke the CLI directly — npx vinext may not be on PATH
      // in fixture subdirectories since vinext is a workspace dependency.
      command:
        "npx tsc -p ../../../packages/vinext/tsconfig.json && node ../../../packages/vinext/dist/cli.js build && node ../../../packages/vinext/dist/cli.js start --port 4175",
      cwd: "./tests/fixtures/pages-basic",
      port: 4175,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  },
  "cloudflare-workers": {
    testDir: "./tests/e2e/cloudflare-workers",
    server: {
      // Build app-router-cloudflare with Vite, then serve with wrangler dev (miniflare)
      command:
        "npx vite build && npx wrangler dev --config dist/server/wrangler.json --port 4176",
      cwd: "./examples/app-router-cloudflare",
      port: 4176,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  },
};

type ProjectName = keyof typeof projectServers;

const selected = process.env.PLAYWRIGHT_PROJECT;

if (selected && !(selected in projectServers)) {
  throw new Error(
    `Unknown PLAYWRIGHT_PROJECT: "${selected}". ` +
      `Valid: ${Object.keys(projectServers).join(", ")}`,
  );
}

const activeProjects: ProjectName[] = selected
  ? [selected as ProjectName]
  : (Object.keys(projectServers) as ProjectName[]);

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  retries: 1,
  // GitHub reporter adds inline failure annotations in PR diffs.
  reporter: process.env.CI ? [["list"], ["github"]] : [["list"]],
  use: {
    headless: true,
    // Use chromium only — fast and sufficient for our tests
    browserName: "chromium",
  },
  projects: activeProjects.map((name) => ({
    name,
    testDir: projectServers[name].testDir,
  })),
  webServer: activeProjects.map((name) => projectServers[name].server),
});
