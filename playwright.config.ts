import { defineConfig } from "@playwright/test";

const appRouterBrowserSpecificTests = "**/app-router/**/*.browser.spec.ts";
const appRouterServer = {
  command: "npx vp dev --port 4174",
  cwd: "./tests/fixtures/app-basic",
  port: 4174,
  reuseExistingServer: !process.env.CI,
  timeout: 30_000,
};

// Dedicated server for BFCache/cacheComponents coverage. cacheComponents is an
// opt-in semantic mode that retains inactive route trees as hidden Activity DOM.
// Running it on the shared app-basic fixture would change the DOM contract for
// every unrelated app-router test, so it gets its own isolated fixture instead.
const appRouterBfcacheServer = {
  command: "npx vp dev --port 4183",
  cwd: "./tests/fixtures/app-bfcache",
  port: 4183,
  reuseExistingServer: !process.env.CI,
  timeout: 30_000,
};

/**
 * Each project maps to a single webServer. Some browser-specific projects share
 * a server with the base project, and shared servers are de-duped by port.
 * Browser-specific production tests may opt out with server: null when they own
 * their build/server lifecycle inside the test fixture.
 * When PLAYWRIGHT_PROJECT is set
 * (e.g. in CI matrix jobs), only that project and its server are configured,
 * so each CI runner only starts the one server it needs.
 */
