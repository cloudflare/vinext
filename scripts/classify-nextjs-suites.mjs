#!/usr/bin/env node

/**
 * Classifies Next.js e2e test files by which router(s) their fixture exercises.
 *
 * Usage (CLI):
 *   node scripts/classify-nextjs-suites.mjs <nextjs-dir> <suites-input> <output-json>
 *
 *   <suites-input> is either:
 *     - A JSON file containing an array of suite paths
 *     - A path to a compat-ingest payload (object with a `files` array of
 *       { suite, ... }); the script will read suite paths from there
 *
 * Usage (programmatic):
 *   import { classifySuites } from "./classify-nextjs-suites.mjs";
 *   const map = await classifySuites(nextjsDir, ["test/e2e/middleware-basic/middleware-basic.test.ts"]);
 *   // → Map { "test/e2e/middleware-basic/middleware-basic.test.ts" => "pages", ... }
 *
 * Classification rules (in priority order):
 *
 *   1. Override file (scripts/nextjs-suite-overrides.json) — explicit
 *      hand-curated routing for suites the heuristic gets wrong.
 *
 *   2. Walk the fixture directory (the directory containing the .test.ts file)
 *      up to a bounded depth, looking for `app/` and `pages/` subdirectories.
 *      A directory only "counts" if it contains a real route file:
 *        - app/ counts if it contains page.{js,jsx,ts,tsx}, route.{js,ts}, or
 *          layout.{js,jsx,ts,tsx} (anywhere under it)
 *        - pages/ counts if it contains any .{js,jsx,ts,tsx} file at depth ≤ 2
 *          that isn't a Pages-Router special file (_app, _document, _error)
 *          or an API stub
 *
 *      → has-app + has-pages → "both"
 *      → has-app only        → "app"
 *      → has-pages only      → "pages"
 *      → neither             → "unknown"
 *
 *   3. Cross-reference APP_ROUTER_NON_APP_DIR_SUITES (mirrored from
 *      nextjs-deploy-manifest.mjs) so curated App Router suites that don't
 *      live under test/e2e/app-dir/ get "app" even if the heuristic says
 *      "unknown" or "pages".
 *
 * Why we don't just use the path prefix:
 *   The path-prefix rule (test/e2e/app-dir/ = app router) is mostly right,
 *   but ~50 suites under app-dir/ have BOTH an app/ and a pages/ directory
 *   to exercise interop. Some of those are true parity tests; others have
 *   a stub pages/ that's incidental. The "has real routes" check on each
 *   side correctly distinguishes the two cases.
 *
 * Bounded-depth walk:
 *   Some fixtures nest their app under fixtures/<name>/{app,pages} or
 *   apps/<name>/{app,pages}. We walk up to depth 4 from the fixture root
 *   (which is the directory containing the .test.ts file), which is enough
 *   to find any standard layout. We skip node_modules and .next.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const OVERRIDES_PATH = path.join(__dirname, "nextjs-suite-overrides.json");

/**
 * Suites that live outside test/e2e/app-dir/ but exercise App Router
 * behaviour. Mirrored from nextjs-deploy-manifest.mjs so the two scripts
 * stay in sync — keep them identical.
 */
const APP_ROUTER_NON_APP_DIR_SUITES = new Set([
  "test/e2e/next-form/default/next-form-prefetch.test.ts",
]);

const MAX_WALK_DEPTH = 4;
const SKIP_DIRS = new Set(["node_modules", ".next", ".turbo", "dist", "build"]);

const ROUTE_EXTS = new Set([".js", ".jsx", ".ts", ".tsx"]);

/**
 * Pages-Router files that don't count as "real routes" for classification:
 * they exist as plumbing in many fixtures even when the fixture isn't
 * primarily testing the Pages Router. Mostly the framework specials.
 */
const PAGES_NON_ROUTE_BASENAMES = new Set([
  "_app",
  "_document",
  "_error",
  "_app.page",
  "_document.page",
]);

/**
 * App Router special filenames that count as "this is a real route".
 */
const APP_ROUTE_BASENAMES = new Set([
  "page",
  "route",
  "layout",
  "default", // parallel-routes default
]);

function hasExt(name) {
  const ext = path.extname(name);
  return ROUTE_EXTS.has(ext);
}

