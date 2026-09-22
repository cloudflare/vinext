import fs from "node:fs";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
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
  it("claims the configured plugin when an unused instance was constructed first", async () => {
    const root = createProject();
    fs.writeFileSync(
      path.join(root, "vite.config.ts"),
      `import vinext from ${JSON.stringify(VINEXT_ENTRY_URL)};
const unused = vinext();
export default { plugins: [vinext()] };
`,
    );
    child = spawn(process.execPath, [VITE_CLI_PATH, "dev", "--port", "0"], {
      cwd: root,
      stdio: "pipe",
    });

    const lock = await waitFor(() => {
      const current = readLockfile(getLockfilePath(root));
      return current && current.port > 0 ? current : undefined;
    });
    expect(lock.port).toBeGreaterThan(0);
  }, 30_000);

  it("does not let a nested config-loading server claim an unused instance's reservation", async () => {
    const root = createProject();
    const nestedRoot = createProject();
    fs.writeFileSync(
      path.join(root, "vite.config.ts"),
      `import vinext from ${JSON.stringify(VINEXT_ENTRY_URL)};
import { createServer } from "vite";
const unused = vinext();
export default { plugins: [
  { name: "nested-before-vinext", enforce: "pre", async config() {
    const nested = await createServer({ root: ${JSON.stringify(nestedRoot)}, plugins: [vinext()], logLevel: "silent" });
    try {
      if (nested.config.server.port !== 5173) throw new Error("Nested server claimed the CLI lifecycle");
    } finally { await nested.close(); }
  } },
  vinext(),
] };
`,
    );
    child = spawn(process.execPath, [VITE_CLI_PATH, "dev", "--port", "0"], {
      cwd: root,
      stdio: "pipe",
    });

    const lock = await waitFor(() => {
      const current = readLockfile(getLockfilePath(root));
      return current && current.port > 0 ? current : undefined;
    });
    expect(lock.port).toBeGreaterThan(0);
    expect(fs.existsSync(getLockfilePath(nestedRoot))).toBe(false);
  }, 30_000);

  it("loads dotenv before evaluating Vite config", async () => {
    const root = createProject();
    fs.writeFileSync(path.join(root, ".env.staging"), "FROM_DOTENV=config-time-dotenv\n");
    fs.writeFileSync(
      path.join(root, "vite.config.ts"),
      `import vinext from ${JSON.stringify(VINEXT_ENTRY_URL)};
if (process.env.FROM_DOTENV !== "config-time-dotenv") {
  throw new Error("dotenv unavailable in Vite config: " + process.env.FROM_DOTENV);
}
export default { plugins: [vinext()] };
`,
    );
    child = spawn(
      process.execPath,
      [VITE_CLI_PATH, "dev", root, "--mode", "staging", "--port", "0"],
      {
        cwd: root,
        stdio: "pipe",
      },
    );

    const lock = await waitFor(() => {
      const current = readLockfile(getLockfilePath(root));
      return current && current.port > 0 ? current : undefined;
    });
    expect(lock.port).toBeGreaterThan(0);
  }, 30_000);

  it("preserves an explicit NODE_ENV while evaluating Vite config", async () => {
    const root = createProject();
    fs.writeFileSync(
      path.join(root, "vite.config.ts"),
      `import vinext from ${JSON.stringify(VINEXT_ENTRY_URL)};
if (process.env.NODE_ENV !== "staging") {
  throw new Error("vite.config saw NODE_ENV=" + process.env.NODE_ENV);
}
export default { plugins: [vinext()] };
`,
    );
    const env = { ...process.env };
    Reflect.set(env, "NODE_ENV", "staging");
    child = spawn(process.execPath, [VITE_CLI_PATH, "dev", "--port", "0"], {
      cwd: root,
      env,
      stdio: "pipe",
    });

    const lock = await waitFor(() => {
      const current = readLockfile(getLockfilePath(root));
      return current && current.port > 0 ? current : undefined;
    });
    expect(lock.port).toBeGreaterThan(0);
  }, 30_000);

  it("reports duplicate dev servers through Vite's normal error path", async () => {
    const root = createProject();
    fs.writeFileSync(
      path.join(root, "vite.config.ts"),
      `import vinext from ${JSON.stringify(VINEXT_ENTRY_URL)};\nexport default { plugins: [vinext()] };\n`,
    );
    child = spawn(process.execPath, [VITE_CLI_PATH, "dev", "--port", "0"], {
      cwd: root,
      stdio: "pipe",
    });
    await waitFor(() => readLockfile(getLockfilePath(root)));

    const duplicate = spawnSync(process.execPath, [VITE_CLI_PATH, "dev", "--port", "0"], {
      cwd: root,
      encoding: "utf8",
      timeout: 10_000,
    });

    expect(duplicate.status).toBe(1);
    expect(duplicate.stderr).toContain("Another vinext dev server is already running");
    expect(duplicate.stderr).not.toContain("node:events");
  }, 30_000);

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

  it("updates and releases the lock when a failed listen is retried", async () => {
    const root = createProject();
    useViteCliArgv();
    const occupied = createHttpServer();
    const occupiedPort = await new Promise<number>((resolve) => {
      occupied.listen(0, "localhost", () => {
        const address = occupied.address();
        if (!address || typeof address === "string") throw new Error("Expected a TCP port");
        resolve(address.port);
      });
    });
    try {
      server = await createServer({
        root,
        configFile: false,
        logLevel: "silent",
        plugins: [vinext()],
        server: { port: occupiedPort, strictPort: true },
      });
      await expect(server.listen()).rejects.toThrow(`Port ${occupiedPort} is already in use`);
      expect(fs.existsSync(getLockfilePath(root))).toBe(false);

      await server.listen(0);
      const address = server.httpServer?.address();
      if (!address || typeof address === "string") throw new Error("Expected a TCP port");
      const actualPort = address.port;
      expect(
        await waitFor(() => readLockfile(getLockfilePath(root))?.port === actualPort || undefined),
      ).toBe(true);

      const nested = await createServer({
        root,
        configFile: false,
        logLevel: "silent",
        plugins: [vinext()],
      });
      try {
        expect(nested.config.server.port).toBe(5173);
        expect(readLockfile(getLockfilePath(root))?.port).toBe(actualPort);
      } finally {
        await nested.close();
      }

      await server.close();
      server = undefined;
      expect(fs.existsSync(getLockfilePath(root))).toBe(false);
    } finally {
      await new Promise<void>((resolve) => occupied.close(() => resolve()));
    }
  });

  it("honors the dev lock opt-out", async () => {
    const root = createProject();
    const previous = process.env.VINEXT_NO_DEV_LOCK;
    process.env.VINEXT_NO_DEV_LOCK = "1";
    useViteCliArgv();
    try {
      server = await createServer({
        root,
        configFile: false,
        logLevel: "silent",
        plugins: [vinext()],
        server: { port: 0 },
      });
      await server.listen();
      expect(fs.existsSync(getLockfilePath(root))).toBe(false);

      await server.restart();
      const nested = await createServer({
        root,
        configFile: false,
        logLevel: "silent",
        plugins: [vinext()],
      });
      expect(nested.config.server.port).toBe(5173);
      await nested.close();
    } finally {
      if (previous === undefined) delete process.env.VINEXT_NO_DEV_LOCK;
      else process.env.VINEXT_NO_DEV_LOCK = previous;
    }
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

  it.each(["forced", "concurrent"] as const)(
    "does not carry CLI restart provenance into a reused config after a %s restart",
    async (kind) => {
      const root = createProject();
      const nestedRoot = createProject();
      useViteCliArgv();
      server = await createServer({
        root,
        configFile: false,
        logLevel: "silent",
        plugins: [vinext()],
        server: { port: 0 },
      });
      await server.listen();

      if (kind === "forced") await server.restart(true);
      else await Promise.all([server.restart(), server.restart()]);

      const nested = await createServer({
        ...server.config.inlineConfig,
        root: nestedRoot,
        server: {},
      });
      try {
        expect(nested.config.server.port).toBe(5173);
        expect(fs.existsSync(getLockfilePath(nestedRoot))).toBe(false);
      } finally {
        await nested.close();
      }
      await server.close();
      server = undefined;
      expect(fs.existsSync(getLockfilePath(root))).toBe(false);
    },
  );

  it("moves the lifecycle when a restart changes the configured root", async () => {
    const firstRoot = createProject();
    const secondRoot = createProject();
    useViteCliArgv();
    let configCalls = 0;
    server = await createServer({
      root: firstRoot,
      configFile: false,
      logLevel: "silent",
      plugins: [
        {
          name: "change-root-on-restart",
          enforce: "pre",
          config: () => ({ root: configCalls++ === 0 ? firstRoot : secondRoot }),
        },
        vinext(),
      ],
      server: { port: 0 },
    });
    await server.listen();
    expect(readLockfile(getLockfilePath(firstRoot))).toMatchObject({ pid: process.pid });

    await server.restart();

    expect(fs.realpathSync.native(server.config.root)).toBe(fs.realpathSync.native(secondRoot));
    expect(fs.existsSync(getLockfilePath(firstRoot))).toBe(false);
    expect(readLockfile(getLockfilePath(secondRoot))).toMatchObject({ pid: process.pid });
    await server.close();
    server = undefined;
    expect(fs.existsSync(getLockfilePath(secondRoot))).toBe(false);
  });

  it("keeps nested programmatic servers outside a CLI restart", async () => {
    const root = createProject();
    const nestedRoot = createProject();
    useViteCliArgv();
    let configCalls = 0;
    let nested: ViteDevServer | undefined;
    server = await createServer({
      root,
      configFile: false,
      logLevel: "silent",
      plugins: [
        vinext(),
        {
          name: "create-nested-server-on-restart",
          async config() {
            if (++configCalls !== 2) return;
            nested = await createServer({
              root: nestedRoot,
              configFile: false,
              logLevel: "silent",
              plugins: [vinext()],
            });
          },
        },
      ],
      server: { port: 0 },
    });
    await server.listen();

    try {
      await server.restart();

      expect(nested?.config.server.port).toBe(5173);
      expect(fs.existsSync(getLockfilePath(nestedRoot))).toBe(false);
    } finally {
      await nested?.close();
    }
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
            handler: () => ({ server: { middlewareMode: true, port: 3000 } }),
          },
        },
      ],
    });

    expect(server.config.server.port).toBe(3000);
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

  it("keeps nested servers created by earlier config hooks outside the CLI lifecycle", async () => {
    const root = createProject();
    useViteCliArgv();
    let nested: ViteDevServer | undefined;
    try {
      server = await createServer({
        root,
        configFile: false,
        logLevel: "silent",
        plugins: [
          {
            name: "create-nested-before-vinext-config",
            enforce: "pre",
            config: {
              order: "pre",
              async handler() {
                nested = await createServer({
                  root,
                  configFile: false,
                  logLevel: "silent",
                  plugins: [vinext()],
                });
              },
            },
          },
          vinext(),
        ],
      });
      expect(nested?.config.server.port).toBe(5173);
      expect(server.config.server.port).toBe(3000);
      await server.listen(0);
      expect(readLockfile(getLockfilePath(root))).toBeTruthy();
    } finally {
      await nested?.close();
    }
  });
});
