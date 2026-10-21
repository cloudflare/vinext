#!/usr/bin/env node

import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { reportPerformanceSample } from "./report-sample.mjs";

const repositoryRoot = process.env.VINEXT_PERF_TARGET_ROOT ?? process.cwd();
const benchmarkDir = join(repositoryRoot, "benchmarks");
const targetUser = process.env.VINEXT_PERF_TARGET_USER;
const profiling = process.env.VINEXT_PERF_PROFILE === "true";
const framework = process.argv[2];
// /dashboard is a force-dynamic App Router route whose layout and page render
// "use client" components (Timer, Counter). Its first response therefore loads
// the server bundle, the client-reference manifest, and the SSR entry instead of
// serving a prerendered file. "Uptime" is markup the Timer client component
// emits itself; it is not a prop in the RSC payload, so the response only
// matches once client components were really server-rendered.
const route = process.argv[3] ?? "/dashboard";
const expectedText = process.env.VINEXT_PERF_EXPECTED_TEXT ?? "Uptime";
const timeoutMs = Number(process.env.VINEXT_PERF_TIMEOUT_MS ?? 120_000);
const benchmarkEnvironmentNames = Object.keys(process.env).filter((name) =>
  name.startsWith("VINEXT_PERF_"),
);

if (framework !== "vinext" && framework !== "nextjs") {
  console.error("Usage: node benchmarks/perf/production-cold-start.mjs <vinext|nextjs> [route]");
  process.exit(1);
}

const projectDir = join(benchmarkDir, framework);
// The production build is created once by the setup commands in scenarios.json
// and shared by every sample; only the server process is fresh each time.
const buildOutputPath = join(projectDir, framework === "vinext" ? "dist/server" : ".next/BUILD_ID");

function targetEnvironment() {
  const environment = { ...process.env };
  for (const name of benchmarkEnvironmentNames) delete environment[name];
  return {
    ...environment,
    NEXT_TELEMETRY_DISABLED: "1",
    NO_COLOR: "1",
  };
}

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

function commandFor(port) {
  let command;
  if (framework === "vinext") {
    // Run the CLI entry through node directly; the node_modules/.bin shim would
    // add a shell launcher to every sample.
    const cliPath = join(projectDir, "node_modules/vinext/dist/cli.js");
    command = {
      command: globalThis.process.execPath,
      args: [cliPath, "start", "--hostname", "127.0.0.1", "--port", String(port)],
    };
  } else {
    command = {
      command: process.env.VINEXT_PERF_NEXT_BIN ?? join(projectDir, "node_modules/.bin/next"),
      args: ["start", "-H", "127.0.0.1", "-p", String(port)],
    };
  }
  return targetUser && !profiling
    ? { command: "sudo", args: ["-u", targetUser, "--", command.command, ...command.args] }
    : command;
}

async function waitForRoute(url, child, output, getSpawnError) {
  const deadline = performance.now() + timeoutMs;

  while (performance.now() < deadline) {
    const spawnError = getSpawnError();
    if (spawnError) throw spawnError;
    if (child.exitCode !== null) {
      throw new Error(`Production server exited with code ${child.exitCode}\n${output.join("")}`);
    }

    try {
      // Let an accepted request run until the overall deadline so one slow first
      // render is measured as a single cold request, not as overlapping retries.
      const signal = AbortSignal.timeout(Math.max(1, Math.ceil(deadline - performance.now())));
      const response = await fetch(url, { signal });
      if (response.ok) {
        const body = await response.text();
        if (body.includes(expectedText)) return;
      }
    } catch {
      // The server is still starting.
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error(
    `Production server did not serve ${url} within ${timeoutMs}ms\n${output.join("")}`,
  );
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

  // Clear the grace timer once the server is gone so it does not keep this
  // process alive for the full two seconds after every sample.
  let gracePeriod;
  await Promise.race([
    child.exitCode === null
      ? new Promise((resolve) => child.once("exit", resolve))
      : Promise.resolve(),
    new Promise((resolve) => (gracePeriod = setTimeout(resolve, 2_000))),
  ]);
  clearTimeout(gracePeriod);

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
  try {
    await access(buildOutputPath);
  } catch {
    throw new Error(
      `Build output not found at ${buildOutputPath}; run the production build setup first`,
    );
  }
  const port = await allocatePort();
  const { command, args } = commandFor(port);
  const output = [];
  let spawnError = null;
  const startedAt = performance.now();
  const child = spawn(command, args, {
    cwd: projectDir,
    detached: true,
    env: targetEnvironment(),
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.on("data", (chunk) => output.push(chunk.toString()));
  child.stderr.on("data", (chunk) => output.push(chunk.toString()));
  child.on("error", (error) => {
    spawnError = new Error(`Failed to start ${framework} production server: ${error.message}`);
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
