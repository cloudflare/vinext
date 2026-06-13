// Pure planning logic for the integration shard matrix: manifest schema
// validation, weight lookup, balanced bin-packing, and the CI gate checks.
//
// The committed manifest (scripts/ci-integration-timings.json) records per-file
// timing provenance. The planner only consumes `estimateMs`; the median/p75/
// samples fields exist so a reviewer can trust where each weight came from.

import { median, percentile } from "./vitest-blob-timings.mjs";

export const MANIFEST_VERSION = 2;
export const SUITE = "integration";
export const ESTIMATOR_METRIC = "p75";

// Weight used when the planner meets a file with no manifest entry. The CI
// `--check` gate warns on such files, so newly added tests keep running until
// the manifest is refreshed with real timings.
export const DEFAULT_TIMING_MS = 5_000;

// ── manifest → weights ──────────────────────────────────────────────────

export function manifestWeights(manifest) {
  const weights = new Map();
  for (const [file, entry] of Object.entries(manifest.files)) {
    weights.set(file, entry.estimateMs);
  }
  return weights;
}

function weightOf(weights, file) {
  return weights.get(file) ?? DEFAULT_TIMING_MS;
}

// ── manifest validation ─────────────────────────────────────────────────

// Returns a list of human-readable errors. Empty list means valid. Pure: never
// exits or logs, so callers control reporting.
export function validateManifest(manifest) {
  const errors = [];

  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
    return ["Timing manifest must be a JSON object"];
  }
  if (manifest.version !== MANIFEST_VERSION) {
    errors.push(
      `Manifest version must be ${MANIFEST_VERSION}, got ${JSON.stringify(manifest.version)}`,
    );
  }
  if (manifest.suite !== SUITE) {
    errors.push(`Manifest suite must be "${SUITE}", got ${JSON.stringify(manifest.suite)}`);
  }
  if (!Number.isInteger(manifest.shardTotal) || manifest.shardTotal < 1) {
    errors.push(
      `Manifest shardTotal must be a positive integer, got ${JSON.stringify(manifest.shardTotal)}`,
    );
  }
  if (typeof manifest.generatedAt !== "string" || manifest.generatedAt.length === 0) {
    errors.push("Manifest generatedAt must be a non-empty ISO timestamp");
  }
  const runs = manifest.generatedFrom?.runs;
  if (!Array.isArray(runs) || runs.length === 0) {
    errors.push(
      "Manifest generatedFrom.runs must list at least one source CI run (provenance is required)",
    );
  }
  if (manifest.estimator?.metric !== ESTIMATOR_METRIC) {
    errors.push(
      `Manifest estimator.metric must be "${ESTIMATOR_METRIC}", got ${JSON.stringify(manifest.estimator?.metric)}`,
    );
  }

  if (
    typeof manifest.files !== "object" ||
    manifest.files === null ||
    Array.isArray(manifest.files)
  ) {
    errors.push("Manifest must contain a 'files' map");
    return errors;
  }
  const fileEntries = Object.entries(manifest.files);
  if (fileEntries.length === 0) {
    errors.push("Manifest 'files' map is empty");
  }
  for (const [file, entry] of fileEntries) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      errors.push(`Malformed timing for ${file}: must be an object with estimateMs`);
      continue;
    }
    errors.push(...positiveIntFieldErrors(file, entry, "estimateMs"));
    errors.push(...positiveIntFieldErrors(file, entry, "p75Ms"));
    errors.push(...positiveIntFieldErrors(file, entry, "medianMs"));
    if (!Number.isInteger(entry.samples) || entry.samples < 1) {
      errors.push(
        `Invalid samples for ${file}: must be a positive integer, got ${JSON.stringify(entry.samples)}`,
      );
    }
  }

  return errors;
}

function positiveIntFieldErrors(file, entry, field) {
  const value = entry[field];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return [`Invalid ${field} for ${file}: must be a finite number, got ${JSON.stringify(value)}`];
  }
  if (!Number.isInteger(value)) return [`Invalid ${field} for ${file}: ${value} is not an integer`];
  if (value <= 0) return [`Invalid ${field} for ${file}: ${value} is not positive`];
  return [];
}

