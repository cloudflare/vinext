import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { build, createServer, type ViteDevServer } from "vite";
import vinext from "../packages/vinext/src/index.js";

const execFileAsync = promisify(execFile);

// Ported from Next.js:
// test/e2e/edge-compiler-can-import-blob-assets/index.test.ts
// https://github.com/vercel/next.js/blob/canary/test/e2e/edge-compiler-can-import-blob-assets/index.test.ts
describe("Pages edge API blob assets in production", () => {
  let tmpRoot: string;
  let outDir: string;
  let server: import("node:http").Server;
  let baseUrl: string;
  const image = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]);

  beforeAll(async () => {
    tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "vinext-edge-blob-assets-"));
    outDir = path.join(tmpRoot, "dist");
    await fsp.symlink(
      path.resolve(import.meta.dirname, "../node_modules"),
      path.join(tmpRoot, "node_modules"),
      "junction",
    );
    await fsp.mkdir(path.join(tmpRoot, "pages", "api"), { recursive: true });
    await fsp.mkdir(path.join(tmpRoot, "src"), { recursive: true });
    await fsp.writeFile(path.join(tmpRoot, "package.json"), JSON.stringify({ type: "module" }));
    await fsp.writeFile(path.join(tmpRoot, "src", "text-file.txt"), "Hello, from text-file.txt!");
    await fsp.writeFile(path.join(tmpRoot, "src", "vercel.png"), image);
    await fsp.writeFile(
      path.join(tmpRoot, "pages", "api", "edge.js"),
      `export const config = { runtime: "edge" };

export default async function handler(request) {
  const name = new URL(request.url).searchParams.get("handler");
  if (name === "text-file") {
    const url = new URL("../../src/text-file.txt", import.meta.url);
    return fetch(url);
  }
  if (name === "image-file") {
    const url = new URL("../../src/vercel.png", import.meta.url);
    return fetch(url);
  }
  return new Response("Invalid handler", { status: 400 });
}
`,
    );

    await build({
      root: tmpRoot,
      configFile: false,
      plugins: [vinext({ disableAppRouter: true })],
      logLevel: "silent",
      build: {
        outDir: path.join(outDir, "server"),
        ssr: "virtual:vinext-server-entry",
        rolldownOptions: { output: { entryFileNames: "entry.js" } },
      },
    });

    const { startProdServer } = await import("../packages/vinext/src/server/prod-server.js");
    const started = await startProdServer({ port: 0, host: "127.0.0.1", outDir });
    server = "server" in started ? started.server : started;
    const address = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${address.port}`;
  }, 120_000);

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("fetches a relative text asset", async () => {
    const response = await fetch(`${baseUrl}/api/edge?handler=text-file`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("Hello, from text-file.txt!");
  });

  it("fetches a relative image asset byte-for-byte", async () => {
    const response = await fetch(`${baseUrl}/api/edge?handler=image-file`);
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer()).equals(image)).toBe(true);
  });
});

describe("Pages edge API blob assets in development", () => {
  let tmpRoot: string;
  let assetPath: string;
  let server: ViteDevServer;
  let baseUrl: string;

  beforeAll(async () => {
    tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "vinext-edge-blob-assets-dev-"));
    await fsp.symlink(
      path.resolve(import.meta.dirname, "../node_modules"),
      path.join(tmpRoot, "node_modules"),
      "junction",
    );
    await fsp.mkdir(path.join(tmpRoot, "pages", "api"), { recursive: true });
    await fsp.mkdir(path.join(tmpRoot, "src"), { recursive: true });
    await fsp.writeFile(path.join(tmpRoot, "package.json"), JSON.stringify({ type: "module" }));
    assetPath = path.join(tmpRoot, "src", "message.txt");
    await fsp.writeFile(assetPath, "before asset edit");
    await fsp.writeFile(
      path.join(tmpRoot, "pages", "api", "edge.js"),
      `export const config = { runtime: "edge" };

export default function handler() {
  return fetch(new URL("../../src/message.txt", import.meta.url));
}
`,
    );

    server = await createServer({
      root: tmpRoot,
      configFile: false,
      plugins: [vinext({ disableAppRouter: true })],
      logLevel: "silent",
      server: { host: "127.0.0.1", port: 0 },
    });
    await server.listen();
    const address = server.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("Expected Vite TCP address");
    baseUrl = `http://127.0.0.1:${address.port}`;
  }, 120_000);

  afterAll(async () => {
    if (server) await server.close();
    if (tmpRoot) await fsp.rm(tmpRoot, { recursive: true, force: true });
  });

  it("invalidates the route when only the embedded asset changes", async () => {
    const initial = await fetch(`${baseUrl}/api/edge`);
    expect(initial.status).toBe(200);
    expect(await initial.text()).toBe("before asset edit");

    await fsp.writeFile(assetPath, "after asset edit");
    server.watcher.emit("change", assetPath);

    await vi.waitFor(
      async () => {
        const updated = await fetch(`${baseUrl}/api/edge`);
        expect(updated.status).toBe(200);
        expect(await updated.text()).toBe("after asset edit");
      },
      { timeout: 10_000, interval: 100 },
    );
  });
});

