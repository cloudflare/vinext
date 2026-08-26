import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build, type Plugin } from "vite";
import { _transformVeryDynamicRequests } from "../packages/vinext/src/plugins/ignore-dynamic-requests.js";
import {
  _mayContainFetchIdentifier,
  createImportMetaUrlPlugin,
} from "../packages/vinext/src/plugins/import-meta-url.js";
import { OgAssetOwnership } from "../packages/vinext/src/plugins/og-asset-ownership.js";
import {
  MAX_INLINE_FETCH_ASSET_BYTES,
  MAX_INLINE_FETCH_ASSET_MODULE_OUTPUT_BYTES,
} from "../packages/vinext/src/plugins/import-meta-assets.js";
import vinext from "../packages/vinext/src/index.js";

function hookHandler(hook: unknown): (...args: any[]) => any {
  return typeof hook === "function"
    ? (hook as (...args: any[]) => any)
    : (hook as { handler: (...args: any[]) => any }).handler;
}

function transformHandler(plugin: Plugin): (...args: any[]) => any {
  return hookHandler(plugin.transform);
}

function fetchInputUrl(input: string | URL | Request | undefined): string {
  if (input === undefined) throw new Error("Expected fetch to receive an input");
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

async function importCode(code: string): Promise<Record<string, any>> {
  return import(
    /* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`
  );
}

describe("import-meta asset phase", () => {
  let root: string;
  let routePath: string;
  let typedRoutePath: string;
  let packageAssetPath: string;

  beforeAll(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "vinext-import-meta-assets-"));
    routePath = path.join(root, "pages", "api", "edge.js");
    typedRoutePath = path.join(root, "pages", "api", "edge.ts");
    packageAssetPath = path.join(root, "node_modules", "my-pkg", "hello", "world.json");
    await fsp.mkdir(path.dirname(routePath), { recursive: true });
    await fsp.mkdir(path.join(root, "src"), { recursive: true });
    await fsp.mkdir(path.dirname(packageAssetPath), { recursive: true });
    await fsp.writeFile(path.join(root, "package.json"), JSON.stringify({ type: "module" }));
    await fsp.writeFile(routePath, "export default function handler() {}\n");
    await fsp.writeFile(typedRoutePath, "export default function handler() {}\n");
    await fsp.writeFile(path.join(root, "src", "text-file.txt"), "Hello, from text-file.txt!");
    await fsp.writeFile(path.join(root, "src", "font name.txt"), "encoded space");
    await fsp.writeFile(path.join(root, "src", "font#hash.txt"), "encoded hash");
    await fsp.writeFile(path.join(root, "src", "vercel.png"), Buffer.from([0x89, 0x50, 0x4e]));
    await fsp.writeFile(packageAssetPath, '{ "i am": "a node dependency" }');
  });

  afterAll(async () => {
    if (root) await fsp.rm(root, { recursive: true, force: true });
  });

  async function createPlugin(command: "build" | "serve" = "build") {
    const ownership = new OgAssetOwnership();
    const plugin = createImportMetaUrlPlugin({
      getRoot: () => root,
      assetOwnership: ownership,
    }).vitePlugin;
    await hookHandler(plugin.configResolved).call(null, {
      command,
      root,
      resolve: { alias: [] },
      environments: {},
      build: { outDir: "dist" },
    });
    await hookHandler(plugin.buildStart).call(null);
    return plugin;
  }

  function context(
    resolveMap: Record<string, string> = {},
    consumer: "client" | "server" = "server",
  ) {
    const watchedFiles: string[] = [];
    return {
      watchedFiles,
      environment: {
        name: consumer === "client" ? "client" : "ssr",
        mode: "build",
        config: { consumer },
      },
      addWatchFile(file: string) {
        watchedFiles.push(file);
      },
      async resolve(specifier: string) {
        const id = resolveMap[specifier];
        return id ? { id } : null;
      },
    };
  }

  it("prescans only standalone fetch identifiers", () => {
    expect(_mayContainFetchIdentifier("fetch(url)")).toBe(true);
    expect(_mayContainFetchIdentifier(String.raw`f\u0065tch(url)`)).toBe(true);
    expect(_mayContainFetchIdentifier(String.raw`\u0066etch(url)`)).toBe(true);
    expect(_mayContainFetchIdentifier("prefetch(url); fetcher(url); $fetch(url)")).toBe(false);
    expect(_mayContainFetchIdentifier(String.raw`pre\u0066etch(url); fetch\u0065r(url)`)).toBe(
      false,
    );
  });

  it("makes the import-meta plugin the explicit ownership tracker", async () => {
    const ownership = new OgAssetOwnership();
    const configure = vi.spyOn(ownership, "configure");
    const reset = vi.spyOn(ownership, "reset");
    const record = vi.spyOn(ownership, "recordResolvedImport");
    const plugin = createImportMetaUrlPlugin({
      getRoot: () => root,
      assetOwnership: ownership,
    }).vitePlugin;
    const config = {
      command: "build",
      root,
      resolve: { alias: [{ find: "my-pkg", replacement: packageAssetPath }] },
      environments: {},
      build: { outDir: "dist" },
    };

    await hookHandler(plugin.configResolved).call(null, config);
    await hookHandler(plugin.buildStart).call(null);

    expect(plugin.name).toBe("vinext:import-meta-url");
    expect(plugin.resolveId).toBeDefined();
    expect(configure).toHaveBeenCalledOnce();
    expect(reset).toHaveBeenCalledOnce();

    await hookHandler(plugin.resolveId).call(
      { resolve: async () => ({ id: packageAssetPath }) },
      "my-pkg",
      routePath,
      {},
    );
    expect(record).toHaveBeenCalledWith("my-pkg", packageAssetPath);
  });

  it("keeps dependency tracking ahead of resolution and asset transforms after compilation", () => {
    const plugin = createImportMetaUrlPlugin({
      getRoot: () => root,
      assetOwnership: new OgAssetOwnership(),
    }).vitePlugin;

    expect(typeof plugin.resolveId).toBe("object");
    expect((plugin.resolveId as { order?: string }).order).toBe("pre");
    expect(typeof plugin.transform).toBe("object");
    expect((plugin.transform as { order?: string }).order).toBe("post");
  });

  it("disables the overlapping legacy fetch inliner in production wiring", async () => {
    const plugin = vinext().find(
      (candidate): candidate is Plugin =>
        typeof candidate === "object" &&
        candidate !== null &&
        "name" in candidate &&
        candidate.name === "vinext:og-inline-read-file-assets",
    );
    if (!plugin) throw new Error("Expected the production OG inline plugin");
    await hookHandler(plugin.configResolved).call(null, {
      command: "build",
      root,
      resolve: { alias: [] },
    });
    await hookHandler(plugin.buildStart).call(null);

    const source = `fetch(new URL("../../src/text-file.txt", import.meta.url)).then((response) => response.arrayBuffer());`;
    expect(await transformHandler(plugin).call(context(), source, routePath)).toBeNull();
  });

  it("tracks an aliased workspace package through a real server build", async () => {
    const workspaceRoot = path.join(root, "workspace-build");
    const projectRoot = path.join(workspaceRoot, "app");
    const packageRoot = path.join(workspaceRoot, "packages", "ui");
    const entry = path.join(projectRoot, "entry.js");
    const packageEntry = path.join(packageRoot, "dist", "feature.js");
    const output = path.join(projectRoot, "dist", "entry.mjs");
    const asset = Buffer.from("workspace-package-asset");
    await fsp.mkdir(projectRoot, { recursive: true });
    await fsp.mkdir(path.dirname(packageEntry), { recursive: true });
    await fsp.writeFile(path.join(projectRoot, "package.json"), JSON.stringify({ type: "module" }));
    await fsp.writeFile(entry, `export { response } from "ui";`);
    await fsp.writeFile(
      path.join(packageRoot, "package.json"),
      JSON.stringify({
        name: "@scope/ui",
        type: "module",
        exports: { "./*": "./dist/*.js" },
      }),
    );
    await fsp.writeFile(
      packageEntry,
      `export const response = fetch(new URL("../asset.bin", import.meta.url));`,
    );
    await fsp.writeFile(path.join(packageRoot, "asset.bin"), asset);

    await build({
      root: projectRoot,
      configFile: false,
      logLevel: "silent",
      resolve: { alias: { ui: packageEntry } },
      ssr: { noExternal: true },
      plugins: [
        createImportMetaUrlPlugin({
          getRoot: () => projectRoot,
          assetOwnership: new OgAssetOwnership(),
        }).vitePlugin,
      ],
      build: {
        ssr: entry,
        outDir: "dist",
        rolldownOptions: { output: { entryFileNames: "entry.mjs" } },
      },
    });

    const code = await fsp.readFile(output, "utf8");
    expect(code).toContain(asset.toString("base64"));
    expect(code).not.toContain(`new URL("./asset.bin", import.meta.url)`);
  });

  it("preserves observable URL consumers while replacing only the fetch input", async () => {
    const plugin = await createPlugin();
    const source = [
      `import { fileURLToPath } from "node:url";`,
      `const url = new URL("../../src/text-file.txt", import.meta.url);`,
      `const path = url.pathname;`,
      `const file = fileURLToPath(url);`,
      `const response = fetch(url);`,
    ].join("\n");
    const result = await transformHandler(plugin).call(context(), source, routePath);
    expect(result.code).toContain(`const url = new URL("../../src/text-file.txt",`);
    expect(result.code).toContain(`, __vinext_asset_url = new URL(__vinext_asset_data)`);
    expect(result.code).toContain(`const path = url.pathname;`);
    expect(result.code).toContain(`const file = fileURLToPath(url);`);
    expect(result.code).toContain(`fetch(__vinext_asset_url)`);
  });

  it("keeps escaped fetch identifiers eligible for asset rewriting", async () => {
    const plugin = await createPlugin();
    const source = String.raw`export const response = f\u0065tch(new URL("../../src/text-file.txt", import.meta.url));`;
    const result = await transformHandler(plugin).call(context(), source, routePath);

    expect(result.code).toContain(String.raw`f\u0065tch(new URL(__vinext_asset_data))`);
  });

  it("finalizes observable asset aliases with portable emitted-module identity", async () => {
    const ownership = new OgAssetOwnership();
    const capability = createImportMetaUrlPlugin({
      getRoot: () => root,
      assetOwnership: ownership,
    });
    const plugin = capability.vitePlugin;
    await hookHandler(plugin.configResolved).call(null, {
      command: "build",
      root,
      resolve: { alias: [] },
      environments: {},
      build: { outDir: "dist" },
    });
    await hookHandler(plugin.buildStart).call(null);
    const transformed = await transformHandler(plugin).call(
      context(),
      [
        `const asset = new URL("../../src/text-file.txt", import.meta.url);`,
        `export const protocol = asset.protocol;`,
        `export const response = fetch(asset);`,
      ].join("\n"),
      routePath,
    );
    const emitted = hookHandler(plugin.renderChunk).call(
      context(),
      transformed.code,
      { fileName: "server/entry.js" },
      { format: "es" },
    );

    expect(emitted.code).toContain('from "node:url"');
    expect(emitted.code).toContain(
      `new URL("../../src/text-file.txt", ({ get value() { return __vinext_module_identity.url; } }).value)`,
    );
    expect(emitted.code).toContain(`fetch(__vinext_asset_url)`);
    expect(emitted.code).not.toContain("__VINEXT_EMITTED_MODULE_URL_");
  });

  it("replaces a direct fetch input in a Node build", async () => {
    const plugin = await createPlugin();
    const source = `function handler() { return fetch(new URL("../../src/text-file.txt", import.meta.url)); }`;
    const result = await transformHandler(plugin).call(context(), source, routePath);
    expect(result.code).toContain(`fetch(new URL(__vinext_asset_data))`);
    expect(result.code).not.toContain("import.meta.url");
  });

  it("eliminates module-scope I/O for an exact fetch arrayBuffer chain", async () => {
    const plugin = await createPlugin();
    const source = `export default fetch(new URL("../../src/text-file.txt", import.meta.url)).then((response) => response.arrayBuffer());`;
    const result = await transformHandler(plugin).call(context(), source, routePath);

    expect(result.code).toContain("const __vinext_decode_asset_data = async (data) => {");
    expect(result.code).toContain("new globalThis.Uint8Array(binary.length)");
    expect(result.code).not.toContain("fetch(");
    expect(result.code).not.toContain("import.meta.url");
    expect(result.code).toContain(Buffer.from("Hello, from text-file.txt!").toString("base64"));
  });

  it("preserves a replaced global fetch for module-scope arrayBuffer chains", async () => {
    const plugin = await createPlugin();
    const source = [
      `const originalFetch = globalThis.fetch;`,
      `let calls = 0;`,
      `globalThis.fetch = async () => { calls += 1; return new Response("instrumented"); };`,
      `export const asset = fetch(new URL("../../src/text-file.txt", import.meta.url)).then((response) => response.arrayBuffer());`,
      `export { calls };`,
      `export function restore() { globalThis.fetch = originalFetch; }`,
    ].join("\n");
    const result = await transformHandler(plugin).call(context(), source, routePath);

    expect(result.code).toContain("fetch(new URL(__vinext_asset_data)).then");
    expect(result.code).not.toContain("__vinext_decode_asset_data");
    expect(result.code).not.toContain("import.meta.url");

    const module = await importCode(result.code);
    try {
      expect(Buffer.from(await module.asset).toString()).toBe("instrumented");
      expect(module.calls).toBe(1);
    } finally {
      module.restore();
    }
  });

  it("preserves a bare replacement of global fetch for module-scope arrayBuffer chains", async () => {
    const plugin = await createPlugin();
    const source = [
      `const originalFetch = globalThis.fetch;`,
      `let calls = 0;`,
      `fetch = async () => { calls += 1; return new Response("instrumented"); };`,
      `export const asset = fetch(new URL("../../src/text-file.txt", import.meta.url)).then((response) => response.arrayBuffer());`,
      `export { calls };`,
      `export function restore() { globalThis.fetch = originalFetch; }`,
    ].join("\n");
    const result = await transformHandler(plugin).call(context(), source, routePath);

    expect(result.code).toContain("fetch(new URL(__vinext_asset_data)).then");
    expect(result.code).not.toContain("__vinext_decode_asset_data");
    expect(result.code).not.toContain("import.meta.url");

    const module = await importCode(result.code);
    try {
      expect(Buffer.from(await module.asset).toString()).toBe("instrumented");
      expect(module.calls).toBe(1);
    } finally {
      module.restore();
    }
  });

  it("keeps the decoder when global fetch is replaced after the asset chain", async () => {
    const plugin = await createPlugin();
    const source = [
      `export const asset = fetch(new URL("../../src/text-file.txt", import.meta.url)).then((response) => response.arrayBuffer());`,
      `globalThis.fetch = instrumentedFetch;`,
      `function instrumentedFetch() { throw new Error("later replacement"); }`,
    ].join("\n");
    const result = await transformHandler(plugin).call(context(), source, routePath);

    expect(result.code).toContain("__vinext_decode_asset_data(");
    expect(result.code).not.toContain("fetch(");
  });

  it("changes fetch eligibility after evaluating a replacement assignment", async () => {
    const plugin = await createPlugin();
    const source = [
      `const instrumentedFetch = globalThis.fetch;`,
      `globalThis.fetch = (fetch(new URL("../../src/text-file.txt", import.meta.url)).then((response) => response.arrayBuffer()), instrumentedFetch);`,
      `export const after = fetch(new URL("../../src/text-file.txt", import.meta.url)).then((response) => response.arrayBuffer());`,
    ].join("\n");
    const result = await transformHandler(plugin).call(context(), source, routePath);

    expect(result.code.match(/__vinext_decode_asset_data\(/g)).toHaveLength(1);
    expect(result.code.match(/fetch\(new URL\(__vinext_asset_data\)\)\.then/g)).toHaveLength(1);
  });

  it("evaluates declaration initializers before destructuring defaults", async () => {
    const plugin = await createPlugin();
    const source = [
      `const instrumentedFetch = globalThis.fetch;`,
      `export const [asset = (globalThis.fetch = instrumentedFetch)] = [fetch(new URL("../../src/text-file.txt", import.meta.url)).then((response) => response.arrayBuffer())];`,
    ].join("\n");
    const result = await transformHandler(plugin).call(context(), source, routePath);

    expect(result.code).toContain("__vinext_decode_asset_data(");
    expect(result.code).not.toContain("fetch(new URL(__vinext_asset_data)).then");
  });

  it("preserves global fetch replacements made by module-scope IIFEs", async () => {
    const plugin = await createPlugin();
    const source = [
      `const originalFetch = globalThis.fetch;`,
      `let calls = 0;`,
      `(() => { globalThis.fetch = async () => { calls += 1; return new Response("instrumented"); }; })();`,
      `export const asset = fetch(new URL("../../src/text-file.txt", import.meta.url)).then((response) => response.arrayBuffer());`,
      `export { calls };`,
      `export function restore() { globalThis.fetch = originalFetch; }`,
    ].join("\n");
    const result = await transformHandler(plugin).call(context(), source, routePath);

    expect(result.code).toContain("fetch(new URL(__vinext_asset_data)).then");
    expect(result.code).not.toContain("__vinext_decode_asset_data");

    const module = await importCode(result.code);
    try {
      expect(Buffer.from(await module.asset).toString()).toBe("instrumented");
      expect(module.calls).toBe(1);
    } finally {
      module.restore();
    }
  });

  it("does not execute generator IIFE bodies during module initialization analysis", async () => {
    const plugin = await createPlugin();
    const source = [
      `(function* () { globalThis.fetch = instrumentedFetch; })();`,
      `export const asset = fetch(new URL("../../src/text-file.txt", import.meta.url)).then((response) => response.arrayBuffer());`,
    ].join("\n");
    const result = await transformHandler(plugin).call(context(), source, routePath);

    expect(result.code).toContain("__vinext_decode_asset_data(");
    expect(result.code).not.toContain("fetch(");
  });

  it("evaluates IIFE defaults only for arguments that may be undefined", async () => {
    const plugin = await createPlugin();
    const iife = (argument: string) =>
      [
        `const instrumentedFetch = globalThis.fetch;`,
        `export const asset = ((value = (globalThis.fetch = instrumentedFetch)) => fetch(new URL("../../src/text-file.txt", import.meta.url)).then((response) => response.arrayBuffer()))(${argument});`,
      ].join("\n");

    const supplied = await transformHandler(plugin).call(context(), iife("1"), routePath);
    expect(supplied.code).toContain("__vinext_decode_asset_data(");
    expect(supplied.code).not.toContain("fetch(new URL(__vinext_asset_data)).then");

    const missing = await transformHandler(plugin).call(context(), iife(""), routePath);
    expect(missing.code).toContain("fetch(new URL(__vinext_asset_data)).then");
    expect(missing.code).not.toContain("__vinext_decode_asset_data");
  });

  it("keeps the module-scope decoder for read-only globalThis members", async () => {
    const plugin = await createPlugin();
    const source = [
      `export const crypto = globalThis.crypto;`,
      `export const asset = fetch(new URL("../../src/text-file.txt", import.meta.url)).then((response) => response.arrayBuffer());`,
    ].join("\n");
    const result = await transformHandler(plugin).call(context(), source, routePath);

    expect(result.code).toContain("__vinext_decode_asset_data(");
    expect(result.code).not.toContain("fetch(");
  });

  it("keeps the module-scope decoder for global object feature detection", async () => {
    const plugin = await createPlugin();
    const source = [
      `export const supported = typeof globalThis !== "undefined";`,
      `export const asset = fetch(new URL("../../src/text-file.txt", import.meta.url)).then((response) => response.arrayBuffer());`,
    ].join("\n");
    const result = await transformHandler(plugin).call(context(), source, routePath);

    expect(result.code).toContain("__vinext_decode_asset_data(");
    expect(result.code).not.toContain("fetch(");
  });

  it("preserves possible module-scope replacements through global object aliases", async () => {
    const plugin = await createPlugin();
    for (const replacement of [
      `globalThis["fetch"] = instrumentedFetch;`,
      `self.fetch = instrumentedFetch;`,
      `global.fetch = instrumentedFetch;`,
      `const host = globalThis; host.fetch = instrumentedFetch;`,
      `Object.defineProperty(globalThis, "fetch", { value: instrumentedFetch });`,
    ]) {
      const source = [
        `const instrumentedFetch = fetch;`,
        replacement,
        `export const asset = fetch(new URL("../../src/text-file.txt", import.meta.url)).then((response) => response.arrayBuffer());`,
      ].join("\n");
      const result = await transformHandler(plugin).call(context(), source, routePath);

      expect(result.code).toContain("fetch(new URL(__vinext_asset_data)).then");
      expect(result.code).not.toContain("__vinext_decode_asset_data");
    }
  });

  it("ignores global object escapes in deferred execution", async () => {
    const plugin = await createPlugin();
    const source = [
      `export function exposeGlobal() { return globalThis; }`,
      `export const asset = fetch(new URL("../../src/text-file.txt", import.meta.url)).then((response) => response.arrayBuffer());`,
    ].join("\n");
    const result = await transformHandler(plugin).call(context(), source, routePath);

    expect(result.code).toContain("__vinext_decode_asset_data(");
    expect(result.code).not.toContain("fetch(");
  });

  it("preserves fetch semantics for exact arrayBuffer chains inside functions", async () => {
    const plugin = await createPlugin();
    const source = [
      `export function read() { return fetch(new URL("../../src/text-file.txt", import.meta.url)).then((response) => response.arrayBuffer()); }`,
      `export function nested() { return { asset: fetch(new URL("../../src/text-file.txt", import.meta.url)).then((response) => response.arrayBuffer()) }; }`,
    ].join("\n");
    const result = await transformHandler(plugin).call(context(), source, routePath);

    expect(result.code.match(/fetch\(new URL\(__vinext_asset_data\)\)/g)).toHaveLength(2);
    expect(result.code).not.toContain("__vinext_decode_asset_data");
    expect(result.code).not.toContain("import.meta.url");
  });

  it("distinguishes deferred defaults and fields from static initialization", async () => {
    const plugin = await createPlugin();
    const source = [
      `export function read(asset = fetch(new URL("../../src/text-file.txt", import.meta.url)).then((response) => response.arrayBuffer())) { return asset; }`,
      `export class Reader {`,
      `  asset = fetch(new URL("../../src/text-file.txt", import.meta.url)).then((response) => response.arrayBuffer());`,
      `  static shared = fetch(new URL("../../src/text-file.txt", import.meta.url)).then((response) => response.arrayBuffer());`,
      `}`,
    ].join("\n");
    const result = await transformHandler(plugin).call(context(), source, routePath);

    expect(result.code.match(/fetch\(new URL\(__vinext_asset_data\)\)/g)).toHaveLength(2);
    expect(result.code).toContain("static shared = __vinext_decode_asset_data(");
    expect(result.code).not.toContain("import.meta.url");
  });

  it("decodes with collision-safe globals when common intrinsics are shadowed", async () => {
    const plugin = await createPlugin();
    const source = [
      `const Promise = null;`,
      `const Uint8Array = null;`,
      `const atob = null;`,
      `export const asset = fetch(new URL("../../src/text-file.txt", import.meta.url)).then((response) => response.arrayBuffer());`,
    ].join("\n");
    const result = await transformHandler(plugin).call(context(), source, routePath);
    const module = await importCode(result.code);

    expect(Buffer.from(await module.asset).toString()).toBe("Hello, from text-file.txt!");
  });

  it("keeps decoding asynchronous and reports decoder failures as rejections", async () => {
    const plugin = await createPlugin();
    const source = [
      `const asset = fetch(new URL("../../src/text-file.txt", import.meta.url)).then((response) => response.arrayBuffer());`,
      `const order = [];`,
      `asset.catch(() => order.push("asset"));`,
      `queueMicrotask(() => order.push("sentinel"));`,
      `export { asset, order };`,
    ].join("\n");
    const result = await transformHandler(plugin).call(context(), source, routePath);
    const encoded = Buffer.from("Hello, from text-file.txt!").toString("base64");
    const malformed = result.code.replace(encoded, "%%%invalid-base64%%%");
    const module = await importCode(malformed);

    await expect(module.asset).rejects.toThrow();
    await Promise.resolve();
    expect(module.order).toEqual(["sentinel", "asset"]);
  });

  it("keeps other fetch response chains intact", async () => {
    const plugin = await createPlugin();
    const source = [
      `const text = fetch(new URL("../../src/text-file.txt", import.meta.url)).then((response) => response.text());`,
      `const other = { arrayBuffer() {} };`,
      `const bytes = fetch(new URL("../../src/text-file.txt", import.meta.url)).then(() => other.arrayBuffer());`,
      `const iterator = fetch(new URL("../../src/text-file.txt", import.meta.url)).then(function* (response) { return response.arrayBuffer(); });`,
      `const asyncBytes = fetch(new URL("../../src/text-file.txt", import.meta.url)).then(async (response) => response.arrayBuffer());`,
    ].join("\n");
    const result = await transformHandler(plugin).call(context(), source, routePath);

    expect(result.code.match(/fetch\(new URL\(__vinext_asset_data\)\)/g)).toHaveLength(4);
    expect(result.code).not.toContain("__vinext_decode_asset_data");
  });

  it("watches every embedded asset", async () => {
    const plugin = await createPlugin();
    const pluginContext = context({ "my-pkg/hello/world.json": packageAssetPath });
    const source = [
      `fetch(new URL("../../src/text-file.txt", import.meta.url));`,
      `fetch(new URL("my-pkg/hello/world.json", import.meta.url));`,
    ].join("\n");
    await transformHandler(plugin).call(pluginContext, source, routePath);
    expect(pluginContext.watchedFiles).toEqual([
      await fsp.realpath(path.join(root, "src", "text-file.txt")),
      await fsp.realpath(packageAssetPath),
    ]);
  });

  it("replaces stale dev asset-importer edges when a module changes", async () => {
    const plugin = await createPlugin("serve");
    const textAsset = await fsp.realpath(path.join(root, "src", "text-file.txt"));
    const imageAsset = await fsp.realpath(path.join(root, "src", "vercel.png"));
    const moduleNode = { id: routePath };
    const hotContext = {
      environment: {
        moduleGraph: {
          getModuleById: (id: string) => (id === routePath ? moduleNode : undefined),
        },
      },
    };

    await transformHandler(plugin).call(
      context(),
      `fetch(new URL("../../src/text-file.txt", import.meta.url));`,
      routePath,
    );
    expect(
      hookHandler(plugin.hotUpdate).call(hotContext, { file: textAsset, modules: [] }),
    ).toEqual([moduleNode]);

    await transformHandler(plugin).call(
      context(),
      `fetch(new URL("../../src/vercel.png", import.meta.url));`,
      routePath,
    );
    expect(
      hookHandler(plugin.hotUpdate).call(hotContext, { file: textAsset, modules: [] }),
    ).toBeUndefined();
    expect(
      hookHandler(plugin.hotUpdate).call(hotContext, { file: imageAsset, modules: [] }),
    ).toEqual([moduleNode]);

    await transformHandler(plugin).call(
      context(),
      `console.log(new URL("../../src/vercel.png", import.meta.url).protocol);`,
      routePath,
    );
    expect(
      hookHandler(plugin.hotUpdate).call(hotContext, { file: imageAsset, modules: [] }),
    ).toBeUndefined();
  });

  it("keeps same-named aliases isolated by lexical scope", async () => {
    const plugin = await createPlugin();
    const source = [
      `const one = () => { const url = new URL("../../src/text-file.txt", import.meta.url); return fetch(url); };`,
      `const two = () => { const url = new URL("../../src/vercel.png", import.meta.url); return fetch(url); };`,
    ].join("\n");
    const result = await transformHandler(plugin).call(context(), source, routePath);
    expect(result.code).toContain("data:text/plain; charset=utf-8;base64,");
    expect(result.code).toContain("data:image/png;base64,");
  });

  it("passes mutated, escaped, or exported aliases through at runtime", async () => {
    const plugin = await createPlugin();
    for (const use of [
      `url.pathname = "/other";`,
      `mutate(url);`,
      `target[mutate(url)] = value;`,
      `const { value = mutate(url) } = {};`,
      `for (url.pathname of values) {}`,
      `for ({ value: url.pathname } of values) {}`,
      `for (const { value = mutate(url) } of values) {}`,
      `eval('url.pathname = "/other"');`,
      `export { url };`,
    ]) {
      const source = [
        `const url = new URL("../../src/text-file.txt", import.meta.url);`,
        use,
        `fetch(url);`,
      ].join("\n");
      expect(await transformHandler(plugin).call(context(), source, routePath)).toBeNull();
    }
  });

  it("preserves the temporal-dead-zone read for aliases used before initialization", async () => {
    const plugin = await createPlugin();
    const source = [
      `fetch(url);`,
      `const url = new URL("../../src/text-file.txt", import.meta.url);`,
    ].join("\n");
    const result = await transformHandler(plugin).call(context(), source, routePath);
    expect(result.code).toContain(`fetch(__vinext_asset_url)`);
  });

  it("does not reuse aliases across switch cases", async () => {
    const plugin = await createPlugin();
    const source = [
      `switch (kind) {`,
      `  case 1: fetch(url); break;`,
      `  case 2: const url = new URL("../../src/text-file.txt", import.meta.url); break;`,
      `}`,
    ].join("\n");
    expect(await transformHandler(plugin).call(context(), source, routePath)).toBeNull();
  });

  it("tracks side effects in dynamic-import options without rewriting the specifier", async () => {
    const plugin = await createPlugin();
    const source = [
      `const asset = new URL("../../src/text-file.txt", import.meta.url);`,
      `void import("./noop.js", (asset.href = "data:text/plain,mutated", {}));`,
      `fetch(asset);`,
    ].join("\n");
    const result = await transformHandler(plugin).call(context(), source, routePath);
    expect(result?.code ?? source).toContain(`fetch(asset)`);
    expect(result?.code ?? source).not.toContain("data:text/plain; charset=utf-8;base64,");
  });

  it("ignores syntax-only identifiers while validating aliases", async () => {
    const plugin = await createPlugin();
    const source = [
      `import { url as other } from "./other";`,
      `const url = new URL("../../src/text-file.txt", import.meta.url);`,
      `type Snapshot = typeof url;`,
      `const object = { url: other };`,
      `class Holder { accessor url = 1; }`,
      `urlLabel: { break urlLabel; }`,
      `export { url } from "./other";`,
      `fetch(url);`,
    ].join("\n");
    const result = await transformHandler(plugin).call(context(), source, typedRoutePath);
    expect(result.code).toContain(`fetch(__vinext_asset_url)`);

    const metaSource = [
      `const meta = new URL("../../src/text-file.txt", import.meta.url);`,
      `void import.meta;`,
      `export * as meta from "./other";`,
      `fetch(meta);`,
    ].join("\n");
    const metaResult = await transformHandler(plugin).call(context(), metaSource, typedRoutePath);
    expect(metaResult.code).toContain(`fetch(__vinext_asset_url)`);
  });

  it("avoids runtime TypeScript declaration collisions", async () => {
    const plugin = await createPlugin();
    const source = [
      `enum __vinext_asset_url { Value }`,
      `namespace __vinext_asset_url_ { export const value = 1; }`,
      `import __vinext_asset_url__ = require("./other");`,
      `const asset = new URL("../../src/text-file.txt", import.meta.url);`,
      `fetch(asset);`,
    ].join("\n");
    const result = await transformHandler(plugin).call(context(), source, typedRoutePath);
    expect(result.code).toContain(`__vinext_asset_url___ = new URL(__vinext_asset_data`);
  });

  it("invalidates aliases referenced by decorators", async () => {
    const plugin = await createPlugin();
    const source = [
      `const asset = new URL("../../src/text-file.txt", import.meta.url);`,
      `class Example { @mutate(asset) method() {} }`,
      `fetch(asset);`,
    ].join("\n");
    expect(await transformHandler(plugin).call(context(), source, typedRoutePath)).toBeNull();

    const parameterMutation = [
      `const asset = new URL("../../src/text-file.txt", import.meta.url);`,
      `class ParameterMutation { method(@mutate(asset) asset: unknown) {} }`,
      `fetch(asset);`,
    ].join("\n");
    expect(
      await transformHandler(plugin).call(context(), parameterMutation, typedRoutePath),
    ).toBeNull();

    const decoratedAsset = `@decorate(new URL("../../src/text-file.txt", import.meta.url)) class Decorated {}`;
    const result = await transformHandler(await createPlugin()).call(
      context(),
      decoratedAsset,
      typedRoutePath,
    );
    expect(result).toBeNull();

    const decoratedParameter = [
      `class DecoratedParameter {`,
      `  constructor(@decorate(new URL("../../src/text-file.txt", import.meta.url)) public value: string) {}`,
      `}`,
    ].join("\n");
    const parameterResult = await transformHandler(await createPlugin()).call(
      context(),
      decoratedParameter,
      typedRoutePath,
    );
    expect(parameterResult).toBeNull();
  });

  it("preserves non-fetch URL consumers on every target", async () => {
    const plugin = await createPlugin();
    const source = [
      `const text = new URL("../../src/text-file.txt", import.meta.url);`,
      `const image = new URL("../../src/vercel.png", import.meta?.url);`,
    ].join("\n");
    expect(await transformHandler(plugin).call(context(), source, routePath)).toBeNull();
  });

  it("preserves non-fetch assets in default parameter initializers", async () => {
    const plugin = await createPlugin();
    const source = `function read(asset = new URL("../../src/text-file.txt", import.meta.url)) { return asset; }`;
    expect(await transformHandler(plugin).call(context(), source, routePath)).toBeNull();
  });

  it("keeps URL-based dynamic imports in the module graph", async () => {
    const plugin = await createPlugin();
    const source = [
      `void import(new URL("../../src/text-file.txt", import.meta.url).href);`,
      `const asset = fetch(new URL("../../src/vercel.png", import.meta.url));`,
    ].join("\n");
    const normalized = _transformVeryDynamicRequests(source, routePath, false);
    if (!normalized) throw new Error("Expected the early URL import transform to run");
    const result = await transformHandler(plugin).call(context(), normalized.code, routePath);
    expect(result.code).toContain(`import("../../src/text-file.txt")`);
    expect(result.code).toContain("data:image/png;base64,");
    expect(result.code).not.toContain("data:text/plain");
  });

  it.each([
    `import(new URL("../../src/text-file.txt", import.meta.url));`,
    `import(/* @vite-ignore */ new URL("../../src/text-file.txt", import.meta.url));`,
  ])("never treats a dynamic import specifier as a fetched asset", async (source) => {
    const plugin = await createPlugin();
    expect(await transformHandler(plugin).call(context(), source, routePath)).toBeNull();
  });

  it("constructs the replacement before a fetch-time URL shadow", async () => {
    const plugin = await createPlugin();
    const source = [
      `const asset = new URL("../../src/text-file.txt", import.meta.url);`,
      `function read(URL) { return fetch(asset); }`,
    ].join("\n");
    const result = await transformHandler(plugin).call(context(), source, routePath);
    expect(result.code).toContain(`__vinext_asset_url = new URL(__vinext_asset_data`);
    expect(result.code).toContain(`function read(URL) { return fetch(__vinext_asset_url); }`);
  });

  it("keeps directives intact and avoids decoded identifier collisions", async () => {
    const plugin = await createPlugin();
    const source = [
      `"use server";`,
      `const __vinext_asset_\\u0075rl = "user";`,
      `const asset = new URL("../../src/text-file.txt", import.meta.url);`,
      `function read(__vinext_asset_url_) {`,
      `  for (const __vinext_asset_url__ of values) { fetch(asset); }`,
      `}`,
    ].join("\n");
    const result = await transformHandler(plugin).call(context(), source, routePath);
    expect(result.code).toContain(`__vinext_asset_url___ = new URL(__vinext_asset_data`);
    expect(result.code).toContain(
      `for (const __vinext_asset_url__ of values) { fetch(__vinext_asset_url___); }`,
    );
    expect(result.code).toContain(`"use server";`);
    expect(result.code).toContain(`const __vinext_asset_\\u0075rl = "user";`);
  });

  it("does not depend on the global WeakMap constructor", async () => {
    const plugin = await createPlugin();
    const source = [
      `const WeakMap = CustomWeakMap;`,
      `const asset = new URL("../../src/text-file.txt", import.meta.url);`,
      `fetch(asset);`,
    ].join("\n");
    const result = await transformHandler(plugin).call(context(), source, routePath);
    expect(result.code).toContain(`fetch(__vinext_asset_url)`);
    expect(result.code).not.toContain(`new WeakMap`);
  });

  it("executes alias pass-through, constructor replacement, and TDZ semantics", async () => {
    const runtimeRoot = path.join(root, "runtime-alias");
    const entry = path.join(runtimeRoot, "entry.js");
    const outDir = path.join(runtimeRoot, "dist");
    await fsp.mkdir(runtimeRoot, { recursive: true });
    await fsp.writeFile(path.join(runtimeRoot, "package.json"), JSON.stringify({ type: "module" }));
    await fsp.writeFile(path.join(runtimeRoot, "asset.txt"), "runtime asset");
    await fsp.writeFile(
      entry,
      [
        `export function unchanged() {`,
        `  const asset = new URL("./asset.txt", import.meta.url);`,
        `  return fetch(asset);`,
        `}`,
        `export function direct() {`,
        `  return fetch(new URL("./asset.txt", import.meta.url));`,
        `}`,
        `export function mutated() {`,
        `  const asset = new URL("./asset.txt", import.meta.url);`,
        `  asset.href = "data:text/plain,mutated";`,
        `  return fetch(asset);`,
        `}`,
        `export function changedConstructor() {`,
        `  const asset = new URL("./asset.txt", import.meta.url);`,
        `  const OriginalURL = globalThis.URL;`,
        `  globalThis.URL = class { constructor() { throw new Error("unexpected URL construction"); } };`,
        `  try { return fetch(asset); } finally { globalThis.URL = OriginalURL; }`,
        `}`,
        `export async function reused() {`,
        `  const asset = new URL("./asset.txt", import.meta.url);`,
        `  await fetch(asset);`,
        `  return fetch(asset);`,
        `}`,
        `export function mutatedByLaterArgument() {`,
        `  const asset = new URL("./asset.txt", import.meta.url);`,
        `  return fetch(asset, (asset.href = "data:text/plain,later", {}));`,
        `}`,
        `export function beforeInitialization() {`,
        `  fetch(asset);`,
        `  const asset = new URL("./asset.txt", import.meta.url);`,
        `}`,
      ].join("\n"),
    );

    const ownership = new OgAssetOwnership();
    ownership.configure(runtimeRoot, []);
    const capability = createImportMetaUrlPlugin({
      getRoot: () => runtimeRoot,
      assetOwnership: ownership,
    });
    await build({
      root: runtimeRoot,
      configFile: false,
      logLevel: "silent",
      plugins: [capability.vitePlugin],
      build: {
        ssr: entry,
        outDir,
        rolldownOptions: { output: { entryFileNames: "entry.mjs" } },
      },
    });

    const runtime = (await import(
      `${pathToFileURL(path.join(outDir, "entry.mjs")).href}?test=${Date.now()}`
    )) as Record<string, () => Promise<unknown> | undefined>;
    const originalFetch = globalThis.fetch;
    const inputs: Array<string | URL | Request> = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      inputs.push(input);
      return new Response("ok");
    }) as typeof fetch;
    try {
      await runtime.unchanged!();
      const unchanged = inputs.pop();
      expect(unchanged).toBeInstanceOf(URL);
      expect(fetchInputUrl(unchanged)).toMatch(/^data:text\/plain/);

      await runtime.direct!();
      const direct = inputs.pop();
      expect(direct).toBeInstanceOf(URL);
      expect(fetchInputUrl(direct)).toMatch(/^data:text\/plain/);

      await runtime.mutated!();
      const mutated = inputs.pop();
      expect(mutated).toBeInstanceOf(URL);
      expect(fetchInputUrl(mutated)).toBe("data:text/plain,mutated");

      await runtime.changedConstructor!();
      const changedConstructor = inputs.pop();
      expect(changedConstructor).toBeInstanceOf(URL);
      expect(fetchInputUrl(changedConstructor)).toMatch(/^data:text\/plain/);

      await runtime.reused!();
      const reusedSecond = inputs.pop();
      const reusedFirst = inputs.pop();
      expect(reusedFirst).toBeInstanceOf(URL);
      expect(reusedSecond).toBeInstanceOf(URL);
      expect(reusedFirst).toBe(reusedSecond);
      expect(fetchInputUrl(reusedFirst)).toMatch(/^data:text\/plain/);

      await runtime.mutatedByLaterArgument!();
      const laterMutation = inputs.pop();
      expect(laterMutation).toBeInstanceOf(URL);
      expect(fetchInputUrl(laterMutation)).toBe("data:text/plain,later");

      expect(() => runtime.beforeInitialization!()).toThrow(ReferenceError);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("keeps observable query/hash semantics while embedding a fetchable data URL", async () => {
    const plugin = await createPlugin();
    const source = [
      `fetch(new URL("my-pkg/hello/world.json", import.meta.url));`,
      `fetch(new URL("../../src/text-file.txt?raw#fragment", import.meta.url));`,
      `const queried = new URL("../../src/text-file.txt?raw#fragment", import.meta.url);`,
      `const query = queried.search;`,
      `const hash = queried.hash;`,
      `fetch(queried);`,
    ].join("\n");
    const result = await transformHandler(plugin).call(
      context({ "my-pkg/hello/world.json": packageAssetPath }),
      source,
      routePath,
    );
    expect(result.code).toContain("data:application/json; charset=utf-8;base64,");
    expect(result.code).toContain("data:text/plain; charset=utf-8;base64,");
    expect(result.code).toContain(
      `const queried = new URL("../../src/text-file.txt?raw#fragment",`,
    );
    expect(result.code).toContain(`const query = queried.search;`);
    expect(result.code).toContain(`const hash = queried.hash;`);

    const embeddedUrls = [...result.code.matchAll(/("(?:\\.|[^"\\])*")/g)]
      .map((match) => JSON.parse(match[1]) as string)
      .filter((url) => url.startsWith("data:"))
      .map((url) => new URL(url));
    expect(embeddedUrls).toHaveLength(2);
    expect(embeddedUrls.every((url) => url.search === "" && url.hash === "")).toBe(true);
    const textUrl = embeddedUrls.find((url) => url.pathname.startsWith("text/plain;"));
    expect(textUrl).toBeDefined();
    const encoded = textUrl!.pathname.slice(textUrl!.pathname.indexOf(",") + 1);
    expect(Buffer.from(encoded, "base64").toString()).toBe("Hello, from text-file.txt!");
  });

  it("uses URL path decoding and static template literals for relative assets", async () => {
    const plugin = await createPlugin();
    const source = [
      "fetch(new URL(`../../src/font%20name.txt`, import.meta.url));",
      `fetch(new URL("../../src/font%23hash.txt", import.meta.url));`,
    ].join("\n");
    const result = await transformHandler(plugin).call(context(), source, routePath);

    expect(result.code).toContain(Buffer.from("encoded space").toString("base64"));
    expect(result.code).toContain(Buffer.from("encoded hash").toString("base64"));
    expect(result.code).not.toContain("import.meta.url");
  });

  it("does not rewrite a locally shadowed URL constructor", async () => {
    const plugin = await createPlugin();
    const source = `function read(URL) { return fetch(new URL("../../src/text-file.txt", import.meta.url)); }`;
    expect(await transformHandler(plugin).call(context(), source, routePath)).toBeNull();
  });

  it("does not rewrite non-fetch consumers or a locally shadowed fetch", async () => {
    const plugin = await createPlugin();
    for (const source of [
      `const url = new URL("../../src/text-file.txt", import.meta.url); console.log(url);`,
      `function read(fetch) { return fetch(new URL("../../src/text-file.txt", import.meta.url)); }`,
    ]) {
      expect(await transformHandler(plugin).call(context(), source, routePath)).toBeNull();
    }
  });

  it("supports TypeScript wrappers without scanning type-only syntax", async () => {
    const plugin = await createPlugin();
    const source = [
      `type AssetUrl = URL;`,
      `const url = new URL("../../src/text-file.txt", import.meta.url) as URL;`,
      `fetch(url as AssetUrl);`,
    ].join("\n");
    const result = await transformHandler(plugin).call(context(), source, typedRoutePath);
    expect(result.code).toContain("data:text/plain; charset=utf-8;base64,");
  });

  it("honors bundler ignore directives and leaves unsupported URLs untouched", async () => {
    const plugin = await createPlugin();
    const source = [
      `fetch(new URL(/* @vite-ignore */ "../../src/text-file.txt", import.meta.url));`,
      `fetch(new URL(/* webpackIgnore: true */ "../../src/text-file.txt", import.meta.url));`,
      `fetch(new URL(/* turbopackIgnore: true, webpackChunkName: "ignored" */ "../../src/text-file.txt", import.meta.url));`,
      `fetch(new URL(/* @vite-ignore */ /* webpackIgnore: false */ "../../src/text-file.txt", import.meta.url));`,
      String.raw`fetch(new URL(/* webpackInclude: /foo\(/, webpackIgnore: true */ "../../src/text-file.txt", import.meta.url));`,
      `fetch(new URL(/* @vite-ignore */ ("../../src/text-file.txt"), import.meta.url));`,
      `fetch(new URL(/* webpackInclude: /[(]/, webpackIgnore: true */ ("../../src/text-file.txt"), import.meta.url));`,
      `fetch(new URL(/* webpackInclude: /foo/, // note\n webpackIgnore: true */ "../../src/text-file.txt", import.meta.url));`,
      `fetch(new URL("../../src/missing.txt", import.meta.url));`,
      `fetch(new URL("https://example.com/file.txt", import.meta.url));`,
      `fetch(new URL("/src/text-file.txt", import.meta.url));`,
      `fetch(new URL("../../src/text-file.txt", import.meta.url, sideEffect()));`,
    ].join("\n");
    expect(await transformHandler(plugin).call(context(), source, routePath)).toBeNull();
  });

  it("does not synthesize ignore directives from RegExp-valued magic options", async () => {
    const plugin = await createPlugin();
    const source = `fetch(new URL(/* webpackIgnore: false, webpackInclude: /x, webpackIgnore: true, y/ */ "../../src/text-file.txt", import.meta.url));`;
    const result = await transformHandler(plugin).call(context(), source, routePath);
    expect(result.code).toContain("data:text/plain; charset=utf-8;base64,");
  });

  it("recognizes comments and escaped URL identifiers", async () => {
    const plugin = await createPlugin();
    const source = String.raw`const asset = fetch(new /* asset */ U\u0052L("../../src/text-file.txt", import.meta.url));`;
    const result = await transformHandler(plugin).call(context(), source, routePath);
    expect(result.code).toContain("data:text/plain; charset=utf-8;base64,");
  });

  it("does not read relative assets outside the owning project", async () => {
    const plugin = await createPlugin();
    const secretPath = path.join(path.dirname(root), "vinext-import-meta-secret.txt");
    await fsp.writeFile(secretPath, "secret");
    try {
      const relative = path.relative(path.dirname(routePath), secretPath).replaceAll("\\", "/");
      const source = `fetch(new URL(${JSON.stringify(relative)}, import.meta.url));`;
      expect(await transformHandler(plugin).call(context(), source, routePath)).toBeNull();
    } finally {
      await fsp.rm(secretPath, { force: true });
    }
  });

  it("fails clearly instead of silently bloating a bundle with a large fetched asset", async () => {
    const largeAsset = path.join(root, "src", "large.bin");
    await fsp.writeFile(largeAsset, Buffer.alloc(MAX_INLINE_FETCH_ASSET_BYTES + 1));
    try {
      const plugin = await createPlugin();
      const source = `fetch(new URL("../../src/large.bin", import.meta.url));`;
      await expect(transformHandler(plugin).call(context(), source, routePath)).rejects.toThrow(
        `exceeds the ${MAX_INLINE_FETCH_ASSET_BYTES} byte limit`,
      );
    } finally {
      await fsp.rm(largeAsset, { force: true });
    }
  });

  it("emits one data payload for repeated references to the same asset", async () => {
    const repeatedAsset = path.join(root, "src", "repeated.bin");
    await fsp.writeFile(repeatedAsset, "repeated payload");
    const realRepeatedAsset = await fsp.realpath(repeatedAsset);
    const readFile = vi.spyOn(fs.promises, "readFile");
    try {
      const plugin = await createPlugin();
      const source = Array.from(
        { length: 4 },
        () => `fetch(new URL("../../src/repeated.bin", import.meta.url));`,
      ).join("\n");
      const result = await transformHandler(plugin).call(context(), source, routePath);
      expect(result.code.match(/data:application\/octet-stream;base64,/g)).toHaveLength(1);
      expect(result.code.match(/new URL\(__vinext_asset_data\)/g)).toHaveLength(4);
      expect(
        readFile.mock.calls.filter(
          ([file]) => typeof file === "string" && file === realRepeatedAsset,
        ),
      ).toHaveLength(1);
    } finally {
      readFile.mockRestore();
      await fsp.rm(repeatedAsset, { force: true });
    }
  });

  it("bounds generated data URLs within one transformed module", async () => {
    const assets = Array.from({ length: 4 }, (_, index) =>
      path.join(root, "src", `module-limit-${index}.bin`),
    );
    await Promise.all(
      assets.map((asset) =>
        fsp.writeFile(asset, Buffer.alloc(Math.floor(MAX_INLINE_FETCH_ASSET_BYTES * 0.8))),
      ),
    );
    try {
      const plugin = await createPlugin();
      const source = assets
        .map(
          (_, index) => `fetch(new URL("../../src/module-limit-${index}.bin", import.meta.url));`,
        )
        .join("\n");
      await expect(transformHandler(plugin).call(context(), source, routePath)).rejects.toThrow(
        `exceeding the ${MAX_INLINE_FETCH_ASSET_MODULE_OUTPUT_BYTES} byte module limit`,
      );
    } finally {
      await Promise.all(assets.map((asset) => fsp.rm(asset, { force: true })));
    }
  });

  it("runs only in server environments", async () => {
    const plugin = await createPlugin();
    const source = `fetch(new URL("../../src/text-file.txt", import.meta.url));`;
    expect(
      await transformHandler(plugin).call(context({}, "client"), source, routePath),
    ).toBeNull();
  });
});