// ── bin packing ─────────────────────────────────────────────────────────

function groupLoad(group, weights) {
  let total = 0;
  for (const file of group.files) total += weightOf(weights, file);
  return total;
}

function makespan(groups, weights) {
  let max = 0;
  for (const group of groups) max = Math.max(max, groupLoad(group, weights));
  return max;
}

// Longest-processing-time greedy: assign heaviest files first to the currently
// lightest shard. A binary min-heap keyed by (load, index) finds the lightest
// shard in O(log m) instead of scanning all shards per file, so packing is
// O(n log m) overall. Ties break on lowest shard index for determinism.
export function greedyPack(files, weights, groupTotal) {
  const groups = Array.from({ length: groupTotal }, (_, index) => ({ index, files: [] }));
  const heap = new MinHeap((a, b) => a.load - b.load || a.index - b.index);
  for (const group of groups) heap.push({ load: 0, index: group.index });

  const ordered = [...files].sort((a, b) => {
    const diff = weightOf(weights, b) - weightOf(weights, a);
    return diff !== 0 ? diff : a.localeCompare(b);
  });

  for (const file of ordered) {
    const lightest = heap.pop();
    groups[lightest.index].files.push(file);
    lightest.load += weightOf(weights, file);
    heap.push(lightest);
  }

  return groups;
}

// Deterministic local search that lowers the makespan after the greedy seed.
// Each round targets the single heaviest shard and tries the cheapest fix that
// strictly reduces the global max: move one file out, swap one file, then swap
// two files. All three reduce to "transfer a set out of A and a set into A from
// B"; `makespanAfter` scores any such transfer from a single primitive.
export function localImprove(groups, weights) {
  for (;;) {
    const currentMax = makespan(groups, weights);
    const byLoad = [...groups].sort(
      (a, b) => groupLoad(b, weights) - groupLoad(a, weights) || a.index - b.index,
    );
    const heavy = byLoad[0];

    const improvement =
      firstImprovingTransfer(
        groups,
        weights,
        currentMax,
        moveOneFileCandidates(heavy, byLoad, weights),
      ) ??
      firstImprovingTransfer(
        groups,
        weights,
        currentMax,
        swapOneFileCandidates(heavy, byLoad, weights),
      ) ??
      firstImprovingTransfer(
        groups,
        weights,
        currentMax,
        swapTwoFileCandidates(heavy, byLoad, weights),
      );

    if (!improvement) break;
    transfer(improvement.from, improvement.to, improvement.outFiles, improvement.inFiles);
  }
}

function firstImprovingTransfer(groups, weights, currentMax, candidates) {
  for (const candidate of candidates) {
    if (
      makespanAfter(
        groups,
        candidate.from,
        candidate.to,
        candidate.outMs,
        candidate.inMs,
        weights,
      ) < currentMax
    ) {
      return candidate;
    }
  }
  return null;
}

function* moveOneFileCandidates(heavy, byLoad, weights) {
  for (let i = byLoad.length - 1; i >= 1; i--) {
    const other = byLoad[i];
    for (const file of heaviestFirst(heavy.files, weights)) {
      yield transferCandidate(heavy, other, [file], [], weights);
    }
  }
}

function* swapOneFileCandidates(heavy, byLoad, weights) {
  for (let i = byLoad.length - 1; i >= 1; i--) {
    const other = byLoad[i];
    for (const out of heaviestFirst(heavy.files, weights)) {
      const dOut = weightOf(weights, out);
      for (const back of lightestFirst(other.files, weights)) {
        const dIn = weightOf(weights, back);
        if (dIn >= dOut) break;
        yield transferCandidate(heavy, other, [out], [back], weights);
      }
    }
  }
}

