/**
 * Tests the vinext user-land server function directive integration used for function-level
 * "use cache" directives. Vinext owns the directive plugin while plugin-rsc
 * provides directive transforms and aggregates independently owned server
 * reference claims.
 */
import path from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vite-plus/test";
import { parseAst, type Plugin } from "vite";
import vinext from "../packages/vinext/src/index.js";
import { APP_FIXTURE_DIR, RSC_ENTRIES } from "./helpers.js";

// oxlint-disable-next-line typescript/no-explicit-any
function unwrapHook(hook: any): ((...args: any[]) => any) | undefined {
  return typeof hook === "function" ? hook : hook?.handler;
}

async function getPlugins(options: { manualRsc?: boolean } = {}): Promise<Plugin[]> {
  // oxlint-disable-next-line typescript/no-explicit-any
  const rawPlugins = (
    vinext({ appDir: APP_FIXTURE_DIR, rsc: options.manualRsc ? false : undefined }) as any[]
  ).flat(Infinity);
  if (options.manualRsc) {
    const rsc = (await import("@vitejs/plugin-rsc")).default;
    rawPlugins.push(rsc({ entries: RSC_ENTRIES }));
  }
  const resolved = await Promise.all(rawPlugins.map((plugin) => Promise.resolve(plugin)));
  return resolved.flat(Infinity).filter(Boolean) as Plugin[];
}

const moduleId = path.join(APP_FIXTURE_DIR, "app", "unit-test-inline-cache.tsx");
const inlineCacheCode = [
  `export async function getData() {`,
  `  "use cache";`,
  `  return 1;`,
  `}`,
].join("\n");
const fileCacheCode = [
  `"use cache";`,
  `export async function getData() {`,
  `  return 1;`,
  `}`,
].join("\n");

async function configurePluginRsc(plugins: Plugin[]) {
  const minimal = plugins.find((plugin) => plugin.name === "rsc:minimal")!;
  const configResolved = unwrapHook(minimal.configResolved)!;
  configResolved.call(minimal, {
    root: APP_FIXTURE_DIR,
    command: "build",
    environments: {
      rsc: { build: { outDir: path.join(APP_FIXTURE_DIR, "dist/rsc") } },
    },
  });
  const useCachePlugin = plugins.find(
    (plugin) => plugin.name === "vinext:server-function-directives",
  )!;
  unwrapHook(useCachePlugin.configResolved)!.call(useCachePlugin, { plugins });
  // oxlint-disable-next-line typescript/no-explicit-any
  return (minimal as any).api.manager;
}

async function configureVinext(plugins: Plugin[]) {
  const configPlugin = plugins.find((plugin) => plugin.name === "vinext:config")!;
  await unwrapHook(configPlugin.config)!.call(
    configPlugin,
    { root: APP_FIXTURE_DIR },
    { command: "build", mode: "test" },
  );
}

async function transformRsc(source: string): Promise<string> {
  const plugins = await getPlugins();
  await configurePluginRsc(plugins);
  const plugin = plugins.find(
    (candidate) => candidate.name === "vinext:server-function-directives",
  )!;
  const result = await unwrapHook(plugin.transform)!.call(
    { environment: { name: "rsc", mode: "build" } },
    source,
    moduleId,
  );
  return result!.code;
}

