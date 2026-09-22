import fs from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer, type ViteDevServer } from "vite";
import { afterEach, describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";
import { getLockfilePath, readLockfile } from "../packages/vinext/src/server/dev-lockfile.js";

const originalArgv = process.argv;
const VITE_CLI_PATH = path.join(path.dirname(fileURLToPath(import.meta.resolve("vite"))), "cli.js");
const VINEXT_ENTRY_URL = pathToFileURL(
  path.resolve(import.meta.dirname, "../packages/vinext/dist/index.js"),
).href;
const roots: string[] = [];
let server: ViteDevServer | undefined;
let child: ChildProcess | undefined;

function createProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-vite-dev-lifecycle-"));
  roots.push(root);
  fs.symlinkSync(
    path.resolve(import.meta.dirname, "../node_modules"),
    path.join(root, "node_modules"),
    "junction",
  );
  fs.mkdirSync(path.join(root, "pages"));
  fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}\n');
  fs.writeFileSync(
    path.join(root, "pages/index.tsx"),
    "export default function Page() { return <main>home</main>; }\n",
  );
  return root;
}

function useViteCliArgv(): void {
  process.argv = [process.execPath, "/project/node_modules/vite/bin/vite.js", "dev"];
}

async function waitFor<T>(read: () => T | undefined, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for Vite dev state");
}

