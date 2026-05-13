#!/usr/bin/env node

/**
 * Generates a filtered deploy-tests manifest from the Next.js repo.
 *
 * Usage:
 *   node scripts/nextjs-deploy-manifest.mjs <nextjs-dir> <output-json-path> [--filter pages|app|all]
 *
 * Filters:
 *   pages  — exclude test/e2e/app-dir/** (Pages Router only)
 *   app    — include only test/e2e/app-dir/** (App Router only)
 *   all    — pass through the full manifest unfiltered (default)
 */

import fs from "node:fs/promises";
import path from "node:path";

function printUsage() {
  console.error(
    "Usage: node scripts/nextjs-deploy-manifest.mjs <nextjs-dir> <output-json-path> [--filter pages|app|all]",
  );
}

function isAppDirSuite(suite) {
  return suite.startsWith("test/e2e/app-dir/");
}

/**
 * Suites that live outside test/e2e/app-dir/ but exercise App Router
 * behavior. Excluded from the "pages" filter so they don't gate Pages
 * Router-only runs.
 */
const APP_ROUTER_NON_APP_DIR_SUITES = ["test/e2e/next-form/default/next-form-prefetch.test.ts"];

async function main() {
  const positionals = [];
  let filter = "all";

  // Simple arg parsing: positionals + optional --filter
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === "--filter" && i + 1 < process.argv.length) {
      filter = process.argv[++i];
    } else if (!arg.startsWith("-")) {
      positionals.push(arg);
    }
  }

  const [nextjsDirArg, outputPathArg] = positionals;

  if (!nextjsDirArg || !outputPathArg) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  if (!["pages", "app", "all"].includes(filter)) {
    console.error(`Invalid --filter value: ${filter}. Must be pages, app, or all.`);
    process.exitCode = 1;
    return;
  }

  const nextjsDir = path.resolve(nextjsDirArg);
  const outputPath = path.resolve(outputPathArg);
  const sourcePath = path.join(nextjsDir, "test", "deploy-tests-manifest.json");
  const source = JSON.parse(await fs.readFile(sourcePath, "utf8"));

  if (source.version !== 2) {
    throw new Error(`Expected Next.js deploy manifest version 2, got ${source.version}`);
  }

  let suites = source.suites ?? {};
  let extraExcludes = [];

  if (filter === "pages") {
    suites = Object.fromEntries(Object.entries(suites).filter(([suite]) => !isAppDirSuite(suite)));
    extraExcludes = ["test/e2e/app-dir/**/*", ...APP_ROUTER_NON_APP_DIR_SUITES];
  } else if (filter === "app") {
    suites = Object.fromEntries(Object.entries(suites).filter(([suite]) => isAppDirSuite(suite)));
  }

  const exclude = Array.from(new Set([...(source.rules?.exclude ?? []), ...extraExcludes]));

  const manifest = {
    version: 2,
    suites,
    rules: {
      include: source.rules?.include?.length
        ? source.rules.include
        : ["test/e2e/**/*.test.{t,j}s{,x}"],
      exclude,
    },
  };

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const totalSuites = Object.keys(source.suites ?? {}).length;
  const appDirSuites = Object.keys(source.suites ?? {}).filter(isAppDirSuite).length;
  const outputSuites = Object.keys(suites).length;

  console.log(`Wrote ${outputPath}`);
  console.log(
    JSON.stringify(
      {
        source: sourcePath,
        filter,
        totalSuites,
        outputSuites,
        appDirSuites,
        nonAppDirSuites: totalSuites - appDirSuites,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
