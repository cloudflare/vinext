import fs from "node:fs";
import path from "pathslash";
import { parseAst, type Alias, type ESTree } from "vite";
import { packageNameFromSpecifier } from "../utils/package-name.js";
import { canonicalizeFilePath, NODE_MODULES_PATH_RE } from "../utils/path.js";
import { readJsonFile } from "../utils/safe-json-file.js";
import {
  mayContainDynamicImport,
  scriptParserLanguage,
  staticStringValue,
  walkAst,
  type ScriptParserLanguage,
} from "./ast-utils.js";

// Adapter Worker entries are small module graphs. The cap only bounds startup
// work if an entry unexpectedly reaches a large part of its package.
const MAX_HOST_ENTRY_FILES = 64;

/**
 * Collect the bare imports reachable from an adapter-owned multi-stage entry.
 *
 * The host-entry transform appends a re-export of this entry, so Vite's
 * dependency scanner never sees its imports. The optimizer then discovers them
 * only when the host first imports the Worker graph, re-bundles, and reloads.
 * Returning them as optional includes makes the first optimize final.
 *
 * Includes use root-form ids, matching what the optimizer discovers on its
 * own: @vitejs/plugin-rsc re-resolves bare imports from node_modules importers
 * against the project root, and Vite then serves that root copy to the
 * importer by id. A dependency is therefore kept only when it resolves into
 * node_modules both from its importer and from the root. Linked or workspace
 * packages, and packages the root cannot resolve, are skipped because they are
 * not discovered either. An importer outside node_modules (a linked adapter)
 * has its own copy registered by Vite first, so its dependency is kept only
 * when that copy is the root's.
 *
 * Import declarations, re-exports and literal dynamic imports are read, as
 * Vite's scanner reads them. Only relative imports inside the entry's own
 * package are followed, by real path as Vite loads them. Type-only imports,
 * computed dynamic imports, builtins, protocol ids, package imports, and
 * imports of the owning package itself are skipped. So are ids matched by
 * `aliases`: server environments only optimize an aliased bare import when it
 * is explicitly included, so including one would change it. Ids are not
 * resolved further, so non-JS subpaths (CSS, JSON, WASM) are kept. Vite skips
 * those includes, as discovery does, and the caller silences the warning it
 * logs for them.
 */
export function collectHostEntryOptimizeDepsIncludes(
  entry: string,
  root: string,
  aliases: readonly Alias[],
): string[] {
  const realEntry = canonicalizeFilePath(entry);
  const realRoot = canonicalizeFilePath(root);
  const owners = new Map<string, string | null>();
  const owner = findOwningPackageName(realEntry, owners);
  if (!owner) return [];

  const includes = new Set<string>();
  const seen = new Set<string>();
  const pending = [realEntry];
  while (pending.length > 0 && seen.size < MAX_HOST_ENTRY_FILES) {
    const file = pending.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);

    const lang = scriptParserLanguage(file);
    if (!lang || findOwningPackageName(file, owners) !== owner) continue;
    let specifiers: string[];
    try {
      specifiers = runtimeImportSpecifiers(fs.readFileSync(file, "utf-8"), lang);
    } catch {
      continue;
    }

    for (const specifier of specifiers) {
      if (specifier.startsWith("./") || specifier.startsWith("../")) {
        pending.push(canonicalizeFilePath(path.resolve(path.dirname(file), specifier)));
        continue;
      }
      if (includes.has(specifier) || aliases.some(({ find }) => matchesAlias(find, specifier))) {
        continue;
      }
      const packageName = packageNameFromSpecifier(specifier);
      if (!packageName || packageName === owner) continue;
      const importerCopy = findInstalledPackageDir(path.dirname(file), packageName);
      const rootCopy = importerCopy && findInstalledPackageDir(realRoot, packageName);
      if (rootCopy && (NODE_MODULES_PATH_RE.test(file) || importerCopy === rootCopy)) {
        includes.add(specifier);
      }
    }
  }
  return [...includes];
}

/**
 * List a module's runtime import specifiers: import and re-export
 * declarations, then dynamic imports whose request is a static string.
 */
function runtimeImportSpecifiers(code: string, lang: ScriptParserLanguage): string[] {
  const ast = parseAst(code, { lang });
  const specifiers: string[] = [];
  for (const statement of ast.body) {
    if (isRuntimeModuleDeclaration(statement)) specifiers.push(statement.source.value);
  }
  if (!mayContainDynamicImport(code)) return specifiers;
  for (const statement of ast.body) {
    walkAst(statement, (node) => {
      if (node.type !== "ImportExpression") return;
      const specifier = staticStringValue(node.source);
      if (specifier !== null) specifiers.push(specifier);
    });
  }
  return specifiers;
}

type ModuleDeclarationWithSource = (
  | ESTree.ImportDeclaration
  | ESTree.ExportNamedDeclaration
  | ESTree.ExportAllDeclaration
) & { source: ESTree.StringLiteral };

function isRuntimeModuleDeclaration(
  statement: ESTree.Program["body"][number],
): statement is ModuleDeclarationWithSource {
  if (statement.type === "ImportDeclaration") {
    return (
      statement.importKind !== "type" &&
      (statement.specifiers.length === 0 ||
        statement.specifiers.some(
          (specifier) => specifier.type !== "ImportSpecifier" || specifier.importKind !== "type",
        ))
    );
  }
  if (statement.type === "ExportNamedDeclaration") {
    return (
      statement.source !== null &&
      statement.exportKind !== "type" &&
      (statement.specifiers.length === 0 ||
        statement.specifiers.some((specifier) => specifier.exportKind !== "type"))
    );
  }
  return statement.type === "ExportAllDeclaration" && statement.exportKind !== "type";
}

/** Match `id` against an alias `find` pattern the way Vite's alias plugins do. */
function matchesAlias(find: string | RegExp, id: string): boolean {
  if (find instanceof RegExp) return find.test(id);
  return id === find || id.startsWith(find.endsWith("/") ? find : `${find}/`);
}

/**
 * Find the name of the package that owns `file`. Nameless manifests (for
 * example a `{ "type": "module" }` marker in a dist directory) are skipped.
 * Results are memoised per directory in `owners`.
 */
function findOwningPackageName(file: string, owners: Map<string, string | null>): string | null {
  const fileDirectory = path.dirname(file);
  const cached = owners.get(fileDirectory);
  if (cached !== undefined) return cached;
  let owner: string | null = null;
  let directory = fileDirectory;
  while (true) {
    const packageJsonPath = path.join(directory, "package.json");
    if (fs.existsSync(packageJsonPath)) {
      const name = readJsonFile<{ name?: unknown }>(packageJsonPath)?.name;
      if (typeof name === "string" && name) {
        owner = name;
        break;
      }
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  owners.set(fileDirectory, owner);
  return owner;
}

/**
 * Resolve `packageName` from `directory` to its real package directory,
 * walking up through node_modules directories like Node and Vite do. Returns
 * null unless that directory is inside node_modules, so linked packages do not
 * count.
 */
function findInstalledPackageDir(directory: string, packageName: string): string | null {
  while (true) {
    const packageDir = path.join(directory, "node_modules", packageName);
    if (fs.existsSync(path.join(packageDir, "package.json"))) {
      const realPackageDir = canonicalizeFilePath(packageDir);
      return NODE_MODULES_PATH_RE.test(realPackageDir) ? realPackageDir : null;
    }
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}
