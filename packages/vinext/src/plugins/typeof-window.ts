import { parseAst } from "vite";
import MagicString from "magic-string";
import {
  collectBindingNames,
  forEachAstChild,
  hasRange,
  isAstRecord,
  isIdentifierNamed,
  nodeArray,
} from "./ast-utils.js";

type WindowType = "object" | "undefined";

type AstNode = Parameters<typeof forEachAstChild>[0];

type Scope = {
  parent: Scope | null;
  bindings: Set<string>;
};

type EnvironmentLike = {
  config: {
    consumer: "client" | "server";
  };
};

function createScope(parent: Scope | null): Scope {
  return { parent, bindings: new Set() };
}

function hasBinding(scope: Scope, name: string): boolean {
  for (let current: Scope | null = scope; current; current = current.parent) {
    if (current.bindings.has(name)) return true;
  }
  return false;
}

function collectScopeBindings(node: AstNode, scope: Scope): void {
  forEachAstChild(node, (child) => {
    if (child.type === "ExportNamedDeclaration" || child.type === "ExportDefaultDeclaration") {
      if (isAstRecord(child.declaration)) collectScopeBindings(child, scope);
      return;
    }
    if (child.type === "FunctionDeclaration" || child.type === "ClassDeclaration") {
      collectBindingNames(child.id, scope.bindings);
      return;
    }
    if (child.type === "VariableDeclaration") {
      for (const declaration of nodeArray(child.declarations)) {
        if (isAstRecord(declaration)) collectBindingNames(declaration.id, scope.bindings);
      }
      return;
    }
    if (child.type === "ImportDeclaration") {
      for (const specifier of nodeArray(child.specifiers)) {
        if (isAstRecord(specifier)) collectBindingNames(specifier.local, scope.bindings);
      }
    }
  });
}

function collectVarBindings(node: AstNode, scope: Scope, isRoot = true): void {
  if (
    !isRoot &&
    (node.type === "FunctionDeclaration" ||
      node.type === "FunctionExpression" ||
      node.type === "ArrowFunctionExpression")
  ) {
    return;
  }
  if (node.type === "VariableDeclaration" && node.kind === "var") {
    for (const declaration of nodeArray(node.declarations)) {
      if (isAstRecord(declaration)) collectBindingNames(declaration.id, scope.bindings);
    }
  }
  forEachAstChild(node, (child) => collectVarBindings(child, scope, false));
}

function isFunctionNode(node: AstNode): boolean {
  return (
    node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression" ||
    node.type === "ArrowFunctionExpression"
  );
}

function createChildScope(node: AstNode, parent: Scope): Scope | null {
  if (
    node.type !== "Program" &&
    node.type !== "BlockStatement" &&
    node.type !== "StaticBlock" &&
    node.type !== "SwitchStatement" &&
    node.type !== "CatchClause" &&
    node.type !== "ForStatement" &&
    node.type !== "ForInStatement" &&
    node.type !== "ForOfStatement" &&
    node.type !== "ClassDeclaration" &&
    node.type !== "ClassExpression"
  ) {
    return null;
  }

  const scope = createScope(parent);
  if (node.type === "ClassDeclaration" || node.type === "ClassExpression") {
    collectBindingNames(node.id, scope.bindings);
  } else if (node.type === "CatchClause") {
    collectBindingNames(node.param, scope.bindings);
  }
  collectScopeBindings(node, scope);
  if (node.type === "SwitchStatement") {
    for (const switchCase of nodeArray(node.cases)) {
      if (isAstRecord(switchCase)) collectScopeBindings(switchCase, scope);
    }
  }
  return scope;
}

export function getTypeofWindowReplacement(environment: EnvironmentLike): WindowType {
  return environment.config.consumer === "client" ? "object" : "undefined";
}

function stringLiteralValue(node: unknown): string | null {
  if (!isAstRecord(node)) return null;
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  return null;
}