function* swapTwoFileCandidates(heavy, byLoad, weights) {
  const light = byLoad[byLoad.length - 1];
  if (heavy.index === light.index || heavy.files.length < 2 || light.files.length < 2) return;

  const outs = heaviestFirst(heavy.files, weights).slice(0, 4);
  const backs = lightestFirst(light.files, weights).slice(0, 4);
  for (let a = 0; a < outs.length; a++) {
    for (let b = a + 1; b < outs.length; b++) {
      for (let c = 0; c < backs.length; c++) {
        for (let d = c + 1; d < backs.length; d++) {
          yield transferCandidate(heavy, light, [outs[a], outs[b]], [backs[c], backs[d]], weights);
        }
      }
    }
  }
}

function transferCandidate(from, to, outFiles, inFiles, weights) {
  return {
    from,
    to,
    outFiles,
    inFiles,
    outMs: filesLoad(outFiles, weights),
    inMs: filesLoad(inFiles, weights),
  };
}

function filesLoad(files, weights) {
  return files.reduce((total, file) => total + weightOf(weights, file), 0);
}

// Makespan if `dOut` ms moves out of A and `dIn` ms moves in (B is the inverse).
function makespanAfter(groups, a, b, dOut, dIn, weights) {
  let max = 0;
  for (const group of groups) {
    let load = groupLoad(group, weights);
    if (group.index === a.index) load += dIn - dOut;
    else if (group.index === b.index) load += dOut - dIn;
    max = Math.max(max, load);
  }
  return max;
}

function transfer(a, b, outFiles, inFiles) {
  a.files = a.files.filter((f) => !outFiles.includes(f));
  b.files = b.files.filter((f) => !inFiles.includes(f));
  a.files.push(...inFiles);
  b.files.push(...outFiles);
}

function heaviestFirst(files, weights) {
  return [...files].sort(
    (a, b) => weightOf(weights, b) - weightOf(weights, a) || a.localeCompare(b),
  );
}

function lightestFirst(files, weights) {
  return [...files].sort(
    (a, b) => weightOf(weights, a) - weightOf(weights, b) || a.localeCompare(b),
  );
}

export function pack(files, weights, groupTotal) {
  const groups = greedyPack(files, weights, groupTotal);
  if (groupTotal >= 2) localImprove(groups, weights);
  return groups;
}

// Advisory shard-count model. Sweeps candidate counts and estimates the
// integration critical path (one shard's fixed overhead + its test load +
// the merge/report job). It deliberately does NOT drive CI: the count stays a
// declarative manual choice in the manifest, because the real CI wall-clock is
// gated by whichever job is slowest overall (often app-router E2E or unit), and
// adding integration shards past that competing bottleneck buys ~0 wall-clock
// while burning runner minutes. Pass targetMs (the competing bottleneck) to get
// a concrete recommendation: the smallest count that drops integration at or
// below it.
export function recommendShardCount({ files, weights, maxShards, overheadMs, reportMs, targetMs }) {
  const totalMs = files.reduce((sum, f) => sum + weightOf(weights, f), 0);
  const rows = [];
  for (let shards = 1; shards <= maxShards; shards++) {
    const groups = pack(files, weights, shards);
    const maxGroupMs = makespan(groups, weights);
    const criticalPathMs = overheadMs + maxGroupMs + reportMs;
    const runnerMs = totalMs + shards * overheadMs + reportMs;
    const meetsTarget = targetMs !== undefined && criticalPathMs <= targetMs;
    rows.push({ shards, maxGroupMs, criticalPathMs, runnerMs, meetsTarget });
  }

  // With a competing bottleneck, the smallest count that reaches it is optimal:
  // fewer shards miss it, more shards only add cost. Without one, fall back to
  // the lowest critical path (the maximum sweep), but the caller should prefer
  // passing a target.
  const recommended =
    targetMs === undefined
      ? rows[rows.length - 1].shards
      : (rows.find((r) => r.meetsTarget)?.shards ?? rows[rows.length - 1].shards);

  return { rows, recommended, targetMs };
}

export function planSummary(groups, weights) {
  return groups.map((group) => {
    const head = group.files.slice(0, 3).join(" ");
    const rest = group.files.length > 3 ? ` +${group.files.length - 3} more` : "";
    return `${group.index + 1}/${groups.length}  ${Math.round(groupLoad(group, weights) / 1000)}s  ${head}${rest}`;
  });
}

