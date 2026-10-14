/**
 * Tests vinext's RSC-environment hoisting of inline "use server" functions,
 * which binds each closure's encrypted captures to its own action id.
 */
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { parseAst, type Plugin } from "vite";
import vinext from "../packages/vinext/src/index.js";
import {
  decryptActionBoundArgs,
  encryptActionBoundArgs,
} from "../packages/vinext/src/shims/server-action-bound-args.js";
import { APP_FIXTURE_DIR, RSC_ENTRIES } from "./helpers.js";

const encryption = vi.hoisted(() => ({ values: new Map<string, unknown>() }));
vi.mock("@vitejs/plugin-rsc/utils/encryption-runtime", () => ({
  async encryptActionBoundArgs(value: unknown) {
    const id = `encrypted:${encryption.values.size}`;
    encryption.values.set(id, value);
    return id;
  },
  async decryptActionBoundArgs(id: Promise<string>) {
    return encryption.values.get(await id);
  },
}));
beforeEach(() => encryption.values.clear());

// oxlint-disable-next-line typescript/no-explicit-any
function unwrapHook(hook: any): ((...args: any[]) => any) | undefined {
  return typeof hook === "function" ? hook : hook?.handler;
}

const PLUGIN_NAME = "vinext:inline-server-actions";
const moduleId = path.join(APP_FIXTURE_DIR, "app", "unit-test-inline-actions.tsx");
const rscContext = { environment: { name: "rsc", mode: "build" } };

async function setup(options: { manualRsc?: boolean } = {}) {
  // oxlint-disable-next-line typescript/no-explicit-any
  const rawPlugins = (
    vinext({ appDir: APP_FIXTURE_DIR, rsc: options.manualRsc ? false : undefined }) as any[]
  ).flat(Infinity);
  if (options.manualRsc) {
    const rsc = (await import("@vitejs/plugin-rsc")).default;
    rawPlugins.push(rsc({ entries: RSC_ENTRIES }));
  }
  const plugins = (await Promise.all(rawPlugins.map((plugin) => Promise.resolve(plugin))))
    .flat(Infinity)
    .filter(Boolean) as Plugin[];
  const minimal = plugins.find((plugin) => plugin.name === "rsc:minimal")!;
  unwrapHook(minimal.configResolved)!.call(minimal, {
    root: APP_FIXTURE_DIR,
    command: "build",
    environments: { rsc: { build: { outDir: path.join(APP_FIXTURE_DIR, "dist/rsc") } } },
  });
  const plugin = plugins.find((candidate) => candidate.name === PLUGIN_NAME)!;
  unwrapHook(plugin.configResolved)!.call(plugin, { plugins });
  return {
    plugins,
    plugin,
    useServerPlugin: plugins.find((candidate) => candidate.name === "rsc:use-server")!,
    // oxlint-disable-next-line typescript/no-explicit-any
    manager: (minimal as any).api.manager,
  };
}

const twoActionsCode = [
  `export default async function Page({ owner }) {`,
  `  const plain = async () => {`,
  `    "use server";`,
  `    return "plain";`,
  `  };`,
  `  const preview = async () => {`,
  `    "use server";`,
  `    return "preview:" + owner;`,
  `  };`,
  `  const protectedOwner = "victim";`,
  `  async function readProtected() {`,
  `    "use server";`,
  `    const inner = async () => {`,
  `      "use server";`,
  `      return protectedOwner;`,
  `    };`,
  `    return inner;`,
  `  }`,
  `  return [preview, readProtected, plain];`,
  `}`,
].join("\n");

