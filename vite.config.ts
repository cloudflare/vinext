import path from "node:path";
import { defineConfig } from "vite-plus";
import { randomUUID } from "node:crypto";

const SHIMS_SRC = path.resolve(import.meta.dirname, "packages/vinext/src/shims");
const VINEXT_SRC = path.resolve(import.meta.dirname, "packages/vinext/src");
const CLOUDFLARE_SRC = path.resolve(import.meta.dirname, "packages/cloudflare/src");
const MSW_SETUP = path.resolve(import.meta.dirname, "tests/_msw/setup.ts");

// Resolve own-workspace sources directly in tests so the vinext <->
// @vinext/cloudflare dependency edge points at source (single module instance,
// no prior build required). Shared by both test projects below.
const WORKSPACE_SRC_ALIAS = {
  "vinext/shims": SHIMS_SRC,
  "vinext/internal": VINEXT_SRC,
  "@vinext/cloudflare/internal": CLOUDFLARE_SRC,
  "@vinext/cloudflare/cache": path.resolve(import.meta.dirname, "packages/cloudflare/src/cache"),
  "@vinext/cloudflare/images": path.resolve(import.meta.dirname, "packages/cloudflare/src/images"),
};

export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  fmt: {
    printWidth: 100,
    tabWidth: 2,
    useTabs: false,
    semi: true,
    singleQuote: false,
    trailingComma: "all",
    ignorePatterns: [
      "tests/fixtures/ecosystem/**",
      "examples/**",
      "packages/types/next/upstream/**",
    ],
  },
  lint: {
    ignorePatterns: [
      "fixtures/ecosystem/**",
      "tests/fixtures/**",
      "tests/fixtures/ecosystem/**",
      "examples/**",
      "packages/types/next/upstream/**",
    ],
    options: {
      typeAware: true,
      typeCheck: true,
      denyWarnings: true,
    },
    plugins: ["typescript", "unicorn", "import", "react"],
    jsPlugins: [
      "./oxlint-plugins/prefer-import-alias.js",
      "./oxlint-plugins/prefer-shared-utils.js",
    ],
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "typescript/consistent-type-definitions": ["error", "type"],
      "@typescript-eslint/no-unsafe-function-type": "error",
      "@typescript-eslint/no-unused-vars": "error",
      "@typescript-eslint/no-redeclare": "error",
      "@typescript-eslint/no-implied-eval": "error",

      "unicorn/prefer-node-protocol": "error",

      "import/first": "error",
      "import/no-duplicates": "error",

      "no-new-func": "error",
      "no-implied-eval": "error",
      "arrow-body-style": ["error", "as-needed"],

      "react/exhaustive-deps": "error",
      "react/no-array-index-key": "error",
      "react/rules-of-hooks": "error",
      "react/self-closing-comp": "error",
      "vinext-utils/prefer-shared-utils": "error",
    },
    overrides: [
      {
        files: ["**.spec.ts", "**.test.ts"],
        rules: {
          "@typescript-eslint/no-explicit-any": "off",
          "@typescript-eslint/no-unsafe-function-type": "off",
          "typescript/no-misused-promises": "error",
          "typescript/switch-exhaustiveness-check": "error",
          "import/no-self-import": "error",
          "unicorn/throw-new-error": "error",
          "unicorn/error-message": "error",
        },
      },
      {
        files: ["packages/vinext/src/**/*.{ts,tsx}"],
        rules: {
          "typescript/no-misused-promises": "error",
          "typescript/switch-exhaustiveness-check": "error",
          "typescript/restrict-template-expressions": "error",
          "import/no-self-import": "error",
          "unicorn/throw-new-error": "error",
          "unicorn/error-message": "error",
          // Source path handling goes through pathslash so every join/resolve/
          // relative emits canonical forward-slash output on Windows. Files
          // that genuinely work in native-separator space (build/standalone.ts)
          // disable this inline with a reason.
          "no-restricted-imports": [
            "error",
            {
              paths: [
                {
                  name: "node:path",
                  message: 'Import path from "pathslash" instead (canonical forward-slash output).',
                },
                {
                  name: "path",
                  message: 'Import path from "pathslash" instead (canonical forward-slash output).',
                },
              ],
            },
          ],
        },
      },
      {
        // Forces relative imports of own-package files inside vinext to use
        // the tsconfig path alias (e.g. ../shims/X.js → vinext/shims/X).
        // Originally added for #1001 — bare specifiers keep
        // @vitejs/plugin-rsc's `packageSources` map populated, which avoids
        // the broken absolute-fs-path proxy fallback.
        files: ["packages/vinext/**"],
        rules: {
          "vinext-local/prefer-import-alias": "error",
        },
      },
    ],
  },
  test: {
    // GitHub Actions reporter adds inline failure annotations in PR diffs.
    // Agent reporter suppresses passing test noise when running inside AI agents.
    reporters: process.env.CI ? ["default", "github-actions"] : ["default", "agent"],

    // Shared env for all projects.
    env: {
      // Mirrors the Vite `define` in index.ts that inlines a build-time UUID.
      // Setting it here means tests exercise the same code path as production.
      __VINEXT_DRAFT_SECRET: randomUUID(),
    },

    // Coverage activated only via --coverage flag (or CLI/config override).
    // Istanbul provider is required because vinext source loads through Vite's
    // module runner (helpers.ts:15 imports from packages/vinext/src directly,
    // and integration tests start in-process Vite servers via createServer()).
    // V8 coverage misses code under that runner.
    coverage: {
      provider: "istanbul",
      include: ["packages/vinext/src/**/*.{ts,tsx}"],
      exclude: ["**/*.d.ts", "**/*.test.ts", "**/*.spec.ts"],
      reporter: ["text", "html", "json-summary", "lcov"],
      reportsDirectory: "coverage",
      clean: true,
      skipFull: true,
      // Always emit the report, even if some test files failed. A failing
      // integration test (e.g. timing-sensitive teardown) shouldn't suppress
      // coverage data we already collected.
      reportOnFailure: true,
    },

    projects: [
      {
        resolve: {
          alias: WORKSPACE_SRC_ALIAS,
        },
        test: {
          name: "unit",
          setupFiles: [MSW_SETUP],
          // `scripts/**` covers the release-tooling unit tests
          // (scripts/create-changeset.test.ts, scripts/version.test.ts), which
          // are pure-logic and have no fixture/server dependencies.
          include: ["tests/**/*.test.ts", "scripts/**/*.test.ts"],
          exclude: [
            "tests/fixtures/**/node_modules/**",
            // Integration tests: spin up Vite dev servers against shared fixture
            // dirs. Must run serially to avoid Vite deps optimizer cache races
            // (node_modules/.vite/*) that produce "outdated pre-bundle" 500s.
            // When adding a test that calls startFixtureServer() or createServer(),
            // move it here.
            "tests/app-router-client-preloading.test.ts",
            "tests/app-router-deployment-id.test.ts",
            "tests/app-router-dev-server.test.ts",
            "tests/app-router-external-rewrite.test.ts",
            "tests/app-router-font-google-prod.test.ts",
            "tests/app-router-isr-codegen.test.ts",
            "tests/app-router-malformed-url.test.ts",
            "tests/app-router-metadata-routes.test.ts",
            "tests/app-router-middleware-next-request.test.ts",
            "tests/app-router-next-config-codegen.test.ts",
            "tests/app-router-next-config-dev.test.ts",
            "tests/app-router-origin-check.test.ts",
            "tests/app-router-proxy-conventions.test.ts",
            "tests/app-router-production-build.test.ts",
            "tests/app-router-production-server.test.ts",
            "tests/app-router-rsc-flight-hint.test.ts",
            "tests/app-router-rsc-plugin.test.ts",
            "tests/app-router-static-export.test.ts",
            "tests/app-router-worker-entry.test.ts",
            "tests/api-handler.test.ts",
            "tests/cjs.test.ts",
            "tests/client-global-define.test.ts",
            "tests/ecosystem.test.ts",
            "tests/entry-templates.test.ts",
            "tests/features.test.ts",
            "tests/favicon-short-circuit.test.ts",
            "tests/image-optimization-parity.test.ts",
            "tests/node-modules-css.test.ts",
            "tests/pages-i18n-prod.test.ts",
            "tests/pages-router-concurrency.test.ts",
            "tests/pages-router.test.ts",
            "tests/postcss-resolve.test.ts",
            "tests/prerender.test.ts",
            "tests/static-export.test.ts",
            "tests/vite-hmr-websocket.test.ts",
            "tests/nextjs-compat/**/*.test.ts",
            // Flaky under parallelism due to 1 MiB buffer allocation pressure.
            "tests/kv-cache-handler.test.ts",
          ],
        },
      },
      {
        resolve: {
          alias: WORKSPACE_SRC_ALIAS,
        },
        test: {
          name: "integration",
          // MSW is intentionally NOT installed in the integration project.
          // Integration tests spin up in-process HTTP servers and fixture
          // dev servers and exercise them via `fetch("http://127.0.0.1:<port>/...")`.
          // The @mswjs/interceptors layer interferes with that loopback
          // traffic in subtle ways even when handlers `passthrough()`
          // (e.g. 5xx response bodies stall, fixture-startup readiness
          // probes time out). MSW's value here is mocking external HTTP
          // for unit tests of fetch wrappers — integration tests already
          // talk to real local servers, not to the network, so the
          // unhandled-request guard buys little. If a future integration
          // test needs to mock an external fetch, wire MSW per-file with
          // `setupServer` rather than reverting this exclusion.
          include: [
            "tests/app-router-client-preloading.test.ts",
            "tests/app-router-deployment-id.test.ts",
            "tests/app-router-dev-server.test.ts",
            "tests/app-router-external-rewrite.test.ts",
            "tests/app-router-font-google-prod.test.ts",
            "tests/app-router-isr-codegen.test.ts",
            "tests/app-router-malformed-url.test.ts",
            "tests/app-router-metadata-routes.test.ts",
            "tests/app-router-middleware-next-request.test.ts",
            "tests/app-router-next-config-codegen.test.ts",
            "tests/app-router-next-config-dev.test.ts",
            "tests/app-router-origin-check.test.ts",
            "tests/app-router-proxy-conventions.test.ts",
            "tests/app-router-production-build.test.ts",
            "tests/app-router-production-server.test.ts",
            "tests/app-router-rsc-flight-hint.test.ts",
            "tests/app-router-rsc-plugin.test.ts",
            "tests/app-router-static-export.test.ts",
            "tests/app-router-worker-entry.test.ts",
            "tests/api-handler.test.ts",
            "tests/cjs.test.ts",
            "tests/client-global-define.test.ts",
            "tests/ecosystem.test.ts",
            "tests/entry-templates.test.ts",
            "tests/favicon-short-circuit.test.ts",
            "tests/features.test.ts",
            "tests/image-optimization-parity.test.ts",
            "tests/kv-cache-handler.test.ts",
            "tests/node-modules-css.test.ts",
            "tests/pages-i18n-prod.test.ts",
            "tests/pages-router-concurrency.test.ts",
            "tests/pages-router.test.ts",
            "tests/postcss-resolve.test.ts",
            "tests/prerender.test.ts",
            "tests/static-export.test.ts",
            "tests/vite-hmr-websocket.test.ts",
            "tests/nextjs-compat/**/*.test.ts",
          ],
          testTimeout: 30000,
          // Serial execution prevents Vite deps optimizer cache races when
          // multiple test files share the same fixture directory.
          fileParallelism: false,
        },
      },
    ],
  },
});
