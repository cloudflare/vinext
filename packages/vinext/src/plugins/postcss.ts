import path from "node:path";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import type { UserConfig } from "vite";
import { isRecord } from "../utils/is-record.js";
import { readJsonFile } from "../utils/safe-json-file.js";

export type ExplicitPostcssConfig = Extract<
  NonNullable<NonNullable<UserConfig["css"]>["postcss"]>,
  object
>;
export type PostcssAcceptedPlugin = NonNullable<ExplicitPostcssConfig["plugins"]>[number];

type PostcssPluginSpec = {
  name: string;
  options: unknown;
};

type PostcssPluginEntry = PostcssPluginSpec | { value: unknown };

type PostcssConfigInfo = {
  configPath: string;
  hasTailwindPlugin: boolean;
  isOpaqueConfig: boolean;
  postcss: Promise<{ plugins: PostcssAcceptedPlugin[] } | undefined> | undefined;
  shouldInjectIntoVite: boolean;
};

/**
 * PostCSS config file names to search for, in priority order.
 * `package.json` is checked first in findPostcssConfig() to match Next.js
 * findConfig(), where package configuration always wins.
 */
const POSTCSS_CONFIG_FILES = [
  "postcss.config.js",
  "postcss.config.cjs",
  "postcss.config.mjs",
  "postcss.config.ts",
  "postcss.config.cts",
  "postcss.config.mts",
  "postcss.config.json",
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

const NEXT_SUPPORTED_JSON_POSTCSS_CONFIG = "postcss.config.json";
const TAILWIND_POSTCSS_PLUGINS = new Set(["@tailwindcss/postcss", "tailwindcss"]);

type FoundPostcssConfig = {
  configPath: string;
  config: unknown;
  loadModule: boolean;
};

/**
 * Module-level cache for resolvePostcssStringPlugins — avoids re-scanning per Vite environment.
 * Stores the Promise itself so concurrent calls (RSC/SSR/Client config() hooks firing in
 * parallel) all await the same in-flight scan rather than each starting their own.
 */
export const postcssCache = new Map<string, Promise<PostcssConfigInfo | undefined>>();

function hasDefaultExport(value: unknown): value is { default: unknown } {
  return isRecord(value) && "default" in value;
}

function isPostcssPluginSpec(value: PostcssPluginEntry): value is PostcssPluginSpec {
  return "name" in value;
}

function isEmptyRecord(value: unknown): boolean {
  return isRecord(value) && Object.keys(value).length === 0;
}

function isAcceptedPostcssPlugin(value: unknown): value is PostcssAcceptedPlugin {
  return !!value && (typeof value === "object" || typeof value === "function");
}

export function isTailwindPostcssPluginValue(plugin: unknown): boolean {
  if (typeof plugin === "string") {
    return TAILWIND_POSTCSS_PLUGINS.has(plugin);
  }
  if (Array.isArray(plugin) && typeof plugin[0] === "string" && plugin[1] !== false) {
    return TAILWIND_POSTCSS_PLUGINS.has(plugin[0]);
  }
  if (!isRecord(plugin)) return false;
  return (
    (typeof plugin.name === "string" && TAILWIND_POSTCSS_PLUGINS.has(plugin.name)) ||
    (typeof plugin.postcssPlugin === "string" && TAILWIND_POSTCSS_PLUGINS.has(plugin.postcssPlugin))
  );
}

function toAcceptedPostcssPlugin(value: unknown, name: string): PostcssAcceptedPlugin {
  if (isAcceptedPostcssPlugin(value)) return value;
  throw new TypeError(`PostCSS plugin ${name} did not resolve to a valid plugin value.`);
}

function parseJsonConfigContent(content: string, configPath: string): unknown {
  try {
    return JSON.parse(content);
  } catch (cause) {
    throw new Error(`[vinext] Failed to parse PostCSS JSON config ${configPath}`, { cause });
  }
}

export function findPostcssConfig(projectRoot: string): FoundPostcssConfig | null {
  const packageJsonPath = path.join(projectRoot, "package.json");
  if (fs.existsSync(packageJsonPath)) {
    const packageJson = readJsonFile<unknown>(packageJsonPath);
    if (isRecord(packageJson) && isRecord(packageJson.postcss)) {
      return { configPath: packageJsonPath, config: packageJson.postcss, loadModule: false };
    }
  }

  for (const name of POSTCSS_CONFIG_FILES) {
    const candidate = path.join(projectRoot, name);
    if (!fs.existsSync(candidate)) continue;

    if (path.basename(candidate) === ".postcssrc") {
      const content = fs.readFileSync(candidate, "utf-8").trim();
      return {
        configPath: candidate,
        config: content.startsWith("{") ? parseJsonConfigContent(content, candidate) : undefined,
        loadModule: false,
      };
    }

    if (candidate.endsWith(".yaml") || candidate.endsWith(".yml")) {
      return { configPath: candidate, config: undefined, loadModule: false };
    }

    if (candidate.endsWith(".json")) {
      let parseError: unknown;
      const config = readJsonFile<unknown>(candidate, {
        onError(error) {
          parseError = error;
        },
      });
      if (config === null && parseError) {
        throw new Error(`[vinext] Failed to parse PostCSS JSON config ${candidate}`, {
          cause: parseError,
        });
      }
      return {
        configPath: candidate,
        config: config ?? undefined,
        loadModule: false,
      };
    }

    return { configPath: candidate, config: undefined, loadModule: true };
  }

  return null;
}

async function loadPostcssConfig(found: FoundPostcssConfig): Promise<unknown> {
  if (!found.loadModule) return found.config;

  try {
    const mod = await import(pathToFileURL(found.configPath).href);
    return hasDefaultExport(mod) ? mod.default : mod;
  } catch {
    // If we can't load the config, let Vite/postcss-load-config handle it.
    return undefined;
  }
}

function normalizePostcssPlugins(plugins: unknown): {
  entries: PostcssPluginEntry[];
  hasStringPlugins: boolean;
  hasTailwindPlugin: boolean;
} | null {
  const entries: PostcssPluginEntry[] = [];
  let hasStringPlugins = false;
  let hasTailwindPlugin = false;

  function addPlugin(name: string, options: unknown, fromArrayString: boolean): void {
    if (options === false) return;
    if (TAILWIND_POSTCSS_PLUGINS.has(name)) {
      hasTailwindPlugin = true;
    }
    if (fromArrayString) {
      hasStringPlugins = true;
    }
    entries.push({ name, options });
  }

  if (Array.isArray(plugins)) {
    for (const plugin of plugins) {
      if (!plugin) continue;
      if (typeof plugin === "string") {
        addPlugin(plugin, undefined, true);
        continue;
      }
      if (Array.isArray(plugin) && typeof plugin[0] === "string") {
        addPlugin(plugin[0], plugin[1], true);
        continue;
      }
      entries.push({ value: plugin });
    }
    return { entries, hasStringPlugins, hasTailwindPlugin };
  }

  if (isRecord(plugins)) {
    for (const [name, options] of Object.entries(plugins)) {
      addPlugin(name, options, false);
    }
    return { entries, hasStringPlugins, hasTailwindPlugin };
  }

  return null;
}

async function resolvePostcssPlugins(
  projectRoot: string,
  entries: PostcssPluginEntry[],
): Promise<PostcssAcceptedPlugin[]> {
  const req = createRequire(path.join(projectRoot, "package.json"));
  return Promise.all(
    entries.map(async (entry): Promise<PostcssAcceptedPlugin | undefined> => {
      if (!isPostcssPluginSpec(entry)) {
        return toAcceptedPostcssPlugin(entry.value, "inline");
      }

      // Keep the boundary defensive for direct callers such as resolvePostcssPlugin();
      // normalizePostcssPlugins() filters disabled entries before this point.
      if (entry.options === false) return undefined;

      const resolvedPath = req.resolve(entry.name);
      const mod = await import(pathToFileURL(resolvedPath).href);
      const candidate = hasDefaultExport(mod) ? mod.default : mod;
      if (typeof candidate !== "function") {
        return toAcceptedPostcssPlugin(candidate, entry.name);
      }

      if (entry.options === undefined || entry.options === true || isEmptyRecord(entry.options)) {
        return toAcceptedPostcssPlugin(candidate(), entry.name);
      }

      return toAcceptedPostcssPlugin(candidate(entry.options), entry.name);
    }),
  ).then((plugins) =>
    plugins.filter((plugin): plugin is PostcssAcceptedPlugin => plugin !== undefined),
  );
}

export async function resolvePostcssPlugin(
  projectRoot: string,
  name: string,
  options: unknown,
): Promise<PostcssAcceptedPlugin> {
  const plugins = await resolvePostcssPlugins(projectRoot, [{ name, options }]);
  const plugin = plugins[0];
  if (!plugin) {
    throw new Error(`PostCSS plugin "${name}" could not be resolved.`);
  }
  return plugin;
}

async function inspectPostcssConfigUncached(
  projectRoot: string,
): Promise<PostcssConfigInfo | undefined> {
  const found = findPostcssConfig(projectRoot);
  if (!found) return undefined;

  const config = await loadPostcssConfig(found);
  if (!isRecord(config)) {
    return {
      configPath: found.configPath,
      hasTailwindPlugin: false,
      isOpaqueConfig: true,
      postcss: undefined,
      shouldInjectIntoVite: false,
    };
  }

  const normalized = normalizePostcssPlugins(config.plugins);
  if (!normalized) {
    return {
      configPath: found.configPath,
      hasTailwindPlugin: false,
      isOpaqueConfig: true,
      postcss: undefined,
      shouldInjectIntoVite: false,
    };
  }

  const needsExplicitViteConfig =
    path.basename(found.configPath) === NEXT_SUPPORTED_JSON_POSTCSS_CONFIG ||
    normalized.hasStringPlugins;

  let postcssPromise: Promise<{ plugins: PostcssAcceptedPlugin[] }> | undefined;

  return {
    configPath: found.configPath,
    hasTailwindPlugin: normalized.hasTailwindPlugin,
    isOpaqueConfig: false,
    get postcss() {
      postcssPromise ??= resolvePostcssPlugins(projectRoot, normalized.entries).then((plugins) => ({
        plugins,
      }));
      return postcssPromise;
    },
    shouldInjectIntoVite: needsExplicitViteConfig,
  };
}

export function inspectPostcssConfig(projectRoot: string): Promise<PostcssConfigInfo | undefined> {
  if (postcssCache.has(projectRoot)) return postcssCache.get(projectRoot)!;

  const promise = inspectPostcssConfigUncached(projectRoot);
  postcssCache.set(projectRoot, promise);
  return promise;
}

/**
 * Resolve PostCSS config shapes that Vite will not handle by itself.
 *
 * Next.js supports `postcss.config.json` and string plugin names. Vite's
 * postcss-load-config path does not discover `postcss.config.json`, and string
 * array entries need explicit module resolution before they can be passed to
 * Vite. Object-form configs in Vite-discovered files are left to Vite.
 */
export async function resolvePostcssStringPlugins(
  projectRoot: string,
): Promise<{ plugins: PostcssAcceptedPlugin[] } | undefined> {
  const info = await inspectPostcssConfig(projectRoot);
  if (!info?.shouldInjectIntoVite) return undefined;
  return info.postcss;
}
