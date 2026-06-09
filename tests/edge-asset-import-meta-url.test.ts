/**
 * Regression test for cloudflare/vinext#1824.
 *
 * Edge/worker routes that reference static assets via
 * `new URL("./asset", import.meta.url)` and `fetch(url)` failed at runtime:
 * Vite's built-in `vite:asset-import-meta-url` plugin only runs in the
 * `client` environment, so the URL was left untransformed, and on Cloudflare
 * Workers `import.meta.url` is the literal string `"worker"` — `new URL(...)`
 * then throws `TypeError: Invalid URL`. The whole upstream
 * `edge-compiler-can-import-blob-assets` suite (5 tests) was red.
 *
 * `vinext:edge-asset-import-meta-url` rewrites the expression to an inline
 * `data:` URL so the asset is fetchable on workerd. The unit tests below drive
 * the plugin's `transform` hook directly (mirroring the `edge.js` fixture from
 * the upstream suite); the end-to-end block runs a real Pages Router edge-API
 * build through the full Vite pipeline (filter + applyToEnvironment + the
 * cross-plugin ordering that is the explicit motivation for the change).
 */

import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { build as viteBuild } from "vite";
import vinext from "../packages/vinext/src/index.js";
import { createEdgeAssetImportMetaUrlPlugin } from "../packages/vinext/src/plugins/edge-asset-import-meta-url.js";
import type { Plugin } from "vite";

const ROOT_NODE_MODULES = path.resolve(import.meta.dirname, "../node_modules");

// Build the plugin directly so the test controls the worker-target gate.
// Defaults to a worker target since that is the environment the plugin is
// scoped to.
function getPlugin(isWorkerTarget = true): Plugin {
  return createEdgeAssetImportMetaUrlPlugin({ isWorkerTarget: () => isWorkerTarget });
}

function transformHandler(plugin: Plugin): (...args: any[]) => any {
  const t = plugin.transform as any;
  return typeof t === "function" ? t : t.handler;
}

// Minimal `this` context for the transform hook. `environment.config.consumer`
// is "server" so applyToEnvironment would admit it; isBuild defaults to false
// (we don't call configResolved) which disables the cache — fine for a test.
function makeCtx(resolveMap: Record<string, string> = {}) {
  return {
    environment: { name: "rsc", config: { consumer: "server" } },
    async resolve(spec: string) {
      const id = resolveMap[spec];
      return id ? { id } : null;
    },
  };
}

let tmpDir: string;
let routePath: string;

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-edge-asset-"));
  const srcDir = path.join(tmpDir, "src");
  const apiDir = path.join(tmpDir, "pages", "api");
  await fs.mkdir(srcDir, { recursive: true });
  await fs.mkdir(apiDir, { recursive: true });

  await fs.writeFile(path.join(srcDir, "text-file.txt"), "Hello, from text-file.txt!");
  await fs.writeFile(
    path.join(srcDir, "vercel.png"),
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01, 0x02]),
  );
  await fs.writeFile(path.join(tmpDir, "world.json"), '{ "i am": "a node dependency" }');

  routePath = path.join(apiDir, "edge.js");
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

describe("vinext:edge-asset-import-meta-url", () => {
  it("rewrites a relative text asset URL to a fetchable data: URL", async () => {
    const plugin = getPlugin();
    const code = [
      "const url = new URL('../../src/text-file.txt', import.meta.url)",
      "return fetch(url)",
    ].join("\n");

    const result = await transformHandler(plugin).call(makeCtx(), code, routePath);
    expect(result, "expected the relative URL to be rewritten").not.toBeNull();

    const expected =
      "data:text/plain;base64," + Buffer.from("Hello, from text-file.txt!").toString("base64");
    expect(result.code).toContain(`new URL(${JSON.stringify(expected)})`);
    // The runtime no longer touches the (string "worker") import.meta.url for
    // this expression.
    expect(result.code).not.toContain("import.meta.url");

    // The inlined data URL round-trips to the original bytes.
    const decoded = Buffer.from(expected.split(",")[1]!, "base64").toString("utf8");
    expect(decoded).toBe("Hello, from text-file.txt!");
  });

  it("inlines a binary image asset with the correct mime type", async () => {
    const plugin = getPlugin();
    const code = "const url = new URL('../../src/vercel.png', import.meta.url); fetch(url)";
    const result = await transformHandler(plugin).call(makeCtx(), code, routePath);
    expect(result).not.toBeNull();

    const expected =
      "data:image/png;base64," +
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01, 0x02]).toString("base64");
    expect(result.code).toContain(`new URL(${JSON.stringify(expected)})`);
  });

  it("resolves bare specifiers (node_modules assets) via the bundler resolver", async () => {
    const plugin = getPlugin();
    const worldJson = path.join(tmpDir, "world.json");
    const code = "const url = new URL('my-pkg/hello/world.json', import.meta.url); fetch(url)";
    const ctx = makeCtx({ "my-pkg/hello/world.json": worldJson });

    const result = await transformHandler(plugin).call(ctx, code, routePath);
    expect(result, "expected the bare-specifier URL to be rewritten").not.toBeNull();

    const expected =
      "data:application/json;base64," +
      Buffer.from('{ "i am": "a node dependency" }').toString("base64");
    expect(result.code).toContain(`new URL(${JSON.stringify(expected)})`);

    const decoded = JSON.parse(Buffer.from(expected.split(",")[1]!, "base64").toString("utf8"));
    expect(decoded).toEqual({ "i am": "a node dependency" });
  });

  it("leaves absolute/remote URLs untouched", async () => {
    const plugin = getPlugin();
    // Single-arg remote URL and a two-arg base form — neither references a
    // build-time asset, so the plugin must not rewrite them.
    const code = [
      "const a = new URL('https://example.vercel.sh')",
      "const b = new URL('/', 'https://example.vercel.sh')",
    ].join("\n");
    const result = await transformHandler(plugin).call(makeCtx(), code, routePath);
    expect(result).toBeNull();
  });

  it("leaves the expression untouched when the file does not exist", async () => {
    const plugin = getPlugin();
    const code = "const url = new URL('../../src/missing.bin', import.meta.url)";
    const result = await transformHandler(plugin).call(makeCtx(), code, routePath);
    expect(result).toBeNull();
  });

  it("matches the optional-chained `import.meta?.url` form", async () => {
    const plugin = getPlugin();
    const code = "const url = new URL('../../src/text-file.txt', import.meta?.url)";
    const result = await transformHandler(plugin).call(makeCtx(), code, routePath);
    expect(result, "expected import.meta?.url to be rewritten").not.toBeNull();
    const expected =
      "data:text/plain;base64," + Buffer.from("Hello, from text-file.txt!").toString("base64");
    expect(result.code).toContain(`new URL(${JSON.stringify(expected)})`);
  });

  it("strips ?query/#hash from relative specifiers before resolving", async () => {
    const plugin = getPlugin();
    const code = "const url = new URL('../../src/text-file.txt?raw', import.meta.url)";
    const result = await transformHandler(plugin).call(makeCtx(), code, routePath);
    expect(result, "expected query-suffixed specifier to resolve").not.toBeNull();
    const expected =
      "data:text/plain;base64," + Buffer.from("Hello, from text-file.txt!").toString("base64");
    expect(result.code).toContain(`new URL(${JSON.stringify(expected)})`);
  });

  it("only runs in non-client environments of a worker-target build", () => {
    const workerPlugin = getPlugin(true);
    const applyWorker = workerPlugin.applyToEnvironment as (env: any) => boolean;
    expect(applyWorker({ config: { consumer: "client" } })).toBe(false);
    expect(applyWorker({ config: { consumer: "server" } })).toBe(true);

    // Plain Node SSR build (no Cloudflare/Nitro plugin): never runs, because
    // `import.meta.url` there is already a valid file:// URL.
    const nodePlugin = getPlugin(false);
    const applyNode = nodePlugin.applyToEnvironment as (env: any) => boolean;
    expect(applyNode({ config: { consumer: "server" } })).toBe(false);
    expect(applyNode({ config: { consumer: "client" } })).toBe(false);
  });
});