function evaluateTypeofWindowComparison(
  node: unknown,
  replacement: WindowType,
  scope: Scope,
): boolean | null {
  if (!isAstRecord(node) || node.type !== "BinaryExpression") return null;
  if (!["==", "===", "!=", "!=="].includes(String(node.operator))) return null;

  const left = isAstRecord(node.left) ? node.left : null;
  const right = isAstRecord(node.right) ? node.right : null;
  const leftIsTypeofWindow =
    left?.type === "UnaryExpression" &&
    left.operator === "typeof" &&
    isIdentifierNamed(left.argument, "window") &&
    !hasBinding(scope, "window");
  const rightIsTypeofWindow =
    right?.type === "UnaryExpression" &&
    right.operator === "typeof" &&
    isIdentifierNamed(right.argument, "window") &&
    !hasBinding(scope, "window");

  const comparedValue = leftIsTypeofWindow
    ? stringLiteralValue(right)
    : rightIsTypeofWindow
      ? stringLiteralValue(left)
      : null;
  if (comparedValue === null) return null;

  const equal = replacement === comparedValue;
  return node.operator === "==" || node.operator === "===" ? equal : !equal;
}

export function replaceTypeofWindow(code: string, replacement: WindowType) {
  if (!/typeof\s+window/.test(code)) return null;

  let ast: ReturnType<typeof parseAst>;
  try {
    ast = parseAst(code);
  } catch {
    return null;
  }

  const output = new MagicString(code);
  let changed = false;
  if (!isAstRecord(ast)) return null;

  const rootScope = createScope(null);
  collectScopeBindings(ast, rootScope);
  collectVarBindings(ast, rootScope);

  function visit(node: AstNode, parentScope: Scope): void {
    if (isFunctionNode(node)) {
      const parameterScope = createScope(parentScope);
      collectBindingNames(node.id, parameterScope.bindings);
      for (const parameter of nodeArray(node.params)) {
        collectBindingNames(parameter, parameterScope.bindings);
        if (isAstRecord(parameter)) visit(parameter, parameterScope);
      }

      if (isAstRecord(node.body)) {
        if (node.body.type === "BlockStatement") {
          const bodyScope = createScope(parameterScope);
          collectVarBindings(node.body, bodyScope);
          visit(node.body, bodyScope);
        } else {
          visit(node.body, parameterScope);
        }
      }
      return;
    }

    const scope = createChildScope(node, parentScope) ?? parentScope;

    if (node.type === "IfStatement" && hasRange(node)) {
      const result = evaluateTypeofWindowComparison(node.test, replacement, scope);
      if (result !== null) {
        const selected = result ? node.consequent : node.alternate;
        if (isAstRecord(selected) && hasRange(selected)) {
          output.remove(node.start, selected.start);
          output.remove(selected.end, node.end);
          visit(selected, scope);
        } else {
          output.overwrite(node.start, node.end, ";");
        }
        changed = true;
        return;
      }
    }

    if (node.type === "ConditionalExpression" && hasRange(node)) {
      const result = evaluateTypeofWindowComparison(node.test, replacement, scope);
      const selected = result ? node.consequent : node.alternate;
      if (result !== null && isAstRecord(selected) && hasRange(selected)) {
        output.overwrite(node.start, selected.start, "(");
        if (selected.end < node.end) {
          output.overwrite(selected.end, node.end, ")");
        } else {
          output.appendLeft(selected.end, ")");
        }
        visit(selected, scope);
        changed = true;
        return;
      }
    }

    if (
      node.type === "UnaryExpression" &&
      node.operator === "typeof" &&
      isIdentifierNamed(node.argument, "window") &&
      !hasBinding(scope, "window") &&
      hasRange(node)
    ) {
      output.overwrite(node.start, node.end, JSON.stringify(replacement));
      changed = true;
      return;
    }

    forEachAstChild(node, (child) => visit(child, scope));
  }

  for (const node of ast.body) {
    if (isAstRecord(node)) visit(node, rootScope);
  }
  if (!changed) return null;

  return {
    code: output.toString(),
    map: output.generateMap({ hires: "boundary" }),
  };
}