async function getAvailablePort(): Promise<number> {
  const server = createHttpServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected an available port");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

async function waitForServer(child: ChildProcess, url: string): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (child.exitCode !== null) {
      throw new Error(`Nitro server exited before becoming ready with code ${child.exitCode}`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for Nitro server at ${url}`);
}

async function stopServer(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  await exited;
}

async function readBuiltModules(dir: string): Promise<string> {
  let output = "";
  for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) output += await readBuiltModules(file);
    else if (entry.name.endsWith(".mjs")) output += await fsp.readFile(file, "utf8");
  }
  return output;
}

describe("App Router blob assets through Nitro presets", () => {
  let tmpRoot: string;

  beforeAll(async () => {
    tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "vinext-nitro-blob-assets-"));
    await fsp.symlink(
      path.resolve(import.meta.dirname, "../node_modules"),
      path.join(tmpRoot, "node_modules"),
      "junction",
    );
    await fsp.mkdir(path.join(tmpRoot, "app", "asset"), { recursive: true });
    await fsp.writeFile(path.join(tmpRoot, "package.json"), JSON.stringify({ type: "module" }));
    await fsp.writeFile(
      path.join(tmpRoot, "app", "layout.jsx"),
      `export default function Layout({ children }) { return <html><body>{children}</body></html>; }`,
    );
    await fsp.writeFile(
      path.join(tmpRoot, "app", "asset", "message.txt"),
      "Hello from a Nitro asset!",
    );
    await fsp.writeFile(
      path.join(tmpRoot, "app", "asset", "route.js"),
      `import { fileURLToPath } from "node:url";

const assetUrl = new URL("./message.txt", import.meta.url);

export async function GET(request) {
  const text = await (await fetch(assetUrl)).text();
  const mode = new URL(request.url).searchParams.get("mode");
  return Response.json({
    text,
    protocol: assetUrl.protocol,
    pathname: assetUrl.pathname,
    filePath: mode === "node" ? fileURLToPath(assetUrl) : null,
  });
}
`,
    );
    await fsp.writeFile(
      path.join(tmpRoot, "vite.config.ts"),
      `import { defineConfig } from "vite";
import { nitro } from ${JSON.stringify(pathToFileURL(path.resolve(import.meta.dirname, "../examples/app-router-nitro/node_modules/nitro/dist/vite.mjs")).href)};
import vinext from ${JSON.stringify(pathToFileURL(path.resolve(import.meta.dirname, "../packages/vinext/src/index.ts")).href)};

const preset = process.env.TEST_NITRO_PRESET;
export default defineConfig({ plugins: [vinext(), nitro(preset ? { preset } : {})] });
`,
    );
  });

  afterAll(async () => {
    if (tmpRoot) await fsp.rm(tmpRoot, { recursive: true, force: true });
  });

  async function buildNitro(preset?: string) {
    await fsp.rm(path.join(tmpRoot, ".output"), { recursive: true, force: true });
    const vp = path.resolve(
      import.meta.dirname,
      `../examples/app-router-nitro/node_modules/.bin/vp${process.platform === "win32" ? ".CMD" : ""}`,
    );
    await execFileAsync(vp, ["build"], {
      cwd: tmpRoot,
      env: { ...process.env, TEST_NITRO_PRESET: preset },
    });
  }

  it("preserves file URL consumers in the default Node preset", async () => {
    await buildNitro();

    const port = await getAvailablePort();
    const child = spawn(process.execPath, [path.join(tmpRoot, ".output", "server", "index.mjs")], {
      cwd: tmpRoot,
      env: { ...process.env, HOST: "127.0.0.1", PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr?.pipe(process.stderr);
    const url = `http://127.0.0.1:${port}/asset?mode=node`;

    try {
      await waitForServer(child, url);
      const response = await fetch(url);
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        text: string;
        protocol: string;
        pathname: string;
        filePath: string;
      };
      expect(body.text).toBe("Hello from a Nitro asset!");
      expect(body.protocol).toBe("file:");
      expect(body.pathname).toContain("/server/");
      expect(body.filePath.replaceAll("\\", "/")).toContain("/server/");
    } finally {
      await stopServer(child);
    }
  }, 120_000);

  it("rewrites the constructor for a nodeless Cloudflare preset", async () => {
    await buildNitro("cloudflare-module");

    const serverEntry = path.join(tmpRoot, ".output", "server", "index.mjs");
    const built = await readBuiltModules(path.dirname(serverEntry));
    expect(built).toContain("data:text/plain; charset=utf-8;base64,");
    expect(built).not.toContain('new URL("./message.txt", import.meta.url)');

    const workerModule = await import(`${pathToFileURL(serverEntry).href}?test=${Date.now()}`);
    const worker = workerModule.default as {
      fetch(request: Request, env: unknown, context: unknown): Promise<Response>;
    };
    const response = await worker.fetch(
      new Request("https://example.test/asset?mode=worker"),
      {},
      { waitUntil() {} },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      text: "Hello from a Nitro asset!",
      protocol: "data:",
      filePath: null,
    });
  }, 120_000);
});
