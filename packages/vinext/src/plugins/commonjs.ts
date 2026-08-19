import MagicString from "magic-string";
import { realpath, stat } from "node:fs/promises";
import path, { toSlash } from "pathslash";
import {
  createFilter,
  parseAst,
  parseAstAsync,
  type Alias,
  type Environment,
  type Plugin,
} from "vite";
import {
  collectBindingNames,
  forEachAstChild,
  getAstName,
  hasRange,
  isAstRecord,
  isIdentifierNamed,
  nodeArray,
  scriptParserLanguage,
  staticStringValue,
  unwrapExpression,
  type AstRecord,
} from "./ast-utils.js";
import {
  collectDirectScopeBindings,
  collectLoopScopeBindings,
  collectSwitchScopeBindings,
  collectVarScopeBindings,
  createAstScope,
  hasAstBinding,
  isFunctionNode,
  type AstScope,
} from "./ast-scope.js";
import { magicStringTransformResult, type MagicStringTransformResult } from "./transform-result.js";
import { hasDynamicRequestIgnoreDirective } from "./dynamic-request-utils.js";
import { stripViteModuleQuery } from "../utils/path.js";
import { packageNameFromSpecifier } from "../utils/package-name.js";
import { listFilesFollowingSymlinks } from "../utils/list-files.js";

const COMMONJS_PRESCAN = /\b(?:require|module|exports)\b/;
const IDENTIFIER_NAME_RE = /^[$_\p{ID_Start}][$\u200C\u200D\p{ID_Continue}]*$/u;
const DEFAULT_COMMONJS_EXTENSIONS = [
  ".mjs",
  ".js",
  ".cjs",
  ".mts",
  ".ts",
  ".cts",
  ".jsx",
  ".tsx",
  ".json",
] as const;
const DYNAMIC_REQUIRE_EXTENSIONS = [
  ".vue",
  ".svelte",
  ".png",
  ".jpg",
  ".jpeg",
  ".jfif",
  ".pjpeg",
  ".pjp",
  ".gif",
  ".svg",
  ".ico",
  ".webp",
  ".avif",
  ".mp4",
  ".webm",
  ".ogg",
  ".mp3",
  ".wav",
  ".flac",
  ".aac",
  ".woff",
  ".woff2",
  ".eot",
  ".ttf",
  ".otf",
  ".webmanifest",
  ".pdf",
  ".txt",
  ".css",
  ".less",
  ".sass",
  ".scss",
  ".styl",
  ".stylus",
  ".pcss",
  ".postcss",
] as const;

