import MagicString from "magic-string";
import { parseAst } from "vite";
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

const COMMONJS_PRESCAN = /\b(?:require\s*\(|module\s*\.|exports\s*[.[])/;
const IDENTIFIER_NAME_RE = /^[A-Za-z_$][\w$]*$/;

type StaticRequire = {
  node: AstRecord & { start: number; end: number };
  specifier: string;
};

type CommonJsAnalysis = {
  requires: StaticRequire[];
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
        argument &&
        specifier !== null
      ) {
        requires.push({ node, specifier });
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
    hasExports,
    namedExports: [...namedExports],
    rootBindings: rootScope.bindings,
  };
}

function unusedBinding(bindings: Set<string>, base: string): string {
  let name = base;
  let suffix = 0;
  while (bindings.has(name)) name = `${base}_${++suffix}`;
  bindings.add(name);
  return name;
}

/** Convert the project-local mixed CommonJS syntax that Vite's ESM module runner cannot execute. */
export function transformCommonJs(code: string, id: string): MagicStringTransformResult | null {
  const analysis = analyzeCommonJs(code, id);
  if (!analysis || (analysis.requires.length === 0 && !analysis.hasExports)) return null;

  const output = new MagicString(code);
  const bindings = new Set(analysis.rootBindings);
  const imports: string[] = [];
  for (const { node, specifier } of analysis.requires) {
    const importName = unusedBinding(bindings, "__vinext_cjs_import__");
    imports.push(`import * as ${importName} from ${JSON.stringify(specifier)};`);
    output.overwrite(node.start, node.end, `(${importName}.default || ${importName})`);
  }

  const preamble: string[] = [];
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
