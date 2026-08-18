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
  alias?: boolean;
};

type AssetScope = AstScope & {
  assets: Map<string, AssetUrl>;
};

export type ImportMetaAssetRewrite = { start: number; end: number; replacement: string };

function createAssetScope(parent: AssetScope | null): AssetScope {
  return { ...createAstScope(parent), assets: new Map() };
}

function assetUrlFromNode(value: unknown): AssetUrl | null {
  const expression = unwrapExpression(value);
  if (!isNewUrlExpression(expression) || !hasRange(expression)) return null;

  const args = nodeArray(expression.arguments);
  const specifier = unwrapExpression(args[0]);
  if (
    args.length !== 2 ||
    !isImportMetaUrlOrChainedNode(args[1]) ||
    specifier?.type !== "Literal" ||
    typeof specifier.value !== "string"
  ) {
    return null;
  }
  if (
    specifier.value === "" ||
    specifier.value.startsWith("?") ||
    specifier.value.startsWith("#") ||
    specifier.value.startsWith("/") ||
    /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(specifier.value)
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
    typeof declarator.id.name !== "string" ||
    hasAstBinding(scope, "URL")
  ) {
    return;
  }
  const asset = assetUrlFromNode(declarator.init);
  if (asset) scope.assets.set(declarator.id.name, asset);
}

function collectAssetScopeBindings(node: AstRecord, scope: AssetScope): void {
  collectDirectScopeBindings(node, scope);
  collectDirectScopeBindings(node, scope, (declaration, declarator) =>
    recordAssetBinding(declaration, declarator, scope),
  );
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

function collectAssetUrlRewrites(ast: AstRecord, nodelessTarget: boolean): AssetUrl[] {
  const assets: AssetUrl[] = [];
  const rootScope = createAssetScope(null);
  collectVarScopeBindings(ast, rootScope);
  collectAssetScopeBindings(ast, rootScope);

  function visit(node: AstRecord, parentScope: AssetScope): void {
    if (isFunctionNode(node)) {
      const parameterScope = createAssetScope(parentScope);
      collectBindingNames(node.id, parameterScope.bindings);
      for (const parameter of nodeArray(node.params)) {
        collectBindingNames(parameter, parameterScope.bindings);
      }
      if (isAstRecord(node.body)) {
        const bodyScope = createAssetScope(parameterScope);
        if (node.body.type === "BlockStatement") {
          collectVarScopeBindings(node.body, bodyScope);
          collectAssetScopeBindings(node.body, bodyScope);
        }
        visit(node.body, bodyScope);
      }
      return;
    }

    if (node.type === "SwitchStatement") {
      if (isAstRecord(node.discriminant)) visit(node.discriminant, parentScope);
      const switchScope = createAssetScope(parentScope);
      collectSwitchScopeBindings(node, switchScope);
      for (const switchCase of nodeArray(node.cases)) {
        if (!isAstRecord(switchCase)) continue;
        const caseScope = createAssetScope(switchScope);
        collectAssetScopeBindings(
          { type: "BlockStatement", body: nodeArray(switchCase.consequent) },
          caseScope,
        );
        visit(switchCase, caseScope);
      }
      return;
    }

    const scope = createChildScope(node, parentScope) ?? parentScope;
    if (
      node.type === "ImportExpression" &&
      relativeDynamicImportUrlSpecifier(node.source) !== null
    ) {
      return;
    }

    const nodelessAsset =
      nodelessTarget && !hasAstBinding(scope, "URL") ? assetUrlFromNode(node) : null;
    if (nodelessAsset) {
      assets.push(nodelessAsset);
      return;
    }

    if (
      !nodelessTarget &&
      node.type === "CallExpression" &&
      isIdentifierNamed(unwrapExpression(node.callee), "fetch") &&
      !hasAstBinding(scope, "fetch")
    ) {
      const input = nodeArray(node.arguments)[0];
      const directAsset = hasAstBinding(scope, "URL") ? null : assetUrlFromNode(input);
      if (directAsset) {
        assets.push(directAsset);
      } else {
        const identifier = unwrapExpression(input);
        if (identifier?.type === "Identifier" && hasRange(identifier)) {
          const boundAsset = findAssetBinding(scope, String(identifier.name));
          if (boundAsset) assets.push({ ...boundAsset, range: identifier, alias: true });
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

/** Asset phase of the existing import-meta capability. */
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

      context.addWatchFile(file);
      const dataUrlExpression = `new URL(${JSON.stringify(dataUrl)})`;
      rewrites.push({
        start: assetUrl.range.start,
        end: assetUrl.range.end,
        replacement: assetUrl.alias
          ? `(${code.slice(assetUrl.range.start, assetUrl.range.end)}.href === ${code.slice(assetUrl.sourceRange.start, assetUrl.sourceRange.end)}.href ? ${dataUrlExpression} : ${code.slice(assetUrl.range.start, assetUrl.range.end)})`
          : dataUrlExpression,
      });
    }

    return rewrites;
  }
}