const projectServers = {
  "pages-router": {
    testDir: "./tests/e2e/pages-router",
    use: { baseURL: "http://localhost:4173" },
    server: {
      command: "npx vp run vinext#build && npx vp dev --port 4173",
      cwd: "./tests/fixtures/pages-basic",
      port: 4173,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
  },
  "app-router": {
    testDir: "./tests/e2e",
    testMatch: ["**/app-router/**/*.spec.ts", "**/og-image.spec.ts"],
    testIgnore: appRouterBrowserSpecificTests,
    use: { baseURL: "http://localhost:4174" },
    server: appRouterServer,
  },
  "app-router-chrome-browser-specific": {
    testDir: "./tests/e2e",
    testMatch: [appRouterBrowserSpecificTests],
    use: {
      browserName: "chromium" as const,
      channel: "chrome" as const,
    },
    server: null,
  },
  "app-router-webkit-browser-specific": {
    testDir: "./tests/e2e",
    testMatch: [appRouterBrowserSpecificTests],
    use: { browserName: "webkit" as const },
    server: null,
  },
  "app-router-bfcache": {
    testDir: "./tests/e2e/app-router-bfcache",
    use: { baseURL: "http://localhost:4183" },
    server: appRouterBfcacheServer,
  },
  "catch-error": {
    testDir: "./tests/e2e/catch-error",
    use: { baseURL: "http://localhost:4185" },
    server: {
      command:
        "npx vp run vinext#build && node ../../../packages/vinext/dist/cli.js build && node ../../../packages/vinext/dist/cli.js start --port 4185",
      cwd: "./tests/fixtures/global-not-found-basic",
      port: 4185,
      reuseExistingServer: false,
      timeout: 60_000,
    },
  },
  "cloudflare-pages-router": {
    testDir: "./tests/e2e",
    testMatch: [
      "**/cloudflare-pages-router/**/*.spec.ts",
      "**/pages-router/instrumentation-startup.spec.ts",
    ],
    use: { baseURL: "http://localhost:4177" },
    server: {
      command: "npx vp build && npx wrangler dev --port 4177",
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
        "npx vp run vinext#build && node ../../../packages/vinext/dist/cli.js build && node ../../../packages/vinext/dist/cli.js start --port 4175",
      cwd: "./tests/fixtures/pages-basic",
      port: 4175,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  },
  "pages-scroll-restoration": {
    testDir: "./tests/e2e/pages-scroll-restoration",
    use: { baseURL: "http://localhost:4185" },
    server: {
      command:
        "npx vp run vinext#build && node ../../../packages/vinext/dist/cli.js build && node ../../../packages/vinext/dist/cli.js start --port 4185",
      cwd: "./tests/fixtures/pages-scroll-restoration",
      port: 4185,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  },
  "cloudflare-workers": {
    testDir: "./tests/e2e",
    testMatch: [
      "**/cloudflare-workers/**/*.spec.ts",
      "**/app-router/instrumentation.spec.ts",
      "**/og-image.spec.ts",
    ],
    use: { baseURL: "http://localhost:4176" },
    server: {
      // Build app-router-cloudflare with Vite, then serve with wrangler dev (miniflare)
      command: "npx vp build && npx wrangler dev --config dist/server/wrangler.json --port 4176",
      cwd: "./examples/app-router-cloudflare",
      port: 4176,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  },
  "cloudflare-dev": {
    testDir: "./tests/e2e",
    testMatch: [
      "**/cloudflare-dev/**/*.spec.ts",
      "**/app-router/instrumentation.spec.ts",
      "**/og-image.spec.ts",
    ],
    use: { baseURL: "http://localhost:4178" },
    server: {
      // Run vite dev (not wrangler) against the cloudflare example so that
      // configureServer() is exercised with @cloudflare/vite-plugin loaded.
      command: "npx vp dev --port 4178",
      cwd: "./examples/app-router-cloudflare",
      port: 4178,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
  },
  "cloudflare-pages-router-dev": {
    testDir: "./tests/e2e",
    testMatch: [
      "**/cloudflare-pages-router-dev/**/*.spec.ts",
      "**/pages-router/instrumentation-startup.spec.ts",
    ],
    use: { baseURL: "http://localhost:4179" },
    server: {
      command: "npx vp dev --port 4179",
      cwd: "./examples/pages-router-cloudflare",
      port: 4179,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
  },
  "static-export": {
    testDir: "./tests/e2e/static-export",
    use: { baseURL: "http://localhost:4180" },
    server: {
      // Build the static export fixture, then serve the output with a
      // lightweight static file server. No vinext runtime is needed —
      // the output is pure pre-rendered HTML files.
      command:
        "npx vp run vinext#build && node ../../../packages/vinext/dist/cli.js build && node ../../../tests/e2e/static-export/serve-static.mjs dist/client 4180",
      cwd: "./tests/fixtures/static-export",
      port: 4180,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  },
  "app-with-src": {
    testDir: "./tests/e2e/app-with-src",
    use: { baseURL: "http://localhost:4181" },
    server: {
      command: "npx vp dev --port 4181",
      cwd: "./tests/fixtures/app-with-src",
      port: 4181,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
  },
  "standalone-output": {
    testDir: "./tests/e2e/standalone-output",
    use: { baseURL: "http://localhost:4182" },
    server: {
      // Build vinext CLI, then build the fixture, then start the standalone
      // server from an isolated temp directory. Moving it outside the repo
      // prevents Node from resolving missing externals from workspace
      // node_modules and verifies the standalone package is self-contained.
      command:
        'npx vp run vinext#build && node ../../../packages/vinext/dist/cli.js build && standalone_dir="$(mktemp -d)" && cp -R dist/standalone/. "$standalone_dir" && PORT=4182 node "$standalone_dir/server.js"',
      cwd: "./tests/fixtures/standalone-output",
      port: 4182,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  },
  "root-layout-redirect": {
    testDir: "./tests/e2e/root-layout-redirect",
    use: { baseURL: "http://localhost:4184" },
    server: {
      // Build vinext CLI, then build the fixture, then start the production
      // server. This exercises prodOnCaughtError (the fixed code path) rather
      // than devOnCaughtError, which already filtered navigation-signal errors
      // before this PR.
      command:
        "npx vp run vinext#build && node ../../../packages/vinext/dist/cli.js build && node ../../../packages/vinext/dist/cli.js start --port 4184",
      cwd: "./tests/fixtures/root-layout-redirect",
      port: 4184,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  },
  "use-params-app-pages": {
    testDir: "./tests/e2e/use-params-app-pages",
    use: { baseURL: "http://localhost:4186" },
    server: {
      command:
        "cd ../../.. && npx vp run vinext#build && cd tests/fixtures/use-params-app-pages && node ../../../packages/vinext/dist/cli.js build && node ../../../packages/vinext/dist/cli.js start --port 4186",
      cwd: "./tests/fixtures/use-params-app-pages",
      port: 4186,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  },
  "ppr-impact-demo": {
    testDir: "./tests/e2e/ppr-impact-demo",
    use: { baseURL: "http://localhost:4187" },
    server: {
      command:
        "npx vp run vinext#build && node ../../../packages/vinext/dist/cli.js build --prerender-all && node ../../../packages/vinext/dist/cli.js start --port 4187",
      cwd: "./tests/fixtures/ppr-impact-demo",
      port: 4187,
      reuseExistingServer: !process.env.CI,
      timeout: 90_000,
    },
  },
  "app-front-redirect-issue": {
    testDir: "./tests/e2e/app-front-redirect-issue",
    use: { baseURL: "http://localhost:4188" },
    server: {
      command:
        "(test -e node_modules || test -L node_modules || ln -s ../../../fixtures/app-basic/node_modules node_modules) && npx vp run vinext#build && NEXT_DEPLOYMENT_ID=vinext-front-redirect-e2e node ../../../../packages/vinext/dist/cli.js build && NEXT_DEPLOYMENT_ID=vinext-front-redirect-e2e node ../../../../packages/vinext/dist/cli.js start --port 4188",
      cwd: "./tests/e2e/app-front-redirect-issue/fixture",
      port: 4188,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  },
  "pages-router-basepath-dev": {
    testDir: "./tests/e2e/pages-router-basepath-dev",
    use: { baseURL: "http://localhost:4189" },
    server: {
      command:
        "(test -e node_modules || test -L node_modules || ln -s ../pages-basic/node_modules node_modules) && npx vp dev --port 4189",
      cwd: "./tests/fixtures/pages-basepath-dev",
      port: 4189,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
  },
  "pages-router-basepath": {
    // basePath + trailingSlash. Runs in PROD mode (build + start) because
    // vinext's dev server has a Vite html-proxy / basePath incompatibility
    // in inline hydration imports — unrelated to the navigation pipeline
    // under test. Prod skips html-proxy entirely (it uses pre-built
    // `__VINEXT_PAGE_LOADERS__`), so we exercise the same Pages Router
    // navigation code paths users hit in production.
    testDir: "./tests/e2e/pages-router-basepath",
    use: { baseURL: "http://localhost:4190" },
    server: {
      command:
        "(test -e node_modules || test -L node_modules || ln -s ../pages-basic/node_modules node_modules) && npx vp run vinext#build && node ../../../packages/vinext/dist/cli.js build && node ../../../packages/vinext/dist/cli.js start --port 4190",
      cwd: "./tests/fixtures/pages-basepath-trailing-slash",
      port: 4190,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
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
    // Most projects use Chromium by default. Browser-specific projects override this.
    browserName: "chromium",
  },
  projects: activeProjects.map((name) => {
    const p = projectServers[name];
    return {
      name,
      testDir: p.testDir,
      ...("testMatch" in p ? { testMatch: p.testMatch } : {}),
      ...("testIgnore" in p ? { testIgnore: p.testIgnore } : {}),
      ...("use" in p ? { use: p.use } : {}),
    };
  }),
  webServer: [
    ...new Map(
      activeProjects
        .map((name) => projectServers[name].server)
        .filter(
          (server): server is NonNullable<(typeof projectServers)[ProjectName]["server"]> =>
            server !== null,
        )
        .map((server) => [server.port, server]),
    ).values(),
  ],
});
