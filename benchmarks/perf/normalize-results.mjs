#!/usr/bin/env node

import { createReadStream } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createGunzip } from "node:zlib";

const inputPath = resolve(process.argv[2] ?? "benchmarks/results/perf-samples.jsonl");
const outputPath = resolve(process.argv[3] ?? "benchmarks/results/perf-results.json");
const profilesDirectory = resolve(process.argv[4] ?? "benchmarks/results/perf-profiles");

async function readGzipJson(path) {
  const chunks = [];
  for await (const chunk of createReadStream(path).pipe(createGunzip())) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function column(table, name, row) {
  if (Array.isArray(table?.[name])) return table[name][row];
  const index = table?.schema?.[name];
  return index === undefined ? undefined : table.data?.[row]?.[index];
}

function normalizeSource(source) {
  if (!source) return null;
  const withoutProtocol = source.replace(/^file:\/\//, "");
  const repositoryMarker = "/work/vinext/vinext/";
  const repositoryIndex = withoutProtocol.indexOf(repositoryMarker);
  if (repositoryIndex >= 0) {
    return withoutProtocol.slice(repositoryIndex + repositoryMarker.length);
  }
  const nodeModulesIndex = withoutProtocol.lastIndexOf("/node_modules/");
  if (nodeModulesIndex >= 0) return withoutProtocol.slice(nodeModulesIndex + 1);
  return withoutProtocol;
}

function frameCategory(source) {
  if (!source) return "native";
  if (source.startsWith("packages/vinext/") || source.includes("node_modules/vinext/")) {
    return "vinext";
  }
  if (source.includes("/rolldown/") || source.includes("rolldown-")) return "rolldown";
  if (source.includes("vite-plus-core/dist/vite/") || source.includes("node_modules/vite/")) {
    return "vite";
  }
  if (source.startsWith("node:")) return "node";
  if (source.startsWith("node_modules/")) return "dependency";
  if (source.startsWith("benchmarks/")) return "benchmark";
  return "application";
}

function parseFrame(rawName) {
  const cleanedName = rawName.replace(/^JS:[+*'^~]*/, "");
  const sourceMatch = cleanedName.match(/\s((?:file:\/\/|node:)[^\s]+)$/);
  const source = normalizeSource(sourceMatch?.[1] ?? null);
  const name = sourceMatch ? cleanedName.slice(0, sourceMatch.index).trim() : cleanedName;
  return {
    name: name || "(anonymous)",
    source,
    category: frameCategory(source),
  };
}

function stackFrames(tables, stackIndex) {
  const frames = [];
  const seen = new Set();
  while (stackIndex !== null && stackIndex !== undefined && !seen.has(stackIndex)) {
    seen.add(stackIndex);
    const frameIndex = column(tables.stackTable, "frame", stackIndex);
    const funcIndex = column(tables.frameTable, "func", frameIndex);
    const nameIndex = column(tables.funcTable, "name", funcIndex);
    const fallbackNameIndex = column(tables.frameTable, "location", frameIndex);
    const name = tables.stringArray?.[nameIndex ?? fallbackNameIndex];
    if (typeof name === "string" && name.length > 0) frames.push(parseFrame(name));
    stackIndex = column(tables.stackTable, "prefix", stackIndex);
  }
  return frames.reverse();
}

function addStack(root, frames, weight) {
  root.value += weight;
  let current = root;
  for (const frame of frames) {
    const key = `${frame.category}\0${frame.name}\0${frame.source ?? ""}`;
    let child = current.children.get(key);
    if (!child) {
      child = { ...frame, value: 0, children: new Map() };
      current.children.set(key, child);
    }
    child.value += weight;
    current = child;
  }
}

function ownedSubtree(node) {
  if (node.category === "vinext" || node.category === "vite" || node.category === "rolldown") {
    return true;
  }
  return Array.from(node.children.values()).some(ownedSubtree);
}

function serializeTree(node, depth = 0, budget = { remaining: 3000 }) {
  budget.remaining -= 1;
  if (depth >= 32 || budget.remaining <= 0) {
    return {
      name: node.name,
      value: node.value,
      ...(node.source ? { source: node.source } : {}),
      ...(node.category ? { category: node.category } : {}),
    };
  }
  const children = Array.from(node.children.values())
    .sort((left, right) => {
      const ownedDifference = Number(ownedSubtree(right)) - Number(ownedSubtree(left));
      return ownedDifference || right.value - left.value;
    })
    .slice(0, depth < 2 ? 40 : ownedSubtree(node) ? 40 : 20)
    .filter(() => budget.remaining > 0)
    .map((child) => serializeTree(child, depth + 1, budget));
  const serialized = {
    name: node.name,
    value: node.value,
    ...(node.source ? { source: node.source } : {}),
    ...(node.category ? { category: node.category } : {}),
  };
  return children.length > 0 ? { ...serialized, children } : serialized;
}

function profileToFlameGraph(profile) {
  const root = { name: "all samples", value: 0, children: new Map() };
  const sampleIntervalMs = Number(profile.meta?.interval ?? 1) || 1;
  for (const thread of profile.threads ?? []) {
    const tables = profile.shared ?? thread;
    if (!tables?.stackTable || !tables.frameTable || !tables.funcTable || !tables.stringArray) {
      continue;
    }
    const sampleLength = thread.samples?.length ?? thread.samples?.data?.length ?? 0;
    const usesSampleWeights = thread.samples?.weightType === "samples";
    for (let row = 0; row < sampleLength; row++) {
      const stackIndex = column(thread.samples, "stack", row);
      if (stackIndex === null || stackIndex === undefined) continue;
      const rawWeight = Math.abs(Number(column(thread.samples, "weight", row) ?? 1)) || 1;
      const weight = (usesSampleWeights ? rawWeight : 1) * sampleIntervalMs;
      const frames = stackFrames(tables, stackIndex);
      if (frames.length > 0) {
        const processName = thread.processName || thread.name || "unknown process";
        addStack(
          root,
          [{ name: processName, source: null, category: "process" }, ...frames],
          weight,
        );
      }
    }
  }
  return root.value > 0 ? serializeTree(root) : null;
}

async function loadFlameGraph(benchmarkId) {
  try {
    const profilePath = join(profilesDirectory, benchmarkId, "samply-profile.json.gz");
    await access(profilePath);
    const profile = await readGzipJson(profilePath);
    return profileToFlameGraph(profile);
  } catch (error) {
    console.warn(`No flame graph available for ${benchmarkId}: ${error.message}`);
    return null;
  }
}

function quantile(sorted, percentile) {
  if (sorted.length === 0) return null;
  const index = (sorted.length - 1) * percentile;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function summarize(values) {
  if (values.length === 0) throw new Error("Cannot summarize an empty sample set");
  const sorted = [...values].sort((left, right) => left - right);
  const mean = sorted.reduce((total, value) => total + value, 0) / sorted.length;
  const variance =
    sorted.reduce((total, value) => total + (value - mean) ** 2, 0) /
    Math.max(sorted.length - 1, 1);
  const q1 = quantile(sorted, 0.25);
  const q3 = quantile(sorted, 0.75);
  const iqr = q3 - q1;
  const lowerFence = q1 - iqr * 1.5;
  const upperFence = q3 + iqr * 1.5;

  return {
    rounds: sorted.length,
    mean,
    median: quantile(sorted, 0.5),
    standardDeviation: Math.sqrt(variance),
    min: sorted[0],
    max: sorted.at(-1),
    q1,
    q3,
    outliers: sorted.filter((value) => value < lowerFence || value > upperFence).length,
  };
}

async function main() {
  const contents = await readFile(inputPath, "utf8");
  const samples = contents
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

  const grouped = Map.groupBy(samples, (sample) => sample.benchmarkId);
  const benchmarks = await Promise.all(
    Array.from(grouped, async ([benchmarkId, group]) => ({
      benchmarkId,
      scenarioId: group[0].scenarioId,
      suite: group[0].suite,
      label: group[0].label,
      description: group[0].description,
      implementationId: group[0].implementationId,
      implementationLabel: group[0].implementationLabel,
      unit: group[0].unit,
      lowerIsBetter: group[0].lowerIsBetter,
      samples: summarize(group.map((sample) => sample.value)),
      flameGraph: group[0].profile ? await loadFlameGraph(benchmarkId) : null,
    })),
  );

  const payload = {
    schemaVersion: 1,
    provider: "samply",
    instrument: "walltime",
    run: {
      kind: process.env.VINEXT_PERF_RUN_KIND === "pull_request" ? "pull_request" : "main",
      commitSha: process.env.VINEXT_PERF_COMMIT_SHA ?? process.env.GITHUB_SHA ?? "local",
      baseSha: process.env.VINEXT_PERF_BASE_SHA || null,
      pullRequest: Number(process.env.VINEXT_PERF_PR_NUMBER) || null,
      executionId: process.env.VINEXT_PERF_EXECUTION_ID || `local:${Date.now()}`,
      measuredAt: new Date().toISOString(),
      repository: process.env.GITHUB_REPOSITORY ?? "cloudflare/vinext",
    },
    system: {
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      runner: process.env.RUNNER_NAME ?? "local",
    },
    benchmarks,
  };

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`Wrote ${benchmarks.length} normalized benchmarks to ${outputPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});