// End-to-end: build a real Pages Router edge-API route through the full Vite
// pipeline and assert the worker server bundle inlines the asset. Exercises
// the filter, applyToEnvironment gate, and plugin ordering — not just the
// transform handler in isolation. A stub plugin named `vite-plugin-cloudflare`
// flips vinext's worker-target detection (the gate only checks the plugin
// name), so the plugin runs without pulling in @cloudflare/vite-plugin.
describe("vinext:edge-asset-import-meta-url (end-to-end build)", () => {
  async function buildEdgeRoute(opts: { workerTarget: boolean }): Promise<string> {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-edge-e2e-"));
    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-edge-e2e-out-"));
    try {
      await fs.symlink(ROOT_NODE_MODULES, path.join(tmpDir, "node_modules"), "junction");
      const apiDir = path.join(tmpDir, "pages", "api");
      const assetDir = path.join(tmpDir, "src");
      await fs.mkdir(apiDir, { recursive: true });
      await fs.mkdir(assetDir, { recursive: true });
      await fs.writeFile(path.join(assetDir, "text-file.txt"), "Hello, from text-file.txt!");
      await fs.writeFile(
        path.join(apiDir, "edge.js"),
        `export const config = { runtime: 'edge' }\n` +
          `export default async function handler() {\n` +
          `  const url = new URL('../../src/text-file.txt', import.meta.url)\n` +
          `  return fetch(url)\n` +
          `}\n`,
      );
      await fs.writeFile(
        path.join(tmpDir, "pages", "index.tsx"),
        "export default function Home() {\n  return <div>Hi</div>;\n}\n",
      );

      const stubCloudflarePlugin: Plugin = { name: "vite-plugin-cloudflare" };
      await viteBuild({
        root: tmpDir,
        configFile: false,
        plugins: [
          ...(opts.workerTarget ? [stubCloudflarePlugin] : []),
          vinext({ disableAppRouter: true }),
        ],
        logLevel: "silent",
        build: {
          outDir,
          emptyOutDir: false,
          ssr: "virtual:vinext-server-entry",
          rollupOptions: { output: { entryFileNames: "entry.js" } },
        },
      });

      return await fs.readFile(path.join(outDir, "entry.js"), "utf8");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      await fs.rm(outDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  it("inlines the asset as a data: URL in the worker server bundle", async () => {
    const entry = await buildEdgeRoute({ workerTarget: true });
    const expected =
      "data:text/plain;base64," + Buffer.from("Hello, from text-file.txt!").toString("base64");
    expect(
      entry.includes(expected),
      `expected the edge route's new URL(...) to be inlined as a data: URL`,
    ).toBe(true);
    // The rewritten expression no longer references import.meta.url, which is
    // the literal string "worker" at runtime and would throw on `new URL(...)`.
    expect(entry).not.toContain("text-file.txt");
  }, 180_000);

  it("leaves the expression untouched in a plain Node SSR build", async () => {
    const entry = await buildEdgeRoute({ workerTarget: false });
    // No Cloudflare/Nitro plugin → the edge-asset plugin must not run, so no
    // data: URL is emitted for this asset.
    expect(entry).not.toContain("data:text/plain;base64");
  }, 180_000);
});
