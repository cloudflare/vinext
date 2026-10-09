/**
 * Browser Web Worker graphs must honor the same `server-only` boundary as the
 * rest of the client bundle. Vite bundles each worker in its own plugin
 * container, so the main client environment's validator never sees the
 * worker's modules unless vinext registers it for worker builds too.
 *
 * These builds copy the checked-in Next.js worker fixture
 * (tests/e2e/nextjs-worker/fixture, ported from Next.js
 * test/e2e/app-dir/worker) and route one of its existing worker graphs
 * through a `server-only` module. Next.js fails the build for these graphs
 * with both webpack ("You're importing a module that depends on
 * "server-only"...") and Turbopack ("'server-only' cannot be imported from a
 * Client Component module"), including when the worker only uses a sibling
 * export of a barrel that re-exports the server-only module.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createBuilder } from "vite";
import { afterEach, describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";

const FIXTURE_DIR = path.resolve(import.meta.dirname, "e2e/nextjs-worker/fixture");
const CF_NODE_MODULES = path.resolve(import.meta.dirname, "fixtures/cf-app-basic/node_modules");
const CF_PLUGIN_PATH = path.join(CF_NODE_MODULES, "@cloudflare/vite-plugin/dist/index.mjs");
const SECRET_MARKER = "__VINEXT_WORKER_SERVER_ONLY_SECRET__";
const SERVER_ONLY_ERROR = /depends on "server-only".*reachable from a browser Web Worker bundle/;

type CloudflarePluginFactory = (opts?: {
  viteEnvironment?: { name: string; childEnvironments?: string[] };
}) => import("vite").Plugin;

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function copyFixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-worker-server-only-"));
  tmpDirs.push(root);
  fs.cpSync(FIXTURE_DIR, root, {
    recursive: true,
    filter: (source) => !/[\\/](?:node_modules|dist|\.wrangler)$/.test(source),
  });
  fs.symlinkSync(CF_NODE_MODULES, path.join(root, "node_modules"), "junction");

  // A utility barrel mixing a harmless helper with a server-only signing key.
  writeFile(root, "app/lib/greet.ts", 'export const greet = (name: string) => "hello " + name;\n');
  writeFile(
    root,
    "app/lib/session-key.ts",
    `import "server-only";

export const SESSION_KEY = new TextEncoder().encode(${JSON.stringify(SECRET_MARKER)});
`,
  );
  writeFile(
    root,
    "app/lib/index.ts",
    'export { greet } from "./greet";\nexport { SESSION_KEY } from "./session-key";\n',
  );
  return root;
}

function writeFile(root: string, filePath: string, content: string) {
  const absPath = path.join(root, filePath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, content);
}

function readClientJavaScript(dir: string): string {
  if (!fs.existsSync(dir)) return "";
  let output = "";
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) output += readClientJavaScript(entryPath);
    else if (entry.name.endsWith(".js")) output += fs.readFileSync(entryPath, "utf8");
  }
  return output;
}

async function buildFixture(root: string): Promise<void> {
  const { cloudflare } = (await import(pathToFileURL(CF_PLUGIN_PATH).href)) as {
    cloudflare: CloudflarePluginFactory;
  };
  const builder = await createBuilder({
    root,
    configFile: false,
    plugins: [
      vinext({ appDir: root }),
      cloudflare({ viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] } }),
    ],
    // Mirrors the fixture's vite.config.ts.
    resolve: {
      alias: {
        "@resvg/resvg-wasm": path.resolve(
          import.meta.dirname,
          "../node_modules/.pnpm/node_modules/@resvg/resvg-wasm",
        ),
      },
    },
    logLevel: "silent",
  });
  await builder.buildApp();
}

describe("server-only in browser Web Worker graphs", () => {
  it("fails the build when a worker imports a sibling export of a server-only barrel", async () => {
    const root = copyFixture();
    writeFile(
      root,
      "app/worker.ts",
      `import { greet } from "./lib";

void import("./worker-dep").then((mod) => {
  self.postMessage("worker.ts:" + mod.default + ":" + greet("worker"));
});
`,
    );

    await expect(buildFixture(root)).rejects.toThrow(SERVER_ONLY_ERROR);
  }, 120_000);

  it("fails the build when a SharedWorker dynamically imports a server-only module", async () => {
    const root = copyFixture();
    writeFile(
      root,
      "app/shared-worker-dep.ts",
      `import { SESSION_KEY } from "./lib/session-key";

export default "shared-worker-dep:" + SESSION_KEY.length;
`,
    );
    const sharedWorkerPath = path.join(root, "app/shared-worker.ts");
    fs.writeFileSync(
      sharedWorkerPath,
      fs
        .readFileSync(sharedWorkerPath, "utf8")
        .replace('import("./worker-dep")', 'import("./shared-worker-dep")'),
    );

    await expect(buildFixture(root)).rejects.toThrow(SERVER_ONLY_ERROR);
  }, 120_000);

  // Next.js turns this import into a Server Function reference. Vite's worker
  // container has no Server Function transform and would emit the module
  // body, so vinext fails closed instead.
  it("fails the build when a worker imports a server-only Server Functions module", async () => {
    const root = copyFixture();
    writeFile(
      root,
      "app/actions-server-only.ts",
      `"use server";

import "server-only";

const SESSION_KEY = ${JSON.stringify(SECRET_MARKER)};

export async function keyLength() {
  return SESSION_KEY.length;
}
`,
    );
    writeFile(
      root,
      "app/worker.ts",
      `import { keyLength } from "./actions-server-only";

void keyLength().then((length) => self.postMessage("worker.ts:" + length));
`,
    );

    await expect(buildFixture(root)).rejects.toThrow(SERVER_ONLY_ERROR);
  }, 120_000);

  const key = JSON.stringify(SECRET_MARKER);
  it.each([
    [
      "an ES module re-export",
      "key.mts",
      `export * from "server-only";\nexport const KEY = ${key};\n`,
    ],
    ["a dynamic import", "key.ts", `void import("server-only");\nexport const KEY = ${key};\n`],
    ["a CommonJS require", "key.cjs", `require("server-only");\nexports.KEY = ${key};\n`],
  ])(
    "fails the build when a worker reaches server-only through %s",
    async (_, file, source) => {
      const root = copyFixture();
      writeFile(root, `app/${file}`, source);
      writeFile(
        root,
        "app/worker.ts",
        `import { KEY } from "./${file}";

self.postMessage("worker.ts:" + KEY.length);
`,
      );

      await expect(buildFixture(root)).rejects.toThrow(SERVER_ONLY_ERROR);
    },
    120_000,
  );

  it("builds a worker that imports the harmless utility directly", async () => {
    const root = copyFixture();
    writeFile(
      root,
      "app/worker.ts",
      `import { greet } from "./lib/greet";

void import("./worker-dep").then((mod) => {
  self.postMessage("worker.ts:" + mod.default + ":" + greet("worker"));
});
`,
    );

    await buildFixture(root);
    const workerDir = path.join(root, "dist/client/_next/static/workers");
    const workerJavaScript = readClientJavaScript(workerDir);
    expect(workerJavaScript).toContain("hello ");
    expect(readClientJavaScript(path.join(root, "dist/client"))).not.toContain(SECRET_MARKER);
  }, 120_000);
});
