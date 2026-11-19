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

// A dev server's environment, with the owner plugin its vinext() adds. A
// restarted server passes the plugin of the server it replaces.
function devEnvironment(name = "rsc", owner = createReactServerDomAsyncHookOwnerPlugin()) {
  const context: EnvironmentContext = { environment: { name } };
  // Transforms the module the development build gets, as the environment does,
  // and returns a function that evaluates it.
  const transformAsyncHooks = () => {
    const id = resolveId.handler.call(undefined, "async_hooks", DEVELOPMENT_BUILD)!;
    const { code } = (owner.transform as { handler: TransformHandler }).handler.call(
      context,
      load.handler.call(undefined, id),
    );
    return (): typeof import("node:async_hooks") => {
      const module = { exports: {} as typeof import("node:async_hooks") };
      compileFunction(code, ["require", "module"])(createRequire(import.meta.url), module);
      return module.exports;
    };
  };
  return {
    owner,
    transformAsyncHooks,
    loadAsyncHooks: () => transformAsyncHooks()(),
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

  // Vite closes an environment's plugins before its module runner, which does
  // not wait for a module it is still evaluating.
  it("does not enable a hook whose server closed while the build was evaluating", async () => {
    const environment = devEnvironment();
    const evaluate = environment.transformAsyncHooks();
    environment.close();
    let inits = 0;
    const hook = evaluate()
      .createHook({ init: () => void inits++ })
      .enable();
    try {
      await nextTask();
      expect(inits).toBe(0);
    } finally {
      hook.disable();
    }
  });

  it("enables the hook of a restarted server that reuses the closed server's plugins", async () => {
    const closed = devEnvironment();
    const lateEvaluate = closed.transformAsyncHooks();
    closed.close();
    const restarted = devEnvironment("rsc", closed.owner);
    const inits = { late: 0, restarted: 0 };
    const restartedHook = restarted
      .loadAsyncHooks()
      .createHook({ init: () => void inits.restarted++ })
      .enable();
    const lateHook = lateEvaluate()
      .createHook({ init: () => void inits.late++ })
      .enable();
    try {
      await nextTask();
      expect(inits.restarted).toBeGreaterThan(0);
      expect(inits.late).toBe(0);
      restarted.close();
      const afterClose = inits.restarted;
      await nextTask();
      expect(inits.restarted).toBe(afterClose);
    } finally {
      restartedHook.disable();
      lateHook.disable();
    }
  });

  // Vite environment names are arbitrary keys.
  it.each([['custom"env'], ["custom$&env"], ["custom\\'env`"]])(
    "keeps the owner of an environment named %s, and disables its hook on close",
    async (name) => {
      const environment = devEnvironment(name);
      let inits = 0;
      const hook = environment
        .loadAsyncHooks()
        .createHook({ init: () => void inits++ })
        .enable();
      try {
        await nextTask();
        expect(inits).toBeGreaterThan(0);
        environment.close();
        const afterClose = inits;
        await nextTask();
        expect(inits).toBe(afterClose);
      } finally {
        hook.disable();
      }
    },
  );
});
