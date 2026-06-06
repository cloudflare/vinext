// Shared helpers for reading per-file durations out of Vitest blob reports.
//
// CI uploads one `--reporter=blob` file per integration shard
// (.vitest-reports/blob-<i>-<n>.json, artifact `blob-report-<i>`). These blobs
// are Vitest's serializable internal format, meant to be re-merged. We parse
// them with Vite+'s bundled blob parser to recover each test file's wall-clock
// duration, then aggregate those durations across runs into timing samples.
//
// This module is the single source of truth for the (fragile) parser probe and
// the pure aggregation math, so the refresh tool and any local analysis script
// share one implementation instead of duplicating the probe.

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

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
  const parseBlob = await loadVitestBlobParser();
  const blobFiles = await findBlobFiles(dir);
  if (blobFiles.length === 0) {
    throw new Error(`No Vitest blob JSON files found under ${dir}`);
  }

  const perBlob = [];
  const warnings = [];
  for (const file of blobFiles) {
    const [version, testFiles] = parseBlob(await readFile(file, "utf8"));
    if (!version || !Array.isArray(testFiles)) {
      throw new Error(`${file} does not look like a Vitest blob report`);
    }
    const extracted = extractDurations(testFiles);
    perBlob.push(extracted.durations);
    for (const warning of extracted.warnings) warnings.push(`${file}: ${warning}`);
  }

  return { samples: mergeSamples(perBlob), blobCount: blobFiles.length, warnings };
}

// Locate Vite+'s bundled Vitest blob parser. This reaches into the published
// package's minified chunks, so it is deliberately defensive: when Vite+
// changes its bundle shape this throws a clear, actionable error rather than
// silently returning empty timings.
export async function loadVitestBlobParser() {
  const pnpmDir = path.resolve("node_modules/.pnpm");
  const entries = await readdir(pnpmDir).catch(() => []);
  const packageDirName = entries.find((entry) => entry.startsWith("@voidzero-dev+vite-plus-test@"));
  if (!packageDirName) {
    throw new Error(
      "Could not find @voidzero-dev/vite-plus-test under node_modules/.pnpm. Run `vp install` first.",
    );
  }

  const chunksDir = path.join(
    pnpmDir,
    packageDirName,
    "node_modules/@voidzero-dev/vite-plus-test/dist/chunks",
  );
  const chunks = await readdir(chunksDir);
  const indexChunks = chunks.filter((entry) => /^index\..*\.js$/.test(entry));
  if (indexChunks.length === 0) {
    throw new Error(`Could not find Vite+ test index chunk under ${chunksDir}`);
  }

  for (const indexChunk of indexChunks) {
    const mod = await import(pathToFileURL(path.join(chunksDir, indexChunk)).href);
    if (typeof mod.p === "function" && typeof mod.q === "function" && typeof mod.r === "function") {
      return mod.p;
    }
  }
  throw new Error(
    "Could not load the Vitest blob parser from @voidzero-dev/vite-plus-test. " +
      "Its bundle shape likely changed; update loadVitestBlobParser() in scripts/lib/vitest-blob-timings.mjs.",
  );
}
