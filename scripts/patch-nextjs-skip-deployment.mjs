#!/usr/bin/env node

/**
 * Let a Next.js checkout run the e2e suites that opt out of deploy mode.
 *
 * Usage:
 *   node scripts/patch-nextjs-skip-deployment.mjs <nextjs-dir>
 *
 * A suite that calls `nextTestSetup({ skipDeployment: true })` registers a
 * single "should skip next deploy" test in deploy mode, so none of its real
 * tests run against vinext. Many of these suites exercise runtime behaviour
 * (for example the `"use cache"` and Cache Components suites) and only skip
 * deploy mode because Vercel deployments can't run them.
 *
 * After this patch, `VINEXT_RUN_SKIPPED_DEPLOYMENT_TESTS=1` runs those suites'
 * real tests in deploy mode. Without it the harness behaves as upstream. Safe
 * to run more than once.
 */

import fs from "node:fs";
import path from "node:path";

const nextjsDir = process.argv[2];
if (!nextjsDir) {
  console.error("Usage: node scripts/patch-nextjs-skip-deployment.mjs <nextjs-dir>");
  process.exit(1);
}

const file = path.join(nextjsDir, "test/lib/e2e-utils/index.ts");
const FROM = "if (options.skipDeployment) {";
const TO =
  "if (options.skipDeployment && process.env.VINEXT_RUN_SKIPPED_DEPLOYMENT_TESTS !== '1') {";

const source = fs.readFileSync(file, "utf8");
if (source.includes(TO)) process.exit(0);
if (!source.includes(FROM)) {
  console.error(`[patch-nextjs-skip-deployment] ${file} has no \`${FROM}\` to patch`);
  process.exit(1);
}
fs.writeFileSync(file, source.replace(FROM, TO));
console.log("[patch-nextjs-skip-deployment] patched test/lib/e2e-utils/index.ts");
