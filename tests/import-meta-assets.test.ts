import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build, type Plugin } from "vite";
import { _transformVeryDynamicRequests } from "../packages/vinext/src/plugins/ignore-dynamic-requests.js";
import { createImportMetaUrlPlugin } from "../packages/vinext/src/plugins/import-meta-url.js";
import { createOgInlineFetchAssetsPlugin } from "../packages/vinext/src/plugins/og-assets.js";
import { OgAssetOwnership } from "../packages/vinext/src/plugins/og-asset-ownership.js";

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
    await fsp.writeFile(path.join(root, "src", "vercel.png"), Buffer.from([0x89, 0x50, 0x4e]));
    await fsp.writeFile(packageAssetPath, '{ "i am": "a node dependency" }');
  });

  afterAll(async () => {
    if (root) await fsp.rm(root, { recursive: true, force: true });
  });

  async function createPlugin(nodelessTarget: boolean, command: "build" | "serve" = "build") {
    const ownership = new OgAssetOwnership();
    ownership.configure(root, []);
    const plugin = createImportMetaUrlPlugin({
      getRoot: () => root,
      assetOwnership: ownership,
      isNodelessServerTarget: () => nodelessTarget,
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

  it("uses the existing import-meta plugin and shared ownership tracker", async () => {
    const ownership = new OgAssetOwnership();
    const configure = vi.spyOn(ownership, "configure");
    const reset = vi.spyOn(ownership, "reset");
    const ogPlugin = createOgInlineFetchAssetsPlugin(ownership);
    const plugin = createImportMetaUrlPlugin({
      getRoot: () => root,
      assetOwnership: ownership,
      isNodelessServerTarget: () => true,
    }).vitePlugin;
    const config = {
      command: "build",
      root,
      resolve: { alias: [] },
      environments: {},
      build: { outDir: "dist" },
    };

    await hookHandler(ogPlugin.configResolved).call(null, config);
    await hookHandler(plugin.configResolved).call(null, config);
    await hookHandler(ogPlugin.buildStart).call(null);
    await hookHandler(plugin.buildStart).call(null);

    expect(plugin.name).toBe("vinext:import-meta-url");
    expect(plugin.resolveId).toBeUndefined();
    expect(configure).toHaveBeenCalledOnce();
    expect(reset).toHaveBeenCalledOnce();
  });

  it("replaces only the fetch input in a Node build", async () => {
    const plugin = await createPlugin(false);
    const source = [
      `import { fileURLToPath } from "node:url";`,
      `const url = new URL("../../src/text-file.txt", import.meta.url);`,
      `const path = url.pathname;`,
      `const file = fileURLToPath(url);`,
      `const response = fetch(url);`,
    ].join("\n");
    const result = await transformHandler(plugin).call(context(), source, routePath);

    expect(result.code).toContain(
      `const url = new URL("../../src/text-file.txt", import.meta.url), __vinext_asset_url = new URL("data:text/plain; charset=utf-8;base64,`,
    );
    expect(result.code).toContain(`const path = url.pathname;`);
    expect(result.code).toContain(`const file = fileURLToPath(url);`);
    expect(result.code).toContain(`fetch(__vinext_asset_url)`);
  });

  it("replaces a direct fetch input in a Node build", async () => {
    const plugin = await createPlugin(false);
    const source = `function handler() { return fetch(new URL("../../src/text-file.txt", import.meta.url)); }`;
    const result = await transformHandler(plugin).call(context(), source, routePath);
    expect(result.code).toContain(`fetch(new URL("data:text/plain; charset=utf-8;base64,`);
    expect(result.code).not.toContain("import.meta.url");
  });

  it("watches every embedded asset", async () => {
    const plugin = await createPlugin(false);
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

  it("keeps same-named aliases isolated by lexical scope", async () => {
    const plugin = await createPlugin(false);
    const source = [
      `const one = () => { const url = new URL("../../src/text-file.txt", import.meta.url); return fetch(url); };`,
      `const two = () => { const url = new URL("../../src/vercel.png", import.meta.url); return fetch(url); };`,
    ].join("\n");
    const result = await transformHandler(plugin).call(context(), source, routePath);
    expect(result.code).toContain("data:text/plain; charset=utf-8;base64,");
    expect(result.code).toContain("data:image/png;base64,");
  });

  it("passes mutated, escaped, or exported aliases through at runtime", async () => {
    const plugin = await createPlugin(false);
    for (const use of [
      `url.pathname = "/other";`,
      `mutate(url);`,
      `target[mutate(url)] = value;`,
      `for (url.pathname of values) {}`,
      `for ({ value: url.pathname } of values) {}`,
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
    const plugin = await createPlugin(false);
    const source = [
      `fetch(url);`,
      `const url = new URL("../../src/text-file.txt", import.meta.url);`,
    ].join("\n");
    const result = await transformHandler(plugin).call(context(), source, routePath);
    expect(result.code).toContain(`fetch(__vinext_asset_url)`);
  });

  it("does not reuse aliases across switch cases", async () => {
    const plugin = await createPlugin(false);
    const source = [
      `switch (kind) {`,
      `  case 1: fetch(url); break;`,
      `  case 2: const url = new URL("../../src/text-file.txt", import.meta.url); break;`,
      `}`,
    ].join("\n");
    expect(await transformHandler(plugin).call(context(), source, routePath)).toBeNull();
  });

  it("tracks side effects in dynamic-import options without rewriting the specifier", async () => {
    const plugin = await createPlugin(false);
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
    const plugin = await createPlugin(false);
    const source = [
      `import { url as other } from "./other";`,
      `const url = new URL("../../src/text-file.txt", import.meta.url);`,
      `type Snapshot = typeof url;`,
      `const object = { url: other };`,
      `urlLabel: { break urlLabel; }`,
      `export { url } from "./other";`,
      `fetch(url);`,
    ].join("\n");
    const result = await transformHandler(plugin).call(context(), source, typedRoutePath);
    expect(result.code).toContain(`fetch(__vinext_asset_url)`);
  });

  it("rewrites the constructor itself for nodeless targets", async () => {
    const plugin = await createPlugin(true);
    const source = [
      `const text = new URL("../../src/text-file.txt", import.meta.url);`,
      `const image = new URL("../../src/vercel.png", import.meta?.url);`,
    ].join("\n");
    const result = await transformHandler(plugin).call(context(), source, routePath);
    expect(result.code).not.toContain("import.meta");
    expect(result.code).toContain("data:text/plain; charset=utf-8;base64,");
    expect(result.code).toContain("data:image/png;base64,");
  });

  it("rewrites nodeless assets in default parameter initializers", async () => {
    const plugin = await createPlugin(true);
    const source = `function read(asset = new URL("../../src/text-file.txt", import.meta.url)) { return asset; }`;
    const result = await transformHandler(plugin).call(context(), source, routePath);
    expect(result.code).toContain("data:text/plain; charset=utf-8;base64,");
  });

  it("keeps URL-based dynamic imports in the module graph", async () => {
    const plugin = await createPlugin(true);
    const source = [
      `void import(new URL("../../src/text-file.txt", import.meta.url).href);`,
      `const asset = new URL("../../src/vercel.png", import.meta.url);`,
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
    const plugin = await createPlugin(true);
    expect(await transformHandler(plugin).call(context(), source, routePath)).toBeNull();
  });

  it("constructs the replacement beside the alias before a fetch-time URL shadow", async () => {
    const plugin = await createPlugin(false);
    const source = [
      `const asset = new URL("../../src/text-file.txt", import.meta.url);`,
      `function read(URL) { return fetch(asset); }`,
    ].join("\n");
    const result = await transformHandler(plugin).call(context(), source, routePath);
    expect(result.code).toContain(
      `const asset = new URL("../../src/text-file.txt", import.meta.url), __vinext_asset_url = new URL("data:text/plain;`,
    );
    expect(result.code).toContain(`function read(URL) { return fetch(__vinext_asset_url); }`);
  });

  it("keeps directives intact and avoids decoded identifier collisions", async () => {
    const plugin = await createPlugin(false);
    const source = [
      `"use server";`,
      `const __vinext_asset_\\u0075rl = "user";`,
      `const asset = new URL("../../src/text-file.txt", import.meta.url);`,
      `function read(__vinext_asset_url_) { return fetch(asset); }`,
    ].join("\n");
    const result = await transformHandler(plugin).call(context(), source, routePath);
    expect(result.code).toContain(
      `const asset = new URL("../../src/text-file.txt", import.meta.url), __vinext_asset_url__ = new URL("data:text/plain;`,
    );
    expect(result.code).toContain(`"use server";`);
    expect(result.code).toContain(`const __vinext_asset_\\u0075rl = "user";`);
  });

  it("does not depend on the global WeakMap constructor", async () => {
    const plugin = await createPlugin(false);
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
      isNodelessServerTarget: () => false,
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

  it("resolves package assets and strips query/hash suffixes", async () => {
    const plugin = await createPlugin(false);
    const source = [
      `fetch(new URL("my-pkg/hello/world.json", import.meta.url));`,
      `fetch(new URL("../../src/text-file.txt?raw#fragment", import.meta.url));`,
    ].join("\n");
    const result = await transformHandler(plugin).call(
      context({ "my-pkg/hello/world.json": packageAssetPath }),
      source,
      routePath,
    );
    expect(result.code).toContain("data:application/json; charset=utf-8;base64,");
    expect(result.code).toContain("data:text/plain; charset=utf-8;base64,");
  });

  it.each([true, false])(
    "does not rewrite a locally shadowed URL constructor (nodeless=%s)",
    async (nodelessTarget) => {
      const plugin = await createPlugin(nodelessTarget);
      const source = `function read(URL) { return fetch(new URL("../../src/text-file.txt", import.meta.url)); }`;
      expect(await transformHandler(plugin).call(context(), source, routePath)).toBeNull();
    },
  );

  it("does not rewrite non-fetch consumers or a locally shadowed fetch", async () => {
    const plugin = await createPlugin(false);
    for (const source of [
      `const url = new URL("../../src/text-file.txt", import.meta.url); console.log(url);`,
      `function read(fetch) { return fetch(new URL("../../src/text-file.txt", import.meta.url)); }`,
    ]) {
      expect(await transformHandler(plugin).call(context(), source, routePath)).toBeNull();
    }
  });

  it("supports TypeScript wrappers without scanning type-only syntax", async () => {
    const plugin = await createPlugin(false);
    const source = [
      `type AssetUrl = URL;`,
      `const url = new URL("../../src/text-file.txt", import.meta.url) as URL;`,
      `fetch(url as AssetUrl);`,
    ].join("\n");
    const result = await transformHandler(plugin).call(context(), source, typedRoutePath);
    expect(result.code).toContain("data:text/plain; charset=utf-8;base64,");
  });

  it("honors @vite-ignore and leaves unsupported URLs untouched", async () => {
    const plugin = await createPlugin(true);
    const source = [
      `new URL(/* @vite-ignore */ "../../src/text-file.txt", import.meta.url);`,
      `new URL("../../src/missing.txt", import.meta.url);`,
      `new URL("https://example.com/file.txt", import.meta.url);`,
      `new URL("/src/text-file.txt", import.meta.url);`,
      `new URL("../../src/text-file.txt", import.meta.url, sideEffect());`,
    ].join("\n");
    expect(await transformHandler(plugin).call(context(), source, routePath)).toBeNull();
  });

  it("recognizes comments and escaped URL identifiers", async () => {
    const plugin = await createPlugin(true);
    const source = String.raw`const asset = new /* asset */ U\u0052L("../../src/text-file.txt", import.meta.url);`;
    const result = await transformHandler(plugin).call(context(), source, routePath);
    expect(result.code).toContain("data:text/plain; charset=utf-8;base64,");
  });

  it("does not read relative assets outside the owning project", async () => {
    const plugin = await createPlugin(true);
    const secretPath = path.join(path.dirname(root), "vinext-import-meta-secret.txt");
    await fsp.writeFile(secretPath, "secret");
    try {
      const relative = path.relative(path.dirname(routePath), secretPath).replaceAll("\\", "/");
      const source = `new URL(${JSON.stringify(relative)}, import.meta.url);`;
      expect(await transformHandler(plugin).call(context(), source, routePath)).toBeNull();
    } finally {
      await fsp.rm(secretPath, { force: true });
    }
  });

  it("runs only in server environments", async () => {
    const plugin = await createPlugin(true);
    const source = `new URL("../../src/text-file.txt", import.meta.url);`;
    expect(
      await transformHandler(plugin).call(context({}, "client"), source, routePath),
    ).toBeNull();
  });
});
