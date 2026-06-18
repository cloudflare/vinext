#!/usr/bin/env node

import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { reportPerformanceSample } from "./report-sample.mjs";

const repositoryRoot = process.env.VINEXT_PERF_TARGET_ROOT ?? process.cwd();
const benchmarkDir = join(repositoryRoot, "benchmarks");
const targetUser = process.env.VINEXT_PERF_TARGET_USER;
const framework = process.argv[2];
const timeoutMs = Number(process.env.VINEXT_PERF_TIMEOUT_MS ?? 180_000);

if (framework !== "vinext" && framework !== "nextjs") {
  console.error("Usage: node benchmarks/perf/build-time.mjs <vinext|nextjs>");
  process.exit(1);
}

const projectDir = join(benchmarkDir, framework);

async function cleanBuildOutput() {
  await rm(join(projectDir, framework === "vinext" ? "dist" : ".next"), {
    recursive: true,
    force: true,
  });
}

function buildCommand() {
  let command;
  if (framework === "vinext") {
    command = {
      command: join(repositoryRoot, "node_modules/.bin/vp"),
      args: ["build"],
    };
  } else {
    command = {
      command: process.env.VINEXT_PERF_NEXT_BIN ?? join(projectDir, "node_modules/.bin/next"),
      args: ["build", "--turbopack"],
    };
  }
  return targetUser
    ? { command: "sudo", args: ["-u", targetUser, "--", command.command, ...command.args] }
    : command;
}

async function stopProcessGroup(child) {
  const processGroupId = child.pid;
  try {
    if (processGroupId) globalThis.process.kill(-processGroupId, "SIGTERM");
  } catch {
    try {
      if (child.exitCode === null) child.kill("SIGTERM");
    } catch {
      // The launcher and its process group have already exited.
    }
  }

  await Promise.race([
    child.exitCode === null
      ? new Promise((resolve) => child.once("exit", resolve))
      : Promise.resolve(),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);

  if (child.exitCode === null) {
    try {
      if (processGroupId) globalThis.process.kill(-processGroupId, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        // The process exited between the checks.
      }
    }
  }
}

async function main() {
  await cleanBuildOutput();
  const { command, args } = buildCommand();
  const startedAt = performance.now();
  const child = spawn(command, args, {
    cwd: projectDir,
    detached: true,
    env: {
      ...process.env,
      NEXT_TELEMETRY_DISABLED: "1",
      NO_COLOR: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = [];
  child.stdout.on("data", (chunk) => output.push(chunk.toString()));
  child.stderr.on("data", (chunk) => output.push(chunk.toString()));

  let timeoutId;
  try {
    const result = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (exitCode, exitSignal) => resolve({ code: exitCode, signal: exitSignal }));
    });
    const timeout = new Promise(
      (_, reject) =>
        (timeoutId = setTimeout(
          () => reject(new Error(`${framework} build timed out after ${timeoutMs}ms`)),
          timeoutMs,
        )),
    );
    const { code, signal } = await Promise.race([result, timeout]);
    if (code !== 0) {
      throw new Error(
        `${framework} build exited with ${signal ? `signal ${signal}` : `code ${code}`}\n${output.join("")}`,
      );
    }
    await reportPerformanceSample(performance.now() - startedAt);
  } finally {
    clearTimeout(timeoutId);
    await stopProcessGroup(child);
    child.stdout.destroy();
    child.stderr.destroy();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});
