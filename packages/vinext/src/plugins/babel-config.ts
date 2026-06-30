import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import type { Plugin } from "vite";
import { relativeWithinRoot, tryRealpathSync } from "../build/ssr-manifest.js";

const BABEL_CONFIG_FILES = [
  ".babelrc",
  ".babelrc.json",
  ".babelrc.js",
  ".babelrc.mjs",
  ".babelrc.cjs",
  "babel.config.js",
  "babel.config.json",
  "babel.config.mjs",
  "babel.config.cjs",
];
const VITE_SPECIAL_QUERY_RE = /[?&](?:worker|sharedworker|raw|url)\b/;

export function isViteSpecialQuery(id: string): boolean {
  return VITE_SPECIAL_QUERY_RE.test(id);
}

type BabelCore = {
  transformAsync(
    code: string,
    options: Record<string, unknown>,
  ): Promise<{
    code?: string | null;
    map?: {
      version: number;
      mappings: string;
      names: string[];
      sources: string[];
      sourcesContent?: Array<string | null>;
      file?: string;
      sourceRoot?: string;
    } | null;
  } | null>;
};

type BabelConfigPluginOptions = {
  forceSwcTransforms: boolean;
  includeExternalDirs: boolean;
  serverTarget: "node" | "webworker";
  transpilePackages: string[];
};

function findBabelConfig(root: string): string | null {
  for (const file of BABEL_CONFIG_FILES) {
    const configPath = path.join(root, file);
    if (fs.existsSync(configPath)) return configPath;
  }
  return null;
}

function resolveBabelCore(root: string): string | null {
  const projectRequire = createRequire(path.join(root, "package.json"));
  try {
    return projectRequire.resolve("@babel/core");
  } catch {}

  try {
    const nextRequire = createRequire(projectRequire.resolve("next/package.json"));
    return nextRequire.resolve("next/dist/compiled/babel/core");
  } catch {}

  return null;
}

function resolveReactRefreshPlugin(root: string): string | null {
  const projectRequire = createRequire(path.join(root, "package.json"));
  try {
    const nextRequire = createRequire(projectRequire.resolve("next/package.json"));
    return nextRequire.resolve("next/dist/compiled/react-refresh/babel");
  } catch {
    return null;
  }
}

function isPathInPackage(filename: string, packageName: string): boolean {
  const normalizedFilename = filename.replaceAll("\\", "/");
  return normalizedFilename.includes(`/node_modules/${packageName}/`);
}

function resolvePackageRoot(root: string, packageName: string): string | null {
  const projectRequire = createRequire(path.join(root, "package.json"));
  for (const searchPath of projectRequire.resolve.paths(packageName) ?? []) {
    const packageRoot = path.join(searchPath, packageName);
    const packageJsonPath = path.join(packageRoot, "package.json");
    try {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as {
        name?: unknown;
      };
      if (packageJson.name === packageName) return tryRealpathSync(packageRoot) ?? packageRoot;
    } catch {}
  }
  return null;
}

