import { spawn, type ChildProcess } from "node:child_process";

export const FIXTURE_STARTUP_TIMEOUT_MS = process.env.CI ? 90_000 : 30_000;
export const FIXTURE_HOOK_TIMEOUT_MS = FIXTURE_STARTUP_TIMEOUT_MS + 15_000;

const READY_POLL_INTERVAL_MS = 250;
const READY_REQUEST_TIMEOUT_MS = 2_000;
const SERVER_SETTLE_DELAY_MS = 500;

export type FixtureDevServer = {
  process: ChildProcess;
  baseUrl: string;
  fetchPage: (pathname: string) => Promise<{ html: string; status: number }>;
};

type FixtureDevServerOptions = {
  name: string;
  root: string;
  port: number;
  command?: {
    bin: string;
    args: string[];
  };
  startupTimeoutMs?: number;
  readinessPollIntervalMs?: number;
  readyRequestTimeoutMs?: number;
  serverSettleDelayMs?: number;
  onSpawn?: (proc: ChildProcess) => void;
};

export async function startFixtureDevServer({
  name,
  root,
  port,
  command = {
    bin: "npx",
    args: ["vp", "dev", "--port", String(port), "--strictPort"],
  },
  startupTimeoutMs = FIXTURE_STARTUP_TIMEOUT_MS,
  readinessPollIntervalMs = READY_POLL_INTERVAL_MS,
  readyRequestTimeoutMs = READY_REQUEST_TIMEOUT_MS,
  serverSettleDelayMs = SERVER_SETTLE_DELAY_MS,
  onSpawn,
}: FixtureDevServerOptions): Promise<FixtureDevServer> {
  const baseUrl = `http://localhost:${port}`;
  const proc = spawn(command.bin, command.args, {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
    detached: process.platform !== "win32",
  });

  onSpawn?.(proc);

  let output = "";
  const appendOutput = (data: Buffer | string) => {
    output += data.toString();
  };

  proc.stdout?.on("data", appendOutput);
  proc.stderr?.on("data", appendOutput);

  try {
    await waitForFixtureReady({
      name,
      baseUrl,
      proc,
      getOutput: () => output,
      startupTimeoutMs,
      readinessPollIntervalMs,
      readyRequestTimeoutMs,
    });
  } catch (error) {
    stopFixtureDevServer(proc);
    throw error;
  }

  await new Promise((resolve) => setTimeout(resolve, serverSettleDelayMs));

  async function fetchPage(pathname: string) {
    const res = await fetch(`${baseUrl}${pathname}`, {
      signal: AbortSignal.timeout(10_000),
    });
    const html = await res.text();
    return { html, status: res.status };
  }

  return { process: proc, baseUrl, fetchPage };
}

export function stopFixtureDevServer(proc: ChildProcess | null | undefined) {
  if (!proc || proc.killed) {
    return;
  }

  if (process.platform === "win32") {
    try {
      proc.kill("SIGTERM");
    } catch {
      return;
    }
    return;
  }

  const pid = proc.pid;
  if (pid == null) {
    return;
  }

  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      proc.kill("SIGKILL");
    } catch {
      // ignore
    }
  }
}

async function waitForFixtureReady({
  name,
  baseUrl,
  proc,
  getOutput,
  startupTimeoutMs,
  readinessPollIntervalMs,
  readyRequestTimeoutMs,
}: {
  name: string;
  baseUrl: string;
  proc: ChildProcess;
  getOutput: () => string;
  startupTimeoutMs: number;
  readinessPollIntervalMs: number;
  readyRequestTimeoutMs: number;
}) {
  await new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + startupTimeoutMs;

    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };

    const onExit = (code: number | null) => {
      cleanup();
      reject(new Error(`Fixture "${name}" exited with code ${code}: ${getOutput()}`));
    };

    let pollTimer: NodeJS.Timeout | undefined;
    const cleanup = () => {
      if (pollTimer) {
        clearTimeout(pollTimer);
      }
      proc.off("error", onError);
      proc.off("exit", onExit);
    };

    const checkReady = async () => {
      if (Date.now() >= deadline) {
        cleanup();
        reject(
          new Error(`Fixture "${name}" did not start within ${startupTimeoutMs}ms: ${getOutput()}`),
        );
        return;
      }

      try {
        const res = await fetch(`${baseUrl}/`, {
          redirect: "manual",
          signal: AbortSignal.timeout(readyRequestTimeoutMs),
        });
        await res.body?.cancel();
        cleanup();
        resolve();
      } catch {
        pollTimer = setTimeout(checkReady, readinessPollIntervalMs);
      }
    };

    proc.on("error", onError);
    proc.on("exit", onExit);
    void checkReady();
  });
}
