import { defineConfig } from "vite-plus";
import { randomUUID } from "node:crypto";

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
    ignorePatterns: ["fixtures/ecosystem/**", "tests/fixtures/ecosystem/**", "examples/**"],
    // TODO: Enable typeAware and typeCheck later
    // options: {
    //   typeAware: true,
    //   typeCheck: true,
    // },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 30000,
    env: {
      // Mirrors the Vite `define` in index.ts that inlines a build-time UUID.
      // Setting it here means tests exercise the same code path as production.
      __VINEXT_DRAFT_SECRET: randomUUID(),
    },
    // Multiple suites spin up Vite dev servers against the same fixture dirs.
    // Running test files in parallel can race on Vite's deps optimizer cache
    // (node_modules/.vite/*) and produce "outdated pre-bundle" 500s.
    fileParallelism: false,
    // GitHub Actions reporter adds inline failure annotations in PR diffs.
    // It's auto-enabled with the default reporter, but being explicit ensures
    // it survives any future reporter config changes.
    reporters: process.env.CI ? ["default", "github-actions"] : ["default"],
  },
});