export function createBabelConfigPlugin(
  getOptions: () => BabelConfigPluginOptions = () => ({
    forceSwcTransforms: false,
    includeExternalDirs: false,
    serverTarget: "node",
    transpilePackages: [],
  }),
): Plugin {
  let root = process.cwd();
  let canonicalRoot = tryRealpathSync(root) ?? root;
  let babelCorePromise: Promise<BabelCore> | null = null;
  let reactRefreshPluginPath: string | null = null;
  let configPath: string | null = null;
  let srcDir = canonicalRoot;
  let pagesDir = path.join(canonicalRoot, "src", "pages");
  let transpilePackageRoots = new Map<string, string | null>();

  return {
    name: "vinext:babel-config",
    enforce: "pre",
    configResolved(config) {
      root = config.root;
      canonicalRoot = tryRealpathSync(root) ?? root;
      configPath = findBabelConfig(canonicalRoot);
      reactRefreshPluginPath = resolveReactRefreshPlugin(root);
      transpilePackageRoots = new Map();
      srcDir = fs.existsSync(path.join(canonicalRoot, "src"))
        ? path.join(canonicalRoot, "src")
        : canonicalRoot;
      pagesDir = fs.existsSync(path.join(canonicalRoot, "pages"))
        ? path.join(canonicalRoot, "pages")
        : path.join(canonicalRoot, "src", "pages");
    },
    configureServer(server) {
      const configCandidates = BABEL_CONFIG_FILES.map((file) => path.join(canonicalRoot, file));
      server.watcher.add(configCandidates);
      let restartPending = false;
      const restartForBabelConfig = (changedPath: string) => {
        if (!configCandidates.includes(changedPath) || restartPending) return;
        restartPending = true;
        void server.restart().finally(() => {
          restartPending = false;
        });
      };
      server.watcher.on("add", restartForBabelConfig);
      server.watcher.on("change", restartForBabelConfig);
      server.watcher.on("unlink", restartForBabelConfig);
    },
    transform: {
      filter: {
        id: /\.[cm]?[jt]sx?(?:\?.*)?$/,
      },
      async handler(code, id) {
        if (!configPath || id.startsWith("\0") || isViteSpecialQuery(id)) {
          return;
        }
        const options = getOptions();
        if (options.forceSwcTransforms) return;

        const filename = id.replace(/\?.*$/, "");
        if (!path.isAbsolute(filename)) return;
        const normalizedFilename = filename.replaceAll("\\", "/");
        const canonicalFilename = tryRealpathSync(filename) ?? filename;
        const isProjectFile = relativeWithinRoot(canonicalRoot, canonicalFilename);
        const isTranspiledPackage = options.transpilePackages.some((packageName) => {
          if (isPathInPackage(filename, packageName)) return true;

          let packageRoot = transpilePackageRoots.get(packageName);
          if (packageRoot === undefined) {
            packageRoot = resolvePackageRoot(root, packageName);
            transpilePackageRoots.set(packageName, packageRoot);
          }

          return packageRoot !== null && relativeWithinRoot(packageRoot, canonicalFilename);
        });
        if (
          ((!isProjectFile && !options.includeExternalDirs) ||
            normalizedFilename.includes("/node_modules/")) &&
          !isTranspiledPackage
        ) {
          return;
        }

        const environmentConfig = this.environment?.config;
        if (!environmentConfig) return;

        if (!babelCorePromise) {
          const babelCorePath = resolveBabelCore(root);
          if (!babelCorePath) {
            throw new Error(
              "vinext: A Babel config was found, but Babel could not be resolved. " +
                "Install @babel/core or ensure next is installed in the project.",
            );
          }
          babelCorePromise = import(pathToFileURL(babelCorePath).href).then((module) => {
            const babelCore = (module.default ?? module) as BabelCore;
            if (typeof babelCore.transformAsync !== "function") {
              throw new Error("vinext: Loaded @babel/core does not export transformAsync().");
            }
            return babelCore;
          });
        }

        const babelCore = await babelCorePromise;
        const isServer = environmentConfig.consumer !== "client";
        const isDev = environmentConfig.command === "serve";
        const result = await babelCore.transformAsync(code, {
          filename: canonicalFilename,
          cwd: canonicalRoot,
          configFile: configPath,
          babelrc: false,
          sourceMaps: true,
          sourceFileName: filename,
          plugins:
            isDev && !isServer && reactRefreshPluginPath
              ? [[reactRefreshPluginPath, { skipEnvCheck: true }]]
              : undefined,
          caller: {
            name: "next-babel-turbo-loader",
            supportsStaticESM: true,
            supportsDynamicImport: true,
            supportsTopLevelAwait: true,
            supportsExportNamespaceFrom: true,
            target: isServer ? options.serverTarget : "web",
            isServer,
            isDev,
            srcDir,
            pagesDir,
            transformMode: "default",
            hasJsxRuntime: true,
          },
        });

        if (result?.code == null) return;
        return { code: result.code, map: result.map ?? undefined };
      },
    },
  };
}
