import fs from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";

/**
 * Extract the npm package name from a bare module specifier.
 *
 * Returns null for:
 *  - Relative imports ("./foo", "../bar")
 *  - Absolute paths ("/abs/path")
 *  - Node built-ins ("node:fs")
 *  - Package self-references ("#imports")
 */
function packageNameFromSpecifier(specifier: string): string | null {
  if (
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    specifier.startsWith("node:") ||
    specifier.startsWith("#")
  ) {
    return null;
  }

  if (specifier.startsWith("@")) {
    const parts = specifier.split("/");
    if (parts.length >= 2) {
      return `${parts[0]}/${parts[1]}`;
    }
    return null;
  }

  return specifier.split("/")[0] || null;
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
  // Track how many server environments have completed their writeBundle call
  // so we know when it is safe to flush to disk.
  let pendingWrites = 0;
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
          // Walk up from options.dir until we find a parent whose basename is "server",
          // or fall back to options.dir if none found within 3 levels.
          let candidate = dir;
          for (let i = 0; i < 3; i++) {
            if (path.basename(candidate) === "server") {
              outDir = candidate;
              break;
            }
            const parent = path.dirname(candidate);
            if (parent === candidate) break;
            candidate = parent;
          }
          if (!outDir) outDir = dir;
        }

        pendingWrites++;

        for (const item of Object.values(bundle)) {
          if (item.type !== "chunk") continue;
          const chunk = item as { imports: string[]; dynamicImports: string[] };
          for (const specifier of [...(chunk.imports ?? []), ...(chunk.dynamicImports ?? [])]) {
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
