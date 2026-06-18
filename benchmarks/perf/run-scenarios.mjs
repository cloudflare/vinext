#!/usr/bin/env node

import { execFileSync, spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_PAIRED_ROUNDS, pairedRevisionOrder } from "./pairing.mts";
import { performanceScenarios, performanceSetup, benchmarkId } from "./scenarios.mjs";

const harnessRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const targetRoot = process.env.VINEXT_PERF_TARGET_ROOT ?? process.cwd();
const baseRoot = process.env.VINEXT_PERF_BASE_ROOT;
const targetUser = process.env.VINEXT_PERF_TARGET_USER;
const profilerBin = process.env.VINEXT_PERF_PROFILER_BIN ?? "codspeed";
const resultsRoot = process.env.VINEXT_PERF_RESULTS_ROOT ?? join(targetRoot, "benchmarks/results");
const direct = process.argv.includes("--direct");
const setupOnly = process.argv.includes("--setup-only");
const roundsArgument = process.argv.find((argument) => argument.startsWith("--rounds="));
const rounds = Number(roundsArgument?.slice("--rounds=".length) ?? 0);
const implementationArgument = process.argv.find((argument) =>
  argument.startsWith("--implementation="),
);
const setupImplementation = implementationArgument?.slice("--implementation=".length);
const pairedRun = process.env.VINEXT_PERF_RUN_KIND === "pull_request" && Boolean(baseRoot);
const skippedImplementations = new Set(
  (process.env.VINEXT_PERF_SKIP_IMPLEMENTATIONS ?? "").split(",").filter(Boolean),
);

function trustedCommand(command, root = targetRoot) {
  if (command[0] === "vp") return [join(root, "node_modules/.bin/vp"), ...command.slice(1)];
  if (command[0] === "npm") {
    const npmPath = execFileSync("which", ["npm"], { encoding: "utf8" }).trim();
    return [npmPath, ...command.slice(1)];
  }
  if (command[0] !== "node" || !command[1]?.startsWith("benchmarks/")) return command;
  return [command[0], join(harnessRoot, command[1]), ...command.slice(2)];
}

function targetCommand(command) {
  if (!targetUser) return command;
  return ["sudo", "-E", "-H", "-u", targetUser, "--", ...command];
}

function profilerCommand() {
  if (!targetUser) return [profilerBin];
  const targetHome = `/home/${targetUser}`;
  return [
    "sudo",
    "-E",
    "-H",
    "-u",
    targetUser,
    "--",
    "env",
    "-u",
    "GITHUB_ENV",
    "-u",
    "GITHUB_PATH",
    `HOME=${targetHome}`,
    `CARGO_HOME=${targetHome}/.cargo`,
    `XDG_CACHE_HOME=${targetHome}/.cache`,
    `XDG_CONFIG_HOME=${targetHome}/.config`,
    `PATH=${targetHome}/.cargo/bin:${targetHome}/.local/bin:${process.env.PATH}`,
    profilerBin,
  ];
}

function run(command, args, env, cwd = targetRoot) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else
        reject(new Error(`${command} exited with ${signal ? `signal ${signal}` : `code ${code}`}`));
    });
  });
}

if (setupOnly) {
  for (const setup of performanceSetup) {
    if (
      setupImplementation &&
      setup.implementationId &&
      setup.implementationId !== setupImplementation
    ) {
      continue;
    }
    const command = trustedCommand(setup.command, targetRoot);
    const executable = setup.trusted ? command : targetCommand(command);
    await run(
      executable[0],
      executable.slice(1),
      { ...process.env, VINEXT_PERF_TARGET_ROOT: targetRoot },
      setup.cwd ? join(targetRoot, setup.cwd) : targetRoot,
    );
  }
  process.exit(0);
}

