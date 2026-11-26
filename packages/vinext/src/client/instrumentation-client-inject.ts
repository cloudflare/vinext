import fs from "node:fs";
import path from "pathslash";
import { INSTRUMENTATION_CLIENT_HOOK_FAILED_MESSAGE } from "./instrumentation-client-state.js";

/** Resolve empty-module next to this file (.js in dist, .ts in source). */
function resolveInstrumentationClientEmptyModule(dir: string): string {
  const jsPath = path.join(dir, "empty-module.js");
  if (fs.existsSync(jsPath)) return jsPath;
  return path.join(dir, "empty-module.ts");
}

/** Absolute path to the vinext empty-module fallback for composed client instrumentation. */
export const INSTRUMENTATION_CLIENT_EMPTY_MODULE = resolveInstrumentationClientEmptyModule(
  import.meta.dirname,
);

// An npm package name, optionally scoped, then an optional subpath. Path
// aliases (`@/x`, `~/x`) and subpath imports (`#x`) don't match.
const PACKAGE_SPECIFIER_RE = /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(?:\/|$)/i;

/**
 * Whether an `instrumentationClientInject` entry names a package, which the
 * client dependency optimizer can pre-bundle at startup.
 */
export function isPackageInjectSpecifier(spec: string): boolean {
  return PACKAGE_SPECIFIER_RE.test(spec);
}

/**
 * Generate a virtual ESM module that implements the Next.js
 * `instrumentationClientInject` contract for client bootstrap.
 *
 * Resolution follows two paths depending on whether injects are configured:
 *
 * **Empty injects (`injects.length === 0`):** Returns `export {}` and the
 * plugin does not serve a virtual module. The `resolve.alias` for
 * `private-next-instrumentation-client` resolves directly to the user's
 * `instrumentation-client` file (or {@link INSTRUMENTATION_CLIENT_EMPTY_MODULE} when absent),
 * so the user's `onRouterTransitionStart` is used as-is with no composition.
 *
 * **Non-empty injects:** The plugin serves this generated module via
 * `resolveId`/`load`. It imports each inject in config order, then the user's
 * file last, and exports a single `onRouterTransitionStart` that fans out to
 * every module. Like Next.js' `callHooks` (client/components/router-transition.ts),
 * it reads each module's hook when a transition starts, so a CommonJS module
 * can install it after load, and it isolates each hook's errors.
 *
 * Next.js `require()`s each inject, so a CommonJS inject's hooks live on its
 * live `module.exports`. A namespace import of CommonJS (Rolldown's interop in
 * builds, Vite's optimized-dep interop in dev) copies `module.exports` when it
 * loads and exposes the live object as `default`. So a hook the inject's
 * namespace lacks is read from `default`.
 *
 * **Specifier resolution:** Next.js webpack loader resolves every inject against
 * the project root at build time (`this.resolve(rootContext, spec)`) and emits
 * `require(resolvedPath)`. Vinext pre-resolves `./` and `../` in the plugin
 * `config()` hook; bare specifiers rely on Vite resolution at bundle time.
 *
 * @param injects - Entries from `nextConfig.instrumentationClientInject`
 * @param userPath - Absolute path to the user's `instrumentation-client` file,
 *                   or `null` when the file doesn't exist
 * @param emptyModulePath - Absolute path to the empty-module fallback
 */
export function generateInstrumentationClientInjectModule(
  injects: readonly string[],
  userPath: string | null,
  emptyModulePath: string = INSTRUMENTATION_CLIENT_EMPTY_MODULE,
): string {
  if (injects.length === 0) {
    return "export {};";
  }

  const lines: string[] = [];
  const modules: string[] = [];

  for (let i = 0; i < injects.length; i++) {
    lines.push(`import * as __vinj_${i} from ${JSON.stringify(injects[i])};`);
    modules.push(`__vinj_${i}`);
  }

  // The user's instrumentation-client is ESM: its namespace holds its hooks.
  const userSlot = injects.length;
  lines.push(`import * as __vinj_${userSlot} from ${JSON.stringify(userPath ?? emptyModulePath)};`);

  lines.push(
    "",
    `const __vinext_inject_modules = [${modules.join(", ")}];`,
    "",
    "// Reads a module's hook once, as Next.js's optional call does: a CommonJS",
    "// namespace's export can be a live getter. A namespace without the export",
    "// reads it from its default export instead.",
    "function __vinext_inject_hook(namespace) {",
    '  if ("onRouterTransitionStart" in namespace) {',
    "    return { hooks: namespace, hook: namespace.onRouterTransitionStart };",
    "  }",
    "  const exports = namespace.default;",
    '  return exports !== null && (typeof exports === "object" || typeof exports === "function")',
    "    ? { hooks: exports, hook: exports.onRouterTransitionStart }",
    "    : { hooks: namespace, hook: undefined };",
    "}",
    "",
    "export function onRouterTransitionStart(url, type, event) {",
    `  for (let index = 0; index <= __vinext_inject_modules.length; index++) {`,
    "    try {",
    "      // Every hook read is inside the try, since a getter can throw.",
    "      const { hooks, hook } =",
    "        index < __vinext_inject_modules.length",
    "          ? __vinext_inject_hook(__vinext_inject_modules[index])",
    `          : { hooks: __vinj_${userSlot}, hook: __vinj_${userSlot}.onRouterTransitionStart };`,
    "      // Next.js builds the start event per hook, so one hook's mutation",
    "      // never reaches the next. Reflect.apply calls the hook itself, even",
    "      // if it overrides call.",
    "      if (hook != null) {",
    "        Reflect.apply(hook, hooks, [",
    "          url,",
    "          type,",
    "          event == null ? event : { ...event, fromRoutes: [...event.fromRoutes] },",
    "        ]);",
    "      }",
    "    } catch (error) {",
    `      console.error(${JSON.stringify(INSTRUMENTATION_CLIENT_HOOK_FAILED_MESSAGE)}, error);`,
    "    }",
    "  }",
    "}",
    "",
  );

  return lines.join("\n");
}
