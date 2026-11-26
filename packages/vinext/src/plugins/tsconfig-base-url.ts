import path, { toSlash } from "pathslash";
import type { Plugin } from "vite";
import type { TsconfigBaseUrlLoad } from "../config/tsconfig-paths.js";

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
  let watchFiles = new Set<string>();
  // The config Vite's native resolver reads, when it reads one.
  let nativeConfigPath: string | null = null;

  function load(): void {
    const loaded = options.load();
    const baseUrlConfig = loaded?.config ?? null;
    watchFiles = new Set(loaded?.watchFiles);
    baseUrl =
      baseUrlConfig && baseUrlConfig.configPath !== nativeConfigPath ? baseUrlConfig.baseUrl : null;
  }

  return {
    name: "vinext:tsconfig-base-url",
    enforce: "pre",
    // Decided from the final config: any plugin's config hook can set Vite's
    // top-level `tsconfig` (the file the native resolver reads, else it
    // discovers tsconfig.json) or `resolve.tsconfigPaths`.
    configResolved(config) {
      nativeConfigPath =
        config.resolve.tsconfigPaths !== true
          ? null
          : config.tsconfig
            ? toSlash(config.tsconfig)
            : path.join(toSlash(config.root), "tsconfig.json");
      load();
    },
    // Like Vite's own tsconfig.json handling (reloadOnTsconfigChange), a change
    // to a candidate config or one it extends re-reads baseUrl, then
    // invalidates every module and reloads.
    configureServer(server) {
      server.watcher.add([...watchFiles]);
      const onConfigFileEvent = (file: string) => {
        if (!watchFiles.has(toSlash(file))) return;
        const previousBaseUrl = baseUrl;
        const previousWatchFiles = watchFiles;
        load();
        const added = [...watchFiles].filter((watched) => !previousWatchFiles.has(watched));
        if (added.length > 0) server.watcher.add(added);
        if (baseUrl === previousBaseUrl) return;
        server.config.logger.info(
          `changed baseUrl config detected: ${file} - invalidating modules and forcing full-reload.`,
          { clear: server.config.clearScreen, timestamp: true },
        );
        for (const environment of Object.values(server.environments)) {
          environment.moduleGraph.invalidateAll();
        }
        for (const environment of Object.values(server.environments)) {
          environment.hot.send({ type: "full-reload", path: "*" });
        }
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
