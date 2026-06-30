#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";
import { nextjsInputFingerprint } from "./nextjs-input-fingerprint.mts";

const inputPath = resolve(process.argv[2] ?? "performance-artifact/perf-results.json");
const artifactRoot = dirname(inputPath);
const repository = process.env.GITHUB_REPOSITORY ?? "cloudflare/vinext";
const sourceEvent = requiredEnvironment("VINEXT_PERF_SOURCE_EVENT");
const sourceRunId = requiredEnvironment("VINEXT_PERF_SOURCE_RUN_ID");
const sourceRunAttempt = requiredEnvironment("VINEXT_PERF_SOURCE_RUN_ATTEMPT");
const sourceRun = githubApi(`repos/${repository}/actions/runs/${sourceRunId}`);
let totalProfileBytes = 0;
const gunzipAsync = promisify(gunzip);
const MAX_PROFILE_ROWS = 2_000_000;
const MAX_PROFILE_STRINGS = 500_000;
const MAX_PROFILE_STRING_LENGTH = 16_384;
const MAX_PROFILE_STACK_DEPTH = 2_000;
const MAX_PROFILE_EXPANDED_FRAMES = 10_000_000;

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

function remoteNextjsInputFingerprint(repositoryName, ref) {
  const tree = githubApi(
    `repos/${repositoryName}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
  );
  assert(Array.isArray(tree.tree) && tree.truncated !== true, "Invalid repository tree");
  return nextjsInputFingerprint(tree.tree);
}

function trustedScenarioManifest(ref) {
  assert(isSha(ref), "Trusted benchmark manifest ref must be a complete SHA");
  const file = githubApi(
    `repos/${repository}/contents/benchmarks/perf/scenarios.json?ref=${encodeURIComponent(ref)}`,
  );
  assert(file.type === "file" && file.encoding === "base64", "Invalid benchmark manifest response");
  const manifest = JSON.parse(Buffer.from(file.content, "base64").toString("utf8"));
  assert(manifest && typeof manifest === "object", "Invalid benchmark manifest");
  assert(Array.isArray(manifest.scenarios), "Benchmark manifest has no scenarios");
  assert(
    manifest.scenarios.length > 0 && manifest.scenarios.length <= 100,
    "Invalid benchmark manifest scenario count",
  );
  return manifest.scenarios;
}

function benchmarkId(scenario, implementation) {
  return `${implementation.id}-${scenario.id}`;
}

function validateSamples(samples, benchmarkId, label) {
  assert(
    samples &&
      Number.isInteger(samples.rounds) &&
      samples.rounds > 0 &&
      samples.rounds <= 1_000 &&
      ["mean", "median", "standardDeviation", "min", "max", "q1", "q3"].every(
        (field) => Number.isFinite(samples[field]) && samples[field] >= 0,
      ),
    `Invalid ${label} samples for ${benchmarkId}`,
  );
  assert(
    samples.min <= samples.median &&
      samples.median <= samples.max &&
      samples.min <= samples.mean &&
      samples.mean <= samples.max,
    `Inconsistent ${label} samples for ${benchmarkId}`,
  );
}

function tableRowCount(table, label) {
  if (table === undefined) return 0;
  assert(table && typeof table === "object", `Invalid ${label}`);
  if (table.schema !== undefined) {
    assert(table.schema && typeof table.schema === "object", `Invalid ${label} schema`);
    for (const index of Object.values(table.schema)) {
      assert(Number.isInteger(index) && index >= 0 && index <= 1_000, `Invalid ${label} column`);
    }
  }
  if (table.data !== undefined) {
    assert(Array.isArray(table.data), `Invalid ${label} rows`);
    assert(
      table.data.every((row) => Array.isArray(row)),
      `Invalid ${label} row`,
    );
  }
  const directColumns = Object.entries(table).filter(
    ([key, value]) =>
      key !== "schema" && key !== "data" && key !== "length" && Array.isArray(value),
  );
  const lengths = [
    ...(Array.isArray(table.data) ? [table.data.length] : []),
    ...directColumns.map(([, value]) => value.length),
  ];
  const rowCount = lengths.length > 0 ? Math.max(...lengths) : 0;
  assert(
    lengths.every((length) => length === rowCount),
    `Mismatched ${label} column lengths`,
  );
  if (table.length !== undefined) {
    assert(Number.isInteger(table.length) && table.length === rowCount, `Invalid ${label} length`);
  }
  return rowCount;
}

function tableColumn(table, columnName, row) {
  const direct = table?.[columnName];
  if (Array.isArray(direct)) return direct[row];
  const columnIndex = table?.schema?.[columnName];
  return columnIndex === undefined ? undefined : table?.data?.[row]?.[columnIndex];
}

function validOptionalIndex(value, rowCount) {
  return (
    value === null ||
    value === undefined ||
    (Number.isInteger(value) && value >= 0 && value < rowCount)
  );
}

function validateProfileTables(profile, profileFile) {
  let totalRows = 0;
  let totalStrings = 0;
  let totalExpandedFrames = 0;
  const shared = profile.shared ?? {};
  for (const tableName of ["stackTable", "frameTable", "funcTable"]) {
    totalRows += tableRowCount(shared[tableName], `${profileFile} shared ${tableName}`);
  }
  if (shared.stringArray !== undefined) {
    assert(Array.isArray(shared.stringArray), `Invalid shared string table: ${profileFile}`);
    assert(
      shared.stringArray.every((value) => typeof value === "string"),
      `Invalid profile string`,
    );
    assert(
      shared.stringArray.every((value) => value.length <= MAX_PROFILE_STRING_LENGTH),
      `Profile string is too long: ${profileFile}`,
    );
    totalStrings += shared.stringArray.length;
  }
  for (const [threadIndex, thread] of profile.threads.entries()) {
    assert(thread && typeof thread === "object", `Invalid thread ${threadIndex}: ${profileFile}`);
    totalRows += tableRowCount(thread.samples, `${profileFile} samples`);
    for (const tableName of ["stackTable", "frameTable", "funcTable"]) {
      if (shared[tableName] === undefined) {
        totalRows += tableRowCount(thread[tableName], `${profileFile} ${tableName}`);
      }
    }
    const strings = shared.stringArray === undefined ? thread.stringArray : undefined;
    if (strings !== undefined) {
      assert(Array.isArray(strings), `Invalid string table: ${profileFile}`);
      assert(
        strings.every((value) => typeof value === "string"),
        `Invalid profile string`,
      );
      assert(
        strings.every((value) => value.length <= MAX_PROFILE_STRING_LENGTH),
        `Profile string is too long: ${profileFile}`,
      );
      totalStrings += strings.length;
    }

    const stackTable = shared.stackTable ?? thread.stackTable;
    const frameTable = shared.frameTable ?? thread.frameTable;
    const funcTable = shared.funcTable ?? thread.funcTable;
    const stringArray = shared.stringArray ?? thread.stringArray ?? [];
    const stackRows = tableRowCount(stackTable, `${profileFile} stackTable references`);
    const frameRows = tableRowCount(frameTable, `${profileFile} frameTable references`);
    const funcRows = tableRowCount(funcTable, `${profileFile} funcTable references`);
    const sampleRows = tableRowCount(thread.samples, `${profileFile} sample references`);
    const stackDepths = new Map();

    function stackDepth(initialStackIndex) {
      if (stackDepths.has(initialStackIndex)) return stackDepths.get(initialStackIndex);
      let stackIndex = initialStackIndex;
      const path = [];
      const seen = new Set();
      while (stackIndex !== null && stackIndex !== undefined) {
        assert(
          Number.isInteger(stackIndex) && stackIndex >= 0 && stackIndex < stackRows,
          `Invalid stack reference: ${profileFile}`,
        );
        if (stackDepths.has(stackIndex)) break;
        assert(!seen.has(stackIndex), `Cyclic stack reference: ${profileFile}`);
        seen.add(stackIndex);
        path.push(stackIndex);
        assert(path.length <= MAX_PROFILE_STACK_DEPTH, `Profile stack is too deep: ${profileFile}`);
        const frameIndex = tableColumn(stackTable, "frame", stackIndex);
        assert(
          Number.isInteger(frameIndex) && frameIndex >= 0 && frameIndex < frameRows,
          `Invalid stack frame reference: ${profileFile}`,
        );
        stackIndex = tableColumn(stackTable, "prefix", stackIndex);
      }
      let depth = stackIndex === null || stackIndex === undefined ? 0 : stackDepths.get(stackIndex);
      while (path.length > 0) {
        assert(
          depth + path.length <= MAX_PROFILE_STACK_DEPTH,
          `Profile stack is too deep: ${profileFile}`,
        );
        depth += 1;
        stackDepths.set(path.pop(), depth);
      }
      return stackDepths.get(initialStackIndex);
    }

    for (let row = 0; row < frameRows; row++) {
      assert(
        validOptionalIndex(tableColumn(frameTable, "func", row), funcRows),
        `Invalid frame function reference: ${profileFile}`,
      );
      assert(
        validOptionalIndex(tableColumn(frameTable, "location", row), stringArray.length),
        `Invalid frame location reference: ${profileFile}`,
      );
    }
    for (let row = 0; row < funcRows; row++) {
      assert(
        validOptionalIndex(tableColumn(funcTable, "name", row), stringArray.length),
        `Invalid function name reference: ${profileFile}`,
      );
    }
    for (let row = 0; row < sampleRows; row++) {
      const stackIndex = tableColumn(thread.samples, "stack", row);
      if (stackIndex === null || stackIndex === undefined) continue;
      totalExpandedFrames += stackDepth(stackIndex);
      assert(
        totalExpandedFrames <= MAX_PROFILE_EXPANDED_FRAMES,
        `Profile expands to too many sample frames: ${profileFile}`,
      );
    }
  }
  assert(totalRows <= MAX_PROFILE_ROWS, `Profile has too many table rows: ${profileFile}`);
  assert(totalStrings <= MAX_PROFILE_STRINGS, `Profile has too many strings: ${profileFile}`);
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
  assert(stats.size <= 25 * 1024 * 1024, `Compressed profile is too large: ${profileFile}`);
  totalProfileBytes += stats.size;
  assert(totalProfileBytes <= 75 * 1024 * 1024, "Combined compressed profiles are too large");
  const realProfilePath = await realpath(profilePath);
  const realArtifactRoot = await realpath(artifactRoot);
  const realRelativePath = relative(realArtifactRoot, realProfilePath);
  assert(
    !realRelativePath.startsWith("..") && !isAbsolute(realRelativePath),
    "Profile resolves outside the artifact directory",
  );
  const profileContents = await gunzipAsync(await readFile(profilePath), {
    maxOutputLength: 64 * 1024 * 1024,
  });
  const profile = JSON.parse(profileContents.toString("utf8"));
  assert(profile && typeof profile === "object", `Invalid Samply profile: ${profileFile}`);
  assert(Array.isArray(profile.threads), `Samply profile has no threads: ${profileFile}`);
  assert(profile.threads.length <= 10_000, `Samply profile has too many threads: ${profileFile}`);
  assert(
    profile.meta === undefined || (profile.meta && typeof profile.meta === "object"),
    `Invalid Samply profile metadata: ${profileFile}`,
  );
  assert(
    profile.shared === undefined || (profile.shared && typeof profile.shared === "object"),
    `Invalid Samply shared tables: ${profileFile}`,
  );
  validateProfileTables(profile, profileFile);
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
assert(
  payload.schemaVersion === 1 || payload.schemaVersion === 2,
  "Unsupported performance schema",
);
assert(payload.provider === "samply", "Unexpected performance provider");
assert(payload.instrument === "walltime", "Unexpected performance instrument");
assert(payload.run?.repository === repository, "Performance repository does not match workflow");
assert(isSha(payload.run?.commitSha), "Performance commit SHA must be complete");
assert(
  payload.run.executionId === `${sourceRunId}:${sourceRunAttempt}`,
  "Performance execution ID does not match workflow run",
);
const skippedImplementationIds = payload.run.skippedImplementations ?? [];
assert(Array.isArray(skippedImplementationIds), "Invalid skipped implementations");
assert(
  skippedImplementationIds.every(
    (implementation) =>
      typeof implementation === "string" && /^[a-zA-Z0-9._:-]+$/.test(implementation),
  ),
  "Invalid skipped implementation",
);
assert(Array.isArray(payload.benchmarks), "Performance benchmarks must be an array");
assert(
  payload.benchmarks.length > 0 && payload.benchmarks.length <= 100,
  "Invalid benchmark count",
);

let sourcePullRequest = null;
if (sourceEvent === "pull_request") {
  assert(payload.run.kind === "pull_request", "Pull request workflow produced a non-PR run");
  assert(
    Number.isInteger(payload.run.pullRequest) && payload.run.pullRequest > 0,
    "Invalid PR number",
  );
  sourcePullRequest = githubApi(`repos/${repository}/pulls/${payload.run.pullRequest}`);
  assert(sourcePullRequest.state === "open", "Source pull request is not open");
  assert(
    sourcePullRequest.head.sha === sourceRun.head_sha,
    "Source run head SHA does not match PR",
  );
  assert(
    sourcePullRequest.head.repo.full_name === sourceRun.head_repository?.full_name,
    "Source run repository does not match PR",
  );
  assert(
    sourcePullRequest.head.ref === sourceRun.head_branch,
    "Source run branch does not match PR",
  );
} else if (sourceEvent === "workflow_dispatch" && payload.run.kind === "pull_request") {
  assert(
    Number.isInteger(payload.run.pullRequest) && payload.run.pullRequest > 0,
    "Invalid PR number",
  );
  sourcePullRequest = githubApi(`repos/${repository}/pulls/${payload.run.pullRequest}`);
  assert(
    payload.run.commitSha === sourcePullRequest.head.sha,
    "Dispatched PR head SHA is stale or invalid",
  );
  assert(
    payload.run.baseSha === sourcePullRequest.base.sha,
    "Dispatched PR base SHA is stale or invalid",
  );
}

let trustedManifestRef;
if (sourceEvent === "pull_request") {
  trustedManifestRef = sourcePullRequest.base.sha;
} else if (sourceEvent === "push") {
  trustedManifestRef = sourceRun.head_sha;
} else if (sourceEvent === "workflow_dispatch") {
  assert(
    sourceRun.head_repository?.full_name === repository && sourceRun.head_branch === "main",
    "Dispatched workflow ref is not the default branch",
  );
  trustedManifestRef = sourceRun.head_sha;
} else {
  throw new Error(`Unsupported source event: ${sourceEvent}`);
}

const performanceScenarios = trustedScenarioManifest(trustedManifestRef);
const skippedImplementations = new Set(skippedImplementationIds);
if (payload.run.kind === "pull_request") {
  assert(
    [...skippedImplementations].every((implementation) => implementation === "nextjs"),
    "Only unchanged Next.js benchmarks may be skipped",
  );
  if (skippedImplementations.has("nextjs")) {
    const baseFingerprint = remoteNextjsInputFingerprint(
      sourcePullRequest.base.repo.full_name,
      sourcePullRequest.base.sha,
    );
    const benchmarkRef =
      sourceEvent === "pull_request"
        ? sourcePullRequest.merge_commit_sha
        : sourcePullRequest.head.sha;
    assert(isSha(benchmarkRef), "Pull request merge commit SHA is unavailable");
    const headFingerprint = remoteNextjsInputFingerprint(
      sourceEvent === "pull_request" ? repository : sourcePullRequest.head.repo.full_name,
      benchmarkRef,
    );
    assert(
      baseFingerprint === headFingerprint,
      "Next.js benchmarks were skipped even though their inputs changed",
    );
  }
} else {
  assert(skippedImplementations.size === 0, "Non-PR runs may not skip implementations");
}
const benchmarkIds = new Set();
const expectedBenchmarks = new Map(
  performanceScenarios.flatMap((scenario) =>
    scenario.implementations.flatMap((implementation) =>
      skippedImplementations.has(implementation.id)
        ? []
        : [
            [
              benchmarkId(scenario, implementation),
              {
                scenarioId: scenario.id,
                suite: scenario.suite,
                label: scenario.label,
                description: scenario.description,
                implementationId: implementation.id,
                implementationLabel: implementation.label,
                unit: scenario.unit,
                lowerIsBetter: scenario.lowerIsBetter,
                profile: implementation.profile === true,
                compareBase: implementation.compareBase === true,
              },
            ],
          ],
    ),
  ),
);
assert(
  payload.benchmarks.length === expectedBenchmarks.size,
  "Performance artifact does not contain the trusted benchmark set",
);
for (const benchmark of payload.benchmarks) {
  assert(
    typeof benchmark.benchmarkId === "string" && /^[a-zA-Z0-9._:-]+$/.test(benchmark.benchmarkId),
    "Invalid benchmark ID",
  );
  assert(!benchmarkIds.has(benchmark.benchmarkId), `Duplicate benchmark: ${benchmark.benchmarkId}`);
  benchmarkIds.add(benchmark.benchmarkId);
  const expected = expectedBenchmarks.get(benchmark.benchmarkId);
  assert(expected, `Unexpected benchmark: ${benchmark.benchmarkId}`);
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
  for (const field of [
    "scenarioId",
    "suite",
    "label",
    "description",
    "implementationId",
    "implementationLabel",
    "unit",
    "lowerIsBetter",
  ]) {
    assert(benchmark[field] === expected[field], `Untrusted ${field} for ${benchmark.benchmarkId}`);
  }
  assert(typeof benchmark.lowerIsBetter === "boolean", "Invalid benchmark direction");
  assert(benchmark.profileObjectKey === undefined, "Artifacts may not provide profile object keys");
  validateSamples(benchmark.samples, benchmark.benchmarkId, "head");
  if (payload.run.kind === "pull_request" && expected.compareBase) {
    validateSamples(benchmark.baselineSamples, benchmark.benchmarkId, "paired baseline");
    assert(
      benchmark.baselineSamples.rounds === benchmark.samples.rounds,
      `Paired sample counts differ for ${benchmark.benchmarkId}`,
    );
  } else {
    assert(
      benchmark.baselineSamples === null || benchmark.baselineSamples === undefined,
      `Unexpected paired baseline for ${benchmark.benchmarkId}`,
    );
  }
  if (benchmark.profileFile !== null && benchmark.profileFile !== undefined) {
    assert(expected.profile, `Unexpected profile for ${benchmark.benchmarkId}`);
    if (payload.run.kind === "pull_request" && expected.compareBase) {
      assert(
        benchmark.profileRounds === 1,
        `Paired profile must contain one round for ${benchmark.benchmarkId}`,
      );
    } else {
      assert(
        benchmark.profileRounds === undefined ||
          (Number.isInteger(benchmark.profileRounds) &&
            benchmark.profileRounds > 0 &&
            benchmark.profileRounds <= 1_000),
        `Invalid profile round count for ${benchmark.benchmarkId}`,
      );
    }
    await validateProfilePath(benchmark.profileFile);
  } else {
    assert(!expected.profile, `Missing profile for ${benchmark.benchmarkId}`);
    assert(
      benchmark.profileRounds === null || benchmark.profileRounds === undefined,
      `Unexpected profile round count for ${benchmark.benchmarkId}`,
    );
  }
}
if (payload.schemaVersion === 2) {
  assert(
    payload.benchmarks.some((benchmark) => benchmark.baselineSamples),
    "Performance schema 2 requires paired baseline samples",
  );
}

let commitRepository = repository;
if (sourceEvent === "pull_request") {
  commitRepository = sourcePullRequest.head.repo.full_name;
  assert(
    payload.run.pullRequest === sourcePullRequest.number,
    "Pull request number does not match workflow run",
  );
  assert(
    payload.run.commitSha === sourcePullRequest.head.sha,
    "Pull request head SHA does not match workflow run",
  );
  assert(
    payload.run.baseSha === sourcePullRequest.base.sha,
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
    commitRepository = sourcePullRequest.head.repo.full_name;
  } else {
    assert(payload.run.kind === "main", "Invalid dispatched run kind");
    execFileSync("git", ["fetch", "--no-tags", "origin", "main"], { stdio: "inherit" });
    execFileSync("git", ["merge-base", "--is-ancestor", payload.run.commitSha, "origin/main"]);
    assert(
      payload.run.baseSha === null && payload.run.pullRequest === null,
      "Main run has PR metadata",
    );
  }
}

const commit = githubApi(`repos/${commitRepository}/git/commits/${payload.run.commitSha}`);
assert(
  new Date(payload.run.measuredAt).toISOString() === new Date(commit.committer.date).toISOString(),
  "Performance measuredAt does not match the commit timestamp",
);

console.log(`Validated ${payload.benchmarks.length} benchmarks for ${payload.run.commitSha}`);
