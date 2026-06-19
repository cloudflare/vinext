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
const headUser = process.env.VINEXT_PERF_HEAD_USER ?? process.env.VINEXT_PERF_TARGET_USER;
const baseUser = process.env.VINEXT_PERF_BASE_USER ?? headUser;
const profilerBin = process.env.VINEXT_PERF_PROFILER_BIN ?? "codspeed";
const resultsRoot = process.env.VINEXT_PERF_RESULTS_ROOT ?? join(targetRoot, "benchmarks/results");
const direct = process.argv.includes("--direct");
const setupOnly = process.argv.includes("--setup-only");
const roundsArgument = process.argv.find((argument) => argument.startsWith("--rounds="));
const requestedRounds = roundsArgument ? Number(roundsArgument.slice("--rounds=".length)) : null;
const implementationArgument = process.argv.find((argument) =>
  argument.startsWith("--implementation="),
);
const setupImplementation = implementationArgument?.slice("--implementation=".length);
const pairedRun = process.env.VINEXT_PERF_RUN_KIND === "pull_request" && Boolean(baseRoot);
const skippedImplementations = new Set(
  (process.env.VINEXT_PERF_SKIP_IMPLEMENTATIONS ?? "").split(",").filter(Boolean),
);

if (requestedRounds !== null && (!Number.isInteger(requestedRounds) || requestedRounds < 1)) {
  throw new Error(`--rounds must be a positive integer, received ${roundsArgument}`);
}

function trustedCommand(command) {
  if (command[0] === "vp") {
    const vpPath = execFileSync("which", ["vp"], { encoding: "utf8" }).trim();
    return [vpPath, ...command.slice(1)];
  }
  if (command[0] === "npm") {
    const npmPath = execFileSync("which", ["npm"], { encoding: "utf8" }).trim();
    return [npmPath, ...command.slice(1)];
  }
  if (command[0] !== "node" || !command[1]?.startsWith("benchmarks/")) return command;
  return [command[0], join(harnessRoot, command[1]), ...command.slice(2)];
}

function userForRoot(root) {
  return baseRoot && root === baseRoot ? baseUser : headUser;
}

function targetCommand(command, root = targetRoot) {
  const user = userForRoot(root);
  if (!user) return command;
  return ["sudo", "-E", "-H", "-u", user, "--", ...command];
}

function targetEnvironment(environment) {
  return Object.fromEntries(
    Object.entries(environment).filter(([name]) => !name.startsWith("VINEXT_PERF_")),
  );
}

function profilerCommand() {
  return [profilerBin];
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

async function cleanupTargetUser(root = targetRoot) {
  const user = userForRoot(root);
  if (!user) return;
  for (const signal of ["-STOP", "-KILL"]) {
    try {
      execFileSync("sudo", ["pkill", signal, "-u", user], { stdio: "ignore" });
    } catch (error) {
      if (error?.status !== 1) throw error;
    }
  }
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const processes = execFileSync("sudo", ["ps", "-u", user, "-o", "pid=,stat=,args="], {
        encoding: "utf8",
      })
        .trim()
        .split("\n")
        .filter((process) => process.trim() && !/^\s*\d+\s+\S*Z/.test(process))
        .join("\n");
      if (!processes) return;
      if (attempt === 19) {
        throw new Error(`Benchmark processes survived cleanup for ${user}:\n${processes}`);
      }
    } catch (error) {
      if (error?.status === 1) return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function runUntrusted(command, args, env, cwd, root) {
  try {
    await run(command, args, env, cwd);
  } finally {
    await cleanupTargetUser(root);
  }
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
    const command = trustedCommand(setup.command);
    const executable = setup.trusted ? command : targetCommand(command, targetRoot);
    const environment = setup.trusted
      ? { ...process.env, VINEXT_PERF_TARGET_ROOT: targetRoot }
      : targetEnvironment(process.env);
    const cwd = setup.cwd ? join(targetRoot, setup.cwd) : targetRoot;
    if (setup.trusted) await run(executable[0], executable.slice(1), environment, cwd);
    else await runUntrusted(executable[0], executable.slice(1), environment, cwd, targetRoot);
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
    VINEXT_PERF_PROFILE: "false",
    VINEXT_PERF_REVISION: revision,
    VINEXT_PERF_TARGET_USER: userForRoot(root),
  };
}

async function runTimingSample(scenario, implementation, revision, root) {
  const command = trustedCommand(implementation.command);
  const timingEnv = benchmarkEnvironment(scenario, implementation, revision, root);
  await runUntrusted(command[0], command.slice(1), timingEnv, root, root);
}

async function runProfile(scenario, implementation) {
  const id = benchmarkId(scenario, implementation);
  const profileDirectory = join(resultsRoot, `perf-profiles/${id}`);
  await mkdir(profileDirectory, { recursive: true });
  const command = trustedCommand(implementation.command);
  const profiler = profilerCommand();
  const profilerEnv = {
    ...benchmarkEnvironment(scenario, implementation, "head", targetRoot),
    VINEXT_PERF_PROFILE: "true",
    VINEXT_PERF_RECORD_SAMPLE: "false",
  };
  console.log(`Profiling one diagnostic round for ${id}`);
  await runUntrusted(
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
    targetRoot,
  );
}

for (const scenario of performanceScenarios) {
  for (const implementation of scenario.implementations) {
    if (skippedImplementations.has(implementation.id)) continue;
    const profile = implementation.profile === true;

    console.log(`\nRunning ${scenario.suite} / ${implementation.label} / ${scenario.label}`);
    if (direct) {
      const directRounds = requestedRounds ?? 5;
      for (let round = 0; round < directRounds; round++) {
        await runTimingSample(scenario, implementation, "head", targetRoot);
      }
      continue;
    }

    if (pairedRun && implementation.compareBase === true) {
      const pairedRounds = requestedRounds ?? DEFAULT_PAIRED_ROUNDS;
      for (let round = 0; round < pairedRounds; round++) {
        const roots = { base: baseRoot, head: targetRoot };
        const order = pairedRevisionOrder(round).map((revision) => [revision, roots[revision]]);
        console.log(
          `  Paired round ${round + 1}/${pairedRounds}: ${order.map(([revision]) => revision).join(" → ")}`,
        );
        for (const [revision, root] of order) {
          await runTimingSample(scenario, implementation, revision, root);
        }
      }
      if (profile) await runProfile(scenario, implementation);
      continue;
    }

    const timingRounds = requestedRounds ?? 5;
    for (let round = 0; round < timingRounds; round++) {
      await runTimingSample(scenario, implementation, "head", targetRoot);
    }
    if (profile) await runProfile(scenario, implementation);
  }
}
