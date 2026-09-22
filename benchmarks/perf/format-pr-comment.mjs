#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const resultsPath = resolve(process.argv[2] ?? "performance-artifact/perf-results.json");
const responsePath = resolve(process.argv[3] ?? "performance-upload.json");
const outputPath = resolve(process.argv[4] ?? "performance-comment.md");
const results = JSON.parse(await readFile(resultsPath, "utf8"));

if (results.run.kind !== "pull_request") {
  await writeFile(outputPath, "");
  process.exit(0);
}

const resultBenchmarks = Array.isArray(results.benchmarks) ? results.benchmarks : [];
const resultsByBenchmark = new Map(
  resultBenchmarks.map((benchmark) => [benchmark.benchmarkId, benchmark]),
);
const response = await readUploadResponse(responsePath);
const uploadedComparison = response.comparison;
if (!uploadedComparison && resultBenchmarks.length === 0) {
  await writeFile(outputPath, "");
  process.exit(0);
}
const hasPairedBaseline = resultBenchmarks.some((benchmark) => benchmark.baselineSamples);
const comparisonSource = uploadedComparison ?? localComparison(resultBenchmarks);
const comparison = {
  ...comparisonSource,
  baseline: hasPairedBaseline
    ? {
        sha: results.run.baseSha,
        shortSha: shortSha(results.run.baseSha),
        measuredAt: comparisonSource.baseline?.measuredAt ?? null,
      }
    : comparisonSource.baseline,
  measurements: comparisonSource.measurements.map((measurement) => {
    const benchmark = resultsByBenchmark.get(measurement.benchmarkId);
    return benchmark?.baselineSamples
      ? {
          ...measurement,
          baseline: benchmark.baselineSamples,
          current: benchmark.samples,
        }
      : measurement;
  }),
};

function escapeCell(value) {
  return String(value)
    .replaceAll("@", "@\u200b")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("|", "\\|")
    .replaceAll("\n", " ");
}

function formatValue(value, unit) {
  if (unit === "ms")
    return value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(2)} s`;
  if (unit === "bytes") {
    if (value < 1024) return `${Math.round(value)} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${(value / (1024 * 1024)).toFixed(2)} MB`;
  }
  return `${Number(value.toFixed(2))} ${unit}`;
}

function shortSha(sha) {
  return typeof sha === "string" && sha.length > 0 ? sha.slice(0, 7) : "unknown";
}

async function readUploadResponse(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    // The skipped-upload fields are diagnostic metadata; comment formatting is
    // gated by the presence of a dashboard comparison.
    if (error?.code === "ENOENT") return { uploaded: false, reason: "missing_response" };
    throw error;
  }
}

function localComparison(benchmarks) {
  const hasLocalBaseline =
    results.run.baseSha && benchmarks.some((benchmark) => benchmark.baselineSamples);

  return {
    uploaded: false,
    head: {
      sha: results.run.commitSha,
      shortSha: shortSha(results.run.commitSha),
      measuredAt: results.run.measuredAt,
    },
    baseline: hasLocalBaseline
      ? {
          sha: results.run.baseSha,
          shortSha: shortSha(results.run.baseSha),
          measuredAt: null,
        }
      : null,
    measurements: benchmarks.map((benchmark) => ({
      benchmarkId: benchmark.benchmarkId,
      label: benchmark.label,
      implementationLabel: benchmark.implementationLabel,
      unit: benchmark.unit,
      lowerIsBetter: benchmark.lowerIsBetter,
      baseline: benchmark.baselineSamples,
      current: benchmark.samples,
    })),
  };
}

function measurementChange(measurement) {
  if (!measurement.baseline) return null;
  return (
    ((measurement.current.median - measurement.baseline.median) / measurement.baseline.median) * 100
  );
}

function changeCell(measurement, hasComparisonBaseline) {
  const change = measurementChange(measurement);
  if (change === null) return hasComparisonBaseline ? "Current only" : "New";
  const neutral = Math.abs(change) < 1.5;
  const improved = measurement.lowerIsBetter ? change < 0 : change > 0;
  const indicator = neutral ? "⚫" : improved ? "🟢" : "🔴";
  return `${indicator} ${change > 0 ? "+" : ""}${change.toFixed(1)}%`;
}

const measurements = comparison.measurements.toSorted(
  (left, right) =>
    left.label.localeCompare(right.label) ||
    left.implementationLabel.localeCompare(right.implementationLabel),
);
const changes = measurements.map(measurementChange).filter((change) => change !== null);
const regressions = measurements.filter((measurement) => {
  const change = measurementChange(measurement);
  return (
    change !== null &&
    Math.abs(change) >= 1.5 &&
    (measurement.lowerIsBetter ? change > 0 : change < 0)
  );
}).length;
const improvements = measurements.filter((measurement) => {
  const change = measurementChange(measurement);
  return (
    change !== null &&
    Math.abs(change) >= 1.5 &&
    (measurement.lowerIsBetter ? change < 0 : change > 0)
  );
}).length;
const neutral = changes.length - regressions - improvements;
const skippedNextjs = results.run.skippedImplementations?.includes("nextjs");
const hasHistoricalBaseline = comparison.measurements.some(
  (measurement) =>
    measurement.baseline && !resultsByBenchmark.get(measurement.benchmarkId)?.baselineSamples,
);
const hasUnpairedMeasurement = comparison.measurements.some(
  (measurement) => !resultsByBenchmark.get(measurement.benchmarkId)?.baselineSamples,
);
const hasCurrentOnlyMeasurement = comparison.measurements.some(
  (measurement) =>
    !measurement.baseline && !resultsByBenchmark.get(measurement.benchmarkId)?.baselineSamples,
);
const dashboardUrl = uploadedComparison
  ? `https://vinext.dev/benchmarks/pull/${results.run.pullRequest}`
  : null;
