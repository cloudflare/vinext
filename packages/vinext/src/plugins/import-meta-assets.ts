import fs from "node:fs";
import path, { toSlash } from "pathslash";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ResolvedConfig } from "vite";
import type { TransformPluginContext } from "vite/rolldown";
import { contentTypeForPath } from "../server/static-file-cache.js";
import {
  collectBindingNames,
  directivePrologueEnd,
  forEachAstChild,
  hasRange,
  isAstRecord,
  isIdentifierNamed,
  nodeArray,
  staticStringValue,
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
  hasBundlerIgnoreInNewUrl,
  isImportMetaUrlOrChainedNode,
  isNewUrlExpression,
} from "./import-meta-url-syntax.js";
import { stripViteModuleQuery } from "../utils/path.js";

type AssetUrl = {
  range: AstRange;
  sourceRange: AstRange;
  baseRange: AstRange;
  specifier: string;
  replacementKind?: "url" | "array-buffer-promise";
  binding?: AssetBinding;
};

type AssetBinding = {
  asset: AssetUrl;
  declarator: AstRange;
  valid: boolean;
};

type AssetScope = AstScope & {
  assets: Map<string, AssetBinding>;
  nodeUrlFunctions: Set<string>;
  nodeUrlNamespaces: Set<string>;
};

export type ImportMetaAssetRewrite = {
  start: number;
  end: number;
  replacement: string;
};

function createAssetScope(parent: AssetScope | null): AssetScope {
  return {
    ...createAstScope(parent),
    assets: new Map(),
    nodeUrlFunctions: new Set(),
    nodeUrlNamespaces: new Set(),
  };
}

function addScopeBindingNames(scope: AssetScope, target: Set<string>): void {
  for (const name of scope.bindings) target.add(name);
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
  if (!isNewUrlExpression(expression) || !hasRange(expression)) return null;

  const args = nodeArray(expression.arguments);
  const specifier = staticStringValue(unwrapExpression(args[0]));
  if (
    args.length !== 2 ||
    !isImportMetaUrlOrChainedNode(args[1]) ||
    !hasRange(args[1]) ||
    specifier === null
  ) {
    return null;
  }
  if (
    specifier === "" ||
    specifier.startsWith("?") ||
    specifier.startsWith("#") ||
    specifier.startsWith("/") ||
    /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(specifier)
  ) {
    return null;
  }
  return {
    range: isAstRecord(value) && hasRange(value) ? value : expression,
    sourceRange: expression,
    baseRange: args[1],
    specifier,
  };
}

function isNamedMember(value: unknown, name: string): value is AstRecord {
  const member = unwrapExpression(value);
  return (
    member?.type === "MemberExpression" &&
    member.optional !== true &&
    member.computed !== true &&
    isIdentifierNamed(member.property, name)
  );
}

function isParameterArrayBufferCall(value: unknown, parameterName: string): boolean {
  const call = unwrapExpression(value);
  if (
    call?.type !== "CallExpression" ||
    call.optional === true ||
    nodeArray(call.arguments).length !== 0 ||
    !isNamedMember(call.callee, "arrayBuffer")
  ) {
    return false;
  }
  const receiver = unwrapExpression(call.callee.object);
  return isIdentifierNamed(receiver, parameterName);
}

function callbackReturnsArrayBuffer(value: unknown): boolean {
  const callback = unwrapExpression(value);
  if (
    (callback?.type !== "ArrowFunctionExpression" && callback?.type !== "FunctionExpression") ||
    callback.generator === true ||
    callback.async === true ||
    nodeArray(callback.params).length !== 1
  ) {
    return false;
  }
  const parameter = unwrapExpression(nodeArray(callback.params)[0]);
  if (parameter?.type !== "Identifier" || typeof parameter.name !== "string") return false;

  const body = unwrapExpression(callback.body);
  if (body?.type !== "BlockStatement") {
    return isParameterArrayBufferCall(body, parameter.name);
  }
  const statements = nodeArray(body.body);
  return (
    statements.length === 1 &&
    isAstRecord(statements[0]) &&
    statements[0].type === "ReturnStatement" &&
    isParameterArrayBufferCall(statements[0].argument, parameter.name)
  );
}

