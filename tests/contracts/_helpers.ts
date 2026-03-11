import { spawn, type ChildProcessByStdio } from "node:child_process";
import net from "node:net";
import type { Readable } from "node:stream";
import { APP_FIXTURE_DIR, startFixtureServer } from "../helpers";

type SpawnedContractProcess = ChildProcessByStdio<null, Readable, Readable>;

export interface ContractServer {
  baseUrl: string;
  close(): Promise<void>;
}

let server: ContractServer | null = null;

function getContractTarget(): "vinext" | "nextjs" {
  return process.env.CONTRACT_TARGET === "nextjs" ? "nextjs" : "vinext";
}

async function getAvailablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      if (!address || typeof address === "string") {
        reject(new Error("Failed to resolve an available port"));
        return;
      }
      const port = address.port;
      srv.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

async function waitForServerReady(
  baseUrl: string,
  proc: SpawnedContractProcess,
  output: { value: string },
): Promise<void> {
  const deadline = Date.now() + 30_000;

  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      throw new Error(
        `next dev exited before becoming ready (code ${proc.exitCode})\n${output.value.trim()}`,
      );
    }

    try {
      const res = await fetch(`${baseUrl}/about`, { redirect: "manual" });
      if (res.status > 0) return;
    } catch {
      // Retry until the deadline.
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`Timed out waiting for next dev at ${baseUrl}\n${output.value.trim()}`);
}

async function stopProcess(proc: SpawnedContractProcess): Promise<void> {
  if (proc.exitCode !== null) return;

  proc.kill("SIGTERM");

  await Promise.race([
    new Promise<void>((resolve) => proc.once("exit", () => resolve())),
    new Promise<void>((resolve) =>
      setTimeout(() => {
        if (proc.exitCode === null) proc.kill("SIGKILL");
        resolve();
      }, 5_000),
    ),
  ]);
}

async function startNextjsContractServer(): Promise<ContractServer> {
  const port = await getAvailablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const output = { value: "" };

  const proc = spawn(
    "pnpm",
    [
      "--dir",
      APP_FIXTURE_DIR,
      "exec",
      "next",
      "dev",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(port),
    ],
    {
      cwd: APP_FIXTURE_DIR,
      env: {
        ...process.env,
        NEXT_TELEMETRY_DISABLED: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  const appendOutput = (chunk: Buffer) => {
    output.value += chunk.toString("utf-8");
    if (output.value.length > 8_000) {
      output.value = output.value.slice(-8_000);
    }
  };

  proc.stdout.on("data", appendOutput);
  proc.stderr.on("data", appendOutput);

  await waitForServerReady(baseUrl, proc, output);

  return {
    baseUrl,
    async close() {
      await stopProcess(proc);
    },
  };
}

/**
 * Get or create the shared contract test server.
 *
 * CONTRACT_TARGET=vinext (default) boots the Vite/vinext fixture.
 * CONTRACT_TARGET=nextjs boots a real `next dev` server against the same fixture.
 * CONTRACT_TARGET_URL bypasses local boot entirely and targets an external URL.
 */
export async function getContractServer(): Promise<ContractServer> {
  if (process.env.CONTRACT_TARGET_URL) {
    return {
      baseUrl: process.env.CONTRACT_TARGET_URL,
      async close() {},
    };
  }

  if (!server) {
    if (getContractTarget() === "nextjs") {
      server = await startNextjsContractServer();
    } else {
      const viteServer = await startFixtureServer(APP_FIXTURE_DIR);
      server = {
        baseUrl: viteServer.baseUrl,
        async close() {
          await viteServer.server.close();
        },
      };
    }
  }

  return server;
}

export async function closeContractServer(): Promise<void> {
  if (server) {
    await server.close();
    server = null;
  }
}
