import { AsyncLocalStorage } from "node:async_hooks";
import type { Plugin } from "vite";
import { toSlash } from "pathslash";

/**
 * React's Node development Flight server enables an async_hooks hook when it
 * is evaluated, and never disables it. Next.js loads it once per process. In
 * Vite, a dev server's module runner evaluates it again, so each restart adds
 * a hook, and the hook keeps the closed server's React and module graph alive.
 *
 * The build also wraps console's methods, as vinext's hook warning
 * suppression wraps `console.error`. Each wrapper calls the one it replaced,
 * so a closed server's copies stay reachable from `console` too.
 *
 * The build's `async_hooks` resolves to a module that creates hooks through
 * `node:async_hooks` and records the dev server each one belongs to, and the
 * console methods that copy of the build replaced. When that server closes,
 * its hook is disabled and its console methods are put back. Vite can still
 * keep a closed server's environments, and with them that copy, so the hook
 * is also told the resources it recorded are gone, as it would have heard. A
 * live server's hook and console methods work as React set them.
 */

const REACT_SERVER_DOM_ASYNC_HOOKS_ID = "\0vinext:react-server-dom-async-hooks";

// React's Node development build of the Flight server, vendored by plugin-rsc
// or installed. The static entry uses the same file.
const REACT_SERVER_DOM_NODE_DEVELOPMENT_BUILD =
  /\/react-server-dom-webpack-server\.node\.development\.js$/;

// Also read by server/app-hook-warning-suppression.ts.
const REGISTRY = Symbol.for("vinext.devServerOwners");

type DevServerOwner = {
  closed: boolean;
  hook?: { of: unknown; release(): void };
};

type ConsoleMethods = Record<string, unknown>;

/** The console methods a module evaluated for a dev server replaced. */
type ConsoleLayer = {
  owner: DevServerOwner;
  kind: string;
  // Its server closed, or evaluated the module again.
  retired: boolean;
  before: ConsoleMethods;
  after: ConsoleMethods;
};

/**
 * Shared with the modules a dev server's module runner evaluates, in the same
 * realm.
 */
type DevServerRegistry = {
  // The dev server a request runs for, so a module evaluated while serving it
  // is attributed to it.
  scope: AsyncLocalStorage<DevServerOwner>;
  // The dev servers that are running.
  live: Set<DevServerOwner>;
  // In the order the methods were replaced.
  consoleLayers: ConsoleLayer[];
  /**
   * Called by a module before it replaces console methods, and `record()`
   * once it has. Undefined when it can't be attributed to a server.
   */
  consoleLayer(kind: string): { owner: DevServerOwner; record(): void } | undefined;
};

export function devServerRegistry(): DevServerRegistry {
  const scope = globalThis as typeof globalThis & { [REGISTRY]?: DevServerRegistry };
  return (scope[REGISTRY] ??= {
    scope: new AsyncLocalStorage(),
    live: new Set(),
    consoleLayers: [],
    consoleLayer(kind) {
      const owner = ownerOfModule(this);
      if (!owner) return undefined;
      retireConsoleLayers(this, (layer) => layer.owner === owner && layer.kind === kind);
      const before: ConsoleMethods = { ...console };
      return {
        owner,
        record: () => {
          const after: ConsoleMethods = {};
          for (const [name, method] of Object.entries(console)) {
            if (method !== before[name]) after[name] = method;
          }
          if (Object.keys(after).length === 0) return;
          this.consoleLayers.push({ owner, kind, retired: false, before, after });
          if (owner.closed) retireConsoleLayers(this, (layer) => layer.owner === owner);
        },
      };
    },
  });
}

/**
 * A module evaluated outside a request, such as by instrumentation at
 * startup, belongs to the only running server. With several running and no
 * request, it isn't attributed.
 */
function ownerOfModule(registry: DevServerRegistry): DevServerOwner | undefined {
  const owner = registry.scope.getStore();
  if (owner) return owner;
  if (registry.live.size === 1) return registry.live.values().next().value;
  return undefined;
}

/**
 * Retires the matching layers, and puts back each retired layer's methods
 * while they are still the current ones. From the latest down, so a retired
 * layer below comes back to the methods it replaced too. One below a layer
 * still in use stays until that one is retired.
 */
