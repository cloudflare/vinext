#!/usr/bin/env node

import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const inputPath = resolve(process.argv[2] ?? "benchmarks/results/perf-samples.jsonl");
const outputPath = resolve(process.argv[3] ?? "benchmarks/results/perf-results.json");
const profilesDirectory = resolve(process.argv[4] ?? "benchmarks/results/perf-profiles");

async function profileFile(benchmarkId) {
  try {
    const profilePath = join(profilesDirectory, benchmarkId, "samply-profile.json.gz");
    await access(profilePath);
    return relative(dirname(outputPath), profilePath);
  } catch {
    return null;
  }
}

function quantile(sorted, percentile) {
  if (sorted.length === 0) return null;
  const index = (sorted.length - 1) * percentile;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function summarize(values) {
  if (values.length === 0) throw new Error("Cannot summarize an empty sample set");
  const sorted = [...values].sort((left, right) => left - right);
  const mean = sorted.reduce((total, value) => total + value, 0) / sorted.length;
  const variance =
    sorted.reduce((total, value) => total + (value - mean) ** 2, 0) /
    Math.max(sorted.length - 1, 1);
  const q1 = quantile(sorted, 0.25);
  const q3 = quantile(sorted, 0.75);
  const iqr = q3 - q1;
  const lowerFence = q1 - iqr * 1.5;
  const upperFence = q3 + iqr * 1.5;

  return {
    rounds: sorted.length,
    mean,
    median: quantile(sorted, 0.5),
    standardDeviation: Math.sqrt(variance),
    min: sorted[0],
    max: sorted.at(-1),
    q1,
    q3,
    outliers: sorted.filter((value) => value < lowerFence || value > upperFence).length,
  };
}

function commitTimestamp(commitSha) {
  if (!commitSha || commitSha === "local") return new Date().toISOString();
  const timestamp = execFileSync("git", ["show", "-s", "--format=%cI", commitSha], {
    encoding: "utf8",
  }).trim();
  const date = new Date(timestamp);
  if (Number.isNaN(date.valueOf())) {
    throw new Error(`Could not determine commit timestamp for ${commitSha}`);
  }
  return date.toISOString();
}

async function main() {
  const contents = await readFile(inputPath, "utf8");
  const samples = contents
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

  const grouped = Map.groupBy(samples, (sample) => sample.benchmarkId);
  const commitSha = process.env.VINEXT_PERF_COMMIT_SHA ?? process.env.GITHUB_SHA ?? "local";
  const benchmarks = await Promise.all(
    Array.from(grouped, async ([benchmarkId, group]) => ({
      benchmarkId,
      scenarioId: group[0].scenarioId,
      suite: group[0].suite,
      label: group[0].label,
      description: group[0].description,
      implementationId: group[0].implementationId,
      implementationLabel: group[0].implementationLabel,
      unit: group[0].unit,
      lowerIsBetter: group[0].lowerIsBetter,
      samples: summarize(group.map((sample) => sample.value)),
      profileFile: group[0].profile ? await profileFile(benchmarkId) : null,
    })),
  );

  const payload = {
    schemaVersion: 1,
    provider: "samply",
    instrument: "walltime",
    run: {
      kind: process.env.VINEXT_PERF_RUN_KIND === "pull_request" ? "pull_request" : "main",
      commitSha,
      baseSha: process.env.VINEXT_PERF_BASE_SHA || null,
      pullRequest: Number(process.env.VINEXT_PERF_PR_NUMBER) || null,
      executionId: process.env.VINEXT_PERF_EXECUTION_ID || `local:${Date.now()}`,
      measuredAt: commitTimestamp(commitSha),
      repository: process.env.GITHUB_REPOSITORY ?? "cloudflare/vinext",
    },
    system: {
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      runner: process.env.RUNNER_NAME ?? "local",
    },
    benchmarks,
  };

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(payload)}\n`);
  console.log(`Wrote ${benchmarks.length} normalized benchmarks to ${outputPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});
