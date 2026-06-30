import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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

  it("keeps untrusted benchmark processes away from baselines and result files", () => {
    const workflow = readFileSync(
      join(import.meta.dirname, "../.github/workflows/perf.yml"),
      "utf8",
    );
    const runner = readFileSync(
      join(import.meta.dirname, "../benchmarks/perf/run-scenarios.mjs"),
      "utf8",
    );
    const coldStart = readFileSync(
      join(import.meta.dirname, "../benchmarks/perf/cold-start.mjs"),
      "utf8",
    );
    const buildTime = readFileSync(
      join(import.meta.dirname, "../benchmarks/perf/build-time.mjs"),
      "utf8",
    );

    expect(workflow).toContain("vinext-perf-head");
    expect(workflow).toContain("vinext-perf-base");
    expect(workflow).toContain(
      'echo "VINEXT_PERF_BASE_ROOT=$RUNNER_TEMP/vinext-perf-base/checkout"',
    );
    expect(workflow).toContain('mv .perf-base-staging "$VINEXT_PERF_BASE_ROOT"');
    expect(workflow).toContain('chmod 700 "$(dirname "$VINEXT_PERF_BASE_ROOT")"');
    expect(workflow).toContain("- name: Validate performance workspace paths");
    expect(workflow).toContain('if [ ! -d "$path" ] || [ -L "$path" ]; then');
    expect(workflow).toContain('if [ "$(realpath "$path")" != "$path" ]; then');
    expect(workflow).toContain("benchmarks/vinext/app");
    expect(workflow).toContain("benchmarks/nextjs/app");
    expect(workflow).toContain("rm -rf .perf-base-staging .perf-manifests .perf-harness");
    expect(workflow).toContain("grant_write_paths()");
    expect(workflow).toContain("packages/vinext/dist");
    expect(workflow).toContain("node_modules/.vite/task-cache");
    expect(workflow).toContain("benchmarks/nextjs/node_modules");
    expect(workflow).toContain('sudo chmod +t "$path"');
    expect(workflow).toContain('sudo setfacl -m u:"$user":rwx "$path"');
    expect(workflow).toContain('sudo setfacl -m d:u:"$user":rwx,d:u:"$USER":rwx "$path"');
    expect(workflow).toContain('sudo chown -R "$user":"$user" "$path"');
    expect(workflow).toContain('if [ -L "$path" ]; then');
    expect(workflow).toContain('case "$(realpath "$path")" in');
    expect(workflow).toContain('sudo chmod -R u+rwX "$path"');
    expect(workflow).toContain('sudo setfacl -R -m u:"$USER":rwX "$path"');
    expect(workflow).toContain('sudo -u "$user" test -w "$path"');
    expect(workflow).not.toContain('setfacl -R -m u:vinext-perf-head:rwX "$GITHUB_WORKSPACE"');
    expect(workflow).toContain("- name: Lock benchmark inputs after setup");
    expect(workflow).toContain('"$root/packages/vinext/dist"');
    expect(workflow).toContain('"$root/packages/cloudflare/dist"');
    expect(workflow).toContain('"$root/node_modules/.vite/task-cache"');
    expect(workflow).toContain("benchmarks/vinext/node_modules/.vite-temp");
    expect(workflow).toContain('sudo chown -R "$USER":"$USER" "$path"');
    expect(workflow).toContain("benchmarks/perf/validate-profile-traces.mjs");
    expect(workflow).toContain(
      "github.event.pull_request.head.repo.full_name != github.repository && github.event.pull_request.base.sha",
    );
    expect(workflow).toContain("github.event.pull_request.head.sha || github.sha");
    expect(workflow).toContain(
      'cp -R .perf-harness/benchmarks/vinext "$trusted_harness/benchmarks/vinext"',
    );
    expect(workflow).toContain(
      'cp -R .perf-harness/benchmarks/nextjs "$trusted_harness/benchmarks/nextjs"',
    );
    expect(workflow).toContain('if [ -f "$trace_validator" ]; then');
    expect(workflow).not.toContain('u:vinext-perf:rwx "$VINEXT_PERF_RESULTS_ROOT"');
    expect(runner).toContain("VINEXT_PERF_TARGET_USER: userForRoot(root)");
    expect(runner).toContain('!name.startsWith("VINEXT_PERF_")');
    expect(runner).toContain('execFileSync("which", ["vp"]');
    expect(runner).not.toContain('join(root, "node_modules/.bin/vp")');
    expect(runner).toContain("function profilerCommand() {\n  return [profilerBin];\n}");
    expect(runner).toContain('for (const signal of ["-STOP", "-KILL"])');
    expect(runner).toContain('["ps", "-u", user, "-o", "pid=,stat=,args="]');
    expect(runner).toContain("!/^\\s*\\d+\\s+\\S*Z/.test(process)");
    expect(runner).toContain("for (let attempt = 0; attempt < 20; attempt++)");
    expect(runner).toContain("await cleanupTargetUser(root)");
    expect(runner).toContain("else await runUntrusted(");
    expect(runner).toContain(
      "await runUntrusted(command[0], command.slice(1), timingEnv, root, root)",
    );
    expect(runner).toContain("await runUntrusted(\n    profiler[0]");
    expect(coldStart).toContain('name.startsWith("VINEXT_PERF_")');
    expect(coldStart).toContain('const profiling = process.env.VINEXT_PERF_PROFILE === "true"');
    expect(coldStart).toContain('join(projectDir, "node_modules/vite-plus/bin/vp")');
    expect(coldStart).toContain("detached: true");
    expect(coldStart).toContain("return targetUser && !profiling");
    expect(coldStart).toContain("await Promise.all(paths.map(clearDirectory))");
    expect(coldStart).toContain("const entries = await readdir(path)");
    expect(buildTime).toContain('name.startsWith("VINEXT_PERF_")');
    expect(buildTime).toContain("const entries = await readdir(outputDirectory)");
    expect(buildTime).toContain('const profiling = process.env.VINEXT_PERF_PROFILE === "true"');
    expect(buildTime).toContain('join(projectDir, "node_modules/vite-plus/bin/vp")');
    expect(buildTime).toContain(
      "globalThis.process.execve(command, [command, ...args], targetEnvironment())",
    );
    expect(buildTime).toContain("return targetUser && !profiling");
    expect(buildTime).toContain("detached: true");
    expect(buildTime).not.toContain(
      'rm(join(projectDir, framework === "vinext" ? "dist" : ".next")',
    );
  });

  it("requires dispatched workflow code to come from main", () => {
    const workflow = readFileSync(
      join(import.meta.dirname, "../.github/workflows/perf.yml"),
      "utf8",
    );
    const validation = readFileSync(
      join(import.meta.dirname, "../benchmarks/perf/validate-results.mjs"),
      "utf8",
    );

    expect(workflow).toContain("- name: Validate dispatched workflow ref");
    expect(workflow).toContain('[ "$VINEXT_PERF_WORKFLOW_SHA" != "$(git rev-parse origin/main)" ]');
    expect(validation).toContain("sourceRun.head_repository?.full_name === repository");
    expect(validation).toContain('sourceRun.head_branch === "main"');
    expect(validation).toContain("Dispatched workflow ref is not the default branch");
  });

  it("keeps Next.js enabled until the trusted base supports fingerprinting", () => {
    const workflow = readFileSync(
      join(import.meta.dirname, "../.github/workflows/perf.yml"),
      "utf8",
    );
    const detectionStep = workflow.slice(
      workflow.indexOf("- name: Detect Next.js benchmark input changes"),
      workflow.indexOf("- name: Prepare trusted benchmark manifests"),
    );
    const compatibilityGuard = detectionStep.indexOf('[ ! -f "$fingerprint_script" ]');
    const fingerprintInvocation = detectionStep.indexOf(
      'head_fingerprint=$(node "$fingerprint_script" .)',
    );

    expect(compatibilityGuard).toBeGreaterThan(-1);
    expect(detectionStep).toContain('grep -q "skippedImplementations" "$base_validator"');
    expect(detectionStep).toContain("keeping Next.js for rollout compatibility");
    expect(detectionStep).toContain("exit 0");
    expect(fingerprintInvocation).toBeGreaterThan(compatibilityGuard);
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

    expect(publishJob).toContain("actions: read");
    expect(publishJob).toContain("contents: read");
    expect(publishJob).not.toContain("issues: write");
    expect(commentJob).toContain("actions: read");
    expect(commentJob).toContain("pull-requests: write");
    expect(commentJob).not.toContain("issues: write");
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

  it("rejects symlinked bundle outputs", () => {
    const directory = mkdtempSync(join(tmpdir(), "vinext-perf-bundle-symlink-"));
    const outputDirectory = join(directory, "benchmarks/vinext/dist");
    const linkedDirectory = join(directory, "linked-client");
    mkdirSync(linkedDirectory, { recursive: true });
    mkdirSync(outputDirectory, { recursive: true });
    writeFileSync(join(linkedDirectory, "entry.js"), "console.log('linked')");
    execFileSync("ln", ["-s", linkedDirectory, join(outputDirectory, "client")]);

    expect(() =>
      execFileSync(process.execPath, ["benchmarks/perf/bundle-size.mjs", "vinext"], {
        cwd: join(import.meta.dirname, ".."),
        env: { ...process.env, VINEXT_PERF_TARGET_ROOT: directory },
        stdio: "pipe",
      }),
    ).toThrow("Bundle output may not be a symlink");
  });

  it("rejects bundle outputs beneath symlinked benchmark ancestors", () => {
    const directory = mkdtempSync(join(tmpdir(), "vinext-perf-bundle-ancestor-"));
    const linkedRoot = mkdtempSync(join(tmpdir(), "vinext-perf-linked-root-"));
    mkdirSync(join(directory, "benchmarks"), { recursive: true });
    mkdirSync(join(linkedRoot, "dist/client"), { recursive: true });
    writeFileSync(join(linkedRoot, "dist/client/entry.js"), "console.log('linked')");
    execFileSync("ln", ["-s", linkedRoot, join(directory, "benchmarks/vinext")]);

    expect(() =>
      execFileSync(process.execPath, ["benchmarks/perf/bundle-size.mjs", "vinext"], {
        cwd: join(import.meta.dirname, ".."),
        env: { ...process.env, VINEXT_PERF_TARGET_ROOT: directory },
        stdio: "pipe",
      }),
    ).toThrow("Bundle output escapes the benchmark checkout");
  });

  it("measures the eager RSC entry closure and complete server bundle separately", () => {
    const directory = mkdtempSync(join(tmpdir(), "vinext-perf-server-bundle-"));
    const repositoryRoot = join(import.meta.dirname, "..");
    const serverDirectory = join(directory, "benchmarks/vinext/dist/server");
    const samplesPath = join(directory, "samples.jsonl");
    const rscEntry =
      "import './_next/static/shared.js'; export { value } from './_next/static/reexport.js'; import('./_next/static/lazy.js'); export default function handler() { return 'rsc'; }";
    const ssrEntry = "export function render() { return 'ssr'; }";
    const sharedChunk = "import '../../index.js'; export const shared = 'chunk';";
    const reexportedChunk = "export const value = 'reexported';";
    const lazyChunk = "export const lazy = 'lazy';";
    mkdirSync(join(serverDirectory, "ssr"), { recursive: true });
    mkdirSync(join(serverDirectory, "_next/static"), { recursive: true });
    writeFileSync(join(directory, "package.json"), '{"private":true}');
    symlinkSync(join(repositoryRoot, "node_modules"), join(directory, "node_modules"), "dir");
    writeFileSync(join(serverDirectory, "index.js"), rscEntry);
    writeFileSync(join(serverDirectory, "ssr/index.js"), ssrEntry);
    writeFileSync(join(serverDirectory, "_next/static/shared.js"), sharedChunk);
    writeFileSync(join(serverDirectory, "_next/static/reexport.js"), reexportedChunk);
    writeFileSync(join(serverDirectory, "_next/static/lazy.js"), lazyChunk);
    writeFileSync(join(serverDirectory, "vinext-server.json"), "{}");

    const baseEnvironment = {
      ...process.env,
      VINEXT_PERF_TARGET_ROOT: directory,
      VINEXT_PERF_SAMPLES: samplesPath,
      VINEXT_PERF_SCENARIO_ID: "bundle-size",
      VINEXT_PERF_SUITE: "Build",
      VINEXT_PERF_LABEL: "Bundle size",
      VINEXT_PERF_IMPLEMENTATION_ID: "vinext",
      VINEXT_PERF_IMPLEMENTATION_LABEL: "vinext",
      VINEXT_PERF_UNIT: "bytes",
      VINEXT_PERF_LOWER_IS_BETTER: "true",
      VINEXT_PERF_REVISION: "head",
    };

    execFileSync(process.execPath, ["benchmarks/perf/bundle-size.mjs", "vinext", "rsc-entry"], {
      cwd: join(import.meta.dirname, ".."),
      env: { ...baseEnvironment, VINEXT_PERF_BENCHMARK_ID: "vinext-rsc-entry-gzip" },
    });
    execFileSync(process.execPath, ["benchmarks/perf/bundle-size.mjs", "vinext", "server"], {
      cwd: join(import.meta.dirname, ".."),
      env: { ...baseEnvironment, VINEXT_PERF_BENCHMARK_ID: "vinext-server-bundle-gzip" },
    });

    const samples = readFileSync(samplesPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(samples.map((sample) => sample.value)).toEqual([
      gzipSync(rscEntry).length + gzipSync(sharedChunk).length + gzipSync(reexportedChunk).length,
      gzipSync(rscEntry).length +
        gzipSync(ssrEntry).length +
        gzipSync(sharedChunk).length +
        gzipSync(reexportedChunk).length +
        gzipSync(lazyChunk).length,
    ]);
  });

  it("resolves Vite from the benchmark target when the trusted harness is relocated", () => {
    const directory = mkdtempSync(join(tmpdir(), "vinext-perf-relocated-harness-"));
    const repositoryRoot = join(import.meta.dirname, "..");
    const targetRoot = join(directory, "target");
    const harnessRoot = join(directory, "harness");
    const serverDirectory = join(targetRoot, "benchmarks/vinext/dist/server");
    const samplesPath = join(directory, "samples.jsonl");

    mkdirSync(serverDirectory, { recursive: true });
    mkdirSync(harnessRoot, { recursive: true });
    cpSync(join(repositoryRoot, "benchmarks/perf"), join(harnessRoot, "benchmarks/perf"), {
      recursive: true,
    });
    writeFileSync(join(targetRoot, "package.json"), '{"private":true}');
    symlinkSync(join(repositoryRoot, "node_modules"), join(targetRoot, "node_modules"), "dir");
    writeFileSync(join(serverDirectory, "index.js"), "import './shared.js';");
    writeFileSync(join(serverDirectory, "shared.js"), "export const shared = true;");

    execFileSync(
      process.execPath,
      [join(harnessRoot, "benchmarks/perf/bundle-size.mjs"), "vinext", "rsc-entry"],
      {
        cwd: harnessRoot,
        env: {
          ...process.env,
          VINEXT_PERF_TARGET_ROOT: targetRoot,
          VINEXT_PERF_SAMPLES: samplesPath,
          VINEXT_PERF_SCENARIO_ID: "bundle-size",
          VINEXT_PERF_SUITE: "Build",
          VINEXT_PERF_BENCHMARK_ID: "vinext-rsc-entry-gzip",
          VINEXT_PERF_LABEL: "RSC entry",
          VINEXT_PERF_IMPLEMENTATION_ID: "vinext",
          VINEXT_PERF_IMPLEMENTATION_LABEL: "vinext",
          VINEXT_PERF_UNIT: "bytes",
          VINEXT_PERF_LOWER_IS_BETTER: "true",
          VINEXT_PERF_REVISION: "head",
        },
      },
    );

    const sample = JSON.parse(readFileSync(samplesPath, "utf8"));
    expect(sample.value).toBe(
      gzipSync("import './shared.js';").length + gzipSync("export const shared = true;").length,
    );
  });

  it("measures only the eager client entry closure", () => {
    const directory = mkdtempSync(join(tmpdir(), "vinext-perf-client-entry-"));
    const clientDirectory = join(directory, "benchmarks/vinext/dist/client");
    const chunksDirectory = join(clientDirectory, "assets");
    const manifestDirectory = join(clientDirectory, ".vite");
    const samplesPath = join(directory, "samples.jsonl");
    const entry = "import './shared.js'; console.log('entry');";
    const shared = "export const shared = 'shared';";
    const lazy = "export const lazy = 'lazy';";
    mkdirSync(chunksDirectory, { recursive: true });
    mkdirSync(manifestDirectory, { recursive: true });
    writeFileSync(join(chunksDirectory, "entry.js"), entry);
    writeFileSync(join(chunksDirectory, "shared.js"), shared);
    writeFileSync(join(chunksDirectory, "lazy.js"), lazy);
    writeFileSync(
      join(manifestDirectory, "manifest.json"),
      JSON.stringify({
        "virtual:entry": {
          file: "assets/entry.js",
          isEntry: true,
          imports: ["shared"],
          dynamicImports: ["lazy"],
        },
        shared: {
          file: "assets/shared.js",
          imports: ["virtual:entry"],
        },
        lazy: {
          file: "assets/lazy.js",
          isDynamicEntry: true,
        },
      }),
    );

    execFileSync(process.execPath, ["benchmarks/perf/bundle-size.mjs", "vinext", "client-entry"], {
      cwd: join(import.meta.dirname, ".."),
      env: {
        ...process.env,
        VINEXT_PERF_TARGET_ROOT: directory,
        VINEXT_PERF_SAMPLES: samplesPath,
        VINEXT_PERF_BENCHMARK_ID: "vinext-client-entry-gzip",
        VINEXT_PERF_SCENARIO_ID: "client-entry-gzip",
        VINEXT_PERF_SUITE: "Build",
        VINEXT_PERF_LABEL: "Client entry size",
        VINEXT_PERF_IMPLEMENTATION_ID: "vinext",
        VINEXT_PERF_IMPLEMENTATION_LABEL: "vinext",
        VINEXT_PERF_UNIT: "bytes",
        VINEXT_PERF_LOWER_IS_BETTER: "true",
        VINEXT_PERF_REVISION: "head",
      },
    });

    const sample = JSON.parse(readFileSync(samplesPath, "utf8"));
    expect(sample.value).toBe(gzipSync(entry).length + gzipSync(shared).length);
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
    expect(results.schemaVersion).toBe(2);
    expect(results.run.skippedImplementations).toEqual([]);
    expect(results.benchmarks[0].samples).toMatchObject({ rounds: 2, median: 91 });
    expect(results.benchmarks[0].baselineSamples).toMatchObject({
      rounds: 2,
      median: 101,
    });
    expect(results.benchmarks[0].profileRounds).toBe(1);
  });

  it("requires every diagnostic profile to contain filterable traces", () => {
    const directory = mkdtempSync(join(tmpdir(), "vinext-perf-traces-"));
    const resultsPath = join(directory, "results.json");
    const firstProfile = "profiles/dev/samply-profile.json.gz";
    const secondProfile = "profiles/build/samply-profile.json.gz";
    mkdirSync(join(directory, "profiles/dev"), { recursive: true });
    mkdirSync(join(directory, "profiles/build"), { recursive: true });
    writeFileSync(
      join(directory, firstProfile),
      gzipSync(profileWithSources(["file:///repo/packages/vinext/src/index.ts"])),
    );
    writeFileSync(
      join(directory, secondProfile),
      gzipSync(
        profileWithSources([
          "file:///repo/packages/vinext/src/index.ts",
          "file:///repo/node_modules/vite-plus-core/dist/vite/node/index.js",
          "file:///repo/node_modules/rolldown/dist/index.mjs",
        ]),
      ),
    );
    writeFileSync(
      resultsPath,
      JSON.stringify({
        benchmarks: [
          { benchmarkId: "vinext-dev", profileFile: firstProfile },
          { benchmarkId: "vinext-build", profileFile: secondProfile },
        ],
      }),
    );

    expect(() =>
      execFileSync(
        process.execPath,
        ["benchmarks/perf/validate-profile-traces.mjs", resultsPath, directory],
        { cwd: join(import.meta.dirname, ".."), encoding: "utf8", stdio: "pipe" },
      ),
    ).toThrow("vinext-dev profile is missing sampled vite, rolldown frames");
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
      [`repos/cloudflare/vinext/git/commits/${headSha}`]: commit(measuredAt),
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
      "repos/cloudflare/vinext/actions/runs/123": sourceRun(
        "workflow_dispatch",
        workflowSha,
        "main",
      ),
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
      [`repos/cloudflare/vinext/git/commits/${headSha}`]: commit(measuredAt),
    });
  });

  it("accepts dispatched main artifacts after main advances", () => {
    const workflowSha = "c".repeat(40);
    const repositoryRoot = join(import.meta.dirname, "..");
    execFileSync("git", ["fetch", "--no-tags", "origin", "main"], {
      cwd: repositoryRoot,
    });
    const commitSha = execFileSync("git", ["rev-parse", "origin/main"], {
      cwd: repositoryRoot,
      encoding: "utf8",
    }).trim();
    const measuredAt = execFileSync("git", ["show", "-s", "--format=%cI", commitSha], {
      cwd: repositoryRoot,
      encoding: "utf8",
    }).trim();
    const payload = mainPerformancePayload({
      commitSha,
      measuredAt,
      benchmarks: [performanceBenchmark("vinext", false)],
    });

    validatePerformancePayload(payload, "workflow_dispatch", {
      "repos/cloudflare/vinext/actions/runs/123": sourceRun(
        "workflow_dispatch",
        workflowSha,
        "main",
      ),
      [`repos/cloudflare/vinext/contents/benchmarks/perf/scenarios.json?ref=${workflowSha}`]:
        githubFile(
          JSON.stringify({
            scenarios: [performanceScenario([{ id: "vinext", label: "vinext" }])],
          }),
        ),
      [`repos/cloudflare/vinext/git/commits/${commitSha}`]: commit(measuredAt),
    });
  }, 15_000);

  it("rejects dispatched artifacts from workflow refs outside main", () => {
    const workflowSha = "c".repeat(40);
    const headSha = "a".repeat(40);
    const baseSha = "b".repeat(40);
    const measuredAt = "2026-06-18T12:00:00.000Z";
    const payload = performancePayload({
      headSha,
      baseSha,
      measuredAt,
      benchmarks: [performanceBenchmark("vinext", true)],
    });

    expect(() =>
      validatePerformancePayload(payload, "workflow_dispatch", {
        "repos/cloudflare/vinext/actions/runs/123": sourceRun("workflow_dispatch", workflowSha),
        "repos/cloudflare/vinext/pulls/42": pullRequest(headSha, baseSha),
      }),
    ).toThrow("Dispatched workflow ref is not the default branch");
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
      [`repos/cloudflare/vinext/git/commits/${headSha}`]: commit(measuredAt),
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
      [`repos/cloudflare/vinext/git/commits/${headSha}`]: commit(measuredAt),
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
        GITHUB_REPOSITORY: "cloudflare/vinext",
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
    schemaVersion: benchmarks.some(
      (benchmark) =>
        typeof benchmark === "object" &&
        benchmark !== null &&
        "baselineSamples" in benchmark &&
        benchmark.baselineSamples !== null,
    )
      ? 2
      : 1,
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

function mainPerformancePayload({
  commitSha,
  measuredAt,
  benchmarks,
}: {
  commitSha: string;
  measuredAt: string;
  benchmarks: unknown[];
}) {
  return {
    schemaVersion: 1,
    provider: "samply",
    instrument: "walltime",
    run: {
      kind: "main",
      commitSha,
      baseSha: null,
      pullRequest: null,
      executionId: "123:1",
      measuredAt,
      repository: "cloudflare/vinext",
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

function sourceRun(event: string, headSha: string, headBranch = "benchmark-branch") {
  return {
    path: ".github/workflows/perf.yml",
    status: "completed",
    conclusion: "success",
    event,
    run_attempt: 1,
    head_sha: headSha,
    head_repository: { full_name: "cloudflare/vinext" },
    head_branch: headBranch,
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

function profileWithSources(sources: string[]) {
  return JSON.stringify({
    threads: [
      {
        stringArray: sources.map((source) => `function ${source}`),
        funcTable: { name: sources.map((_, index) => index) },
        frameTable: { func: sources.map((_, index) => index) },
        stackTable: {
          frame: sources.map((_, index) => index),
          prefix: sources.map((_, index) => (index === 0 ? null : index - 1)),
        },
        samples: { stack: [sources.length - 1], length: 1 },
      },
    ],
  });
}

function gitTreeEntry(path: string, sha: string) {
  return { path, sha, type: "blob" };
}

function githubTree(tree: Array<ReturnType<typeof gitTreeEntry>>) {
  return { truncated: false, tree };
}

function commit(measuredAt: string) {
  return { committer: { date: measuredAt } };
}