// ── CI gate ─────────────────────────────────────────────────────────────

// `errors` are fail-closed structural invariants (bad schema, shard-count
// drift, zero discovery, dropped/duplicated file). `warnings` are weight-
// freshness drift (unknown or stale file): they degrade balance, not
// correctness, so adding/removing a test must not red CI. Pure.
export function checkPlan({ discovered, manifest, shardTotal }) {
  const errors = [];
  const warnings = [];

  if (discovered.length === 0) {
    errors.push("Discovered zero integration test files — something is wrong");
  }

  errors.push(...validateManifest(manifest));

  // Schema must be sound before comparing file sets / packing.
  if (errors.length > 0) return { errors, warnings, groups: [] };

  if (manifest.shardTotal !== shardTotal) {
    errors.push(
      `Shard-count drift: manifest shardTotal is ${manifest.shardTotal} but CI requested ${shardTotal}. ` +
        "Refresh the manifest with --shard-total matching the matrix.",
    );
  }

  const manifestFiles = Object.keys(manifest.files);
  const missing = discovered.filter((f) => !(f in manifest.files));
  for (const f of missing) {
    warnings.push(
      `No timing for ${f}: packed at ${DEFAULT_TIMING_MS}ms until the manifest is refreshed`,
    );
  }
  const stale = manifestFiles.filter((f) => !discovered.includes(f));
  for (const f of stale) {
    warnings.push(`Stale manifest entry (no longer discovered): ${f}, drop on next refresh`);
  }

  const weights = manifestWeights(manifest);
  const groups = pack(discovered, weights, shardTotal);

  // Bucket coverage: every discovered file lands in exactly one shard.
  const placed = groups.flatMap((g) => g.files);
  const placedSet = new Set();
  for (const f of placed) {
    if (placedSet.has(f)) errors.push(`Duplicate file in packed output: ${f}`);
    placedSet.add(f);
  }
  for (const f of discovered) {
    if (!placedSet.has(f)) errors.push(`File dropped during packing: ${f}`);
  }

  return { errors, warnings, groups };
}

// ── manifest building (refresh) ─────────────────────────────────────────

// Build a deterministic v2 manifest from aggregated timing samples. File keys
// are sorted so the serialized bytes are stable given the same inputs.
export function buildManifest({ samples, shardTotal, runs, generatedAt }) {
  const files = {};
  for (const file of [...samples.keys()].sort((a, b) => a.localeCompare(b))) {
    const durations = samples.get(file);
    const p75 = Math.round(percentile(durations, 75));
    files[file] = {
      estimateMs: p75,
      medianMs: Math.round(median(durations)),
      p75Ms: p75,
      samples: durations.length,
    };
  }

  return {
    version: MANIFEST_VERSION,
    suite: SUITE,
    shardTotal,
    generatedAt,
    generatedFrom: { runs },
    estimator: { metric: ESTIMATOR_METRIC },
    files,
  };
}

// ── tiny binary min-heap ────────────────────────────────────────────────

class MinHeap {
  constructor(compare) {
    this.compare = compare;
    this.items = [];
  }

  get size() {
    return this.items.length;
  }

  push(item) {
    const items = this.items;
    items.push(item);
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.compare(items[i], items[parent]) >= 0) break;
      [items[i], items[parent]] = [items[parent], items[i]];
      i = parent;
    }
  }

  pop() {
    const items = this.items;
    const top = items[0];
    const last = items.pop();
    if (items.length > 0) {
      items[0] = last;
      let i = 0;
      for (;;) {
        const left = 2 * i + 1;
        const right = 2 * i + 2;
        let smallest = i;
        if (left < items.length && this.compare(items[left], items[smallest]) < 0) smallest = left;
        if (right < items.length && this.compare(items[right], items[smallest]) < 0)
          smallest = right;
        if (smallest === i) break;
        [items[i], items[smallest]] = [items[smallest], items[i]];
        i = smallest;
      }
    }
    return top;
  }
}
