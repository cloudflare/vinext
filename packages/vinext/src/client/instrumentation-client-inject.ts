import fs from "node:fs";
import path from "node:path";

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
 * `resolveId`/`load`. It side-effect-imports each inject in config order, then
 * the user's file last, and exports a single composed `onRouterTransitionStart`
 * that fans out to every module's hook.
 *
 * **Specifier resolution:** Next.js webpack loader resolves every inject against
 * the project root at build time (`this.resolve(rootContext, spec)`) and emits
 * `require(resolvedPath)`. Vinext pre-resolves `./` and `../` in the plugin
 * `config()` hook; bare specifiers rely on Vite resolution at bundle time.
 *
 * @param injects - Module specifiers from `nextConfig.instrumentationClientInject`
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

  for (let i = 0; i < injects.length; i++) {
    lines.push(`import * as __vinj_${i} from ${JSON.stringify(injects[i])};`);
  }

  const userSlot = injects.length;
  lines.push(`import * as __vinj_${userSlot} from ${JSON.stringify(userPath ?? emptyModulePath)};`);

  const hookCalls: string[] = [];
  for (let i = 0; i <= userSlot; i++) {
    hookCalls.push(
      `  if (typeof __vinj_${i}.onRouterTransitionStart === "function") {`,
      `    __vinj_${i}.onRouterTransitionStart(url, type);`,
      `  }`,
    );
  }

  lines.push("");
  lines.push("export function onRouterTransitionStart(url, type) {");
  lines.push(...hookCalls);
  lines.push(`}`);
  lines.push("");

  return lines.join("\n");
}
