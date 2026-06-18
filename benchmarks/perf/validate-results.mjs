#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

const inputPath = resolve(process.argv[2] ?? "performance-artifact/perf-results.json");
const artifactRoot = dirname(inputPath);
const repository = process.env.GITHUB_REPOSITORY ?? "cloudflare/vinext";
const sourceEvent = requiredEnvironment("VINEXT_PERF_SOURCE_EVENT");
const sourceRunId = requiredEnvironment("VINEXT_PERF_SOURCE_RUN_ID");
const sourceRunAttempt = requiredEnvironment("VINEXT_PERF_SOURCE_RUN_ATTEMPT");
const sourceRun = githubApi(`repos/${repository}/actions/runs/${sourceRunId}`);
let totalProfileBytes = 0;

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function isSha(value) {
  return typeof value === "string" && /^[0-9a-f]{40}$/i.test(value);
}

function githubApi(path) {
  const token = requiredEnvironment("GITHUB_TOKEN");
  return JSON.parse(
    execFileSync("gh", ["api", path], {
      encoding: "utf8",
      env: { ...process.env, GH_TOKEN: token },
    }),
  );
}

async function validateProfilePath(profileFile) {
  assert(typeof profileFile === "string" && profileFile.length > 0, "Invalid profile path");
  assert(!isAbsolute(profileFile), "Artifact profile paths must be relative");
  assert(
    /^perf-profiles\/[a-zA-Z0-9._:-]+\/samply-profile\.json\.gz$/.test(profileFile),
    `Unexpected profile path: ${profileFile}`,
  );
  const profilePath = resolve(artifactRoot, profileFile);
  const artifactRelativePath = relative(artifactRoot, profilePath);
  assert(
    !artifactRelativePath.startsWith("..") && !isAbsolute(artifactRelativePath),
    "Artifact profile path escapes the artifact directory",
  );
  const stats = await lstat(profilePath);
  assert(
    stats.isFile() && !stats.isSymbolicLink(),
    `Profile is not a regular file: ${profileFile}`,
  );
  assert(stats.size <= 100 * 1024 * 1024, `Profile is too large: ${profileFile}`);
  totalProfileBytes += stats.size;
  assert(totalProfileBytes <= 300 * 1024 * 1024, "Combined profiles are too large");
  const realProfilePath = await realpath(profilePath);
  const realArtifactRoot = await realpath(artifactRoot);
  const realRelativePath = relative(realArtifactRoot, realProfilePath);
  assert(
    !realRelativePath.startsWith("..") && !isAbsolute(realRelativePath),
    "Profile resolves outside the artifact directory",
  );
}

const resultsStats = await lstat(inputPath);
assert(
  resultsStats.isFile() && !resultsStats.isSymbolicLink(),
  "Performance results are not a regular file",
);
assert(resultsStats.size <= 1024 * 1024, "Performance results are too large");
const payload = JSON.parse(await readFile(inputPath, "utf8"));
assert(sourceRun.path === ".github/workflows/perf.yml", "Unexpected source workflow");
assert(sourceRun.status === "completed" && sourceRun.conclusion === "success", "Source run failed");
assert(sourceRun.event === sourceEvent, "Source event does not match workflow run");
assert(sourceRun.run_attempt === Number(sourceRunAttempt), "Source run attempt does not match");
assert(payload.schemaVersion === 1, "Unsupported performance schema");
assert(payload.provider === "samply", "Unexpected performance provider");
assert(payload.instrument === "walltime", "Unexpected performance instrument");
assert(payload.run?.repository === repository, "Performance repository does not match workflow");
assert(isSha(payload.run?.commitSha), "Performance commit SHA must be complete");
assert(
  payload.run.executionId === `${sourceRunId}:${sourceRunAttempt}`,
  "Performance execution ID does not match workflow run",
);
assert(Array.isArray(payload.benchmarks), "Performance benchmarks must be an array");
assert(
  payload.benchmarks.length > 0 && payload.benchmarks.length <= 100,
  "Invalid benchmark count",
);

