import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { createIdResolver, type Plugin, type Rollup } from "vite";

type ExternalModuleMode = "import" | "require";

type ResolvedExternal = {
  path: string;
  mode: ExternalModuleMode;
};

function realpath(resolvedPath: string): string {
  try {
    return fs.realpathSync(resolvedPath);
  } catch {
    return resolvedPath;
  }
}

function getExternalModuleMode(kind: Rollup.ImportKind | undefined): ExternalModuleMode {
  return kind === "require-call" ? "require" : "import";
}

export function compareTransitiveExternalResolutions(
  importerResolved: ResolvedExternal,
  rootResolved: ResolvedExternal | null,
): string | null {
  const importerReal = realpath(importerResolved.path);
  if (!rootResolved) return importerReal;

  const rootReal = realpath(rootResolved.path);
  if (importerReal === rootReal && importerResolved.mode === rootResolved.mode) return null;
  return importerReal;
}

/**
 * Transitive-externals resolution for `serverExternalPackages`.
 *
 * This plugin is inert on Cloudflare / Nitro deployment targets: those
 * builds bundle everything (no `resolve.external` entries), so the
 * configured external set is empty and `resolveId` short-circuits on the
 * `set.size === 0` check. It only does work for Node-server targets that
 * actually populate `serverExternalPackages`.
 */

/**
 * Decide whether an external request from `importer` would resolve to a
 * different installed copy than the same request from the project root.
 *
 * Returns the absolute resolved path (i.e. the importer's nested copy)
 * when the resolutions differ, or `null` when they're identical (or when
 * resolution fails — in that case we leave the request external and let
 * Vite/Node handle it normally).
 *
 * This mirrors Next.js's webpack handler, which refuses to externalize a
 * request when the resolution from the importer context differs from the
 * project-root resolution (`baseResolveCheck`). Once the request is
 * resolved to an absolute path, Vite no longer matches it against
 * `resolve.external` (which is a list of bare specifiers), so the module
 * gets bundled with the importer instead of being left as a runtime
 * `import "lodash"` that would resolve to the wrong version.
 *
 * See:
 * https://github.com/vercel/next.js/blob/canary/packages/next/src/build/handle-externals.ts
 */
export function resolveTransitiveExternal(
  request: string,
  importer: string,
  rootResolver: NodeRequire,
): string | null {
  let importerResolved: string;
  try {
    const importerRequire = createRequire(importer);
    importerResolved = importerRequire.resolve(request);
  } catch {
    return null;
  }

  let rootResolved: string;
  try {
    rootResolved = rootResolver.resolve(request);
  } catch {
    // Request can't be resolved from the root at all — that's a stronger
    // signal that the importer's nested copy is the only valid one.
    // Returning the importer-resolved path forces Vite to bundle it.
    return realpath(importerResolved);
  }

  return compareTransitiveExternalResolutions(
    { path: importerResolved, mode: "require" },
    { path: rootResolved, mode: "require" },
  );
}

/**
 * vinext:transitive-externals
 *
 * Force Vite to bundle (rather than externalize) imports of packages listed
 * in `serverExternalPackages` when the importer resolves them to a different
 * installed copy than the project root. Without this, two nested copies of
 * a transitive dependency collapse to a single version at runtime — the
 * importer ends up loading whichever copy happens to sit at the top-level
 * `node_modules/<dep>/`, regardless of the version it actually expects.
 *
 * Example layout:
 *
 *   node_modules/lodash/                  # v3.10.1 (root)
 *   node_modules/dep-a/                   # depends on lodash@3
 *   node_modules/dep-b/                   # depends on lodash@4
 *   node_modules/dep-b/node_modules/lodash/  # v4.17.21 (nested)
 *
 * With `serverExternalPackages: ['lodash']`, Vite would normally leave
 * every `import 'lodash'` as a bare runtime require. Both dep-a and dep-b
 * would then resolve `lodash` from the same `dist/server/node_modules/`
 * directory at runtime — only one version can win. This plugin detects
 * dep-b's case, returns the absolute path to its nested lodash copy, and
 * lets Vite bundle that copy alongside dep-b's code.
 *
 * Ports the `baseResolveCheck` behaviour from Next.js's webpack handler:
 * https://github.com/vercel/next.js/blob/canary/packages/next/src/build/handle-externals.ts
 */
