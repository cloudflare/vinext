import type { Plugin } from "vite";

/**
 * Patch react-server-dom-webpack dev builds to avoid crashes in Vite's
 * module runner.
 *
 * React 19's development builds include aggressive error/stack reconstruction
 * logic (`resolveErrorDev`, `parseStackTrace`, `buildFakeCallStack`,
 * `console.createTask`) that crashes in Vite's module runner because:
 *
 * 1. `task.debugStack` can be `undefined` (not `null`), but the code uses
 *    strict equality `null !== task.debugStack` which doesn't catch `undefined`.
 *
 * 2. `parseStackTrace(error, skip)` is called with `undefined` error objects,
 *    crashing on `error.stack`.
 *
 * 3. `console.createTask()` (V8 devtools API) behaves differently in Vite's
 *    module runner context and can throw.
 *
 * 4. `resolveErrorDev()` on the client side attempts full stack reconstruction
 *    using `buildFakeCallStack` and `console.createTask`, which crash without
 *    proper element ownership metadata.
 *
 * 5. Elements created by framework internals (vinext `__wrapper`,
 *    `@vitejs/plugin-rsc` Resources) lack `_debugStack`/`_debugTask`/
 *    `_debugInfo` properties, triggering "without development properties"
 *    thrown errors.
 *
 * These patches are applied at transform time via string replacement, targeting
 * both the standalone `react-server-dom-webpack` package and the vendor copy
 * bundled in `@vitejs/plugin-rsc/dist/vendor/react-server-dom/`.
 */
export function patchReactServerDom(): Plugin {
  return {
    name: "vinext:patch-react-server-dom",
    enforce: "pre",
    transform(code, id) {
      // Match both standalone and vendor copies of react-server-dom-webpack
      if (
        !(id.includes("react-server-dom-webpack") || id.includes("react-server-dom/cjs")) ||
        !id.includes(".development.")
      ) {
        return;
      }

      let patched = code;
      let changed = false;

      // 1. Fix debugStack null checks (undefined vs null)
      //    `null !== undefined` is `true`, so `undefined` passes the guard and
      //    reaches `parseStackTrace(task.debugStack, 1)` with an undefined arg.
      //    Using `!=` (loose) catches both `null` and `undefined`.
      if (patched.includes("task.debugStack")) {
        patched = patched.replace(/null === task\.debugStack/g, "null == task.debugStack");
        patched = patched.replace(/null !== task\.debugStack/g, "null != task.debugStack");
        changed = true;
      }

      // 2. Guard parseStackTrace against undefined/null error argument
      if (patched.includes("function parseStackTrace(error,")) {
        patched = patched.replace(
          /function parseStackTrace\(error,\s*skipFrames\)\s*\{/g,
          "function parseStackTrace(error, skipFrames) { if (error == null) return [];",
        );
        changed = true;
      }

      // 3. Disable console.createTask (crashes in Vite's module runner)
      if (patched.includes("supportsCreateTask = !!console.createTask")) {
        patched = patched.replace(
          /supportsCreateTask = !!console\.createTask/g,
          "supportsCreateTask = false",
        );
        changed = true;
      }

      // 4. Guard buildFakeCallStack against undefined stack
      if (
        patched.includes(
          "function buildFakeCallStack(response, stack, environmentName, innerCall) {",
        )
      ) {
        patched = patched.replace(
          "function buildFakeCallStack(response, stack, environmentName, innerCall) {",
          "function buildFakeCallStack(response, stack, environmentName, innerCall) { if (!stack) return innerCall;",
        );
        changed = true;
      }

      // 5. Neuter resolveErrorDev to avoid stack reconstruction crashes (client-side).
      //    Instead of the full stack reconstruction path (which crashes), return a
      //    simple Error with the relevant metadata attached.
      if (patched.includes("function resolveErrorDev(response, errorInfo) {")) {
        patched = patched.replace(
          "function resolveErrorDev(response, errorInfo) {",
          `function resolveErrorDev(response, errorInfo) {
      var __err = new Error((errorInfo && errorInfo.message) || "RSC render error");
      __err.name = (errorInfo && errorInfo.name) || "Error";
      if (errorInfo) { __err.environmentName = errorInfo.env; __err.digest = errorInfo.digest; }
      return __err;`,
        );
        changed = true;
      }

      // 6. Suppress "without development properties" thrown errors.
      //    Framework internals create elements without dev metadata; in production
      //    this is fine, but dev builds throw. Convert to no-ops.
      if (patched.includes("without development properties")) {
        patched = patched.replace(
          /throw Error\(([^)]*without development properties[^)]*)\)/g,
          "void 0",
        );
        patched = patched.replace(
          /console\.error\(\s*([^)]*without development properties[^)]*)\)/g,
          "void 0",
        );
        changed = true;
      }

      if (changed) {
        return patched;
      }
    },
  };
}