function retireConsoleLayers(
  registry: DevServerRegistry,
  matches: (layer: ConsoleLayer) => boolean,
): void {
  const target = console as unknown as ConsoleMethods;
  for (let index = registry.consoleLayers.length - 1; index >= 0; index -= 1) {
    const layer = registry.consoleLayers[index];
    if (matches(layer)) layer.retired = true;
    if (!layer.retired) continue;
    for (const name of Object.keys(layer.after)) {
      if (target[name] !== layer.after[name]) continue;
      Object.defineProperty(target, name, { value: layer.before[name] });
      delete layer.after[name];
    }
    if (Object.keys(layer.after).length === 0) registry.consoleLayers.splice(index, 1);
  }
}

// The build requires it from CommonJS, once per copy, before it replaces the
// console methods, and has replaced them once it has finished evaluating.
//
// A disabled hook no longer hears of resources being destroyed, and React's
// drops what it recorded for one only then. Async ids only increase, so the
// ones it can have recorded are those created while it was enabled: it's
// called for each, in slices so a long session's don't block the restart.
const ASYNC_HOOKS_MODULE = `"use strict";
const asyncHooks = require("node:async_hooks");
const consoleLayer = globalThis[Symbol.for(${JSON.stringify(REGISTRY.description)})]?.consoleLayer("react-server-dom");
const owner = consoleLayer?.owner;
if (consoleLayer) queueMicrotask(consoleLayer.record);
function newestAsyncId() {
  const resource = new asyncHooks.AsyncResource("vinext");
  resource.emitDestroy();
  return resource.asyncId();
}
function destroyAll(destroy, from, to) {
  const end = Math.min(from + 10000000, to);
  for (let asyncId = from; asyncId < end; asyncId += 1) destroy(asyncId);
  if (end < to) setImmediate(destroyAll, destroy, end, to).unref();
}
module.exports = {
  ...asyncHooks,
  createHook(callbacks) {
    const hook = asyncHooks.createHook(callbacks);
    if (!owner) return hook;
    const enable = hook.enable;
    hook.enable = function () {
      if (owner.closed) return this;
      if (owner.hook?.of === hook) return enable.call(this);
      // The server evaluated the build again, after re-optimizing its
      // dependencies: the previous copy no longer renders.
      owner.hook?.release();
      const firstAsyncId = newestAsyncId();
      owner.hook = {
        of: hook,
        release() {
          hook.disable();
          if (typeof callbacks.destroy === "function") {
            destroyAll(callbacks.destroy, firstAsyncId, newestAsyncId());
          }
        },
      };
      return enable.call(this);
    };
    return hook;
  },
};
`;

/** For the dev optimizer's Rolldown pipeline, which pre-bundles the build. */
export const reactServerDomAsyncHookOptimizeDepsPlugin: Plugin = {
  name: "vinext:react-server-dom-async-hook:optimize-deps",
  resolveId: {
    filter: { id: /^(?:node:)?async_hooks$/ },
    handler(_id, importer) {
      if (importer && REACT_SERVER_DOM_NODE_DEVELOPMENT_BUILD.test(toSlash(importer))) {
        return REACT_SERVER_DOM_ASYNC_HOOKS_ID;
      }
    },
  },
  load: {
    filter: { id: new RegExp(`^${REACT_SERVER_DOM_ASYNC_HOOKS_ID}$`) },
    handler() {
      return ASYNC_HOOKS_MODULE;
    },
  },
};

/**
 * Records each dev server, and when it closes disables its hook and puts back
 * the console methods replaced for it.
 */
export function createReactServerDomAsyncHookOwnerPlugin(): Plugin {
  const owners = new WeakMap<object, DevServerOwner>();
  return {
    name: "vinext:react-server-dom-async-hook:owner",
    apply: "serve",
    // Its middleware has to run before the one that renders.
    enforce: "pre",
    configureServer(server) {
      const owner: DevServerOwner = { closed: false };
      const registry = devServerRegistry();
      registry.live.add(owner);
      for (const environment of Object.values(server.environments)) {
        owners.set(environment, owner);
      }
      server.middlewares.use((_req, _res, next) => registry.scope.run(owner, next));
    },
    closeBundle() {
      const owner = owners.get(this.environment);
      if (!owner || owner.closed) return;
      owner.closed = true;
      owner.hook?.release();
      owner.hook = undefined;
      const registry = devServerRegistry();
      registry.live.delete(owner);
      retireConsoleLayers(registry, (layer) => layer.owner === owner);
    },
  };
}
