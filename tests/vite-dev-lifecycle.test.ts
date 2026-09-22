import fs from "node:fs";
import { createServer as createHttpServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { createServer, type ViteDevServer } from "vite";
import { afterEach, describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";
import { getLockfilePath, readLockfile } from "../packages/vinext/src/server/dev-lockfile.js";

const originalArgv = process.argv;
const roots: string[] = [];
let server: ViteDevServer | undefined;

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

afterEach(async () => {
  await server?.close();
  server = undefined;
  process.argv = originalArgv;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("Vite dev lifecycle", () => {
  it("applies vinext defaults and releases the lock when closed before listen", async () => {
    const root = createProject();
    useViteCliArgv();
    server = await createServer({
      root,
      configFile: false,
      logLevel: "silent",
      plugins: [vinext()],
    });

    expect(server.config.server).toMatchObject({ host: "localhost", port: 3000 });
    expect(readLockfile(getLockfilePath(root))).toMatchObject({
      pid: process.pid,
      hostname: "localhost",
      port: 3000,
    });

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
          configureServer() {
            const currentServer = ++configureCount;
            return () => {
              if (currentServer === 2) throw new Error("replacement post-configuration failed");
            };
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
          config: () => ({ server: { middlewareMode: true } }),
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
});
