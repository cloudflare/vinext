#!/usr/bin/env node
/**
 * CI shard planner for the integration test suite.
 *
 * Discovers integration test files via `vp test list`, reads historical
 * timings from a committed manifest, and assigns files to shards using
 * longest-processing-time greedy + deterministic local improvement.
 *
 * Usage:
 *   node scripts/ci-integration-shard.mjs --shard=N/M                 emit files for shard N of M
 *   node scripts/ci-integration-shard.mjs --check --shard-total=N    verify manifest is in sync
 *   node scripts/ci-integration-shard.mjs --list                      list all integration files
 */

import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";

const ROOT = new URL("..", import.meta.url).pathname;
const MANIFEST_PATH = new URL("ci-integration-timings.json", import.meta.url).pathname;

// Seed timings are approximate. They only need to preserve relative file
// weight so that the four heaviest files (ecosystem, features, pages-router,
// app-router-dev-server) don't land in the same shard. Replace with measured
// CI timing data when the suite shape changes materially.
const DEFAULT_TIMING_MS = 5_000;

const args = process.argv.slice(2);

function parseFlag(name) {
  const flag = args.find((a) => a.startsWith(`${name}=`));
  if (!flag) return null;
  return flag.split("=").slice(1).join("=");
}

function die(...msg) {
  console.error(...msg);
  process.exit(1);
}

// ── manifest loading (strict) ──────────────────────────────────────────

