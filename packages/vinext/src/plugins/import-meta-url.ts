// Rewrites source-identity globals in user modules so module identity survives
// bundling, matching Next.js:
//   - direct `import.meta.url` reads become source-module URLs
//   - server-side free `__filename` / `__dirname` reads become source paths
//
// Two known limitations, both matching Vite's own `import.meta.url` handling:
//   1. Destructured access — `const { url } = import.meta;` — is not detected
//      and will leak the bundled chunk URL.
//   2. An aliased `import.meta.url` used as a `new URL()` base — e.g.
//      `const u = import.meta.url; new URL("./file", u);` — is rewritten,
//      breaking Vite's asset detection for that expression. Only the direct
//      `new URL("./file", import.meta.url)` form is preserved.
// Both are edge cases that are unlikely in real Next.js apps.
import { normalizePath, parseAst, type Plugin } from "vite";
import MagicString from "magic-string";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { tryRealpathSync } from "../build/ssr-manifest.js";
import {
  collectBindingNames,
  forEachAstChild,
  hasRange,
  isAstRecord,
  isIdentifierNamed,
  nodeArray,
  type AstRange,
  type AstRecord,
} from "./ast-utils.js";

type ImportMetaUrlEnvironment = "client" | "server";

type RewriteResult = {
  code: string;
  map: ReturnType<MagicString["generateMap"]>;
};

type RootPaths = {
  root: string;
  canonicalRoot: string;
  normalizedRoot: string;
  excludedRelativePrefixes: string[];
};

const TRANSFORMABLE_SCRIPT_EXTENSIONS = new Set([
  ".cjs",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
]);

export function createImportMetaUrlPlugin(options: { getRoot: () => string | undefined }): Plugin {
  let rootPaths: RootPaths | undefined;
  let outputDirs: string[] = [];

  function getRootPaths(): RootPaths | undefined {
    const root = options.getRoot();
    if (!root) return rootPaths;
    if (!rootPaths || rootPaths.root !== root) {
      rootPaths = createRootPaths(root, { outputDirs });
    }
    return rootPaths;
  }

  return {
    name: "vinext:import-meta-url",
    enforce: "post",
    configResolved(config) {
      const root = options.getRoot() ?? config.root;
      outputDirs = [config.build.outDir];
      rootPaths = createRootPaths(root, { outputDirs });
    },
    transform(code, id) {
      if (!mayContainSourceIdentityToken(code)) return null;
      const paths = getRootPaths();
      if (!paths) return null;
      const cleanId = cleanModuleId(id);
      const canonicalId = transformableModuleCanonicalId(cleanId, paths);
      if (!canonicalId) return null;

      const environment: ImportMetaUrlEnvironment =
        this.environment?.name === "client" ? "client" : "server";
      const rewritten = rewriteCanonicalSourceIdentity(code, canonicalId, paths, environment);
      if (!rewritten) return null;
      return {
        code: rewritten.code,
        map: rewritten.map,
      };
    },
  };
}

// Test-only entry point. Delegates to the same transform the plugin runs so
// tests exercise the production code path rather than a parallel implementation.
export function rewriteImportMetaUrl(
  code: string,
  id: string,
  root: string,
  environment: ImportMetaUrlEnvironment,
): RewriteResult | null {
  if (!mayContainImportMetaUrl(code)) return null;
  return rewriteCanonicalSourceIdentity(
    code,
    canonicalizePath(id),
    createRootPaths(root),
    environment,
  );
}

// Test-only entry point. Mirrors the plugin's server eligibility checks and
// then delegates to the same transform the plugin runs, so tests exercise the
// production code path rather than a parallel implementation.
export function rewriteServerCjsGlobals(
  code: string,
  id: string,
  root: string,
): RewriteResult | null {
  if (!mayContainServerCjsGlobal(code)) return null;
  const rootPaths = createRootPaths(root);
  // Use the same eligibility gate the plugin runs (node_modules, extension,
  // within-root, build-output exclusion) instead of a hand-rolled subset, so
  // the tests exercise the production boundary rather than a parallel one.
  const canonicalId = transformableModuleCanonicalId(id, rootPaths);
  if (!canonicalId) return null;
  return rewriteCanonicalSourceIdentity(code, canonicalId, rootPaths, "server");
}

