import fs from "node:fs";
import path from "node:path";
import { builtinModules } from "node:module";
import type { Plugin } from "vite";

const BUILTIN_MODULES = new Set(
  builtinModules.flatMap((name) =>
    name.startsWith("node:") ? [name, name.slice(5)] : [name, `node:${name}`],
  ),
);

/**
 * Extract the npm package name from a bare module specifier.
 *
 * Returns null for:
 *  - Relative imports ("./foo", "../bar")
 *  - Absolute paths ("/abs/path")
 *  - Node built-ins ("node:fs")
 *  - Package self-references ("#imports")
 */
export function packageNameFromSpecifier(specifier: string): string | null {
  if (
    !specifier ||
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    specifier.startsWith("\\") ||
    specifier.startsWith("#")
  ) {
    return null;
  }

  // External specifiers can include non-package schemes such as
  // "virtual:vite-rsc" or "file:...". Those are never npm packages.
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(specifier)) {
    return null;
  }

  if (specifier.startsWith("@")) {
    const parts = specifier.split("/");
    if (parts.length >= 2) {
      return `${parts[0]}/${parts[1]}`;
    }
    return null;
  }

  const packageName = specifier.split("/")[0] || null;
  if (!packageName || BUILTIN_MODULES.has(specifier) || BUILTIN_MODULES.has(packageName)) {
    return null;
  }
  return packageName;
}

/**
 * vinext:server-externals-manifest
 *
 * A `writeBundle` plugin that collects the packages left external by the
 * SSR/RSC bundler and writes them to `<outDir>/vinext-externals.json`.
 *
 * With `noExternal: true`, Vite bundles almost everything — only packages
 * explicitly listed in `ssr.external` / `resolve.external` remain as live
 * imports in the server bundle. Those packages are exactly what a standalone
 * deployment needs in `node_modules/`.
 *
 * Using the bundler's own import graph (`chunk.imports` + `chunk.dynamicImports`)
 * is authoritative: no text parsing, no regex, no guessing.
 *
 * The written JSON is an array of package-name strings, e.g.:
 *   ["react", "react-dom", "react-dom/server"]
 *
 * `emitStandaloneOutput` reads this file and uses it as the seed list for the
 * BFS `node_modules/` copy, replacing the old regex-scan approach.
 */
export function createServerExternalsManifestPlugin(): Plugin {
  // Accumulate external specifiers across all server environments (rsc + ssr).
  // Both environments run writeBundle; we merge their results so Pages Router
  // builds (ssr only) and App Router builds (rsc + ssr) both produce a
  // complete manifest.
  const externals = new Set<string>();
  let outDir: string | null = null;

  return {
    name: "vinext:server-externals-manifest",
    apply: "build",
    enforce: "post",

    writeBundle: {
      sequential: true,
      order: "post",
      handler(options, bundle) {
        const envName = this.environment?.name;
        // Only collect from server environments (rsc = App Router RSC build,
        // ssr = Pages Router SSR build or App Router SSR build).
        if (envName !== "rsc" && envName !== "ssr") return;

        const dir = options.dir;
        if (!dir) return;

        // Use the first server env's outDir parent as the canonical server dir.
        // For Pages Router: options.dir IS dist/server.
        // For App Router RSC: options.dir is dist/server.
        // For App Router SSR: options.dir is dist/server/ssr.
        // We always want dist/server as the manifest location.
        if (!outDir) {
          // The server bundle outputs to dist/server for all environments except
          // App Router SSR, which outputs to dist/server/ssr. We always want
          // dist/server as the manifest location. Rather than hard-coding "ssr",
          // treat any sub-directory of dist/server (basename !== "server") as a
          // sub-env and walk up one level. This handles any future sub-directory
          // environments (e.g. "edge") without code changes.
          // Note: using basename rather than a walk-up avoids misfiring when a
          // user's project path contains a "server" segment above the dist output
          // (e.g. /home/user/server/my-app/).
          outDir = path.basename(dir) === "server" ? dir : path.dirname(dir);
        }

        const bundleFiles = new Set(Object.keys(bundle));
        for (const item of Object.values(bundle)) {
          if (item.type !== "chunk") continue;
          // In Rollup output, item.imports normally contains filenames of other
          // chunks in the bundle. But externalized packages remain as bare npm
          // specifiers (e.g. "react", "@mdx-js/react") since they were never
          // bundled into chunk files. packageNameFromSpecifier filters out chunk
          // filenames (relative/absolute paths) and extracts the package name from
          // bare specifiers — which is exactly what the standalone BFS needs.
          for (const specifier of [...item.imports, ...item.dynamicImports]) {
            if (bundleFiles.has(specifier)) {
              continue;
            }
            const pkg = packageNameFromSpecifier(specifier);
            if (pkg) externals.add(pkg);
          }
        }

        // After the last expected writeBundle call, flush to disk.
        // We flush on every call since we don't know ahead of time how many
        // environments will fire — overwriting with the accumulated set is safe.
        if (outDir && fs.existsSync(outDir)) {
          const manifestPath = path.join(outDir, "vinext-externals.json");
          fs.writeFileSync(manifestPath, JSON.stringify([...externals], null, 2) + "\n", "utf-8");
        }
      },
    },
  };
}