const benchmarkIds = new Set();
for (const benchmark of payload.benchmarks) {
  assert(
    typeof benchmark.benchmarkId === "string" && /^[a-zA-Z0-9._:-]+$/.test(benchmark.benchmarkId),
    "Invalid benchmark ID",
  );
  assert(!benchmarkIds.has(benchmark.benchmarkId), `Duplicate benchmark: ${benchmark.benchmarkId}`);
  benchmarkIds.add(benchmark.benchmarkId);
  for (const field of [
    "scenarioId",
    "suite",
    "label",
    "implementationId",
    "implementationLabel",
    "unit",
  ]) {
    assert(
      typeof benchmark[field] === "string" &&
        benchmark[field].length > 0 &&
        benchmark[field].length <= 200,
      `Invalid ${field}`,
    );
  }
  assert(
    typeof benchmark.description === "string" && benchmark.description.length <= 2_000,
    "Invalid benchmark description",
  );
  assert(typeof benchmark.lowerIsBetter === "boolean", "Invalid benchmark direction");
  assert(benchmark.profileObjectKey === undefined, "Artifacts may not provide profile object keys");
  assert(
    benchmark.samples &&
      Number.isInteger(benchmark.samples.rounds) &&
      benchmark.samples.rounds > 0 &&
      benchmark.samples.rounds <= 1_000 &&
      ["mean", "median", "standardDeviation", "min", "max", "q1", "q3"].every(
        (field) => Number.isFinite(benchmark.samples[field]) && benchmark.samples[field] >= 0,
      ),
    `Invalid samples for ${benchmark.benchmarkId}`,
  );
  assert(
    benchmark.samples.min <= benchmark.samples.median &&
      benchmark.samples.median <= benchmark.samples.max &&
      benchmark.samples.min <= benchmark.samples.mean &&
      benchmark.samples.mean <= benchmark.samples.max,
    `Inconsistent samples for ${benchmark.benchmarkId}`,
  );
  if (benchmark.profileFile !== null && benchmark.profileFile !== undefined) {
    await validateProfilePath(benchmark.profileFile);
  }
}

if (sourceEvent === "pull_request") {
  const pullRequest = sourceRun.pull_requests?.[0];
  assert(pullRequest, "Source workflow run is not associated with a pull request");
  assert(payload.run.kind === "pull_request", "Pull request workflow produced a non-PR run");
  assert(
    payload.run.pullRequest === pullRequest.number,
    "Pull request number does not match workflow run",
  );
  assert(
    payload.run.commitSha === pullRequest.head.sha,
    "Pull request head SHA does not match workflow run",
  );
  assert(
    payload.run.baseSha === pullRequest.base.sha,
    "Pull request base SHA does not match workflow run",
  );
} else if (sourceEvent === "push") {
  assert(payload.run.kind === "main", "Push workflow produced a non-main run");
  assert(
    payload.run.commitSha === sourceRun.head_sha,
    "Push commit SHA does not match workflow run",
  );
  assert(
    payload.run.baseSha === null && payload.run.pullRequest === null,
    "Main run has PR metadata",
  );
} else if (sourceEvent === "workflow_dispatch") {
  if (payload.run.kind === "pull_request") {
    assert(
      Number.isInteger(payload.run.pullRequest) && payload.run.pullRequest > 0,
      "Invalid PR number",
    );
    const pullRequest = githubApi(`repos/${repository}/pulls/${payload.run.pullRequest}`);
    assert(
      payload.run.commitSha === pullRequest.head.sha,
      "Dispatched PR head SHA is stale or invalid",
    );
    assert(
      payload.run.baseSha === pullRequest.base.sha,
      "Dispatched PR base SHA is stale or invalid",
    );
  } else {
    assert(payload.run.kind === "main", "Invalid dispatched run kind");
    execFileSync("git", ["fetch", "--no-tags", "origin", "main"], { stdio: "inherit" });
    execFileSync("git", ["merge-base", "--is-ancestor", payload.run.commitSha, "origin/main"]);
    assert(
      payload.run.baseSha === null && payload.run.pullRequest === null,
      "Main run has PR metadata",
    );
  }
} else {
  throw new Error(`Unsupported source event: ${sourceEvent}`);
}

console.log(`Validated ${payload.benchmarks.length} benchmarks for ${payload.run.commitSha}`);
