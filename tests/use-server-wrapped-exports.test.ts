import { describe, expect, it } from "vite-plus/test";
import { parseAst } from "vite-plus";
import {
  transformDirectiveProxyExport,
  transformServerActionServer,
} from "@vitejs/plugin-rsc/transforms";
import vinext from "../packages/vinext/src/index.js";
import type { Plugin } from "vite-plus";

function unwrapHook(hook: unknown): Function {
  if (typeof hook === "function") return hook;
  const handler = (hook as { handler?: Function } | undefined)?.handler;
  if (!handler) throw new Error("expected plugin hook handler");
  return handler;
}

function getWrappedExportsPlugin(): Plugin | undefined {
  const plugins = (vinext() as Plugin[]).flat(Infinity) as Plugin[];
  return plugins.find((plugin) => plugin?.name === "vinext:fix-use-server-wrapped-exports");
}

async function runPlugin(source: string, id = "/app/actions.ts"): Promise<string> {
  const plugin = getWrappedExportsPlugin();
  let code = source;

  if (!plugin?.transform) return code;

  const transform = unwrapHook(plugin.transform);
  const result = await transform.call(plugin, code, id);
  if (result != null) {
    code = typeof result === "string" ? result : result.code;
  }
  return code;
}

const WRAPPED_EXPORT_SOURCE = `
"use server";

import { actionClient } from "./lib/safe-action";

export const testAction = actionClient.action(async () => {
  return { message: "Hello, world!" };
});
`.trimStart();

describe("vinext:fix-use-server-wrapped-exports", () => {
  it("plugin is present in the vinext() plugin array", () => {
    expect(getWrappedExportsPlugin()).toBeDefined();
  });

  it("reproduces the upstream bug: strict proxy transform rejects wrapped async exports", () => {
    const ast = parseAst(WRAPPED_EXPORT_SOURCE);

    expect(() =>
      transformDirectiveProxyExport(ast as Parameters<typeof transformDirectiveProxyExport>[0], {
        code: WRAPPED_EXPORT_SOURCE,
        runtime: (name: string) => `createRef(${JSON.stringify(name)})`,
        directive: "use server",
        rejectNonAsyncFunction: true,
      }),
    ).toThrowError(/unsupported non async function/);
  });

  it("fix: rewrites wrapped async exports into local bindings plus export specifiers", async () => {
    const output = await runPlugin(WRAPPED_EXPORT_SOURCE);

    expect(output).toContain("const testAction = actionClient.action(async () => {");
    expect(output).toContain("export { testAction };");

    const ast = parseAst(output);
    const result = transformDirectiveProxyExport(
      ast as Parameters<typeof transformDirectiveProxyExport>[0],
      {
        code: output,
        runtime: (name: string) => `createRef(${JSON.stringify(name)})`,
        directive: "use server",
        rejectNonAsyncFunction: true,
      },
    );

    if (!result) throw new Error("expected proxy transform result");
    expect(result.output.toString()).toContain(
      'export const testAction = /* #__PURE__ */ createRef("testAction");',
    );
  });

  it("preserves the server transform for wrapped async exports", async () => {
    const output = await runPlugin(WRAPPED_EXPORT_SOURCE);
    const ast = parseAst(output);

    const result = transformServerActionServer(
      output,
      ast as Parameters<typeof transformServerActionServer>[1],
      {
        runtime: (_value: string, name: string) => `register(${JSON.stringify(name)})`,
        rejectNonAsyncFunction: true,
      },
    );

    expect(result.output.toString()).toContain('register("testAction")');
  });

  it("does not rewrite direct async function exports", async () => {
    const source = `
"use server";

export const testAction = async () => {
  return { message: "Hello, world!" };
};
`.trimStart();

    expect(await runPlugin(source)).toBe(source);
  });
});
