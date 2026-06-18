import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  isNextjsBenchmarkInput,
  nextjsInputFingerprint,
} from "../benchmarks/perf/nextjs-input-fingerprint.mts";
import { DEFAULT_PAIRED_ROUNDS, pairedRevisionOrder } from "../benchmarks/perf/pairing.mts";

describe("paired performance benchmarks", () => {
  it("alternates base/head order across rounds", () => {
    expect(DEFAULT_PAIRED_ROUNDS % 2).toBe(0);
    expect(pairedRevisionOrder(0)).toEqual(["base", "head"]);
    expect(pairedRevisionOrder(1)).toEqual(["head", "base"]);
    expect(pairedRevisionOrder(2)).toEqual(["base", "head"]);
  });

  it("installs the base checkout before overlaying trusted benchmark files", () => {
    const workflow = readFileSync(
      join(import.meta.dirname, "../.github/workflows/perf.yml"),
      "utf8",
    );
    const prepareManifests = workflow.indexOf("- name: Prepare trusted benchmark manifests");
    const installBase = workflow.indexOf("- name: Install base dependencies");
    const installHarness = workflow.indexOf("- name: Install trusted performance harness");
    const manifestStep = workflow.slice(prepareManifests, installBase);

    expect(prepareManifests).toBeGreaterThan(-1);
    expect(installBase).toBeGreaterThan(prepareManifests);
    expect(installHarness).toBeGreaterThan(installBase);
    expect(manifestStep).not.toContain('roots+=(".perf-base")');
  });

  it("isolates pull request comment permissions from benchmark publishing", () => {
    const workflow = readFileSync(
      join(import.meta.dirname, "../.github/workflows/perf-publish.yml"),
      "utf8",
    );
    const publishJob = workflow.slice(
      workflow.indexOf("  publish:"),
      workflow.indexOf("  comment:"),
    );
    const commentJob = workflow.slice(workflow.indexOf("  comment:"));

    expect(workflow).not.toContain("pull-requests: write");
    expect(publishJob).toContain("actions: read");
    expect(publishJob).toContain("contents: read");
    expect(publishJob).not.toContain("issues: write");
    expect(commentJob).toContain("actions: read");
    expect(commentJob).toContain("issues: write");
    expect(commentJob).not.toContain("secrets.");
    expect(commentJob).not.toContain("actions/checkout");
    expect(commentJob).not.toContain("performance-artifact");
  });

  it("fingerprints every Next.js measurement input", () => {
    const entries = [
      gitTreeEntry(".github/workflows/perf.yml", "0"),
      gitTreeEntry("benchmarks/nextjs/package.json", "1"),
      gitTreeEntry("benchmarks/nextjs/next.config.ts", "2"),
      gitTreeEntry("benchmarks/generate-app.mjs", "3"),
      gitTreeEntry("benchmarks/perf/scenarios.json", "4"),
      gitTreeEntry("benchmarks/perf/cold-start.mjs", "5"),
      gitTreeEntry("benchmarks/perf/normalize-results.mjs", "5a"),
      gitTreeEntry("benchmarks/perf/format-pr-comment.mjs", "6"),
      gitTreeEntry("benchmarks/nextjs/app/page.tsx", "7"),
    ];
    const fingerprint = nextjsInputFingerprint(entries);

    for (const path of [
      ".github/workflows/perf.yml",
      "benchmarks/nextjs/package.json",
      "benchmarks/nextjs/next.config.ts",
      "benchmarks/generate-app.mjs",
      "benchmarks/perf/scenarios.json",
      "benchmarks/perf/cold-start.mjs",
      "benchmarks/perf/normalize-results.mjs",
    ]) {
      expect(isNextjsBenchmarkInput(path)).toBe(true);
      expect(
        nextjsInputFingerprint(
          entries.map((entry) =>
            entry.path === path ? { ...entry, sha: `${entry.sha}x` } : entry,
          ),
        ),
      ).not.toBe(fingerprint);
    }
    expect(isNextjsBenchmarkInput("benchmarks/perf/format-pr-comment.mjs")).toBe(false);
    expect(isNextjsBenchmarkInput("benchmarks/nextjs/app/page.tsx")).toBe(false);
  });

  it("normalizes same-run baseline samples separately from head samples", () => {
    const directory = mkdtempSync(join(tmpdir(), "vinext-perf-"));
    const samplesPath = join(directory, "samples.jsonl");
    const resultsPath = join(directory, "results.json");
    const profilesPath = join(directory, "profiles");
    const profileDirectory = join(profilesPath, "vinext-production-build");
    mkdirSync(profileDirectory, { recursive: true });
    writeFileSync(
      join(profileDirectory, "samply-profile.json.gz"),
      gzipSync(JSON.stringify({ threads: [] })),
    );
    const sample = {
      schemaVersion: 1,
      benchmarkId: "vinext-production-build",
      scenarioId: "production-build",
      suite: "Build",
      label: "Production build time",
      description: "Build",
      implementationId: "vinext",
      implementationLabel: "vinext",
      profile: true,
      unit: "ms",
      lowerIsBetter: true,
      measuredAt: "2026-01-01T00:00:00.000Z",
    };
    writeFileSync(
      samplesPath,
      [
        { ...sample, revision: "base", value: 100 },
        { ...sample, revision: "head", value: 90 },
        { ...sample, revision: "head", value: 92 },
        { ...sample, revision: "base", value: 102 },
      ]
        .map((value) => JSON.stringify(value))
        .join("\n"),
    );

    execFileSync(
      process.execPath,
      ["benchmarks/perf/normalize-results.mjs", samplesPath, resultsPath, profilesPath],
      {
        cwd: join(import.meta.dirname, ".."),
        env: {
          ...process.env,
          VINEXT_PERF_RUN_KIND: "pull_request",
          VINEXT_PERF_COMMIT_SHA: "local",
          VINEXT_PERF_BASE_SHA: "a".repeat(40),
          VINEXT_PERF_PR_NUMBER: "1",
        },
      },
    );

    const results = JSON.parse(readFileSync(resultsPath, "utf8"));
    expect(results.run.skippedImplementations).toEqual([]);
    expect(results.benchmarks[0].samples).toMatchObject({ rounds: 2, median: 91 });
    expect(results.benchmarks[0].baselineSamples).toMatchObject({
      rounds: 2,
      median: 101,
    });
    expect(results.benchmarks[0].profileRounds).toBe(1);
  });

  it("reports unchanged Next.js as skipped", () => {
    const directory = mkdtempSync(join(tmpdir(), "vinext-perf-comment-"));
    const resultsPath = join(directory, "results.json");
    const responsePath = join(directory, "response.json");
    const outputPath = join(directory, "comment.md");
    writeFileSync(
      resultsPath,
      JSON.stringify({
        run: {
          kind: "pull_request",
          pullRequest: 42,
          baseSha: "b".repeat(40),
          measuredAt: "2026-01-01T00:00:00.000Z",
          skippedImplementations: ["nextjs"],
        },
        benchmarks: [
          {
            benchmarkId: "vinext-production-build",
            samples: { median: 90 },
            baselineSamples: { median: 100 },
          },
        ],
      }),
    );
    writeFileSync(
      responsePath,
      JSON.stringify({
        comparison: {
          head: { shortSha: "1234567" },
          baseline: null,
          measurements: [
            {
              benchmarkId: "vinext-production-build",
              label: "Production build time",
              implementationLabel: "vinext",
              unit: "ms",
              lowerIsBetter: true,
              baseline: null,
              current: { median: 999 },
            },
          ],
        },
      }),
    );

    execFileSync(
      process.execPath,
      ["benchmarks/perf/format-pr-comment.mjs", resultsPath, responsePath, outputPath],
      { cwd: join(import.meta.dirname, "..") },
    );

    const comment = readFileSync(outputPath, "utf8");
    expect(comment).toContain(
      "using alternating same-runner rounds. Next.js was unchanged and skipped.",
    );
    expect(comment).toContain("1 improved · 0 regressed · 0 within ±1.5%");
    expect(comment).not.toContain("Next.js |");
  });

  it("labels mixed paired and historical PR comment baselines", () => {
    const directory = mkdtempSync(join(tmpdir(), "vinext-perf-mixed-comment-"));
    const resultsPath = join(directory, "results.json");
    const responsePath = join(directory, "response.json");
    const outputPath = join(directory, "comment.md");
    writeFileSync(
      resultsPath,
      JSON.stringify({
        run: {
          kind: "pull_request",
          pullRequest: 42,
          baseSha: "b".repeat(40),
          measuredAt: "2026-01-01T00:00:00.000Z",
        },
        benchmarks: [
          {
            benchmarkId: "paired",
            samples: { median: 90 },
            baselineSamples: { median: 100 },
          },
          { benchmarkId: "historical", samples: { median: 80 }, baselineSamples: null },
        ],
      }),
    );
    writeFileSync(
      responsePath,
      JSON.stringify({
        comparison: {
          head: { shortSha: "aaaaaaa" },
          baseline: { shortSha: "bbbbbbb" },
          measurements: [
            commentMeasurement("paired", 100, 90),
            commentMeasurement("historical", 100, 80),
          ],
        },
      }),
    );

    execFileSync(
      process.execPath,
      ["benchmarks/perf/format-pr-comment.mjs", resultsPath, responsePath, outputPath],
      { cwd: join(import.meta.dirname, "..") },
    );

    const comment = readFileSync(outputPath, "utf8");
    expect(comment).toContain(
      "Paired benchmarks use alternating same-runner rounds; unpaired benchmarks use the stored base-run baseline.",
    );
    expect(comment).toContain("mixed paired/historical baselines");
  });

  it("accepts legacy PR artifacts without skipped implementation metadata", () => {
    const headSha = "a".repeat(40);
    const baseSha = "b".repeat(40);
    const measuredAt = "2026-06-18T12:00:00.000Z";
    const payload = performancePayload({
      headSha,
      baseSha,
      measuredAt,
      benchmarks: [performanceBenchmark("vinext", false)],
    });

    validatePerformancePayload(payload, "pull_request", {
      "repos/cloudflare/vinext/actions/runs/123": sourceRun("pull_request", headSha),
      "repos/cloudflare/vinext/pulls/42": pullRequest(headSha, baseSha),
      [`repos/cloudflare/vinext/contents/benchmarks/perf/scenarios.json?ref=${baseSha}`]:
        githubFile(
          JSON.stringify({
            scenarios: [performanceScenario([{ id: "vinext", label: "vinext" }])],
          }),
        ),
      [`repos/cloudflare/vinext/commits/${headSha}`]: commit(measuredAt),
    });
  });

  it("accepts dispatched PR artifacts that skip unchanged Next.js", () => {
    const workflowSha = "c".repeat(40);
    const headSha = "a".repeat(40);
    const baseSha = "b".repeat(40);
    const measuredAt = "2026-06-18T12:00:00.000Z";
    const nextjsInputs = [
      gitTreeEntry("benchmarks/nextjs/package.json", "1"),
      gitTreeEntry("benchmarks/generate-app.mjs", "2"),
      gitTreeEntry("benchmarks/perf/scenarios.json", "3"),
    ];
    const payload = performancePayload({
      headSha,
      baseSha,
      measuredAt,
      skippedImplementations: ["nextjs"],
      benchmarks: [performanceBenchmark("vinext", true)],
    });

    validatePerformancePayload(payload, "workflow_dispatch", {
      "repos/cloudflare/vinext/actions/runs/123": sourceRun("workflow_dispatch", workflowSha),
      "repos/cloudflare/vinext/pulls/42": pullRequest(headSha, baseSha),
      [`repos/cloudflare/vinext/contents/benchmarks/perf/scenarios.json?ref=${workflowSha}`]:
        githubFile(
          JSON.stringify({
            scenarios: [
              performanceScenario([
                { id: "nextjs", label: "Next.js", compareBase: true },
                { id: "vinext", label: "vinext", compareBase: true },
              ]),
            ],
          }),
        ),
      [`repos/cloudflare/vinext/git/trees/${baseSha}?recursive=1`]: githubTree(nextjsInputs),
      [`repos/cloudflare/vinext/git/trees/${headSha}?recursive=1`]: githubTree(nextjsInputs),
      [`repos/cloudflare/vinext/commits/${headSha}`]: commit(measuredAt),
    });
  });

  it("validates skipped Next.js against the synthetic merge commit", () => {
    const headSha = "a".repeat(40);
    const baseSha = "b".repeat(40);
    const mergeSha = "c".repeat(40);
    const measuredAt = "2026-06-18T12:00:00.000Z";
    const baseInputs = [
      gitTreeEntry("benchmarks/nextjs/package.json", "1"),
      gitTreeEntry("benchmarks/generate-app.mjs", "2"),
      gitTreeEntry("benchmarks/perf/scenarios.json", "3"),
    ];
    const staleHeadInputs = baseInputs.map((entry) =>
      entry.path === "benchmarks/perf/scenarios.json" ? { ...entry, sha: "stale" } : entry,
    );
    const payload = performancePayload({
      headSha,
      baseSha,
      measuredAt,
      skippedImplementations: ["nextjs"],
      benchmarks: [performanceBenchmark("vinext", true)],
    });

    validatePerformancePayload(payload, "pull_request", {
      "repos/cloudflare/vinext/actions/runs/123": sourceRun("pull_request", headSha),
      "repos/cloudflare/vinext/pulls/42": pullRequest(headSha, baseSha, mergeSha),
      [`repos/cloudflare/vinext/contents/benchmarks/perf/scenarios.json?ref=${baseSha}`]:
        githubFile(
          JSON.stringify({
            scenarios: [
              performanceScenario([
                { id: "nextjs", label: "Next.js", compareBase: true },
                { id: "vinext", label: "vinext", compareBase: true },
              ]),
            ],
          }),
        ),
      [`repos/cloudflare/vinext/git/trees/${baseSha}?recursive=1`]: githubTree(baseInputs),
      [`repos/cloudflare/vinext/git/trees/${mergeSha}?recursive=1`]: githubTree(baseInputs),
      [`repos/cloudflare/vinext/git/trees/${headSha}?recursive=1`]: githubTree(staleHeadInputs),
      [`repos/cloudflare/vinext/commits/${headSha}`]: commit(measuredAt),
    });
  });

  it("rejects skipped Next.js when a benchmark runtime input changed", () => {
    const workflowSha = "c".repeat(40);
    const headSha = "a".repeat(40);
    const baseSha = "b".repeat(40);
    const measuredAt = "2026-06-18T12:00:00.000Z";
    const baseInputs = [
      gitTreeEntry("benchmarks/nextjs/package.json", "1"),
      gitTreeEntry("benchmarks/generate-app.mjs", "2"),
      gitTreeEntry("benchmarks/perf/scenarios.json", "3"),
    ];
    const headInputs = baseInputs.map((entry) =>
      entry.path === "benchmarks/perf/scenarios.json" ? { ...entry, sha: "changed" } : entry,
    );
    const payload = performancePayload({
      headSha,
      baseSha,
      measuredAt,
      skippedImplementations: ["nextjs"],
      benchmarks: [performanceBenchmark("vinext", true)],
    });

    expect(() =>
      validatePerformancePayload(payload, "workflow_dispatch", {
        "repos/cloudflare/vinext/actions/runs/123": sourceRun("workflow_dispatch", workflowSha),
        "repos/cloudflare/vinext/pulls/42": pullRequest(headSha, baseSha),
        [`repos/cloudflare/vinext/contents/benchmarks/perf/scenarios.json?ref=${workflowSha}`]:
          githubFile(
            JSON.stringify({
              scenarios: [
                performanceScenario([
                  { id: "nextjs", label: "Next.js", compareBase: true },
                  { id: "vinext", label: "vinext", compareBase: true },
                ]),
              ],
            }),
          ),
        [`repos/cloudflare/vinext/git/trees/${baseSha}?recursive=1`]: githubTree(baseInputs),
        [`repos/cloudflare/vinext/git/trees/${headSha}?recursive=1`]: githubTree(headInputs),
      }),
    ).toThrow();
  });

  it("requires paired profiles to declare their single profiling round", () => {
    const headSha = "a".repeat(40);
    const baseSha = "b".repeat(40);
    const measuredAt = "2026-06-18T12:00:00.000Z";
    const benchmark = {
      ...performanceBenchmark("vinext", true),
      profileFile: "perf-profiles/vinext-production-build/samply-profile.json.gz",
      profileRounds: 1,
    };
    const payload = performancePayload({
      headSha,
      baseSha,
      measuredAt,
      benchmarks: [benchmark],
    });
    const responses = {
      "repos/cloudflare/vinext/actions/runs/123": sourceRun("pull_request", headSha),
      "repos/cloudflare/vinext/pulls/42": pullRequest(headSha, baseSha),
      [`repos/cloudflare/vinext/contents/benchmarks/perf/scenarios.json?ref=${baseSha}`]:
        githubFile(
          JSON.stringify({
            scenarios: [
              performanceScenario([
                { id: "vinext", label: "vinext", compareBase: true, profile: true },
              ]),
            ],
          }),
        ),
      [`repos/cloudflare/vinext/commits/${headSha}`]: commit(measuredAt),
    };

    expect(() => validatePerformancePayload(payload, "pull_request", responses)).not.toThrow();
    expect(() =>
      validatePerformancePayload(
        {
          ...payload,
          benchmarks: [{ ...benchmark, profileRounds: 6 }],
        },
        "pull_request",
        responses,
      ),
    ).toThrow("Paired profile must contain one round");
  });
});

