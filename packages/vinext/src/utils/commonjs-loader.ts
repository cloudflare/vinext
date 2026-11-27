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
import { findAstBindingScope, walkAstScopes } from "../plugins/ast-scope.js";
import { forEachAstChild, parseProgram, walkAst } from "../plugins/ast-utils.js";

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
  // A missing global is thrown where it is read, so only the first frame with
  // a location counts: a caller's statement says nothing about the error.
  for (const line of error.stack.split("\n").slice(1)) {
    const location = line.match(/(?:\(|at )(.+):(\d+):(\d+)\)?$/);
    if (!location) continue;
    const [, framePath, lineNumberText, columnNumberText] = location;
    const canonicalFramePath = canonicalPath(framePath);
    if (!canonicalFramePath.endsWith(".js")) return false;

    let source: string;
    try {
      source = fs.readFileSync(canonicalFramePath, "utf8");
    } catch {
      return false;
    }
    const offset = sourceOffset(source, Number(lineNumberText), Number(columnNumberText));
    return offset !== null && statementReadsGlobal(source, offset, identifier);
  }

  return false;
}

/** The UTF-16 offset of a 1-based line and column, or `null` when out of range. */
function sourceOffset(source: string, lineNumber: number, columnNumber: number): number | null {
  const lineBreak = /\r\n?|\n|\u2028|\u2029/g;
  let lineStart = 0;
  for (let current = 1; current < lineNumber; current++) {
    if (!lineBreak.exec(source)) return null;
    lineStart = lineBreak.lastIndex;
  }
  const offset = lineStart + columnNumber - 1;
  return offset >= lineStart && offset <= source.length ? offset : null;
}

function isStatementNode(node: ESTree.Node): boolean {
  return /(?:Statement|Declaration)$/.test(node.type);
}

/**
 * Whether the innermost statement containing `offset` reads `name` as an
 * unbound variable. V8 reports a missing global at the enclosing expression,
 * not at the identifier: `log` in `console.log(require("x"))`, or the start of
 * `const c = { plugins: [require("x")] }`. It always stays inside the
 * statement that threw, so a column match would miss those shapes. Strings,
 * comments, property names (`obj.require`, `{ require: 1 }`) and names bound
 * in scope (a `require` parameter) don't count.
 */
function statementReadsGlobal(source: string, offset: number, name: string): boolean {
  let program: ESTree.Program;
  try {
    program = parseProgram(source, { lang: "jsx", sourceType: "unambiguous" });
  } catch {
    return false;
  }

  let statement: ESTree.Node | null = null;
  let node: ESTree.Node | null = program;
  while (node) {
    const parent: ESTree.Node = node;
    node = null;
    forEachAstChild(parent, (child) => {
      if (!node && child.start <= offset && offset < child.end) node = child;
    });
    if (node && isStatementNode(node)) statement = node;
  }
  if (!statement) return false;
  const { start, end } = statement;

  // Non-computed property names are identifiers that never read a variable.
  const propertyNames = new Set<ESTree.Node>();
  walkAst(statement, (current) => {
    if (current.type === "MemberExpression" && !current.computed) {
      propertyNames.add(current.property);
    } else if (
      (current.type === "Property" && !current.computed && !current.shorthand) ||
      ((current.type === "MethodDefinition" || current.type === "PropertyDefinition") &&
        !current.computed)
    ) {
      propertyNames.add(current.key);
    }
  });

  let found = false;
  walkAstScopes(program, (current, scope) => {
    if (
      !found &&
      current.type === "Identifier" &&
      current.name === name &&
      current.start >= start &&
      current.end <= end &&
      !propertyNames.has(current) &&
      !findAstBindingScope(scope, name)
    ) {
      found = true;
    }
  });
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
