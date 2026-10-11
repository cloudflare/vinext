import { transformServerActionServer } from "@vitejs/plugin-rsc/transforms";
import { parseAst } from "vite";
import { describe, expect, it } from "vite-plus/test";
import { createActionBoundArgsPlugin } from "../packages/vinext/src/plugins/action-bound-args.js";

type TransformHandler = (
  this: { error(message: string): never },
  code: string,
  id: string,
) => Promise<{ code: string } | undefined>;

const plugin = createActionBoundArgsPlugin({ runtime: "/runtime.js" });
const handler = (plugin.transform as { handler: TransformHandler }).handler;
const context = {
  error(message: string): never {
    throw new Error(message);
  },
};

const RUNTIME_IMPORT = `import * as __vite_rsc_encryption_runtime from "file:///app/node_modules/@vitejs/plugin-rsc/dist/utils/encryption-runtime.js";\n`;

// The same code generation `rsc:use-server` uses for the RSC environment.
function useServerTransform(code: string): string {
  return (
    RUNTIME_IMPORT +
    transformServerActionServer(code, parseAst(code), {
      runtime: (value, name) =>
        `$$ReactServer.registerServerReference(${value}, "abc123", ${JSON.stringify(name)})`,
      rejectNonAsyncFunction: true,
      encode: (value) => `__vite_rsc_encryption_runtime.encryptActionBoundArgs(${value})`,
      decode: (value) => `await __vite_rsc_encryption_runtime.decryptActionBoundArgs(${value})`,
    }).output.toString()
  );
}

describe("vinext:action-bound-args", () => {
  it("binds each inline action's encrypted closure to its own action id", async () => {
    const code = useServerTransform(`export default function Page({ label, role }) {
  async function preview() { "use server"; return label; }
  const actions = { read: async () => { "use server"; return role; } };
  return [preview, actions];
}`);
    const result = await handler.call(context, code, "/app/page.js");
    const output = result!.code;

    expect(output).toContain(`import * as $$vinextActionBoundArgs from "/runtime.js";`);
    expect(output).toContain(
      `$$vinextActionBoundArgs.encryptBoundArgs("abc123#$$hoist_0_preview", [label])`,
    );
    expect(output).toContain(
      `$$vinextActionBoundArgs.decryptBoundArgs("abc123#$$hoist_0_preview", $$hoist_encoded)`,
    );
    expect(output).toContain(
      `$$vinextActionBoundArgs.encryptBoundArgs("abc123#$$hoist_1_anonymous_server_function", [role])`,
    );
    expect(output).toContain(
      `$$vinextActionBoundArgs.decryptBoundArgs("abc123#$$hoist_1_anonymous_server_function", $$hoist_encoded)`,
    );
    expect(output).not.toMatch(/__vite_rsc_encryption_runtime\.\w+ActionBoundArgs/);
  });

  it("binds closures through a renamed runtime namespace", async () => {
    const code = useServerTransform(`export default function Page({ label }) {
  async function preview() { "use server"; return label; }
  return preview;
}`).replaceAll("__vite_rsc_encryption_runtime", "__renamed_runtime");
    const result = await handler.call(context, code, "/app/page.js");
    expect(result!.code).toContain(
      `$$vinextActionBoundArgs.decryptBoundArgs("abc123#$$hoist_0_preview", $$hoist_encoded)`,
    );
    expect(result!.code).not.toMatch(/__renamed_runtime\.\w+ActionBoundArgs/);
  });

  it("fails the build for an encrypted closure it cannot bind", async () => {
    const code = `${RUNTIME_IMPORT}export const action = __vite_rsc_encryption_runtime.encryptActionBoundArgs([secret]);`;
    await expect(handler.call(context, code, "/app/page.js")).rejects.toThrow(
      "could not bind an inline Server Action's encrypted closure to its action id",
    );
  });

  it("leaves unrelated APIs with the same method names alone", async () => {
    const code = `import * as api from "./encryption-runtime.js";
export const sealed = api.encryptActionBoundArgs([secret]);`;
    expect(await handler.call(context, code, "/app/page.js")).toBeUndefined();
  });

  it("rejects every closure for an action whose registration was pruned", async () => {
    const code = useServerTransform(`export default function Page({ label }) {
  const preview = typeof window !== "undefined" ? async () => { "use server"; return label; } : null;
  return preview;
}`).replace(/\? \/\* #__PURE__ \*\/ [^:]*:/, "? undefined :");
    const result = await handler.call(context, code, "/app/page.js");
    expect(result!.code).toContain(`$$vinextActionBoundArgs.decryptBoundArgs("", $$hoist_encoded)`);
  });
});
