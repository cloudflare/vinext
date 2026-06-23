import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";
import { importExportWithCommonJsFallback } from "../utils/commonjs-loader.js";

async function loadPluginExport(resolvedPath: string): Promise<unknown> {
  return importExportWithCommonJsFallback(resolvedPath);
}

/**
 * PostCSS config file names to search for, in priority order.
 * Matches the same search order as postcss-load-config / lilconfig.
 */
const POSTCSS_CONFIG_FILES = [
  "postcss.config.js",
  "postcss.config.cjs",
  "postcss.config.mjs",
  "postcss.config.ts",
  "postcss.config.cts",
  "postcss.config.mts",
  ".postcssrc",
  ".postcssrc.js",
  ".postcssrc.cjs",
  ".postcssrc.mjs",
  ".postcssrc.ts",
  ".postcssrc.cts",
  ".postcssrc.mts",
  ".postcssrc.json",
  ".postcssrc.yaml",
  ".postcssrc.yml",
];

/**
 * Module-level cache for resolvePostcssStringPlugins — avoids re-scanning per Vite environment.
 * Stores the Promise itself so concurrent calls (RSC/SSR/Client config() hooks firing in
 * parallel) all await the same in-flight scan rather than each starting their own.
 */
export const postcssCache = new Map<string, Promise<{ plugins: unknown[] } | undefined>>();

/**
 * Resolve PostCSS string plugin names in a project's PostCSS config.
 *
 * Next.js (via postcss-load-config) resolves string plugin names in the
 * object form `{ plugins: { "pkg-name": opts } }` but NOT in the array form
 * `{ plugins: ["pkg-name"] }`. Since many Next.js projects use the array
 * form (particularly with Tailwind CSS v4), we detect this case and resolve
 * the string names to actual plugin functions so Vite can use them.
 *
 * Returns the resolved PostCSS config object to inject into Vite's
 * `css.postcss`, or `undefined` if no resolution is needed.
 */
export function resolvePostcssStringPlugins(
  projectRoot: string,
): Promise<{ plugins: unknown[] } | undefined> {
  if (postcssCache.has(projectRoot)) return postcssCache.get(projectRoot)!;

  const promise = resolvePostcssStringPluginsUncached(projectRoot);
  postcssCache.set(projectRoot, promise);
  return promise;
}

async function resolvePostcssStringPluginsUncached(
  projectRoot: string,
): Promise<{ plugins: unknown[] } | undefined> {
  // Find the PostCSS config file
  let configPath: string | null = null;
  for (const name of POSTCSS_CONFIG_FILES) {
    const candidate = path.join(projectRoot, name);
    if (fs.existsSync(candidate)) {
      configPath = candidate;
      break;
    }
  }
  if (!configPath) {
    return undefined;
  }

  // Load the config file
  // oxlint-disable-next-line typescript/no-explicit-any
  let config: any;
  try {
    if (
      configPath.endsWith(".json") ||
      configPath.endsWith(".yaml") ||
      configPath.endsWith(".yml")
    ) {
      // JSON/YAML configs use object form — postcss-load-config handles these fine
      return undefined;
    }
    // For .postcssrc without extension, check if it's JSON
    if (configPath.endsWith(".postcssrc")) {
      const content = fs.readFileSync(configPath, "utf-8").trim();
      if (content.startsWith("{")) {
        // JSON format — postcss-load-config handles object form
        return undefined;
      }
    }
    config = await importExportWithCommonJsFallback(configPath);
  } catch {
    // If we can't load the config, let Vite/postcss-load-config handle it
    return undefined;
  }

  // Only process array-form plugins that contain string entries
  // (either bare strings or tuple form ["plugin-name", { options }])
  if (!config || !Array.isArray(config.plugins)) {
    return undefined;
  }
  const hasStringPlugins = config.plugins.some(
    (p: unknown) => typeof p === "string" || (Array.isArray(p) && typeof p[0] === "string"),
  );
  if (!hasStringPlugins) {
    return undefined;
  }

  // Resolve string plugin names to actual plugin functions
  const req = createRequire(path.join(projectRoot, "package.json"));
  try {
    const resolved = await Promise.all(
      config.plugins.filter(Boolean).map(async (plugin: unknown) => {
        if (typeof plugin === "string") {
          const resolved = req.resolve(plugin);
          const fn = await loadPluginExport(resolved);
          // If the export is a function, call it to get the plugin instance
          return typeof fn === "function" ? fn() : fn;
        }
        // Array tuple form: ["plugin-name", { options }]
        if (Array.isArray(plugin) && typeof plugin[0] === "string") {
          const [name, options] = plugin;
          const resolved = req.resolve(name);
          const fn = await loadPluginExport(resolved);
          return typeof fn === "function" ? fn(options) : fn;
        }
        // Already a function or plugin object — pass through
        return plugin;
      }),
    );
    return { plugins: resolved };
  } catch {
    // A plugin name failed to resolve or load (e.g. it isn't installed at
    // `projectRoot`, or resolves differently than postcss-load-config would).
    // Don't crash the whole build (every Vite environment runs this config
    // hook, so a throw here aborts the RSC/SSR/client builds with an opaque
    // error). Fall back to `undefined` so Vite's own postcss-load-config
    // loads and resolves the config relative to the config file instead.
    //
    // Note: a single unresolvable entry makes us defer the *entire* config to
    // Vite (not a per-plugin skip) — the resolved list is only useful if it's
    // complete, and Vite re-loads the whole config anyway. If the failure was a
    // genuine plugin-factory error rather than a resolution miss, Vite's loader
    // re-surfaces it with a clearer message than this opaque build abort.
    return undefined;
  }
}
