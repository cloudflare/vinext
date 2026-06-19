#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { isAbsolute, normalize, relative, resolve, sep } from "node:path";
import { gunzip } from "node:zlib";
import { promisify } from "node:util";

const gunzipAsync = promisify(gunzip);
const requiredCategories = ["vinext", "vite", "rolldown"];

function column(table, name, row) {
  const direct = table?.[name];
  if (Array.isArray(direct)) return direct[row];
  const index = table?.schema?.[name];
  return index === undefined ? undefined : table?.data?.[row]?.[index];
}

function sourceCategory(rawName) {
  const cleanedName = rawName.replace(/^JS:[+*'^~]*/, "");
  const source = cleanedName
    .match(/\s((?:file:\/\/|node:)[^\s]+)$/)?.[1]
    ?.replace(/^file:\/\//, "");
  if (!source) return null;
  if (source.includes("/packages/vinext/") || source.includes("/node_modules/vinext/")) {
    return "vinext";
  }
  if (source.includes("/rolldown/") || source.includes("rolldown-")) return "rolldown";
  if (source.includes("vite-plus-core/dist/vite/") || source.includes("/node_modules/vite/")) {
    return "vite";
  }
  return null;
}

function sampledCategories(profile) {
  const categories = new Set();
  for (const thread of profile.threads ?? []) {
    const tables = profile.shared ? { ...thread, ...profile.shared } : thread;
    const sampleLength = thread.samples?.length ?? thread.samples?.data?.length ?? 0;
    for (let row = 0; row < sampleLength; row++) {
      const seen = new Set();
      let stackIndex = column(thread.samples, "stack", row);
      while (typeof stackIndex === "number" && !seen.has(stackIndex)) {
        seen.add(stackIndex);
        const frameIndex = column(tables.stackTable, "frame", stackIndex);
        if (typeof frameIndex !== "number") break;
        const functionIndex = column(tables.frameTable, "func", frameIndex);
        const nameIndex =
          typeof functionIndex === "number"
            ? column(tables.funcTable, "name", functionIndex)
            : column(tables.frameTable, "location", frameIndex);
        const rawName = typeof nameIndex === "number" ? tables.stringArray?.[nameIndex] : undefined;
        if (typeof rawName === "string") {
          const category = sourceCategory(rawName);
          if (category) categories.add(category);
        }
        stackIndex = column(tables.stackTable, "prefix", stackIndex);
      }
    }
  }
  return categories;
}

function profilePath(root, profileFile) {
  if (isAbsolute(profileFile)) throw new Error(`Profile path must be relative: ${profileFile}`);
  const path = resolve(root, normalize(profileFile));
  const relativePath = relative(root, path);
  if (relativePath === "" || relativePath.startsWith(`..${sep}`) || relativePath === "..") {
    throw new Error(`Profile path escapes the artifact root: ${profileFile}`);
  }
  return path;
}

async function validateProfile(path, benchmarkId) {
  const profile = JSON.parse((await gunzipAsync(await readFile(path))).toString("utf8"));
  const categories = sampledCategories(profile);
  console.log(`${benchmarkId}: sampled ${[...categories].join(", ") || "no required"} frames`);
  return categories;
}

async function main() {
  const resultsPath = process.argv[2];
  const artifactRoot = resolve(process.argv[3] ?? ".");
  if (!resultsPath)
    throw new Error("Usage: validate-profile-traces.mjs <results.json> [artifact-root]");
  const results = JSON.parse(await readFile(resultsPath, "utf8"));
  const profiles = (results.benchmarks ?? []).filter((benchmark) => benchmark.profileFile);
  if (profiles.length === 0) throw new Error("Performance results contain no diagnostic profiles");
  const categorySets = await Promise.all(
    profiles.map((benchmark) =>
      validateProfile(profilePath(artifactRoot, benchmark.profileFile), benchmark.benchmarkId),
    ),
  );
  const categories = new Set(categorySets.flatMap((categorySet) => [...categorySet]));
  const missing = requiredCategories.filter((category) => !categories.has(category));
  if (missing.length > 0) {
    throw new Error(`Performance profiles are missing sampled ${missing.join(", ")} frames`);
  }
  console.log(`Performance profiles sampled ${requiredCategories.join(", ")} frames`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});