function arrayBufferFetchAssetFromCall(
  value: AstRecord,
  scope: AssetScope,
): { asset: AssetUrl; fetchCall: AstRecord } | null {
  if (
    value.type !== "CallExpression" ||
    value.optional === true ||
    nodeArray(value.arguments).length !== 1 ||
    !isNamedMember(value.callee, "then") ||
    !callbackReturnsArrayBuffer(nodeArray(value.arguments)[0]) ||
    !hasRange(value)
  ) {
    return null;
  }
  const fetchCall = unwrapExpression(value.callee.object);
  if (
    fetchCall?.type !== "CallExpression" ||
    fetchCall.optional === true ||
    nodeArray(fetchCall.arguments).length !== 1 ||
    !isIdentifierNamed(unwrapExpression(fetchCall.callee), "fetch") ||
    hasAstBinding(scope, "fetch") ||
    hasAstBinding(scope, "URL") ||
    hasAstBinding(scope, "globalThis")
  ) {
    return null;
  }
  const asset = assetUrlFromNode(nodeArray(fetchCall.arguments)[0]);
  if (asset === null) return null;
  return {
    asset: { ...asset, range: value, replacementKind: "array-buffer-promise" },
    fetchCall,
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
    typeof declarator.id.name !== "string" ||
    hasAstBinding(scope, "URL")
  ) {
    return;
  }
  const asset = assetUrlFromNode(declarator.init);
  if (asset && hasRange(declarator)) {
    scope.assets.set(declarator.id.name, { asset, declarator, valid: true });
  }
}