function commonJsExtensionFilter(extensions: readonly string[]): RegExp {
  const patterns = [...new Set(extensions)]
    .filter(Boolean)
    .map((extension) => extension.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return patterns.length > 0 ? new RegExp(`(?:${patterns.join("|")})(?:[?#].*)?$`, "i") : /a^/;
}

type StaticRequire = {
  node: AstRecord & { start: number; end: number };
  specifier: string;
};

type DynamicRequire = {
  argument: AstRecord & { start: number; end: number };
  callee: AstRecord & { start: number; end: number };
  ignored: boolean;
  node: AstRecord & { start: number; end: number };
};

type CommonJsAnalysis = {
  requires: StaticRequire[];
  dynamicRequires: DynamicRequire[];
  argumentlessRequires: Array<AstRecord & { start: number; end: number }>;
  bindings: Set<string>;
  hasExports: boolean;
  namedExports: string[];
};

type WrapperVarClassification = {
  initialized: Set<string>;
  noOp: Set<string>;
};

function wrapperVarName(value: unknown): "require" | "module" | "exports" | null {
  const name = getAstName(value);
  return name === "require" || name === "module" || name === "exports" ? name : null;
}

function isWrapperPreservingInitializer(
  name: "require" | "module" | "exports",
  value: unknown,
): boolean {
  const initializer = unwrapExpression(value);
  if (!initializer) return true;
  if (isIdentifierNamed(initializer, name)) return true;
  if (
    name === "exports" &&
    initializer.type === "MemberExpression" &&
    isIdentifierNamed(unwrapExpression(initializer.object), "module") &&
    memberPropertyName(initializer) === "exports"
  ) {
    return true;
  }
  if (
    (initializer.type === "LogicalExpression" || initializer.type === "BinaryExpression") &&
    (initializer.operator === "||" || initializer.operator === "??") &&
    isIdentifierNamed(unwrapExpression(initializer.left), name)
  ) {
    return true;
  }
  return false;
}

function classifyRootWrapperVars(root: AstRecord): WrapperVarClassification {
  const classification: WrapperVarClassification = {
    initialized: new Set(),
    noOp: new Set(),
  };

  function visit(node: AstRecord, isRoot = false): void {
    if (
      !isRoot &&
      (isFunctionNode(node) || node.type === "StaticBlock" || node.type === "TSModuleBlock")
    ) {
      return;
    }
    if (node.type === "VariableDeclaration" && node.kind === "var" && node.declare !== true) {
      for (const declarator of nodeArray(node.declarations)) {
        if (!isAstRecord(declarator)) continue;
        const name = wrapperVarName(declarator.id);
        if (!name) continue;
        classification.noOp.add(name);
      }
    }
    forEachAstChild(node, (child) => visit(child));
  }

  visit(root, true);
  // Preserve the existing scope-aware improvement for direct, unconditional
  // wrapper replacements. Nested initializers are control-flow dependent, so
  // transforming them matches the original plugin and CommonJS wrapper model.
  for (const statement of nodeArray(root.body)) {
    if (!isAstRecord(statement) || statement.type !== "VariableDeclaration") continue;
    if (statement.kind !== "var" || statement.declare === true) continue;
    for (const declarator of nodeArray(statement.declarations)) {
      if (!isAstRecord(declarator)) continue;
      const name = wrapperVarName(declarator.id);
      if (name && !isWrapperPreservingInitializer(name, declarator.init)) {
        classification.initialized.add(name);
      }
    }
  }
  for (const name of classification.initialized) classification.noOp.delete(name);
  return classification;
}

function removeNoOpDirectVarBindings(
  scope: AstScope,
  noOpWrapperVars: ReadonlySet<string>,
  directVarBindings: ReadonlySet<string>,
): void {
  for (const name of noOpWrapperVars) {
    if (directVarBindings.has(name)) scope.bindings.delete(name);
  }
}

function memberPropertyName(node: AstRecord): string | null {
  const property = unwrapExpression(node.property);
  if (!property) return null;
  if (node.computed === true) return staticStringValue(property);
  return getAstName(property);
}

function isUnboundModuleExports(node: AstRecord | null, scope: AstScope): boolean {
  if (node?.type !== "MemberExpression" || hasAstBinding(scope, "module")) return false;
  return (
    isIdentifierNamed(unwrapExpression(node.object), "module") &&
    memberPropertyName(node) === "exports"
  );
}

function commonJsExportName(node: AstRecord, scope: AstScope): string | null | undefined {
  if (node.type !== "MemberExpression") return undefined;
  const object = unwrapExpression(node.object);
  if (isIdentifierNamed(object, "exports") && !hasAstBinding(scope, "exports")) {
    return memberPropertyName(node);
  }
  if (isUnboundModuleExports(node, scope)) return null;
  if (isUnboundModuleExports(object, scope)) return memberPropertyName(node);
  return undefined;
}

function analyzeCommonJsAst(
  code: string,
  ast: ReturnType<typeof parseAst>,
): CommonJsAnalysis | null {
  const root = isAstRecord(ast) ? ast : null;
  if (!root) return null;

  const rootScope = createAstScope(null);
  collectDirectScopeBindings(root, rootScope);
  collectVarScopeBindings(root, rootScope);
  // In Node's CommonJS wrapper, a top-level `var require`, `var module`, or
  // `var exports` without an initializer redeclares the wrapper parameter and
  // leaves its value intact. Treat that narrow form as the ambient CJS binding.
  const { noOp: noOpWrapperVars } = classifyRootWrapperVars(root);
  for (const name of noOpWrapperVars) rootScope.bindings.delete(name);
  const bindings = new Set(rootScope.bindings);
  const requires: StaticRequire[] = [];
  const dynamicRequires: DynamicRequire[] = [];
  const argumentlessRequires: Array<AstRecord & { start: number; end: number }> = [];
  const namedExports = new Set<string>();
  let hasExports = false;

  function visit(node: AstRecord, parentScope: AstScope): void {
    if (node.type === "Identifier" && typeof node.name === "string") bindings.add(node.name);
    let scope = parentScope;
    if (isFunctionNode(node)) {
      const parameterScope = createAstScope(parentScope);
      collectBindingNames(node.id, parameterScope.bindings);
      for (const binding of parameterScope.bindings) bindings.add(binding);
      for (const parameter of nodeArray(node.params)) {
        collectBindingNames(parameter, parameterScope.bindings);
        for (const binding of parameterScope.bindings) bindings.add(binding);
        if (isAstRecord(parameter)) visit(parameter, parameterScope);
      }
      const body = isAstRecord(node.body) ? node.body : null;
      if (body) {
        const bodyScope = createAstScope(parameterScope);
        collectDirectScopeBindings(body, bodyScope);
        collectVarScopeBindings(body, bodyScope);
        for (const binding of bodyScope.bindings) bindings.add(binding);
        if (body.type === "BlockStatement") {
          for (const statement of nodeArray(body.body)) {
            if (isAstRecord(statement)) visit(statement, bodyScope);
          }
        } else {
          visit(body, bodyScope);
        }
      }
      return;
    }
    if (node.type === "SwitchStatement") {
      if (isAstRecord(node.discriminant)) visit(node.discriminant, parentScope);
      const switchScope = createAstScope(parentScope);
      const directVarBindings = new Set<string>();
      collectSwitchScopeBindings(node, switchScope, (declaration, declarator) => {
        if (declaration.kind === "var") collectBindingNames(declarator.id, directVarBindings);
      });
      removeNoOpDirectVarBindings(switchScope, noOpWrapperVars, directVarBindings);
      for (const binding of switchScope.bindings) bindings.add(binding);
      for (const switchCase of nodeArray(node.cases)) {
        if (isAstRecord(switchCase)) visit(switchCase, switchScope);
      }
      return;
    }
    if (
      (node.type === "BlockStatement" && node !== root) ||
      node.type === "StaticBlock" ||
      node.type === "TSModuleBlock"
    ) {
      scope = createAstScope(parentScope);
      const directVarBindings = new Set<string>();
      collectDirectScopeBindings(node, scope, (declaration, declarator) => {
        if (declaration.kind === "var") collectBindingNames(declarator.id, directVarBindings);
      });
      removeNoOpDirectVarBindings(scope, noOpWrapperVars, directVarBindings);
      if (node.type === "StaticBlock" || node.type === "TSModuleBlock") {
        collectVarScopeBindings(node, scope);
      }
      for (const binding of scope.bindings) bindings.add(binding);
    } else if (node.type === "CatchClause") {
      scope = createAstScope(parentScope);
      collectBindingNames(node.param, scope.bindings);
      for (const binding of scope.bindings) bindings.add(binding);
    } else if (
      node.type === "ForStatement" ||
      node.type === "ForInStatement" ||
      node.type === "ForOfStatement"
    ) {
      scope = createAstScope(parentScope);
      const directVarBindings = new Set<string>();
      collectLoopScopeBindings(node, scope, (declaration, declarator) => {
        if (declaration.kind === "var") collectBindingNames(declarator.id, directVarBindings);
      });
      removeNoOpDirectVarBindings(scope, noOpWrapperVars, directVarBindings);
      for (const binding of scope.bindings) bindings.add(binding);
    } else if (node.type === "ClassExpression" && node.id) {
      scope = createAstScope(parentScope);
      collectBindingNames(node.id, scope.bindings);
      for (const binding of scope.bindings) bindings.add(binding);
    }

    if (node.type === "CallExpression" && hasRange(node)) {
      const callee = unwrapExpression(node.callee);
      const args = nodeArray(node.arguments);
      const argument = unwrapExpression(args[0]);
      const specifier = staticStringValue(argument);
      if (isIdentifierNamed(callee, "require") && !hasAstBinding(scope, "require")) {
        if (!argument) {
          argumentlessRequires.push(node);
          return;
        }
        if (specifier !== null) {
          requires.push({ node, specifier });
          return;
        } else if (hasRange(argument) && hasRange(callee)) {
          dynamicRequires.push({
            argument,
            callee,
            ignored: hasDynamicRequestIgnoreDirective(code, node, argument),
            node,
          });
        }
      }
    } else if (node.type === "AssignmentExpression") {
      const left = unwrapExpression(node.left);
      const exportName = left ? commonJsExportName(left, scope) : undefined;
      if (exportName !== undefined) {
        hasExports = true;
        if (exportName && exportName !== "default" && IDENTIFIER_NAME_RE.test(exportName)) {
          namedExports.add(exportName);
        }
      }
    }

    forEachAstChild(node, (child) => visit(child, scope));
  }

  for (const statement of nodeArray(root.body)) {
    if (isAstRecord(statement)) visit(statement, rootScope);
  }
  return {
    requires,
    dynamicRequires,
    argumentlessRequires,
    bindings,
    hasExports,
    namedExports: [...namedExports],
  };
}

function analyzeCommonJs(code: string, id: string): CommonJsAnalysis | null {
  if (!COMMONJS_PRESCAN.test(code)) return null;
  try {
    return analyzeCommonJsAst(code, parseAst(code, { lang: scriptParserLanguage(id) ?? "jsx" }));
  } catch {
    return null;
  }
}

async function analyzeCommonJsAsync(code: string, id: string): Promise<CommonJsAnalysis | null> {
  if (!COMMONJS_PRESCAN.test(code)) return null;
  try {
    return analyzeCommonJsAst(
      code,
      await parseAstAsync(code, { lang: scriptParserLanguage(id) ?? "jsx" }),
    );
  } catch {
    return null;
  }
}

type DynamicRequireCandidate = {
  cases: string[];
  depth: number;
  specifier: string;
};

type ResolvedDynamicRequire = DynamicRequire & {
  candidates: DynamicRequireCandidate[];
};

type DynamicPatternResolution = {
  cwd: string;
  globPattern: string;
  runtimePattern: string;
  importSpecifier(absolute: string): string;
  resolvedMatch(absolute: string): string;
};

type DynamicGlobPattern = {
  globPattern: string;
  resolvedPattern: string;
  runtimePattern: string;
};

function templateElementValue(node: AstRecord): string | null {
  if (node.type !== "TemplateElement" || typeof node.value !== "object" || !node.value) {
    return null;
  }
  const cooked = Reflect.get(node.value, "cooked");
  const raw = Reflect.get(node.value, "raw");
  return typeof cooked === "string" ? cooked : typeof raw === "string" ? raw : null;
}

function dynamicRequirePattern(value: unknown): string | null {
  const node = unwrapExpression(value);
  if (!node) return null;
  const literal = staticStringValue(node);
  if (literal !== null) return literal;
  if (node.type === "TemplateLiteral") {
    const quasis = nodeArray(node.quasis).filter(isAstRecord);
    const expressions = nodeArray(node.expressions);
    let pattern = "";
    for (let index = 0; index < quasis.length; index++) {
      const text = templateElementValue(quasis[index]);
      if (text === null || text.includes("*")) return null;
      pattern += text;
      if (index < expressions.length) pattern += "*";
    }
    return pattern;
  }
  if (node.type === "BinaryExpression" && node.operator === "+") {
    const left = dynamicRequirePattern(node.left);
    const right = dynamicRequirePattern(node.right);
    return left === null || right === null ? null : left + right;
  }
  if (node.type === "CallExpression") {
    const callee = unwrapExpression(node.callee);
    if (callee?.type !== "MemberExpression" || memberPropertyName(callee) !== "concat") return "*";
    const object = dynamicRequirePattern(callee.object);
    if (object === null) return null;
    let pattern = object;
    for (const argument of nodeArray(node.arguments)) {
      const part = dynamicRequirePattern(argument);
      if (part === null) return null;
      pattern += part;
    }
    return pattern;
  }
  return "*";
}

function normalizedDynamicRequirePattern(value: unknown): string | null {
  return dynamicRequirePattern(value)?.replace(/\*+/g, "*") ?? null;
}

function assertSupportedDynamicRequires(code: string, analysis: CommonJsAnalysis): void {
  const unsupportedDynamic = analysis.dynamicRequires.find((request) => {
    if (request.ignored) return false;
    const pattern = normalizedDynamicRequirePattern(request.argument);
    return pattern === null || pattern.startsWith("*") || pattern.replaceAll("*", "") === "";
  });
  const range = analysis.argumentlessRequires[0] ?? unsupportedDynamic?.node;
  if (!range) return;

  const source = code.slice(range.start, range.end);
  throw new Error(
    `invalid import ${JSON.stringify(source)}. It cannot be statically analyzed. ` +
      "Dynamic requires must include a statically known path segment.",
  );
}

function extensionlessCases(specifier: string): string[] {
  const extension = path.extname(specifier);
  const cases = new Set([specifier]);
  if (extension) cases.add(specifier.slice(0, -extension.length));
  const basename = extension ? path.basename(specifier, extension) : path.basename(specifier);
  if (basename === "index") {
    const directory = path.dirname(specifier);
    cases.add(directory === "." ? "." : directory);
  }
  return [...cases];
}

function looseGlobPatterns(pattern: string): string[] {
  if (pattern.includes("**")) return [pattern];
  const lastWildcard = pattern.lastIndexOf("*");
  if (lastWildcard === -1) return [pattern];
  const head = pattern.slice(0, lastWildcard + 1);
  const tail = pattern.slice(lastWildcard + 1);
  return [pattern, head.endsWith("/*") ? `${head}*/*${tail}` : `${head}/**/*${tail}`];
}

function dynamicGlobPatterns(
  resolvedPattern: string,
  runtimePattern: string,
  extensions: readonly string[],
): DynamicGlobPattern[] {
  const patterns = path.extname(resolvedPattern)
    ? [{ resolvedPattern, runtimePattern }]
    : [
        { resolvedPattern, runtimePattern },
        ...extensions.flatMap((extension) => [
          {
            resolvedPattern: resolvedPattern + extension,
            runtimePattern: runtimePattern + extension,
          },
          {
            resolvedPattern: path.join(resolvedPattern, `index${extension}`),
            runtimePattern: path.join(runtimePattern, `index${extension}`),
          },
        ]),
      ];
  const results = new Map<string, DynamicGlobPattern>();
  for (const pattern of patterns) {
    for (const globPattern of looseGlobPatterns(pattern.resolvedPattern)) {
      const result = { globPattern, ...pattern };
      results.set(`${globPattern}\0${pattern.runtimePattern}`, result);
    }
  }
  return [...results.values()];
}

function firstGlobMagicIndex(pattern: string): number {
  const simpleMagic = pattern.search(/[?*[{]/);
  const extglobMagic = pattern.search(/[+@!]\(/);
  if (simpleMagic === -1) return extglobMagic;
  if (extglobMagic === -1) return simpleMagic;
  return Math.min(simpleMagic, extglobMagic);
}

function globStaticPrefix(pattern: string): string {
  const firstMagic = firstGlobMagicIndex(pattern);
  return firstMagic === -1 ? pattern : pattern.slice(0, firstMagic);
}

export function globTraversalRoot(absolutePattern: string): string {
  const firstMagic = firstGlobMagicIndex(absolutePattern);
  if (firstMagic === -1) return path.dirname(absolutePattern);
  const staticPrefix = absolutePattern.slice(0, firstMagic);
  if (!staticPrefix.endsWith("/")) return path.dirname(staticPrefix);
  const root = path.parse(absolutePattern).root;
  return staticPrefix === root ? root : staticPrefix.slice(0, -1) || root;
}

function generatedGlobMatcher(pattern: string): (value: string) => boolean {
  if (/[?[\]{}()!]/.test(pattern)) return createFilter(pattern);
  let source = "^";
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index];
    if (character !== "*") {
      source += character.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
      continue;
    }
    if (pattern[index + 1] !== "*") {
      source += index === 0 || pattern[index - 1] === "/" ? "(?!\\.)[^/]*" : "[^/]*";
      continue;
    }
    index++;
    if (pattern[index + 1] === "/") {
      source += "(?:(?!\\.)[^/]+/)*";
      index++;
    } else {
      source += ".*";
    }
  }
  const regexp = new RegExp(`${source}$`);
  return (value) => regexp.test(value);
}

function runtimeMatchForPattern(
  resolvedPattern: string,
  runtimePattern: string,
  resolvedMatch: string,
): string {
  const resolvedPrefix = globStaticPrefix(resolvedPattern);
  const runtimePrefix = globStaticPrefix(runtimePattern);
  return `${runtimePrefix}${resolvedMatch.slice(resolvedPrefix.length)}`;
}

function patternIncludesExplicitDotEntry(pattern: string): boolean {
  return pattern
    .split("/")
    .some((segment) => segment.startsWith(".") && segment !== "." && segment !== "..");
}

async function findPackageDirectory(
  importerDirectory: string,
  packageName: string,
  preserveSymlinks: boolean,
): Promise<string | null> {
  let directory = importerDirectory;
  for (;;) {
    const candidate = path.join(directory, "node_modules", packageName);
    try {
      if ((await stat(candidate)).isDirectory()) {
        return preserveSymlinks ? candidate : toSlash(await realpath(candidate));
      }
    } catch {}
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

function barePatternBase(pattern: string): string | null {
  const packageName = packageNameFromSpecifier(pattern);
  if (packageName) return packageName;
  const wildcard = pattern.indexOf("*");
  const separator = wildcard === -1 ? -1 : pattern.lastIndexOf("/", wildcard);
  if (separator <= 0) return null;
  const staticBase = pattern.slice(0, separator);
  if (/^@[A-Za-z0-9._~-]+$/.test(staticBase)) return staticBase;
  return packageNameFromSpecifier(`${staticBase}/placeholder`) ? staticBase : null;
}

async function resolveDynamicPattern(
  pattern: string,
  importerDirectory: string,
  aliases: readonly Alias[],
  root: string,
  preserveSymlinks: boolean,
): Promise<DynamicPatternResolution | null> {
  for (const alias of aliases) {
    const matches =
      typeof alias.find === "string"
        ? pattern === alias.find || pattern.startsWith(`${alias.find}/`)
        : new RegExp(alias.find.source, alias.find.flags).test(pattern);
    if (!matches) continue;
    const replaced = pattern.replace(alias.find, toSlash(alias.replacement));
    const resolvedPattern = path.isAbsolute(replaced) ? replaced : path.resolve(root, replaced);
    return {
      cwd: path.parse(resolvedPattern).root,
      globPattern: resolvedPattern,
      runtimePattern: pattern,
      importSpecifier: toSlash,
      resolvedMatch: toSlash,
    };
  }
  if (pattern.startsWith("./") || pattern.startsWith("../")) {
    return {
      cwd: importerDirectory,
      globPattern: pattern,
      runtimePattern: pattern,
      importSpecifier(absolute) {
        const relative = toSlash(path.relative(importerDirectory, absolute));
        return relative.startsWith(".") ? relative : `./${relative}`;
      },
      resolvedMatch(absolute) {
        const relative = toSlash(path.relative(importerDirectory, absolute));
        return pattern.startsWith("./") && !relative.startsWith(".") ? `./${relative}` : relative;
      },
    };
  }
  if (path.isAbsolute(pattern)) {
    return {
      cwd: path.parse(pattern).root,
      globPattern: pattern,
      runtimePattern: pattern,
      importSpecifier: toSlash,
      resolvedMatch: toSlash,
    };
  }
  const packageBase = barePatternBase(pattern);
  if (!packageBase) {
    throw new Error(
      `invalid import ${JSON.stringify(pattern)}. It cannot be statically analyzed because ` +
        "it is not a relative, absolute, aliased, or bare-package request.",
    );
  }
  const packageDirectory = await findPackageDirectory(
    importerDirectory,
    packageBase,
    preserveSymlinks,
  );
  if (!packageDirectory) {
    throw new Error(
      `invalid import ${JSON.stringify(pattern)}. It cannot be statically analyzed because ` +
        `package prefix ${JSON.stringify(packageBase)} could not be resolved.`,
    );
  }
  const suffix = pattern.slice(packageBase.length).replace(/^\/+/, "");
  return {
    cwd: path.parse(packageDirectory).root,
    globPattern: path.join(packageDirectory, suffix),
    runtimePattern: pattern,
    importSpecifier: toSlash,
    resolvedMatch: toSlash,
  };
}

async function resolveDynamicRequire(
  request: DynamicRequire,
  id: string,
  extensions: readonly string[],
  aliases: readonly Alias[],
  root: string,
  preserveSymlinks: boolean,
): Promise<ResolvedDynamicRequire | null> {
  if (request.ignored) return null;
  const pattern = normalizedDynamicRequirePattern(request.argument);
  if (!pattern?.includes("*")) return null;

  const cleanId = toSlash(stripViteModuleQuery(id));
  const importerDirectory = path.dirname(cleanId);
  const resolvedPattern = await resolveDynamicPattern(
    pattern,
    importerDirectory,
    aliases,
    root,
    preserveSymlinks,
  );
  if (!resolvedPattern) return null;
  const candidates = new Map<string, DynamicRequireCandidate>();
  const patterns = dynamicGlobPatterns(
    resolvedPattern.globPattern,
    resolvedPattern.runtimePattern,
    extensions,
  ).map((pattern) => {
    const absoluteGlobPattern = path.isAbsolute(pattern.globPattern)
      ? pattern.globPattern
      : path.resolve(resolvedPattern.cwd, pattern.globPattern);
    return {
      ...pattern,
      matches: generatedGlobMatcher(absoluteGlobPattern),
    };
  });
  const firstGlobPattern = patterns[0]?.globPattern;
  if (!firstGlobPattern) return null;
  const absoluteGlobPattern = path.isAbsolute(firstGlobPattern)
    ? firstGlobPattern
    : path.resolve(resolvedPattern.cwd, firstGlobPattern);
  const traversalRoot = globTraversalRoot(absoluteGlobPattern);
  for (const relative of await listFilesFollowingSymlinks(traversalRoot, true, {
    includeDotEntries: patternIncludesExplicitDotEntry(resolvedPattern.globPattern),
  })) {
    const absolute = path.join(traversalRoot, relative);
    if (absolute === cleanId) continue;
    const resolvedMatch = resolvedPattern.resolvedMatch(absolute);
    for (const pattern of patterns) {
      if (!pattern.matches(absolute)) continue;
      const specifier = resolvedPattern.importSpecifier(absolute);
      const runtimeMatch = runtimeMatchForPattern(
        resolvedPattern.globPattern,
        resolvedPattern.runtimePattern,
        resolvedMatch,
      );
      const cases = extensionlessCases(runtimeMatch);
      candidates.set(absolute, { cases, depth: specifier.split("/").length, specifier });
      break;
    }
  }
  return candidates.size > 0
    ? {
        ...request,
        candidates: [...candidates.values()].sort((left, right) =>
          left.depth !== right.depth
            ? left.depth - right.depth
            : left.specifier < right.specifier
              ? -1
              : left.specifier > right.specifier
                ? 1
                : 0,
        ),
      }
    : null;
}

function unusedBinding(bindings: Set<string>, base: string): string {
  let name = base;
  let suffix = 0;
  while (bindings.has(name)) name = `${base}_${++suffix}`;
  bindings.add(name);
  return name;
}

function renderCommonJs(
  code: string,
  id: string,
  analysis: CommonJsAnalysis,
  dynamicRequires: readonly ResolvedDynamicRequire[],
): MagicStringTransformResult | null {
  if (analysis.requires.length === 0 && dynamicRequires.length === 0 && !analysis.hasExports) {
    return null;
  }

  const output = new MagicString(code);
  const bindings = new Set(analysis.bindings);
  const imports: Array<{ code: string; dynamicOrder: number | null }> = [];
  const importBindings = new Map<string, { name: string; record: (typeof imports)[number] }>();
  let nextDynamicImportOrder = 0;
  function importBinding(specifier: string, dynamic = false): string {
    const existing = importBindings.get(specifier);
    if (existing) {
      if (dynamic && existing.record.dynamicOrder === null) {
        existing.record.dynamicOrder = nextDynamicImportOrder++;
      }
      return existing.name;
    }
    const importName = unusedBinding(bindings, "__vinext_cjs_import__");
    const record = {
      code: `import * as ${importName} from ${JSON.stringify(specifier)};`,
      dynamicOrder: dynamic ? nextDynamicImportOrder++ : null,
    };
    imports.push(record);
    importBindings.set(specifier, { name: importName, record });
    return importName;
  }

  for (const { node, specifier } of analysis.requires) {
    const importName = importBinding(specifier);
    output.overwrite(node.start, node.end, `(${importName}.default || ${importName})`);
  }

  const preamble: string[] = [];
  for (const dynamicRequire of dynamicRequires) {
    const runtimeName = unusedBinding(bindings, "__vinext_dynamic_require__");
    const cases = dynamicRequire.candidates.flatMap((candidate) => {
      const importName = importBinding(candidate.specifier, true);
      return candidate.cases.map((value) => `case ${JSON.stringify(value)}: return ${importName};`);
    });
    preamble.push(
      `function ${runtimeName}(request) { switch (request) { ${cases.join(" ")} default: { const error = new Error("Cannot find module '" + request + "'"); error.code = "MODULE_NOT_FOUND"; throw error; } } }`,
    );
    output.overwrite(dynamicRequire.callee.start, dynamicRequire.callee.end, runtimeName);
  }
  if (analysis.hasExports) {
    preamble.push("var module = { exports: {} };", "var exports = module.exports;");
  }
  if (imports.length > 0 || preamble.length > 0) {
    const importCode = [...imports]
      .sort((left, right) => {
        if (left.dynamicOrder !== null && right.dynamicOrder !== null) {
          return left.dynamicOrder - right.dynamicOrder;
        }
        if (left.dynamicOrder !== null) return -1;
        if (right.dynamicOrder !== null) return 1;
        return 0;
      })
      .map((record) => record.code);
    output.prepend(`${[...importCode, ...preamble].join("\n")}\n`);
  }

  if (analysis.hasExports) {
    const defaultBinding = unusedBinding(bindings, "__vinext_cjs_default__");
    const declarations = [
      `const ${defaultBinding} = (module.exports == null ? {} : module.exports).default || module.exports;`,
    ];
    const exports = [`${defaultBinding} as default`];
    for (const name of analysis.namedExports) {
      const binding = unusedBinding(bindings, `__vinext_cjs_export_${name}__`);
      declarations.push(
        `const ${binding} = (module.exports == null ? {} : module.exports).${name};`,
      );
      exports.push(`${binding} as ${name}`);
    }
    output.append(`\n${declarations.join("\n")}\nexport { ${exports.join(", ")} };\n`);
  }

  return magicStringTransformResult(output, { hires: true, source: id });
}

/** Convert the project-local mixed CommonJS syntax that Vite's ESM module runner cannot execute. */
export function transformCommonJs(code: string, id: string): MagicStringTransformResult | null {
  const analysis = analyzeCommonJs(code, id);
  if (analysis) assertSupportedDynamicRequires(code, analysis);
  return analysis ? renderCommonJs(code, id, analysis, []) : null;
}

export type CommonJsPluginOptions = {
  shouldTransform?: (environment: Environment, code: string, id: string) => boolean;
};

/** Vite lifecycle adapter for the shared CommonJS transform. */
export function createCommonJsPlugin(options: CommonJsPluginOptions = {}): Plugin {
  let extensions: readonly string[] = [
    ...DEFAULT_COMMONJS_EXTENSIONS,
    ...DYNAMIC_REQUIRE_EXTENSIONS,
  ];
  let aliases: readonly Alias[] = [];
  let preserveSymlinks = false;
  let root = toSlash(process.cwd());
  const transformFilter = {
    id: commonJsExtensionFilter(DEFAULT_COMMONJS_EXTENSIONS),
    code: COMMONJS_PRESCAN,
  };
  return {
    name: "vinext:commonjs",
    configResolved(config) {
      extensions = [...new Set([...config.resolve.extensions, ...DYNAMIC_REQUIRE_EXTENSIONS])];
      aliases = config.resolve.alias;
      preserveSymlinks = config.resolve.preserveSymlinks;
      root = toSlash(config.root);
      transformFilter.id = commonJsExtensionFilter(config.resolve.extensions);
    },
    transform: {
      filter: transformFilter,
      async handler(code, id) {
        if (options.shouldTransform && !options.shouldTransform(this.environment, code, id)) {
          return null;
        }
        const analysis = await analyzeCommonJsAsync(code, id);
        if (!analysis) return null;
        assertSupportedDynamicRequires(code, analysis);
        const dynamicRequires = (
          await Promise.all(
            analysis.dynamicRequires.map((request) =>
              resolveDynamicRequire(request, id, extensions, aliases, root, preserveSymlinks),
            ),
          )
        ).filter((value): value is ResolvedDynamicRequire => value !== null);
        return renderCommonJs(code, id, analysis, dynamicRequires);
      },
    },
  };
}
