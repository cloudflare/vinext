import type { Plugin } from "vite";
import { toSlash } from "pathslash";

const REACT_SERVER_DOM_ASYNC_HOOKS_ID = "\0vinext:react-server-dom-async-hooks";

// React's Node development build of the Flight server, vendored by plugin-rsc
// or installed.
const REACT_SERVER_DOM_NODE_DEVELOPMENT_BUILD =
  /\/react-server-dom-webpack-server\.node\.development\.js$/;

/**
 * Keeps one async_hooks hook from React's Node development Flight server per
 * process.
 *
 * The build installs a hook that runs on every async resource each time it is
 * evaluated, and never removes it. Next.js loads it once per process. Vite's
 * module runner evaluates the pre-bundled build again for each dev server,
 * including on every restart, so the hooks would pile up. The build gets
 * node:async_hooks with a createHook whose hooks disable the previous one when
 * they are enabled.
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
        `const activeHook = Symbol.for("vinext.reactServerDomAsyncHook");`,
        `module.exports = Object.assign(Object.create(asyncHooks), {`,
        `  createHook(callbacks) {`,
        `    const hook = asyncHooks.createHook(callbacks);`,
        `    const enable = hook.enable;`,
        `    hook.enable = function () {`,
        `      const previous = globalThis[activeHook];`,
        `      if (previous && previous !== hook) previous.disable();`,
        `      globalThis[activeHook] = hook;`,
        `      return enable.call(this);`,
        `    };`,
        `    return hook;`,
        `  },`,
        `});`,
      ].join("\n");
    },
  },
};
