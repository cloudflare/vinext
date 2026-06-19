#!/usr/bin/env node

import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { gzipSync } from "node:zlib";
import { reportPerformanceSample } from "./report-sample.mjs";

const repositoryRoot = process.env.VINEXT_PERF_TARGET_ROOT ?? process.cwd();
const benchmarkDir = join(repositoryRoot, "benchmarks");
const framework = process.argv[2];

if (framework !== "vinext" && framework !== "nextjs") {
  console.error("Usage: node benchmarks/perf/bundle-size.mjs <vinext|nextjs>");
  process.exit(1);
}

const outputDirectory =
  framework === "vinext"
    ? join(benchmarkDir, "vinext", "dist", "client")
    : join(benchmarkDir, "nextjs", ".next", "static");

async function gzipBundleSize(directory) {
  let gzipBytes = 0;
  let fileCount = 0;

  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Bundle output may not contain symlinks: ${path}`);
    if (entry.isDirectory()) {
      const nested = await gzipBundleSize(path);
      gzipBytes += nested.gzipBytes;
      fileCount += nested.fileCount;
    } else if (/\.(?:js|css|mjs)$/.test(entry.name)) {
      const file = await readFile(path);
      gzipBytes += gzipSync(file).length;
      fileCount += 1;
    }
  }

  return { gzipBytes, fileCount };
}

async function main() {
  const output = await lstat(outputDirectory).catch(() => null);
  if (output?.isSymbolicLink()) {
    throw new Error(`Bundle output may not be a symlink: ${outputDirectory}`);
  }
  if (!output?.isDirectory()) {
    throw new Error(
      `Build output not found at ${outputDirectory}; run the production build scenario first`,
    );
  }
  const resolvedRoot = await realpath(repositoryRoot);
  const resolvedOutput = await realpath(outputDirectory);
  const outputRelativePath = relative(resolvedRoot, resolvedOutput);
  if (outputRelativePath.startsWith("..") || isAbsolute(outputRelativePath)) {
    throw new Error(`Bundle output escapes the benchmark checkout: ${outputDirectory}`);
  }

  const { gzipBytes, fileCount } = await gzipBundleSize(outputDirectory);
  if (fileCount === 0) throw new Error(`No client JavaScript or CSS found in ${outputDirectory}`);
  await reportPerformanceSample(gzipBytes);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});