function validatePerformancePayload(
  payload: Record<string, unknown>,
  sourceEvent: string,
  githubResponses: Record<string, unknown>,
) {
  const directory = mkdtempSync(join(tmpdir(), "vinext-perf-validator-"));
  const payloadPath = join(directory, "results.json");
  const responsesPath = join(directory, "responses.json");
  const ghPath = join(directory, "gh");
  writeFileSync(payloadPath, JSON.stringify(payload));
  writeFileSync(responsesPath, JSON.stringify(githubResponses));
  for (const benchmark of payload.benchmarks as Array<{ profileFile?: string | null }>) {
    if (!benchmark.profileFile) continue;
    const profilePath = join(directory, benchmark.profileFile);
    mkdirSync(join(profilePath, ".."), { recursive: true });
    writeFileSync(profilePath, gzipSync(JSON.stringify({ threads: [] })));
  }
  writeFileSync(
    ghPath,
    `#!/usr/bin/env node
const responses = JSON.parse(require("node:fs").readFileSync(process.env.MOCK_GH_RESPONSES, "utf8"));
const response = responses[process.argv[3]];
if (response === undefined) {
  console.error("Unexpected gh api request:", process.argv[3]);
  process.exit(1);
}
process.stdout.write(JSON.stringify(response));
`,
  );
  chmodSync(ghPath, 0o755);

  const validation = spawnSync(
    process.execPath,
    ["benchmarks/perf/validate-results.mjs", payloadPath],
    {
      cwd: join(import.meta.dirname, ".."),
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        GITHUB_TOKEN: "test",
        VINEXT_PERF_SOURCE_EVENT: sourceEvent,
        VINEXT_PERF_SOURCE_RUN_ID: "123",
        VINEXT_PERF_SOURCE_RUN_ATTEMPT: "1",
        MOCK_GH_RESPONSES: responsesPath,
      },
      encoding: "utf8",
    },
  );
  if (validation.status !== 0) {
    throw new Error(validation.stderr || validation.stdout || "Performance validation failed");
  }
}