describe("plugin-rsc inline use-cache references", () => {
  it("supports an explicitly registered RSC plugin", async () => {
    const plugins = await getPlugins({ manualRsc: true });
    const manager = await configurePluginRsc(plugins);
    const useCacheIndex = plugins.findIndex(
      (candidate) => candidate.name === "vinext:server-function-directives",
    );
    const useServerIndex = plugins.findIndex((candidate) => candidate.name === "rsc:use-server");
    expect(useCacheIndex).toBeGreaterThanOrEqual(0);
    expect(useCacheIndex).toBeLessThan(useServerIndex);

    const transformed = await unwrapHook(plugins[useCacheIndex]!.transform)!.call(
      { environment: { name: "rsc", mode: "build" } },
      inlineCacheCode,
      moduleId,
    );
    expect(transformed!.code).toContain("registerCachedFunction");
    expect(manager.serverReferences.metaMap.get(moduleId)).toBeDefined();
  });

  it("keeps the vinext claim through the built-in use-server transform", async () => {
    const plugins = await getPlugins();
    const manager = await configurePluginRsc(plugins);
    const useCacheIndex = plugins.findIndex(
      (candidate) => candidate.name === "vinext:server-function-directives",
    );
    const useServerIndex = plugins.findIndex((candidate) => candidate.name === "rsc:use-server");
    expect(useCacheIndex).toBeLessThan(useServerIndex);

    const context = { environment: { name: "rsc", mode: "build" } };
    const transformed = await unwrapHook(plugins[useCacheIndex]!.transform)!.call(
      context,
      inlineCacheCode,
      moduleId,
    );
    expect(manager.serverReferences.metaMap.get(moduleId)).toBeDefined();

    await unwrapHook(plugins[useServerIndex]!.transform)!.call(
      context,
      transformed!.code,
      moduleId,
    );
    expect(manager.serverReferences.metaMap.get(moduleId)).toBeDefined();

    const ssrContext = { environment: { name: "ssr", mode: "build" } };
    const proxied = await unwrapHook(plugins[useCacheIndex]!.transform)!.call(
      ssrContext,
      fileCacheCode,
      moduleId,
    );
    await unwrapHook(plugins[useServerIndex]!.transform)!.call(ssrContext, proxied!.code, moduleId);
    expect(manager.serverReferences.metaMap.get(moduleId)).toMatchObject({
      importId: moduleId,
      exportNames: expect.arrayContaining(["getData"]),
    });
  });

  it("aggregates use-server and vinext claims", async () => {
    const plugins = await getPlugins();
    const manager = await configurePluginRsc(plugins);
    const useCachePlugin = plugins.find(
      (candidate) => candidate.name === "vinext:server-function-directives",
    )!;
    const useServerPlugin = plugins.find((candidate) => candidate.name === "rsc:use-server")!;
    const context = { environment: { name: "rsc", mode: "build" } };
    const source = [
      `export async function action() {`,
      `  "use server";`,
      `}`,
      `export async function getData() {`,
      `  "use cache";`,
      `  return 1;`,
      `}`,
    ].join("\n");

    const useCacheResult = await unwrapHook(useCachePlugin.transform)!.call(
      context,
      source,
      moduleId,
    );
    const useServerResult = await unwrapHook(useServerPlugin.transform)!.call(
      context,
      useCacheResult!.code,
      moduleId,
    );
    expect(useServerResult!.code).toContain("$$VinextReactServer.registerServerReference");
    expect(() => parseAst(useServerResult!.code)).not.toThrow();
    const claims = manager.serverReferences.claimMap.get(moduleId);
    expect([...claims.keys()]).toEqual(["vinext:server-function-directives", "rsc:use-server"]);

    const merged = manager.serverReferences.metaMap.get(moduleId)!;
    expect(merged.importId).toBe(moduleId);
    expect(merged.exportNames).toContainEqual(expect.stringMatching(/action/));
    expect(merged.exportNames).toContainEqual(expect.stringMatching(/getData/));
    expect(merged.exportNames).toHaveLength(new Set(merged.exportNames).size);
  });

  it("removes the vinext claim when the directive is removed", async () => {
    const plugins = await getPlugins();
    const manager = await configurePluginRsc(plugins);
    const useCachePlugin = plugins.find(
      (candidate) => candidate.name === "vinext:server-function-directives",
    )!;
    const rscContext = { environment: { name: "rsc", mode: "build" } };
    const ssrContext = { environment: { name: "ssr", mode: "build" } };

    await unwrapHook(useCachePlugin.transform)!.call(rscContext, fileCacheCode, moduleId);
    await unwrapHook(useCachePlugin.transform)!.call(ssrContext, fileCacheCode, moduleId);
    expect(manager.serverReferences.metaMap.get(moduleId)).toBeDefined();

    const source = `export async function getData() { return 1; }`;
    await unwrapHook(useCachePlugin.transform)!.call(rscContext, source, moduleId);
    await unwrapHook(useCachePlugin.transform)!.call(ssrContext, source, moduleId);
    expect(manager.serverReferences.metaMap.get(moduleId)).toBeUndefined();
  });

  it("hands a file-level reference between vinext and rsc:use-server", async () => {
    const plugins = await getPlugins();
    const manager = await configurePluginRsc(plugins);
    const useCachePlugin = plugins.find(
      (candidate) => candidate.name === "vinext:server-function-directives",
    )!;
    const useServerPlugin = plugins.find((candidate) => candidate.name === "rsc:use-server")!;
    const context = { environment: { name: "rsc", mode: "build" } };
    const useServerCode = [
      `"use server";`,
      `export async function getData() {`,
      `  return 1;`,
      `}`,
    ].join("\n");

    const transform = async (source: string) => {
      const useCacheResult = await unwrapHook(useCachePlugin.transform)!.call(
        context,
        source,
        moduleId,
      );
      await unwrapHook(useServerPlugin.transform)!.call(
        context,
        useCacheResult?.code ?? source,
        moduleId,
      );
    };

    await transform(fileCacheCode);
    expect([...manager.serverReferences.claimMap.get(moduleId).keys()]).toEqual([
      "vinext:server-function-directives",
    ]);

    await transform(useServerCode);
    expect([...manager.serverReferences.claimMap.get(moduleId).keys()]).toEqual(["rsc:use-server"]);

    await transform(fileCacheCode);
    expect([...manager.serverReferences.claimMap.get(moduleId).keys()]).toEqual([
      "vinext:server-function-directives",
    ]);
  });

  it("matches Vite's dev reference key for files outside the project root", async () => {
    const plugins = await getPlugins();
    const manager = await configurePluginRsc(plugins);
    manager.config.command = "serve";
    manager.server = {
      environments: {
        rsc: {
          config: { root: APP_FIXTURE_DIR },
          moduleGraph: { getModuleById: () => undefined },
        },
      },
    };
    const plugin = plugins.find(
      (candidate) => candidate.name === "vinext:server-function-directives",
    )!;
    const externalId = import.meta.filename;
    const result = await unwrapHook(plugin.transform)!.call(
      { environment: { name: "rsc", mode: "dev" } },
      inlineCacheCode,
      externalId,
    );
    const expectedKey = path.posix.join("/@fs/", externalId);
    expect(result!.code).toContain(JSON.stringify(expectedKey));
    expect(manager.serverReferences.metaMap.get(externalId)!.referenceKey).toBe(expectedKey);
  });

  it("wraps and registers inline cache functions with plugin-rsc's build reference key", async () => {
    const plugins = await getPlugins();
    const manager = await configurePluginRsc(plugins);
    const plugin = plugins.find(
      (candidate) => candidate.name === "vinext:server-function-directives",
    )!;
    const transform = unwrapHook(plugin.transform)!;
    const result = await transform.call(
      { environment: { name: "rsc", mode: "build" } },
      inlineCacheCode,
      moduleId,
    );
    expect(result).not.toBeNull();

    const expectedKey = createHash("sha256")
      .update(manager.toRelativeId(moduleId))
      .digest("hex")
      .slice(0, 12);
    expect(result!.code).toContain("$$VinextReactServer.registerServerReference");
    expect(result!.code).toContain("registerCachedFunction");
    expect(result!.code).toContain(JSON.stringify(expectedKey));
    expect(manager.serverReferences.metaMap.get(moduleId)).toEqual({
      importId: moduleId,
      referenceKey: expectedKey,
      exportNames: ["$$hoist_0_getData"],
    });
  });

  it("removes its claim when the directive is removed", async () => {
    const plugins = await getPlugins();
    const manager = await configurePluginRsc(plugins);
    const plugin = plugins.find(
      (candidate) => candidate.name === "vinext:server-function-directives",
    )!;
    const transform = unwrapHook(plugin.transform)!;
    const useServerPlugin = plugins.find((candidate) => candidate.name === "rsc:use-server")!;
    const context = { environment: { name: "rsc", mode: "build" } };
    await transform.call(context, inlineCacheCode, moduleId);
    expect(manager.serverReferences.metaMap.get(moduleId)).toBeDefined();
    const source = `export async function getData() { return 1; }`;
    const useServerResult = await unwrapHook(useServerPlugin.transform)!.call(
      context,
      source,
      moduleId,
    );
    await transform.call(context, useServerResult?.code ?? source, moduleId);
    expect(manager.serverReferences.metaMap.get(moduleId)).toBeUndefined();
  });

  it("encrypts closure captures through the cache runtime envelope", async () => {
    const plugins = await getPlugins();
    await configurePluginRsc(plugins);
    const plugin = plugins.find(
      (candidate) => candidate.name === "vinext:server-function-directives",
    )!;
    const transform = unwrapHook(plugin.transform)!;
    const closureCode = [
      `export async function CachedSection() {`,
      `  "use cache";`,
      `  const capturedSecret = "do-not-leak";`,
      `  const getMessage = async () => {`,
      `    "use cache";`,
      `    return "message:" + capturedSecret;`,
      `  };`,
      `  return getMessage;`,
      `}`,
    ].join("\n");

    const result = await transform.call(
      { environment: { name: "rsc", mode: "build" } },
      closureCode,
      moduleId,
    );
    expect(result).not.toBeNull();
    expect(result!.code).toMatch(
      /\.bind\(null,\s*\$\$cacheRuntime\.encryptCacheCaptures\(\[capturedSecret\]\)\)/,
    );
    expect(result!.code).not.toMatch(/\.bind\(null,\s*capturedSecret\)/);
    expect(result!.code).toContain("const [capturedSecret] = $$hoist_encoded");
    const boundRegistration = result!.code.match(
      /registerCachedFunction\(\$\$hoist_[^,]+_getMessage\$\$impl,[^)]*\)/,
    )?.[0];
    expect(boundRegistration).toBeDefined();
    expect(boundRegistration).toContain('"argumentCount":0');
  });

  it.each(["ssr", "client"])(
    "rejects standalone inline cache functions in the %s graph",
    async (environmentName) => {
      const plugins = await getPlugins();
      await configurePluginRsc(plugins);
      const plugin = plugins.find(
        (candidate) => candidate.name === "vinext:server-function-directives",
      )!;
      const transform = unwrapHook(plugin.transform)!;

      await expect(
        transform.call(
          { environment: { name: environmentName, mode: "build" } },
          inlineCacheCode,
          moduleId,
        ),
      ).rejects.toThrow(/inline "use cache".*Client Component/);
    },
  );

  it("supports destructured file-level exports", async () => {
    const plugins = await getPlugins();
    await configurePluginRsc(plugins);
    const plugin = plugins.find(
      (candidate) => candidate.name === "vinext:server-function-directives",
    )!;
    const transform = unwrapHook(plugin.transform)!;
    const result = await transform.call(
      { environment: { name: "rsc", mode: "build" } },
      [`"use cache";`, `export const { value: getData } = { value: async () => 1 };`].join("\n"),
      moduleId,
    );
    expect(result!.code).toContain("registerCachedFunction(getData");
  });

  it("supports named re-exports from file-level cache modules", async () => {
    const plugins = await getPlugins();
    await configurePluginRsc(plugins);
    const plugin = plugins.find(
      (candidate) => candidate.name === "vinext:server-function-directives",
    )!;
    const transform = unwrapHook(plugin.transform)!;
    const result = await transform.call(
      { environment: { name: "rsc", mode: "build" } },
      [`"use cache";`, `export { getData } from "./data";`].join("\n"),
      moduleId,
    );
    expect(result!.code).toContain("registerCachedFunction($$import_getData");
  });

  it("accepts configured cache kinds containing punctuation", async () => {
    const plugins = await getPlugins();
    await configurePluginRsc(plugins);
    const plugin = plugins.find(
      (candidate) => candidate.name === "vinext:server-function-directives",
    )!;
    const transform = unwrapHook(plugin.transform)!;
    const result = await transform.call(
      { environment: { name: "rsc", mode: "build" } },
      [`export async function getData() {`, `  "use cache: durable-cache";`, `}`].join("\n"),
      moduleId,
    );
    expect(result?.code).toContain('"durable-cache"');
  });

  it("wraps mixed file-level export forms", async () => {
    const plugins = await getPlugins();
    const manager = await configurePluginRsc(plugins);
    const plugin = plugins.find(
      (candidate) => candidate.name === "vinext:server-function-directives",
    )!;
    const transform = unwrapHook(plugin.transform)!;
    const result = await transform.call(
      { environment: { name: "rsc", mode: "build" } },
      [
        `"use cache";`,
        `const imported = async () => 1;`,
        `export const direct = async () => 2;`,
        `export const alias = imported;`,
        `const named = async function named() { return 3; };`,
        `export { named, imported as renamed };`,
        `export default imported;`,
      ].join("\n"),
      moduleId,
    );
    expect(result!.code).toContain("registerCachedFunction(direct");
    expect(result!.code).toContain("registerCachedFunction(alias");
    expect(result!.code).toContain("registerCachedFunction(named");
    expect(result!.code).toContain("registerCachedFunction(imported");
    expect(manager.serverReferences.metaMap.get(moduleId)!.exportNames).toEqual(
      expect.arrayContaining(["direct", "alias", "named", "renamed", "default"]),
    );
  });

  it("rejects statically known synchronous inline cached functions", async () => {
    const plugins = await getPlugins();
    await configurePluginRsc(plugins);
    const plugin = plugins.find(
      (candidate) => candidate.name === "vinext:server-function-directives",
    )!;
    const transform = unwrapHook(plugin.transform)!;
    await expect(
      transform.call(
        { environment: { name: "rsc", mode: "build" } },
        [`export function getData() {`, `  "use cache";`, `}`].join("\n"),
        moduleId,
      ),
    ).rejects.toThrow(/non async function/);
  });

  it.each(["rsc", "ssr", "client"])(
    "rejects synchronous exports from file-level cache modules in the %s graph",
    async (environmentName) => {
      // Ported from Next.js: crates/next-custom-transforms/tests/errors/server-actions/server-graph/14/input.js
      // https://github.com/vercel/next.js/blob/canary/crates/next-custom-transforms/tests/errors/server-actions/server-graph/14/input.js
      const plugins = await getPlugins();
      await configurePluginRsc(plugins);
      const plugin = plugins.find(
        (candidate) => candidate.name === "vinext:server-function-directives",
      )!;
      const transform = unwrapHook(plugin.transform)!;
      await expect(
        transform.call(
          { environment: { name: environmentName, mode: "build" } },
          [`"use cache";`, `export function getData() { return 1; }`].join("\n"),
          moduleId,
        ),
      ).rejects.toThrow(/non async function/);
    },
  );

  it.each(["rsc", "ssr", "client"])(
    "allows scalar route segment config exports from file-level cache pages in the %s graph",
    async (environmentName) => {
      // Ported from Next.js: vercel/next.js#97181
      // https://github.com/vercel/next.js/commit/c0c64a0ab154853f4c792fb7b22a81d1b04ce073
      const plugins = await getPlugins();
      const manager = await configurePluginRsc(plugins);
      const plugin = plugins.find(
        (candidate) => candidate.name === "vinext:server-function-directives",
      )!;
      const transform = unwrapHook(plugin.transform)!;
      const pageModuleId = path.join(APP_FIXTURE_DIR, "app", "cached-page", "page.tsx");
      const result = await transform.call(
        { environment: { name: environmentName, mode: "build" } },
        [
          `"use cache";`,
          `export const revalidate = 60;`,
          `export const dynamic = "force-static";`,
          `export const metadata = { title: "Cached page" };`,
          `export default async function Page() { return null; }`,
        ].join("\n"),
        pageModuleId,
      );

      if (environmentName === "rsc") {
        expect(result!.code).toContain(`export const revalidate = 60;`);
        expect(result!.code).toContain(`export const dynamic = "force-static";`);
        expect(result!.code).toContain(`export const metadata = { title: "Cached page" };`);
      } else {
        // Non-RSC graphs contain only callable server-reference proxies. Route
        // config and metadata stay server-only and must not become references.
        expect(result!.code).not.toContain("#revalidate");
        expect(result!.code).not.toContain("#dynamic");
        expect(result!.code).not.toContain("#metadata");
      }
      expect(manager.serverReferences.metaMap.get(pageModuleId)!.exportNames).not.toEqual(
        expect.arrayContaining(["revalidate", "dynamic", "metadata"]),
      );
    },
  );

  it.each(["rsc", "ssr", "client"])(
    "still rejects class exports from file-level cache modules in the %s graph",
    async (environmentName) => {
      // Next.js continues to reject class declarations in file-level cache modules.
      // https://github.com/vercel/next.js/blob/c0c64a0ab154853f4c792fb7b22a81d1b04ce073/crates/next-custom-transforms/src/transforms/server_actions.rs#L1954-L1960
      const plugins = await getPlugins();
      await configurePluginRsc(plugins);
      const plugin = plugins.find(
        (candidate) => candidate.name === "vinext:server-function-directives",
      )!;
      const transform = unwrapHook(plugin.transform)!;

      await expect(
        transform.call(
          { environment: { name: environmentName, mode: "build" } },
          [`"use cache";`, `export class Config {}`].join("\n"),
          moduleId,
        ),
      ).rejects.toThrow(/non async function/);
    },
  );

  it.each(["rsc", "ssr", "client"])(
    "still rejects default scalar exports from file-level cache modules in the %s graph",
    async (environmentName) => {
      // Next.js only relaxes named variable literals; non-function defaults remain invalid.
      // https://github.com/vercel/next.js/blob/c0c64a0ab154853f4c792fb7b22a81d1b04ce073/crates/next-custom-transforms/src/transforms/server_actions.rs#L2081-L2107
      const plugins = await getPlugins();
      await configurePluginRsc(plugins);
      const plugin = plugins.find(
        (candidate) => candidate.name === "vinext:server-function-directives",
      )!;
      const transform = unwrapHook(plugin.transform)!;

      await expect(
        transform.call(
          { environment: { name: environmentName, mode: "build" } },
          [`"use cache";`, `export default 1;`].join("\n"),
          moduleId,
        ),
      ).rejects.toThrow(/non async function/);
    },
  );

  it.each(["use cache:remote", "use cache remote", "use cache : remote"])(
    "rejects malformed cache directive %s",
    async (directive) => {
      const plugins = await getPlugins();
      await configurePluginRsc(plugins);
      const plugin = plugins.find(
        (candidate) => candidate.name === "vinext:server-function-directives",
      )!;
      const transform = unwrapHook(plugin.transform)!;
      await expect(
        transform.call(
          { environment: { name: "rsc", mode: "build" } },
          [`export async function getData() {`, `  ${JSON.stringify(directive)};`, `}`].join("\n"),
          moduleId,
        ),
      ).rejects.toThrow(/Invalid cache directive/);
    },
  );

  it("composes inline cache semantics with a module-level use-server boundary", async () => {
    const plugins = await getPlugins();
    const manager = await configurePluginRsc(plugins);
    const plugin = plugins.find(
      (candidate) => candidate.name === "vinext:server-function-directives",
    )!;
    const useServerPlugin = plugins.find((candidate) => candidate.name === "rsc:use-server")!;
    const context = { environment: { name: "rsc", mode: "build" } };
    const source = [
      `"use server";`,
      `export async function getData() {`,
      `  "use cache";`,
      `  return 1;`,
      `}`,
    ].join("\n");
    const result = await unwrapHook(plugin.transform)!.call(context, source, moduleId);
    expect(result?.code).toContain("registerCachedFunction");
    expect(result?.code).toMatch(/^"use server";\nimport /);

    const useServerResult = await unwrapHook(useServerPlugin.transform)!.call(
      context,
      result!.code,
      moduleId,
    );
    expect(useServerResult?.code).toContain("$$VinextReactServer.registerServerReference");
    expect(() => parseAst(useServerResult!.code)).not.toThrow();
    expect([...manager.serverReferences.claimMap.get(moduleId).keys()]).toEqual([
      "vinext:server-function-directives",
      "rsc:use-server",
    ]);
    const exportNames = manager.serverReferences.metaMap.get(moduleId)!.exportNames;
    expect(exportNames).toContainEqual(expect.stringMatching(/getData/));
    expect(exportNames).toHaveLength(new Set(exportNames).size);
  });

  it("leaves inline use-server exports to plugin-rsc inside a file-level cache boundary", async () => {
    const plugins = await getPlugins();
    const manager = await configurePluginRsc(plugins);
    const plugin = plugins.find(
      (candidate) => candidate.name === "vinext:server-function-directives",
    )!;
    const useServerPlugin = plugins.find((candidate) => candidate.name === "rsc:use-server")!;
    const context = { environment: { name: "rsc", mode: "build" } };
    const source = [
      `"use cache";`,
      `export async function cached() {}`,
      `export async function uncached() {`,
      `  "use server";`,
      `}`,
    ].join("\n");

    const result = await unwrapHook(plugin.transform)!.call(context, source, moduleId);
    expect(result?.code).toContain("registerCachedFunction(cached");
    expect(result?.code).not.toContain("registerCachedFunction(uncached");
    expect(result?.code).toMatch(/^"use cache";\nimport /);

    const useServerResult = await unwrapHook(useServerPlugin.transform)!.call(
      context,
      result!.code,
      moduleId,
    );
    expect(() => parseAst(useServerResult!.code)).not.toThrow();
    expect([...manager.serverReferences.claimMap.get(moduleId).keys()]).toEqual([
      "vinext:server-function-directives",
      "rsc:use-server",
    ]);
    const exportNames = manager.serverReferences.metaMap.get(moduleId)!.exportNames;
    expect(exportNames).toContain("cached");
    expect(exportNames).toContainEqual(expect.stringMatching(/uncached/));
    expect(exportNames).toHaveLength(new Set(exportNames).size);
  });

  it("rejects conflicting file-level cache and use-server directives", async () => {
    const plugins = await getPlugins();
    await configurePluginRsc(plugins);
    const plugin = plugins.find(
      (candidate) => candidate.name === "vinext:server-function-directives",
    )!;
    const transform = unwrapHook(plugin.transform)!;
    await expect(
      transform.call(
        { environment: { name: "rsc", mode: "build" } },
        [`"use server";`, `"use cache";`, `export async function getData() {}`].join("\n"),
        moduleId,
      ),
    ).rejects.toThrow(/cannot contain both/);
  });

  it("still rejects scalar exports from file-level use-server modules", async () => {
    // Next.js keeps this restriction because every export from a "use server"
    // file becomes a callable server reference.
    // https://github.com/vercel/next.js/commit/c0c64a0ab154853f4c792fb7b22a81d1b04ce073
    const plugins = await getPlugins();
    await configurePluginRsc(plugins);
    const useServerPlugin = plugins.find((candidate) => candidate.name === "rsc:use-server")!;
    const transform = unwrapHook(useServerPlugin.transform)!;

    await expect(
      transform.call(
        {
          environment: { name: "rsc", mode: "build" },
          error(error: unknown): never {
            throw error;
          },
        },
        [`"use server";`, `export const value = 1;`].join("\n"),
        moduleId,
      ),
    ).rejects.toThrow(/non async function/);
  });

  it("returns a source map for transformed modules", async () => {
    const plugins = await getPlugins();
    await configurePluginRsc(plugins);
    const plugin = plugins.find(
      (candidate) => candidate.name === "vinext:server-function-directives",
    )!;
    const result = await unwrapHook(plugin.transform)!.call(
      { environment: { name: "rsc", mode: "build" } },
      inlineCacheCode,
      moduleId,
    );
    expect(result?.map).toBeTruthy();
  });

  it("wraps and registers file-level cache exports in the RSC graph", async () => {
    const plugins = await getPlugins();
    const manager = await configurePluginRsc(plugins);
    const plugin = plugins.find(
      (candidate) => candidate.name === "vinext:server-function-directives",
    )!;
    const transform = unwrapHook(plugin.transform)!;
    const result = await transform.call(
      { environment: { name: "rsc", mode: "build" } },
      fileCacheCode,
      moduleId,
    );
    expect(result).not.toBeNull();
    expect(result!.code).toContain("$$VinextReactServer.registerServerReference");
    expect(result!.code).toContain("registerCachedFunction");
    expect(result!.code).toContain('"use cache";');
    expect(manager.serverReferences.metaMap.get(moduleId)!.exportNames).toEqual(["getData"]);
  });

  it("marks file-level App Page default exports after Vinext resolves the app directory", async () => {
    const plugins = await getPlugins();
    await configureVinext(plugins);
    await configurePluginRsc(plugins);
    const plugin = plugins.find(
      (candidate) => candidate.name === "vinext:server-function-directives",
    )!;
    const pageId = path.join(APP_FIXTURE_DIR, "app", "page.tsx");
    const result = await unwrapHook(plugin.transform)!.call(
      { environment: { name: "rsc", mode: "build" } },
      [`"use cache";`, `export default async function Page() { return null; }`].join("\n"),
      pageId,
    );

    expect(result?.code).toContain('"appPageDefaultExport":true');
  });

  it.each(["ssr", "client"])(
    "emits server-reference proxies for file-level cache exports in the %s graph",
    async (environmentName) => {
      const plugins = await getPlugins();
      await configurePluginRsc(plugins);
      const plugin = plugins.find(
        (candidate) => candidate.name === "vinext:server-function-directives",
      )!;
      const transform = unwrapHook(plugin.transform)!;
      const result = await transform.call(
        { environment: { name: environmentName, mode: "build" } },
        fileCacheCode,
        moduleId,
      );
      expect(result).not.toBeNull();
      expect(result!.code).toContain("createServerReference");
      expect(result!.code).toContain("#getData");
      expect(result!.code).not.toContain("registerCachedFunction");
      expect(result!.code).not.toContain("registerCachedServerReference");
    },
  );

  it.each([
    {
      name: "a default parameter",
      parameters: "_props, parent = fallbackParent",
    },
    {
      name: "a rest parameter",
      parameters: "...args",
    },
  ])(
    "records second-argument usage for an inline cached function with $name",
    async ({ parameters }) => {
      const code = await transformRsc(
        `export async function generateMetadata(${parameters}) {\n  "use cache";\n  return {};\n}`,
      );
      expect(code).toContain('"acceptsSecondArgument":true');
    },
  );

  it("records second-argument usage for file-level cached exports", async () => {
    const code = await transformRsc(
      `"use cache";\nexport async function generateMetadata(_props, parent = fallbackParent) {\n  return {};\n}`,
    );
    expect(code).toContain('"acceptsSecondArgument":true');
  });

  it("conservatively records second-argument usage for opaque re-exports", async () => {
    const code = await transformRsc(
      `"use cache";\nexport { generateMetadata } from "./metadata.js";`,
    );
    expect(code).toContain('"acceptsSecondArgument":true');
  });

  it("records when a cached function omits the second argument", async () => {
    const code = await transformRsc(
      `export async function generateMetadata() {\n  "use cache";\n  return {};\n}`,
    );
    expect(code).toContain('"acceptsSecondArgument":false');
  });
});
