/**
 * `vinext start` shuts down gracefully on SIGINT and SIGTERM, like `next start`
 * and Next.js's standalone `server.js`: it stops accepting connections, lets
 * in-flight requests and `after()` callbacks finish, then exits with
 * 128 + the signal number. https://github.com/cloudflare/vinext/issues/4588
 *
 * Ported from Next.js:
 *   - test/production/graceful-shutdown/index.test.ts
 *   - test/e2e/app-dir/graceful-shutdown-next-after/next-start/index.test.ts
 *
 * @see https://github.com/vercel/next.js/blob/canary/test/production/graceful-shutdown/index.test.ts
 * @see https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/graceful-shutdown-next-after/next-start/index.test.ts
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { once } from "node:events";
import { createBuilder } from "vite";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";
import { pathToFileURL } from "node:url";
import { createIsolatedFixture } from "./helpers.js";

const CLI_PATH = path.resolve(import.meta.dirname, "../packages/vinext/dist/cli.js");
const FIXTURES_DIR = path.resolve(import.meta.dirname, "./fixtures");
const PROD_SERVER_MODULE_URL = pathToFileURL(
  path.resolve(import.meta.dirname, "../packages/vinext/dist/server/prod-server.js"),
).href;
const SHUTDOWN_MODULE_URL = pathToFileURL(
  path.resolve(import.meta.dirname, "../packages/vinext/dist/server/prod-server-shutdown.js"),
).href;

type StartedServer = {
  child: ChildProcess;
  port: number;
  output: () => string;
  exited: Promise<[number | null, NodeJS.Signals | null]>;
};

type ResponseResult = { status: number; body: string };

const fixtureDirs: string[] = [];
const children: ChildProcess[] = [];

async function buildFixture(name: string): Promise<string> {
  const fixtureDir = await createIsolatedFixture(path.join(FIXTURES_DIR, name), `vinext-${name}-`);
  fixtureDirs.push(fixtureDir);
  fs.writeFileSync(path.join(fixtureDir, "package.json"), '{"private":true,"type":"module"}');
  const builder = await createBuilder({
    root: fixtureDir,
    configFile: false,
    plugins: [vinext({ appDir: fixtureDir })],
    logLevel: "silent",
  });
  await builder.buildApp();
  return fixtureDir;
}

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
});

afterAll(() => {
  for (const fixtureDir of fixtureDirs.splice(0)) {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
});

async function startServer(
  fixtureDir: string,
  env: Record<string, string> = {},
): Promise<StartedServer> {
  const childEnv = { ...process.env, ...env };
  Reflect.deleteProperty(childEnv, "NODE_ENV");
  const child = spawn(
    process.execPath,
    [CLI_PATH, "start", "--port", "0", "--hostname", "127.0.0.1"],
    { cwd: fixtureDir, env: childEnv, stdio: ["ignore", "pipe", "pipe"] },
  );
  children.push(child);
  const exited = once(child, "exit") as Promise<[number | null, NodeJS.Signals | null]>;

  let output = "";
  child.stdout?.on("data", (chunk) => (output += chunk));
  child.stderr?.on("data", (chunk) => (output += chunk));

  const port = await new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`server did not start:\n${output}`)), 15_000);
    const onData = () => {
      const match = /Production server running at http:\/\/[^:]+:(\d+)/.exec(output);
      if (!match) return;
      clearTimeout(timeout);
      child.stdout?.off("data", onData);
      resolve(Number(match[1]));
    };
    child.stdout?.on("data", onData);
    void exited.then(() => {
      clearTimeout(timeout);
      reject(new Error(`server exited before it started:\n${output}`));
    });
  });

  return { child, port, output: () => output, exited };
}

// Each request uses its own connection (Connection: close) so an idle
// keep-alive socket from the test client can't delay the server's close.
function request(port: number, pathname: string): Promise<ResponseResult> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port, path: pathname, agent: false }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        res.on("error", reject);
      })
      .on("error", reject);
  });
}

async function waitForConnectionRefused(port: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const error = await request(port, "/api/fast").then(
      () => undefined,
      (err: NodeJS.ErrnoException) => err,
    );
    if (error?.code === "ECONNREFUSED") return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("server kept accepting connections after the signal");
}

async function waitForOutput(server: StartedServer, text: string, timeout = 5_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!server.output().includes(text)) {
    if (Date.now() > deadline) throw new Error(`missing "${text}" in:\n${server.output()}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("vinext start graceful shutdown (App Router)", () => {
  let fixtureDir = "";
  beforeAll(async () => {
    fixtureDir = await buildFixture("app-graceful-shutdown");
  }, 120_000);

  it("finishes pending requests but refuses new ones", async () => {
    const server = await startServer(fixtureDir);
    expect(await request(server.port, "/api/fast")).toEqual({
      status: 200,
      body: '{"hello":"world"}',
    });

    const pending = request(server.port, "/api/long-running");
    // Asserted below; until then a dropped request must not be unhandled.
    pending.catch(() => {});
    // Let the request reach the server before the signal.
    await new Promise((resolve) => setTimeout(resolve, 100));
    server.child.kill("SIGTERM");

    await waitForConnectionRefused(server.port);
    expect(await pending).toEqual({ status: 200, body: '{"hello":"world"}' });
    expect(await server.exited).toEqual([143, null]);
  }, 30_000);

  it("stops accepting new requests when shutting down", async () => {
    const server = await startServer(fixtureDir);
    server.child.kill("SIGTERM");

    await waitForConnectionRefused(server.port);
    expect(await server.exited).toEqual([143, null]);
  }, 30_000);

  it.each([
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const)(
    "waits for after callbacks when the server receives %s",
    async (signal, code) => {
      const server = await startServer(fixtureDir);
      expect((await request(server.port, "/")).status).toBe(200);
      await waitForOutput(server, "[after] starting sleep");

      server.child.kill(signal);

      expect(await server.exited).toEqual([code, null]);
      expect(server.output()).toContain("[after] finished sleep");
    },
    30_000,
  );

  it("handles a signal sent as soon as the server reports it is running", async () => {
    // Signals the process from inside the readiness log, before anything
    // else can run.
    const script = `
      const log = console.log;
      console.log = (...args) => {
        log(...args);
        if (String(args[0]).includes("Production server running")) {
          process.kill(process.pid, "SIGTERM");
        }
      };
      const { startProdServer } = await import(${JSON.stringify(PROD_SERVER_MODULE_URL)});
      await startProdServer({ port: 0, host: "127.0.0.1", outDir: "dist" });
    `;
    const env = { ...process.env };
    Reflect.deleteProperty(env, "NODE_ENV");
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      cwd: fixtureDir,
      env,
      stdio: "ignore",
    });
    children.push(child);

    expect(await once(child, "exit")).toEqual([143, null]);
  }, 30_000);

  // https://nextjs.org/docs/pages/guides/self-hosting#manual-graceful-shutdowns
  it("leaves the signals to the app when NEXT_MANUAL_SIG_HANDLE is set", async () => {
    const server = await startServer(fixtureDir, { NEXT_MANUAL_SIG_HANDLE: "true" });
    server.child.kill("SIGTERM");

    expect(await server.exited).toEqual([null, "SIGTERM"]);
  }, 30_000);
});

describe("vinext start graceful shutdown (Pages Router)", () => {
  let fixtureDir = "";
  beforeAll(async () => {
    fixtureDir = await buildFixture("pages-graceful-shutdown");
  }, 120_000);

  // Like Next.js, whose response cache hands background revalidation to the
  // server's waitUntil, which `nextServer.close()` awaits.
  it("waits for a background ISR regeneration", async () => {
    const server = await startServer(fixtureDir);
    expect(await request(server.port, "/isr")).toMatchObject({ status: 200 });
    await waitForOutput(server, "[gsp] end 1");

    // Once past `revalidate: 1`, the stale page is served and regenerated in
    // the background.
    const deadline = Date.now() + 10_000;
    while (!server.output().includes("[gsp] start 2")) {
      if (Date.now() > deadline) throw new Error(`no regeneration in:\n${server.output()}`);
      expect(await request(server.port, "/isr")).toMatchObject({ status: 200 });
      await waitForOutput(server, "[gsp] start 2", 250).catch(() => {});
    }
    expect(server.output()).not.toContain("[gsp] end 2");

    server.child.kill("SIGTERM");

    expect(await server.exited).toEqual([143, null]);
    expect(server.output()).toContain("[gsp] end 2");
  }, 30_000);

  // Next.js doesn't wait for API handlers when it closes, so a handler that
  // outlives its client must not hold the process open.
  it("does not wait for an API handler that outlives its client", async () => {
    const server = await startServer(fixtureDir);
    await new Promise<void>((resolve, reject) => {
      const req = http.get(
        { host: "127.0.0.1", port: server.port, path: "/api/events", agent: false },
        (res) => {
          res.on("error", () => {});
          res.once("data", () => {
            req.destroy();
            resolve();
          });
        },
      );
      req.on("error", reject);
    });
    // Let the server see the disconnect.
    await new Promise((resolve) => setTimeout(resolve, 200));

    server.child.kill("SIGTERM");

    const exit = await Promise.race([
      server.exited,
      new Promise((resolve) => setTimeout(() => resolve("still running"), 5_000)),
    ]);
    expect(exit).toEqual([143, null]);
  }, 30_000);
});

describe("production server shutdown lifecycle", () => {
  // Runs `body` in a fresh Node process with a listening server registered
  // for graceful shutdown, then sends the process SIGTERM.
  async function runShutdown(body: string): Promise<{ code: number | null; output: string }> {
    const script = `
      import http from "node:http";
      import { closeServerOnTerminationSignals, trackBackgroundWork } from ${JSON.stringify(SHUTDOWN_MODULE_URL)};
      const listen = async () => {
        const server = http.createServer();
        await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
        closeServerOnTerminationSignals(server);
        return server;
      };
      await listen();
      ${body}
      process.kill(process.pid, "SIGTERM");
    `;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    let output = "";
    child.stdout?.on("data", (chunk) => (output += chunk));
    child.stderr?.on("data", (chunk) => (output += chunk));
    const [code] = (await once(child, "exit")) as [number | null];
    return { code, output };
  }

  it("waits for work that holds no reference on the event loop", async () => {
    const result = await runShutdown(`
      trackBackgroundWork(new Promise((resolve) => {
        setTimeout(() => { console.log("work done"); resolve(); }, 200).unref();
      }));
    `);
    expect(result).toEqual({ code: 143, output: "work done\n" });
  }, 30_000);

  it("closes a server that finishes starting after the signal", async () => {
    const result = await runShutdown(`
      // Background work keeps the drain going until the late server is up.
      let release;
      trackBackgroundWork(new Promise((resolve) => (release = resolve)));
      process.once("SIGTERM", async () => {
        const late = await listen();
        late.on("close", () => console.log("late server closed"));
        release();
      });
    `);
    expect(result).toEqual({ code: 143, output: "late server closed\n" });
  }, 30_000);
});
