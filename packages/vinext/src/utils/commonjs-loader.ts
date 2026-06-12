import fs from "node:fs";
import { createRequire, Module } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

type CompilableCommonJsModule = Module & {
  _compile(content: string, filename: string): void;
};

const CommonJsModule = Module as typeof Module & {
  _nodeModulePaths(from: string): string[];
};

function canonicalPath(filePath: string): string {
  const normalizedPath = filePath.startsWith("/@fs/") ? filePath.slice(4) : filePath;
  const resolvedPath = normalizedPath.startsWith("file://")
    ? fileURLToPath(normalizedPath)
    : normalizedPath;
  try {
    return fs.realpathSync.native(resolvedPath);
  } catch {
    return path.resolve(resolvedPath);
  }
}

export function shouldRetryAsCommonJs(error: unknown, resolvedPath: string): boolean {
  if (!resolvedPath.endsWith(".js") || !(error instanceof Error)) return false;
  if ("code" in error && error.code === "ERR_REQUIRE_ESM") {
    const canonicalResolvedPath = canonicalPath(resolvedPath);
    return (
      error.message.includes(canonicalResolvedPath) ||
      error.message.includes(pathToFileURL(canonicalResolvedPath).href)
    );
  }
  if (!(error instanceof ReferenceError)) return false;

  const match = error.message.match(
    /^(module|exports|require|__dirname|__filename) is not defined(?: in ES module scope)?/,
  );
  if (!match || !error.stack) return false;

  const identifier = match[1];
  // This validation intentionally assumes the executed config/plugin source
  // is byte-identical to the on-disk file. Current callers load raw user files;
  // transformed modules should not use this fallback without source-map logic.
  for (const line of error.stack.split("\n").slice(1)) {
    const location = line.match(/(?:\(|at )(.+):(\d+):(\d+)\)?$/);
    if (!location) continue;
    const [, framePath, lineNumberText, columnNumberText] = location;
    const canonicalFramePath = canonicalPath(framePath);
    if (!canonicalFramePath.endsWith(".js")) continue;

    let sourceLine: string | undefined;
    try {
      sourceLine = fs.readFileSync(canonicalFramePath, "utf8").split(/\r?\n/)[
        Number(lineNumberText) - 1
      ];
    } catch {
      continue;
    }
    const column = Number(columnNumberText) - 1;
    if (sourceLine?.slice(column, column + identifier.length) === identifier) return true;
  }

  return false;
}

function compileCommonJsModule(resolvedPath: string, parent?: Module): unknown {
  resolvedPath = canonicalPath(resolvedPath);
  const req = createRequire(resolvedPath);
  const cached = req.cache[resolvedPath];
  if (cached) return cached.exports;

  const mod = new CommonJsModule(resolvedPath, parent) as CompilableCommonJsModule;
  mod.filename = resolvedPath;
  mod.paths = CommonJsModule._nodeModulePaths(path.dirname(resolvedPath));
  req.cache[resolvedPath] = mod;

  const originalRequire = mod.require.bind(mod);
  mod.require = ((specifier: string) => {
    let dependencyPath: string;
    try {
      dependencyPath = req.resolve(specifier);
    } catch {
      return originalRequire(specifier);
    }

    if (dependencyPath.endsWith(".cjs")) {
      // Keep `.cjs` modules inside this loader so their deferred `require()`
      // calls retain the same `.js` fallback and share Node's module cache.
      // This deliberately bypasses third-party `require.extensions[".cjs"]`
      // hooks; the supported config/plugin paths are raw JavaScript modules.
      return compileCommonJsModule(dependencyPath, mod);
    }

    try {
      return originalRequire(specifier);
    } catch (error) {
      if (!shouldRetryAsCommonJs(error, dependencyPath)) throw error;
      return compileCommonJsModule(dependencyPath, mod);
    }
  }) as Module["require"];

  try {
    mod._compile(fs.readFileSync(resolvedPath, "utf8"), resolvedPath);
    mod.loaded = true;
    return mod.exports;
  } catch (error) {
    if (req.cache[resolvedPath] === mod) delete req.cache[resolvedPath];
    throw error;
  }
}

/**
 * Load a `.js` file as CommonJS even when a surrounding `package.json`
 * declares `"type": "module"`. Nested misclassified `.js` dependencies are
 * compiled the same way, while Node keeps handling builtins, JSON, native
 * addons, and correctly classified modules through its normal loader.
 */
export function loadCommonJsModule(resolvedPath: string): unknown {
  return compileCommonJsModule(resolvedPath);
}

/**
 * Import a module normally, retrying only `.js` files that fail because Node
 * classified CommonJS source as ESM.
 */
export async function importExportWithCommonJsFallback(resolvedPath: string): Promise<unknown> {
  try {
    const mod = await import(pathToFileURL(resolvedPath).href);
    return mod.default ?? mod;
  } catch (error) {
    if (!shouldRetryAsCommonJs(error, resolvedPath)) throw error;
    return loadCommonJsModule(resolvedPath);
  }
}