function collectAssetScopeBindings(node: AstRecord, scope: AssetScope): void {
  collectDirectScopeBindings(node, scope);
  collectDirectScopeBindings(node, scope, (declaration, declarator) =>
    recordAssetBinding(declaration, declarator, scope),
  );
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

function invalidateAssetBinding(scope: AssetScope, name: string): void {
  const binding = findAssetBinding(scope, name);
  if (binding) binding.valid = false;
}

function invalidateVisibleAssetBindings(scope: AssetScope): void {
  for (
    let current: AssetScope | null = scope;
    current;
    current = current.parent as AssetScope | null
  ) {
    for (const binding of current.assets.values()) binding.valid = false;
  }
}

function rootIdentifierName(value: unknown): string | null {
  let node = unwrapExpression(value);
  while (node?.type === "MemberExpression") node = unwrapExpression(node.object);
  return node?.type === "Identifier" && typeof node.name === "string" ? node.name : null;
}

function invalidateAssetTarget(scope: AssetScope, value: unknown): void {
  const node = unwrapExpression(value);
  if (!node) return;
  if (node.type === "Identifier" && typeof node.name === "string") {
    invalidateAssetBinding(scope, node.name);
    return;
  }
  if (node.type === "MemberExpression") {
    const name = rootIdentifierName(node);
    if (name) invalidateAssetBinding(scope, name);
    return;
  }
  if (node.type === "AssignmentPattern" || node.type === "RestElement") {
    invalidateAssetTarget(scope, node.type === "AssignmentPattern" ? node.left : node.argument);
    return;
  }
  if (node.type === "ArrayPattern") {
    for (const element of nodeArray(node.elements)) invalidateAssetTarget(scope, element);
    return;
  }
  if (node.type === "ObjectPattern") {
    for (const property of nodeArray(node.properties)) {
      if (!isAstRecord(property)) continue;
      invalidateAssetTarget(
        scope,
        property.type === "RestElement" ? property.argument : property.value,
      );
    }
  }
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

function createChildScope(node: AstRecord, parent: AssetScope): AssetScope | null {
  if (
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
  } else {
    if (node.type === "StaticBlock" || node.type === "TSModuleBlock") {
      collectVarScopeBindings(node, scope);
    }
    collectAssetScopeBindings(node, scope);
  }
  if (
    node.type === "ForStatement" ||
    node.type === "ForInStatement" ||
    node.type === "ForOfStatement"
  ) {
    collectLoopScopeBindings(node, scope);
    collectLoopScopeBindings(node, scope, (declaration, declarator) =>
      recordAssetBinding(declaration, declarator, scope),
    );
  }
  return scope;
}

function collectAssetUrlRewrites(ast: AstRecord): { assets: AssetUrl[]; usedNames: Set<string> } {
  const assets: AssetUrl[] = [];
  const usedNames = new Set<string>();
  const handledFetchCalls = new Set<AstRecord>();
  let deferredExecutionDepth = 0;
  const rootScope = createAssetScope(null);
  collectVarScopeBindings(ast, rootScope);
  collectAssetScopeBindings(ast, rootScope);
  collectNodeUrlImports(ast, rootScope);
  addScopeBindingNames(rootScope, usedNames);

  function visitBindingPatternRuntime(value: unknown, scope: AssetScope): void {
    const node = unwrapExpression(value);
    if (!node) return;
    if (node.type === "AssignmentPattern") {
      visitBindingPatternRuntime(node.left, scope);
      if (isAstRecord(node.right)) visit(node.right, scope);
      return;
    }
    if (node.type === "RestElement" || node.type === "TSParameterProperty") {
      visitBindingPatternRuntime(
        node.type === "RestElement" ? node.argument : node.parameter,
        scope,
      );
      return;
    }
    if (node.type === "ArrayPattern") {
      for (const element of nodeArray(node.elements)) visitBindingPatternRuntime(element, scope);
      return;
    }
    if (node.type === "ObjectPattern") {
      for (const property of nodeArray(node.properties)) {
        if (!isAstRecord(property)) continue;
        if (property.type === "RestElement") {
          visitBindingPatternRuntime(property.argument, scope);
          continue;
        }
        if (property.computed === true && isAstRecord(property.key)) visit(property.key, scope);
        visitBindingPatternRuntime(property.value, scope);
      }
    }
  }

  function visitDecorators(node: AstRecord, scope: AssetScope): void {
    for (const decorator of nodeArray(node.decorators)) {
      if (isAstRecord(decorator)) visit(decorator, scope);
    }
  }

  function visitDeferred(node: AstRecord, scope: AssetScope): void {
    deferredExecutionDepth++;
    try {
      visit(node, scope);
    } finally {
      deferredExecutionDepth--;
    }
  }

  function visit(node: AstRecord, parentScope: AssetScope, safeAssetReference = false): void {
    if (isFunctionNode(node)) {
      visitDecorators(node, parentScope);
      const parameterScope = createAssetScope(parentScope);
      collectBindingNames(node.id, parameterScope.bindings);
      collectBindingNames(node.id, usedNames);
      for (const parameter of nodeArray(node.params)) {
        collectBindingNames(parameter, parameterScope.bindings);
        collectBindingNames(parameter, usedNames);
      }
      addScopeBindingNames(parameterScope, usedNames);
      for (const parameter of nodeArray(node.params)) {
        if (isAstRecord(parameter)) {
          visitDecorators(parameter, parentScope);
          visitDeferred(parameter, parameterScope);
        }
      }
      if (isAstRecord(node.body)) {
        const bodyScope = createAssetScope(parameterScope);
        if (node.body.type === "BlockStatement") {
          collectVarScopeBindings(node.body, bodyScope);
          collectAssetScopeBindings(node.body, bodyScope);
        }
        visitDeferred(node.body, bodyScope);
      }
      return;
    }

    if (node.type === "SwitchStatement") {
      if (isAstRecord(node.discriminant)) visit(node.discriminant, parentScope);
      const switchScope = createAssetScope(parentScope);
      collectSwitchScopeBindings(node, switchScope);
      addScopeBindingNames(switchScope, usedNames);
      for (const switchCase of nodeArray(node.cases)) {
        if (!isAstRecord(switchCase)) continue;
        const caseScope = createAssetScope(switchScope);
        collectAssetScopeBindings(
          { type: "BlockStatement", body: nodeArray(switchCase.consequent) },
          caseScope,
        );
        addScopeBindingNames(caseScope, usedNames);
        visit(switchCase, caseScope);
      }
      return;
    }

    const childScope = createChildScope(node, parentScope);
    if (childScope) addScopeBindingNames(childScope, usedNames);
    const scope = childScope ?? parentScope;
    if (node.type === "ImportExpression") {
      if (isAstRecord(node.source)) visit(node.source, scope, true);
      if (isAstRecord(node.options)) visit(node.options, scope);
      return;
    }

    if (node.type === "ImportDeclaration") {
      for (const specifier of nodeArray(node.specifiers)) {
        if (isAstRecord(specifier)) collectBindingNames(specifier.local, usedNames);
      }
      return;
    }
    if (node.type === "ExportAllDeclaration") return;

    if (node.type === "Identifier" && typeof node.name === "string") {
      usedNames.add(node.name);
      if (!safeAssetReference) invalidateAssetBinding(scope, node.name);
      return;
    }
    if (node.type === "MetaProperty") return;

    if (node.type === "VariableDeclaration") {
      for (const declarator of nodeArray(node.declarations)) {
        if (!isAstRecord(declarator)) continue;
        collectBindingNames(declarator.id, usedNames);
        visitBindingPatternRuntime(declarator.id, scope);
        if (isAstRecord(declarator.init)) {
          visit(declarator.init, scope);
        }
      }
      return;
    }

    if (node.type === "AssignmentExpression") {
      invalidateAssetTarget(scope, node.left);
      if (isAstRecord(node.left)) visit(node.left, scope);
      if (isAstRecord(node.right)) visit(node.right, scope);
      return;
    }
    if (node.type === "UpdateExpression") {
      invalidateAssetTarget(scope, node.argument);
      if (isAstRecord(node.argument)) visit(node.argument, scope);
      return;
    }
    if (node.type === "UnaryExpression" && node.operator === "delete") {
      invalidateAssetTarget(scope, node.argument);
      if (isAstRecord(node.argument)) visit(node.argument, scope);
      return;
    }
    if (node.type === "ForInStatement" || node.type === "ForOfStatement") {
      if (isAstRecord(node.left) && node.left.type === "VariableDeclaration") {
        for (const declarator of nodeArray(node.left.declarations)) {
          if (!isAstRecord(declarator)) continue;
          collectBindingNames(declarator.id, usedNames);
          visitBindingPatternRuntime(declarator.id, scope);
        }
      } else {
        invalidateAssetTarget(scope, node.left);
        if (isAstRecord(node.left)) visit(node.left, scope);
      }
      if (isAstRecord(node.right)) visit(node.right, scope);
      if (isAstRecord(node.body)) visit(node.body, scope);
      return;
    }

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
      collectBindingNames(node.id, usedNames);
      const body = isAstRecord(node.body) ? node.body : node;
      for (const member of nodeArray(body.members)) {
        if (isAstRecord(member) && isAstRecord(member.initializer)) {
          visit(member.initializer, scope);
        }
      }
      return;
    }
    if (node.type === "TSModuleDeclaration") {
      collectBindingNames(node.id, usedNames);
      if (isAstRecord(node.body)) visit(node.body, scope);
      return;
    }
    if (node.type === "TSImportEqualsDeclaration") {
      collectBindingNames(node.id, usedNames);
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

    if (node.type === "CallExpression") {
      const arrayBufferAsset =
        deferredExecutionDepth === 0 ? arrayBufferFetchAssetFromCall(node, scope) : null;
      if (arrayBufferAsset !== null) {
        assets.push(arrayBufferAsset.asset);
        handledFetchCalls.add(arrayBufferAsset.fetchCall);
      }
      const callee = unwrapExpression(node.callee);
      const isGlobalFetch = isIdentifierNamed(callee, "fetch") && !hasAstBinding(scope, "fetch");
      const isReadOnlyUrlConsumer = isNodeUrlFileUrlToPath(scope, callee);
      const isDirectEval =
        node.optional !== true &&
        isIdentifierNamed(callee, "eval") &&
        !hasAstBinding(scope, "eval");
      if (isDirectEval) invalidateVisibleAssetBindings(scope);
      const input = nodeArray(node.arguments)[0];
      if (isGlobalFetch && !handledFetchCalls.has(node)) {
        const directAsset = hasAstBinding(scope, "URL") ? null : assetUrlFromNode(input);
        if (directAsset) assets.push(directAsset);
        const identifier = unwrapExpression(input);
        if (!directAsset && identifier?.type === "Identifier" && hasRange(identifier)) {
          const boundAsset = findAssetBinding(scope, String(identifier.name));
          if (boundAsset) {
            assets.push({ ...boundAsset.asset, range: identifier, binding: boundAsset });
          }
        }
      }

      const receiver =
        callee?.type === "MemberExpression" ? rootIdentifierName(callee.object) : null;
      if (receiver && !isReadOnlyUrlConsumer) invalidateAssetBinding(scope, receiver);
      if (isAstRecord(node.callee)) visit(node.callee, scope, isReadOnlyUrlConsumer);
      for (const [index, argument] of nodeArray(node.arguments).entries()) {
        if (!isAstRecord(argument)) continue;
        const safeArgument =
          (isGlobalFetch && index === 0 && unwrapExpression(argument)?.type === "Identifier") ||
          (isReadOnlyUrlConsumer &&
            index === 0 &&
            unwrapExpression(argument)?.type === "Identifier");
        visit(argument, scope, safeArgument);
      }
      return;
    }

    if (node.type === "MemberExpression") {
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
          "username",
        ].includes(String(property.name));
      if (isAstRecord(node.object)) visit(node.object, scope, safeUrlValue);
      if (node.computed === true && isAstRecord(node.property)) visit(node.property, scope);
      return;
    }

    if (
      node.type === "Property" ||
      node.type === "PropertyDefinition" ||
      node.type === "AccessorProperty"
    ) {
      visitDecorators(node, scope);
      if (node.computed === true && isAstRecord(node.key)) visit(node.key, scope);
      if (isAstRecord(node.value)) {
        if (node.type !== "Property" && node.static !== true) {
          visitDeferred(node.value, scope);
        } else {
          visit(node.value, scope);
        }
      }
      return;
    }

    if (node.type === "MethodDefinition") {
      visitDecorators(node, scope);
      if (node.computed === true && isAstRecord(node.key)) visit(node.key, scope);
      if (isAstRecord(node.value)) visit(node.value, scope);
      return;
    }

    if (node.type === "LabeledStatement") {
      if (isAstRecord(node.body)) visit(node.body, scope);
      return;
    }
    if (node.type === "BreakStatement" || node.type === "ContinueStatement") return;

    if (node.type === "ExportNamedDeclaration" || node.type === "ExportDefaultDeclaration") {
      if (node.exportKind === "type") return;
      if (isAstRecord(node.source)) return;
      if (isAstRecord(node.declaration)) {
        visit(node.declaration, scope);
        if (node.declaration.type === "VariableDeclaration") {
          for (const declarator of nodeArray(node.declaration.declarations)) {
            if (isAstRecord(declarator)) invalidateAssetTarget(scope, declarator.id);
          }
        }
      }
      for (const specifier of nodeArray(node.specifiers)) {
        if (isAstRecord(specifier) && isAstRecord(specifier.local)) {
          visit(specifier.local, scope);
        }
      }
      return;
    }

    forEachAstChild(node, (child) => visit(child, scope, safeAssetReference));
  }

  for (const statement of nodeArray(ast.body)) {
    if (isAstRecord(statement)) visit(statement, rootScope);
  }
  return { assets: assets.filter((asset) => asset.binding?.valid !== false), usedNames };
}

/** Asset phase of the existing import-meta capability. */
export class ImportMetaAssetTransformer {
  readonly #cache = new Map<string, { dataUrl: string; size: number }>();
  readonly #assetImporters = new Map<string, Map<string, string>>();
  readonly #importerStates = new Map<string, { importer: string; assets: Set<string> }>();
  #cachedBytes = 0;
  #isBuild = false;

  constructor(
    private readonly options: {
      ownership: OgAssetOwnership;
    },
  ) {}

  configResolved(config: ResolvedConfig): void {
    this.#isBuild = config.command === "build";
    this.options.ownership.configure(config.root, config.resolve.alias);
  }

  buildStart(): void {
    if (this.#isBuild) {
      this.#cache.clear();
      this.#cachedBytes = 0;
      this.#assetImporters.clear();
      this.#importerStates.clear();
    }
    this.options.ownership.reset();
  }

  importersForAsset(id: string): ReadonlySet<string> | undefined {
    const importers = this.#assetImporters.get(toSlash(id));
    return importers ? new Set(importers.values()) : undefined;
  }

  forgetImporter(id: string): void {
    const cleanId = toSlash(stripViteModuleQuery(id));
    for (const [key, state] of this.#importerStates) {
      if (toSlash(stripViteModuleQuery(state.importer)) === cleanId) {
        this.#replaceImporterState(key, state.importer, new Set());
      }
    }
  }

  async collectRewrites(
    context: TransformPluginContext,
    code: string,
    id: string,
    ast: AstRecord,
    newUrlBaseReplacement: string,
  ): Promise<ImportMetaAssetRewrite[]> {
    const importerKey = `${context.environment?.name ?? "server"}\0${id}`;
    const { assets: assetUrls, usedNames } = collectAssetUrlRewrites(ast);
    if (assetUrls.length === 0) {
      this.#replaceImporterState(importerKey, id, new Set());
      return [];
    }
    const moduleBoundary = await this.options.ownership.resolveModuleBoundary(id);
    if (moduleBoundary === null) {
      this.#replaceImporterState(importerKey, id, new Set());
      return [];
    }

    const rewrites: ImportMetaAssetRewrite[] = [];
    const initializedBindings = new Map<AssetBinding, string>();
    const transformPayloads = new Map<string, { dataUrl: string; size: number }>();
    const dataBindings = new Map<string, string>();
    const dataDeclarations: string[] = [];
    let arrayBufferDecoderBinding: string | undefined;
    const embeddedAssets = new Set<string>();
    let moduleOutputBytes = 0;
    for (const assetUrl of assetUrls) {
      if (hasBundlerIgnoreInNewUrl(code, assetUrl.sourceRange)) continue;

      const cleanSpecifier = assetUrl.specifier.split(/[?#]/, 1)[0];
      if (cleanSpecifier === "") continue;
      let file: string | null = null;
      if (cleanSpecifier.startsWith("./") || cleanSpecifier.startsWith("../")) {
        let decodedPath: string;
        try {
          const baseUrl = pathToFileURL(path.join(moduleBoundary.moduleDir, "__vinext_asset__"));
          const assetFileUrl = new URL(assetUrl.specifier, baseUrl);
          assetFileUrl.search = "";
          assetFileUrl.hash = "";
          decodedPath = toSlash(fileURLToPath(assetFileUrl));
        } catch {
          continue;
        }
        file = await this.options.ownership.resolveContainedAsset(
          moduleBoundary.assetRoot,
          decodedPath,
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

      let cached =
        transformPayloads.get(file) ?? (this.#isBuild ? this.#cache.get(file) : undefined);
      if (cached === undefined) {
        let stat: Awaited<ReturnType<typeof fs.promises.stat>>;
        try {
          stat = await fs.promises.stat(file);
        } catch {
          continue;
        }
        if (stat.size > MAX_INLINE_FETCH_ASSET_BYTES) {
          throw new Error(
            `Cannot inline fetched asset ${JSON.stringify(file)}: ${stat.size} bytes exceeds the ${MAX_INLINE_FETCH_ASSET_BYTES} byte limit. Serve large files from public/ or an external URL instead.`,
          );
        }
        let bytes: Buffer;
        try {
          bytes = await fs.promises.readFile(file);
        } catch {
          continue;
        }
        if (bytes.byteLength > MAX_INLINE_FETCH_ASSET_BYTES) {
          throw new Error(
            `Cannot inline fetched asset ${JSON.stringify(file)}: ${bytes.byteLength} bytes exceeds the ${MAX_INLINE_FETCH_ASSET_BYTES} byte limit. Serve large files from public/ or an external URL instead.`,
          );
        }
        cached = {
          dataUrl: `data:${contentTypeForPath(file)};base64,${bytes.toString("base64")}`,
          size: bytes.byteLength,
        };
        if (
          this.#isBuild &&
          this.#cachedBytes + cached.size <= MAX_CACHED_INLINE_FETCH_ASSET_BYTES
        ) {
          this.#cache.set(file, cached);
          this.#cachedBytes += cached.size;
        }
      }
      transformPayloads.set(file, cached);

      if (!embeddedAssets.has(file)) context.addWatchFile(file);
      embeddedAssets.add(file);
      // Query/hash stay on the original URL alias. They must not be appended
      // to the private data URL passed to fetch: a query after a base64 payload
      // makes the data URL invalid.
      let dataBinding = dataBindings.get(file);
      if (dataBinding === undefined) {
        dataBinding = selectPrivateBinding(usedNames, "__vinext_asset_data");
        dataBindings.set(file, dataBinding);
        const dataLiteral = JSON.stringify(cached.dataUrl);
        moduleOutputBytes += dataLiteral.length;
        if (moduleOutputBytes > MAX_INLINE_FETCH_ASSET_MODULE_OUTPUT_BYTES) {
          throw new Error(
            `Cannot inline fetched assets in ${JSON.stringify(id)}: their generated data URLs total ${moduleOutputBytes} bytes, exceeding the ${MAX_INLINE_FETCH_ASSET_MODULE_OUTPUT_BYTES} byte module limit. Serve some assets from public/ or external URLs instead.`,
          );
        }
        dataDeclarations.push(`const ${dataBinding} = ${dataLiteral};`);
      }
      const dataUrlExpression = `new URL(${dataBinding})`;
      let replacement = dataUrlExpression;
      if (assetUrl.replacementKind === "array-buffer-promise") {
        if (arrayBufferDecoderBinding === undefined) {
          arrayBufferDecoderBinding = selectPrivateBinding(usedNames, "__vinext_decode_asset_data");
          dataDeclarations.push(
            [
              `const ${arrayBufferDecoderBinding} = async (data) => {`,
              `await 0;`,
              `const binary = globalThis.atob(data.slice(data.indexOf(",") + 1));`,
              `const bytes = new globalThis.Uint8Array(binary.length);`,
              `for (let index = 0; index < binary.length; index++) {`,
              `bytes[index] = binary.charCodeAt(index);`,
              `}`,
              `return bytes.buffer;`,
              `};`,
            ].join("\n"),
          );
        }
        replacement = `${arrayBufferDecoderBinding}(${dataBinding})`;
      }
      if (assetUrl.binding) {
        let privateBinding = initializedBindings.get(assetUrl.binding);
        if (privateBinding === undefined) {
          privateBinding = selectPrivateBinding(usedNames, "__vinext_asset_url");
          initializedBindings.set(assetUrl.binding, privateBinding);
          const declarator = assetUrl.binding.declarator;
          rewrites.push({
            start: assetUrl.binding.asset.baseRange.start,
            end: assetUrl.binding.asset.baseRange.end,
            replacement: newUrlBaseReplacement,
          });
          rewrites.push({
            start: declarator.end,
            end: declarator.end,
            replacement: `, ${privateBinding} = ${dataUrlExpression}`,
          });
        }
        replacement = privateBinding;
      }
      rewrites.push({
        start: assetUrl.range.start,
        end: assetUrl.range.end,
        replacement,
      });
    }

    if (dataDeclarations.length > 0) {
      rewrites.push({
        start: directivePrologueEnd(ast),
        end: directivePrologueEnd(ast),
        replacement: `\n${dataDeclarations.join("\n")}\n`,
      });
    }
    this.#replaceImporterState(importerKey, id, embeddedAssets);
    return rewrites;
  }

  #replaceImporterState(key: string, importer: string, assets: Set<string>): void {
    const previous = this.#importerStates.get(key);
    if (previous) {
      for (const asset of previous.assets) {
        const importers = this.#assetImporters.get(asset);
        importers?.delete(key);
        if (importers?.size === 0) this.#assetImporters.delete(asset);
      }
    }

    if (assets.size === 0) {
      this.#importerStates.delete(key);
      return;
    }

    this.#importerStates.set(key, { importer, assets });
    for (const asset of assets) {
      const importers = this.#assetImporters.get(asset) ?? new Map<string, string>();
      importers.set(key, importer);
      this.#assetImporters.set(asset, importers);
    }
  }
}

// Inlining is the only target-independent way to preserve fetch(URL) across
// server runtimes. Cap each implicit asset to catch accidental large-file
// embedding, and cap each transformed module before later tree-shaking and
// chunking. Final deployment bundle limits remain the deploy adapter's concern.
export const MAX_INLINE_FETCH_ASSET_BYTES = 2 * 1024 * 1024;
export const MAX_INLINE_FETCH_ASSET_MODULE_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_CACHED_INLINE_FETCH_ASSET_BYTES = 4 * 1024 * 1024;

function selectPrivateBinding(usedNames: Set<string>, base: string): string {
  let binding = base;
  while (usedNames.has(binding)) binding += "_";
  usedNames.add(binding);
  return binding;
}