/**
 * Like path.basename(name, path.extname(name)) but strips a second optional
 * extension segment for the Next.js `pageExtensions` config pattern, where
 * files are named e.g. `page.page.tsx` to opt into a custom extension.
 *
 *   layout.tsx       → "layout"
 *   layout.page.tsx  → "layout"
 *   page.page.js     → "page"
 *   index.tsx        → "index"
 *   blog.page.tsx    → "blog"
 */
function basenameNoExt(name) {
  let base = path.basename(name, path.extname(name));
  // Strip a second `.page` / `.api` style segment if present. This is the
  // pageExtensions convention. We only strip well-known suffixes so we
  // don't accidentally collapse e.g. `app.config.tsx` → `app`.
  const PAGE_EXT_SUFFIXES = [".page", ".route", ".api"];
  for (const suffix of PAGE_EXT_SUFFIXES) {
    if (base.endsWith(suffix) && base.length > suffix.length) {
      base = base.slice(0, -suffix.length);
      break;
    }
  }
  return base;
}

/**
 * Does the directory at `dir` contain any "real" App Router route file
 * (page / route / layout / default) anywhere under it? Bounded by depth
 * to avoid scanning enormous trees.
 */
function appDirHasRealRoute(dir, maxDepth = 5) {
  const stack = [{ dir, depth: 0 }];
  while (stack.length) {
    const { dir: cur, depth } = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        if (depth + 1 <= maxDepth) {
          stack.push({ dir: path.join(cur, e.name), depth: depth + 1 });
        }
      } else if (e.isFile() && hasExt(e.name)) {
        if (APP_ROUTE_BASENAMES.has(basenameNoExt(e.name))) return true;
      }
    }
  }
  return false;
}

/**
 * Does the directory at `dir` contain any "real" Pages Router route file?
 * We accept any .js/.jsx/.ts/.tsx file directly under pages/ (excluding the
 * framework specials), or one level deep (e.g. pages/blog/[slug].tsx), or
 * two levels deep. Files under pages/api/ count too — they're real routes.
 */
function pagesDirHasRealRoute(dir, maxDepth = 3) {
  const stack = [{ dir, depth: 0 }];
  while (stack.length) {
    const { dir: cur, depth } = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        if (depth + 1 <= maxDepth) {
          stack.push({ dir: path.join(cur, e.name), depth: depth + 1 });
        }
      } else if (e.isFile() && hasExt(e.name)) {
        const base = basenameNoExt(e.name);
        // Hidden / underscore-prefixed Pages Router specials don't count
        // (except api/_middleware which doesn't exist in modern Next anyway).
        if (PAGES_NON_ROUTE_BASENAMES.has(base)) continue;
        // A bare file at the root of pages/ is always a real route (e.g.
        // pages/index.tsx). Nested files also count (e.g. pages/blog/post.tsx).
        return true;
      }
    }
  }
  return false;
}

/**
 * Some Next.js fixtures wrap their test app inside a directory that is
 * literally named `app`, like:
 *
 *   test/e2e/og-api/
 *     index.test.ts
 *     app/                  ← test-app wrapper (NOT App Router)
 *       next.config.js
 *       middleware.js
 *       app/                ← actual App Router root
 *         og/route.js
 *       pages/              ← Pages Router fixture
 *         index.js
 *
 * The .test.ts uses `nextTestSetup({ files: __dirname + '/app' })`, so the
 * outer `app/` is the Next.js project root, not an App Router directory.
 * Distinguishing it from a real App Router app dir matters: if we treat
 * the wrapper as App Router we never descend into it and miss both the
 * inner `app/` and the sibling `pages/`.
 *
 * Heuristic: a directory named `app` is the Next.js project root (i.e. a
 * wrapper) if it contains a top-level `next.config.{js,ts,mjs,cjs}`. Real
 * App Router app directories don't ship a next.config alongside their
 * route files.
 */
const NEXT_CONFIG_NAMES = new Set([
  "next.config.js",
  "next.config.ts",
  "next.config.mjs",
  "next.config.cjs",
]);

