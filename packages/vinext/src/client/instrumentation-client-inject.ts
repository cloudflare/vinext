/**
 * Generate a virtual ESM module that implements the Next.js
 * `instrumentationClientInject` contract for client bootstrap.
 *
 * Resolution follows two paths depending on whether injects are configured:
 *
 * **Empty injects (`injects.length === 0`):** Returns `export {}` and the
 * plugin does not serve a virtual module. The `resolve.alias` for
 * `private-next-instrumentation-client` resolves directly to the user's
 * `instrumentation-client` file (or `vinext/client/empty-module` when absent),
 * so the user's `onRouterTransitionStart` is used as-is with no composition.
 *
 * **Non-empty injects:** The plugin serves this generated module via
 * `resolveId`/`load`. It side-effect-imports each inject in config order, then
 * the user's file last, and exports a single composed `onRouterTransitionStart`
 * that fans out to every module's hook.
 *
 * @param injects - Module specifiers from `nextConfig.instrumentationClientInject`
 * @param userPath - Absolute path to the user's `instrumentation-client` file,
 *                   or `null` when the file doesn't exist
 */
export function generateInstrumentationClientInjectModule(
  injects: readonly string[],
  userPath: string | null,
): string {
  const EMPTY_MODULE = "vinext/client/empty-module";

  // No injects: Next.js keeps the current transparent passthrough.
  // The alias already handles the user file or empty-module, so emit
  // nothing that could shadow what the alias resolves.
  if (injects.length === 0) {
    return "export {};";
  }

  const lines: string[] = [];

  for (let i = 0; i < injects.length; i++) {
    lines.push(`import * as __vinj_${i} from ${JSON.stringify(injects[i])};`);
  }

  const lastIndex = injects.length;
  lines.push(`import * as __vinj_${lastIndex} from ${JSON.stringify(userPath ?? EMPTY_MODULE)};`);

  const hookCalls: string[] = [];
  for (let i = 0; i <= lastIndex; i++) {
    hookCalls.push(
      `  if (typeof __vinj_${i}.onRouterTransitionStart === "function") {`,
      `    __vinj_${i}.onRouterTransitionStart(url, type);`,
      `  }`,
    );
  }

  lines.push("");
  lines.push("export function onRouterTransitionStart(url: string, type: string) {");
  lines.push(...hookCalls);
  lines.push(`}`);
  lines.push("");

  return lines.join("\n");
}