function rewriteCanonicalSourceIdentity(
  code: string,
  canonicalId: string,
  rootPaths: RootPaths,
  environment: ImportMetaUrlEnvironment,
): RewriteResult | null {
  let ast: unknown;
  try {
    ast = parseAst(code);
  } catch {
    return null;
  }

  const output = new MagicString(code);
  let changed = false;

  // Skip the import.meta.url AST walk for modules that don't contain the token
  // (the widened CJS-global gate admits many such modules). A range can only
  // exist when the substring is present, so this is behavior-preserving.
  if (mayContainImportMetaUrl(code)) {
    const importMetaRanges = collectImportMetaUrlRanges(ast);
    if (importMetaRanges.length > 0) {
      const replacement = JSON.stringify(importMetaUrlValue(canonicalId, rootPaths, environment));
      for (const range of importMetaRanges) {
        output.overwrite(range.start, range.end, replacement);
        changed = true;
      }
    }
  }

  if (environment === "server" && mayContainServerCjsGlobal(code)) {
    const injected = injectServerCjsGlobals(ast, canonicalId);
    if (injected) {
      output.appendLeft(findDirectivePrologueEnd(ast), `\n${injected}`);
      changed = true;
    }
  }

  if (!changed) return null;
  return {
    code: output.toString(),
    map: output.generateMap({ hires: "boundary" }),
  };
}

function cleanModuleId(id: string): string {
  return id.split("?", 1)[0];
}

function createRootPaths(root: string, options: { outputDirs?: string[] } = {}): RootPaths {
  const canonicalRoot = canonicalizePath(root);
  const normalizedRoot = normalizePath(canonicalRoot);
  return {
    root,
    canonicalRoot,
    normalizedRoot,
    excludedRelativePrefixes: excludedRelativePrefixes(canonicalRoot, normalizedRoot, options),
  };
}

// Returns the canonical module id when the module is eligible for rewriting,
// or null otherwise. Threading the canonical id back to the caller avoids a
// second realpathSync when computing the replacement value.
function transformableModuleCanonicalId(id: string, rootPaths: RootPaths): string | null {
  if (!id || id.startsWith("\0")) return null;
  if (!path.isAbsolute(id)) return null;
  const normalizedInputId = normalizePath(id);
  // Early-exit optimization: skip the realpathSync below for node_modules
  // paths, which are the majority of modules in a typical project. The
  // isPathWithin check below provides a second safety net in case a
  // symlink causes the canonical path to land outside node_modules.
  if (normalizedInputId.includes("/node_modules/")) return null;
  if (!TRANSFORMABLE_SCRIPT_EXTENSIONS.has(path.extname(normalizedInputId))) return null;

  const canonicalId = canonicalizePath(id);
  const normalizedId = normalizePath(canonicalId);
  if (!isPathWithin(normalizedId, rootPaths.normalizedRoot)) return null;

  const relativePath = normalizePath(path.relative(rootPaths.canonicalRoot, canonicalId));
  if (isExcludedRelativePath(relativePath, rootPaths.excludedRelativePrefixes)) return null;
  return canonicalId;
}

function mayContainImportMetaUrl(code: string): boolean {
  return code.includes("import.meta.url") || code.includes("import.meta?.url");
}

function mayContainServerCjsGlobal(code: string): boolean {
  return code.includes("__filename") || code.includes("__dirname");
}

function mayContainSourceIdentityToken(code: string): boolean {
  return mayContainImportMetaUrl(code) || mayContainServerCjsGlobal(code);
}

