import { randomUUID } from "node:crypto";
import type { Plugin } from "vite";
import { toSlash } from "pathslash";

const REACT_SERVER_DOM_ASYNC_HOOKS_ID = "\0vinext:react-server-dom-async-hooks";

// React's Node development build of the Flight server, vendored by plugin-rsc
// or installed.
const REACT_SERVER_DOM_NODE_DEVELOPMENT_BUILD =
  /\/react-server-dom-webpack-server\.node\.development\.js$/;

// The process-wide map from the environment of a dev server to the hook its
// copy of the build enabled.
const ACTIVE_HOOKS = Symbol.for("vinext.reactServerDomAsyncHooks");

// The process-wide set of environments that have closed. A copy of the build
// that an environment was still evaluating when it closed must not enable its
// hook afterwards: nothing would disable it again. Holds one id per closed dev
// server environment, for the life of the process.
const CLOSED_OWNERS = Symbol.for("vinext.reactServerDomAsyncHooks.closed");

// Stands in the pre-bundled build for the environment that evaluates it. The
// pre-bundle is shared by every server that uses the same cache directory, so
// each server's transform writes its own.
const OWNER_PLACEHOLDER = "__VINEXT_REACT_SERVER_DOM_ASYNC_HOOK_OWNER__";
const OWNER_PLACEHOLDER_LITERAL = new RegExp(`(["'\`])${OWNER_PLACEHOLDER}\\1`, "g");

type ActiveHooks = Map<string, { disable(): unknown }>;

function activeHooks(): ActiveHooks {
  const scope = globalThis as typeof globalThis & { [ACTIVE_HOOKS]?: ActiveHooks };
  return (scope[ACTIVE_HOOKS] ??= new Map());
}

function closedOwners(): Set<string> {
  const scope = globalThis as typeof globalThis & { [CLOSED_OWNERS]?: Set<string> };
  return (scope[CLOSED_OWNERS] ??= new Set());
}

/**
 * Keeps one async_hooks hook from React's Node development Flight server per
 * dev server environment, for as long as that server runs.
 *
 * The build installs a hook that runs on every async resource each time it is
 * evaluated, and never removes it. Next.js loads it once per process. Vite's
 * module runner evaluates the pre-bundled build again for each dev server,
 * including on every restart, so the hooks would pile up. The build gets
 * node:async_hooks with a createHook whose hook, once enabled, replaces the
 * one enabled before it in the same environment of the same server, and is
 * disabled when that server closes. A copy still being evaluated when its
 * server closes does not enable its hook. Other live servers keep theirs.
 *
 * For the dev optimizer's Rolldown pipeline, the only place this build is
 * re-evaluated.
 */
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
      return [
        `"use strict";`,
        `const asyncHooks = require("node:async_hooks");`,
        `const activeHooks = (globalThis[Symbol.for(${JSON.stringify(ACTIVE_HOOKS.description)})] ??= new Map());`,
        `const closedOwners = (globalThis[Symbol.for(${JSON.stringify(CLOSED_OWNERS.description)})] ??= new Set());`,
        `const owner = ${JSON.stringify(OWNER_PLACEHOLDER)};`,
        `module.exports = Object.assign(Object.create(asyncHooks), {`,
        `  createHook(callbacks) {`,
        `    const hook = asyncHooks.createHook(callbacks);`,
        `    const enable = hook.enable;`,
        `    hook.enable = function () {`,
        `      if (closedOwners.has(owner)) {`,
        `        hook.disable();`,
        `        return this;`,
        `      }`,
        `      const previous = activeHooks.get(owner);`,
        `      if (previous && previous !== hook) previous.disable();`,
        `      activeHooks.set(owner, hook);`,
        `      return enable.call(this);`,
        `    };`,
        `    return hook;`,
        `  },`,
        `});`,
      ].join("\n");
    },
  },
};

/**
 * Ties the hooks of {@link reactServerDomAsyncHookOptimizeDepsPlugin} to the
 * dev server: names each environment's copy of the pre-bundled build, and
 * disables its hook when the environment closes.
 */
export function createReactServerDomAsyncHookOwnerPlugin(): Plugin {
  // One owner per environment instance: a restarted server can reuse these
  // plugin instances, and its new environments must not share the closed
  // ones' owners.
  const owners = new WeakMap<object, string>();
  const ownerOf = (environment: { name: string }) => {
    let owner = owners.get(environment);
    if (!owner) {
      owner = `${randomUUID()}:${environment.name}`;
      owners.set(environment, owner);
    }
    return owner;
  };
  return {
    name: "vinext:react-server-dom-async-hook:owner",
    apply: "serve",
    transform: {
      filter: { code: OWNER_PLACEHOLDER },
      handler(code, id) {
        // Only the optimizer's pre-bundles carry the generated module; app
        // code that happens to hold the same text is left alone.
        const cacheDir = `${toSlash(this.environment.config.cacheDir).replace(/\/$/, "")}/`;
        if (!toSlash(id).startsWith(cacheDir)) return null;
        // Replaces the whole string literal, in whichever quotes the optimizer
        // wrote it, so any environment name stays one literal, as written.
        const owner = JSON.stringify(ownerOf(this.environment));
        return { code: code.replace(OWNER_PLACEHOLDER_LITERAL, () => owner), map: null };
      },
    },
    closeBundle() {
      const owner = ownerOf(this.environment);
      closedOwners().add(owner);
      const hooks = activeHooks();
      hooks.get(owner)?.disable();
      hooks.delete(owner);
    },
  };
}