export function createTransitiveExternalsPlugin(options: {
  /**
   * Lazy getters so the plugin can read the project root and the
   * resolved next.config values that are populated during
   * `configResolved` — after the plugin factory has already run.
   */
  getRoot: () => string | null;
  getExternalPackages: () => string[];
}): Plugin {
  let externalSet: Set<string> | null = null;
  let rootResolver: NodeRequire | null = null;
  let rootImporter: string | null = null;
  let importResolver: ReturnType<typeof createIdResolver> | null = null;
  let requireResolver: ReturnType<typeof createIdResolver> | null = null;

  return {
    name: "vinext:transitive-externals",
    enforce: "pre",

    configResolved(config) {
      const root = options.getRoot();
      if (!root) return;
      externalSet = new Set(options.getExternalPackages());
      rootImporter = path.join(root, "package.json");
      rootResolver = createRequire(rootImporter);
      importResolver = createIdResolver(config, {
        external: [],
        isRequire: false,
        noExternal: true,
      });
      requireResolver = createIdResolver(config, {
        external: [],
        isRequire: true,
        noExternal: true,
      });
    },

    resolveId(source, importer, resolveOptions) {
      // `resolve.external` is only configured on server environments (rsc,
      // ssr), so the client environment has nothing to disambiguate.
      // Bail out immediately to avoid per-import work on client builds.
      if (this.environment?.name === "client") return null;
      const set = externalSet;
      const resolver = rootResolver;
      const rootAnchor = rootImporter;
      const viteImportResolver = importResolver;
      const viteRequireResolver = requireResolver;
      if (!set || !resolver || !rootAnchor || !viteImportResolver || !viteRequireResolver)
        return null;
      if (!importer || set.size === 0) return null;
      // Only act on bare specifiers that match an externalised package.
      // Match either an exact package name or a subpath import (e.g.
      // "lodash/package.json"). Handle scoped packages too.
      let pkgName: string | null = null;
      if (source.startsWith("@")) {
        const parts = source.split("/");
        if (parts.length >= 2) pkgName = `${parts[0]}/${parts[1]}`;
      } else {
        pkgName = source.split("/")[0] ?? null;
      }
      if (!pkgName || !set.has(pkgName)) return null;

      // Skip importers that aren't real on-disk files (virtual modules,
      // \0-prefixed ids, etc.) — we can't anchor a Node resolver on them.
      if (importer.startsWith("\0") || importer.includes("?")) return null;
      if (!path.isAbsolute(importer)) return null;

      if (typeof this.resolve !== "function") {
        return resolveTransitiveExternal(source, importer, resolver);
      }

      const kind = resolveOptions.kind;
      const mode = getExternalModuleMode(kind);
      const environmentResolver = mode === "require" ? viteRequireResolver : viteImportResolver;
      return (async () => {
        const importerResolution = await environmentResolver(this.environment, source, importer);
        if (!importerResolution || !path.isAbsolute(importerResolution)) {
          return mode === "require" ? resolveTransitiveExternal(source, importer, resolver) : null;
        }

        const rootResolution = await environmentResolver(this.environment, source, rootAnchor);
        return compareTransitiveExternalResolutions(
          { path: importerResolution, mode },
          rootResolution && path.isAbsolute(rootResolution) ? { path: rootResolution, mode } : null,
        );
      })();
    },
  };
}

/** Test helper: build a plugin from a pre-resolved root and package list. */
export function _createPluginForTest(options: {
  root: string;
  externalPackages: string[];
}): Plugin {
  return createTransitiveExternalsPlugin({
    getRoot: () => options.root,
    getExternalPackages: () => options.externalPackages,
  });
}
