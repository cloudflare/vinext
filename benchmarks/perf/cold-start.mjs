#!/usr/bin/env node

import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { reportPerformanceSample } from "./report-sample.mjs";

const benchmarkDir = dirname(dirname(fileURLToPath(import.meta.url)));
const repositoryRoot = dirname(benchmarkDir);
const framework = process.argv[2];
const route = process.argv[3] ?? "/";
const expectedText = process.env.VINEXT_PERF_EXPECTED_TEXT ?? "Benchmark App";

if (framework !== "vinext" && framework !== "nextjs") {
  console.error("Usage: node benchmarks/perf/cold-start.mjs <vinext|nextjs> [route]");
  process.exit(1);
}

const projectDir = join(benchmarkDir, framework);
const timeoutMs = Number(process.env.VINEXT_PERF_TIMEOUT_MS ?? 60_000);

async function allocatePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : null;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  if (!port) throw new Error("Failed to allocate a benchmark port");
  return port;
}

async function cleanFrameworkCache() {
  const paths =
    framework === "vinext"
      ? [join(projectDir, "node_modules/.vite"), join(projectDir, ".vite")]
      : [join(projectDir, ".next")];
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
}

function commandFor(port) {
  if (framework === "vinext") {
    return {
      command: join(repositoryRoot, "node_modules/.bin/vp"),
      args: ["dev", "--host", "127.0.0.1", "--port", String(port)],
    };
  }

  return {
    command: process.env.VINEXT_PERF_NEXT_BIN ?? join(projectDir, "node_modules/.bin/next"),
    args: ["dev", "--turbopack", "-H", "127.0.0.1", "-p", String(port)],
  };
}

async function waitForRoute(url, child, output, getSpawnError) {
  const deadline = performance.now() + timeoutMs;

  while (performance.now() < deadline) {
    const spawnError = getSpawnError();
    if (spawnError) throw spawnError;
    if (child.exitCode !== null) {
      throw new Error(`Dev server exited with code ${child.exitCode}\n${output.join("")}`);
    }

    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) {
        const body = await response.text();
        if (body.includes(expectedText)) return;
      }
    } catch {
      // The server is still starting.
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error(`Dev server did not serve ${url} within ${timeoutMs}ms\n${output.join("")}`);
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
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);

  if (child.exitCode === null) {
    try {
      if (processGroupId) globalThis.process.kill(-processGroupId, "SIGKILL");
    } catch {
      // The process exited between the checks.
    }
  }

  child.stdout.destroy();
  child.stderr.destroy();
}

async function main() {
  await cleanFrameworkCache();
  const port = await allocatePort();
  const { command, args } = commandFor(port);
  const output = [];
  let spawnError = null;
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

  child.stdout.on("data", (chunk) => output.push(chunk.toString()));
  child.stderr.on("data", (chunk) => output.push(chunk.toString()));
  child.on("error", (error) => {
    spawnError = new Error(`Failed to start ${framework} dev server: ${error.message}`);
  });

  try {
    await waitForRoute(`http://127.0.0.1:${port}${route}`, child, output, () => spawnError);
    const durationMs = performance.now() - startedAt;
    await reportPerformanceSample(durationMs);
  } finally {
    await stopProcessGroup(child);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});
