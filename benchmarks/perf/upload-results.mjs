#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

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
const form = new FormData();
form.set("results", JSON.stringify(payload));

for (const benchmark of payload.benchmarks) {
  if (!benchmark.profileFile) continue;
  const profilePath = resolve(benchmark.profileFile);
  const contents = await readFile(profilePath);
  form.append(
    `profile:${benchmark.benchmarkId}`,
    new Blob([contents], { type: "application/gzip" }),
    `${encodeURIComponent(benchmark.benchmarkId)}.json.gz`,
  );
  benchmark.profileFile = basename(profilePath);
}

form.set("results", JSON.stringify(payload));
const response = await fetch(uploadUrl, {
  method: "POST",
  headers: { "X-Compat-Secret": secret },
  body: form,
});

if (!response.ok) {
  throw new Error(`Performance upload failed (${response.status}): ${await response.text()}`);
}

console.log(await response.text());
