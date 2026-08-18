import fs from "node:fs";
import path from "pathslash";
import type { ResolvedConfig } from "vite";
import type { TransformPluginContext } from "vite/rolldown";
import { contentTypeForPath } from "../server/static-file-cache.js";
import {
  collectBindingNames,
  forEachAstChild,
  hasRange,
  isAstRecord,
  isIdentifierNamed,
  nodeArray,
  unwrapExpression,
  type AstRange,
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
import { OgAssetOwnership } from "./og-asset-ownership.js";
import {
  isImportMetaUrlOrChainedNode,
  isNewUrlExpression,
  relativeDynamicImportUrlSpecifier,
} from "./import-meta-url-syntax.js";

type AssetUrl = {
  range: AstRange;
  sourceRange: AstRange;
  specifier: string;
  preserveEvaluation?: boolean;
  binding?: AssetBinding;
};

type AssetBinding = { asset: AssetUrl; valid: boolean };

export type ImportMetaAssetRewrite = { start: number; end: number; replacement: string };

type AssetScope = AstScope & {
  assets: Map<string, AssetBinding>;
  unsafeAssetBindings: Set<string>;
  nodeUrlFunctions: Set<string>;
  nodeUrlNamespaces: Set<string>;
};

function createAssetScope(parent: AssetScope | null): AssetScope {
  return {
    ...createAstScope(parent),
    assets: new Map(),
    unsafeAssetBindings: new Set(),
    nodeUrlFunctions: new Set(),
    nodeUrlNamespaces: new Set(),
  };
}

function collectNodeUrlImports(ast: AstRecord, scope: AssetScope): void {
  for (const statement of nodeArray(ast.body)) {
    if (
      !isAstRecord(statement) ||
      statement.type !== "ImportDeclaration" ||
      !isAstRecord(statement.source) ||
      (statement.source.value !== "node:url" && statement.source.value !== "url")
    ) {
      continue;
    }
    for (const specifier of nodeArray(statement.specifiers)) {
      if (!isAstRecord(specifier) || !isAstRecord(specifier.local)) continue;
      const local = specifier.local.name;
      if (typeof local !== "string") continue;
      if (
        specifier.type === "ImportSpecifier" &&
        isAstRecord(specifier.imported) &&
        specifier.imported.name === "fileURLToPath"
      ) {
        scope.nodeUrlFunctions.add(local);
      } else if (specifier.type === "ImportNamespaceSpecifier") {
        scope.nodeUrlNamespaces.add(local);
      }
    }
  }
}

function assetUrlFromNode(value: unknown): AssetUrl | null {
  const expression = unwrapExpression(value);
  if (!isNewUrlExpression(expression) || !hasRange(expression)) {
    return null;
  }

  const args = nodeArray(expression.arguments);
  if (args.length !== 2 || !isImportMetaUrlOrChainedNode(args[1])) return null;
  const specifier = unwrapExpression(args[0]);
  if (
    !isAstRecord(specifier) ||
    specifier.type !== "Literal" ||
    typeof specifier.value !== "string"
  ) {
    return null;
  }
  if (
    specifier.value === "" ||
    specifier.value.startsWith("?") ||
    specifier.value.startsWith("#") ||
    /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(specifier.value) ||
    specifier.value.startsWith("/")
  ) {
    return null;
  }
  return {
    range: isAstRecord(value) && hasRange(value) ? value : expression,
    sourceRange: expression,
    specifier: specifier.value,
  };
}

function recordAssetBinding(
  declaration: AstRecord,
  declarator: AstRecord,
  scope: AssetScope,
): void {
  if (
    declaration.kind !== "const" ||
    !isAstRecord(declarator.id) ||
    declarator.id.type !== "Identifier" ||
    typeof declarator.id.name !== "string"
  ) {
    return;
  }
  if (hasAstBinding(scope, "URL")) return;
  if (isUnsafeAssetBinding(scope, declarator.id.name)) return;
  const asset = assetUrlFromNode(declarator.init);
  if (asset) scope.assets.set(declarator.id.name, { asset, valid: true });
}

function collectAssetScopeBindings(node: AstRecord, scope: AssetScope): void {
  collectDirectScopeBindings(node, scope);
}

function findAssetBinding(scope: AssetScope, name: string): AssetBinding | null {
  for (
    let current: AssetScope | null = scope;
    current;
    current = current.parent as AssetScope | null
  ) {
    const asset = current.assets.get(name);
    if (asset) return asset;
    if (current.bindings.has(name)) return null;
  }
  return null;
}

function isUnsafeAssetBinding(scope: AssetScope, name: string): boolean {
  for (
    let current: AssetScope | null = scope;
    current;
    current = current.parent as AssetScope | null
  ) {
    if (current.unsafeAssetBindings.has(name)) return true;
    if (current.bindings.has(name)) return false;
  }
  return false;
}

function invalidateAssetBinding(scope: AssetScope, name: string): void {
  for (
    let current: AssetScope | null = scope;
    current;
    current = current.parent as AssetScope | null
  ) {
    const binding = current.assets.get(name);
    if (binding) {
      binding.valid = false;
      current.assets.delete(name);
      current.unsafeAssetBindings.add(name);
      return;
    }
    if (current.bindings.has(name)) {
      current.unsafeAssetBindings.add(name);
      return;
    }
  }
}

function invalidateAssetsVisibleToDirectEval(scope: AssetScope): void {
  const shadowed = new Set<string>();
  for (
    let current: AssetScope | null = scope;
    current;
    current = current.parent as AssetScope | null
  ) {
    for (const [name, binding] of current.assets) {
      if (shadowed.has(name)) continue;
      binding.valid = false;
      current.assets.delete(name);
    }
    for (const name of current.bindings) {
      if (shadowed.has(name)) continue;
      const binding = current.assets.get(name);
      if (binding) binding.valid = false;
      current.assets.delete(name);
      current.unsafeAssetBindings.add(name);
    }
    for (const name of current.bindings) shadowed.add(name);
  }
}

function rootIdentifierName(value: unknown): string | null {
  let node = unwrapExpression(value);
  while (node?.type === "MemberExpression") node = unwrapExpression(node.object);
  return node?.type === "Identifier" && typeof node.name === "string" ? node.name : null;
}

function hasScopedCapability(
  scope: AssetScope,
  name: string,
  capability: "nodeUrlFunctions" | "nodeUrlNamespaces",
): boolean {
  for (
    let current: AssetScope | null = scope;
    current;
    current = current.parent as AssetScope | null
  ) {
    if (current[capability].has(name)) return true;
    if (current.bindings.has(name)) return false;
  }
  return false;
}

function isNodeUrlFileUrlToPath(scope: AssetScope, value: unknown): boolean {
  const callee = unwrapExpression(value);
  if (callee?.type === "Identifier" && typeof callee.name === "string") {
    return hasScopedCapability(scope, callee.name, "nodeUrlFunctions");
  }
  if (
    callee?.type === "MemberExpression" &&
    callee.computed !== true &&
    isIdentifierNamed(callee.property, "fileURLToPath")
  ) {
    const namespace = unwrapExpression(callee.object);
    return (
      namespace?.type === "Identifier" &&
      typeof namespace.name === "string" &&
      hasScopedCapability(scope, namespace.name, "nodeUrlNamespaces")
    );
  }
  return false;
}

function isGlobalThisMember(scope: AssetScope, value: unknown, name: string): boolean {
  const member = unwrapExpression(value);
  if (
    member?.type !== "MemberExpression" ||
    !(
      (member.computed !== true && isIdentifierNamed(member.property, name)) ||
      (member.computed === true &&
        isAstRecord(member.property) &&
        member.property.type === "Literal" &&
        member.property.value === name)
    )
  ) {
    return false;
  }
  const receiver = unwrapExpression(member.object);
  return isIdentifierNamed(receiver, "globalThis") && !hasAstBinding(scope, "globalThis");
}

function isGlobalFetchCallee(scope: AssetScope, value: unknown): boolean {
  const callee = unwrapExpression(value);
  if (isIdentifierNamed(callee, "fetch")) return !hasAstBinding(scope, "fetch");
  return isGlobalThisMember(scope, callee, "fetch");
}

function invalidateAssignedAssetTargets(scope: AssetScope, value: unknown): void {
  const node = unwrapExpression(value);
  if (!node) return;
  if (node.type === "Identifier" && typeof node.name === "string") {
    invalidateAssetBinding(scope, node.name);
    return;
  }
  if (node.type === "MemberExpression") {
    const assigned = rootIdentifierName(node);
    if (assigned) invalidateAssetBinding(scope, assigned);
    return;
  }
  if (node.type === "AssignmentPattern") {
    invalidateAssignedAssetTargets(scope, node.left);
    return;
  }
  if (node.type === "RestElement") {
    invalidateAssignedAssetTargets(scope, node.argument);
    return;
  }
  if (node.type === "ArrayPattern" || node.type === "ArrayExpression") {
    for (const element of nodeArray(node.elements)) invalidateAssignedAssetTargets(scope, element);
    return;
  }
  if (node.type === "ObjectPattern" || node.type === "ObjectExpression") {
    for (const property of nodeArray(node.properties)) {
      if (!isAstRecord(property)) continue;
      invalidateAssignedAssetTargets(
        scope,
        property.type === "RestElement" ? property.argument : property.value,
      );
    }
  }
}

function invalidateEscapedAssetValue(scope: AssetScope, value: unknown): void {
  const node = unwrapExpression(value);
  if (!node) return;
  if (node.type === "Identifier" && typeof node.name === "string") {
    invalidateAssetBinding(scope, node.name);
    return;
  }
  if (node.type === "ConditionalExpression") {
    invalidateEscapedAssetValue(scope, node.consequent);
    invalidateEscapedAssetValue(scope, node.alternate);
  } else if (node.type === "LogicalExpression" || node.type === "SequenceExpression") {
    for (const expression of node.type === "SequenceExpression"
      ? nodeArray(node.expressions)
      : [node.left, node.right]) {
      invalidateEscapedAssetValue(scope, expression);
    }
  } else if (node.type === "ArrayExpression") {
    for (const element of nodeArray(node.elements)) invalidateEscapedAssetValue(scope, element);
  } else if (node.type === "ObjectExpression") {
    for (const property of nodeArray(node.properties)) {
      if (isAstRecord(property)) invalidateEscapedAssetValue(scope, property.value);
    }
  } else if (node.type === "MemberExpression") {
    const property = unwrapExpression(node.property);
    const safeUrlValue =
      node.computed !== true &&
      property?.type === "Identifier" &&
      [
        "hash",
        "host",
        "hostname",
        "href",
        "origin",
        "password",
        "pathname",
        "port",
        "protocol",
        "search",
        "toJSON",
        "toString",
        "username",
      ].includes(String(property.name));
    if (safeUrlValue) return;
    const referenced = rootIdentifierName(node);
    if (referenced) invalidateAssetBinding(scope, referenced);
  }
}

function createChildScope(node: AstRecord, parent: AssetScope): AssetScope | null {
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

  const scope = createAssetScope(parent);
  if (node.type === "ClassDeclaration" || node.type === "ClassExpression") {
    collectBindingNames(node.id, scope.bindings);
  } else if (node.type === "CatchClause") {
    collectBindingNames(node.param, scope.bindings);
  }
  collectAssetScopeBindings(node, scope);
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

function collectAssetUrlRewrites(ast: AstRecord, nodelessTarget: boolean): AssetUrl[] {
  const assets: AssetUrl[] = [];
  let globalFetchIsStable = true;
  const rootScope = createAssetScope(null);
  collectAssetScopeBindings(ast, rootScope);
  collectVarScopeBindings(ast, rootScope);
  collectNodeUrlImports(ast, rootScope);

  function visit(node: AstRecord, parentScope: AssetScope, safeAssetReference = false): void {
    if (isFunctionNode(node)) {
      const parameterScope = createAssetScope(parentScope);
      collectBindingNames(node.id, parameterScope.bindings);
      for (const parameter of nodeArray(node.params)) {
        collectBindingNames(parameter, parameterScope.bindings);
        if (isAstRecord(parameter)) visit(parameter, parameterScope);
      }

      if (isAstRecord(node.body)) {
        if (node.body.type === "BlockStatement") {
          const bodyScope = createAssetScope(parameterScope);
          collectAssetScopeBindings(node.body, bodyScope);
          collectVarScopeBindings(node.body, bodyScope);
          visit(node.body, bodyScope);
        } else {
          visit(node.body, parameterScope);
        }
      }
      return;
    }

    if (node.type === "SwitchStatement") {
      if (isAstRecord(node.discriminant)) visit(node.discriminant, parentScope, true);
      const switchScope = createAssetScope(parentScope);
      collectSwitchScopeBindings(node, switchScope);
      for (const switchCase of nodeArray(node.cases)) {
        // Cases share lexical bindings but not proven control-flow dominance.
        // Keep aliases case-local so a declaration in one case cannot rewrite
        // a fetch reached through another case.
        if (isAstRecord(switchCase)) visit(switchCase, createAssetScope(switchScope));
      }
      return;
    }

    const scope = createChildScope(node, parentScope) ?? parentScope;
    if (node.type === "Identifier" && typeof node.name === "string") {
      if (
        !safeAssetReference &&
        ((node.name === "eval" && !hasAstBinding(scope, "eval")) ||
          (node.name === "globalThis" && !hasAstBinding(scope, "globalThis")))
      ) {
        globalFetchIsStable = false;
      }
      if (!safeAssetReference) invalidateAssetBinding(scope, node.name);
      return;
    }
    if (node.type === "VariableDeclaration") {
      for (const declarator of nodeArray(node.declarations)) {
        if (!isAstRecord(declarator)) continue;
        if (!assetUrlFromNode(declarator.init)) {
          invalidateEscapedAssetValue(scope, declarator.init);
        }
        if (isAstRecord(declarator.init)) visit(declarator.init, scope);
        recordAssetBinding(node, declarator, scope);
      }
      return;
    }
    if (node.type === "ImportDeclaration") return;
    if (
      node.type === "TSAsExpression" ||
      node.type === "TSSatisfiesExpression" ||
      node.type === "TSNonNullExpression" ||
      node.type === "TSInstantiationExpression" ||
      node.type === "TSTypeAssertion"
    ) {
      if (isAstRecord(node.expression)) visit(node.expression, scope, safeAssetReference);
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
      if (isAstRecord(node.parameter)) visit(node.parameter, scope, safeAssetReference);
      return;
    }
    if (node.type.startsWith("TS")) return;
    if (
      (node.type === "ForInStatement" || node.type === "ForOfStatement") &&
      (!isAstRecord(node.left) || node.left.type !== "VariableDeclaration")
    ) {
      invalidateAssignedAssetTargets(scope, node.left);
    }
    if (
      node.type === "ImportExpression" &&
      relativeDynamicImportUrlSpecifier(node.source) !== null
    ) {
      return;
    }
    const nodelessAsset = nodelessTarget && !hasAstBinding(scope, "URL") && assetUrlFromNode(node);
    if (nodelessAsset) {
      assets.push(nodelessAsset);
      return;
    }

    if (!nodelessTarget) {
      if (node.type === "AssignmentExpression") {
        if (isGlobalFetchCallee(scope, node.left)) globalFetchIsStable = false;
        invalidateAssignedAssetTargets(scope, node.left);
        invalidateEscapedAssetValue(scope, node.right);
      } else if (node.type === "UpdateExpression") {
        if (isGlobalFetchCallee(scope, node.argument)) globalFetchIsStable = false;
        invalidateAssignedAssetTargets(scope, node.argument);
      } else if (node.type === "UnaryExpression" && node.operator === "delete") {
        if (isGlobalFetchCallee(scope, node.argument)) globalFetchIsStable = false;
        invalidateAssignedAssetTargets(scope, node.argument);
      } else if (node.type === "NewExpression") {
        for (const argument of nodeArray(node.arguments)) {
          invalidateEscapedAssetValue(scope, argument);
        }
      } else if (
        node.type === "ReturnStatement" ||
        node.type === "ThrowStatement" ||
        node.type === "YieldExpression"
      ) {
        invalidateEscapedAssetValue(scope, node.argument);
      } else if (node.type === "ArrayExpression") {
        for (const element of nodeArray(node.elements)) {
          invalidateEscapedAssetValue(scope, element);
        }
      } else if (node.type === "Property") {
        invalidateEscapedAssetValue(scope, node.value);
      }
    }

    if (
      !nodelessTarget &&
      node.type === "CallExpression" &&
      isGlobalFetchCallee(scope, node.callee)
    ) {
      const input = nodeArray(node.arguments)[0];
      const directAsset = hasAstBinding(scope, "URL") ? null : assetUrlFromNode(input);
      if (directAsset) {
        assets.push(directAsset);
      } else if (
        isAstRecord(input) &&
        unwrapExpression(input)?.type === "Identifier" &&
        hasRange(input)
      ) {
        const identifier = unwrapExpression(input)!;
        const boundAsset = findAssetBinding(scope, String(identifier.name));
        if (boundAsset) {
          assets.push({
            ...boundAsset.asset,
            range: input,
            preserveEvaluation: true,
            binding: boundAsset,
          });
        }
      }
    }

    if (!nodelessTarget && node.type === "CallExpression") {
      const callee = unwrapExpression(node.callee);
      const isGlobalFetch = isGlobalFetchCallee(scope, callee);
      const isReadOnlyUrlConsumer = isNodeUrlFileUrlToPath(scope, callee);
      const isDirectEval =
        node.optional !== true &&
        isIdentifierNamed(callee, "eval") &&
        !hasAstBinding(scope, "eval");
      if (isDirectEval) invalidateAssetsVisibleToDirectEval(scope);
      if (!isGlobalFetch && !isReadOnlyUrlConsumer) {
        const receiver =
          callee?.type === "MemberExpression" ? rootIdentifierName(callee.object) : null;
        if (receiver) invalidateAssetBinding(scope, receiver);
        for (const argument of nodeArray(node.arguments)) {
          invalidateEscapedAssetValue(scope, argument);
        }
      }
      if (isAstRecord(node.callee)) visit(node.callee, scope);
      for (const [index, argument] of nodeArray(node.arguments).entries()) {
        if (!isAstRecord(argument)) continue;
        const safeArgument =
          (isGlobalFetch && index === 0 && unwrapExpression(argument)?.type === "Identifier") ||
          (isReadOnlyUrlConsumer && unwrapExpression(argument)?.type === "Identifier");
        visit(argument, scope, safeArgument);
      }
      return;
    }

    if (node.type === "MemberExpression") {
      if (!nodelessTarget && isGlobalThisMember(scope, node, "eval")) {
        globalFetchIsStable = false;
      }
      const property = unwrapExpression(node.property);
      const safeUrlValue =
        node.computed !== true &&
        property?.type === "Identifier" &&
        [
          "hash",
          "host",
          "hostname",
          "href",
          "origin",
          "password",
          "pathname",
          "port",
          "protocol",
          "search",
          "toJSON",
          "toString",
          "username",
        ].includes(String(property.name));
      const safeGlobalThisReceiver =
        isIdentifierNamed(unwrapExpression(node.object), "globalThis") &&
        !hasAstBinding(scope, "globalThis");
      if (isAstRecord(node.object)) {
        visit(node.object, scope, safeUrlValue || safeGlobalThisReceiver);
      }
      if (node.computed === true && isAstRecord(node.property)) visit(node.property, scope);
      return;
    }

    if (node.type === "Property" || node.type === "PropertyDefinition") {
      if (node.computed === true && isAstRecord(node.key)) visit(node.key, scope);
      if (isAstRecord(node.value)) visit(node.value, scope);
      return;
    }

    if (node.type === "MethodDefinition") {
      if (node.computed === true && isAstRecord(node.key)) visit(node.key, scope);
      if (isAstRecord(node.value)) visit(node.value, scope);
      return;
    }

    if (node.type === "JSXAttribute") {
      if (isAstRecord(node.value)) visit(node.value, scope);
      return;
    }

    if (node.type === "LabeledStatement") {
      if (isAstRecord(node.body)) visit(node.body, scope);
      return;
    }
    if (node.type === "BreakStatement" || node.type === "ContinueStatement") return;

    if (node.type === "SwitchCase") {
      if (isAstRecord(node.test)) visit(node.test, scope, true);
      for (const statement of nodeArray(node.consequent)) {
        if (isAstRecord(statement)) visit(statement, scope);
      }
      return;
    }

    if (node.type === "ExportSpecifier") {
      if (node.exportKind === "type") return;
      if (isAstRecord(node.local)) visit(node.local, scope);
      return;
    }

    const visitReadOnly = (value: unknown): void => {
      if (isAstRecord(value)) visit(value, scope, true);
    };
    if (
      node.type === "IfStatement" ||
      node.type === "WhileStatement" ||
      node.type === "DoWhileStatement"
    ) {
      visitReadOnly(node.test);
      if (isAstRecord(node.body)) visit(node.body, scope);
      if (node.type === "IfStatement" && isAstRecord(node.consequent)) {
        visit(node.consequent, scope);
      }
      if (node.type === "IfStatement" && isAstRecord(node.alternate)) {
        visit(node.alternate, scope);
      }
      return;
    }
    if (node.type === "ConditionalExpression") {
      visitReadOnly(node.test);
      if (isAstRecord(node.consequent)) visit(node.consequent, scope, safeAssetReference);
      if (isAstRecord(node.alternate)) visit(node.alternate, scope, safeAssetReference);
      return;
    }
    if (node.type === "ForStatement") {
      if (isAstRecord(node.init)) visit(node.init, scope);
      visitReadOnly(node.test);
      if (isAstRecord(node.update)) visit(node.update, scope);
      if (isAstRecord(node.body)) visit(node.body, scope);
      return;
    }
    if (node.type === "LogicalExpression") {
      visitReadOnly(node.left);
      if (isAstRecord(node.right)) visit(node.right, scope, safeAssetReference);
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
    if (node.type === "SequenceExpression") {
      const expressions = nodeArray(node.expressions);
      for (const [index, expression] of expressions.entries()) {
        if (isAstRecord(expression)) {
          visit(expression, scope, index === expressions.length - 1 ? safeAssetReference : true);
        }
      }
      return;
    }

    if (node.type === "ExportNamedDeclaration" || node.type === "ExportDefaultDeclaration") {
      if (node.exportKind === "type") return;
      if (isAstRecord(node.source)) return;
      if (isAstRecord(node.declaration)) {
        visit(node.declaration, scope);
        if (node.declaration.type === "VariableDeclaration") {
          for (const declarator of nodeArray(node.declaration.declarations)) {
            if (isAstRecord(declarator)) invalidateAssignedAssetTargets(scope, declarator.id);
          }
        }
      }
      for (const specifier of nodeArray(node.specifiers)) {
        if (isAstRecord(specifier)) visit(specifier, scope);
      }
      return;
    }

    forEachAstChild(node, (child) => visit(child, scope));
  }

  for (const statement of nodeArray(ast.body)) {
    if (isAstRecord(statement)) visit(statement, rootScope);
  }
  if (!nodelessTarget && !globalFetchIsStable) return [];
  return assets.filter((asset) => asset.binding?.valid !== false);
}

/**
 * The asset phase of the shared import-meta capability. This is deliberately a
 * typed helper rather than another Vite plugin: the existing import-meta plugin
 * owns hook ordering, target policy, and the final combined transform.
 */
export class ImportMetaAssetTransformer {
  readonly #cache = new Map<string, string>();
  #isBuild = false;

  constructor(
    private readonly options: {
      isNodelessTarget: () => boolean;
      ownership: OgAssetOwnership;
    },
  ) {}

  configResolved(config: ResolvedConfig): void {
    this.#isBuild = config.command === "build";
  }

  buildStart(): void {
    if (this.#isBuild) this.#cache.clear();
  }

  async collectRewrites(
    context: TransformPluginContext,
    code: string,
    id: string,
    ast: AstRecord,
  ): Promise<ImportMetaAssetRewrite[]> {
    const assetUrls = collectAssetUrlRewrites(ast, this.options.isNodelessTarget());
    if (assetUrls.length === 0) return [];
    const moduleBoundary = await this.options.ownership.resolveModuleBoundary(id);
    if (moduleBoundary === null) return [];

    const rewrites: ImportMetaAssetRewrite[] = [];
    for (const assetUrl of assetUrls) {
      const argument = nodeArray(assetUrl.sourceRange.arguments)[0];
      if (
        isAstRecord(argument) &&
        hasRange(argument) &&
        /\/\*\s*@vite-ignore\s*\*\//.test(code.slice(assetUrl.sourceRange.start, argument.start))
      ) {
        continue;
      }

      const cleanSpecifier = assetUrl.specifier.split(/[?#]/, 1)[0];
      if (cleanSpecifier === "") continue;
      let file: string | null = null;
      if (cleanSpecifier.startsWith("./") || cleanSpecifier.startsWith("../")) {
        file = await this.options.ownership.resolveContainedAsset(
          moduleBoundary.assetRoot,
          path.resolve(moduleBoundary.moduleDir, cleanSpecifier),
        );
      } else {
        const resolved = await context.resolve(assetUrl.specifier, id, { skipSelf: true });
        if (resolved !== null && !resolved.external) {
          const assetBoundary = await this.options.ownership.resolveModuleBoundary(resolved.id);
          if (assetBoundary !== null) {
            file = await this.options.ownership.resolveContainedAsset(
              assetBoundary.assetRoot,
              resolved.id.split(/[?#]/, 1)[0],
            );
          }
        }
      }
      if (file === null) continue;

      let dataUrl = this.#isBuild ? this.#cache.get(file) : undefined;
      if (dataUrl === undefined) {
        let bytes: Buffer;
        try {
          bytes = await fs.promises.readFile(file);
        } catch {
          continue;
        }
        dataUrl = `data:${contentTypeForPath(file)};base64,${bytes.toString("base64")}`;
        if (this.#isBuild) this.#cache.set(file, dataUrl);
      }

      // The bytes are embedded instead of entering Vite's module graph, so the
      // owning module must be invalidated when only the asset changes.
      context.addWatchFile(file);
      rewrites.push({
        start: assetUrl.range.start,
        end: assetUrl.range.end,
        replacement: assetUrl.preserveEvaluation
          ? `(${code.slice(assetUrl.range.start, assetUrl.range.end)}, new URL(${JSON.stringify(dataUrl)}))`
          : `new URL(${JSON.stringify(dataUrl)})`,
      });
    }

    return rewrites;
  }
}
