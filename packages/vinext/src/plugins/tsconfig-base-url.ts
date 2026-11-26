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

// Non-relative specifiers, as TypeScript resolves them through `baseUrl`:
// anything but absolute paths, `\0` virtual ids, package `#imports`, relative
// `./` / `../` paths, and scheme or drive-letter ids (`node:`, `virtual:`,
// `data:`, `C:/`).
const NON_RELATIVE_SPECIFIER_RE = /^[^/\\\0#]/;
const EXCLUDED_SPECIFIER_RES = [/^\.\.?(?:$|[/\\])/, /^[a-z][\w+.-]*:/i];
const QUERY_OR_HASH_RE = /[?#].*$/;

function isJsonRequest(id: string): boolean {
  return id.replace(QUERY_OR_HASH_RE, "").endsWith(".json");
}

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
      filter: { id: { include: NON_RELATIVE_SPECIFIER_RE, exclude: EXCLUDED_SPECIFIER_RES } },
      async handler(id, importer, resolveOptions) {
        const baseUrl = options.getBaseUrl();
        if (!baseUrl || !importer || isJsonRequest(id)) return null;
        if (importer.includes("/node_modules/")) return null;
        const resolved = await this.resolve(path.join(baseUrl, id), importer, {
          ...resolveOptions,
          skipSelf: true,
        });
        if (!resolved || resolved.external || isJsonRequest(resolved.id)) return null;
        return resolved;
      },
    },
  };
}
