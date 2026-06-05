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
 * Pass --run once per source run so the manifest records its provenance.
 * Without --write it prints a dry-run summary and exits non-zero if the
 * manifest would change, so it can double as a freshness check.
 *
 * Usage:
 *   node scripts/ci-integration-timings-refresh.mjs <blob-dir> --run=<id> [--run=<id>...] [--shard-total=N] [--write]
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { buildManifest } from "./lib/integration-shard-plan.mjs";
import { aggregateBlobDir } from "./lib/vitest-blob-timings.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const MANIFEST_PATH = new URL("ci-integration-timings.json", import.meta.url).pathname;
const REPO_RUN_URL = "https://github.com/cloudflare/vinext/actions/runs";

function die(...msg) {
  console.error(...msg);
  process.exit(1);
}

const args = process.argv.slice(2);
const blobDir = args.find((a) => !a.startsWith("--"));
const write = args.includes("--write");
const runIds = args
  .filter((a) => a.startsWith("--run="))
  .map((a) => a.slice("--run=".length))
  .filter(Boolean);
const shardTotalRaw = args.find((a) => a.startsWith("--shard-total="));
const shardTotal = shardTotalRaw
  ? Number.parseInt(shardTotalRaw.slice("--shard-total=".length), 10)
  : 6;

if (!blobDir)
  die("Usage: ci-integration-timings-refresh.mjs <blob-dir> --run=<id> [--run=...] [--write]");
if (runIds.length === 0)
  die("At least one --run=<id> is required so the manifest records its provenance.");
if (!Number.isInteger(shardTotal) || shardTotal < 1) die(`Invalid --shard-total: ${shardTotalRaw}`);

// Discover the authoritative file set so we can fail closed when the blobs do
// not cover every integration test file. A single complete successful CI run
// spans all shards and therefore every file.
function discoverIntegrationFiles() {
  let raw;
  try {
    raw = execSync("vp test list --project integration --filesOnly", {
      cwd: ROOT,
      encoding: "utf8",
    });
  } catch {
    die("Failed to run 'vp test list --project integration --filesOnly'");
  }
  const files = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const bracketed = trimmed.match(/^\[\w+\]\s+(.+)$/);
    if (bracketed) files.push(bracketed[1]);
    else if (/^tests\/.+\.test\.(ts|js|tsx|jsx)$/.test(trimmed)) files.push(trimmed);
  }
  return files.sort((a, b) => a.localeCompare(b));
}

const { samples, blobCount } = await aggregateBlobDir(blobDir);
const discovered = discoverIntegrationFiles();

const uncovered = discovered.filter((f) => !samples.has(f));
if (uncovered.length > 0) {
  console.error(
    `The provided blobs do not cover ${uncovered.length} discovered integration file(s):`,
  );
  for (const f of uncovered) console.error(`  ${f}`);
  die("Download a complete successful CI run (all shards) so every file has timing data.");
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
