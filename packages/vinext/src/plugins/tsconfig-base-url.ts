import path from "pathslash";
import type { Plugin } from "vite";

type TsconfigBaseUrlPluginOptions = {
  /**
   * The explicit `compilerOptions.baseUrl` to resolve bare imports against,
   * or null when Vite's native `resolve.tsconfigPaths` already reads the
   * config file that sets it (or none does).
   */
  getBaseUrl: () => string | null;
};

// Bare specifiers: no relative/absolute prefix, no `\0` virtual id, and no
// scheme (`node:`, `virtual:`, `data:`, Windows drive letters).
const BARE_SPECIFIER_RE = /^[\w@][^:]*$/;

/**
 * Resolve bare imports against an explicit tsconfig/jsconfig `baseUrl` that
 * Vite's native resolver doesn't read: `jsconfig.json` (Vite only discovers
 * `tsconfig.json`) and a custom `typescript.tsconfigPath` (native discovery is
 * off then).
 *
 * Like Turbopack (turbopack-resolve/src/typescript.rs
 * `apply_tsconfig_resolve_options`), `baseUrl` is tried before `node_modules`
 * and never applies to `.json` requests. Requests from `node_modules` keep
 * standard resolution, like tsconfig `paths` in Next.js webpack.
 */
export function createTsconfigBaseUrlPlugin(options: TsconfigBaseUrlPluginOptions): Plugin {
  return {
    name: "vinext:tsconfig-base-url",
    enforce: "pre",
    resolveId: {
      filter: { id: BARE_SPECIFIER_RE },
      async handler(id, importer, resolveOptions) {
        const baseUrl = options.getBaseUrl();
        if (!baseUrl || !importer || id.endsWith(".json")) return null;
        if (importer.includes("/node_modules/")) return null;
        const resolved = await this.resolve(path.join(baseUrl, id), importer, {
          ...resolveOptions,
          skipSelf: true,
        });
        if (!resolved || resolved.external || resolved.id.endsWith(".json")) return null;
        return resolved;
      },
    },
  };
}