/**
 * Detect whether a directory named `app/` (or `pages/`) is actually a
 * Next.js project-root wrapper rather than a real router directory.
 *
 * Two wrapper signals, either of which is sufficient:
 *
 *   1. Contains a top-level `next.config.{js,ts,mjs,cjs}` file. App Router
 *      app dirs never ship their own next.config.
 *
 *   2. Contains BOTH an inner `app/` AND an inner `pages/` directory.
 *      App Router app dirs don't have recursive `app` children, and even
 *      though `pages` is a legal App Router route group name, it never
 *      coexists with a sibling route group named `app`.
 *
 * We deliberately do NOT treat a top-level `middleware.{js,ts}` as a
 * wrapper signal: Next.js tests put noop `middleware.js` files inside
 * real App Router app dirs to assert the file is ignored there.
 */
const FIXTURE_WRAPPER_MARKERS = new Set(NEXT_CONFIG_NAMES);

function looksLikeFixtureWrapper(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  let hasInnerApp = false;
  let hasInnerPages = false;
  for (const e of entries) {
    if (e.isFile() && FIXTURE_WRAPPER_MARKERS.has(e.name)) return true;
    if (e.isDirectory()) {
      if (e.name === "app") hasInnerApp = true;
      else if (e.name === "pages") hasInnerPages = true;
    }
  }
  if (hasInnerApp && hasInnerPages) return true;
  return false;
}

/**
 * Walk the fixture root and find every directory named `app` or `pages`
 * within MAX_WALK_DEPTH. For each one, check whether it has real routes.
 *
 * Returns { hasApp: boolean, hasPages: boolean }.
 */
function scanFixture(fixtureRoot) {
  let hasApp = false;
  let hasPages = false;

  const stack = [{ dir: fixtureRoot, depth: 0 }];
  while (stack.length) {
    const { dir, depth } = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (SKIP_DIRS.has(e.name)) continue;

      const childPath = path.join(dir, e.name);

      // When we encounter a directory named `app` or `pages`:
      //   1. If it looks like a fixture wrapper (contains next.config.*),
      //      it's NOT a Next.js router directory — it's the test app's
      //      project root. Recurse into it to find the real router
      //      directories inside.
      //   2. Otherwise, hand it to the dedicated route-checker.
      //      - If the route checker finds real routes, mark the flag
      //        and skip descending. The route checker already covered
      //        the subtree, and re-walking would risk a false positive
      //        (an App Router route group named `pages` would trip the
      //        Pages detector).
      //      - If the route checker finds nothing, the directory is
      //        named `app`/`pages` but has neither routes nor a wrapper
      //        signature. Recurse anyway, on the off chance routes are
      //        somewhere deeper.
      if (e.name === "app" || e.name === "pages") {
        if (looksLikeFixtureWrapper(childPath)) {
          // Wrapper: descend to find the real app/pages inside.
          if (depth + 1 <= MAX_WALK_DEPTH) {
            stack.push({ dir: childPath, depth: depth + 1 });
          }
          continue;
        }
        if (e.name === "app") {
          if (!hasApp && appDirHasRealRoute(childPath)) {
            hasApp = true;
            // `hasApp` is now true; short-circuit if pages was already set
            if (hasPages) return { hasApp, hasPages };
            continue; // covered by the route checker
          }
        } else {
          if (!hasPages && pagesDirHasRealRoute(childPath)) {
            hasPages = true;
            if (hasApp) return { hasApp, hasPages };
            continue;
          }
        }
      }

      if (depth + 1 <= MAX_WALK_DEPTH) {
        stack.push({ dir: childPath, depth: depth + 1 });
      }
    }
  }

  return { hasApp, hasPages };
}

/**
 * Classify a single suite. `nextjsDir` is the absolute path to the Next.js
 * checkout root (so that `suite = "test/e2e/foo/foo.test.ts"` resolves to
 * `<nextjsDir>/test/e2e/foo/foo.test.ts`).
 *
 * Returns "app" | "pages" | "both" | "unknown".
 */
