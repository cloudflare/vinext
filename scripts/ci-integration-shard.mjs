#!/usr/bin/env node
/**
 * CI shard planner for the integration test suite.
 *
 * Discovers integration test files via `vp test list`, reads historical
 * timings from a committed manifest, and assigns files to shards using
 * greedy load-balancing (Next.js-style).
 *
 * Usage:
 *   node scripts/ci-integration-shard.mjs --shard=N/M   emit files for shard N of M
 *   node scripts/ci-integration-shard.mjs --check        verify manifest is in sync
 */
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

const ROOT = new URL("..", import.meta.url).pathname;
const MANIFEST_PATH = new URL("ci-integration-timings.json", import.meta.url).pathname;
// Seed timings in ci-integration-timings.json are approximate hand-estimated
// values that preserve relative file weight. They only need to be accurate
// enough that the four heaviest files (ecosystem, features, pages-router,
// app-router-dev-server) don't land in the same shard. Update from CI blob
// reports (via scripts/plan-integration-shards.mjs) when the suite shape
// changes materially.
const DEFAULT_TIMING_MS = 5_000;

// Parsing helpers.
const args = process.argv.slice(2);
const shardFlag = args.find((a) => a.startsWith("--shard="));
const isCheck = args.includes("--check");
const isList = args.includes("--list");

// ── discover integration test files ──────────────────────────────────────────

function discoverIntegrationFiles() {
  const raw = execSync("vp test list --project integration --filesOnly", {
    cwd: ROOT,
    encoding: "utf8",
  });
  const files = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    // Output format: "[project-name] tests/relative/path.test.ts"
    const match = trimmed.match(/^\[\w+\]\s+(.+)$/);
    if (match) files.push(match[1]);
  }
  return files.sort((a, b) => a.localeCompare(b));
}

// ── read timing manifest ─────────────────────────────────────────────────────

function readManifest() {
  try {
    return JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
  } catch {
    return {};
  }
}

// ── greedy pack: assign each file to the currently lightest group ────────────

function pack(files, timings, groupTotal) {
  const groups = Array.from({ length: groupTotal }, () => ({
    files: [],
    ms: 0,
  }));

  const sorted = [...files].sort((a, b) => {
    const diff = (timings[b] ?? DEFAULT_TIMING_MS) - (timings[a] ?? DEFAULT_TIMING_MS);
    // Deterministic tie-break by path so the result is reproducible regardless
    // of JS engine stability guarantees.
    return diff !== 0 ? diff : a.localeCompare(b);
  });

  for (const file of sorted) {
    let lightest = 0;
    for (let i = 1; i < groupTotal; i++) {
      if (groups[i].ms < groups[lightest].ms) lightest = i;
    }
    groups[lightest].files.push(file);
    groups[lightest].ms += timings[file] ?? DEFAULT_TIMING_MS;
  }

  return groups;
}

// ── modes ────────────────────────────────────────────────────────────────────

if (isList) {
  // --list: print all discovered integration files (for debugging)
  const files = discoverIntegrationFiles();
  for (const f of files) console.log(f);
  process.exit(0);
}

if (isCheck) {
  // --check: verify manifest is in sync with discovered files
  const discovered = discoverIntegrationFiles();
  const manifest = readManifest();
  const manifestFiles = Object.keys(manifest).sort();

  let failed = false;
  const missing = discovered.filter((f) => !(f in manifest));
  if (missing.length > 0) {
    console.error(
      `Missing from ci-integration-timings.json (${missing.length}):\n  ${missing.join("\n  ")}`,
    );
    failed = true;
  }

  const stale = manifestFiles.filter((f) => !discovered.includes(f));
  if (stale.length > 0) {
    console.error(
      `Stale entries in ci-integration-timings.json (${stale.length}):\n  ${stale.join("\n  ")}`,
    );
    failed = true;
  }

  // Verify greedy packing produces valid buckets.
  const SHARD_COUNT = 6;
  const groups = pack(discovered, manifest, SHARD_COUNT);
  const packedFiles = groups.flatMap((g) => g.files);
  const missingAfterPack = discovered.filter((f) => !packedFiles.includes(f));
  const extraAfterPack = packedFiles.filter((f) => !discovered.includes(f));
  const seen = new Set();
  const dups = packedFiles.filter((f) => {
    if (seen.has(f)) return true;
    seen.add(f);
    return false;
  });

  if (missingAfterPack.length > 0) {
    console.error(
      `Files dropped during packing (${missingAfterPack.length}):\n  ${missingAfterPack.join("\n  ")}`,
    );
    failed = true;
  }
  if (extraAfterPack.length > 0) {
    console.error(
      `Extra files in packed output (${extraAfterPack.length}):\n  ${extraAfterPack.join("\n  ")}`,
    );
    failed = true;
  }
  if (dups.length > 0) {
    console.error(`Duplicate files in packed output (${dups.length}):\n  ${dups.join("\n  ")}`);
    failed = true;
  }

  if (failed) {
    process.exit(1);
  }

  console.log(`Check OK — ${discovered.length} files, ${manifestFiles.length} manifest entries.`);
  process.exit(0);
}

if (shardFlag) {
  // --shard=N/M: emit space-separated file list for shard N of M
  const match = shardFlag.match(/^--shard=(\d+)\/(\d+)$/);
  if (!match) {
    console.error("Usage: --shard=N/M");
    process.exit(1);
  }
  const groupPos = Number.parseInt(match[1], 10);
  const groupTotal = Number.parseInt(match[2], 10);
  if (groupPos < 1 || groupPos > groupTotal) {
    console.error(`Shard index ${groupPos} out of range [1, ${groupTotal}]`);
    process.exit(1);
  }

  const discovered = discoverIntegrationFiles();
  const manifest = readManifest();
  const groups = pack(discovered, manifest, groupTotal);
  const groupFiles = groups[groupPos - 1].files;

  // Emit space-separated, trimmed of leading/trailing whitespace, suitable
  // for interpolation into a shell command.
  const out = groupFiles.join(" ").trim();
  if (out) console.log(out);
  process.exit(0);
}

// No recognized flag.
console.error(`Usage:
  node scripts/ci-integration-shard.mjs --shard=N/M   emit files for shard N of M
  node scripts/ci-integration-shard.mjs --check        verify manifest is in sync
  node scripts/ci-integration-shard.mjs --list         list all integration files`);
process.exit(1);