function benchmarkEnvironment(scenario, implementation, revision, root) {
  const id = benchmarkId(scenario, implementation);
  return {
    ...process.env,
    VINEXT_PERF_TARGET_ROOT: root,
    VINEXT_PERF_BENCHMARK_ID: id,
    VINEXT_PERF_SCENARIO_ID: scenario.id,
    VINEXT_PERF_SUITE: scenario.suite,
    VINEXT_PERF_LABEL: scenario.label,
    VINEXT_PERF_DESCRIPTION: scenario.description,
    VINEXT_PERF_UNIT: scenario.unit,
    VINEXT_PERF_LOWER_IS_BETTER: String(scenario.lowerIsBetter),
    VINEXT_PERF_IMPLEMENTATION_ID: implementation.id,
    VINEXT_PERF_IMPLEMENTATION_LABEL: implementation.label,
    VINEXT_PERF_PROFILE: String(implementation.profile === true),
    VINEXT_PERF_REVISION: revision,
  };
}

async function runDirectSample(scenario, implementation, revision, root) {
  const command = trustedCommand(implementation.command, root);
  await run(
    command[0],
    command.slice(1),
    benchmarkEnvironment(scenario, implementation, revision, root),
    root,
  );
}

async function runProfile(scenario, implementation) {
  const id = benchmarkId(scenario, implementation);
  const profileDirectory = join(resultsRoot, `perf-profiles/${id}`);
  await mkdir(profileDirectory, { recursive: true });
  const command = trustedCommand(implementation.command, targetRoot);
  const profiler = profilerCommand();
  const profilerEnv = {
    ...benchmarkEnvironment(scenario, implementation, "head", targetRoot),
    VINEXT_PERF_SKIP_SAMPLE: "true",
  };
  if (targetUser) delete profilerEnv.VINEXT_PERF_TARGET_USER;
  await run(
    profiler[0],
    [
      ...profiler.slice(1),
      "exec",
      "--mode",
      "walltime",
      "--walltime-profiler",
      "samply",
      "--profile-folder",
      profileDirectory,
      "--name",
      id,
      "--warmup-time",
      "0s",
      "--min-rounds",
      "1",
      "--max-rounds",
      "1",
      "--max-time",
      "3m",
      "--",
      ...command,
    ],
    profilerEnv,
    targetRoot,
  );
}

for (const scenario of performanceScenarios) {
  for (const implementation of scenario.implementations) {
    if (skippedImplementations.has(implementation.id)) continue;
    const id = benchmarkId(scenario, implementation);
    const profile = implementation.profile === true;
    const env = benchmarkEnvironment(scenario, implementation, "head", targetRoot);

    console.log(`\nRunning ${scenario.suite} / ${implementation.label} / ${scenario.label}`);
    if (direct) {
      const directRounds = rounds > 0 ? rounds : 1;
      for (let round = 0; round < directRounds; round++) {
        await runDirectSample(scenario, implementation, "head", targetRoot);
      }
      continue;
    }

    if (pairedRun && implementation.compareBase === true) {
      const pairedRounds = rounds > 0 ? rounds : DEFAULT_PAIRED_ROUNDS;
      for (let round = 0; round < pairedRounds; round++) {
        const roots = { base: baseRoot, head: targetRoot };
        const order = pairedRevisionOrder(round).map((revision) => [revision, roots[revision]]);
        console.log(
          `  Paired round ${round + 1}/${pairedRounds}: ${order.map(([revision]) => revision).join(" → ")}`,
        );
        for (const [revision, root] of order) {
          await runDirectSample(scenario, implementation, revision, root);
        }
      }
      if (profile) await runProfile(scenario, implementation);
      continue;
    }

    const profileArguments = profile
      ? [
          "--walltime-profiler",
          "samply",
          "--profile-folder",
          join(resultsRoot, `perf-profiles/${id}`),
        ]
      : [];
    if (profile) await mkdir(join(resultsRoot, `perf-profiles/${id}`), { recursive: true });
    const command = trustedCommand(implementation.command, targetRoot);
    const profiler = profilerCommand();
    const profilerEnv = { ...env };
    if (targetUser) delete profilerEnv.VINEXT_PERF_TARGET_USER;
    await run(
      profiler[0],
      [
        ...profiler.slice(1),
        "exec",
        "--mode",
        "walltime",
        ...profileArguments,
        "--name",
        id,
        "--warmup-time",
        "0s",
        "--min-rounds",
        String(rounds > 0 ? rounds : 5),
        "--max-rounds",
        String(rounds > 0 ? rounds : 10),
        "--max-time",
        "3m",
        "--",
        ...command,
      ],
      profilerEnv,
      targetRoot,
    );
  }
}