export function classifySuite(nextjsDir, suite, overrides = {}) {
  if (overrides[suite]) return overrides[suite];

  const testFilePath = path.join(nextjsDir, suite);
  // Fixture root is the directory containing the .test.ts file. If the
  // suite path doesn't resolve to an existing file, fall back to its
  // parent directory anyway — we'll just get "unknown" if nothing's there.
  let fixtureRoot = path.dirname(testFilePath);
  // Many Next.js fixtures live one level above their .test.ts file, e.g.
  //   test/e2e/middleware-base-path/test/index.test.ts  ← test file
  //   test/e2e/middleware-base-path/{app,pages}/        ← fixture
  // When the immediate parent is literally named `test`, prefer the
  // grandparent as the fixture root.
  if (path.basename(fixtureRoot) === "test") {
    const parent = path.dirname(fixtureRoot);
    // Guard: never walk above the Next.js test/e2e/ root.
    if (parent.startsWith(path.join(nextjsDir, "test", "e2e"))) {
      fixtureRoot = parent;
    }
  }

  let stat;
  try {
    stat = fs.statSync(fixtureRoot);
  } catch {
    // Directory doesn't exist (e.g. Next.js checkout doesn't have this test
    // anymore). Fall back to the curated list, then "unknown".
    if (APP_ROUTER_NON_APP_DIR_SUITES.has(suite)) return "app";
    return "unknown";
  }
  if (!stat.isDirectory()) {
    if (APP_ROUTER_NON_APP_DIR_SUITES.has(suite)) return "app";
    return "unknown";
  }

  const { hasApp, hasPages } = scanFixture(fixtureRoot);

  if (hasApp && hasPages) return "both";
  if (hasApp) return "app";
  if (hasPages) return "pages";

  // Curated override for App Router suites whose fixture happens to look
  // empty to the heuristic (e.g. the .test.ts loads pages programmatically).
  if (APP_ROUTER_NON_APP_DIR_SUITES.has(suite)) return "app";

  // Fallback: suites under test/e2e/app-dir/ that have no on-disk fixture
  // (the test builds its files inline via nextTestSetup({ files: { ... } }))
  // are still App Router tests by convention. Without this fallback we'd
  // misclassify ~2-5 suites per release as "unknown". Note we DO NOT apply
  // the inverse rule to Pages Router — there's no equivalent path
  // convention and suites outside app-dir/ legitimately may not exercise
  // any router (build-only, config-only, etc.).
  if (suite.startsWith("test/e2e/app-dir/")) return "app";

  return "unknown";
}

export async function loadOverrides() {
  try {
    const raw = await fsp.readFile(OVERRIDES_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    // Missing or unreadable overrides file: ignore.
  }
  return {};
}

/**
 * Classify many suites. Returns a Map from suite path → router kind.
 */
export async function classifySuites(nextjsDir, suites) {
  const overrides = await loadOverrides();
  const out = new Map();
  for (const suite of suites) {
    out.set(suite, classifySuite(nextjsDir, suite, overrides));
  }
  return out;
}

function printUsage() {
  console.error(
    "Usage: node scripts/classify-nextjs-suites.mjs <nextjs-dir> <suites-input> <output-json>",
  );
  console.error(
    "       <suites-input> is either a JSON array of suite paths or a compat-ingest payload",
  );
}

async function main() {
  const [, , nextjsDirArg, suitesInputArg, outputArg] = process.argv;
  if (!nextjsDirArg || !suitesInputArg || !outputArg) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  const nextjsDir = path.resolve(nextjsDirArg);
  const suitesInputPath = path.resolve(suitesInputArg);
  const outputPath = path.resolve(outputArg);

  const raw = await fsp.readFile(suitesInputPath, "utf8");
  const parsed = JSON.parse(raw);

  let suites;
  if (Array.isArray(parsed)) {
    suites = parsed;
  } else if (parsed && Array.isArray(parsed.files)) {
    suites = parsed.files.map((f) => f.suite).filter((s) => typeof s === "string");
  } else {
    console.error("Input must be a JSON array of suites or an object with a `files` array.");
    process.exitCode = 1;
    return;
  }

  const map = await classifySuites(nextjsDir, suites);

  const result = Object.fromEntries(map);

  const counts = { app: 0, pages: 0, both: 0, unknown: 0 };
  for (const r of map.values()) counts[r]++;

  await fsp.mkdir(path.dirname(outputPath), { recursive: true });
  await fsp.writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);

  console.log(`Wrote ${outputPath}`);
  console.log(JSON.stringify({ totalSuites: suites.length, counts }, null, 2));
}

// Only run as CLI when invoked directly (not when imported).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}
