import {
  collectBindingNames,
  forEachAstChild,
  isAstRecord,
  nodeArray,
  type AstRecord,
} from "./ast-utils.js";

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

export function isFunctionNode(node: AstRecord): boolean {
  return (
    node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression" ||
    node.type === "ArrowFunctionExpression"
  );
}

export function collectDirectScopeBindings(
  node: AstRecord,
  scope: AstScope,
  onVariableDeclarator?: (declaration: AstRecord, declarator: AstRecord) => void,
): void {
  for (const statementValue of nodeArray(node.body)) {
    const statement = isAstRecord(statementValue) ? statementValue : null;
    if (!statement) continue;
    const declaration =
      statement.type === "ExportNamedDeclaration" || statement.type === "ExportDefaultDeclaration"
        ? isAstRecord(statement.declaration)
          ? statement.declaration
          : null
        : statement;
    if (!declaration) continue;

    if (declaration.type === "ImportDeclaration") {
      if (declaration.importKind === "type") continue;
      for (const specifier of nodeArray(declaration.specifiers)) {
        if (isAstRecord(specifier) && specifier.importKind !== "type") {
          collectBindingNames(specifier.local, scope.bindings);
        }
      }
    } else if (
      declaration.type === "TSImportEqualsDeclaration" &&
      declaration.importKind !== "type"
    ) {
      collectBindingNames(declaration.id, scope.bindings);
    } else if (declaration.type === "VariableDeclaration" && declaration.declare !== true) {
      for (const declarator of nodeArray(declaration.declarations)) {
        if (!isAstRecord(declarator)) continue;
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
  node: AstRecord,
  scope: AstScope,
  onVariableDeclarator?: (declaration: AstRecord, declarator: AstRecord) => void,
): void {
  const declarationValue = node.type === "ForStatement" ? node.init : node.left;
  if (!isAstRecord(declarationValue)) return;
  if (declarationValue.type !== "VariableDeclaration" || declarationValue.declare === true) return;
  for (const declarator of nodeArray(declarationValue.declarations)) {
    if (!isAstRecord(declarator)) continue;
    collectBindingNames(declarator.id, scope.bindings);
    onVariableDeclarator?.(declarationValue, declarator);
  }
}

export function collectSwitchScopeBindings(
  node: AstRecord,
  scope: AstScope,
  onVariableDeclarator?: (declaration: AstRecord, declarator: AstRecord) => void,
): void {
  for (const caseValue of nodeArray(node.cases)) {
    if (!isAstRecord(caseValue)) continue;
    collectDirectScopeBindings(
      { type: "BlockStatement", body: nodeArray(caseValue.consequent) },
      scope,
      onVariableDeclarator,
    );
  }
}

export function collectVarScopeBindings(node: AstRecord, scope: AstScope, root = true): void {
  if (
    !root &&
    (isFunctionNode(node) || node.type === "StaticBlock" || node.type === "TSModuleBlock")
  ) {
    return;
  }
  if (node.type === "VariableDeclaration" && node.kind === "var" && node.declare !== true) {
    for (const declarator of nodeArray(node.declarations)) {
      if (isAstRecord(declarator)) collectBindingNames(declarator.id, scope.bindings);
    }
  }
  forEachAstChild(node, (child) => collectVarScopeBindings(child, scope, false));
}
