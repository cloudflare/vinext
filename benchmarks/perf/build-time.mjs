#!/usr/bin/env node

import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { reportPerformanceSample } from "./report-sample.mjs";

const benchmarkDir = dirname(dirname(fileURLToPath(import.meta.url)));
const repositoryRoot = dirname(benchmarkDir);
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
  if (framework === "vinext") {
    return {
      command: join(repositoryRoot, "node_modules/.bin/vp"),
      args: ["build"],
    };
  }

  return {
    command: process.env.VINEXT_PERF_NEXT_BIN ?? join(projectDir, "node_modules/.bin/next"),
    args: ["build", "--turbopack"],
  };
}

async function stopProcessGroup(child) {
  if (child.exitCode !== null || !child.pid) return;
  try {
    globalThis.process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
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

  const timeout = setTimeout(() => void stopProcessGroup(child), timeoutMs);
  try {
    const { code, signal } = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (exitCode, exitSignal) => resolve({ code: exitCode, signal: exitSignal }));
    });
    if (code !== 0) {
      throw new Error(
        `${framework} build exited with ${signal ? `signal ${signal}` : `code ${code}`}\n${output.join("")}`,
      );
    }
    await reportPerformanceSample(performance.now() - startedAt);
  } finally {
    clearTimeout(timeout);
    await stopProcessGroup(child);
    child.stdout.destroy();
    child.stderr.destroy();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});
