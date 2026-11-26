import fs from "node:fs";
import path, { toSlash } from "pathslash";
import type { Plugin } from "vite";
import type { TsconfigBaseUrlConfig, TsconfigBaseUrlLoad } from "../config/tsconfig-paths.js";

type TsconfigBaseUrlPluginOptions = {
  /**
   * Read the config whose explicit `compilerOptions.baseUrl` Next.js applies,
   * or null before vinext's config hook has run.
   */
  load: () => TsconfigBaseUrlLoad | null;
  /**
   * Re-read the `paths` aliases vinext materialized at startup (which resolve
   * against baseUrl) and report whether they changed.
   */
  pathAliasesChanged: () => boolean;
};

// Non-relative specifiers, as TypeScript resolves them through `baseUrl`:
// anything but absolute paths, `\0` virtual ids, package `#imports`, relative
// `./` / `../` paths, and scheme or drive-letter ids (`node:`, `virtual:`,
// `data:`, `C:/`).
const NON_RELATIVE_SPECIFIER_RE = /^[^/\\\0#]/;
const EXCLUDED_SPECIFIER_RES = [/^\.\.?(?:$|[/\\])/, /^[a-z][\w+.-]*:/i];
const QUERY_OR_HASH_RE = /[?#].*$/;

// Whether `node_modules/<package>` (a directory or a workspace symlink) exists
// at or above the importer, so standard resolution would find the package.
function isInstalledPackage(id: string, importer: string): boolean {
  const parts = id.split(/[?#]/, 1)[0].split("/");
  const packageName = id.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
  let dir = path.dirname(toSlash(importer));
  while (true) {
    if (fs.existsSync(path.join(dir, "node_modules", packageName))) return true;
    const parent = path.dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

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
    // changes the selected baseUrl or the aliases, restart the server so all
    // of them are read again.
    configureServer(server) {
      const watched = new Set(loaded?.watchFiles);
      server.watcher.add([...watched]);
      const onConfigFileEvent = (file: string) => {
        if (!watched.has(toSlash(file))) return;
        const next = options.load();
        const added = (next?.watchFiles ?? []).filter((watchFile) => !watched.has(watchFile));
        for (const watchFile of added) watched.add(watchFile);
        if (added.length > 0) server.watcher.add(added);
        const aliasesChanged = options.pathAliasesChanged();
        if (!aliasesChanged && sameBaseUrlConfig(loaded?.config ?? null, next?.config ?? null)) {
          return;
        }
        loaded = next;
        server.config.logger.info(`${path.basename(file)} changed, restarting server...`, {
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
        const options = { ...resolveOptions, skipSelf: true };
        const resolved = await this.resolve(path.join(baseUrl, id), importer, options);
        // No file under baseUrl: standard resolution proceeds untouched.
        if (!resolved || resolved.external || isJsonRequest(resolved.id)) return null;
        // Like Vite's native resolve.tsconfigPaths, other resolvers (later pre
        // plugins, virtual modules) claim the bare id first; baseUrl still
        // takes precedence over an installed package of that name.
        if (isInstalledPackage(id, importer)) return resolved;
        let standard: Awaited<ReturnType<typeof this.resolve>> = null;
        try {
          standard = await this.resolve(id, importer, options);
        } catch {
          // e.g. an unexported package subpath: baseUrl resolves it.
        }
        return standard && !standard.external ? standard : resolved;
      },
    },
  };
}