const rows = measurements.map((measurement) =>
  [
    escapeCell(measurement.label),
    escapeCell(measurement.implementationLabel),
    measurement.baseline ? formatValue(measurement.baseline.median, measurement.unit) : "—",
    formatValue(measurement.current.median, measurement.unit),
    changeCell(measurement, Boolean(comparison.baseline)),
  ].join(" | "),
);

const body = [
  "<!-- vinext-performance-benchmarks -->",
  "## Performance benchmarks",
  "",
  comparison.baseline
    ? hasPairedBaseline
      ? hasUnpairedMeasurement
        ? hasHistoricalBaseline && hasCurrentOnlyMeasurement
          ? `Compared \`${comparison.head.shortSha}\` against base \`${comparison.baseline.shortSha}\`. Paired benchmarks use alternating same-runner rounds, other benchmarks use the stored base-run baseline where available, and remaining benchmarks have no baseline.${skippedNextjs ? " Next.js was unchanged and skipped." : ""}`
          : hasHistoricalBaseline
            ? `Compared \`${comparison.head.shortSha}\` against base \`${comparison.baseline.shortSha}\`. Paired benchmarks use alternating same-runner rounds; unpaired benchmarks use the stored base-run baseline.${skippedNextjs ? " Next.js was unchanged and skipped." : ""}`
            : `Compared \`${comparison.head.shortSha}\` against base \`${comparison.baseline.shortSha}\`. Paired benchmarks use alternating same-runner rounds; unpaired benchmarks have no baseline.${skippedNextjs ? " Next.js was unchanged and skipped." : ""}`
        : `Compared \`${comparison.head.shortSha}\` against base \`${comparison.baseline.shortSha}\` using alternating same-runner rounds.${skippedNextjs ? " Next.js was unchanged and skipped." : ""}`
      : `Compared \`${comparison.head.shortSha}\` against base \`${comparison.baseline.shortSha}\`.`
    : `Measured \`${comparison.head.shortSha}\`. No benchmark run is available for base \`${shortSha(results.run.baseSha)}\`.`,
  "",
  comparison.baseline
    ? `**${improvements} improved · ${regressions} regressed · ${neutral} within ±1.5%**`
    : `**${measurements.length} measurements recorded · baseline unavailable**`,
  "",
  "| Scenario | Framework | Baseline | Current | Change |",
  "|---|---|---:|---:|---:|",
  ...rows.map((row) => `| ${row} |`),
  "",
  dashboardUrl
    ? `[View detailed results and traces](${dashboardUrl})`
    : "Dashboard upload was unavailable for this run.",
  "",
  `<sub>🟢 improvement · 🔴 regression · ⚫ change below 1.5%${
    hasPairedBaseline
      ? hasUnpairedMeasurement
        ? hasHistoricalBaseline && hasCurrentOnlyMeasurement
          ? " · mixed paired/historical/current-only results"
          : hasHistoricalBaseline
            ? " · mixed paired/historical baselines"
            : " · paired/current-only results"
        : " · paired base/head"
      : ""
  }</sub>`,
  "",
].join("\n");

await writeFile(outputPath, body);
