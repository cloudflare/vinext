import { execFile, spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

const READY_PREFIX = "__VINEXT_TEST_SERVER_READY__:";
const SHUTDOWN_GRACE_MS = 5_000;

export type ChildProductionServer = {
  port: number;
  process: ChildProcess;
  description: string;
  failure: Error | null;
};

const stoppingChildren = new WeakSet<ChildProcess>();

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);

  return new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => {
      child.removeListener("exit", onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timeout);
      resolve(true);
    };
    child.once("exit", onExit);
  });
}

async function terminateChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;

  stoppingChildren.add(child);
  child.kill("SIGTERM");
  if (await waitForExit(child, SHUTDOWN_GRACE_MS)) return;
  if (child.exitCode !== null || child.signalCode !== null) return;

  if (process.platform === "win32" && child.pid !== undefined) {
    try {
      await new Promise<void>((resolve, reject) => {
        execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], (error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    } catch (error) {
      if (child.exitCode === null && child.signalCode === null) throw error;
    }
  } else {
    child.kill("SIGKILL");
  }
  if (!(await waitForExit(child, SHUTDOWN_GRACE_MS))) {
    throw new Error(`Child process ${String(child.pid)} did not exit after forced termination`);
  }
}

async function waitForChildServer(
  child: ChildProcess,
  description: string,
): Promise<ChildProductionServer> {
  child.stderr?.pipe(process.stderr);
  const server: ChildProductionServer = { port: 0, process: child, description, failure: null };

  const recordProcessError = (error: Error) => {
    server.failure ??= new Error(`${description} child process error: ${error.message}`, {
      cause: error,
    });
  };
  const recordUnexpectedExit = (code: number | null, signal: NodeJS.Signals | null) => {
    if (stoppingChildren.has(child)) return;
    server.failure ??= new Error(
      `${description} child exited unexpectedly (code ${String(code)}, signal ${String(signal)})`,
    );
  };
  child.on("error", recordProcessError);
  child.on("exit", recordUnexpectedExit);

  try {
    server.port = await new Promise<number>((resolve, reject) => {
      let stdout = "";
      let ready = false;
      const cleanupReadinessListeners = () => {
        clearTimeout(timeout);
        child.removeListener("error", onStartupError);
        child.removeListener("exit", onStartupExit);
      };
      const fail = (error: Error) => {
        cleanupReadinessListeners();
        reject(error);
      };
      const onStartupError = (error: Error) => fail(error);
      const onStartupExit = (code: number | null, signal: NodeJS.Signals | null) => {
        fail(
          new Error(
            `${description} child exited before becoming ready (code ${String(code)}, signal ${String(signal)})`,
          ),
        );
      };
      const onStdout = (chunk: Buffer) => {
        stdout += chunk.toString();
        const lines = stdout.split("\n");
        stdout = lines.pop() ?? "";
        for (const line of lines) {
          if (line.startsWith(READY_PREFIX)) {
            if (ready) continue;
            ready = true;
            const port = Number(line.slice(READY_PREFIX.length));
            cleanupReadinessListeners();
            resolve(port);
            continue;
          }
          if (line.length > 0) console.log(line);
        }
      };
      const timeout = setTimeout(
        () => fail(new Error(`Timed out waiting for the ${description} child process`)),
        30_000,
      );

      child.once("error", onStartupError);
      child.once("exit", onStartupExit);
      child.stdout?.on("data", onStdout);
    });
    return server;
  } catch (error) {
    try {
      await terminateChild(child);
    } catch (shutdownError) {
      throw new AggregateError([error, shutdownError], `${description} startup and cleanup failed`);
    }
    throw error;
  }
}

export async function startChildProductionServer(
  fixtureRoot: string,
): Promise<ChildProductionServer> {
  const prodServerUrl = pathToFileURL(
    path.resolve(process.cwd(), "packages/vinext/dist/server/prod-server.js"),
  ).href;
  const script = `
import { startProdServer } from ${JSON.stringify(prodServerUrl)};

const started = await startProdServer({
  host: "127.0.0.1",
  port: 0,
  outDir: ${JSON.stringify(path.join(fixtureRoot, "dist"))},
  noCompression: true,
});

console.log(${JSON.stringify(READY_PREFIX)} + started.port);

const shutdown = () => {
  started.server.close(() => process.exit(0));
  started.server.closeIdleConnections();
  started.server.closeAllConnections();
};

process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
`;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: fixtureRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });

  return waitForChildServer(child, "production server");
}

export async function startChildViteDevServer(fixtureRoot: string): Promise<ChildProductionServer> {
  const script = `
import { createServer } from "vite";

const server = await createServer({
  root: ${JSON.stringify(fixtureRoot)},
  configFile: ${JSON.stringify(path.join(fixtureRoot, "vite.config.ts"))},
  logLevel: "silent",
  server: { host: "127.0.0.1", port: 0 },
});
await server.listen();

const address = server.httpServer?.address();
if (!address || typeof address === "string") {
  throw new Error("Vite did not expose a local fixture port");
}
console.log(${JSON.stringify(READY_PREFIX)} + address.port);

const shutdown = async () => {
  await server.close();
  process.exit(0);
};

process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
`;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: fixtureRoot,
    env: { ...process.env, NODE_ENV: "development" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  return waitForChildServer(child, "Vite development server");
}

export async function stopChildProductionServer(server: ChildProductionServer): Promise<void> {
  await terminateChild(server.process);
  if (server.failure) throw server.failure;
}
