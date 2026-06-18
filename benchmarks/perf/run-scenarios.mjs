#!/usr/bin/env node

import { execFileSync, spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { performanceScenarios, performanceSetup, benchmarkId } from "./scenarios.mjs";

const harnessRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const targetRoot = process.env.VINEXT_PERF_TARGET_ROOT ?? process.cwd();
const targetUser = process.env.VINEXT_PERF_TARGET_USER;
const profilerBin = process.env.VINEXT_PERF_PROFILER_BIN ?? "codspeed";
const resultsRoot = process.env.VINEXT_PERF_RESULTS_ROOT ?? join(targetRoot, "benchmarks/results");
const direct = process.argv.includes("--direct");
const setupOnly = process.argv.includes("--setup-only");
const roundsArgument = process.argv.find((argument) => argument.startsWith("--rounds="));
const rounds = Number(roundsArgument?.slice("--rounds=".length) ?? 0);

function trustedCommand(command) {
  if (command[0] === "vp") return [join(targetRoot, "node_modules/.bin/vp"), ...command.slice(1)];
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
    const command = trustedCommand(setup.command);
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

for (const scenario of performanceScenarios) {
  for (const implementation of scenario.implementations) {
    const id = benchmarkId(scenario, implementation);
    const profile = implementation.profile === true;
    const env = {
      ...process.env,
      VINEXT_PERF_BENCHMARK_ID: id,
      VINEXT_PERF_SCENARIO_ID: scenario.id,
      VINEXT_PERF_SUITE: scenario.suite,
      VINEXT_PERF_LABEL: scenario.label,
      VINEXT_PERF_DESCRIPTION: scenario.description,
      VINEXT_PERF_UNIT: scenario.unit,
      VINEXT_PERF_LOWER_IS_BETTER: String(scenario.lowerIsBetter),
      VINEXT_PERF_IMPLEMENTATION_ID: implementation.id,
      VINEXT_PERF_IMPLEMENTATION_LABEL: implementation.label,
      VINEXT_PERF_PROFILE: String(profile),
    };

    console.log(`\nRunning ${scenario.suite} / ${implementation.label} / ${scenario.label}`);
    if (direct) {
      const directRounds = rounds > 0 ? rounds : 1;
      for (let round = 0; round < directRounds; round++) {
        const command = trustedCommand(implementation.command);
        await run(command[0], command.slice(1), env);
      }
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
    const command = trustedCommand(implementation.command);
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
