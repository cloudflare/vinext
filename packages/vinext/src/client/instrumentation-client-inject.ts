import fs from "node:fs";
import path from "pathslash";
import { parseSync } from "vite";
import { mayAssignCommonJsExports } from "../plugins/commonjs-syntax.js";
import { stripViteModuleQuery } from "../utils/path.js";
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

export type InstrumentationClientInject = {
  specifier: string;
  /**
   * The module is CommonJS, so its hooks live on `module.exports` (the default
   * import) instead of the ESM namespace.
   */
  commonjs: boolean;
};

/**
 * Whether an inject module is CommonJS. Next.js loads each inject with
 * `require()`, and webpack's `javascript/auto` treats a module without
 * `import`/`export` syntax as CommonJS, so `require()` returns its live
 * `module.exports`. A module with neither ESM syntax nor CommonJS exports is a
 * plain script, which the namespace import also covers.
 */
export function isCommonJsInstrumentationClientInject(code: string, id: string): boolean {
  if (!mayAssignCommonJsExports(code)) return false;
  const extension = path.extname(stripViteModuleQuery(id));
  const lang = /^\.[cm]?ts$/.test(extension) ? "ts" : extension === ".tsx" ? "tsx" : "jsx";
  const parsed = parseSync(id, code, { lang });
  return parsed.errors.length === 0 && !parsed.module.hasModuleSyntax;
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
  injects: readonly InstrumentationClientInject[],
  userPath: string | null,
  emptyModulePath: string = INSTRUMENTATION_CLIENT_EMPTY_MODULE,
): string {
  if (injects.length === 0) {
    return "export {};";
  }

  const lines: string[] = [];
  const modules: string[] = [];

  for (let i = 0; i < injects.length; i++) {
    const { specifier, commonjs } = injects[i];
    lines.push(
      commonjs
        ? `import __vinj_${i} from ${JSON.stringify(specifier)};`
        : `import * as __vinj_${i} from ${JSON.stringify(specifier)};`,
    );
    modules.push(`__vinj_${i}`);
  }

  const userSlot = injects.length;
  lines.push(`import * as __vinj_${userSlot} from ${JSON.stringify(userPath ?? emptyModulePath)};`);
  modules.push(`__vinj_${userSlot}`);

  lines.push(
    "",
    `const __vinext_instrumentation_modules = [${modules.join(", ")}];`,
    "",
    "export function onRouterTransitionStart(url, type, event) {",
    "  for (const hooks of __vinext_instrumentation_modules) {",
    "    if (hooks == null) continue;",
    "    try {",
    "      hooks.onRouterTransitionStart?.(url, type, event);",
    "    } catch (error) {",
    `      console.error(${JSON.stringify(INSTRUMENTATION_CLIENT_HOOK_FAILED_MESSAGE)}, error);`,
    "    }",
    "  }",
    "}",
    "",
  );

  return lines.join("\n");
}
