#!/usr/bin/env node

/// <reference types="node" />

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const includedExactInputPaths = [".github/workflows/perf.yml", "benchmarks/generate-app.mjs"];

const includedInputPrefixes = ["benchmarks/nextjs/", "benchmarks/perf/"];

const excludedInputPrefixes = ["benchmarks/nextjs/app/"];

const excludedPerfInputPaths = [
  "benchmarks/perf/README.md",
  "benchmarks/perf/format-pr-comment.mjs",
  "benchmarks/perf/upload-results.mjs",
  "benchmarks/perf/validate-results.mjs",
];

const excludedExactInputPaths = excludedPerfInputPaths;

const includedInputPredicate = [
  ...includedExactInputPaths.map((path) => `.path == ${JSON.stringify(path)}`),
  ...includedInputPrefixes.map((prefix) => `(.path | startswith(${JSON.stringify(prefix)}))`),
].join(" or ");

const excludedInputPredicate = [
  ...excludedInputPrefixes.map(
    (prefix) => `((.path | startswith(${JSON.stringify(prefix)})) | not)`,
  ),
  ...excludedExactInputPaths.map((path) => `.path != ${JSON.stringify(path)}`),
].join(" and ");

export const nextjsBenchmarkInputTreeJq =
  `{truncated, tree: [.tree[] | select(.type == "blob" and ` +
  `(${includedInputPredicate}) and ${excludedInputPredicate}) | {path, sha, type}]}`;

const excludedPerfFiles = new Set(excludedPerfInputPaths);

export type GitTreeEntry = {
  path: string;
  sha: string;
  type: string;
};

export function isNextjsBenchmarkInput(path: string) {
  if (includedExactInputPaths.includes(path)) return true;
  if (path.startsWith("benchmarks/nextjs/")) {
    return !path.startsWith("benchmarks/nextjs/app/");
  }
  return (
    path.startsWith("benchmarks/perf/") &&
    path !== "benchmarks/perf/README.md" &&
    !excludedPerfFiles.has(path)
  );
}

export function nextjsInputFingerprint(entries: GitTreeEntry[]) {
  const inputs = entries
    .filter((entry) => entry.type === "blob" && isNextjsBenchmarkInput(entry.path))
    .map((entry) => `${entry.path}\0${entry.sha}`)
    .sort();
  if (inputs.length === 0) throw new Error("No Next.js benchmark inputs found");
  return createHash("sha256").update(inputs.join("\n")).digest("hex");
}

export function localNextjsInputFingerprint(root: string) {
  const output = execFileSync(
    "git",
    ["ls-tree", "-r", "--full-tree", "--format=%(objectname)%x09%(objecttype)%x09%(path)", "HEAD"],
    { cwd: root, encoding: "utf8" },
  );
  return nextjsInputFingerprint(
    output
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [sha, type, path] = line.split("\t");
        if (!sha || !type || !path) throw new Error(`Invalid git tree entry: ${line}`);
        return { path, sha, type };
      }),
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(localNextjsInputFingerprint(resolve(process.argv[2] ?? ".")));
}
