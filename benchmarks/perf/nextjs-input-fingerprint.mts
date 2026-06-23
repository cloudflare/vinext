#!/usr/bin/env node

/// <reference types="node" />

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const excludedPerfFiles = new Set([
  "benchmarks/perf/format-pr-comment.mjs",
  "benchmarks/perf/upload-results.mjs",
  "benchmarks/perf/validate-results.mjs",
]);

export type GitTreeEntry = {
  path: string;
  sha: string;
  type: string;
};

export function isNextjsBenchmarkInput(path: string) {
  if (path === ".github/workflows/perf.yml") return true;
  if (path === "benchmarks/generate-app.mjs") return true;
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
