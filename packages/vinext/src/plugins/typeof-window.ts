import path from "node:path";
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

type WindowType = "object" | "undefined";

type AstNode = Parameters<typeof forEachAstChild>[0];

type EnvironmentLike = {
  config: {
    consumer: "client" | "server";
  };
};

function createChildScope(node: AstNode, parent: AstScope): AstScope | null {
  if (
    node.type !== "Program" &&
    node.type !== "BlockStatement" &&
    node.type !== "StaticBlock" &&
    node.type !== "TSModuleBlock" &&
    node.type !== "CatchClause" &&
    node.type !== "ForStatement" &&
    node.type !== "ForInStatement" &&
    node.type !== "ForOfStatement" &&
    node.type !== "ClassDeclaration" &&
    node.type !== "ClassExpression"
  ) {
    return null;
  }

  const scope = createAstScope(parent);
  if (node.type === "ClassDeclaration" || node.type === "ClassExpression") {
    collectBindingNames(node.id, scope.bindings);
  } else if (node.type === "CatchClause") {
    collectBindingNames(node.param, scope.bindings);
  }
  collectDirectScopeBindings(node, scope);
  if (node.type === "StaticBlock" || node.type === "TSModuleBlock") {
    collectVarScopeBindings(node, scope);
  }
  if (
    node.type === "ForStatement" ||
    node.type === "ForInStatement" ||
    node.type === "ForOfStatement"
  ) {
    collectLoopScopeBindings(node, scope);
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
  scope: AstScope,
): boolean | null {
  if (!isAstRecord(node) || node.type !== "BinaryExpression") return null;
  if (!["==", "===", "!=", "!=="].includes(String(node.operator))) return null;

  const left = isAstRecord(node.left) ? node.left : null;
  const right = isAstRecord(node.right) ? node.right : null;
  const leftIsTypeofWindow =
    left?.type === "UnaryExpression" &&
    left.operator === "typeof" &&
    isIdentifierNamed(left.argument, "window") &&
    !hasAstBinding(scope, "window");
  const rightIsTypeofWindow =
    right?.type === "UnaryExpression" &&
    right.operator === "typeof" &&
    isIdentifierNamed(right.argument, "window") &&
    !hasAstBinding(scope, "window");

  const comparedValue = leftIsTypeofWindow
    ? stringLiteralValue(right)
    : rightIsTypeofWindow
      ? stringLiteralValue(left)
      : null;
  if (comparedValue === null) return null;

  const equal = replacement === comparedValue;
  return node.operator === "==" || node.operator === "===" ? equal : !equal;
}

export function replaceTypeofWindow(code: string, replacement: WindowType, id = "file.js") {
  if (!/typeof\s+window/.test(code)) return null;

  const extension = path.extname(id.split("?", 1)[0]);
  const lang =
    extension === ".ts" || extension === ".mts" || extension === ".cts"
      ? "ts"
      : extension === ".tsx"
        ? "tsx"
        : extension === ".jsx"
          ? "jsx"
          : "js";
  let ast: ReturnType<typeof parseAst>;
  try {
    ast = parseAst(code, { lang });
  } catch {
    return null;
  }

  const output = new MagicString(code);
  let changed = false;
  if (!isAstRecord(ast)) return null;

  const rootScope = createAstScope(null);
  collectDirectScopeBindings(ast, rootScope);
  collectVarScopeBindings(ast, rootScope);

  function visit(node: AstNode, parentScope: AstScope): void {
    if (isFunctionNode(node)) {
      const parameterScope = createAstScope(parentScope);
      collectBindingNames(node.id, parameterScope.bindings);
      for (const parameter of nodeArray(node.params)) {
        collectBindingNames(parameter, parameterScope.bindings);
        if (isAstRecord(parameter)) visit(parameter, parameterScope);
      }

      if (isAstRecord(node.body)) {
        if (node.body.type === "BlockStatement") {
          const bodyScope = createAstScope(parameterScope);
          collectDirectScopeBindings(node.body, bodyScope);
          collectVarScopeBindings(node.body, bodyScope);
          visit(node.body, bodyScope);
        } else {
          visit(node.body, parameterScope);
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
      !hasAstBinding(scope, "window") &&
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
