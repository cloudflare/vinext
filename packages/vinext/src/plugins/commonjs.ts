import MagicString from "magic-string";
import { glob } from "node:fs/promises";
import path, { toSlash } from "pathslash";
import { parseAst, type Environment, type Plugin } from "vite";
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

function dynamicGlobPatterns(pattern: string, extensions: readonly string[]): string[] {
  if (path.extname(pattern)) return [pattern];
  return [
    pattern,
    ...extensions.flatMap((extension) => [
      pattern + extension,
      path.join(pattern, `index${extension}`),
    ]),
  ];
}

async function resolveDynamicRequire(
  context: WatchContext,
  request: DynamicRequire,
  id: string,
  extensions: readonly string[],
): Promise<ResolvedDynamicRequire | null> {
  const pattern = dynamicRequirePattern(request.argument);
  if (
    !pattern?.includes("*") ||
    (!pattern.startsWith("./") && !pattern.startsWith("../") && !path.isAbsolute(pattern))
  ) {
    return null;
  }

  const cleanId = stripViteModuleQuery(id);
  const importerDirectory = path.dirname(cleanId);
  const candidates = new Map<string, DynamicRequireCandidate>();
  for (const globPattern of dynamicGlobPatterns(pattern, extensions)) {
    for await (const match of glob(globPattern, { cwd: importerDirectory })) {
      let specifier = toSlash(match);
      const absolute = path.resolve(importerDirectory, specifier);
      if (absolute === cleanId) continue;
      context.addWatchFile(absolute);
      if (!path.isAbsolute(specifier) && !specifier.startsWith(".")) specifier = `./${specifier}`;
      const cases = extensionlessCases(specifier);
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
  return {
    name: "vinext:commonjs",
    configResolved(config) {
      extensions = config.resolve.extensions;
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
              resolveDynamicRequire(this, request, id, extensions),
            ),
          )
        ).filter((value): value is ResolvedDynamicRequire => value !== null);
        return renderCommonJs(code, id, analysis, dynamicRequires);
      },
    },
  };
}
