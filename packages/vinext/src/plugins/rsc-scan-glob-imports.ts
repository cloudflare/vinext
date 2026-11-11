import type { RscPluginManager } from "@vitejs/plugin-rsc";
import type { Plugin, ResolvedConfig } from "vite";
import { isVersionBelow } from "../utils/react-version.js";

/**
 * @vitejs/plugin-rsc 0.5.36 and 0.5.37 reduce scan-build modules to their
 * import specifiers with es-module-lexer v3, which reports template-literal
 * dynamic imports as glob patterns (``import(`file://${p}`)`` becomes
 * `"file://*"`). The scan then emits them as plain imports, which fail to
 * resolve (e.g. in @module-federation/vite). Other versions skip these
 * specifiers (0.5.38 via vitejs/vite-plugin-react#1506), so for the affected
 * ones keep the specifiers that don't resolve external during the scan. A real
 * module whose specifier contains `*` still resolves and stays in the scan
 * graph. The scan's output is discarded, so nothing else changes.
 */
export function isRscScanGlobImportsAffected(version: string): boolean {
  return !isVersionBelow(version, [0, 5, 36]) && isVersionBelow(version, [0, 5, 38]);
}

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