afterEach(async () => {
  if (child?.exitCode === null && child.signalCode === null) {
    const exited = new Promise<void>((resolve) => child!.once("exit", () => resolve()));
    child.kill("SIGTERM");
    await exited;
  }
  child = undefined;
  await server?.close();
  server = undefined;
  process.argv = originalArgv;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("Vite dev lifecycle", () => {
  it("loads dotenv before evaluating Vite config", async () => {
    const root = createProject();
    fs.writeFileSync(path.join(root, ".env"), "FROM_DOTENV=config-time-dotenv\n");
    fs.writeFileSync(
      path.join(root, "vite.config.ts"),
      `import vinext from ${JSON.stringify(VINEXT_ENTRY_URL)};
if (process.env.FROM_DOTENV !== "config-time-dotenv") {
  throw new Error("dotenv unavailable in Vite config: " + process.env.FROM_DOTENV);
}
export default { plugins: [vinext()] };
`,
    );
    child = spawn(process.execPath, [VITE_CLI_PATH, "dev", "--port", "0"], {
      cwd: root,
      stdio: "pipe",
    });

    const lock = await waitFor(() => readLockfile(getLockfilePath(root)));
    expect(lock.port).toBeGreaterThan(0);
  });

  it("applies vinext defaults without locking a server that never listens", async () => {
    const root = createProject();
    useViteCliArgv();
    server = await createServer({
      root,
      configFile: false,
      logLevel: "silent",
      plugins: [vinext()],
    });

    expect(server.config.server).toMatchObject({ host: "localhost", port: 3000 });
    expect(fs.existsSync(getLockfilePath(root))).toBe(false);

    await server.close();
    server = undefined;
    expect(fs.existsSync(getLockfilePath(root))).toBe(false);
  });

  it("does not recreate the lock when a resolved-port update runs after close", async () => {
    const root = createProject();
    useViteCliArgv();
    server = await createServer({
      root,
      configFile: false,
      logLevel: "silent",
      plugins: [vinext()],
      server: { port: 0 },
    });
    await server.listen();

    await server.close();
    server = undefined;
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(fs.existsSync(getLockfilePath(root))).toBe(false);
  });

  it("keeps the lock across a Vite server restart", async () => {
    const root = createProject();
    useViteCliArgv();
    server = await createServer({
      root,
      configFile: false,
      logLevel: "silent",
      plugins: [vinext()],
    });
    await server.listen();
    const startedAt = readLockfile(getLockfilePath(root))?.startedAt;

    await server.restart();

    expect(readLockfile(getLockfilePath(root))).toMatchObject({
      pid: process.pid,
      startedAt,
    });
    await server.close();
    server = undefined;
    expect(fs.existsSync(getLockfilePath(root))).toBe(false);
  });

  it("releases the lock after a replacement server fails to configure", async () => {
    const root = createProject();
    useViteCliArgv();
    let configureCount = 0;
    server = await createServer({
      root,
      configFile: false,
      logLevel: "silent",
      plugins: [
        vinext(),
        {
          name: "fail-replacement-server",
          configureServer() {
            if (++configureCount === 2) throw new Error("replacement configuration failed");
          },
        },
      ],
    });
    await server.listen();

    await server.restart();
    expect(readLockfile(getLockfilePath(root))).toMatchObject({ pid: process.pid });

    await server.close();
    server = undefined;
    expect(fs.existsSync(getLockfilePath(root))).toBe(false);
  });

  it("does not leak the lock when a replacement post-configure callback fails", async () => {
    const root = createProject();
    useViteCliArgv();
    let configureCount = 0;
    server = await createServer({
      root,
      configFile: false,
      logLevel: "silent",
      plugins: [
        vinext(),
        {
          name: "fail-replacement-server-post-configure",
          enforce: "post",
          configureServer: {
            order: "post",
            handler() {
              const currentServer = ++configureCount;
              return () => {
                if (currentServer === 2) throw new Error("replacement post-configuration failed");
              };
            },
          },
        },
      ],
    });
    await server.listen();

    await server.restart();
    expect(readLockfile(getLockfilePath(root))).toMatchObject({ pid: process.pid });

    await server.close();
    server = undefined;
    expect(fs.existsSync(getLockfilePath(root))).toBe(false);
  });

  it("keeps middleware servers lock-free", async () => {
    const root = createProject();
    useViteCliArgv();
    server = await createServer({
      root,
      configFile: false,
      logLevel: "silent",
      plugins: [vinext()],
      server: { middlewareMode: true },
    });

    expect(fs.existsSync(getLockfilePath(root))).toBe(false);
  });

  it("keeps object-form middleware servers lock-free", async () => {
    const root = createProject();
    useViteCliArgv();
    server = await createServer({
      root,
      configFile: false,
      logLevel: "silent",
      plugins: [vinext()],
      server: { middlewareMode: { server: createHttpServer() } },
    });

    expect(server.config.server.port).toBe(5173);
    expect(fs.existsSync(getLockfilePath(root))).toBe(false);
  });

  it("keeps middleware servers configured by later plugins lock-free", async () => {
    const root = createProject();
    useViteCliArgv();
    server = await createServer({
      root,
      configFile: false,
      logLevel: "silent",
      plugins: [
        vinext(),
        {
          name: "middleware-mode",
          enforce: "post",
          config: {
            order: "post",
            handler: () => ({ server: { middlewareMode: true } }),
          },
        },
      ],
    });

    expect(server.config.server.port).toBe(5173);
    expect(fs.existsSync(getLockfilePath(root))).toBe(false);
  });

  it("keeps programmatic servers lock-free", async () => {
    const root = createProject();
    process.argv = [process.execPath, "/project/tests/dev.test.ts"];
    server = await createServer({
      root,
      configFile: false,
      logLevel: "silent",
      plugins: [vinext()],
    });

    expect(server.config.server.port).toBe(5173);
    expect(fs.existsSync(getLockfilePath(root))).toBe(false);
  });

  it("keeps nested programmatic servers outside the CLI lifecycle", async () => {
    const root = createProject();
    useViteCliArgv();
    server = await createServer({
      root,
      configFile: false,
      logLevel: "silent",
      plugins: [vinext()],
    });
    await server.listen();
    const outerLock = readLockfile(getLockfilePath(root));

    const nested = await createServer({
      root,
      configFile: false,
      logLevel: "silent",
      plugins: [vinext()],
    });
    try {
      expect(nested.config.server.port).toBe(5173);
      expect(readLockfile(getLockfilePath(root))).toEqual(outerLock);
    } finally {
      await nested.close();
    }

    await server.close();
    server = undefined;
    expect(fs.existsSync(getLockfilePath(root))).toBe(false);
  });
});