/** Map each hoisted capturing action to the action id its captures decrypt for. */
function decodedActionIds(code: string): Map<string, string> {
  return new Map(
    [
      ...code.matchAll(
        /function (\$\$hoist_\d+_\w+)\(\$\$hoist_encoded\) \{\s*const \[[\w,]+\] = await \$\$vinextBoundArgs\.decryptActionBoundArgs\(("[^"]+")/g,
      ),
    ].map((match) => [match[1]!, match[2]!]),
  );
}

describe("inline Server Action captures", () => {
  it("runs before plugin-rsc's use-server transform", async () => {
    for (const manualRsc of [false, true]) {
      const { plugins } = await setup({ manualRsc });
      const index = plugins.findIndex((candidate) => candidate.name === PLUGIN_NAME);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(
        plugins.findIndex((candidate) => candidate.name === "rsc:use-server"),
      );
    }
  });

  it("binds each closure's encrypted captures to its own action id", async () => {
    const { plugin, useServerPlugin, manager } = await setup();
    const result = await unwrapHook(plugin.transform)!.call(rscContext, twoActionsCode, moduleId);
    const code: string = result!.code;
    expect(() => parseAst(code)).not.toThrow();
    const { referenceKey, exportNames } = manager.serverReferences.metaMap.get(moduleId)!;
    expect(exportNames).toEqual([
      "$$hoist_0_plain",
      "$$hoist_1_preview",
      "$$hoist_2_readProtected",
      "$$hoist_3_inner",
    ]);

    const id = (name: string) => JSON.stringify(`${referenceKey}#${name}`);
    expect(code).toContain(
      `.bind(null, $$vinextBoundArgs.encryptActionBoundArgs(${id("$$hoist_1_preview")}, [owner]))`,
    );
    expect(code).toContain(
      `.bind(null, $$vinextBoundArgs.encryptActionBoundArgs(${id("$$hoist_3_inner")}, [protectedOwner]))`,
    );
    expect(decodedActionIds(code)).toEqual(
      new Map([
        ["$$hoist_1_preview", id("$$hoist_1_preview")],
        ["$$hoist_2_readProtected", id("$$hoist_2_readProtected")],
        ["$$hoist_3_inner", id("$$hoist_3_inner")],
      ]),
    );
    expect(code).toContain("async function $$hoist_0_plain() {");
    expect(code).not.toContain("__vite_rsc_encryption_runtime");
    expect(code).not.toContain('"@vitejs/plugin-rsc/react/rsc/server"');
    expect(code).not.toContain('"use server"');

    // plugin-rsc no longer finds inline directives, so it neither rewrites
    // the module nor claims its references a second time.
    const useServerResult = await unwrapHook(useServerPlugin.transform)!.call(
      rscContext,
      code,
      moduleId,
    );
    expect(useServerResult).toBeUndefined();
    expect([...manager.serverReferences.claimMap.get(moduleId).keys()]).toEqual([PLUGIN_NAME]);
  });

  it.each([
    [
      "a nested action declared right after the directive",
      `export function P(y){async function outer(){"use server";async function inner(){"use server";return y}return inner}return outer}`,
      ["$$hoist_0_outer", "$$hoist_1_inner"],
    ],
    [
      "a use strict prologue",
      `export function P(y){return async () => {"use strict";"use server";return y}}`,
      ["$$hoist_0_anonymous_server_function"],
    ],
    [
      "object and static class methods",
      `export function P(y){return [{ async m(){"use server";return y} }, class { static async s(){"use server";return y} }]}`,
      ["$$hoist_0_m", "$$hoist_1_s"],
    ],
  ])("binds captures for %s", async (_label, source, names) => {
    const { plugin, manager } = await setup();
    const result = await unwrapHook(plugin.transform)!.call(rscContext, source, moduleId);
    const code: string = result!.code;
    expect(() => parseAst(code)).not.toThrow();
    const { referenceKey, exportNames } = manager.serverReferences.metaMap.get(moduleId)!;
    expect(exportNames).toEqual(names);
    expect(decodedActionIds(code)).toEqual(
      new Map(names.map((name) => [name, JSON.stringify(`${referenceKey}#${name}`)])),
    );
    for (const name of names) {
      expect(code).toContain(`registerServerReference(${name}, ${JSON.stringify(referenceKey)}`);
    }
    expect(code).not.toContain('"use server"');
  });

  it("leaves file-level use-server modules to plugin-rsc", async () => {
    const { plugin, manager } = await setup();
    const source = [`"use server";`, `export async function action() {}`].join("\n");
    expect(await unwrapHook(plugin.transform)!.call(rscContext, source, moduleId)).toBeUndefined();
    expect(manager.serverReferences.claimMap.get(moduleId)?.has(PLUGIN_NAME)).toBeFalsy();
  });

  it.each([
    ["no longer mentions the directive", `export const note = "server";`],
    ["only mentions the directive in a string", `export const note = "use server";`],
  ])("drops its claim when a module %s", async (_label, source) => {
    const { plugin, manager } = await setup();
    // A code filter would skip the module and leave the stale claim behind.
    expect(plugin.transform).not.toHaveProperty("filter");
    const transform = unwrapHook(plugin.transform)!;
    await transform.call(rscContext, twoActionsCode, moduleId);
    expect(manager.serverReferences.claimMap.get(moduleId)?.has(PLUGIN_NAME)).toBe(true);
    expect(await transform.call(rscContext, source, moduleId)).toBeUndefined();
    expect(manager.serverReferences.claimMap.get(moduleId)?.has(PLUGIN_NAME)).toBeFalsy();
  });

  it("only transforms the RSC environment", async () => {
    const { plugin } = await setup();
    const result = await unwrapHook(plugin.transform)!.call(
      { environment: { name: "ssr", mode: "build" } },
      twoActionsCode,
      moduleId,
    );
    expect(result).toBeUndefined();
  });
});

describe("Server Action bound-args runtime", () => {
  it("decrypts captures only for the action they were encrypted for", async () => {
    const encrypted = encryptActionBoundArgs("key#$$hoist_0_preview", ["mallory"]);
    expect(await decryptActionBoundArgs("key#$$hoist_0_preview", encrypted)).toEqual(["mallory"]);
    await expect(decryptActionBoundArgs("key#$$hoist_1_readProtected", encrypted)).rejects.toThrow(
      "Invalid Server Action payload: failed to decrypt.",
    );
  });

  it("rejects payloads without an action id", async () => {
    encryption.values.set("legacy", ["mallory"]);
    await expect(decryptActionBoundArgs("key#$$hoist_0_preview", "legacy")).rejects.toThrow(
      "Invalid Server Action payload: failed to decrypt.",
    );
  });
});
