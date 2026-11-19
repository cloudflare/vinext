import { createRequire } from "node:module";
import { compileFunction } from "node:vm";
import { describe, expect, it } from "vite-plus/test";
import {
  createReactServerDomAsyncHookOwnerPlugin,
  reactServerDomAsyncHookOptimizeDepsPlugin as plugin,
} from "../packages/vinext/src/plugins/react-server-dom-async-hook.js";

type ResolveIdHandler = (id: string, importer: string | undefined) => string | undefined;
type LoadHandler = (id: string) => string;
type EnvironmentContext = { environment: { name: string } };
type TransformHandler = (this: EnvironmentContext, code: string) => { code: string };
type CloseBundle = (this: EnvironmentContext) => void;
const resolveId = plugin.resolveId as { handler: ResolveIdHandler };
const load = plugin.load as { handler: LoadHandler };

const DEVELOPMENT_BUILD =
  "/app/node_modules/@vitejs/plugin-rsc/dist/vendor/react-server-dom/cjs/react-server-dom-webpack-server.node.development.js";

// A dev server's environment, with the owner plugin its vinext() adds.
function devEnvironment(name = "rsc") {
  const owner = createReactServerDomAsyncHookOwnerPlugin();
  const context: EnvironmentContext = { environment: { name } };
  return {
    // Evaluates the module the development build gets, as the environment does.
    loadAsyncHooks(): typeof import("node:async_hooks") {
      const id = resolveId.handler.call(undefined, "async_hooks", DEVELOPMENT_BUILD)!;
      const { code } = (owner.transform as { handler: TransformHandler }).handler.call(
        context,
        load.handler.call(undefined, id),
      );
      const module = { exports: {} as typeof import("node:async_hooks") };
      compileFunction(code, ["require", "module"])(createRequire(import.meta.url), module);
      return module.exports;
    },
    close() {
      (owner.closeBundle as CloseBundle).call(context);
    },
  };
}

const nextTask = () => new Promise((resolve) => setTimeout(resolve, 0));

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

  it("keeps one hook enabled when one server evaluates the build again", async () => {
    const environment = devEnvironment();
    const inits = { first: 0, second: 0 };
    const first = environment
      .loadAsyncHooks()
      .createHook({ init: () => void inits.first++ })
      .enable();
    const asyncHooks = environment.loadAsyncHooks();
    const second = asyncHooks.createHook({ init: () => void inits.second++ }).enable();
    try {
      await nextTask();
      expect(inits.first).toBe(0);
      expect(inits.second).toBeGreaterThan(0);
      // Everything else is node:async_hooks.
      expect(asyncHooks.AsyncLocalStorage).toBeTypeOf("function");
      expect(asyncHooks.executionAsyncId()).toBeTypeOf("number");
    } finally {
      environment.close();
      first.disable();
      second.disable();
    }
  });

  it("keeps a live server's hook while another server starts, and disables each on close", async () => {
    const live = devEnvironment();
    const other = devEnvironment();
    const inits = { live: 0, other: 0 };
    const liveHook = live
      .loadAsyncHooks()
      .createHook({ init: () => void inits.live++ })
      .enable();
    const otherHook = other
      .loadAsyncHooks()
      .createHook({ init: () => void inits.other++ })
      .enable();
    try {
      await nextTask();
      expect(inits.live).toBeGreaterThan(0);
      expect(inits.other).toBeGreaterThan(0);

      other.close();
      const { live: liveBefore, other: otherBefore } = inits;
      await nextTask();
      expect(inits.live).toBeGreaterThan(liveBefore);
      expect(inits.other).toBe(otherBefore);

      live.close();
      const liveAfterClose = inits.live;
      await nextTask();
      expect(inits.live).toBe(liveAfterClose);
    } finally {
      liveHook.disable();
      otherHook.disable();
    }
  });
});
