import MagicString from "magic-string";
import { glob, realpath, stat } from "node:fs/promises";
import path, { toSlash } from "pathslash";
import { parseAst, type Alias, type Environment, type Plugin } from "vite";
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
import { stripViteModuleQuery } from "../utils/path.js";
import { packageNameFromSpecifier } from "../utils/package-name.js";

const COMMONJS_PRESCAN = /\b(?:require\s*\(|module\s*\.|exports\s*[.[])/;
const IDENTIFIER_NAME_RE = /^[A-Za-z_$][\w$]*$/;

type StaticRequire = {
  node: AstRecord & { start: number; end: number };
  specifier: string;
};

type DynamicRequire = {
  argument: AstRecord & { start: number; end: number };
  node: AstRecord & { start: number; end: number };
};

type CommonJsAnalysis = {
  requires: StaticRequire[];
  dynamicRequires: DynamicRequire[];
  hasExports: boolean;
  namedExports: string[];
  rootBindings: Set<string>;
};

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

function analyzeCommonJs(code: string, id: string): CommonJsAnalysis | null {
  if (!COMMONJS_PRESCAN.test(code)) return null;
  let ast: ReturnType<typeof parseAst>;
  try {
    ast = parseAst(code, { lang: scriptParserLanguage(id) ?? "jsx" });
  } catch {
    return null;
  }
  const root = isAstRecord(ast) ? ast : null;
  if (!root) return null;

  const rootScope = createAstScope(null);
  collectDirectScopeBindings(root, rootScope);
  collectVarScopeBindings(root, rootScope);
  const requires: StaticRequire[] = [];
  const dynamicRequires: DynamicRequire[] = [];
  const namedExports = new Set<string>();
  let hasExports = false;

  function visit(node: AstRecord, parentScope: AstScope): void {
    let scope = parentScope;
    if (isFunctionNode(node)) {
      const parameterScope = createAstScope(parentScope);
      collectBindingNames(node.id, parameterScope.bindings);
      for (const parameter of nodeArray(node.params)) {
        collectBindingNames(parameter, parameterScope.bindings);
        if (isAstRecord(parameter)) visit(parameter, parameterScope);
      }
      const body = isAstRecord(node.body) ? node.body : null;
      if (body) {
        const bodyScope = createAstScope(parameterScope);
        collectDirectScopeBindings(body, bodyScope);
        collectVarScopeBindings(body, bodyScope);
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
      collectSwitchScopeBindings(node, switchScope);
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
      collectDirectScopeBindings(node, scope);
      if (node.type === "StaticBlock" || node.type === "TSModuleBlock") {
        collectVarScopeBindings(node, scope);
      }
    } else if (node.type === "CatchClause") {
      scope = createAstScope(parentScope);
      collectBindingNames(node.param, scope.bindings);
    } else if (
      node.type === "ForStatement" ||
      node.type === "ForInStatement" ||
      node.type === "ForOfStatement"
    ) {
      scope = createAstScope(parentScope);
      collectLoopScopeBindings(node, scope);
    } else if (node.type === "ClassExpression" && node.id) {
      scope = createAstScope(parentScope);
      collectBindingNames(node.id, scope.bindings);
    }

    if (node.type === "CallExpression" && hasRange(node)) {
      const callee = unwrapExpression(node.callee);
      const args = nodeArray(node.arguments);
      const argument = unwrapExpression(args[0]);
      const specifier = staticStringValue(argument);
      if (
        isIdentifierNamed(callee, "require") &&
        !hasAstBinding(scope, "require") &&
        args.length === 1 &&
        argument
      ) {
        if (specifier !== null) requires.push({ node, specifier });
        else if (hasRange(argument)) dynamicRequires.push({ argument, node });
        return;
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
    hasExports,
    namedExports: [...namedExports],
    rootBindings: rootScope.bindings,
  };
}

type DynamicRequireCandidate = {
  cases: string[];
  specifier: string;
};

type ResolvedDynamicRequire = DynamicRequire & {
  candidates: DynamicRequireCandidate[];
};

type WatchContext = {
  addWatchFile(id: string): void;
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

function patternCaptures(pattern: string, value: string): string[] | null {
  const parts = pattern.split(/\*+/);
  const source = parts.map((part) => part.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")).join("(.*?)");
  const match = new RegExp(`^${source}$`).exec(value);
  return match ? match.slice(1) : null;
}

function interpolatePattern(pattern: string, captures: readonly string[]): string {
  let index = 0;
  return pattern.replace(/\*+/g, () => captures[index++] ?? "");
}

async function findPackageDirectory(
  importerDirectory: string,
  packageName: string,
): Promise<string | null> {
  let directory = importerDirectory;
  for (;;) {
    const candidate = path.join(directory, "node_modules", packageName);
    try {
      if ((await stat(candidate)).isDirectory()) return await realpath(candidate);
    } catch {}
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

async function resolveDynamicPattern(
  pattern: string,
  importerDirectory: string,
  aliases: readonly Alias[],
  root: string,
): Promise<DynamicPatternResolution | null> {
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
  for (const alias of aliases) {
    const matches =
      typeof alias.find === "string"
        ? pattern === alias.find || pattern.startsWith(`${alias.find}/`)
        : new RegExp(alias.find.source, alias.find.flags).test(pattern);
    if (!matches) continue;
    const replaced = pattern.replace(alias.find, alias.replacement);
    const resolvedPattern = path.isAbsolute(replaced) ? replaced : path.resolve(root, replaced);
    return {
      cwd: path.parse(resolvedPattern).root,
      globPattern: resolvedPattern,
      runtimePattern: pattern,
      importSpecifier: toSlash,
      resolvedMatch: toSlash,
    };
  }
  const packageName = packageNameFromSpecifier(pattern);
  if (!packageName) return null;
  const packageDirectory = await findPackageDirectory(importerDirectory, packageName);
  if (!packageDirectory) return null;
  const suffix = pattern.slice(packageName.length).replace(/^\/+/, "");
  return {
    cwd: path.parse(packageDirectory).root,
    globPattern: path.join(packageDirectory, suffix),
    runtimePattern: pattern,
    importSpecifier: toSlash,
    resolvedMatch: toSlash,
  };
}

async function resolveDynamicRequire(
  context: WatchContext,
  request: DynamicRequire,
  id: string,
  extensions: readonly string[],
  aliases: readonly Alias[],
  root: string,
): Promise<ResolvedDynamicRequire | null> {
  const pattern = dynamicRequirePattern(request.argument);
  if (!pattern?.includes("*")) return null;

  const cleanId = stripViteModuleQuery(id);
  const importerDirectory = path.dirname(cleanId);
  const resolvedPattern = await resolveDynamicPattern(pattern, importerDirectory, aliases, root);
  if (!resolvedPattern) return null;
  const candidates = new Map<string, DynamicRequireCandidate>();
  for (const { globPattern, resolvedPattern: matchPattern, runtimePattern } of dynamicGlobPatterns(
    resolvedPattern.globPattern,
    resolvedPattern.runtimePattern,
    extensions,
  )) {
    for await (const match of glob(globPattern, { cwd: resolvedPattern.cwd })) {
      const absolute = path.resolve(resolvedPattern.cwd, match);
      if (absolute === cleanId) continue;
      const captures = patternCaptures(matchPattern, resolvedPattern.resolvedMatch(absolute));
      if (!captures) continue;
      context.addWatchFile(absolute);
      const specifier = resolvedPattern.importSpecifier(absolute);
      const cases = extensionlessCases(interpolatePattern(runtimePattern, captures));
      const existing = candidates.get(absolute);
      if (existing) existing.cases = [...new Set([...existing.cases, ...cases])];
      else candidates.set(absolute, { cases, specifier });
    }
  }
  return candidates.size > 0 ? { ...request, candidates: [...candidates.values()] } : null;
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
  const bindings = new Set(analysis.rootBindings);
  const imports: string[] = [];
  const importBindings = new Map<string, string>();
  function importBinding(specifier: string): string {
    const existing = importBindings.get(specifier);
    if (existing) return existing;
    const importName = unusedBinding(bindings, "__vinext_cjs_import__");
    imports.push(`import * as ${importName} from ${JSON.stringify(specifier)};`);
    importBindings.set(specifier, importName);
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
      const importName = importBinding(candidate.specifier);
      return candidate.cases.map(
        (value) =>
          `case ${JSON.stringify(value)}: return (${importName}.default || ${importName});`,
      );
    });
    preamble.push(
      `function ${runtimeName}(request) { switch (request) { ${cases.join(" ")} default: { const error = new Error("Cannot find module '" + request + "'"); error.code = "MODULE_NOT_FOUND"; throw error; } } }`,
    );
    output.overwrite(
      dynamicRequire.node.start,
      dynamicRequire.node.end,
      `${runtimeName}(${code.slice(dynamicRequire.argument.start, dynamicRequire.argument.end)})`,
    );
  }
  if (analysis.hasExports) {
    preamble.push("var module = { exports: {} };", "var exports = module.exports;");
  }
  if (imports.length > 0 || preamble.length > 0) {
    output.prepend(`${[...imports, ...preamble].join("\n")}\n`);
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
  return analysis ? renderCommonJs(code, id, analysis, []) : null;
}

export type CommonJsPluginOptions = {
  shouldTransform?: (environment: Environment, code: string, id: string) => boolean;
};

/** Vite lifecycle adapter for the shared CommonJS transform. */
export function createCommonJsPlugin(options: CommonJsPluginOptions = {}): Plugin {
  let extensions: readonly string[] = [
    ".mjs",
    ".js",
    ".cjs",
    ".mts",
    ".ts",
    ".cts",
    ".jsx",
    ".tsx",
    ".json",
  ];
  let aliases: readonly Alias[] = [];
  let root = process.cwd();
  return {
    name: "vinext:commonjs",
    configResolved(config) {
      extensions = config.resolve.extensions;
      aliases = config.resolve.alias;
      root = config.root;
    },
    transform: {
      filter: {
        id: /\.(?:[cm]?[jt]s|[jt]sx)(?:[?#].*)?$/i,
        code: COMMONJS_PRESCAN,
      },
      async handler(code, id) {
        if (options.shouldTransform && !options.shouldTransform(this.environment, code, id)) {
          return null;
        }
        const analysis = analyzeCommonJs(code, id);
        if (!analysis) return null;
        const dynamicRequires = (
          await Promise.all(
            analysis.dynamicRequires.map((request) =>
              resolveDynamicRequire(this, request, id, extensions, aliases, root),
            ),
          )
        ).filter((value): value is ResolvedDynamicRequire => value !== null);
        return renderCommonJs(code, id, analysis, dynamicRequires);
      },
    },
  };
}
