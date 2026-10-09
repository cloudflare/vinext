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

function readClientJavaScript(dir: string, skipDir?: string): string {
  if (!fs.existsSync(dir)) return "";
  let output = "";
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entryPath !== skipDir) output += readClientJavaScript(entryPath, skipDir);
    } else if (entry.name.endsWith(".js")) output += fs.readFileSync(entryPath, "utf8");
  }
  return output;
}

/** `extraPlugins` are registered for both the app and its worker builds. */
async function buildFixture(
  root: string,
  extraPlugins: import("vite").Plugin[] = [],
): Promise<void> {
  const { cloudflare } = (await import(pathToFileURL(CF_PLUGIN_PATH).href)) as {
    cloudflare: CloudflarePluginFactory;
  };
  const builder = await createBuilder({
    root,
    configFile: false,
    plugins: [
      vinext({ appDir: root }),
      cloudflare({ viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] } }),
      ...extraPlugins,
    ],
    worker: { plugins: () => extraPlugins },
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

// Next.js compiles workers as part of the browser graph, so a worker that
// imports a "use server" module receives `createServerReference(...)` proxies
// (webpack and Turbopack both build, and neither ships the module body).
describe("Server Functions in browser Web Worker graphs", () => {
  const ACTION_BODY_MARKER = "__VINEXT_WORKER_ACTION_BODY__";

  function writeWorkerActionFixture(root: string, actionSource: string) {
    writeFile(root, "app/worker-actions.ts", actionSource);
    writeFile(
      root,
      "app/worker.ts",
      `import { keyLength } from "./worker-actions";

self.postMessage("worker.ts:" + typeof keyLength);
`,
    );
    // The client page imports the same module so the main client graph's
    // reference key can be compared with the worker's.
    const pagePath = path.join(root, "app/module/page.js");
    fs.writeFileSync(
      pagePath,
      fs
        .readFileSync(pagePath, "utf8")
        .replace(
          'import { useState } from "react";',
          'import { useState } from "react";\nimport { keyLength } from "../worker-actions";\nglobalThis.__workerActionsKeyLength = keyLength;',
        ),
    );
  }

  function serverReferenceIds(javaScript: string): string[] {
    return [...javaScript.matchAll(/[`"']([^`"'\s]+#keyLength)[`"']/g)].map((match) => match[1]!);
  }

  async function buildAndReadWorkers(root: string, extraPlugins?: import("vite").Plugin[]) {
    await buildFixture(root, extraPlugins);
    const clientDir = path.join(root, "dist/client");
    const workerDir = path.join(clientDir, "_next/static/workers");
    return {
      clientJavaScript: readClientJavaScript(clientDir),
      pageJavaScript: readClientJavaScript(clientDir, workerDir),
      workerJavaScript: readClientJavaScript(workerDir),
    };
  }

  it("emits server references with the client graph's ids instead of the module body", async () => {
    const root = copyFixture();
    writeWorkerActionFixture(
      root,
      `"use server";

const BODY = ${JSON.stringify(ACTION_BODY_MARKER)};

export async function keyLength() {
  return BODY.length;
}
`,
    );

    const { clientJavaScript, pageJavaScript, workerJavaScript } = await buildAndReadWorkers(root);
    expect(clientJavaScript).not.toContain(ACTION_BODY_MARKER);
    const workerIds = serverReferenceIds(workerJavaScript);
    expect(workerIds).toHaveLength(1);
    expect(serverReferenceIds(pageJavaScript)).toEqual(workerIds);
  }, 120_000);

  it("builds a worker that imports a server-only Server Functions module", async () => {
    const root = copyFixture();
    writeWorkerActionFixture(
      root,
      `"use server";

import "server-only";
import { SESSION_KEY } from "./lib/session-key";

export async function keyLength() {
  return SESSION_KEY.length;
}
`,
    );

    const { clientJavaScript, workerJavaScript } = await buildAndReadWorkers(root);
    expect(serverReferenceIds(workerJavaScript)).toHaveLength(1);
    expect(clientJavaScript).not.toContain(SECRET_MARKER);
  }, 120_000);

  it("expands export-all re-exports into server references", async () => {
    const root = copyFixture();
    writeFile(
      root,
      "app/worker-action-impl.ts",
      `const BODY = ${JSON.stringify(ACTION_BODY_MARKER)};

export async function keyLength() {
  return BODY.length;
}
`,
    );
    writeWorkerActionFixture(root, `"use server";\n\nexport * from "./worker-action-impl";\n`);

    const { clientJavaScript, workerJavaScript } = await buildAndReadWorkers(root);
    expect(serverReferenceIds(workerJavaScript)).toHaveLength(1);
    expect(clientJavaScript).not.toContain(ACTION_BODY_MARKER);
  }, 120_000);

  it.each(["?worker-query", "#worker-hash"])(
    "emits server references for Server Functions imports with a %s postfix",
    async (postfix) => {
      const root = copyFixture();
      writeWorkerActionFixture(
        root,
        `"use server";

const BODY = ${JSON.stringify(ACTION_BODY_MARKER)};

export async function keyLength() {
  return BODY.length;
}
`,
      );
      writeFile(
        root,
        "app/worker.ts",
        `import { keyLength } from "./worker-actions.ts${postfix}";

self.postMessage("worker.ts:" + typeof keyLength);
`,
      );

      const { clientJavaScript, workerJavaScript } = await buildAndReadWorkers(root);
      expect(serverReferenceIds(workerJavaScript)).toHaveLength(1);
      expect(clientJavaScript).not.toContain(ACTION_BODY_MARKER);
    },
    120_000,
  );

  it("emits server references for virtual Server Functions modules", async () => {
    const root = copyFixture();
    writeFile(
      root,
      "app/worker.ts",
      `import { keyLength } from "virtual:worker-actions";

self.postMessage("worker.ts:" + typeof keyLength);
`,
    );
    const virtualActions: import("vite").Plugin = {
      name: "test:virtual-worker-actions",
      resolveId: (source) =>
        source === "virtual:worker-actions" ? "\0virtual:worker-actions" : null,
      load: (id) =>
        id === "\0virtual:worker-actions"
          ? `"use server";\nconst BODY = ${JSON.stringify(ACTION_BODY_MARKER)};\nexport async function keyLength() { return BODY.length; }\n`
          : null,
    };

    const { clientJavaScript, workerJavaScript } = await buildAndReadWorkers(root, [
      virtualActions,
    ]);
    expect(serverReferenceIds(workerJavaScript)).toHaveLength(1);
    expect(clientJavaScript).not.toContain(ACTION_BODY_MARKER);
  }, 120_000);

  it("rejects export-all re-exports of virtual modules", async () => {
    const root = copyFixture();
    // Worker-only: plugin-rsc's own export-all expansion reads re-export
    // targets from disk, so the main graphs cannot import this barrel.
    writeFile(
      root,
      "app/worker-actions.ts",
      `"use server";\n\nexport * from "virtual:worker-action-impl";\n`,
    );
    writeFile(
      root,
      "app/worker.ts",
      `import { keyLength } from "./worker-actions";

self.postMessage("worker.ts:" + typeof keyLength);
`,
    );
    const virtualImpl: import("vite").Plugin = {
      name: "test:virtual-worker-action-impl",
      resolveId: (source) =>
        source === "virtual:worker-action-impl" ? "\0virtual:worker-action-impl" : null,
      load: (id) =>
        id === "\0virtual:worker-action-impl"
          ? `const BODY = ${JSON.stringify(ACTION_BODY_MARKER)};\nimport "server-only";\nexport async function keyLength() { return BODY.length; }\n`
          : null,
    };

    await expect(buildFixture(root, [virtualImpl])).rejects.toThrow(
      /cannot `export \*` from .*virtual:worker-action-impl.*re-export its names explicitly/,
    );
  }, 120_000);

  it("leaves webpack runtime tokens in other worker modules untouched", async () => {
    const root = copyFixture();
    writeFile(
      root,
      "app/worker.ts",
      `self.postMessage(["__webpack_require__", "u"].join(".") + ":" + String("__webpack_require__.u"));
`,
    );

    await buildFixture(root);
    const workerDir = path.join(root, "dist/client/_next/static/workers");
    const workerFile = fs.readdirSync(workerDir).find((file) => /^worker-[^.]+\.js$/.test(file));
    const workerJavaScript = fs.readFileSync(path.join(workerDir, workerFile!), "utf8");
    expect(workerJavaScript).toContain("__webpack_require__.u");
    expect(workerJavaScript).not.toContain("({}).u");
  }, 120_000);
});
