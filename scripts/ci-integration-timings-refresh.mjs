#!/usr/bin/env node
/**
 * Regenerate scripts/ci-integration-timings.json from real CI Vitest blob
 * reports. This is the only supported way to change the manifest: every weight
 * carries provenance (which runs it came from, how many samples, median + p75).
 *
 * Workflow:
 *   # Download blob artifacts from one or more successful CI runs on main:
 *   gh run download <run-id> -p 'blob-report-*' -D /tmp/blobs
 *   # Aggregate them into the manifest (p75 per file):
 *   node scripts/ci-integration-timings-refresh.mjs /tmp/blobs --run=<run-id> --write
 *
 * Pass --run once per source run so the manifest records its provenance. The
 * blobs must back that claim: every discovered file must have exactly one
 * sample per --run (a file runs in one shard per run), so the manifest cannot
 * claim stronger provenance than the directory provides. --allow-partial
 * relaxes this to "at least one sample per file" for re-run-failed-shard cases;
 * in that mode, generatedFrom.runs lists the source runs used for the refresh,
 * while each file's samples count remains the per-file provenance.
 *
 * --shard-total defaults to the existing manifest's shardTotal, so a plain
 * refresh preserves the count the CI matrix already uses. Pass it explicitly
 * only when changing the shard count (and update the matrix to match).
 *
 * Without --write it prints a dry-run summary and exits non-zero if the
 * manifest would change, so it can double as a freshness check.
 *
 * Usage:
 *   node scripts/ci-integration-timings-refresh.mjs <blob-dir> --run=<id> [--run=<id>...] [--shard-total=N] [--allow-partial] [--write]
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { parseFlag } from "./lib/cli-args.mjs";
import { discoverIntegrationFiles } from "./lib/integration-files.mjs";
import { buildManifest } from "./lib/integration-shard-plan.mjs";
import { aggregateBlobDir } from "./lib/vitest-blob-timings.mjs";

const MANIFEST_PATH = new URL("ci-integration-timings.json", import.meta.url).pathname;
const REPO_RUN_URL = "https://github.com/cloudflare/vinext/actions/runs";

function die(...msg) {
  console.error(...msg);
  process.exit(1);
}

const args = process.argv.slice(2);
const blobDir = args.find((a) => !a.startsWith("--"));
const write = args.includes("--write");
const allowPartial = args.includes("--allow-partial");
const runIds = args
  .filter((a) => a.startsWith("--run="))
  .map((a) => a.slice("--run=".length))
  .filter(Boolean);
const shardTotalRaw = parseFlag(args, "--shard-total");
// Default to the current manifest's shardTotal so a plain refresh preserves the
// count the CI matrix already uses. manifest.shardTotal is the single source of
// truth for the count (the matrix mirrors it and `--check` enforces no drift),
// so a hardcoded default here would silently drift whenever the count changes.
// Only an explicit --shard-total changes the count.
const currentShardTotal = existsSync(MANIFEST_PATH)
  ? JSON.parse(readFileSync(MANIFEST_PATH, "utf8")).shardTotal
  : undefined;
const shardTotal = shardTotalRaw === null ? currentShardTotal : Number.parseInt(shardTotalRaw, 10);

if (!blobDir)
  die("Usage: ci-integration-timings-refresh.mjs <blob-dir> --run=<id> [--run=...] [--write]");
if (runIds.length === 0)
  die("At least one --run=<id> is required so the manifest records its provenance.");
if (!Number.isInteger(shardTotal) || shardTotal < 1) {
  die(
    shardTotalRaw !== null
      ? `Invalid --shard-total: ${shardTotalRaw}`
      : "No --shard-total given and the existing manifest has no valid shardTotal to inherit. Pass --shard-total=N.",
  );
}

const { samples, blobCount, warnings } = await aggregateBlobDir(blobDir);
let discovered;
try {
  discovered = discoverIntegrationFiles();
} catch (err) {
  die(err.message);
}

// Provenance must not overclaim. A test file runs in exactly one shard per
// run, so one complete run yields exactly one sample per file. Require
// samples === runIds.length for every discovered file: too few means a claimed
// run's blobs are missing, too many means the directory holds blobs beyond the
// claimed runs. Either way the manifest would record stronger provenance than
// the blobs provide. --allow-partial relaxes this to "at least one sample" for
// the re-run-failed-shard case; generatedFrom.runs still records the source runs
// used for the refresh, while each file's samples count remains the per-file
// provenance.
const expectedPerFile = runIds.length;
const coverage = discovered.map((f) => ({ file: f, samples: samples.get(f)?.length ?? 0 }));

if (allowPartial) {
  const uncovered = coverage.filter((c) => c.samples === 0);
  if (uncovered.length > 0) {
    console.error(`No samples for ${uncovered.length} discovered file(s):`);
    for (const c of uncovered) console.error(`  ${c.file}`);
    die("Every discovered file needs at least one sample to compute a weight.");
  }
} else {
  const mismatched = coverage.filter((c) => c.samples !== expectedPerFile);
  if (mismatched.length > 0) {
    console.error(
      `Provenance mismatch: ${mismatched.length} discovered file(s) do not have exactly ` +
        `${expectedPerFile} sample(s), one per claimed --run. The blob directory does not back ` +
        `the claimed provenance of ${runIds.length} run(s).`,
    );
    for (const c of mismatched.slice(0, 20)) {
      console.error(`  ${String(c.samples).padStart(2)} / ${expectedPerFile}  ${c.file}`);
    }
    if (mismatched.length > 20) console.error(`  ... and ${mismatched.length - 20} more`);
    die(
      "Provide complete blobs for every --run (all shards), or pass --allow-partial to override.",
    );
  }
}

// Drop measured files that are no longer discovered (renamed/removed tests).
// Deleting the current key during Map iteration is well-defined, so no
// snapshot of the keys is needed.
const known = new Set(discovered);
for (const file of samples.keys()) {
  if (!known.has(file)) samples.delete(file);
}

const runs = runIds.map((id) => ({ id, url: `${REPO_RUN_URL}/${id}` }));
const manifest = buildManifest({
  samples,
  shardTotal,
  runs,
  generatedAt: new Date().toISOString(),
});

const serialized = `${JSON.stringify(manifest, null, 2)}\n`;

console.error(
  `Aggregated ${blobCount} blob(s) from ${runIds.length} run(s) into ${Object.keys(manifest.files).length} files.`,
);
if (warnings.length > 0) {
  console.error(
    `Skipped ${warnings.length} malformed blob entr${warnings.length === 1 ? "y" : "ies"}:`,
  );
  for (const warning of warnings) console.error(`  ${warning}`);
}
for (const file of Object.keys(manifest.files)) {
  const e = manifest.files[file];
  console.error(
    `  ${String(Math.round(e.estimateMs / 1000)).padStart(3)}s  n=${e.samples}  ${file}`,
  );
}

if (write) {
  writeFileSync(MANIFEST_PATH, serialized);
  console.error(`\nWrote ${MANIFEST_PATH}`);
} else {
  // generatedAt and provenance always differ, so compare only the file weights
  // for a meaningful "would the data change?" signal in dry-run mode.
  const previous = existsSync(MANIFEST_PATH)
    ? JSON.parse(readFileSync(MANIFEST_PATH, "utf8"))
    : null;
  const changed = JSON.stringify(previous?.files) !== JSON.stringify(manifest.files);
  console.error(
    `\nDry run (no --write). File weights ${changed ? "WOULD change" : "are unchanged"}.`,
  );
  if (changed) process.exit(1);
}
