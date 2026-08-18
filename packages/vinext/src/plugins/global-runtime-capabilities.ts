import {
  collectBindingNames,
  forEachAstChild,
  isAstRecord,
  nodeArray,
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

function staticMemberName(value: AstRecord): string | null {
  const property = unwrapExpression(value.property);
  if (value.computed !== true && property?.type === "Identifier") {
    return typeof property.name === "string" ? property.name : null;
  }
  return value.computed === true && property?.type === "Literal"
    ? typeof property.value === "string"
      ? property.value
      : null
    : null;
}

export function isGlobalObjectReference(scope: AstScope, value: unknown): boolean {
  const reference = unwrapExpression(value);
  if (reference?.type === "Identifier") {
    return (
      (reference.name === "globalThis" ||
        reference.name === "global" ||
        reference.name === "self") &&
      !hasAstBinding(scope, String(reference.name))
    );
  }
  return (
    reference?.type === "MemberExpression" &&
    ["globalThis", "global", "self"].includes(staticMemberName(reference) ?? "") &&
    isGlobalObjectReference(scope, reference.object)
  );
}

export function isGlobalObjectMember(scope: AstScope, value: unknown, name: string): boolean {
  const member = unwrapExpression(value);
  return (
    member?.type === "MemberExpression" &&
    staticMemberName(member) === name &&
    isGlobalObjectReference(scope, member.object)
  );
}

export function isDynamicCodeCapabilityReference(scope: AstScope, value: unknown): boolean {
  const reference = unwrapExpression(value);
  if (reference?.type === "Identifier") {
    return (
      (reference.name === "eval" || reference.name === "Function") &&
      !hasAstBinding(scope, String(reference.name))
    );
  }
  if (reference?.type !== "MemberExpression") return false;
  if (
    isGlobalObjectMember(scope, reference, "eval") ||
    isGlobalObjectMember(scope, reference, "Function")
  ) {
    return true;
  }
  if (staticMemberName(reference) !== "constructor") return false;
  const receiver = unwrapExpression(reference.object);
  return (
    receiver?.type === "FunctionExpression" ||
    receiver?.type === "ArrowFunctionExpression" ||
    receiver?.type === "ClassExpression" ||
    isDynamicCodeCapabilityReference(scope, receiver)
  );
}

export function assignedTargetCanMutateGlobalCapability(
  scope: AstScope,
  value: unknown,
  capability: "fetch" | "URL",
): boolean {
  const node = unwrapExpression(value);
  if (!node) return false;
  if (node.type === "Identifier") {
    return (
      (node.name === capability && !hasAstBinding(scope, capability)) ||
      isGlobalObjectReference(scope, node)
    );
  }
  if (node.type === "MemberExpression") {
    if (!isGlobalObjectReference(scope, node.object)) return false;
    const name = staticMemberName(node);
    return (
      name === capability ||
      name === "globalThis" ||
      name === "global" ||
      name === "self" ||
      (node.computed === true && name === null)
    );
  }
  if (node.type === "AssignmentPattern") {
    return assignedTargetCanMutateGlobalCapability(scope, node.left, capability);
  }
  if (node.type === "RestElement") {
    return assignedTargetCanMutateGlobalCapability(scope, node.argument, capability);
  }
  if (node.type === "ArrayPattern" || node.type === "ArrayExpression") {
    return nodeArray(node.elements).some((element) =>
      assignedTargetCanMutateGlobalCapability(scope, element, capability),
    );
  }
  if (node.type === "ObjectPattern" || node.type === "ObjectExpression") {
    return nodeArray(node.properties).some(
      (property) =>
        isAstRecord(property) &&
        assignedTargetCanMutateGlobalCapability(
          scope,
          property.type === "RestElement" ? property.argument : property.value,
          capability,
        ),
    );
  }
  return false;
}

function childScope(node: AstRecord, parent: AstScope): AstScope | null {
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

export function isGlobalUrlCapabilityStable(ast: AstRecord): boolean {
  let stable = true;
  const rootScope = createAstScope(null);
  collectDirectScopeBindings(ast, rootScope);
  collectVarScopeBindings(ast, rootScope);

  function visit(node: AstRecord, parentScope: AstScope, safeReference = false): void {
    if (!stable) return;
    if (isFunctionNode(node)) {
      const parameterScope = createAstScope(parentScope);
      collectBindingNames(node.id, parameterScope.bindings);
      for (const parameter of nodeArray(node.params)) {
        collectBindingNames(parameter, parameterScope.bindings);
        if (isAstRecord(parameter)) visit(parameter, parameterScope);
      }
      if (isAstRecord(node.body)) {
        const bodyScope = createAstScope(parameterScope);
        if (node.body.type === "BlockStatement") {
          collectDirectScopeBindings(node.body, bodyScope);
          collectVarScopeBindings(node.body, bodyScope);
        }
        visit(node.body, bodyScope);
      }
      return;
    }

    if (node.type === "SwitchStatement") {
      if (isAstRecord(node.discriminant)) visit(node.discriminant, parentScope, true);
      const switchScope = createAstScope(parentScope);
      collectSwitchScopeBindings(node, switchScope);
      for (const switchCase of nodeArray(node.cases)) {
        if (isAstRecord(switchCase)) visit(switchCase, switchScope);
      }
      return;
    }

    const scope = childScope(node, parentScope) ?? parentScope;
    if (node.type === "Identifier") {
      if (
        !safeReference &&
        (isGlobalObjectReference(scope, node) || isDynamicCodeCapabilityReference(scope, node))
      ) {
        stable = false;
      }
      return;
    }
    if (node.type === "AssignmentExpression") {
      if (assignedTargetCanMutateGlobalCapability(scope, node.left, "URL")) stable = false;
    } else if (node.type === "UpdateExpression") {
      if (assignedTargetCanMutateGlobalCapability(scope, node.argument, "URL")) stable = false;
    } else if (node.type === "UnaryExpression" && node.operator === "delete") {
      if (assignedTargetCanMutateGlobalCapability(scope, node.argument, "URL")) stable = false;
    } else if (
      (node.type === "ForInStatement" || node.type === "ForOfStatement") &&
      (!isAstRecord(node.left) || node.left.type !== "VariableDeclaration") &&
      assignedTargetCanMutateGlobalCapability(scope, node.left, "URL")
    ) {
      stable = false;
    }
    if (!stable) return;

    if (
      node.type === "TSAsExpression" ||
      node.type === "TSSatisfiesExpression" ||
      node.type === "TSNonNullExpression" ||
      node.type === "TSInstantiationExpression" ||
      node.type === "TSTypeAssertion"
    ) {
      if (isAstRecord(node.expression)) visit(node.expression, scope, safeReference);
      return;
    }
    if (node.type === "TSEnumDeclaration") {
      const body = isAstRecord(node.body) ? node.body : node;
      for (const member of nodeArray(body.members)) {
        if (isAstRecord(member) && isAstRecord(member.initializer)) {
          visit(member.initializer, scope);
        }
      }
      return;
    }
    if (node.type === "TSModuleDeclaration") {
      if (isAstRecord(node.body)) visit(node.body, scope);
      return;
    }
    if (node.type === "TSModuleBlock") {
      for (const statement of nodeArray(node.body)) {
        if (isAstRecord(statement)) visit(statement, scope);
      }
      return;
    }
    if (node.type === "TSExportAssignment") {
      if (isAstRecord(node.expression)) visit(node.expression, scope);
      return;
    }
    if (node.type === "TSParameterProperty") {
      if (isAstRecord(node.parameter)) visit(node.parameter, scope, safeReference);
      return;
    }
    if (node.type.startsWith("TS")) {
      return;
    }
    if (node.type === "MemberExpression") {
      if (
        !safeReference &&
        (isGlobalObjectReference(scope, node) || isDynamicCodeCapabilityReference(scope, node))
      ) {
        stable = false;
        return;
      }
      if (isAstRecord(node.object)) {
        visit(node.object, scope, isGlobalObjectReference(scope, node.object));
      }
      if (node.computed === true && isAstRecord(node.property)) visit(node.property, scope, true);
      return;
    }
    if (node.type === "ExpressionStatement") {
      if (isAstRecord(node.expression)) visit(node.expression, scope, true);
      return;
    }
    if (node.type === "Property" || node.type === "PropertyDefinition") {
      if (node.computed === true && isAstRecord(node.key)) visit(node.key, scope, true);
      if (isAstRecord(node.value)) visit(node.value, scope);
      return;
    }
    if (node.type === "MethodDefinition") {
      if (node.computed === true && isAstRecord(node.key)) visit(node.key, scope, true);
      if (isAstRecord(node.value)) visit(node.value, scope);
      return;
    }
    if (node.type === "JSXAttribute") {
      if (isAstRecord(node.value)) visit(node.value, scope);
      return;
    }
    if (node.type === "SwitchCase") {
      if (isAstRecord(node.test)) visit(node.test, scope, true);
      for (const statement of nodeArray(node.consequent)) {
        if (isAstRecord(statement)) visit(statement, scope);
      }
      return;
    }
    if (node.type === "BinaryExpression") {
      const safe = node.operator === "===" || node.operator === "!==";
      if (isAstRecord(node.left)) visit(node.left, scope, safe);
      if (isAstRecord(node.right)) visit(node.right, scope, safe);
      return;
    }
    if (node.type === "UnaryExpression" && node.operator !== "delete") {
      const safe = node.operator === "!" || node.operator === "typeof" || node.operator === "void";
      if (isAstRecord(node.argument)) visit(node.argument, scope, safe);
      return;
    }
    if (node.type === "LogicalExpression") {
      if (isAstRecord(node.left)) visit(node.left, scope, true);
      if (isAstRecord(node.right)) visit(node.right, scope, safeReference);
      return;
    }
    if (node.type === "ConditionalExpression") {
      if (isAstRecord(node.test)) visit(node.test, scope, true);
      if (isAstRecord(node.consequent)) visit(node.consequent, scope, safeReference);
      if (isAstRecord(node.alternate)) visit(node.alternate, scope, safeReference);
      return;
    }
    if (node.type === "SequenceExpression") {
      const expressions = nodeArray(node.expressions);
      for (const [index, expression] of expressions.entries()) {
        if (isAstRecord(expression)) {
          visit(expression, scope, index === expressions.length - 1 ? safeReference : true);
        }
      }
      return;
    }
    if (node.type === "ForStatement") {
      if (isAstRecord(node.init)) visit(node.init, scope, true);
      if (isAstRecord(node.test)) visit(node.test, scope, true);
      if (isAstRecord(node.update)) visit(node.update, scope, true);
      if (isAstRecord(node.body)) visit(node.body, scope);
      return;
    }
    if (
      node.type === "IfStatement" ||
      node.type === "WhileStatement" ||
      node.type === "DoWhileStatement"
    ) {
      if (isAstRecord(node.test)) visit(node.test, scope, true);
      if (isAstRecord(node.body)) visit(node.body, scope);
      if (node.type === "IfStatement" && isAstRecord(node.consequent)) {
        visit(node.consequent, scope);
      }
      if (node.type === "IfStatement" && isAstRecord(node.alternate)) {
        visit(node.alternate, scope);
      }
      return;
    }

    forEachAstChild(node, (child) => visit(child, scope));
  }

  for (const statement of nodeArray(ast.body)) {
    if (isAstRecord(statement)) visit(statement, rootScope);
  }
  return stable;
}
