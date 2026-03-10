import { randomUUID } from "node:crypto";
import { defineConfig } from "vitest/config";

export default defineConfig({
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
