#!/usr/bin/env node

import { spawn } from "node:child_process";
import { performanceScenarios, performanceSetup, benchmarkId } from "./scenarios.mjs";

const direct = process.argv.includes("--direct");
const setupOnly = process.argv.includes("--setup-only");
const roundsArgument = process.argv.find((argument) => argument.startsWith("--rounds="));
const rounds = Number(roundsArgument?.slice("--rounds=".length) ?? 0);

function run(command, args, env, cwd) {
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
    await run(setup.command[0], setup.command.slice(1), process.env, setup.cwd);
  }
  process.exit(0);
}

for (const scenario of performanceScenarios) {
  for (const implementation of scenario.implementations) {
    const id = benchmarkId(scenario, implementation);
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
      VINEXT_PERF_PROFILE: String(scenario.profile),
    };

    console.log(`\nRunning ${scenario.suite} / ${implementation.label} / ${scenario.label}`);
    if (direct) {
      const directRounds = rounds > 0 ? rounds : 1;
      for (let round = 0; round < directRounds; round++) {
        await run(implementation.command[0], implementation.command.slice(1), env);
      }
      continue;
    }

    const profileArguments = scenario.profile
      ? [
          "--walltime-profiler",
          "samply",
          "--profile-folder",
          `benchmarks/results/perf-profiles/${id}`,
        ]
      : [];
    await run(
      "codspeed",
      [
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
        ...implementation.command,
      ],
      env,
    );
  }
}
