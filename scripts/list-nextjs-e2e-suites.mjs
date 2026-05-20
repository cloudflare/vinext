#!/usr/bin/env node

/**
 * Enumerate every Next.js e2e test file under `<nextjs-dir>/test/e2e/` and
 * write the relative paths to `<output-json>` as a JSON array.
 *
 * Usage:
 *   node scripts/list-nextjs-e2e-suites.mjs <nextjs-dir> <output-json>
 *
 * Example output entry: "test/e2e/app-dir/foo/foo.test.ts"
 *
 * Used by the nextjs-deploy-suite GitHub Actions workflow to produce the
 * input for `classify-nextjs-suites.mjs`. Kept as a separate script (vs.
 * inline `node -e "..."` in YAML) so its regex and shell escaping aren't
 * sensitive to workflow-file quoting rules.
 */

import fs from "node:fs/promises";
import fssync from "node:fs";
import path from "node:path";

const TEST_FILE_RE = /\.test\.(t|j)sx?$/;
const SKIP_DIRS = new Set(["node_modules", ".next", ".turbo"]);

function walk(dir, root, out) {
  let entries;
  try {
    entries = fssync.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), root, out);
    } else if (entry.isFile() && TEST_FILE_RE.test(entry.name)) {
      out.push(path.relative(root, path.join(dir, entry.name)));
    }
  }
}

async function main() {
  const [, , nextjsDirArg, outputArg] = process.argv;
  if (!nextjsDirArg || !outputArg) {
    console.error("Usage: node scripts/list-nextjs-e2e-suites.mjs <nextjs-dir> <output-json>");
    process.exitCode = 1;
    return;
  }

  const root = path.resolve(nextjsDirArg);
  const outputPath = path.resolve(outputArg);
  const e2eRoot = path.join(root, "test", "e2e");

  const out = [];
  walk(e2eRoot, root, out);
  // Stable alphabetical order; the default is lexicographic, which is what
  // we want for path-like strings (`localeCompare` would group differently
  // around punctuation).
  out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(out)}\n`);
  console.log(`Enumerated ${out.length} e2e test files → ${outputPath}`);
}

// Only run as CLI when invoked directly (not when imported). Same guard
// as scripts/classify-nextjs-suites.mjs — keeps the module safe to import
// from tests or other tooling without surprise process.argv parsing.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}
