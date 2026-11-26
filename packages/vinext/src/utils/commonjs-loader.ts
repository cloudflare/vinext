import fs from "node:fs";
import { createRequire, Module } from "node:module";
// This loader interops with Node's CJS machinery, which is native-separator
// keyed on Windows: canonicalPath must match the paths Node embeds in
// ERR_REQUIRE_ESM messages and uses as require-cache keys, so its fallback
// has to stay in native space alongside realpathSync.native.
// oxlint-disable-next-line no-restricted-imports
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ESTree } from "vite";
import { parseProgram, walkAst } from "../plugins/ast-utils.js";

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

  // The first frame is the module that threw. Retry only when its source
  // really uses the global, so a user-thrown look-alike error isn't retried.
  // The frame's column can't tell us that: V8 often reports the enclosing
  // expression instead, e.g. `console.log` in `console.log(require("x"))`.
  // This assumes the executed source is byte-identical to the on-disk file.
  // Current callers load raw user files.
  for (const line of error.stack.split("\n").slice(1)) {
    const location = line.match(/(?:\(|at )(.+):\d+:\d+\)?$/);
    if (!location) continue;
    const framePath = canonicalPath(location[1]);
    if (!framePath.endsWith(".js")) return false;
    try {
      return usesIdentifier(fs.readFileSync(framePath, "utf8"), match[1]);
    } catch {
      return false;
    }
  }

  return false;
}

/**
 * Whether `code` uses `name` as a variable, not only as a property name
 * (`obj.require`, `{ require: 1 }`) or inside a string or comment.
 */
function usesIdentifier(code: string, name: string): boolean {
  let found = false;
  const visit = (node: ESTree.Node): boolean | void => {
    if (found) return false;
    if (node.type === "Identifier" && node.name === name) {
      found = true;
      return false;
    }
    // Skip non-computed property names.
    if (node.type === "MemberExpression" && !node.computed) {
      walkAst(node.object, visit);
      return false;
    }
    if (
      (node.type === "Property" ||
        node.type === "MethodDefinition" ||
        node.type === "PropertyDefinition") &&
      !node.computed &&
      node.value
    ) {
      walkAst(node.value, visit);
      return false;
    }
  };
  walkAst(parseProgram(code), visit);
  return found;
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
