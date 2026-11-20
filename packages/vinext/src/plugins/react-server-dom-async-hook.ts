import { AsyncLocalStorage } from "node:async_hooks";
import type { Plugin } from "vite";
import { toSlash } from "pathslash";

/**
 * React's Node development Flight server enables an async_hooks hook when it
 * is evaluated, and never disables it. Next.js loads it once per process. In
 * Vite, a dev server's module runner evaluates it again, so each restart adds
 * a hook, and the hook keeps the closed server's React and module graph alive.
 *
 * The build's `async_hooks` resolves to a module that creates hooks through
 * `node:async_hooks` and records the dev server each one belongs to. When that
 * server closes, its hook is disabled. A live server's hook works as React
 * enabled it.
 */

const REACT_SERVER_DOM_ASYNC_HOOKS_ID = "\0vinext:react-server-dom-async-hooks";

// React's Node development build of the Flight server, vendored by plugin-rsc
// or installed. The static entry uses the same file.
const REACT_SERVER_DOM_NODE_DEVELOPMENT_BUILD =
  /\/react-server-dom-webpack-server\.node\.development\.js$/;

const REGISTRY = Symbol.for("vinext.reactServerDomAsyncHooks");

type FlightHookOwner = {
  closed: boolean;
  hook?: { disable(): unknown };
};

/**
 * Shared by this module and the build's copy of `async_hooks`, which the dev
 * server's module runner evaluates in the same realm.
 */
type FlightHookRegistry = {
  // The dev server a request runs for, so a build evaluated while serving it
  // is attributed to it.
  scope: AsyncLocalStorage<FlightHookOwner>;
  // The dev servers that are running.
  live: Set<FlightHookOwner>;
};

export function flightHookRegistry(): FlightHookRegistry {
  const scope = globalThis as typeof globalThis & { [REGISTRY]?: FlightHookRegistry };
  return (scope[REGISTRY] ??= { scope: new AsyncLocalStorage(), live: new Set() });
}

// The build requires it from CommonJS. A build evaluated outside a request,
// such as by instrumentation at startup, belongs to the only running server.
// With several running and no request, its hook isn't recorded.
const ASYNC_HOOKS_MODULE = `"use strict";
const asyncHooks = require("node:async_hooks");
const registry = globalThis[Symbol.for(${JSON.stringify(REGISTRY.description)})];
function ownerOfNewHook() {
  if (!registry) return undefined;
  const owner = registry.scope.getStore();
  if (owner) return owner;
  if (registry.live.size === 1) return registry.live.values().next().value;
  return undefined;
}
module.exports = {
  ...asyncHooks,
  createHook(callbacks) {
    const hook = asyncHooks.createHook(callbacks);
    const owner = ownerOfNewHook();
    if (!owner) return hook;
    const enable = hook.enable;
    hook.enable = function () {
      if (owner.closed) return this;
      // The server evaluated the build again, after re-optimizing its
      // dependencies: the previous copy no longer renders.
      if (owner.hook && owner.hook !== hook) owner.hook.disable();
      owner.hook = hook;
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

/** Records each dev server for the hooks, and disables a server's hook when it closes. */
export function createReactServerDomAsyncHookOwnerPlugin(): Plugin {
  const owners = new WeakMap<object, FlightHookOwner>();
  return {
    name: "vinext:react-server-dom-async-hook:owner",
    apply: "serve",
    // Its middleware has to run before the one that renders.
    enforce: "pre",
    configureServer(server) {
      const owner: FlightHookOwner = { closed: false };
      const registry = flightHookRegistry();
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
      owner.hook?.disable();
      owner.hook = undefined;
      flightHookRegistry().live.delete(owner);
    },
  };
}
