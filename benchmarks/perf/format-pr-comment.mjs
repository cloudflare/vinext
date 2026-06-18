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

const response = JSON.parse(await readFile(responsePath, "utf8"));
const comparison = response.comparison;
if (!comparison) throw new Error("Performance upload response did not include a comparison");

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

function measurementChange(measurement) {
  if (!measurement.baseline) return null;
  return (
    ((measurement.current.median - measurement.baseline.median) / measurement.baseline.median) * 100
  );
}

function changeCell(measurement) {
  const change = measurementChange(measurement);
  if (change === null) return "New";
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
const dashboardUrl = `https://vinext.dev/benchmarks/pull/${results.run.pullRequest}`;
const rows = measurements.map((measurement) =>
  [
    escapeCell(measurement.label),
    escapeCell(measurement.implementationLabel),
    measurement.baseline ? formatValue(measurement.baseline.median, measurement.unit) : "—",
    formatValue(measurement.current.median, measurement.unit),
    changeCell(measurement),
  ].join(" | "),
);

const body = [
  "<!-- vinext-performance-benchmarks -->",
  "## Performance benchmarks",
  "",
  comparison.baseline
    ? `Compared \`${comparison.head.shortSha}\` against base \`${comparison.baseline.shortSha}\`.`
    : `Measured \`${comparison.head.shortSha}\`. No benchmark run is available for base \`${results.run.baseSha.slice(0, 7)}\`.`,
  "",
  comparison.baseline
    ? `**${improvements} improved · ${regressions} regressed · ${neutral} within ±1.5%**`
    : `**${measurements.length} measurements recorded · baseline unavailable**`,
  "",
  "| Scenario | Framework | Baseline | Current | Change |",
  "|---|---|---:|---:|---:|",
  ...rows.map((row) => `| ${row} |`),
  "",
  `[View detailed results and traces](${dashboardUrl})`,
  "",
  "<sub>🟢 improvement · 🔴 regression · ⚫ change below 1.5%</sub>",
  "",
].join("\n");

await writeFile(outputPath, body);
