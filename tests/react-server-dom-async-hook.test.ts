import { createRequire } from "node:module";
import { compileFunction } from "node:vm";
import { describe, expect, it } from "vite-plus/test";
import { reactServerDomAsyncHookOptimizeDepsPlugin as plugin } from "../packages/vinext/src/plugins/react-server-dom-async-hook.js";

type ResolveIdHandler = (id: string, importer: string | undefined) => string | undefined;
type LoadHandler = (id: string) => string;
const resolveId = plugin.resolveId as { handler: ResolveIdHandler };
const load = plugin.load as { handler: LoadHandler };

const DEVELOPMENT_BUILD =
  "/app/node_modules/@vitejs/plugin-rsc/dist/vendor/react-server-dom/cjs/react-server-dom-webpack-server.node.development.js";

// Evaluates the module the development build gets, as each dev server does.
function loadAsyncHooks(): typeof import("node:async_hooks") {
  const id = resolveId.handler.call(undefined, "async_hooks", DEVELOPMENT_BUILD)!;
  const module = { exports: {} as typeof import("node:async_hooks") };
  compileFunction(load.handler.call(undefined, id), ["require", "module"])(
    createRequire(import.meta.url),
    module,
  );
  return module.exports;
}

describe("reactServerDomAsyncHookOptimizeDepsPlugin", () => {
  it("only replaces async_hooks for React's Node development Flight server", () => {
    expect(resolveId.handler.call(undefined, "node:async_hooks", DEVELOPMENT_BUILD)).toBeTypeOf(
      "string",
    );
    expect(
      resolveId.handler.call(
        undefined,
        "async_hooks",
        DEVELOPMENT_BUILD.replace("development", "production"),
      ),
    ).toBeUndefined();
    expect(resolveId.handler.call(undefined, "async_hooks", "/app/src/server.js")).toBeUndefined();
  });

  it("keeps one hook enabled when the build is evaluated again", async () => {
    const inits = { first: 0, second: 0 };
    const first = loadAsyncHooks()
      .createHook({ init: () => void inits.first++ })
      .enable();
    const asyncHooks = loadAsyncHooks();
    const second = asyncHooks.createHook({ init: () => void inits.second++ }).enable();
    try {
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(inits.first).toBe(0);
      expect(inits.second).toBeGreaterThan(0);
      // Everything else is node:async_hooks.
      expect(asyncHooks.AsyncLocalStorage).toBeTypeOf("function");
      expect(asyncHooks.executionAsyncId()).toBeTypeOf("number");
    } finally {
      first.disable();
      second.disable();
    }
  });
});
