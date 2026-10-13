import type { RscPluginManager } from "@vitejs/plugin-rsc";
import type { Plugin, ResolvedConfig } from "vite";

/**
 * Affected @vitejs/plugin-rsc versions start at 0.5.36. Its scan build reduces
 * modules to their import specifiers with es-module-lexer v3, which reports
 * template-literal dynamic imports as glob patterns
 * (``import(`file://${p}`)`` becomes `"file://*"`). The scan then emits them as
 * plain imports, which fail to resolve (e.g. in @module-federation/vite).
 * Earlier versions skipped these specifiers, so keep the ones that don't
 * resolve external during the scan. A real module whose specifier contains
 * `*` still resolves and stays in the scan graph. The scan's output is
 * discarded, so nothing else changes.
 *
 * TODO: cap the version gate at the plugin-rsc release that skips glob
 * specifiers itself (vitejs/vite-plugin-react#1506).
 */
export const RSC_SCAN_GLOB_IMPORTS_AFFECTED_FROM: [number, number, number] = [0, 5, 36];

export function createRscScanGlobImportsPlugin(options: {
  getManager: (config: ResolvedConfig) => Promise<RscPluginManager | undefined>;
}): Plugin {
  return {
    name: "vinext:rsc-scan-glob-imports",
    apply: "build",
    enforce: "pre",
    resolveId: {
      filter: { id: /\*/ },
      async handler(source, importer, resolveOptions) {
        const manager = await options.getManager(this.environment.config);
        if (!manager?.isScanBuild) return;
        try {
          const resolved = await this.resolve(source, importer, {
            ...resolveOptions,
            skipSelf: true,
          });
          if (resolved) return resolved;
        } catch {}
        return { id: source, external: true };
      },
    },
  };
}
