import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Plugin } from "vite";
import { createAssetImportMetaUrlPlugin } from "../packages/vinext/src/plugins/asset-import-meta-url.js";
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

describe("vinext:asset-import-meta-url", () => {
  let root: string;
  let routePath: string;
  let packageAssetPath: string;

  beforeAll(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "vinext-asset-import-meta-url-"));
    routePath = path.join(root, "pages", "api", "edge.js");
    packageAssetPath = path.join(root, "node_modules", "my-pkg", "hello", "world.json");
    await fsp.mkdir(path.dirname(routePath), { recursive: true });
    await fsp.mkdir(path.join(root, "src"), { recursive: true });
    await fsp.mkdir(path.dirname(packageAssetPath), { recursive: true });
    await fsp.writeFile(path.join(root, "package.json"), JSON.stringify({ type: "module" }));
    await fsp.writeFile(routePath, "export default function handler() {}\n");
    await fsp.writeFile(path.join(root, "src", "text-file.txt"), "Hello, from text-file.txt!");
    await fsp.writeFile(path.join(root, "src", "vercel.png"), Buffer.from([0x89, 0x50, 0x4e]));
    await fsp.writeFile(packageAssetPath, '{ "i am": "a node dependency" }');
  });

  afterAll(async () => {
    if (root) await fsp.rm(root, { recursive: true, force: true });
  });

  async function createPlugin(workerTarget: boolean, command: "build" | "serve" = "build") {
    const plugin = createAssetImportMetaUrlPlugin({ isWorkerTarget: () => workerTarget });
    await hookHandler(plugin.configResolved).call(null, {
      command,
      root,
      resolve: { alias: [] },
    });
    await hookHandler(plugin.buildStart).call(null);
    return plugin;
  }

  function context(resolveMap: Record<string, string> = {}) {
    const watchedFiles: string[] = [];
    return {
      watchedFiles,
      environment: { name: "ssr", config: { consumer: "server" } },
      addWatchFile(file: string) {
        watchedFiles.push(file);
      },
      async resolve(specifier: string) {
        const id = resolveMap[specifier];
        return id ? { id } : null;
      },
    };
  }

  it("replaces only a bound fetch input in a plain Node build", async () => {
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
    expect(result.code).toContain(`fetch(new URL("data:text/plain; charset=utf-8;base64,`);
  });

  it("watches every asset embedded by the transform", async () => {
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

  it("shares ownership tracking without installing a second resolver pass", async () => {
    const ownership = new OgAssetOwnership();
    const configure = vi.spyOn(ownership, "configure");
    const reset = vi.spyOn(ownership, "reset");
    const ogPlugin = createOgInlineFetchAssetsPlugin(ownership);
    const plugin = createAssetImportMetaUrlPlugin({
      isWorkerTarget: () => false,
      ownership,
    });
    const config = { command: "build", root, resolve: { alias: [] } };

    await hookHandler(ogPlugin.configResolved).call(null, config);
    await hookHandler(plugin.configResolved).call(null, config);
    await hookHandler(ogPlugin.buildStart).call(null);
    await hookHandler(plugin.buildStart).call(null);

    expect(configure).toHaveBeenCalledOnce();
    expect(reset).toHaveBeenCalledOnce();
    expect(ogPlugin.resolveId).toBeTypeOf("function");
    expect(plugin.resolveId).toBeUndefined();

    const source = `fetch(new URL("../../src/text-file.txt", import.meta.url));`;
    const result = await transformHandler(plugin).call(context(), source, routePath);
    expect(result.code).toContain("data:text/plain; charset=utf-8;base64,");
  });

  it("replaces a direct fetch input in a plain Node build", async () => {
    const plugin = await createPlugin(false);
    const source = `function handler() { return fetch(new URL("../../src/text-file.txt", import.meta.url)); }`;
    const result = await transformHandler(plugin).call(context(), source, routePath);

    expect(result.code).toContain(`fetch(new URL("data:text/plain; charset=utf-8;base64,`);
    expect(result.code).not.toContain("import.meta.url");
  });

  it("keeps same-named bindings isolated by lexical scope", async () => {
    const plugin = await createPlugin(false);
    const source = [
      `const one = () => {`,
      `  const url = new URL("../../src/text-file.txt", import.meta.url);`,
      `  return fetch(url);`,
      `};`,
      `const two = () => {`,
      `  const url = new URL("../../src/vercel.png", import.meta.url);`,
      `  return fetch(url);`,
      `};`,
    ].join("\n");
    const result = await transformHandler(plugin).call(context(), source, routePath);

    expect(result.code).toContain("data:text/plain; charset=utf-8;base64,");
    expect(result.code).toContain("data:image/png;base64,");
  });

  it("rewrites the asset constructor itself in a worker build", async () => {
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

  it("resolves a bare node_modules asset through the bundler", async () => {
    const plugin = await createPlugin(false);
    const source = [
      `function handler() {`,
      `  const url = new URL("my-pkg/hello/world.json", import.meta.url);`,
      `  return fetch(url);`,
      `}`,
    ].join("\n");
    const result = await transformHandler(plugin).call(
      context({ "my-pkg/hello/world.json": packageAssetPath }),
      source,
      routePath,
    );

    expect(result.code).toContain("data:application/json; charset=utf-8;base64,");
    const encoded = Buffer.from('{ "i am": "a node dependency" }').toString("base64");
    expect(result.code).toContain(encoded);
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
    const source = [
      `function read(fetch) {`,
      `  const url = new URL("../../src/text-file.txt", import.meta.url);`,
      `  return fetch(url);`,
      `}`,
    ].join("\n");
    const result = await transformHandler(plugin).call(context(), source, routePath);

    expect(result).toBeNull();
  });

  it.each([true, false])(
    "does not rewrite constructors using a shadowed URL binding (worker=%s)",
    async (workerTarget) => {
      const plugin = await createPlugin(workerTarget);
      const source = [
        `function read(URL) {`,
        `  return fetch(new URL("../../src/text-file.txt", import.meta.url));`,
        `}`,
      ].join("\n");
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

  it("does not read relative assets outside the owning project", async () => {
    const plugin = await createPlugin(true);
    const secretPath = path.join(path.dirname(root), "vinext-asset-import-secret.txt");
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

  it("runs only in non-client environments", async () => {
    const plugin = await createPlugin(false);
    const apply = plugin.applyToEnvironment as (environment: any) => boolean;
    expect(apply({ config: { consumer: "server" } })).toBe(true);
    expect(apply({ config: { consumer: "client" } })).toBe(false);
  });
});
