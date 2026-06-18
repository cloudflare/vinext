#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const inputPath = resolve(process.argv[2] ?? "benchmarks/results/perf-results.json");
const uploadUrl =
  process.env.VINEXT_PERF_UPLOAD_URL ??
  "https://vinext-web.vinext.workers.dev/api/benchmarks/upload";
const secret = process.env.COMPAT_INGEST_SECRET;

if (!secret) {
  console.log("COMPAT_INGEST_SECRET is not configured; skipping performance upload.");
  process.exit(0);
}

const payload = JSON.parse(await readFile(inputPath, "utf8"));
const profileUploadUrl = uploadUrl.replace(/\/upload$/, "/profile-upload");

for (const benchmark of payload.benchmarks) {
  if (!benchmark.profileFile) continue;
  const profilePath = resolve(benchmark.profileFile);
  const contents = await readFile(profilePath);
  const response = await fetch(profileUploadUrl, {
    method: "PUT",
    headers: {
      "X-Compat-Secret": secret,
      "Content-Type": "application/gzip",
      "X-Performance-Run-Kind": payload.run.kind,
      "X-Performance-Commit-Sha": payload.run.commitSha,
      "X-Performance-Execution-Id": payload.run.executionId,
      "X-Performance-Benchmark-Id": benchmark.benchmarkId,
    },
    body: contents,
  });
  if (!response.ok) {
    throw new Error(
      `Performance profile upload failed (${response.status}): ${await response.text()}`,
    );
  }
  const uploaded = await response.json();
  benchmark.profileObjectKey = uploaded.key;
  delete benchmark.profileFile;
}

const response = await fetch(uploadUrl, {
  method: "POST",
  headers: {
    "X-Compat-Secret": secret,
    "Content-Type": "application/json",
  },
  body: JSON.stringify(payload),
});

if (!response.ok) {
  throw new Error(`Performance upload failed (${response.status}): ${await response.text()}`);
}

console.log(await response.text());
