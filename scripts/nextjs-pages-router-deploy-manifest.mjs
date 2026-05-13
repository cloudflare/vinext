#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

function printUsage() {
  console.error(
    "Usage: node scripts/nextjs-pages-router-deploy-manifest.mjs <nextjs-dir> <output-json-path>",
  );
}

function isAppDirSuite(suite) {
  return suite.startsWith("test/e2e/app-dir/");
}

const APP_ROUTER_NON_APP_DIR_SUITES = [
  // This suite lives outside test/e2e/app-dir, but it explicitly exercises App
  // Router RSC form prefetching and should not gate this Pages Router PR.
  "test/e2e/next-form/default/next-form-prefetch.test.ts",
];

async function main() {
  const nextjsDirArg = process.argv[2];
  const outputPathArg = process.argv[3];

  if (!nextjsDirArg || !outputPathArg) {
    printUsage();
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

  const suites = Object.fromEntries(
    Object.entries(source.suites ?? {}).filter(([suite]) => !isAppDirSuite(suite)),
  );
  const exclude = Array.from(
    new Set([
      ...(source.rules?.exclude ?? []),
      "test/e2e/app-dir/**/*",
      ...APP_ROUTER_NON_APP_DIR_SUITES,
    ]),
  );
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

  console.log(`Wrote ${outputPath}`);
  console.log(
    JSON.stringify(
      {
        source: sourcePath,
        copiedSuites: Object.keys(suites).length,
        excludedAppDirSuites: Object.keys(source.suites ?? {}).filter(isAppDirSuite).length,
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
