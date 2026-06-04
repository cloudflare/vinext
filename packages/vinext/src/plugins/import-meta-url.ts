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
  return rewriteCanonicalServerCjsGlobals(code, canonicalId);
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
    const replacements = collectServerCjsGlobalReplacements(ast, {
      __dirname: path.dirname(canonicalId),
      __filename: canonicalId,
    });
    for (const replacement of replacements) {
      output.overwrite(replacement.start, replacement.end, replacement.code);
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

function rewriteCanonicalServerCjsGlobals(code: string, canonicalId: string): RewriteResult | null {
  let ast: unknown;
  try {
    ast = parseAst(code);
  } catch {
    return null;
  }

  const replacements = collectServerCjsGlobalReplacements(ast, {
    __dirname: path.dirname(canonicalId),
    __filename: canonicalId,
  });
  if (replacements.length === 0) return null;

  const output = new MagicString(code);
  for (const replacement of replacements) {
    output.overwrite(replacement.start, replacement.end, replacement.code);
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

type CjsGlobalValues = {
  __dirname: string;
  __filename: string;
};

type CjsGlobalReplacement = {
  start: number;
  end: number;
  code: string;
};

type ScopeKind = "block" | "function" | "program";

type Scope = {
  bindings: Set<string>;
  kind: ScopeKind;
  parent: Scope | null;
};

function collectServerCjsGlobalReplacements(
  ast: unknown,
  values: CjsGlobalValues,
): CjsGlobalReplacement[] {
  const replacements: CjsGlobalReplacement[] = [];
  const rootScope = createScope(null, "program");

  function visit(value: unknown, scope: Scope): void {
    if (!isNodeLike(value)) return;

    if (isCjsGlobalIdentifier(value) && !isBound(value.name, scope) && hasRange(value)) {
      replacements.push({
        start: value.start,
        end: value.end,
        code: JSON.stringify(values[value.name]),
      });
      return;
    }

    const type = value.type;
    if (typeof type !== "string") return;

    switch (type) {
      case "Program":
        visitStatementList(nodeArray(value.body), rootScope);
        return;
      case "BlockStatement":
      case "StaticBlock": {
        const blockScope = createScope(scope, "block");
        visitStatementList(nodeArray(value.body), blockScope);
        return;
      }
      case "VariableDeclaration": {
        const bindingScope = variableDeclarationBindingScope(value, scope);
        for (const declaration of nodeArray(value.declarations)) {
          if (isNodeLike(declaration) && declaration.type === "VariableDeclarator") {
            collectBindingsFromPattern(declaration.id, bindingScope);
          }
        }
        for (const declaration of nodeArray(value.declarations)) {
          visitVariableDeclarator(declaration, scope, bindingScope);
        }
        return;
      }
      case "FunctionDeclaration":
        visitFunctionLike(value, scope, false);
        return;
      case "FunctionExpression":
      case "ArrowFunctionExpression":
        visitFunctionLike(value, scope, true);
        return;
      case "CatchClause": {
        const catchScope = createScope(scope, "block");
        collectBindingsFromPattern(value.param, catchScope);
        visitPatternRuntimeExpressions(value.param, catchScope);
        visit(value.body, catchScope);
        return;
      }
      case "ClassDeclaration":
        visit(value.superClass, scope);
        visit(value.body, scope);
        return;
      case "ClassExpression": {
        const classScope = createScope(scope, "block");
        collectBindingsFromPattern(value.id, classScope);
        visit(value.superClass, scope);
        visit(value.body, classScope);
        return;
      }
      case "ImportDeclaration":
        return;
      case "MemberExpression":
      case "OptionalMemberExpression":
        visit(value.object, scope);
        if (value.computed === true) visit(value.property, scope);
        return;
      case "AssignmentExpression":
        visitAssignmentTargetRuntimeExpressions(value.left, scope);
        visit(value.right, scope);
        return;
      case "UpdateExpression":
        visitAssignmentTargetRuntimeExpressions(value.argument, scope);
        return;
      case "Property":
        visitProperty(value, scope);
        return;
      case "PropertyDefinition":
      case "MethodDefinition":
        if (value.computed === true) visit(value.key, scope);
        visit(value.value, scope);
        return;
      case "LabeledStatement":
        visit(value.body, scope);
        return;
      case "BreakStatement":
      case "ContinueStatement":
        return;
      case "ExportNamedDeclaration":
      case "ExportDefaultDeclaration":
      case "ExportAllDeclaration":
        visit(value.declaration, scope);
        visit(value.source, scope);
        return;
      default:
        break;
    }

    for (const [key, child] of Object.entries(value)) {
      if (key === "type" || key === "start" || key === "end" || key === "loc") continue;
      if (Array.isArray(child)) {
        for (const item of child) visit(item, scope);
      } else {
        visit(child, scope);
      }
    }
  }

  function visitStatementList(statements: unknown[], scope: Scope): void {
    collectStatementListBindings(statements, scope);
    for (const statement of statements) {
      visit(statement, scope);
    }
  }

  function visitVariableDeclarator(value: unknown, scope: Scope, bindingScope: Scope): void {
    if (!isNodeLike(value) || value.type !== "VariableDeclarator") {
      visit(value, scope);
      return;
    }
    collectBindingsFromPattern(value.id, bindingScope);
    visitPatternRuntimeExpressions(value.id, scope);
    visit(value.init, scope);
  }

  function visitFunctionLike(value: NodeLike, outerScope: Scope, expression: boolean): void {
    const functionScope = createScope(outerScope, "function");
    if (!expression) collectBindingsFromPattern(value.id, outerScope);
    collectBindingsFromPattern(value.id, functionScope);
    for (const param of nodeArray(value.params)) {
      collectBindingsFromPattern(param, functionScope);
    }
    for (const param of nodeArray(value.params)) {
      visitPatternRuntimeExpressions(param, functionScope);
    }
    visit(value.body, functionScope);
  }

  function visitPatternRuntimeExpressions(value: unknown, scope: Scope): void {
    if (!isNodeLike(value)) return;

    const type = value.type;
    if (typeof type !== "string") return;

    switch (type) {
      case "Identifier":
        return;
      case "RestElement":
        visitPatternRuntimeExpressions(value.argument, scope);
        return;
      case "AssignmentPattern":
        visitPatternRuntimeExpressions(value.left, scope);
        visit(value.right, scope);
        return;
      case "ArrayPattern":
        for (const element of nodeArray(value.elements)) {
          visitPatternRuntimeExpressions(element, scope);
        }
        return;
      case "ObjectPattern":
        for (const property of nodeArray(value.properties)) {
          if (!isNodeLike(property)) continue;
          if (property.type === "Property") {
            if (property.computed === true) visit(property.key, scope);
            visitPatternRuntimeExpressions(property.value, scope);
          } else {
            visitPatternRuntimeExpressions(property.argument, scope);
          }
        }
        return;
      case "TSParameterProperty":
        visitPatternRuntimeExpressions(value.parameter, scope);
        return;
      default:
        return;
    }
  }

  function visitAssignmentTargetRuntimeExpressions(value: unknown, scope: Scope): void {
    if (!isNodeLike(value)) return;

    const type = value.type;
    if (typeof type !== "string") return;
    if (type === "Identifier") return;

    switch (type) {
      case "ArrayPattern":
      case "AssignmentPattern":
      case "ObjectPattern":
      case "RestElement":
        visitPatternRuntimeExpressions(value, scope);
        return;
      default:
        visit(value, scope);
        return;
    }
  }

  function visitProperty(value: NodeLike, scope: Scope): void {
    if (value.computed === true) {
      visit(value.key, scope);
    }

    if (
      value.shorthand === true &&
      isCjsGlobalIdentifier(value.key) &&
      !isBound(value.key.name, scope)
    ) {
      if (hasRange(value.key)) {
        replacements.push({
          start: value.key.start,
          end: value.key.end,
          code: `${value.key.name}: ${JSON.stringify(values[value.key.name])}`,
        });
      }
      return;
    }

    visit(value.value, scope);
  }

  visit(ast, rootScope);
  return replacements;
}

function createScope(parent: Scope | null, kind: ScopeKind): Scope {
  return { bindings: new Set(), kind, parent };
}

function isBound(name: string, scope: Scope): boolean {
  let current: Scope | null = scope;
  while (current) {
    if (current.bindings.has(name)) return true;
    current = current.parent;
  }
  return false;
}

function collectStatementListBindings(statements: unknown[], scope: Scope): void {
  for (const statement of statements) {
    collectStatementBindings(statement, scope);
  }
}

function collectStatementBindings(statement: unknown, scope: Scope): void {
  if (!isNodeLike(statement)) return;

  const type = statement.type;
  if (typeof type !== "string") return;

  switch (type) {
    case "VariableDeclaration": {
      const bindingScope = variableDeclarationBindingScope(statement, scope);
      for (const declaration of nodeArray(statement.declarations)) {
        if (isNodeLike(declaration) && declaration.type === "VariableDeclarator") {
          collectBindingsFromPattern(declaration.id, bindingScope);
        }
      }
      return;
    }
    case "FunctionDeclaration":
    case "ClassDeclaration":
      collectBindingsFromPattern(statement.id, scope);
      return;
    case "ImportDeclaration":
      for (const specifier of nodeArray(statement.specifiers)) {
        if (isNodeLike(specifier)) {
          collectBindingsFromPattern(specifier.local, scope);
        }
      }
      return;
    case "ExportNamedDeclaration":
    case "ExportDefaultDeclaration":
      collectStatementBindings(statement.declaration, scope);
      return;
    default:
      return;
  }
}

function variableDeclarationBindingScope(value: NodeLike, scope: Scope): Scope {
  return value.kind === "var" ? nearestVarScope(scope) : scope;
}

function nearestVarScope(scope: Scope): Scope {
  let current: Scope | null = scope;
  while (current) {
    if (current.kind === "function" || current.kind === "program") return current;
    current = current.parent;
  }
  return scope;
}

function collectBindingsFromPattern(value: unknown, scope: Scope): void {
  if (!isNodeLike(value)) return;

  if (isCjsGlobalIdentifier(value)) {
    scope.bindings.add(value.name);
    return;
  }

  const type = value.type;
  if (typeof type !== "string") return;

  switch (type) {
    case "Identifier":
      return;
    case "RestElement":
      collectBindingsFromPattern(value.argument, scope);
      return;
    case "AssignmentPattern":
      collectBindingsFromPattern(value.left, scope);
      return;
    case "ArrayPattern":
      for (const element of nodeArray(value.elements)) {
        collectBindingsFromPattern(element, scope);
      }
      return;
    case "ObjectPattern":
      for (const property of nodeArray(value.properties)) {
        if (!isNodeLike(property)) continue;
        if (property.type === "Property") {
          collectBindingsFromPattern(property.value, scope);
        } else {
          collectBindingsFromPattern(property.argument, scope);
        }
      }
      return;
    case "TSParameterProperty":
      collectBindingsFromPattern(value.parameter, scope);
      return;
    default:
      return;
  }
}

function isCjsGlobalIdentifier(
  value: unknown,
): value is NodeLike & { name: "__dirname" | "__filename" } {
  return (
    isNodeLike(value) &&
    value.type === "Identifier" &&
    (value.name === "__filename" || value.name === "__dirname")
  );
}

function hasRange(value: NodeLike): value is NodeLike & { start: number; end: number } {
  return typeof value.start === "number" && typeof value.end === "number";
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

function nodeArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
