import { AsyncLocalStorage } from "node:async_hooks";
import { isRunnableDevEnvironment, type Plugin } from "vite";
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
 * console methods that copy of the build replaced. A server's requests and
 * its module runners' imports run in its scope, so a copy is attributed to
 * the server whose runner evaluated it. When that server closes,
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
  // The enabled hook of each build, by the build's path: a server could
  // evaluate an installed copy as well as plugin-rsc's.
  hooks: Map<string, { of: unknown; release(): void }>;
};

type ConsoleMethods = Record<string, unknown>;

/**
 * What a module's replacement of a console method calls: it captured a
 * function that calls `target`, the method it replaced, so the methods of a
 * layer below that is retired can be taken out of the chain.
 */
type ConsoleLink = { target: unknown; forward: unknown };

/** The console methods a module evaluated for a dev server replaced. */
type ConsoleLayer = {
  owner: DevServerOwner;
  kind: string;
  // Its server closed, or evaluated the module again.
  retired: boolean;
  links: Map<string, ConsoleLink>;
  after: ConsoleMethods;
};

/**
 * Shared with the modules a dev server's module runner evaluates, in the same
 * realm.
 */
type DevServerRegistry = {
  // The dev server whose module runner is importing.
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
      // Evaluated again, as after a full reload: so are the modules evaluated
      // after it the first time, whose layers are above its own.
      const first = this.consoleLayers.findIndex(
        (layer) => !layer.retired && layer.owner === owner && layer.kind === kind,
      );
      if (first !== -1) {
        const again = new Set(this.consoleLayers.slice(first));
        retireConsoleLayers(this, (layer) => layer.owner === owner && again.has(layer));
      }
      const target = console as unknown as ConsoleMethods;
      const links = new Map<string, ConsoleLink>();
      for (const [name, method] of Object.entries(target)) {
        if (typeof method !== "function") continue;
        const link: ConsoleLink = { target: method, forward: undefined };
        link.forward = function (this: unknown, ...args: unknown[]): unknown {
          return (link.target as (...args: unknown[]) => unknown).apply(this, args);
        };
        // React names its wrapper after the method it replaced.
        Object.defineProperty(link.forward, "name", { value: method.name });
        Object.defineProperty(target, name, { value: link.forward });
        links.set(name, link);
      }
      return {
        owner,
        record: () => {
          const after: ConsoleMethods = {};
          for (const [name, link] of links) {
            if (target[name] !== link.forward) {
              after[name] = target[name];
              continue;
            }
            Object.defineProperty(target, name, { value: link.target });
            links.delete(name);
          }
          if (Object.keys(after).length === 0) return;
          this.consoleLayers.push({ owner, kind, retired: false, links, after });
          if (owner.closed) retireConsoleLayers(this, (layer) => layer.owner === owner);
        },
      };
    },
  });
}

/**
 * One a runner vinext doesn't wrap evaluated, such as an external runtime's
 * in the same process, belongs to the only running server. With several
 * running, it isn't attributed.
 */
function ownerOfModule(registry: DevServerRegistry): DevServerOwner | undefined {
  const owner = registry.scope.getStore();
  if (owner) return owner;
  if (registry.live.size === 1) return registry.live.values().next().value;
  return undefined;
}

/**
 * Retires the matching layers, and takes each retired layer's methods out of
 * the chain: where they are the current ones, the methods they replaced are
 * put back, and where a layer above calls them, it calls those instead. A
 * method something else replaced after it stays until the layer is retired
 * again.
 */
function retireConsoleLayers(
  registry: DevServerRegistry,
  matches: (layer: ConsoleLayer) => boolean,
): void {
  const target = console as unknown as ConsoleMethods;
  const layers = registry.consoleLayers;
  for (let index = layers.length - 1; index >= 0; index -= 1) {
    const layer = layers[index];
    if (matches(layer)) layer.retired = true;
    if (!layer.retired) continue;
    for (const [name, method] of Object.entries(layer.after)) {
      const replaced = layer.links.get(name)!.target;
      if (target[name] === method) {
        Object.defineProperty(target, name, { value: replaced });
      } else {
        const above = layers
          .slice(index + 1)
          .find((upper) => upper.links.get(name)?.target === method);
        if (!above) continue;
        above.links.get(name)!.target = replaced;
      }
      delete layer.after[name];
    }
    if (Object.keys(layer.after).length === 0) layers.splice(index, 1);
  }
}