function excludedRelativePrefixes(
  canonicalRoot: string,
  normalizedRoot: string,
  options: { outputDirs?: string[] },
): string[] {
  // Static list of known output/build directories whose modules must
  // never have import.meta.url rewritten (they are build artifacts, not
  // user source). Custom output directories are added dynamically from
  // config.build.outDir in configResolved. Using .gitignore was considered
  // but adds unnecessary filesystem overhead for this narrow use case.
  const prefixes = new Set([".next", ".vinext", ".vinext-local-package", "dist", "out"]);

  for (const outputDir of options.outputDirs ?? []) {
    const absoluteOutputDir = path.isAbsolute(outputDir)
      ? outputDir
      : path.resolve(canonicalRoot, outputDir);
    const canonicalOutputDir = canonicalizePath(absoluteOutputDir);
    const normalizedOutputDir = normalizePath(canonicalOutputDir);
    if (!isPathWithin(normalizedOutputDir, normalizedRoot)) continue;

    const relativePath = normalizePath(path.relative(canonicalRoot, canonicalOutputDir));
    if (relativePath && relativePath !== ".") prefixes.add(relativePath);
  }

  return [...prefixes];
}

function isExcludedRelativePath(relativePath: string, prefixes: string[]): boolean {
  return prefixes.some(
    (prefix) => relativePath === prefix || relativePath.startsWith(`${prefix}/`),
  );
}

function isPathWithin(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(root.endsWith("/") ? root : `${root}/`);
}

function importMetaUrlValue(
  canonicalId: string,
  rootPaths: RootPaths,
  environment: ImportMetaUrlEnvironment,
): string {
  if (environment === "client") {
    const relativePath = normalizePath(path.relative(rootPaths.canonicalRoot, canonicalId));
    return `file:///ROOT/${relativePath}`;
  }

  return pathToFileURL(canonicalId).href;
}

function canonicalizePath(value: string): string {
  return tryRealpathSync(value) ?? path.resolve(value);
}

function collectImportMetaUrlRanges(ast: unknown): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];

  function visit(value: unknown): void {
    if (!isAstRecord(value)) return;

    if (isImportMetaUrlNode(value)) {
      ranges.push({ start: value.start, end: value.end });
      return;
    }

    if (isChainExpressionWrappingImportMetaUrl(value)) {
      ranges.push({ start: value.start, end: value.end });
      return;
    }

    if (isNewUrlExpression(value)) {
      const args = nodeArray(value.arguments);
      for (let index = 0; index < args.length; index += 1) {
        if (index === 1 && isImportMetaUrlOrChainedNode(args[index])) continue;
        visit(args[index]);
      }
      // The callee is always the bare `URL` identifier (see isNewUrlExpression),
      // so it can never contain an import.meta.url read — no need to visit it.
      return;
    }

    forEachAstChild(value, visit);
  }

  visit(ast);
  return ranges;
}

// Bake __filename/__dirname as top-level `var` literals computed in the plugin
// from the module's canonical path, and let JavaScript scope rules handle
// params, nested locals, object shorthand, assignment behaviour, etc. — simpler
// and more correct than a free-identifier replacement walker that must model
// lexical scope.
//
// The injection rule in one place: inject when the module reads the name and
// nothing in module scope already binds it.
type CjsGlobalName = "__filename" | "__dirname";
const CJS_GLOBALS: readonly CjsGlobalName[] = ["__filename", "__dirname"];

function isCjsGlobalName(name: unknown): name is CjsGlobalName {
  return name === "__filename" || name === "__dirname";
}

function injectServerCjsGlobals(ast: unknown, canonicalId: string): string | null {
  const analysis = analyzeServerCjsGlobals(ast);
  const values: Record<CjsGlobalName, string> = {
    __filename: canonicalId,
    __dirname: path.dirname(canonicalId),
  };
  const parts = CJS_GLOBALS.filter(
    (name) => analysis.reads.has(name) && !analysis.moduleBindings.has(name),
  ).map((name) => `var ${name} = ${JSON.stringify(values[name])};`);
  return parts.length ? parts.join("") : null;
}

type ServerCjsAnalysis = {
  reads: Set<CjsGlobalName>;
  moduleBindings: Set<CjsGlobalName>;
};

