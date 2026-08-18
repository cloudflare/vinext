import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Plugin } from "vite";
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

  async function createPlugin(workerTarget: boolean, command: "build" | "serve" = "build") {
    const ownership = new OgAssetOwnership();
    ownership.configure(root, []);
    const plugin = createImportMetaUrlPlugin({
      getRoot: () => root,
      assetOwnership: ownership,
      isNodelessServerTarget: () => workerTarget,
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

  it("uses the existing import-meta plugin rather than adding an asset plugin", async () => {
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

    const source = `fetch(new URL("../../src/text-file.txt", import.meta.url));`;
    const result = await transformHandler(plugin).call(context(), source, routePath);
    expect(result.code).toContain("data:text/plain; charset=utf-8;base64,");
  });

  it("replaces only a bound fetch input in a Node build", async () => {
    const plugin = await createPlugin(false);
    const source = [
      `const url = new URL("../../src/text-file.txt", import.meta.url);`,
      `const path = url.pathname;`,
      `const response = fetch(url);`,
    ].join("\n");
    const result = await transformHandler(plugin).call(context(), source, routePath);

    expect(result.code).toContain(
      `const url = new URL("../../src/text-file.txt", import.meta.url);`,
    );
    expect(result.code).toContain(`const path = url.pathname;`);
    expect(result.code).toContain(`fetch((url, new URL("data:text/plain; charset=utf-8;base64,`);
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

  it("keeps same-named bindings isolated by lexical scope", async () => {
    const plugin = await createPlugin(false);
    const source = [
      `const one = () => { const url = new URL("../../src/text-file.txt", import.meta.url); return fetch(url); };`,
      `const two = () => { const url = new URL("../../src/vercel.png", import.meta.url); return fetch(url); };`,
    ].join("\n");
    const result = await transformHandler(plugin).call(context(), source, routePath);

    expect(result.code).toContain("data:text/plain; charset=utf-8;base64,");
    expect(result.code).toContain("data:image/png;base64,");
  });

  it("rewrites the asset constructor itself for a nodeless target", async () => {
    const plugin = await createPlugin(true);
    const source = [
      `const fetched = new URL("../../src/text-file.txt", import.meta.url);`,
      `const pathname = new URL("../../src/vercel.png", import.meta?.url).pathname;`,
    ].join("\n");
    const result = await transformHandler(plugin).call(context(), source, routePath);

    expect(result.code).not.toContain("import.meta");
    expect(result.code).toContain("data:text/plain; charset=utf-8;base64,");
    expect(result.code).toContain("data:image/png;base64,");
  });

  it("keeps URL-based dynamic imports in the module graph on nodeless targets", async () => {
    const plugin = await createPlugin(true);
    const source = [
      `void import(new URL("../../src/text-file.txt", import.meta.url).href);`,
      `const asset = new URL("../../src/vercel.png", import.meta.url);`,
    ].join("\n");
    const normalized = _transformVeryDynamicRequests(source, routePath, false);
    if (!normalized) throw new Error("Expected the early dynamic URL transform to run");
    const result = await transformHandler(plugin).call(context(), normalized.code, routePath);

    expect(result.code).toContain(`import("../../src/text-file.txt")`);
    expect(result.code).toContain("data:image/png;base64,");
    expect(result.code).not.toContain("data:text/plain");
  });

  it("rewrites sequential aliases one declarator at a time", async () => {
    const plugin = await createPlugin(false);
    const source = `const url = new URL("../../src/text-file.txt", import.meta.url), response = fetch(url);`;
    const result = await transformHandler(plugin).call(context(), source, routePath);
    expect(result.code).toContain(`fetch((url, new URL("data:text/plain; charset=utf-8;base64,`);
  });

  it("does not rewrite aliases before initialization or across switch cases", async () => {
    const plugin = await createPlugin(false);
    const sources = [
      [`fetch(url);`, `const url = new URL("../../src/text-file.txt", import.meta.url);`].join(
        "\n",
      ),
      [
        `switch (kind) {`,
        `  case 1: fetch(url); break;`,
        `  case 2: const url = new URL("../../src/text-file.txt", import.meta.url); break;`,
        `}`,
      ].join("\n"),
    ];

    for (const source of sources) {
      expect(await transformHandler(plugin).call(context(), source, routePath)).toBeNull();
    }
  });

  it("preserves alias evaluation across independently invoked functions", async () => {
    const plugin = await createPlugin(false);
    const source = [
      `invoke();`,
      `const url = new URL("../../src/text-file.txt", import.meta.url);`,
      `function invoke() { return fetch(url); }`,
    ].join("\n");
    const result = await transformHandler(plugin).call(context(), source, routePath);
    expect(result.code).toContain(`fetch((url, new URL("data:text/plain; charset=utf-8;base64,`);
  });

  it("invalidates mutable or escaped URL aliases", async () => {
    const plugin = await createPlugin(false);
    const sources = [
      [
        `const url = new URL("../../src/text-file.txt", import.meta.url);`,
        `url.pathname = "/other";`,
        `fetch(url);`,
      ].join("\n"),
      [
        `const url = new URL("../../src/text-file.txt", import.meta.url);`,
        `mutate(url);`,
        `fetch(url);`,
      ].join("\n"),
      [
        `const url = new URL("../../src/text-file.txt", import.meta.url);`,
        `function read() { return fetch(url); }`,
        `function mutate() { url.pathname = "/other"; }`,
        `mutate(); read();`,
      ].join("\n"),
      [
        `const url = new URL("../../src/text-file.txt", import.meta.url);`,
        `function read() { return fetch(url); }`,
        `mutate(condition ? url : other);`,
        `read();`,
      ].join("\n"),
      [
        `const url = new URL("../../src/text-file.txt", import.meta.url);`,
        `for (;;) { fetch(url); url.pathname = "/other"; }`,
      ].join("\n"),
      [
        `function mutate() { url.pathname = "/other"; }`,
        `const url = new URL("../../src/text-file.txt", import.meta.url);`,
        `mutate(); fetch(url);`,
      ].join("\n"),
      [
        `const url = new URL("../../src/text-file.txt", import.meta.url);`,
        `[url.pathname] = ["/other"];`,
        `fetch(url);`,
      ].join("\n"),
      [
        `const url = new URL("../../src/text-file.txt", import.meta.url);`,
        `({ value: url.pathname } = source);`,
        `fetch(url);`,
      ].join("\n"),
      [
        `const url = new URL("../../src/text-file.txt", import.meta.url);`,
        `for (url.pathname of values) { fetch(url); }`,
      ].join("\n"),
      [
        `export const url = new URL("../../src/text-file.txt", import.meta.url);`,
        `export function read() { return fetch(url); }`,
      ].join("\n"),
      [
        `const url = new URL("../../src/text-file.txt", import.meta.url);`,
        `class Box { value = url; }`,
        `fetch(url);`,
      ].join("\n"),
      [
        `const url = new URL("../../src/text-file.txt", import.meta.url);`,
        `const view = <Component value={url} />;`,
        `fetch(url);`,
      ].join("\n"),
      [
        `const url = new URL("../../src/text-file.txt", import.meta.url);`,
        `function fileURLToPath(value) { value.pathname = "/other"; }`,
        `fileURLToPath(url);`,
        `fetch(url);`,
      ].join("\n"),
    ];

    for (const source of sources) {
      expect(await transformHandler(plugin).call(context(), source, routePath)).toBeNull();
    }
  });

  it.each([
    [`import { fileURLToPath as toPath } from "node:url";`, `toPath(url);`],
    [`import { fileURLToPath as toPath } from "url";`, `toPath(url);`],
    [`import * as nodeUrl from "node:url";`, `nodeUrl.fileURLToPath(url);`],
    [`import * as nodeUrl from "url";`, `nodeUrl.fileURLToPath(url);`],
  ])("trusts proven node:url consumers", async (importStatement, consume) => {
    const plugin = await createPlugin(false);
    const source = [
      importStatement,
      `const url = new URL("../../src/text-file.txt", import.meta.url);`,
      consume,
      `fetch(url);`,
    ].join("\n");
    const result = await transformHandler(plugin).call(context(), source, routePath);
    expect(result.code).toContain(`fetch((url, new URL("data:text/plain; charset=utf-8;base64,`);
  });

  it("keeps syntax-only names and read-only observations from invalidating aliases", async () => {
    const plugin = await createPlugin(false);
    const source = [
      `const url = new URL("../../src/text-file.txt", import.meta.url);`,
      `const metadata = { url: "not the asset" };`,
      `if (!url || url === metadata) throw new Error();`,
      `void url;`,
      `fetch(url);`,
    ].join("\n");
    const result = await transformHandler(plugin).call(context(), source, routePath);
    expect(result.code).toContain(`fetch((url, new URL("data:text/plain; charset=utf-8;base64,`);
  });

  it("invalidates coercive and user-code binary observations", async () => {
    const plugin = await createPlugin(false);
    const source = [
      `const url = new URL("../../src/text-file.txt", import.meta.url);`,
      `class Mutator {`,
      `  static [Symbol.hasInstance](value) { value.pathname = "/other"; return true; }`,
      `}`,
      `void (url instanceof Mutator);`,
      `fetch(url);`,
    ].join("\n");
    expect(await transformHandler(plugin).call(context(), source, routePath)).toBeNull();
  });

  it("ignores TypeScript type-only names when tracking aliases", async () => {
    const plugin = await createPlugin(false);
    const source = [
      `type Metadata = { url: string };`,
      `const url = new URL("../../src/text-file.txt", import.meta.url);`,
      `const metadata: Metadata = { url: "not the asset" };`,
      `void metadata;`,
      `fetch(url);`,
    ].join("\n");
    const result = await transformHandler(plugin).call(context(), source, typedRoutePath);
    expect(result.code).toContain(`fetch((url, new URL("data:text/plain; charset=utf-8;base64,`);
  });

  it.each([
    `const url = new URL("../../src/text-file.txt", import.meta.url) as URL; fetch(url);`,
    `const url = new URL("../../src/text-file.txt", import.meta.url); fetch(url as URL);`,
    `fetch(new URL("../../src/text-file.txt", import.meta.url) satisfies URL);`,
  ])("rewrites TypeScript-wrapped asset expressions", async (source) => {
    const plugin = await createPlugin(false);
    const result = await transformHandler(plugin).call(context(), source, typedRoutePath);
    expect(result.code).toContain("data:text/plain; charset=utf-8;base64,");
  });

  it("tracks runtime references inside TypeScript enums and namespaces", async () => {
    const plugin = await createPlugin(false);
    const sources = [
      [
        `const url = new URL("../../src/text-file.txt", import.meta.url);`,
        `enum Values { Current = mutate(url) as any }`,
        `fetch(url);`,
      ].join("\n"),
      [
        `const url = new URL("../../src/text-file.txt", import.meta.url);`,
        `namespace Values { export const current = mutate(url); }`,
        `fetch(url);`,
      ].join("\n"),
    ];
    for (const source of sources) {
      expect(await transformHandler(plugin).call(context(), source, typedRoutePath)).toBeNull();
    }
  });

  it("ignores same-named type-only exports", async () => {
    const plugin = await createPlugin(false);
    const source = [
      `type url = string;`,
      `const url = new URL("../../src/text-file.txt", import.meta.url);`,
      `export type { url };`,
      `fetch(url);`,
    ].join("\n");
    const result = await transformHandler(plugin).call(context(), source, typedRoutePath);
    expect(result.code).toContain("data:text/plain; charset=utf-8;base64,");
  });

  it("resolves a bare node_modules asset through the bundler", async () => {
    const plugin = await createPlugin(false);
    const source = `function handler() { return fetch(new URL("my-pkg/hello/world.json", import.meta.url)); }`;
    const result = await transformHandler(plugin).call(
      context({ "my-pkg/hello/world.json": packageAssetPath }),
      source,
      routePath,
    );

    expect(result.code).toContain("data:application/json; charset=utf-8;base64,");
    expect(result.code).toContain(
      Buffer.from('{ "i am": "a node dependency" }').toString("base64"),
    );
  });

  it("strips query and hash suffixes before reading a relative asset", async () => {
    const plugin = await createPlugin(false);
    const source = `fetch(new URL("../../src/text-file.txt?raw#fragment", import.meta.url));`;
    const result = await transformHandler(plugin).call(context(), source, routePath);
    expect(result.code).toContain("data:text/plain; charset=utf-8;base64,");
  });

  it("does not rewrite non-fetch Node consumers", async () => {
    const plugin = await createPlugin(false);
    const source = [
      `const url = new URL("../../src/text-file.txt", import.meta.url);`,
      `const file = fileURLToPath(url);`,
      `const pathname = url.pathname;`,
    ].join("\n");
    const result = await transformHandler(plugin).call(context(), source, routePath);
    expect(result).toBeNull();
  });

  it("does not rewrite calls to a shadowed fetch binding", async () => {
    const plugin = await createPlugin(false);
    const source = `function read(fetch) { return fetch(new URL("../../src/text-file.txt", import.meta.url)); }`;
    const result = await transformHandler(plugin).call(context(), source, routePath);
    expect(result).toBeNull();
  });

  it.each([true, false])(
    "does not rewrite constructors using a shadowed URL binding (nodeless=%s)",
    async (nodelessTarget) => {
      const plugin = await createPlugin(nodelessTarget);
      const source = `function read(URL) { return fetch(new URL("../../src/text-file.txt", import.meta.url)); }`;
      const result = await transformHandler(plugin).call(context(), source, routePath);
      expect(result).toBeNull();
    },
  );

  it("honors @vite-ignore and leaves missing or remote URLs untouched", async () => {
    const plugin = await createPlugin(true);
    const source = [
      `const ignored = new URL(/* @vite-ignore */ "../../src/text-file.txt", import.meta.url);`,
      `const missing = new URL("../../src/missing.txt", import.meta.url);`,
      `const remote = new URL("https://example.com/file.txt", import.meta.url);`,
    ].join("\n");
    const result = await transformHandler(plugin).call(context(), source, routePath);
    expect(result).toBeNull();
  });

  it("leaves current-module URL references out of asset resolution", async () => {
    const plugin = await createPlugin(true);
    const pluginContext = context();
    pluginContext.resolve = async () => {
      throw new Error("current-module references must not be resolved as assets");
    };
    const source = [
      `new URL("", import.meta.url);`,
      `new URL("?raw", import.meta.url);`,
      `new URL("#section", import.meta.url);`,
    ].join("\n");

    expect(await transformHandler(plugin).call(pluginContext, source, routePath)).toBeNull();
  });

  it("leaves root-relative and invalid three-argument URL constructors untouched", async () => {
    const plugin = await createPlugin(true);
    const source = [
      `const rootRelative = new URL("/src/text-file.txt", import.meta.url);`,
      `const invalid = new URL("../../src/text-file.txt", import.meta.url, sideEffect());`,
    ].join("\n");
    const result = await transformHandler(plugin).call(context(), source, routePath);
    expect(result).toBeNull();
  });

  it("recognizes comments between new and URL", async () => {
    const plugin = await createPlugin(true);
    const source = `const asset = new /* asset */ URL("../../src/text-file.txt", import.meta.url);`;
    const result = await transformHandler(plugin).call(context(), source, routePath);
    expect(result.code).toContain("data:text/plain; charset=utf-8;base64,");
  });

  it("does not read relative assets outside the owning project", async () => {
    const plugin = await createPlugin(true);
    const secretPath = path.join(path.dirname(root), "vinext-import-meta-secret.txt");
    await fsp.writeFile(secretPath, "secret");
    try {
      const relative = path.relative(path.dirname(routePath), secretPath).replaceAll("\\", "/");
      const source = `const leaked = new URL(${JSON.stringify(relative)}, import.meta.url);`;
      const result = await transformHandler(plugin).call(context(), source, routePath);
      expect(result).toBeNull();
    } finally {
      await fsp.rm(secretPath, { force: true });
    }
  });

  it("does not run the asset phase in client environments", async () => {
    const plugin = await createPlugin(true);
    const source = `new URL("../../src/text-file.txt", import.meta.url);`;
    const result = await transformHandler(plugin).call(context({}, "client"), source, routePath);
    expect(result).toBeNull();
  });
});