// The build requires it from CommonJS, once per copy, before it replaces the
// console methods, and has replaced them once it has finished evaluating.
//
// A disabled hook no longer hears of resources being destroyed, and React's
// drops what it recorded for one only then. Async ids only increase, so the
// ones it can have recorded are those created while it was enabled: it's
// called for each, in slices so a long session's don't block the restart.
function asyncHooksModule(build: string): string {
  return `"use strict";
const BUILD = ${JSON.stringify(build)};
const asyncHooks = require("node:async_hooks");
const consoleLayer = globalThis[Symbol.for(${JSON.stringify(REGISTRY.description)})]?.consoleLayer("react-server-dom:" + BUILD);
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
      const previous = owner.hooks.get(BUILD);
      if (previous?.of === hook) return enable.call(this);
      // The server evaluated the build again, as after a full reload: the
      // previous copy no longer renders.
      previous?.release();
      const firstAsyncId = newestAsyncId();
      owner.hooks.set(BUILD, {
        of: hook,
        release() {
          hook.disable();
          if (typeof callbacks.destroy === "function") {
            destroyAll(callbacks.destroy, firstAsyncId, newestAsyncId());
          }
        },
      });
      return enable.call(this);
    };
    return hook;
  },
};
`;
}

/** For the dev optimizer's Rolldown pipeline, which pre-bundles the build. */
export const reactServerDomAsyncHookOptimizeDepsPlugin: Plugin = {
  name: "vinext:react-server-dom-async-hook:optimize-deps",
  resolveId: {
    filter: { id: /^(?:node:)?async_hooks$/ },
    handler(_id, importer) {
      if (
        importer &&
        // Its own id ends with the build's path.
        !importer.startsWith(REACT_SERVER_DOM_ASYNC_HOOKS_ID) &&
        REACT_SERVER_DOM_NODE_DEVELOPMENT_BUILD.test(toSlash(importer))
      ) {
        return `${REACT_SERVER_DOM_ASYNC_HOOKS_ID}?${toSlash(importer)}`;
      }
    },
  },
  load: {
    filter: { id: new RegExp(`^${REACT_SERVER_DOM_ASYNC_HOOKS_ID}\\?`) },
    handler(id) {
      // After the "?": the build's path.
      return asyncHooksModule(id.slice(REACT_SERVER_DOM_ASYNC_HOOKS_ID.length + 1));
    },
  },
};

/**
 * Records each dev server, and when it closes disables its hooks and puts back
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
      const owner: DevServerOwner = { closed: false, hooks: new Map() };
      const registry = devServerRegistry();
      registry.live.add(owner);
      for (const environment of Object.values(server.environments)) {
        owners.set(environment, owner);
        if (!isRunnableDevEnvironment(environment)) continue;
        // Instrumentation at startup and the re-imports of a full reload are
        // outside a request.
        const runner = environment.runner;
        const importModule = runner.import.bind(runner);
        runner.import = ((url: string) =>
          registry.scope.run(owner, () => importModule(url))) as typeof runner.import;
      }
      // A module's own import() doesn't go through the runner's import().
      server.middlewares.use((_req, _res, next) => registry.scope.run(owner, next));
    },
    closeBundle() {
      const owner = owners.get(this.environment);
      if (!owner || owner.closed) return;
      owner.closed = true;
      for (const hook of owner.hooks.values()) hook.release();
      owner.hooks.clear();
      const registry = devServerRegistry();
      registry.live.delete(owner);
      retireConsoleLayers(registry, (layer) => layer.owner === owner);
    },
  };
}