// One pass collects the two module facts we need:
//   - reads: names used as values
//   - moduleBindings: names bound anywhere in module scope, including `var`
//     declarations hidden inside top-level blocks and control flow
function analyzeServerCjsGlobals(ast: unknown): ServerCjsAnalysis {
  const reads = new Set<CjsGlobalName>();
  const moduleBindings = new Set<CjsGlobalName>();

  // Recursively walks a binding pattern. Each name found is a module binding.
  function recordBinding(pattern: unknown): void {
    const names = new Set<string>();
    collectBindingNames(pattern, names);
    for (const name of names) {
      if (isCjsGlobalName(name)) moduleBindings.add(name);
    }
  }

  // Records bindings declared directly by a top-level statement. `var` is
  // handled by the recursive walk below so nested blocks and loops use the
  // same rule.
  function recordDirectTopLevelBindings(statement: AstRecord): void {
    const t = statement.type;
    switch (t) {
      case "ImportDeclaration":
        for (const specifier of nodeArray(statement.specifiers)) {
          if (!isAstRecord(specifier)) continue;
          recordBinding(specifier.local);
        }
        return;
      case "VariableDeclaration":
        if (statement.kind === "var") return;
        for (const declarator of nodeArray(statement.declarations)) {
          if (!isAstRecord(declarator) || declarator.type !== "VariableDeclarator") continue;
          recordBinding(declarator.id);
        }
        return;
      case "FunctionDeclaration":
      case "ClassDeclaration":
        recordBinding(statement.id);
        return;
      case "ExportNamedDeclaration":
      case "ExportDefaultDeclaration":
        if (isAstRecord(statement.declaration)) {
          recordDirectTopLevelBindings(statement.declaration);
        }
        return;
    }
  }

  // Walk only syntax whose `var` declarations remain module-scoped. Function
  // and class bodies are scope boundaries.
  function recordModuleScopedVarBindings(node: unknown): void {
    if (!isAstRecord(node)) return;
    const t = node.type;
    switch (t) {
      case "Program":
        for (const statement of nodeArray(node.body)) {
          if (!isAstRecord(statement)) continue;
          recordDirectTopLevelBindings(statement);
          recordModuleScopedVarBindings(statement);
        }
        return;
      case "VariableDeclaration":
        if (node.kind !== "var") return;
        for (const declarator of nodeArray(node.declarations)) {
          if (!isAstRecord(declarator) || declarator.type !== "VariableDeclarator") continue;
          recordBinding(declarator.id);
        }
        return;
      case "FunctionDeclaration":
      case "FunctionExpression":
      case "ArrowFunctionExpression":
      case "ClassDeclaration":
      case "ClassExpression":
        return;
      default:
        for (const child of moduleScopeChildren(node)) {
          recordModuleScopedVarBindings(child);
        }
    }
  }

  function moduleScopeChildren(node: AstRecord): unknown[] {
    const t = node.type;
    switch (t) {
      case "BlockStatement":
        return nodeArray(node.body);
      case "IfStatement":
        return [node.consequent, node.alternate];
      case "SwitchStatement":
        return nodeArray(node.cases);
      case "SwitchCase":
        return nodeArray(node.consequent);
      case "TryStatement":
        return [node.block, node.handler, node.finalizer];
      case "CatchClause":
        return [node.body];
      case "LabeledStatement":
        return [node.body];
      case "ForStatement":
        return [node.init, node.body];
      case "ForInStatement":
      case "ForOfStatement":
        return [node.left, node.body];
      case "WhileStatement":
      case "DoWhileStatement":
      case "WithStatement":
        return [node.body];
      case "ExportNamedDeclaration":
      case "ExportDefaultDeclaration":
        return [node.declaration];
      default:
        return [];
    }
  }

  // Reads are collected from the whole module.
  //
  // The read walker is intentionally broader than the binding walk: it can
  // over-report names that are already bound locally, and the module binding
  // set decides whether injection is safe.
  function recordReads(value: unknown): void {
    if (!isAstRecord(value)) return;
    const t = value.type;
    switch (t) {
      case "Identifier":
        if (isCjsGlobalName(value.name)) reads.add(value.name);
        return;
      case "MemberExpression":
        recordReads(value.object);
        if (value.computed) recordReads(value.property);
        return;
      case "Property":
        if (value.computed) recordReads(value.key);
        recordReads(value.value);
        return;
      case "MethodDefinition":
      case "PropertyDefinition":
        if (value.computed) recordReads(value.key);
        recordReads(value.value);
        return;
      case "ImportDeclaration":
        // Specifiers bind locals; the imported names and module source string
        // are never value reads. (e.g. `import { __filename as foo }` does not
        // read __filename.)
        return;
      case "ExportAllDeclaration":
        // `export * [as name] from "..."` reads no local value; `name` is only
        // an export name, not a reference to a local binding.
        return;
      case "ExportNamedDeclaration":
        // `export const/function/class ...` — recurse into the declaration.
        // `export { local as exported }` — only `local` references a binding,
        // and only when there is no `source` (a re-export points at the source
        // module, not a local). `exported` is always just a name.
        if (isAstRecord(value.declaration)) {
          recordReads(value.declaration);
        } else if (!value.source) {
          for (const specifier of nodeArray(value.specifiers)) {
            if (isAstRecord(specifier)) recordReads(specifier.local);
          }
        }
        return;
      default:
        forEachAstChild(value, recordReads);
    }
  }

  if (isAstRecord(ast) && ast.type === "Program") {
    recordModuleScopedVarBindings(ast);
  }
  recordReads(ast);

  return { reads, moduleBindings };
}

