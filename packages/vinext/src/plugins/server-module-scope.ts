import fs from "node:fs";
import path from "pathslash";
import type { Plugin } from "vite";
import { getBuildBundlerOptions, withBuildBundlerOptions } from "../build/client-build-config.js";
import { isServerEnvironment } from "./environment.js";

/**
 * Package manifest that makes Node load every `.js` file in a server output
 * directory as ESM, whatever the project's own package scope says.
 */
export const SERVER_OUTPUT_PACKAGE_JSON = `${JSON.stringify({ type: "module" })}\n`;

/**
 * The `type` of the nearest package.json at or above `dir`, which decides how
 * Node and Vite treat `.js` files there. Node defaults to CommonJS without one.
 */
export function readPackageScopeType(dir: string): string {
  let directory = path.resolve(dir);
  for (;;) {
    const packageJsonPath = path.join(directory, "package.json");
    if (fs.existsSync(packageJsonPath)) {
      try {
        const { type } = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8")) as {
          type?: unknown;
        };
        return typeof type === "string" ? type : "commonjs";
      } catch {
        return "commonjs";
      }
    }
    const parent = path.dirname(directory);
    if (parent === directory) return "commonjs";
    directory = parent;
  }
}

/**
 * Keeps vinext's server build output ESM under a CommonJS package scope.
 *
 * vinext's server bundles, and the modules it generates next to them
 * (`__vinext_action_owner_manifest.js` and other manifests), are ESM with
 * `.js` names. When the project's package.json omits `"type": "module"`, Vite
 * names server entries `.mjs` (so `dist/server/index.js` never exists) and
 * Node reads the generated `.js` modules as CommonJS. Next.js pins the module
 * type of its own output the same way, with `{"type": "commonjs"}` in
 * `.next/package.json`.
 *
 * This plugin, only for such projects:
 * - restores `.js` entry and chunk names in the server environments vinext
 *   owns, so the fixed entry paths exist;
 * - writes `{"type":"module"}` to `package.json` in every server
 *   environment's output directory, and in the directories outside it that
 *   hold modules the server imports (the Pages Router client assets module
 *   in `dist/`).
 */
export function createServerModuleScopePlugin(options: {
  /** Whether vinext owns the entry and chunk names of this environment. */
  ownsFileNames: (environmentName: string) => boolean;
  /** Directories, possibly outside a server output directory, with modules it imports. */
  getModuleOutputDirs: () => Iterable<string>;
}): Plugin {
  let isModuleScope = true;

  return {
    name: "vinext:server-module-scope",
    apply: "build",

    config(config) {
      isModuleScope = readPackageScopeType(path.resolve(config.root ?? process.cwd())) === "module";
    },

    configEnvironment(name, config) {
      if (isModuleScope || name === "client" || config.consumer === "client") return null;
      if (!options.ownsFileNames(name)) return null;
      const output = getBuildBundlerOptions(config.build)?.output;
      if (Array.isArray(output)) return null;
      const fileNames = {
        ...(output?.entryFileNames === undefined ? { entryFileNames: "[name].js" } : {}),
        ...(output?.chunkFileNames === undefined
          ? { chunkFileNames: `${config.build?.assetsDir ?? "assets"}/[name]-[hash].js` }
          : {}),
      };
      if (Object.keys(fileNames).length === 0) return null;
      return { build: withBuildBundlerOptions({ output: fileNames }) };
    },

    generateBundle(_options, bundle) {
      if (isModuleScope || !isServerEnvironment(this.environment)) return;
      // Nitro writes its own server output and package manifest.
      if (this.environment.name === "nitro") return;
      if ("package.json" in bundle) return;
      this.emitFile({
        type: "asset",
        fileName: "package.json",
        source: SERVER_OUTPUT_PACKAGE_JSON,
      });
    },

    writeBundle() {
      if (isModuleScope || !isServerEnvironment(this.environment)) return;
      for (const dir of options.getModuleOutputDirs()) {
        if (readPackageScopeType(dir) === "module") continue;
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "package.json"), SERVER_OUTPUT_PACKAGE_JSON);
      }
    },
  };
}
