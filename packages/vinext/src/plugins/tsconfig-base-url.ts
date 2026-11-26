import path, { toSlash } from "pathslash";
import type { Plugin } from "vite";
import type { TsconfigBaseUrlConfig, TsconfigBaseUrlLoad } from "../config/tsconfig-paths.js";

type TsconfigBaseUrlPluginOptions = {
  /**
   * Read the config whose explicit `compilerOptions.baseUrl` Next.js applies,
   * or null before vinext's config hook has run.
   */
  load: () => TsconfigBaseUrlLoad | null;
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

function sameBaseUrlConfig(
  a: TsconfigBaseUrlConfig | null,
  b: TsconfigBaseUrlConfig | null,
): boolean {
  return a?.configPath === b?.configPath && a?.baseUrl === b?.baseUrl;
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
  // The baseUrl to apply, or null when Vite's native resolve.tsconfigPaths
  // already reads the config that sets it (or none does).
  let baseUrl: string | null = null;
  let loaded: TsconfigBaseUrlLoad | null = null;
  return {
    name: "vinext:tsconfig-base-url",
    enforce: "pre",
    // Decided from the final config: any plugin's config hook can set Vite's
    // top-level `tsconfig` (the file the native resolver reads, else it
    // discovers tsconfig.json) or `resolve.tsconfigPaths`.
    configResolved(config) {
      loaded = options.load();
      const baseUrlConfig = loaded?.config ?? null;
      const nativeConfigPath = config.tsconfig
        ? toSlash(config.tsconfig)
        : path.join(toSlash(config.root), "tsconfig.json");
      const nativeReadsBaseUrlConfig =
        config.resolve.tsconfigPaths === true && baseUrlConfig?.configPath === nativeConfigPath;
      baseUrl = baseUrlConfig && !nativeReadsBaseUrlConfig ? baseUrlConfig.baseUrl : null;
    },
    // vinext derives `baseUrl` and the `paths` aliases (which resolve against
    // it) at startup, and Vite only refreshes its own cache for
    // `tsconfig.json`. When an edit to a candidate config or one it extends
    // changes the selected baseUrl, restart the server so all of them are
    // read again.
    configureServer(server) {
      const watched = new Set(loaded?.watchFiles);
      server.watcher.add([...watched]);
      const onConfigFileEvent = (file: string) => {
        if (!watched.has(toSlash(file))) return;
        const next = options.load();
        const added = (next?.watchFiles ?? []).filter((watchFile) => !watched.has(watchFile));
        for (const watchFile of added) watched.add(watchFile);
        if (added.length > 0) server.watcher.add(added);
        if (sameBaseUrlConfig(loaded?.config ?? null, next?.config ?? null)) return;
        loaded = next;
        server.config.logger.info(`${path.basename(file)} changed baseUrl, restarting server...`, {
          clear: server.config.clearScreen,
          timestamp: true,
        });
        void server.restart();
      };
      server.watcher.on("add", onConfigFileEvent);
      server.watcher.on("change", onConfigFileEvent);
      server.watcher.on("unlink", onConfigFileEvent);
    },
    resolveId: {
      filter: { id: { include: NON_RELATIVE_SPECIFIER_RE, exclude: EXCLUDED_SPECIFIER_RES } },
      async handler(id, importer, resolveOptions) {
        if (!baseUrl || !importer || isJsonRequest(id)) return null;
        if (toSlash(importer).includes("/node_modules/")) return null;
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
