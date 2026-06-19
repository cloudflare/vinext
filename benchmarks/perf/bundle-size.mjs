#!/usr/bin/env node

import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { reportPerformanceSample } from "./report-sample.mjs";

const repositoryRoot = process.env.VINEXT_PERF_TARGET_ROOT ?? process.cwd();
const benchmarkDir = join(repositoryRoot, "benchmarks");
const framework = process.argv[2];
const target = process.argv[3] ?? "client";

if (framework !== "vinext" && framework !== "nextjs") {
  console.error(
    "Usage: node benchmarks/perf/bundle-size.mjs <vinext|nextjs> [client|client-entry|rsc-entry|server]",
  );
  process.exit(1);
}

if (!["client", "client-entry", "rsc-entry", "server"].includes(target)) {
  throw new Error(`Unknown bundle target: ${target}`);
}
if (framework === "nextjs" && target !== "client") {
  throw new Error(`Bundle target ${target} is only defined for vinext`);
}

const outputPath =
  framework === "nextjs"
    ? join(benchmarkDir, "nextjs", ".next", "static")
    : target === "client" || target === "client-entry"
      ? join(benchmarkDir, "vinext", "dist", "client")
      : target === "rsc-entry"
        ? join(benchmarkDir, "vinext", "dist", "server", "index.js")
        : join(benchmarkDir, "vinext", "dist", "server");

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

async function gzipClientEntryClosure(clientOutputPath) {
  const manifestPath = join(clientOutputPath, ".vite", "manifest.json");
  const resolvedClientOutputPath = await realpath(clientOutputPath);
  const manifestOutput = await lstat(manifestPath);
  if (!manifestOutput.isFile() || manifestOutput.isSymbolicLink()) {
    throw new Error(`Client manifest must be a regular file: ${manifestPath}`);
  }
  const resolvedManifestPath = await realpath(manifestPath);
  const manifestRelativePath = relative(resolvedClientOutputPath, resolvedManifestPath);
  if (manifestRelativePath.startsWith("..") || isAbsolute(manifestRelativePath)) {
    throw new Error(`Client manifest escapes the output directory: ${manifestPath}`);
  }
  const manifest = JSON.parse(await readFile(resolvedManifestPath, "utf8"));
  const entryKeys = Object.keys(manifest).filter((key) => manifest[key]?.isEntry === true);
  if (entryKeys.length !== 1) {
    throw new Error(`Expected one client entry in ${manifestPath}, found ${entryKeys.length}`);
  }

  let gzipBytes = 0;
  const visited = new Set();

  async function visit(key) {
    if (visited.has(key)) return;
    visited.add(key);

    const chunk = manifest[key];
    if (!chunk || typeof chunk.file !== "string") {
      throw new Error(`Client manifest entry ${JSON.stringify(key)} has no output file`);
    }

    const filePath = resolve(clientOutputPath, chunk.file);
    const relativePath = relative(clientOutputPath, filePath);
    if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
      throw new Error(`Client manifest file escapes the output directory: ${chunk.file}`);
    }
    const output = await lstat(filePath);
    if (!output.isFile() || output.isSymbolicLink()) {
      throw new Error(`Client entry output must be a regular file: ${filePath}`);
    }
    const resolvedFilePath = await realpath(filePath);
    const resolvedRelativePath = relative(resolvedClientOutputPath, resolvedFilePath);
    if (resolvedRelativePath.startsWith("..") || isAbsolute(resolvedRelativePath)) {
      throw new Error(`Client entry output escapes the output directory: ${chunk.file}`);
    }
    gzipBytes += gzipSync(await readFile(resolvedFilePath)).length;

    for (const importedKey of chunk.imports ?? []) {
      await visit(importedKey);
    }
  }

  await visit(entryKeys[0]);
  return { gzipBytes, fileCount: visited.size };
}

async function main() {
  const output = await lstat(outputPath).catch(() => null);
  if (output?.isSymbolicLink()) {
    throw new Error(`Bundle output may not be a symlink: ${outputPath}`);
  }
  const expectedType = target === "rsc-entry" ? "file" : "directory";
  if (
    !output ||
    (expectedType === "file" && !output.isFile()) ||
    (expectedType === "directory" && !output.isDirectory())
  ) {
    throw new Error(
      `Build output not found at ${outputPath}; run the production build scenario first`,
    );
  }
  const resolvedRoot = await realpath(repositoryRoot);
  const resolvedOutput = await realpath(outputPath);
  const outputRelativePath = relative(resolvedRoot, resolvedOutput);
  if (outputRelativePath.startsWith("..") || isAbsolute(outputRelativePath)) {
    throw new Error(`Bundle output escapes the benchmark checkout: ${outputPath}`);
  }

  const { gzipBytes, fileCount } =
    target === "rsc-entry"
      ? { gzipBytes: gzipSync(await readFile(outputPath)).length, fileCount: 1 }
      : target === "client-entry"
        ? await gzipClientEntryClosure(outputPath)
        : await gzipBundleSize(outputPath);
  if (fileCount === 0) throw new Error(`No JavaScript or CSS found in ${outputPath}`);
  await reportPerformanceSample(gzipBytes);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});
