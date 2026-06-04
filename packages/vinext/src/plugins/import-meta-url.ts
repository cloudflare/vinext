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
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

type NodeLike = {
  type?: string;
  start?: number;
  end?: number;
  [key: string]: unknown;
};

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

export function rewriteImportMetaUrl(
  code: string,
  id: string,
  root: string,
  environment: ImportMetaUrlEnvironment,
): RewriteResult | null {
  if (!mayContainImportMetaUrl(code)) return null;
  return rewriteCanonicalImportMetaUrl(
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
  const canonicalId = canonicalizePath(id);
  const normalizedId = normalizePath(canonicalId);
  if (!isPathWithin(normalizedId, rootPaths.normalizedRoot)) return null;
  const relativePath = normalizePath(path.relative(rootPaths.canonicalRoot, canonicalId));
  if (isExcludedRelativePath(relativePath, rootPaths.excludedRelativePrefixes)) return null;
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

  const importMetaRanges = collectImportMetaUrlRanges(ast);
  if (importMetaRanges.length > 0) {
    const replacement = JSON.stringify(importMetaUrlValue(canonicalId, rootPaths, environment));
    for (const range of importMetaRanges) {
      output.overwrite(range.start, range.end, replacement);
      changed = true;
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

function rewriteCanonicalImportMetaUrl(
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

  const ranges = collectImportMetaUrlRanges(ast);
  if (ranges.length === 0) return null;

  const replacement = JSON.stringify(importMetaUrlValue(canonicalId, rootPaths, environment));
  const output = new MagicString(code);
  for (const range of ranges) {
    output.overwrite(range.start, range.end, replacement);
  }

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
  try {
    return fs.realpathSync.native(value);
  } catch {
    return path.resolve(value);
  }
}

function collectImportMetaUrlRanges(ast: unknown): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];

  function visit(value: unknown): void {
    if (!isNodeLike(value)) return;

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

    for (const [key, child] of Object.entries(value)) {
      if (key === "type" || key === "start" || key === "end" || key === "loc") continue;
      if (Array.isArray(child)) {
        for (const item of child) visit(item);
      } else {
        visit(child);
      }
    }
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
// Each name is injected independently, only when the source genuinely reads it
// (not just a member-access/key/lookalike mention) AND there is no conflicting
// top-level binding of that name (a `var` colliding with a top-level
// let/const/class/import would be a SyntaxError).
function injectServerCjsGlobals(ast: unknown, canonicalId: string): string | null {
  const values = { __filename: canonicalId, __dirname: path.dirname(canonicalId) } as const;
  const parts = (["__filename", "__dirname"] as const)
    .filter((name) => hasReadReference(ast, name) && !hasTopLevelBinding(ast, name))
    .map((name) => `var ${name} = ${JSON.stringify(values[name])};`);
  return parts.length ? parts.join("") : null;
}

// Reports whether `name` appears as a genuine read reference anywhere in the
// module — an Identifier in value position. Excludes positions that name the
// identifier without reading the binding: non-computed member properties
// (`obj.__filename`), non-computed object/class keys (`{ __filename: 1 }`,
// `class { __filename() {} }`), and lookalikes (`__filenameFoo`). Object
// shorthand values, computed keys/members, default values, and assignment/update
// targets all count as reads.
//
// This is a syntactic read check, not full scope resolution: it does not prove
// the read is *free* (unbound), so a name read only within a scope that also
// binds it may still be reported. That is harmless — collision safety is handled
// by hasTopLevelBinding, and an over-report at worst injects an unused `var`.
function hasReadReference(ast: unknown, name: string): boolean {
  let found = false;
  function visit(value: unknown): void {
    if (found || !isNodeLike(value)) return;
    switch (value.type) {
      case "Identifier":
        if (value.name === name) found = true;
        return;
      case "MemberExpression":
        // `obj[x]` reads x; `obj.x` does not.
        visit(value.object);
        if (value.computed) visit(value.property);
        return;
      case "Property":
        // `{ [x]: v }` reads x; the key in `{ x: v }` / `{ x }` does not. The
        // value (or the shorthand identifier, stored as value) is always a read.
        if (value.computed) visit(value.key);
        visit(value.value);
        return;
      case "MethodDefinition":
      case "PropertyDefinition":
        // Class member: the name is a read only when computed.
        if (value.computed) visit(value.key);
        visit(value.value);
        return;
      default:
        for (const [key, child] of Object.entries(value)) {
          if (key === "type" || key === "start" || key === "end" || key === "loc") continue;
          if (Array.isArray(child)) {
            for (const item of child) visit(item);
          } else {
            visit(child);
          }
        }
    }
  }
  visit(ast);
  return found;
}

// Reports whether `name` is bound by a top-level declaration whose kind would
// make an injected `var ${name}` a redeclaration SyntaxError (let/const/class/
// import) or otherwise shadow our binding (function/var/destructuring). Walks
// only the program body — nested bindings are correctly shadowed by JS scope.
function hasTopLevelBinding(ast: unknown, name: string): boolean {
  if (!isNodeLike(ast) || ast.type !== "Program") return false;
  return nodeArray(ast.body).some((statement) => declaresBinding(statement, name));
}

// Vite's parseAst (rolldown/oxc) rejects TypeScript syntax, and this plugin
// runs `enforce: "post"` after TS has been stripped, so only plain-JS binding
// forms can ever reach here — no `import type`, `enum`, `namespace`, `declare`,
// or `import =` nodes/fields to account for.
function declaresBinding(node: unknown, name: string): boolean {
  if (!isNodeLike(node)) return false;
  switch (node.type) {
    case "ImportDeclaration":
      return nodeArray(node.specifiers).some((s) => isNodeLike(s) && bindsName(s.local, name));
    case "VariableDeclaration":
      return nodeArray(node.declarations).some((d) => isNodeLike(d) && bindsName(d.id, name));
    case "FunctionDeclaration":
    case "ClassDeclaration":
      return isIdentifierNamed(node.id, name);
    case "ExportNamedDeclaration":
    case "ExportDefaultDeclaration":
      return declaresBinding(node.declaration, name);
    case "ForStatement":
      return declaresVarHead(node.init, name);
    case "ForInStatement":
    case "ForOfStatement":
      return declaresVarHead(node.left, name);
    default:
      return false;
  }
}

function declaresVarHead(node: unknown, name: string): boolean {
  return (
    isNodeLike(node) &&
    node.type === "VariableDeclaration" &&
    node.kind === "var" &&
    declaresBinding(node, name)
  );
}

// Recursively checks a binding target (identifier or destructuring pattern).
function bindsName(value: unknown, name: string): boolean {
  if (!isNodeLike(value)) return false;
  if (isIdentifierNamed(value, name)) return true;
  switch (value.type) {
    case "RestElement":
      return bindsName(value.argument, name);
    case "AssignmentPattern":
      return bindsName(value.left, name);
    case "ArrayPattern":
      return nodeArray(value.elements).some((e) => bindsName(e, name));
    case "ObjectPattern":
      return nodeArray(value.properties).some((p) =>
        isNodeLike(p) ? bindsName(p.type === "Property" ? p.value : p.argument, name) : false,
      );
    default:
      return false;
  }
}

function isNodeLike(value: unknown): value is NodeLike {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isIdentifierNamed(value: unknown, name: string): boolean {
  return isNodeLike(value) && value.type === "Identifier" && value.name === name;
}

function isImportMetaNode(value: unknown): boolean {
  return (
    isNodeLike(value) &&
    value.type === "MetaProperty" &&
    isIdentifierNamed(value.meta, "import") &&
    isIdentifierNamed(value.property, "meta")
  );
}

function isImportMetaUrlNode(value: unknown): value is NodeLike & { start: number; end: number } {
  return (
    isNodeLike(value) &&
    value.type === "MemberExpression" &&
    typeof value.start === "number" &&
    typeof value.end === "number" &&
    isImportMetaNode(value.object) &&
    isIdentifierNamed(value.property, "url")
  );
}

// Accepts both import.meta.url (MemberExpression) and import.meta?.url
// (ChainExpression wrapping a MemberExpression) so that the new URL() skip
// correctly handles optional-chained base arguments.
function isImportMetaUrlOrChainedNode(
  value: unknown,
): value is NodeLike & { start: number; end: number } {
  if (isImportMetaUrlNode(value)) return true;
  return (
    isNodeLike(value) && value.type === "ChainExpression" && isImportMetaUrlNode(value.expression)
  );
}

// Catches the ChainExpression wrapper so we record the outer node range
// and avoid descending into the inner MemberExpression (which happens
// to share the same start/end, but this is more explicit).
function isChainExpressionWrappingImportMetaUrl(
  value: unknown,
): value is NodeLike & { start: number; end: number } {
  return (
    isNodeLike(value) &&
    value.type === "ChainExpression" &&
    typeof value.start === "number" &&
    typeof value.end === "number" &&
    isImportMetaUrlNode(value.expression)
  );
}

// Only matches bare `new URL(...)`, not `new globalThis.URL(...)` or
// `new window.URL(...)`. Matches Vite's own asset-detection scope.
function isNewUrlExpression(value: NodeLike): boolean {
  return value.type === "NewExpression" && isIdentifierNamed(value.callee, "URL");
}

function findDirectivePrologueEnd(ast: unknown): number {
  if (!isNodeLike(ast) || ast.type !== "Program") return 0;

  let end = 0;
  for (const statement of nodeArray(ast.body)) {
    if (
      !isNodeLike(statement) ||
      statement.type !== "ExpressionStatement" ||
      !isNodeLike(statement.expression) ||
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

function nodeArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
