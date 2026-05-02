import path from "node:path";
import { defineConfig } from "vite-plus";
import { randomUUID } from "node:crypto";

const SHIMS_SRC = path.resolve(import.meta.dirname, "packages/vinext/src/shims");

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
    ignorePatterns: ["tests/fixtures/ecosystem/**", "examples/**"],
  },
  lint: {
    ignorePatterns: [
      "fixtures/ecosystem/**",
      "tests/fixtures/**",
      "tests/fixtures/ecosystem/**",
      "examples/**",
    ],
    options: {
      typeAware: true,
      typeCheck: true,
      denyWarnings: true,
    },
    plugins: ["typescript", "unicorn", "import", "react"],
    jsPlugins: ["./oxlint-plugins/prefer-import-alias.js"],
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
    },
    overrides: [
      {
        files: ["**.spec.ts", "**.test.ts"],
        rules: {
          "@typescript-eslint/no-explicit-any": "off",
          "@typescript-eslint/no-unsafe-function-type": "off",
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

    projects: [
      {
        resolve: {
          alias: { "vinext/shims": SHIMS_SRC },
        },
        test: {
          name: "unit",
          include: ["tests/**/*.test.ts"],
          exclude: [
            "tests/fixtures/**/node_modules/**",
            // Integration tests: spin up Vite dev servers against shared fixture
            // dirs. Must run serially to avoid Vite deps optimizer cache races
            // (node_modules/.vite/*) that produce "outdated pre-bundle" 500s.
            // When adding a test that calls startFixtureServer() or createServer(),
            // move it here.
            "tests/app-router.test.ts",
            "tests/api-handler.test.ts",
            "tests/cjs.test.ts",
            "tests/ecosystem.test.ts",
            "tests/entry-templates.test.ts",
            "tests/features.test.ts",
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
          alias: { "vinext/shims": SHIMS_SRC },
        },
        test: {
          name: "integration",
          include: [
            "tests/app-router.test.ts",
            "tests/api-handler.test.ts",
            "tests/cjs.test.ts",
            "tests/ecosystem.test.ts",
            "tests/entry-templates.test.ts",
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
