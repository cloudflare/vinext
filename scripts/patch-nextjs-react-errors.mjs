#!/usr/bin/env node

/**
 * Update a Next.js checkout's production Server Components error assertions
 * for React 19.3.
 *
 * Usage:
 *   node scripts/patch-nextjs-react-errors.mjs <nextjs-dir> <vinext-dir>
 *
 * React 19.3's production Flight client reports a Server Components error as
 * minified error #441 instead of the full "An error occurred in the Server
 * Components render…" text. Next.js updated its tests for this when it moved
 * to React 19.3 (vercel/next.js#92945), but the pinned Next.js version
 * predates that change. This ports the browser-facing assertion updates from
 * that commit. Checks against server logs keep the full text, as upstream.
 *
 * Only applied when the React installed in <vinext-dir> (the React the deploy
 * fixtures are pinned to) is 19.3 or newer, so backfills of older vinext
 * commits keep the original expectations. Safe to run more than once.
 */

import fs from "node:fs";
import path from "node:path";

const GENERIC_MESSAGE =
  "An error occurred in the Server Components render. The specific message is omitted in production builds to avoid leaking sensitive details. A digest property is included on this error instance which may provide additional details about the nature of the error.";
const MINIFIED_MESSAGE =
  "Minified React error #441; visit https://react.dev/errors/441 for the full message or use the non-minified dev environment for full errors and additional helpful warnings.";

// The full message is replaced wherever it appears in these files, keeping any
// prefix inside the string literal (e.g. "Global error: ").
const FULL_MESSAGE_FILES = [
  "test/e2e/app-dir/actions/app-action.test.ts",
  "test/e2e/app-dir/catch-error/catch-error-react-compiler.test.ts",
  "test/e2e/app-dir/catch-error/catch-error.test.ts",
  "test/e2e/app-dir/errors/index.test.ts",
  "test/e2e/app-dir/global-error/basic/index.test.ts",
  "test/e2e/app-dir/global-error/layout-error/index.test.ts",
  "test/e2e/app-dir/taint/process-taint.test.ts",
  "test/e2e/app-dir/use-cache/use-cache.test.ts",
];

// Partial matches that upstream rewrote individually. Other partial matches
// (such as the server log checks in errors/index.test.ts) stay unchanged.
const PARTIAL_REPLACEMENTS = [
  {
    file: "test/e2e/app-dir/actions-allowed-origins/app-action-disallowed-origins.test.ts",
    from: "t.includes('An error occurred in the Server Components render.')",
    to: "t.includes('https://react.dev/errors/441')",
  },
  {
    file: "test/e2e/app-dir/segment-cache/prefetch-runtime/prefetch-runtime.test.ts",
    from: "'Error boundary: An error occurred in the Server Components render'",
    to: "'Error boundary: Minified React error #441;'",
  },
  {
    // The same message, split across a string concatenation.
    file: "test/e2e/app-dir/errors/index.test.ts",
    from: /'An error occurred in the Server Components render\. ' \+\s*'The specific message is omitted in production builds to avoid leaking sensitive details\. ' \+\s*'A digest property is included on this error instance which may provide additional details about the nature of the error\.'/,
    to: `'${MINIFIED_MESSAGE}'`,
  },
];

function installedReactVersion(vinextDir) {
  for (const parent of [path.join(vinextDir, "packages", "vinext"), vinextDir]) {
    const manifestPath = path.join(parent, "node_modules", "react", "package.json");
    if (fs.existsSync(manifestPath)) {
      return JSON.parse(fs.readFileSync(manifestPath, "utf8")).version;
    }
  }
  throw new Error(`Unable to find installed react under ${vinextDir}`);
}

function isReact193OrNewer(version) {
  const [major, minor] = version.split(".").map(Number);
  return major > 19 || (major === 19 && minor >= 3);
}

const [nextjsDir, vinextDir] = process.argv.slice(2);
if (!nextjsDir || !vinextDir) {
  console.error("Usage: node scripts/patch-nextjs-react-errors.mjs <nextjs-dir> <vinext-dir>");
  process.exit(1);
}

const reactVersion = installedReactVersion(vinextDir);
if (!isReact193OrNewer(reactVersion)) {
  console.log(`React ${reactVersion} predates minified error #441; leaving Next.js tests as is`);
  process.exit(0);
}

const edits = new Map();
function edit(file, transform) {
  const filePath = path.join(nextjsDir, file);
  if (!edits.has(file)) {
    if (!fs.existsSync(filePath)) {
      console.log(`Skipping ${file}: not in this Next.js checkout`);
      return;
    }
    edits.set(file, fs.readFileSync(filePath, "utf8"));
  }
  edits.set(file, transform(edits.get(file)));
}

for (const file of FULL_MESSAGE_FILES) {
  edit(file, (source) => source.replaceAll(GENERIC_MESSAGE, MINIFIED_MESSAGE));
}
for (const { file, from, to } of PARTIAL_REPLACEMENTS) {
  edit(file, (source) => source.replace(from, to));
}

for (const [file, source] of edits) {
  const filePath = path.join(nextjsDir, file);
  if (source === fs.readFileSync(filePath, "utf8")) continue;
  fs.writeFileSync(filePath, source);
  console.log(`Updated ${file} for React ${reactVersion}'s minified error #441`);
}
