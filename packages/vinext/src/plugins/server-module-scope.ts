import fs from "node:fs";
import path from "pathslash";
import type { Plugin } from "vite";
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

/** Applies `type: "module"` to an emitted package manifest, keeping its other fields. */
function pinModuleType(source: string | Uint8Array): string | null {
  const text = typeof source === "string" ? source : new TextDecoder().decode(source);
  let manifest: unknown;
  try {
    manifest = JSON.parse(text);
  } catch {
    return null;
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return null;
  if (Reflect.get(manifest, "type") === "module") return text;
  return `${JSON.stringify({ ...manifest, type: "module" }, null, 2)}\n`;
}

/**
 * Keeps vinext's server build output ESM under a CommonJS package scope.
 *
 * vinext's server bundles, and the modules it generates next to them
 * (`__vinext_action_owner_manifest.js` and other manifests), are ESM with
 * `.js` names. When the project's package.json omits `"type": "module"`, Vite
 * names server entries `.mjs` (so `dist/server/index.js` never exists), and
 * Node reads `.js` modules in an output directory under a CommonJS scope as
 * CommonJS. Next.js pins the module type of its own output the same way, with
 * `{"type": "commonjs"}` in `.next/package.json`.
 *
 * This plugin:
 * - under a CommonJS project root, swaps Vite's `.mjs` server entry and chunk
 *   name defaults back to the `.js` names Vite uses under a module root, in
 *   the server environments vinext owns, so the fixed entry paths exist;
 * - pins every ESM server output directory whose package scope isn't
 *   `module` with an emitted `package.json` of `{"type":"module"}`, or by
 *   setting `type` on one another plugin emitted.
 *
 * The Pages Router client assets module, which can be written outside any
 * server output directory, is named `.mjs` instead (PAGES_CLIENT_ASSETS_MODULE).
 */
export function createServerModuleScopePlugin(options: {
  /** Whether vinext owns the entry and chunk names of this environment. */
  ownsFileNames: (environmentName: string) => boolean;
}): Plugin {
  let root = process.cwd();
  let isModuleRoot = true;

  return {
    name: "vinext:server-module-scope",
    apply: "build",

    configResolved(config) {
      root = config.root;
      isModuleRoot = readPackageScopeType(root) === "module";
    },

    // Runs before other plugins wrap the chunk names (multi-stage output).
    // Rolldown calls it once per output, so array-shaped outputs are covered.
    outputOptions: {
      order: "pre",
      handler(output) {
        const environment = this.environment;
        if (isModuleRoot || !isServerEnvironment(environment)) return null;
        if (!options.ownsFileNames(environment.name)) return null;
        // Vite's SSR defaults under a CommonJS root (resolveOutputJsExtension).
        const assetsDir = environment.config.build.assetsDir;
        const entryFileNames =
          output.entryFileNames === "[name].mjs" ? "[name].js" : output.entryFileNames;
        const chunkFileNames =
          output.chunkFileNames === path.posix.join(assetsDir, "[name]-[hash].mjs")
            ? path.posix.join(assetsDir, "[name]-[hash].js")
            : output.chunkFileNames;
        if (entryFileNames === output.entryFileNames && chunkFileNames === output.chunkFileNames) {
          return null;
        }
        return { ...output, entryFileNames, chunkFileNames };
      },
    },

    // After every other plugin's assets are in the bundle.
    generateBundle: {
      order: "post",
      handler(output, bundle) {
        const environment = this.environment;
        if (!isServerEnvironment(environment)) return;
        // Nitro writes its own server output and package manifest.
        if (environment.name === "nitro") return;
        if (output.format !== "es") return;

        const emitted = bundle["package.json"];
        if (emitted) {
          if (emitted.type !== "asset") return;
          const source = pinModuleType(emitted.source);
          if (source === null) {
            this.error(
              `[vinext] The package.json emitted into the ${environment.name} server output isn't a JSON object, so it can't declare "type": "module" for vinext's ESM output.`,
            );
          }
          emitted.source = source;
          return;
        }

        const outDir = path.resolve(root, output.dir ?? environment.config.build.outDir);
        if (readPackageScopeType(outDir) === "module") return;
        // Vite has already emptied the output directory, so a package.json
        // still there isn't output: leave it to its owner.
        if (fs.existsSync(path.join(outDir, "package.json"))) {
          this.warn(
            `${path.join(outDir, "package.json")} doesn't declare "type": "module", so Node will load vinext's ESM server output there as CommonJS.`,
          );
          return;
        }
        this.emitFile({
          type: "asset",
          fileName: "package.json",
          source: SERVER_OUTPUT_PACKAGE_JSON,
        });
      },
    },
  };
}
