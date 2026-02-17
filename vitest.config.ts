import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 30000,
    // Multiple suites spin up Vite dev servers against the same fixture dirs.
    // Running test files in parallel can race on Vite's deps optimizer cache
    // (node_modules/.vite/*) and produce "outdated pre-bundle" 500s.
    fileParallelism: false,
  },
});