function isImportMetaNode(value: unknown): boolean {
  return (
    isAstRecord(value) &&
    value.type === "MetaProperty" &&
    isIdentifierNamed(value.meta, "import") &&
    isIdentifierNamed(value.property, "meta")
  );
}

function isImportMetaUrlNode(value: unknown): value is AstRange {
  return (
    isAstRecord(value) &&
    value.type === "MemberExpression" &&
    hasRange(value) &&
    isImportMetaNode(value.object) &&
    isIdentifierNamed(value.property, "url")
  );
}

// Accepts both import.meta.url (MemberExpression) and import.meta?.url
// (ChainExpression wrapping a MemberExpression) so that the new URL() skip
// correctly handles optional-chained base arguments.
function isImportMetaUrlOrChainedNode(value: unknown): value is AstRange {
  if (isImportMetaUrlNode(value)) return true;
  return (
    isAstRecord(value) && value.type === "ChainExpression" && isImportMetaUrlNode(value.expression)
  );
}

// Catches the ChainExpression wrapper so we record the outer node range
// and avoid descending into the inner MemberExpression (which happens
// to share the same start/end, but this is more explicit).
function isChainExpressionWrappingImportMetaUrl(value: unknown): value is AstRange {
  return (
    isAstRecord(value) &&
    value.type === "ChainExpression" &&
    hasRange(value) &&
    isImportMetaUrlNode(value.expression)
  );
}

// Only matches bare `new URL(...)`, not `new globalThis.URL(...)` or
// `new window.URL(...)`. Matches Vite's own asset-detection scope.
function isNewUrlExpression(value: AstRecord): boolean {
  return value.type === "NewExpression" && isIdentifierNamed(value.callee, "URL");
}

function findDirectivePrologueEnd(ast: unknown): number {
  if (!isAstRecord(ast) || ast.type !== "Program") return 0;

  // A shebang (`#!...`) lives outside ast.body but must stay the first bytes of
  // the file, so the injection floor starts after it. Inserting at offset 0
  // would move the shebang off line 1 and produce invalid output.
  let end = 0;
  const hashbang = ast.hashbang;
  const hashbangEnd =
    typeof hashbang === "object" && hashbang !== null ? Reflect.get(hashbang, "end") : null;
  if (typeof hashbangEnd === "number") {
    end = hashbangEnd;
  }

  for (const statement of nodeArray(ast.body)) {
    if (
      !isAstRecord(statement) ||
      statement.type !== "ExpressionStatement" ||
      !isAstRecord(statement.expression) ||
      statement.expression.type !== "Literal" ||
      typeof statement.expression.value !== "string" ||
      typeof statement.end !== "number"
    ) {
      break;
    }
    end = statement.end;
  }

  return end;
}