function readManifest() {
  if (!existsSync(MANIFEST_PATH)) {
    die(`Timing manifest not found: ${MANIFEST_PATH}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
  } catch (err) {
    die(`Timing manifest is not valid JSON: ${MANIFEST_PATH}\n  ${err.message}`);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    die("Timing manifest must be a JSON object with a 'files' map");
  }

  if (typeof parsed.files !== "object" || parsed.files === null || Array.isArray(parsed.files)) {
    die("Timing manifest must contain a 'files' map of string → number");
  }

  const entries = Object.keys(parsed.files);
  if (entries.length === 0) {
    die("Timing manifest 'files' map is empty");
  }

  for (const [file, ms] of Object.entries(parsed.files)) {
    if (typeof ms !== "number" || !Number.isFinite(ms)) {
      die(`Invalid timing for ${file}: must be a finite number, got ${JSON.stringify(ms)}`);
    }
    if (!Number.isInteger(ms)) {
      die(`Invalid timing for ${file}: ${String(ms)} is not an integer`);
    }
    if (ms <= 0) {
      die(`Invalid timing for ${file}: ${String(ms)} is not positive`);
    }
  }

  return parsed;
}

// ── file discovery ─────────────────────────────────────────────────────

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
    // Accept "[integration] path" or plain "path", skip everything else.
    let filePath;
    const bracketed = trimmed.match(/^\[\w+\]\s+(.+)$/);
    if (bracketed) {
      filePath = bracketed[1];
    } else if (/^tests\/.+\.test\.(ts|js|tsx|jsx)$/.test(trimmed)) {
      filePath = trimmed;
    } else {
      continue;
    }
    files.push(filePath);
  }

  if (files.length === 0) {
    die("Discovered zero integration test files — something is wrong");
  }

  return files.sort((a, b) => a.localeCompare(b));
}

// ── greedy LPT pack ────────────────────────────────────────────────────

function greedyPack(files, timings, groupTotal) {
  const groups = Array.from({ length: groupTotal }, () => ({ files: [], ms: 0 }));

  const sorted = [...files].sort((a, b) => {
    const tA = timings[a] ?? DEFAULT_TIMING_MS;
    const tB = timings[b] ?? DEFAULT_TIMING_MS;
    const diff = tB - tA;
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

// ── local improvement helpers ─────────────────────────────────────────

function msAfterMove(groups, fromIdx, toIdx, dMs) {
  return Math.max(
    ...groups.map((g, i) => {
      if (i === fromIdx) return g.ms - dMs;
      if (i === toIdx) return g.ms + dMs;
      return g.ms;
    }),
  );
}

function applyMove(groups, fromIdx, toIdx, file, dMs) {
  groups[fromIdx].files = groups[fromIdx].files.filter((f) => f !== file);
  groups[toIdx].files.push(file);
  groups[fromIdx].ms -= dMs;
  groups[toIdx].ms += dMs;
}

function msAfterSwap(groups, idxA, idxB, dA, dB) {
  return Math.max(
    ...groups.map((g, i) => {
      if (i === idxA) return g.ms - dA + dB;
      if (i === idxB) return g.ms - dB + dA;
      return g.ms;
    }),
  );
}

function applySwap(groups, idxA, idxB, fileA, fileB, dA, dB) {
  groups[idxA].files = groups[idxA].files.filter((f) => f !== fileA);
  groups[idxB].files = groups[idxB].files.filter((f) => f !== fileB);
  groups[idxA].files.push(fileB);
  groups[idxB].files.push(fileA);
  groups[idxA].ms = groups[idxA].ms - dA + dB;
  groups[idxB].ms = groups[idxB].ms - dB + dA;
}

// Sort files in a shard by timing desc (deterministic tie-break by path).
function sortHeaviestFirst(files, timings) {
  return [...files]
    .map((f) => ({ file: f, ms: timings[f] ?? DEFAULT_TIMING_MS }))
    .sort((a, b) => b.ms - a.ms || a.file.localeCompare(b.file));
}

// Sort files in a shard by timing asc (deterministic tie-break by path).
function sortLightestFirst(files, timings) {
  return [...files]
    .map((f) => ({ file: f, ms: timings[f] ?? DEFAULT_TIMING_MS }))
    .sort((a, b) => a.ms - b.ms || a.file.localeCompare(b.file));
}

// ── local improvement pass ────────────────────────────────────────────

function localImprove(groups, timings) {
  let improved = true;

  while (improved) {
    improved = false;
    const currentMax = Math.max(...groups.map((g) => g.ms));

    // Shard indices sorted by duration descending (deterministic: tie-break by index).
    const byLoad = groups.map((g, i) => i).sort((a, b) => groups[b].ms - groups[a].ms || a - b);
    const heavyIdx = byLoad[0];
    const lightIdx = byLoad[byLoad.length - 1];

    // ── Phase 1: move one file from heaviest to lightest ─────────────
    if (heavyIdx !== lightIdx && groups[heavyIdx].files.length > 0) {
      for (const { file, ms } of sortHeaviestFirst(groups[heavyIdx].files, timings)) {
        if (msAfterMove(groups, heavyIdx, lightIdx, ms) < currentMax) {
          applyMove(groups, heavyIdx, lightIdx, file, ms);
          improved = true;
          break;
        }
      }
    }
    if (improved) continue;

    // ── Phase 2: one-to-one swap between heaviest and another shard ──
    // Try other shards from lightest upward.
    for (let i = byLoad.length - 1; i >= 1; i--) {
      const otherIdx = byLoad[i];
      if (groups[otherIdx].files.length === 0) continue;

      const heavies = sortHeaviestFirst(groups[heavyIdx].files, timings);
      const lights = sortLightestFirst(groups[otherIdx].files, timings);
      let found = false;

      for (const hc of heavies) {
        for (const lc of lights) {
          if (msAfterSwap(groups, heavyIdx, otherIdx, hc.ms, lc.ms) < currentMax) {
            applySwap(groups, heavyIdx, otherIdx, hc.file, lc.file, hc.ms, lc.ms);
            improved = true;
            found = true;
            break;
          }
        }
        if (found) break;
      }
      if (found) break;
    }
    if (improved) continue;

    // ── Phase 3: bounded two-file swap between heaviest and lightest ─
    if (
      heavyIdx !== lightIdx &&
      groups[heavyIdx].files.length >= 2 &&
      groups[lightIdx].files.length >= 2
    ) {
      const heavies = sortHeaviestFirst(groups[heavyIdx].files, timings).slice(0, 4);
      const lights = sortLightestFirst(groups[lightIdx].files, timings).slice(0, 4);
      let found = false;

      for (let ai = 0; ai < heavies.length && !found; ai++) {
        for (let aj = ai + 1; aj < heavies.length && !found; aj++) {
          const dh = heavies[ai].ms + heavies[aj].ms;
          for (let bi = 0; bi < lights.length && !found; bi++) {
            for (let bj = bi + 1; bj < lights.length && !found; bj++) {
              const dl = lights[bi].ms + lights[bj].ms;
              const newMax = msAfterMultiSwap(groups, heavyIdx, lightIdx, dh, dl);
              if (newMax < currentMax) {
                applyMultiSwap(
                  groups,
                  heavyIdx,
                  lightIdx,
                  [heavies[ai].file, heavies[aj].file],
                  [lights[bi].file, lights[bj].file],
                  dh,
                  dl,
                );
                improved = true;
                found = true;
              }
            }
          }
        }
      }
    }
  }
}

function msAfterMultiSwap(groups, idxA, idxB, dOut, dIn) {
  return Math.max(
    ...groups.map((g, i) => {
      if (i === idxA) return g.ms - dOut + dIn;
      if (i === idxB) return g.ms - dIn + dOut;
      return g.ms;
    }),
  );
}

function applyMultiSwap(groups, idxA, idxB, outFiles, inFiles, dOut, dIn) {
  for (const f of outFiles) {
    groups[idxA].files = groups[idxA].files.filter((x) => x !== f);
  }
  for (const f of inFiles) {
    groups[idxB].files = groups[idxB].files.filter((x) => x !== f);
  }
  groups[idxA].files.push(...inFiles);
  groups[idxB].files.push(...outFiles);
  groups[idxA].ms = groups[idxA].ms - dOut + dIn;
  groups[idxB].ms = groups[idxB].ms - dIn + dOut;
}

// ── public pack: greedy + local improvement ───────────────────────────

function pack(files, timings, groupTotal) {
  const groups = greedyPack(files, timings, groupTotal);
  if (groupTotal >= 2) {
    localImprove(groups, timings);
  }
  return groups;
}

// ── plan summary (printed to stderr) ───────────────────────────────────

function printPlanSummary(groups) {
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    const head = g.files.slice(0, 3).join(" ");
    const rest = g.files.length > 3 ? ` +${g.files.length - 3} more` : "";
    console.error(`${i + 1}/${groups.length}  ${Math.round(g.ms / 1000)}s  ${head}${rest}`);
  }
}

// ── validation helpers ─────────────────────────────────────────────────

function checkMissingAndStale(discovered, manifest, filesKey) {
  let failed = false;

  const missing = discovered.filter((f) => !(f in manifest[filesKey]));
  if (missing.length > 0) {
    console.error(`Missing from ci-integration-timings.json files (${missing.length}):`);
    for (const f of missing) console.error(`  ${f}`);
    failed = true;
  }

  const stale = Object.keys(manifest[filesKey]).filter((f) => !discovered.includes(f));
  if (stale.length > 0) {
    console.error(`Stale entries in ci-integration-timings.json (${stale.length}):`);
    for (const f of stale) console.error(`  ${f}`);
    failed = true;
  }

  return failed;
}

function checkPackIntegrity(discovered, groups) {
  let failed = false;
  const packedFiles = groups.flatMap((g) => g.files);

  const missing = discovered.filter((f) => !packedFiles.includes(f));
  if (missing.length > 0) {
    console.error(`Files dropped during packing (${missing.length}):`);
    for (const f of missing) console.error(`  ${f}`);
    failed = true;
  }

  const seen = new Set();
  const dups = packedFiles.filter((f) => {
    if (seen.has(f)) return true;
    seen.add(f);
    return false;
  });
  if (dups.length > 0) {
    console.error(`Duplicate files in packed output (${dups.length}):`);
    for (const f of dups) console.error(`  ${f}`);
    failed = true;
  }

  return failed;
}

// ── modes ──────────────────────────────────────────────────────────────

const isList = args.includes("--list");
const isCheck = args.includes("--check");
const shardFlag = parseFlag("--shard");
const checkShardTotal = parseFlag("--shard-total");

if (isList) {
  for (const f of discoverIntegrationFiles()) console.log(f);
  process.exit(0);
}

if (isCheck) {
  if (!checkShardTotal) die("--check requires --shard-total=N");
  const groupTotal = Number.parseInt(checkShardTotal, 10);
  if (!Number.isInteger(groupTotal) || groupTotal < 1) {
    die(`Invalid --shard-total: ${checkShardTotal}`);
  }

  const discovered = discoverIntegrationFiles();
  const manifest = readManifest();

  let failed = false;
  failed = checkMissingAndStale(discovered, manifest, "files") || failed;

  const groups = pack(discovered, manifest.files, groupTotal);
  failed = checkPackIntegrity(discovered, groups) || failed;

  console.error(`\nIntegration shard plan (${groupTotal} ways, ${discovered.length} files):`);
  printPlanSummary(groups);

  if (failed) die("Check failed");

  console.log(
    `Check OK — ${discovered.length} files, ${Object.keys(manifest.files).length} manifest entries.`,
  );
  process.exit(0);
}

if (shardFlag) {
  const shardMatch = shardFlag.match(/^(\d+)\/(\d+)$/);
  if (!shardMatch) die("Usage: --shard=N/M");
  const groupPos = Number.parseInt(shardMatch[1], 10);
  const groupTotal = Number.parseInt(shardMatch[2], 10);
  if (groupPos < 1 || groupPos > groupTotal) {
    die(`Shard index ${groupPos} out of range [1, ${groupTotal}]`);
  }

  const discovered = discoverIntegrationFiles();
  const manifest = readManifest();
  const groups = pack(discovered, manifest.files, groupTotal);
  const groupFiles = groups[groupPos - 1].files;

  console.error(`\nIntegration shard plan (${groupTotal} ways, ${discovered.length} files):`);
  printPlanSummary(groups);

  const out = groupFiles.join(" ").trim();
  if (out) console.log(out);
  process.exit(0);
}

die(`Usage:
  node scripts/ci-integration-shard.mjs --shard=N/M                 emit files for shard N of M
  node scripts/ci-integration-shard.mjs --check --shard-total=N    verify manifest is in sync
  node scripts/ci-integration-shard.mjs --list                      list all integration files`);
