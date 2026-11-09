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
        // A `var` belongs to its function or module scope, which
        // `collectVarScopeBindings` fills, not to the enclosing block.
        if (declaration.kind !== "var") collectBindingNames(declarator.id, scope.bindings);
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
    if (declarationValue.kind !== "var") collectBindingNames(declarator.id, scope.bindings);
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

/** The nearest scope declaring `name`, or `null` for an unbound (global) name. */
export function findAstBindingScope(scope: AstScope, name: string): AstScope | null {
  for (let current: AstScope | null = scope; current; current = current.parent) {
    if (current.bindings.has(name)) return current;
  }
  return null;
}

/**
 * Visit every node with the scope it is evaluated in. The root scope holds the
 * program's own bindings, including every `var` outside a function.
 */
export function walkAstScopes(
  root: ESTree.Program,
  visitor: (node: ESTree.Node, scope: AstScope) => void,
): AstScope {
  const rootScope = createAstScope(null);
  collectDirectScopeBindings(root, rootScope);
  collectVarScopeBindings(root, rootScope);

  function visit(node: ESTree.Node, parentScope: AstScope): void {
    visitor(node, parentScope);
    let scope = parentScope;
    if (isFunctionNode(node)) {
      const parameterScope = createAstScope(parentScope);
      // A declaration's name belongs to the enclosing scope; only a named
      // function expression binds its own name.
      if (node.type === "FunctionExpression") collectBindingNames(node.id, parameterScope.bindings);
      for (const parameter of node.params) collectBindingNames(parameter, parameterScope.bindings);
      if (node.id)
        visit(node.id, node.type === "FunctionExpression" ? parameterScope : parentScope);
      for (const parameter of node.params) visit(parameter, parameterScope);
      if (!node.body) return;
      const bodyScope = createAstScope(parameterScope);
      collectDirectScopeBindings(node.body, bodyScope);
      collectVarScopeBindings(node.body, bodyScope);
      if (node.body.type === "BlockStatement") {
        for (const statement of node.body.body) visit(statement, bodyScope);
      } else {
        visit(node.body, bodyScope);
      }
      return;
    }
    if (node.type === "SwitchStatement") {
      visit(node.discriminant, parentScope);
      const switchScope = createAstScope(parentScope);
      collectSwitchScopeBindings(node, switchScope);
      for (const switchCase of node.cases) visit(switchCase, switchScope);
      return;
    }
    if (
      node.type === "BlockStatement" ||
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
    forEachAstChild(node, (child) => visit(child, scope));
  }

  for (const statement of root.body) visit(statement, rootScope);
  return rootScope;
}
