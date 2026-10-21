import path from "node:path";
import { defineConfig } from "@playwright/test";

// An isolated production-server investigation for #3544. This deliberately
// exercises Node ISR first; it does not claim to emulate Workers Cache.
export default defineConfig({
  testDir: import.meta.dirname,
  testMatch: "tenant-cache.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  use: { baseURL: "http://127.0.0.1:4221" },
  webServer: {
    command:
      "(test -e node_modules || test -L node_modules || ln -s ../../../fixtures/app-basic/node_modules node_modules) && node ../../../../packages/vinext/dist/cli.js build && node ../../../../packages/vinext/dist/cli.js start --hostname 127.0.0.1 --port 4221",
    cwd: path.join(import.meta.dirname, "fixture"),
    env: { NODE_ENV: "production" },
    url: "http://127.0.0.1:4221",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
