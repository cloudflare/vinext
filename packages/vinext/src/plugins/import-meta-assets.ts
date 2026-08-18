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
};

export type ImportMetaAssetRewrite = { start: number; end: number; replacement: string };

type AssetScope = AstScope & {
  assets: Map<string, AssetUrl>;
};

function createAssetScope(parent: AssetScope | null): AssetScope {
  return { ...createAstScope(parent), assets: new Map() };
}

function assetUrlFromNode(value: unknown): AssetUrl | null {
  if (!isNewUrlExpression(value) || !hasRange(value)) {
    return null;
  }

  const args = nodeArray(value.arguments);
  if (args.length !== 2 || !isImportMetaUrlOrChainedNode(args[1])) return null;
  const specifier = args[0];
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
  return { range: value, sourceRange: value, specifier: specifier.value };
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
  const asset = assetUrlFromNode(declarator.init);
  if (asset) scope.assets.set(declarator.id.name, asset);
}

function collectAssetScopeBindings(node: AstRecord, scope: AssetScope): void {
  collectDirectScopeBindings(node, scope);
}

function findAssetBinding(scope: AssetScope, name: string): AssetUrl | null {
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
  for (
    let current: AssetScope | null = scope;
    current;
    current = current.parent as AssetScope | null
  ) {
    if (current.assets.delete(name) || current.bindings.has(name)) return;
  }
}

function rootIdentifierName(value: unknown): string | null {
  let node = unwrapExpression(value);
  while (node?.type === "MemberExpression") node = unwrapExpression(node.object);
  return node?.type === "Identifier" && typeof node.name === "string" ? node.name : null;
}

function invalidateDirectAssetReference(scope: AssetScope, value: unknown): void {
  const node = unwrapExpression(value);
  if (node?.type !== "Identifier" || typeof node.name !== "string") return;
  if (findAssetBinding(scope, node.name)) invalidateAssetBinding(scope, node.name);
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
  const rootScope = createAssetScope(null);
  collectAssetScopeBindings(ast, rootScope);
  collectVarScopeBindings(ast, rootScope);

  function visit(node: AstRecord, parentScope: AssetScope): void {
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
      if (isAstRecord(node.discriminant)) visit(node.discriminant, parentScope);
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
    if (node.type === "VariableDeclaration") {
      for (const declarator of nodeArray(node.declarations)) {
        if (!isAstRecord(declarator)) continue;
        invalidateDirectAssetReference(scope, declarator.init);
        if (isAstRecord(declarator.init)) visit(declarator.init, scope);
        if (isAstRecord(declarator.id)) visit(declarator.id, scope);
        recordAssetBinding(node, declarator, scope);
      }
      return;
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
        const assigned = rootIdentifierName(node.left);
        if (assigned) invalidateAssetBinding(scope, assigned);
        invalidateDirectAssetReference(scope, node.right);
      } else if (node.type === "UpdateExpression") {
        const assigned = rootIdentifierName(node.argument);
        if (assigned) invalidateAssetBinding(scope, assigned);
      } else if (node.type === "UnaryExpression" && node.operator === "delete") {
        const assigned = rootIdentifierName(node.argument);
        if (assigned) invalidateAssetBinding(scope, assigned);
      } else if (node.type === "NewExpression") {
        for (const argument of nodeArray(node.arguments)) {
          invalidateDirectAssetReference(scope, argument);
        }
      } else if (
        node.type === "ReturnStatement" ||
        node.type === "ThrowStatement" ||
        node.type === "YieldExpression"
      ) {
        invalidateDirectAssetReference(scope, node.argument);
      } else if (node.type === "ArrayExpression") {
        for (const element of nodeArray(node.elements)) {
          invalidateDirectAssetReference(scope, element);
        }
      } else if (node.type === "Property") {
        invalidateDirectAssetReference(scope, node.value);
      }
    }

    if (
      !nodelessTarget &&
      node.type === "CallExpression" &&
      isIdentifierNamed(node.callee, "fetch") &&
      !hasAstBinding(scope, "fetch")
    ) {
      const input = nodeArray(node.arguments)[0];
      const directAsset = hasAstBinding(scope, "URL") ? null : assetUrlFromNode(input);
      if (directAsset) {
        assets.push(directAsset);
      } else if (
        isAstRecord(input) &&
        input.type === "Identifier" &&
        typeof input.name === "string" &&
        hasRange(input)
      ) {
        const boundAsset = findAssetBinding(scope, input.name);
        if (boundAsset) assets.push({ ...boundAsset, range: input, preserveEvaluation: true });
      }
    }

    if (!nodelessTarget && node.type === "CallExpression") {
      const callee = unwrapExpression(node.callee);
      const isGlobalFetch = isIdentifierNamed(callee, "fetch") && !hasAstBinding(scope, "fetch");
      if (!isGlobalFetch) {
        const receiver =
          callee?.type === "MemberExpression" ? rootIdentifierName(callee.object) : null;
        if (receiver) invalidateAssetBinding(scope, receiver);
        for (const argument of nodeArray(node.arguments)) {
          invalidateDirectAssetReference(scope, argument);
        }
      }
    }

    forEachAstChild(node, (child) => visit(child, scope));
  }

  for (const statement of nodeArray(ast.body)) {
    if (isAstRecord(statement)) visit(statement, rootScope);
  }
  return assets;
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
