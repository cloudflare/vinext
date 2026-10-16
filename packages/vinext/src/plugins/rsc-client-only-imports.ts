import type { RscPluginManager } from "@vitejs/plugin-rsc";
import type { Plugin, ResolvedConfig } from "vite";
import path from "pathslash";

const CLIENT_ONLY_SPECIFIER_RE = /^client-only$/;
const INVALID_CLIENT_ONLY_ID = "\0virtual:vinext-invalid-client-only";
const INVALID_CLIENT_ONLY_ID_RE = /^\0virtual:vinext-invalid-client-only$/;

/**
 * Reject `client-only` in the RSC build only when it survives tree-shaking.
 *
 * @vitejs/plugin-rsc's `rsc:validate-imports` checks its `client-only` import
 * chain in `buildEnd`, before tree-shaking. A Server Component that imports
 * one export from a `sideEffects: false` barrel then fails the build when an
 * unused leaf of that barrel imports `client-only`, even though the bundler
 * drops the leaf and its marker from the output.
 *
 * Next.js (Turbopack) maps `client-only` in the server graph to an import
 * error that is only reported for modules that stay in the tree-shaken
 * module graph:
 *   crates/next-core/src/next_import_map.rs (insert_client_only_error_alias)
 * (Next.js's webpack build still rejects these barrels before tree-shaking.)
 *
 * This plugin claims the RSC build's `client-only` resolutions before
 * plugin-rsc does, and checks the emitted RSC chunks instead. The marker
 * module has side effects, so it stays in the output whenever any module that
 * imports it is retained, including direct imports from application code.
 * Dev keeps plugin-rsc's resolution-time check because Vite dev does not
 * tree-shake.
 */
export function createRscClientOnlyImportsPlugin(options: {
  getManager: (config: ResolvedConfig) => Promise<RscPluginManager | undefined>;
}): Plugin {
  let enabled = false;

  return {
    name: "vinext:rsc-client-only-imports",
    apply: "build",
    // Ahead of plugin-rsc's `order: "pre"` resolveId hook.
    enforce: "pre",
    configResolved(resolvedConfig) {
      // Respect `rsc({ validateImports: false })` in a manual plugin-rsc setup.
      enabled = resolvedConfig.plugins.some((plugin) => plugin.name === "rsc:validate-imports");
    },
    resolveId: {
      order: "pre",
      filter: { id: CLIENT_ONLY_SPECIFIER_RE },
      handler() {
        if (!enabled || this.environment.name !== "rsc") return;
        return { id: INVALID_CLIENT_ONLY_ID, moduleSideEffects: true };
      },
    },
    load: {
      filter: { id: INVALID_CLIENT_ONLY_ID_RE },
      handler() {
        return `throw new Error("'client-only' cannot be imported from a Server Component module. It should only be used from a Client Component.");`;
      },
    },
    async generateBundle(_outputOptions, bundle) {
      if (!enabled || this.environment.name !== "rsc") return;
      // The scan build reduces every module to its imports, so nothing is
      // tree-shaken there. The real RSC build that follows does the check.
      if ((await options.getManager(this.environment.config))?.isScanBuild) return;

      const retained = new Set<string>();
      for (const output of Object.values(bundle)) {
        if (output.type !== "chunk") continue;
        for (const id of output.moduleIds) retained.add(id);
      }
      if (!retained.has(INVALID_CLIENT_ONLY_ID)) return;

      // Report a chain through modules that are in the output, so the error
      // names the import that kept the marker rather than a dropped one.
      const chain: string[] = [];
      let current: string | undefined = INVALID_CLIENT_ONLY_ID;
      while (current && !chain.includes(current)) {
        chain.push(current);
        const info = this.getModuleInfo(current);
        const importers = info ? [...info.importers, ...info.dynamicImporters] : [];
        current = importers.find((id) => retained.has(id) && !chain.includes(id)) ?? importers[0];
      }
      throw createClientOnlyImportError(chain, this.environment.config.root);
    },
  };
}

// Same message shape as plugin-rsc's `rsc:validate-imports` so dev and build
// report the import chain the same way.
function createClientOnlyImportError(chain: string[], root: string): Error {
  let message = `'client-only' cannot be imported in server build ('rsc' environment):\n`;
  message += chain
    .slice(1, 6)
    .map(
      (id, i) =>
        `${" ".repeat(i + 1)}imported by ${path.relative(root, id).replaceAll("\0", "")}\n`,
    )
    .join("");
  if (chain.length > 6) message += `${" ".repeat(7)}...\n`;
  const error = new Error(message);
  if (chain[1]) Object.assign(error, { id: chain[1] });
  return error;
}
