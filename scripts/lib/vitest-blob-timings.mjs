// Shared helpers for reading per-file durations out of Vitest blob reports.
//
// CI uploads one `--reporter=blob` file per integration shard
// (.vitest-reports/blob-<i>-<n>.json, artifact `blob-report-<i>`). These blobs
// are Vitest's serializable internal format, meant to be re-merged. We decode
// them to recover each test file's wall-clock duration, then aggregate those
// durations across runs into timing samples.
//
// This module is the single source of truth for the blob decoder and the pure
// aggregation math, so the refresh tool and any local analysis script share one
// implementation.

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

// ── statistics (pure) ───────────────────────────────────────────────────

export function median(values) {
  if (values.length === 0) throw new Error("median() requires at least one value");
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Nearest-rank percentile: rank = ceil(p/100 * n), 1-indexed into the sorted
// set. Biases toward observed values (no interpolation), which is what we want
// for a worst-realistic file weight.
export function percentile(values, p) {
  if (values.length === 0) throw new Error("percentile() requires at least one value");
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1];
}

// ── blob parsing (pure given parsed input) ──────────────────────────────

// CI checks the repo out at <runner>/work/vinext/vinext, so blob filepaths look
// like /home/runner/work/vinext/vinext/tests/foo.test.ts. Strip everything up
// to and including the repo-name marker; fall back to the first `tests/`
// segment for other checkout layouts.
export function normalizeTestPath(filePath) {
  const marker = "/vinext/vinext/";
  const markerIndex = filePath.indexOf(marker);
  if (markerIndex !== -1) return filePath.slice(markerIndex + marker.length);
  const testsIndex = filePath.indexOf("/tests/");
  if (testsIndex !== -1) return filePath.slice(testsIndex + 1);
  return path.relative(process.cwd(), filePath);
}

// One blob's parsed `testFiles` array → one duration sample per file.
export function extractDurations(testFiles) {
  const durations = [];
  const warnings = [];

  for (const testFile of testFiles) {
    const file = normalizeTestPath(testFile.filepath);
    const durationMs = testFile.result?.duration;
    if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs <= 0) {
      warnings.push(`Skipped ${file}: blob report has no positive finite duration`);
      continue;
    }
    durations.push({ file, durationMs });
  }

  return { durations, warnings };
}

// Per-blob duration lists → file → samples across all blobs (one sample per
// blob the file appeared in). Keys are insertion-ordered; callers sort.
export function mergeSamples(perBlobDurations) {
  const samples = new Map();
  for (const durations of perBlobDurations) {
    for (const { file, durationMs } of durations) {
      const existing = samples.get(file);
      if (existing) existing.push(durationMs);
      else samples.set(file, [durationMs]);
    }
  }
  return samples;
}

// ── blob discovery + IO ─────────────────────────────────────────────────

export async function findBlobFiles(root) {
  const found = [];
  await walk(path.resolve(root));
  return found.sort((a, b) => a.localeCompare(b));

  async function walk(current) {
    const entryStat = await stat(current);
    if (entryStat.isFile()) {
      if (current.endsWith(".json")) found.push(current);
      return;
    }
    if (!entryStat.isDirectory()) return;
    for (const entry of await readdir(current)) await walk(path.join(current, entry));
  }
}

// Read + parse every blob under `dir` and aggregate into file → samples.
// Throws with a clear message if a file is not a recognizable blob.
export async function aggregateBlobDir(dir) {
  const blobFiles = await findBlobFiles(dir);
  if (blobFiles.length === 0) {
    throw new Error(`No Vitest blob JSON files found under ${dir}`);
  }

  const perBlob = [];
  const warnings = [];
  for (const file of blobFiles) {
    const [version, testFiles] = parseVitestBlob(await readFile(file, "utf8"));
    if (!version || !Array.isArray(testFiles)) {
      throw new Error(`${file} does not look like a Vitest blob report`);
    }
    const extracted = extractDurations(testFiles);
    perBlob.push(extracted.durations);
    for (const warning of extracted.warnings) warnings.push(`${file}: ${warning}`);
  }

  return { samples: mergeSamples(perBlob), blobCount: blobFiles.length, warnings };
}

// Vitest writes `--reporter=blob` files with `flatted`, a JSON dialect that
// stores every value once in a flat array and encodes shared or circular
// references as string indices into that array, so a plain `JSON.parse` leaves
// those references unresolved. Older Vite+ releases bundled a parser this module
// reached into by name; Vite+ 0.2.1 consumes upstream Vitest directly and no
// longer ships that bundle (and `flatted` is vendored inside Vitest rather than
// published as its own installable package), so we resolve the flat array here.
//
// The top-level array holds the literal values; any string that appears as an
// object field or array element is an index back into that array. Each entry is
// rebuilt lazily and memoized before recursing, so shared and circular
// references collapse back onto a single object.
export function parseVitestBlob(content) {
  const pool = JSON.parse(content);
  const resolved = new Map();

  function resolveValue(value) {
    return typeof value === "string" ? resolveIndex(Number(value)) : value;
  }

  function resolveIndex(index) {
    if (resolved.has(index)) return resolved.get(index);
    const raw = pool[index];
    if (raw === null || typeof raw !== "object") {
      resolved.set(index, raw);
      return raw;
    }
    // Object.keys() over an array yields its indices in order, so one loop
    // rebuilds arrays and objects alike.
    const out = Array.isArray(raw) ? [] : {};
    resolved.set(index, out);
    for (const key of Object.keys(raw)) out[key] = resolveValue(raw[key]);
    return out;
  }

  return resolveIndex(0);
}
