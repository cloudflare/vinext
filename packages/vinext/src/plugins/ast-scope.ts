import type { ESTree } from "vite";
import { collectBindingNames, forEachAstChild } from "./ast-utils.js";

export type AstScope = {
  parent: AstScope | null;
  bindings: Set<string>;
};

export function createAstScope<T extends AstScope>(parent: T | null): AstScope {
  return { parent, bindings: new Set() };
}

export function hasAstBinding(scope: AstScope, name: string): boolean {
  for (let current: AstScope | null = scope; current; current = current.parent) {
    if (current.bindings.has(name)) return true;
  }
  return false;
}

export function isFunctionNode(
  node: ESTree.Node,
): node is ESTree.Function | ESTree.ArrowFunctionExpression {
  return (
    node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression" ||
    node.type === "ArrowFunctionExpression"
  );
}

export function collectDirectScopeBindings(
  node: ESTree.Node,
  scope: AstScope,
  onVariableDeclarator?: (
    declaration: ESTree.VariableDeclaration,
    declarator: ESTree.VariableDeclarator,
  ) => void,
): void {
  const statements =
    node.type === "Program" ||
    node.type === "BlockStatement" ||
    node.type === "StaticBlock" ||
    node.type === "TSModuleBlock"
      ? node.body
      : node.type === "SwitchCase"
        ? node.consequent
        : [];

  for (const statement of statements) {
    const declaration =
      statement.type === "ExportNamedDeclaration" || statement.type === "ExportDefaultDeclaration"
        ? statement.declaration
        : statement;
    if (!declaration) continue;

    if (declaration.type === "ImportDeclaration") {
      if (declaration.importKind === "type") continue;
      for (const specifier of declaration.specifiers) {
        if (specifier.type !== "ImportSpecifier" || specifier.importKind !== "type") {
          collectBindingNames(specifier.local, scope.bindings);
        }
      }
    } else if (
      declaration.type === "TSImportEqualsDeclaration" &&
      declaration.importKind !== "type"
    ) {
      collectBindingNames(declaration.id, scope.bindings);
    } else if (declaration.type === "VariableDeclaration" && declaration.declare !== true) {
      for (const declarator of declaration.declarations) {
        collectBindingNames(declarator.id, scope.bindings);
        onVariableDeclarator?.(declaration, declarator);
      }
    } else if (
      (declaration.type === "FunctionDeclaration" || declaration.type === "ClassDeclaration") &&
      declaration.declare !== true
    ) {
      collectBindingNames(declaration.id, scope.bindings);
    } else if (
      (declaration.type === "TSEnumDeclaration" || declaration.type === "TSModuleDeclaration") &&
      declaration.declare !== true
    ) {
      collectBindingNames(declaration.id, scope.bindings);
    }
  }
}

export function collectLoopScopeBindings(
  node: ESTree.ForStatement | ESTree.ForInStatement | ESTree.ForOfStatement,
  scope: AstScope,
  onVariableDeclarator?: (
    declaration: ESTree.VariableDeclaration,
    declarator: ESTree.VariableDeclarator,
  ) => void,
): void {
  const declarationValue = node.type === "ForStatement" ? node.init : node.left;
  if (
    !declarationValue ||
    declarationValue.type !== "VariableDeclaration" ||
    declarationValue.declare === true
  )
    return;
  for (const declarator of declarationValue.declarations) {
    collectBindingNames(declarator.id, scope.bindings);
    onVariableDeclarator?.(declarationValue, declarator);
  }
}

export function collectSwitchScopeBindings(
  node: ESTree.SwitchStatement,
  scope: AstScope,
  onVariableDeclarator?: (
    declaration: ESTree.VariableDeclaration,
    declarator: ESTree.VariableDeclarator,
  ) => void,
): void {
  for (const switchCase of node.cases) {
    collectDirectScopeBindings(switchCase, scope, onVariableDeclarator);
  }
}

export function collectVarScopeBindings(node: ESTree.Node, scope: AstScope, root = true): void {
  if (
    !root &&
    (isFunctionNode(node) || node.type === "StaticBlock" || node.type === "TSModuleBlock")
  ) {
    return;
  }
  if (node.type === "VariableDeclaration" && node.kind === "var" && node.declare !== true) {
    for (const declarator of node.declarations) {
      collectBindingNames(declarator.id, scope.bindings);
    }
  }
  forEachAstChild(node, (child) => collectVarScopeBindings(child, scope, false));
}
