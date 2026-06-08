#!/usr/bin/env node
/**
 * CI shard planner for the integration test suite.
 *
 * Discovers integration test files via `vp test list` (the source of truth),
 * reads per-file weights from the committed timing manifest, and assigns files
 * to shards with a balanced longest-processing-time pack. Planning, validation,
 * and packing live in scripts/lib/integration-shard-plan.mjs; this file is the
 * thin CLI around them.
 *
 * Usage:
 *   node scripts/ci-integration-shard.mjs --shard=N/M               emit files for shard N of M
 *   node scripts/ci-integration-shard.mjs --check --shard-total=N   verify manifest is in sync
 *   node scripts/ci-integration-shard.mjs --list                    list all integration files
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

import { intFlag, parseFlag } from "./lib/cli-args.mjs";
import { discoverIntegrationFiles } from "./lib/integration-files.mjs";
import {
  checkPlan,
  manifestWeights,
  pack,
  planSummary,
  recommendShardCount,
  validateManifest,
} from "./lib/integration-shard-plan.mjs";

// Defaults match the per-shard fixed cost observed in CI (setup 25-31s + build
// 6-8s) and the merge/report job (~35s). Override via flags when CI changes.
const DEFAULT_OVERHEAD_MS = 48_000;
const DEFAULT_REPORT_MS = 35_000;
const DEFAULT_MAX_SHARDS = 10;

const MANIFEST_PATH = new URL("ci-integration-timings.json", import.meta.url).pathname;

function die(...msg) {
  console.error(...msg);
  process.exit(1);
}

function readManifest() {
  if (!existsSync(MANIFEST_PATH)) die(`Timing manifest not found: ${MANIFEST_PATH}`);
  try {
    return JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
  } catch (err) {
    die(`Timing manifest is not valid JSON: ${MANIFEST_PATH}\n  ${err.message}`);
  }
}

function printSummary(groups, weights, fileCount) {
  console.error(`\nIntegration shard plan (${groups.length} ways, ${fileCount} files):`);
  for (const line of planSummary(groups, weights)) console.error(line);
}

function readDiscoveredIntegrationFiles() {
  try {
    return discoverIntegrationFiles();
  } catch (err) {
    die(err.message);
  }
}

function runList() {
  for (const f of readDiscoveredIntegrationFiles()) console.log(f);
}

function runCheck(args) {
  const shardTotalRaw = parseFlag(args, "--shard-total");
  if (!shardTotalRaw) die("--check requires --shard-total=N");
  const shardTotal = Number.parseInt(shardTotalRaw, 10);
  if (!Number.isInteger(shardTotal) || shardTotal < 1)
    die(`Invalid --shard-total: ${shardTotalRaw}`);

  const discovered = readDiscoveredIntegrationFiles();
  const manifest = readManifest();
  const { errors, warnings, groups } = checkPlan({ discovered, manifest, shardTotal });

  if (groups.length > 0) printSummary(groups, manifestWeights(manifest), discovered.length);

  // Advisory: plan is valid, CI passes. Annotate so a maintainer refreshes.
  if (warnings.length > 0) {
    console.error(`\nIntegration shard manifest warnings (${warnings.length}):`);
    for (const w of warnings) console.error(`  ::warning::${w}`);
  }

  if (errors.length > 0) {
    console.error(`\nIntegration shard manifest check failed (${errors.length}):`);
    for (const e of errors) console.error(`  ${e}`);
    process.exit(1);
  }
  console.log(
    `Check OK — ${discovered.length} files, ${Object.keys(manifest.files).length} manifest entries, ${shardTotal} shards.`,
  );
}

function runShard(shardFlag) {
  const match = shardFlag.match(/^(\d+)\/(\d+)$/);
  if (!match) die("Usage: --shard=N/M");
  const pos = Number.parseInt(match[1], 10);
  const total = Number.parseInt(match[2], 10);
  if (pos < 1 || pos > total) die(`Shard index ${pos} out of range [1, ${total}]`);

  const discovered = readDiscoveredIntegrationFiles();
  const manifest = readManifest();
  const errors = validateManifest(manifest);
  if (errors.length > 0) {
    console.error("Timing manifest is invalid:");
    for (const e of errors) console.error(`  ${e}`);
    process.exit(1);
  }

  // Enforce the count invariant at the selection point, not only in --check:
  // a matrix/manifest mismatch would otherwise silently drop or double-run tests.
  if (manifest.shardTotal !== total) {
    die(
      `Shard-count drift: manifest shardTotal is ${manifest.shardTotal} but --shard requested ${total}. ` +
        "Update scripts/ci-integration-timings.json and the CI matrix together.",
    );
  }

  const weights = manifestWeights(manifest);
  const groups = pack(discovered, weights, total);
  printSummary(groups, weights, discovered.length);

  const out = groups[pos - 1].files.join(" ").trim();
  if (out) console.log(out);
}

// Advisory only: models the optimal shard count from the committed weights so a
// maintainer can update the matrix deliberately. Never run by CI.
function runRecommend(args) {
  const discovered = readDiscoveredIntegrationFiles();
  const manifest = readManifest();
  const errors = validateManifest(manifest);
  if (errors.length > 0) {
    console.error("Timing manifest is invalid:");
    for (const e of errors) console.error(`  ${e}`);
    process.exit(1);
  }

  const targetRaw = parseFlag(args, "--target-ms");
  const targetMs = targetRaw === null ? undefined : Number.parseInt(targetRaw, 10);
  if (targetRaw !== null && (!Number.isInteger(targetMs) || targetMs < 1)) {
    die(`Invalid --target-ms: ${targetRaw}`);
  }

  const { rows, recommended } = recommendShardCount({
    files: discovered,
    weights: manifestWeights(manifest),
    maxShards: readIntFlag(args, "--max-shards", DEFAULT_MAX_SHARDS),
    overheadMs: readIntFlag(args, "--overhead-ms", DEFAULT_OVERHEAD_MS),
    reportMs: readIntFlag(args, "--report-ms", DEFAULT_REPORT_MS),
    targetMs,
  });

  const s = (ms) => `${(ms / 1000).toFixed(1)}s`;
  console.log("shards  slowest shard  integration crit path  runner minutes  meets target");
  for (const r of rows) {
    const flag = targetMs === undefined ? "" : r.meetsTarget ? "yes" : "no";
    const marker = r.shards === manifest.shardTotal ? " <- current" : "";
    console.log(
      `${String(r.shards).padStart(6)}  ${s(r.maxGroupMs).padStart(13)}  ${s(r.criticalPathMs).padStart(21)}  ${s(r.runnerMs).padStart(14)}  ${flag.padStart(12)}${marker}`,
    );
  }
  console.log("");
  if (targetMs === undefined) {
    console.log(
      "No --target-ms given. Choose the smallest count whose critical path is at or below your\n" +
        "competing bottleneck (app-router E2E / unit). More shards past that add runner minutes for\n" +
        "~0 wall-clock. Pass --target-ms=<competing-bottleneck-ms> for a concrete recommendation.",
    );
  } else {
    console.log(
      `Recommended: ${recommended} shard(s) — the smallest count that drops integration to or below ${s(targetMs)}.\n` +
        `Manifest currently declares ${manifest.shardTotal}. Update manifest.shardTotal and the CI matrix together if you change it.`,
    );
  }
}

function readIntFlag(args, name, fallback) {
  try {
    return intFlag(args, name, fallback);
  } catch (err) {
    die(err.message);
  }
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--list")) return runList();
  if (args.includes("--check")) return runCheck(args);
  if (args.includes("--recommend")) return runRecommend(args);
  const shardFlag = parseFlag(args, "--shard");
  if (shardFlag) return runShard(shardFlag);

  die(`Usage:
  node scripts/ci-integration-shard.mjs --shard=N/M               emit files for shard N of M
  node scripts/ci-integration-shard.mjs --check --shard-total=N   verify manifest is in sync
  node scripts/ci-integration-shard.mjs --recommend [--target-ms=N]  advise on optimal shard count
  node scripts/ci-integration-shard.mjs --list                    list all integration files`);
}

// Only run the CLI when invoked directly, not when imported for analysis/tests.
if (
  process.argv[1] &&
  pathToFileURL(fileURLToPath(import.meta.url)).href === pathToFileURL(process.argv[1]).href
) {
  main();
}