function performancePayload({
  headSha,
  baseSha,
  measuredAt,
  skippedImplementations,
  benchmarks,
}: {
  headSha: string;
  baseSha: string;
  measuredAt: string;
  skippedImplementations?: string[];
  benchmarks: unknown[];
}) {
  return {
    schemaVersion: 1,
    provider: "samply",
    instrument: "walltime",
    run: {
      kind: "pull_request",
      commitSha: headSha,
      baseSha,
      pullRequest: 42,
      executionId: "123:1",
      measuredAt,
      repository: "cloudflare/vinext",
      ...(skippedImplementations ? { skippedImplementations } : {}),
    },
    system: {},
    benchmarks,
  };
}

function commentMeasurement(benchmarkId: string, baseline: number, current: number) {
  return {
    benchmarkId,
    label: benchmarkId,
    implementationLabel: "vinext",
    unit: "ms",
    lowerIsBetter: true,
    baseline: { median: baseline },
    current: { median: current },
  };
}

function performanceBenchmark(implementationId: string, paired: boolean) {
  const samples = {
    rounds: 2,
    mean: 10,
    median: 10,
    standardDeviation: 0,
    min: 10,
    max: 10,
    q1: 10,
    q3: 10,
    outliers: 0,
  };
  return {
    benchmarkId: `${implementationId}-production-build`,
    scenarioId: "production-build",
    suite: "Build",
    label: "Production build time",
    description: "Build",
    implementationId,
    implementationLabel: implementationId === "nextjs" ? "Next.js" : "vinext",
    unit: "ms",
    lowerIsBetter: true,
    samples,
    baselineSamples: paired ? samples : null,
    profileFile: null,
  };
}

function performanceScenario(
  implementations: Array<{
    id: string;
    label: string;
    compareBase?: boolean;
    profile?: boolean;
  }>,
) {
  return {
    id: "production-build",
    suite: "Build",
    label: "Production build time",
    description: "Build",
    unit: "ms",
    lowerIsBetter: true,
    implementations,
  };
}

function sourceRun(event: string, headSha: string) {
  return {
    path: ".github/workflows/perf.yml",
    status: "completed",
    conclusion: "success",
    event,
    run_attempt: 1,
    head_sha: headSha,
    head_repository: { full_name: "cloudflare/vinext" },
    head_branch: "benchmark-branch",
  };
}

function pullRequest(headSha: string, baseSha: string, mergeSha = "c".repeat(40)) {
  return {
    number: 42,
    state: "open",
    merge_commit_sha: mergeSha,
    head: {
      sha: headSha,
      ref: "benchmark-branch",
      repo: { full_name: "cloudflare/vinext" },
    },
    base: {
      sha: baseSha,
      repo: { full_name: "cloudflare/vinext" },
    },
  };
}

function githubFile(contents: string) {
  return {
    type: "file",
    encoding: "base64",
    content: Buffer.from(contents).toString("base64"),
  };
}

function gitTreeEntry(path: string, sha: string) {
  return { path, sha, type: "blob" };
}

function githubTree(tree: Array<ReturnType<typeof gitTreeEntry>>) {
  return { truncated: false, tree };
}

function commit(measuredAt: string) {
  return { commit: { committer: { date: measuredAt } } };
}
